"""The Materialliste of a Verteiler: what the plan says goes in, what was
actually taken off the shelf for it, and how the two compare.

Nothing here is stored as a list. The PLANNED side is derived from the
board's document on every read — one line per device type ("B16, 1-polig"
× 8) and one per WAGO terminal part (the Reihenklemmen derivation already
counts those) — so the list can never lag behind the plan. The SCANNED side
is a sum over the Werkstatt ledger: every ``consumption`` row that carries
the board's id, minus every ``consumption_undo``. The Regal station writes
those rows when somebody scans a shelf label with the board's list open;
the board's Material tab writes them when somebody books by hand. Because
both sides are derived, correcting a mapping later re-sorts what was
scanned under the right planned line without touching a single booking.

Matching a planned line to a stock article, in this order:

1. an explicit mapping (``schaltplan_material_articles``, keyed by the
   line's key, global — "our B16 is SP-0152" holds for every board);
2. for a WAGO terminal part, the article whose name leads with the part
   number ("WAGO 2003-7641 - TOPJOB S …", the way the catalog names them),
   or whose supplier number is the bare part number.

A scanned article that matches no planned line is still booked and shows
as an ``extra`` line ("nicht geplant"): the person at the rack holds the
part, and the list's job is to say what really went in.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.customer import Customer
from app.models.entities import Project, WerkstattArticle, WerkstattArticleSupplier, WerkstattMovement
from app.models.schaltplan import PanelMaterialArticle, PanelPlan
from app.schemas.schaltplan import (
    PanelMaterialArticleOut,
    PanelMaterialLineOut,
    PanelMaterialOut,
    PanelMaterialPanelOut,
    PanelMaterialSummaryOut,
)
from app.services.schaltplan_layout import DEVICE_CATALOG, iter_devices
from app.services.schaltplan_terminal_rules import TERMINAL_PARTS
from app.services.schaltplan_terminals import derive_terminals, terminal_bom
from app.services.werkstatt_article_labels import split_item_name
from app.services.werkstatt_movements import MovementError, apply_movement

CONSUMPTION = "consumption"
CONSUMPTION_UNDO = "consumption_undo"

LINE_DEVICE = "device"
LINE_TERMINAL = "terminal"
LINE_EXTRA = "extra"

STATUS_OPEN = "open"
STATUS_DONE = "done"
STATUS_OVER = "over"
STATUS_UNPLANNED = "unplanned"

STOCK_WARNING = "Bestand war {available} — Inventur prüfen."

_DEVICE_ORDER = {kind: index for index, kind in enumerate(DEVICE_CATALOG)}


class MaterialError(Exception):
    """A booking the list cannot accept, with the German sentence to show."""


@dataclass(frozen=True)
class PlannedLine:
    key: str
    kind: str
    label: str
    detail: str
    planned: int


# ── Planned side ──────────────────────────────────────────────────────────────


def device_line_key(kind: str, poles: int, rating: str, residual_current: str = "", rcd_type: str = "") -> str:
    """``device:mcb:1p:b16`` — one key per device TYPE, so "our B16" maps once.

    An FI is not one type per rating: a 30 mA and a 300 mA breaker of the
    same 40 A are two different articles, and so are Typ A and Typ B. The
    residual current and the type join the key when they are set, and only
    then, so a board without them keeps the key (and the mapping) it had.
    """
    key = f"device:{kind}:{int(poles)}p:{_normalize_rating(rating)}"
    residual = _normalize_rating(residual_current)
    rcd = _normalize_rating(rcd_type)
    if residual:
        key += f":{residual}"
    if rcd:
        key += f":typ{rcd}"
    return key


def _normalize_rating(rating: str) -> str:
    return "".join((rating or "").lower().split())


def planned_lines(document: dict[str, Any]) -> list[PlannedLine]:
    """The board's parts: device types in catalog order, then the WAGO terminals."""
    devices: dict[str, dict[str, Any]] = {}
    for _row, device in iter_devices(document):
        kind = str(device.get("kind") or "")
        catalog = DEVICE_CATALOG.get(kind)
        if catalog is None:
            continue
        rating = str(device.get("rating") or "").strip()
        residual = str(device.get("residual_current") or "").strip()
        rcd_type = str(device.get("rcd_type") or "").strip()
        poles = _int(device.get("poles"), int(catalog["poles"]))
        te = _int(device.get("te"), int(catalog["te"]))
        key = device_line_key(kind, poles, rating, residual, rcd_type)
        entry = devices.get(key)
        if entry is None:
            entry = {
                "kind": kind, "rating": rating, "residual": residual, "rcd_type": rcd_type,
                "poles": poles, "te": te, "count": 0,
            }
            devices[key] = entry
        entry["count"] += 1

    lines: list[PlannedLine] = []
    for key, entry in sorted(
        devices.items(),
        key=lambda item: (
            _DEVICE_ORDER.get(item[1]["kind"], 99),
            item[1]["rating"].lower(),
            _residual_sort_key(item[1]["residual"]),
            item[1]["rcd_type"].lower(),
        ),
    ):
        catalog = DEVICE_CATALOG[entry["kind"]]
        label = " ".join(
            part
            for part in (
                str(catalog["label"]),
                entry["rating"],
                entry["residual"],
                f"Typ {entry['rcd_type']}" if entry["rcd_type"] else "",
            )
            if part
        )
        lines.append(
            PlannedLine(
                key=key,
                kind=LINE_DEVICE,
                label=label,
                detail=f"{entry['poles']}-polig · {entry['te']} TE",
                planned=int(entry["count"]),
            )
        )
    for row in terminal_bom(derive_terminals(document)):
        lines.append(
            PlannedLine(
                key=f"part:{row['part_id']}",
                kind=LINE_TERMINAL,
                label=str(row["part_no"]),
                detail=str(row["name"]),
                planned=int(row["count"]),
            )
        )
    return lines


def _residual_sort_key(residual: str) -> tuple[int, str]:
    """30 mA before 300 mA — numerically, not as text."""
    digits = "".join(ch for ch in residual if ch.isdigit())
    return (int(digits) if digits else 0, residual.lower())


def _int(value: Any, fallback: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback


# ── Articles ──────────────────────────────────────────────────────────────────


def article_out(article: WerkstattArticle) -> PanelMaterialArticleOut:
    return PanelMaterialArticleOut(
        id=article.id,
        article_number=article.article_number,
        item_name=article.item_name,
        manufacturer=article.manufacturer,
        unit=article.unit,
        internal_code=article.internal_code,
        stock_available=int(article.stock_available or 0),
    )


def explicit_mappings(db: Session, keys: list[str]) -> dict[str, WerkstattArticle]:
    if not keys:
        return {}
    rows = db.execute(
        select(PanelMaterialArticle.part_key, WerkstattArticle)
        .join(WerkstattArticle, WerkstattArticle.id == PanelMaterialArticle.article_id)
        .where(PanelMaterialArticle.part_key.in_(keys))
    ).all()
    return {str(key): article for key, article in rows}


def auto_match_part(db: Session, part_no: str) -> WerkstattArticle | None:
    """The stock article for a WAGO part number, by the catalog's naming.

    "WAGO 2003-7641" matches an article named "WAGO 2003-7641 - TOPJOB S …"
    (the head before " - " is the part number) or one whose supplier number
    is the bare "2003-7641". Archived and merged-away articles never match.
    """
    cleaned = " ".join((part_no or "").split())
    if not cleaned:
        return None
    bare = cleaned.split(" ")[-1]
    candidates = db.scalars(
        select(WerkstattArticle)
        .where(
            WerkstattArticle.is_archived.is_(False),
            WerkstattArticle.merged_into_id.is_(None),
            func.lower(WerkstattArticle.item_name).like(f"%{bare.lower()}%"),
        )
        .order_by(WerkstattArticle.id.asc())
    ).all()
    for article in candidates:
        head, _ = split_item_name(article.item_name, article.manufacturer)
        if head.lower() == cleaned.lower() or head.lower().endswith(bare.lower()):
            return article
    for article in candidates:
        if article.item_name.lower().startswith(cleaned.lower()):
            return article
    supplier_row = db.execute(
        select(WerkstattArticle)
        .join(WerkstattArticleSupplier, WerkstattArticleSupplier.article_id == WerkstattArticle.id)
        .where(
            WerkstattArticleSupplier.supplier_article_no == bare,
            WerkstattArticle.is_archived.is_(False),
            WerkstattArticle.merged_into_id.is_(None),
        )
        .order_by(WerkstattArticle.id.asc())
    ).first()
    return supplier_row[0] if supplier_row is not None else None


def resolve_line_articles(db: Session, lines: list[PlannedLine]) -> dict[str, tuple[WerkstattArticle, str]]:
    """key → (article, "mapping" | "auto") for every planned line that has one."""
    resolved: dict[str, tuple[WerkstattArticle, str]] = {}
    mapped = explicit_mappings(db, [line.key for line in lines])
    for line in lines:
        article = mapped.get(line.key)
        if article is not None:
            resolved[line.key] = (article, "mapping")
            continue
        if line.kind == LINE_TERMINAL:
            part = TERMINAL_PARTS.get(line.key.removeprefix("part:"))
            article = auto_match_part(db, part.part_no if part is not None else line.label)
            if article is not None:
                resolved[line.key] = (article, "auto")
    return resolved


def set_mapping(db: Session, *, key: str, article: WerkstattArticle | None, user_id: int | None) -> None:
    """Remember (or forget) which article a line key means. Flushes, no commit."""
    row = db.scalars(select(PanelMaterialArticle).where(PanelMaterialArticle.part_key == key)).first()
    if article is None:
        if row is not None:
            db.delete(row)
            db.flush()
        return
    if row is None:
        row = PanelMaterialArticle(part_key=key, article_id=article.id, created_by=user_id)
        db.add(row)
    else:
        row.article_id = article.id
    db.flush()


# ── Scanned side ──────────────────────────────────────────────────────────────


@dataclass
class _Consumed:
    net: int = 0
    bookings: int = 0
    last_at: datetime | None = None


def consumed_by_article(db: Session, panel_id: int) -> dict[int, _Consumed]:
    """article id → what the ledger says was built into this board."""
    rows = db.execute(
        select(
            WerkstattMovement.article_id,
            WerkstattMovement.movement_type,
            WerkstattMovement.quantity,
            WerkstattMovement.created_at,
        )
        .where(
            WerkstattMovement.panel_id == panel_id,
            WerkstattMovement.movement_type.in_((CONSUMPTION, CONSUMPTION_UNDO)),
        )
        .order_by(WerkstattMovement.id.asc())
    ).all()
    out: dict[int, _Consumed] = {}
    for article_id, movement_type, quantity, created_at in rows:
        entry = out.setdefault(int(article_id), _Consumed())
        qty = int(quantity or 0)
        if movement_type == CONSUMPTION:
            entry.net += qty
            entry.bookings += 1
        else:
            entry.net -= qty
        if created_at is not None and (entry.last_at is None or created_at > entry.last_at):
            entry.last_at = created_at
    return out


def net_consumed(db: Session, panel_id: int, article_id: int) -> int:
    return consumed_by_article(db, panel_id).get(article_id, _Consumed()).net


# ── Composition ───────────────────────────────────────────────────────────────


def panel_refs(db: Session, plans: list[PanelPlan]) -> dict[int, PanelMaterialPanelOut]:
    customer_ids = {plan.customer_id for plan in plans}
    project_ids = {plan.project_id for plan in plans if plan.project_id}
    customers = (
        {c.id: c for c in db.scalars(select(Customer).where(Customer.id.in_(customer_ids)))} if customer_ids else {}
    )
    projects = (
        {p.id: p for p in db.scalars(select(Project).where(Project.id.in_(project_ids)))} if project_ids else {}
    )
    out: dict[int, PanelMaterialPanelOut] = {}
    for plan in plans:
        customer = customers.get(plan.customer_id)
        project = projects.get(plan.project_id) if plan.project_id else None
        out[plan.id] = PanelMaterialPanelOut(
            id=plan.id,
            panel_number=plan.panel_number,
            designation=plan.designation,
            name=plan.name,
            panel_type=plan.panel_type,  # type: ignore[arg-type]
            status=plan.status,  # type: ignore[arg-type]
            customer_id=plan.customer_id,
            customer_name=getattr(customer, "name", None) or getattr(project, "customer_name", None),
            project_id=plan.project_id,
            project_number=getattr(project, "project_number", None),
            project_name=getattr(project, "name", None),
            updated_at=plan.updated_at,
        )
    return out


def _status(planned: int, scanned: int) -> str:
    if planned <= 0:
        return STATUS_UNPLANNED
    if scanned < planned:
        return STATUS_OPEN
    return STATUS_DONE if scanned == planned else STATUS_OVER


def material_lines(db: Session, plan: PanelPlan) -> list[PanelMaterialLineOut]:
    planned = planned_lines(plan.document or {})
    articles = resolve_line_articles(db, planned)
    consumed = consumed_by_article(db, plan.id)
    seen_articles: set[int] = set()
    lines: list[PanelMaterialLineOut] = []
    for line in planned:
        hit = articles.get(line.key)
        scanned, last_at = 0, None
        article_out_value, source = None, None
        if hit is not None:
            article, source = hit
            article_out_value = article_out(article)
            if article.id not in seen_articles:
                entry = consumed.get(article.id)
                if entry is not None:
                    scanned, last_at = max(entry.net, 0), entry.last_at
                seen_articles.add(article.id)
        lines.append(
            PanelMaterialLineOut(
                key=line.key,
                kind=line.kind,  # type: ignore[arg-type]
                label=line.label,
                detail=line.detail,
                planned=line.planned,
                scanned=scanned,
                status=_status(line.planned, scanned),  # type: ignore[arg-type]
                article=article_out_value,
                article_source=source,  # type: ignore[arg-type]
                last_scanned_at=last_at,
            )
        )
    extra_ids = [article_id for article_id, entry in consumed.items() if entry.net > 0 and article_id not in seen_articles]
    if extra_ids:
        extras = db.scalars(select(WerkstattArticle).where(WerkstattArticle.id.in_(extra_ids))).all()
        for article in sorted(extras, key=lambda a: a.item_name.lower()):
            entry = consumed[article.id]
            lines.append(
                PanelMaterialLineOut(
                    key=f"article:{article.id}",
                    kind=LINE_EXTRA,
                    label=article.item_name,
                    detail="nicht geplant",
                    planned=0,
                    scanned=entry.net,
                    status=STATUS_UNPLANNED,
                    article=article_out(article),
                    article_source=None,
                    last_scanned_at=entry.last_at,
                )
            )
    return lines


def _totals(lines: list[PanelMaterialLineOut]) -> dict[str, Any]:
    last = [line.last_scanned_at for line in lines if line.last_scanned_at is not None]
    return {
        "planned_total": sum(line.planned for line in lines),
        "scanned_total": sum(line.scanned for line in lines),
        "open_lines": sum(1 for line in lines if line.status == STATUS_OPEN),
        "last_scanned_at": max(last) if last else None,
    }


def panel_material(db: Session, plan: PanelPlan) -> PanelMaterialOut:
    lines = material_lines(db, plan)
    return PanelMaterialOut(panel=panel_refs(db, [plan])[plan.id], lines=lines, **_totals(lines))


def material_overview(db: Session, plans: list[PanelPlan]) -> list[PanelMaterialSummaryOut]:
    """Every board with its picking progress: boards somebody scanned for
    first (newest scan first), then the rest by last edit."""
    refs = panel_refs(db, plans)
    rows = [PanelMaterialSummaryOut(panel=refs[plan.id], **_totals(material_lines(db, plan))) for plan in plans]
    rows.sort(
        key=lambda row: (
            row.last_scanned_at is None,
            -(row.last_scanned_at.timestamp() if row.last_scanned_at else 0),
            -row.panel.updated_at.timestamp(),
        )
    )
    return rows


def line_for_article(material: PanelMaterialOut, article_id: int) -> PanelMaterialLineOut | None:
    for line in material.lines:
        if line.article is not None and line.article.id == article_id:
            return line
    return None


# ── Bookings ──────────────────────────────────────────────────────────────────


def book_consumption(
    db: Session,
    *,
    plan: PanelPlan,
    article: WerkstattArticle,
    quantity: int,
    user_id: int,
    notes: str,
) -> tuple[WerkstattMovement, str | None]:
    """One ``consumption`` row for the board; flushes, does not commit.

    Returns the row and a warning when the shelf did not hold that many —
    the booking still lands (the person is holding the part), the count is
    what needs fixing.
    """
    if bool(article.is_archived):
        raise MaterialError("Artikel ist archiviert — keine Buchungen möglich.")
    available = int(article.stock_available or 0)
    warning = STOCK_WARNING.format(available=available) if quantity > available else None
    try:
        movement = apply_movement(
            db,
            article=article,
            movement_type=CONSUMPTION,
            quantity=quantity,
            user_id=user_id,
            project_id=plan.project_id,
            panel_id=plan.id,
            notes=notes,
        )
    except MovementError as exc:
        raise MaterialError(str(exc)) from exc
    return movement, warning


def undo_consumption(
    db: Session,
    *,
    plan: PanelPlan,
    article: WerkstattArticle,
    quantity: int,
    user_id: int,
    notes: str,
) -> WerkstattMovement:
    """The inverse row, bounded by what the board still has of the article."""
    net = net_consumed(db, plan.id, article.id)
    if quantity > net:
        raise MaterialError(
            f"Nichts zum Zurücknehmen — für {plan.panel_number} sind nur {net} × „{article.item_name}“ gebucht."
        )
    try:
        return apply_movement(
            db,
            article=article,
            movement_type=CONSUMPTION_UNDO,
            quantity=quantity,
            user_id=user_id,
            project_id=plan.project_id,
            panel_id=plan.id,
            notes=notes,
        )
    except MovementError as exc:
        raise MaterialError(str(exc)) from exc


def booking_note(plan: PanelPlan, prefix: str | None = None) -> str:
    """"Regal-Station Werkstatt — Verteiler VT-0007" / "Verteiler VT-0007"."""
    text = f"Verteiler {plan.panel_number}"
    return f"{prefix} — {text}" if prefix else text


# ── Project material tab ──────────────────────────────────────────────────────


@dataclass
class ProjectPanelMaterial:
    article: WerkstattArticle
    net: int
    bookings: int
    last_at: datetime | None
    panel_numbers: list[str]


def project_panel_materials(db: Session, project_id: int) -> list[ProjectPanelMaterial]:
    """What was built into this project's boards, one row per article."""
    rows = db.execute(
        select(
            WerkstattMovement.article_id,
            WerkstattMovement.movement_type,
            WerkstattMovement.quantity,
            WerkstattMovement.created_at,
            PanelPlan.panel_number,
        )
        .join(PanelPlan, PanelPlan.id == WerkstattMovement.panel_id)
        .where(
            PanelPlan.project_id == project_id,
            WerkstattMovement.movement_type.in_((CONSUMPTION, CONSUMPTION_UNDO)),
        )
        .order_by(WerkstattMovement.id.asc())
    ).all()
    if not rows:
        return []
    per_article: dict[int, dict[str, Any]] = {}
    for article_id, movement_type, quantity, created_at, panel_number in rows:
        entry = per_article.setdefault(
            int(article_id), {"net": 0, "bookings": 0, "last_at": None, "panels": []}
        )
        qty = int(quantity or 0)
        if movement_type == CONSUMPTION:
            entry["net"] += qty
            entry["bookings"] += 1
        else:
            entry["net"] -= qty
        if created_at is not None and (entry["last_at"] is None or created_at > entry["last_at"]):
            entry["last_at"] = created_at
        if panel_number not in entry["panels"]:
            entry["panels"].append(str(panel_number))
    articles = {
        a.id: a for a in db.scalars(select(WerkstattArticle).where(WerkstattArticle.id.in_(per_article)))
    }
    out: list[ProjectPanelMaterial] = []
    for article_id, entry in per_article.items():
        article = articles.get(article_id)
        if article is None or entry["net"] <= 0:
            continue
        out.append(
            ProjectPanelMaterial(
                article=article,
                net=int(entry["net"]),
                bookings=int(entry["bookings"]),
                last_at=entry["last_at"],
                panel_numbers=sorted(entry["panels"]),
            )
        )
    out.sort(key=lambda row: row.article.item_name.lower())
    return out
