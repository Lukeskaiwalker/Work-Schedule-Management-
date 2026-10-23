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

Matching a planned line to a stock article (``schaltplan_material_match``,
re-exported here), in this order:

1. an explicit mapping (``schaltplan_material_articles``, keyed by the
   line's key, global — "our B16 is SP-0152" holds for every board);
2. the EAN, for the one line that has one (the U84T rail insulation set);
3. for a WAGO terminal part, the article whose name leads with the part
   number ("WAGO 2003-7641 - TOPJOB S …", the way the catalog names them),
   or whose supplier number is the bare part number; for a cabinet line,
   its article number.

A scanned article that matches no planned line is still booked and shows
as an ``extra`` line ("nicht geplant"): the person at the rack holds the
part, and the list's job is to say what really went in.

A board in a cabinet adds the cabinet, its modules and accessories in front
and the parts taken out of a module behind; ``panel_enclosure_material``
derives those and books the returns (docs/PANEL_ENCLOSURE.md §6). Returns
are not picks: no picking total, Regal screen or consumption ever counts them.
Its WAGO lines come from the terminal placement
(``panel_enclosure_terminal_material``, docs/PANEL_ENCLOSURE_R2.md §5).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Mapping

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.customer import Customer
from app.models.entities import Project, WerkstattArticle, WerkstattMovement
from app.models.schaltplan import PanelMaterialArticle, PanelMaterialManualLine, PanelPlan
from app.schemas.schaltplan import (
    PanelMaterialArticleOut,
    PanelMaterialLineOut,
    PanelMaterialOut,
    PanelMaterialPanelOut,
    PanelMaterialSummaryOut,
)
from app.services import panel_enclosure_material as enclosure_material
from app.services import panel_enclosure_terminal_material as terminal_material
from app.services import panel_work
from app.services.panel_enclosure_catalog import EnclosureCatalog, builtin_catalog, load_catalog
from app.services.panel_enclosure_readable import readable_blocks
from app.services.panel_enclosure_terminals import BoardTerminals, insulation_sets
from app.services.schaltplan_layout import DEVICE_CATALOG, iter_devices

# The matching moved to its own module (R2 §5.2); its names stay importable from here.
from app.services.schaltplan_material_match import (  # noqa: F401  (re-exported)
    LINE_TERMINAL,
    auto_match_part,
    explicit_mappings,
    match_articles_by_ean,
    resolve_line_articles,
)
from app.services.schaltplan_terminals import derive_terminals, terminal_bom
from app.services.werkstatt_movements import MovementError, apply_movement

CONSUMPTION = "consumption"
CONSUMPTION_UNDO = "consumption_undo"

LINE_DEVICE = "device"
LINE_MANUAL = "manual"
LINE_EXTRA = "extra"
LINE_ENCLOSURE = "enclosure"
LINE_REMOVED = "removed"
#: What consumption ticks off — never ``removed``: that part goes back, not in.
CONSUMPTION_KINDS = frozenset({LINE_ENCLOSURE, LINE_DEVICE, LINE_TERMINAL, LINE_MANUAL})
RETURN_SCAN_REFUSED = "Rücklauf: in der Materialliste „Ins Lager“ buchen, nicht scannen."

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


def planned_lines(
    document: dict[str, Any], catalog: EnclosureCatalog | None = None, *,
    terms: BoardTerminals | None = None, placement: Mapping[str, Any] | None = None,
) -> list[PlannedLine]:
    """The board's parts: device types in catalog order, then the WAGO terminals.

    In a cabinet: the cabinet, modules and accessories first (U84T for the
    WAGO rails among them), the parts taken out of a module last, and a
    pre-fitted device is not a device line (the module counts it). The
    terminals then come from the placement: no AAR/NAR/RfZ/APZ circuit, the
    end plates added (docs/PANEL_ENCLOSURE_R2.md §5). ``catalog`` defaults to
    the built-ins for pure callers; ``material_lines`` passes the merged one,
    and ``terms``/``placement`` when it already has them.
    """
    if not enclosure_material.has_enclosure(document):
        return [*_device_lines(document), *_terminal_lines(document)]
    catalog = catalog if catalog is not None else builtin_catalog()
    terms, placement = terminal_material.board_placement(document, catalog, terms, placement)
    return [
        *enclosure_material.enclosure_planned_lines(document, catalog, rail_sets=insulation_sets(placement)),
        *_device_lines(document, skip=enclosure_material.supplied_device_ids(document, catalog), cabinet=True),
        *terminal_material.terminal_lines(document, catalog, terms, placement),
        *enclosure_material.removed_planned_lines(document, catalog),
    ]


def _device_lines(document: dict[str, Any], *, skip: set[str] | None = None, cabinet: bool = False) -> list[PlannedLine]:
    devices: dict[str, dict[str, Any]] = {}
    for _row, device in iter_devices(document):
        if skip and str(device.get("id") or "") in skip:
            continue
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
        name = enclosure_material.METER_ON_CABINET if cabinet and entry["kind"] == "meter" else str(catalog["label"])
        label = " ".join(
            part
            for part in (
                name,
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
    return lines


def _terminal_lines(document: dict[str, Any]) -> list[PlannedLine]:
    return [
        PlannedLine(
            key=f"part:{row['part_id']}",
            kind=LINE_TERMINAL,
            label=str(row["part_no"]),
            detail=str(row["name"]),
            planned=int(row["count"]),
        )
        for row in terminal_bom(derive_terminals(document))
    ]


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
class LedgerSum:
    net: int = 0
    bookings: int = 0
    last_at: datetime | None = None


def consumed_by_article(db: Session, panel_id: int) -> dict[int, LedgerSum]:
    """article id → what the ledger says was built into this board."""
    return ledger_by_article(db, panel_id, CONSUMPTION, CONSUMPTION_UNDO)


def ledger_by_article(db: Session, panel_id: int, booking: str, undo: str) -> dict[int, LedgerSum]:
    """article id → net of one booking type and its undo for this board."""
    rows = db.execute(
        select(
            WerkstattMovement.article_id,
            WerkstattMovement.movement_type,
            WerkstattMovement.quantity,
            WerkstattMovement.created_at,
        )
        .where(
            WerkstattMovement.panel_id == panel_id,
            WerkstattMovement.movement_type.in_((booking, undo)),
        )
        .order_by(WerkstattMovement.id.asc())
    ).all()
    out: dict[int, LedgerSum] = {}
    for article_id, movement_type, quantity, created_at in rows:
        _add(out.setdefault(int(article_id), LedgerSum()), movement_type == booking, quantity, created_at)
    return out


def _add(entry: LedgerSum, is_booking: bool, quantity: Any, created_at: datetime | None) -> None:
    # The running sum is local to one read; nothing shared is changed.
    qty = int(quantity or 0)
    if is_booking:
        entry.net += qty
        entry.bookings += 1
    else:
        entry.net -= qty
    if created_at is not None and (entry.last_at is None or created_at > entry.last_at):
        entry.last_at = created_at


def net_consumed(db: Session, panel_id: int, article_id: int) -> int:
    return consumed_by_article(db, panel_id).get(article_id, LedgerSum()).net


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


def allocate_scans(planned: list[int], net: int) -> list[int]:
    """Spread one article's booked pieces over the lines that name it.

    In list order, each line fills up to its planned count; the last one
    takes whatever is left, so a surplus shows as "zu viel" exactly once.
    Two planned LS B16 plus one added by hand, three booked: 2 + 1, both
    done — not 3 on the first line ("zu viel") and the added one open forever.
    """
    remaining = max(net, 0)
    shares: list[int] = []
    for index, want in enumerate(planned):
        take = remaining if index == len(planned) - 1 else min(remaining, max(want, 0))
        shares.append(take)
        remaining -= take
    return shares


def material_lines(db: Session, plan: PanelPlan, catalog: EnclosureCatalog | None = None) -> list[PanelMaterialLineOut]:
    # A stored cabinet block the types refuse is left out, as the detail route does (D14).
    document = readable_blocks(plan.document or {})
    numbers: dict[str, str] = {}
    eans: dict[str, str] = {}
    if enclosure_material.has_enclosure(document):
        catalog = catalog if catalog is not None else load_catalog(db)  # once, and only for a board in a cabinet
        terms, placement = terminal_material.board_placement(document, catalog)
        planned = planned_lines(document, catalog, terms=terms, placement=placement)
        numbers = enclosure_material.line_article_numbers(document, catalog)
        eans = terminal_material.line_eans(document, catalog, placement)
    else:
        planned = planned_lines(document, catalog)
    articles = resolve_line_articles(db, planned, numbers, eans)
    consumed = consumed_by_article(db, plan.id)
    # Every line first, without scans: the derived ones, then the lines added
    # by hand (owner, 2026-10-09) in the order they were added — after the
    # derived ones and before "nicht geplant".
    lines: list[PanelMaterialLineOut] = []
    for line in planned:
        hit = articles.get(line.key)
        article, source = hit if hit is not None else (None, None)
        lines.append(
            PanelMaterialLineOut(
                key=line.key,
                kind=line.kind,  # type: ignore[arg-type]
                label=line.label,
                detail=line.detail,
                planned=line.planned,
                status=_status(line.planned, 0),  # type: ignore[arg-type]
                article=article_out(article) if article is not None else None,
                article_source=source,  # type: ignore[arg-type]
            )
        )
    for row, article in manual_lines(db, plan.id):
        note = (row.note or "").strip() or None
        lines.append(
            PanelMaterialLineOut(
                key=f"manual:{row.id}",
                kind=LINE_MANUAL,  # type: ignore[arg-type]
                label=(article.item_name if article is not None else row.label) or "Material",
                detail=note or "manuell",
                planned=int(row.quantity),
                status=_status(int(row.quantity), 0),  # type: ignore[arg-type]
                article=article_out(article) if article is not None else None,
                article_source="manual" if article is not None else None,  # type: ignore[arg-type]
                manual_id=row.id,
                note=note,
            )
        )

    # Then the scans: a booked article ticks off the lines that name it —
    # consumption the parts going in, returns (salvage) the removed ones.
    indexes_by_article: dict[int, list[int]] = {}
    for index, line in enumerate(lines):
        if line.article is not None and line.kind in CONSUMPTION_KINDS:
            indexes_by_article.setdefault(line.article.id, []).append(index)
    for article_id, indexes in indexes_by_article.items():
        entry = consumed.get(article_id)
        if entry is not None:
            lines = tick_lines(lines, indexes, entry)
    lines, orphans = enclosure_material.apply_salvage(db, plan.id, lines)
    extra_ids = [
        article_id for article_id, entry in consumed.items() if entry.net > 0 and article_id not in indexes_by_article
    ]
    return [*lines, *orphans, *_extra_lines(db, consumed, extra_ids)]


def tick_lines(lines: list[PanelMaterialLineOut], indexes: list[int], entry: LedgerSum) -> list[PanelMaterialLineOut]:
    """The lines with one article's booked pieces spread over those at ``indexes``."""
    shares = allocate_scans([lines[index].planned for index in indexes], entry.net)
    out = list(lines)
    for position, (index, share) in enumerate(zip(indexes, shares)):
        line = out[index]
        out[index] = line.model_copy(
            update={
                "scanned": share,
                "status": _status(line.planned, share),
                # The first line keeps the date even when undo took its
                # pieces back; a later one only once something reached it.
                "last_scanned_at": entry.last_at if position == 0 or share > 0 else None,
            }
        )
    return out


def _extra_lines(db: Session, consumed: dict[int, LedgerSum], extra_ids: list[int]) -> list[PanelMaterialLineOut]:
    if not extra_ids:
        return []
    extras = db.scalars(select(WerkstattArticle).where(WerkstattArticle.id.in_(extra_ids))).all()
    return [
        PanelMaterialLineOut(
            key=f"article:{article.id}",
            kind=LINE_EXTRA,
            label=article.item_name,
            detail="nicht geplant",
            planned=0,
            scanned=consumed[article.id].net,
            status=STATUS_UNPLANNED,
            article=article_out(article),
            article_source=None,
            last_scanned_at=consumed[article.id].last_at,
        )
        for article in sorted(extras, key=lambda a: a.item_name.lower())
    ]


def manual_lines(db: Session, panel_id: int) -> list[tuple[PanelMaterialManualLine, WerkstattArticle | None]]:
    """A board's hand-added lines in the order they were added, with their articles."""
    rows = list(
        db.scalars(
            select(PanelMaterialManualLine)
            .where(PanelMaterialManualLine.panel_id == panel_id)
            .order_by(PanelMaterialManualLine.id.asc())
        ).all()
    )
    article_ids = {row.article_id for row in rows if row.article_id is not None}
    articles = (
        {a.id: a for a in db.scalars(select(WerkstattArticle).where(WerkstattArticle.id.in_(article_ids))).all()}
        if article_ids
        else {}
    )
    return [(row, articles.get(row.article_id) if row.article_id is not None else None) for row in rows]


def counts_toward_picking(line: PanelMaterialLineOut) -> bool:
    """A line the shelf can tick off. A free text added by hand has no
    article to scan: it is listed with its quantity but stays out of the
    picking totals — or a fully picked board would read "1 offen" forever,
    in the list, the Werkstatt overview and on the Regal screen alike.
    A part taken out of a module is not picked either: it goes back."""
    if line.kind == LINE_REMOVED:
        return False
    return not (line.kind == LINE_MANUAL and line.article is None)


def _totals(lines: list[PanelMaterialLineOut]) -> dict[str, Any]:
    counted = [line for line in lines if counts_toward_picking(line)]
    last = [line.last_scanned_at for line in counted if line.last_scanned_at is not None]
    return {
        "planned_total": sum(line.planned for line in counted),
        "scanned_total": sum(line.scanned for line in counted),
        "open_lines": sum(1 for line in counted if line.status == STATUS_OPEN),
        "returns_open": sum(max(line.planned - line.scanned, 0) for line in lines if line.kind == LINE_REMOVED),
        "last_scanned_at": max(last) if last else None,
    }


def panel_material(db: Session, plan: PanelPlan, catalog: EnclosureCatalog | None = None) -> PanelMaterialOut:
    lines = material_lines(db, plan, catalog)
    # The hours ride beside the parts, never among them: _totals counts pieces.
    labour_lines, labour_minutes, labour_running = panel_work.labour(db, plan.id)
    return PanelMaterialOut(
        panel=panel_refs(db, [plan])[plan.id],
        lines=lines,
        **_totals(lines),
        labour=labour_lines,
        labour_minutes=labour_minutes,
        labour_running=labour_running,
    )


def material_overview(db: Session, plans: list[PanelPlan]) -> list[PanelMaterialSummaryOut]:
    """Every board with its picking progress: boards somebody scanned for
    first (newest scan first), then the rest by last edit."""
    refs = panel_refs(db, plans)
    # One catalogue for every board, loaded only if one of them has a cabinet.
    catalog = load_catalog(db) if any(enclosure_material.has_enclosure(plan.document) for plan in plans) else None
    rows = [PanelMaterialSummaryOut(panel=refs[plan.id], **_totals(material_lines(db, plan, catalog))) for plan in plans]
    rows.sort(
        key=lambda row: (
            row.last_scanned_at is None,
            -(row.last_scanned_at.timestamp() if row.last_scanned_at else 0),
            -row.panel.updated_at.timestamp(),
        )
    )
    return rows


def line_for_article(
    material: PanelMaterialOut, article_id: int, *, undone: bool = False
) -> PanelMaterialLineOut | None:
    """The line a booking of this article landed on — after an undo, the one
    the piece came off. The Regal's flash and row highlight come from it.

    Scans fill the lines naming an article in list order (``allocate_scans``):
    a booking lands on the LAST line holding any; an undo takes from the
    first line no longer full, or from the last one when every line is full
    (the surplus sat there). The first line alone was right only while one
    article meant one line — a hand-added "one more B16" broke that.
    A removed line never: no scan lands on a part going back to the shelf.
    """
    named = [
        line
        for line in material.lines
        if line.article is not None and line.article.id == article_id and line.kind != LINE_REMOVED
    ]
    if not named:
        return None
    if undone:
        return next((line for line in named if line.scanned < line.planned), named[-1])
    return next((line for line in reversed(named) if line.scanned > 0), named[0])


def picking_view(material: PanelMaterialOut) -> PanelMaterialOut:
    """The list as the Regal shows it: returns are booked in the Materialliste, never picked."""
    return material.model_copy(update={"lines": [line for line in material.lines if line.kind != LINE_REMOVED]})


def removed_only(material: PanelMaterialOut, article_id: int) -> bool:
    """Only "aus Modul entfernt" lines plan it: a Regal scan would book a return as built in."""
    named = [line for line in material.lines if line.article is not None and line.article.id == article_id]
    return any(line.key.startswith(enclosure_material.REMOVED_PREFIX) for line in named) and not any(
        line.kind in CONSUMPTION_KINDS for line in named
    )


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
    # What the tab calls the row: the article's name, or for a part that went
    # back "Rücklauf ins Lager · …" with a negative ``net``.
    label: str = ""


def project_panel_materials(db: Session, project_id: int) -> list[ProjectPanelMaterial]:
    """What was built into this project's boards, one row per article, then
    what came back out of them as negative rows (owner, 2026-10-21: a return
    reduces the project's material, quantity only)."""
    built = project_ledger_rows(db, project_id, CONSUMPTION, CONSUMPTION_UNDO)
    return [*built, *enclosure_material.project_panel_returns(db, project_id)]


def project_ledger_rows(db: Session, project_id: int, booking: str, undo: str) -> list[ProjectPanelMaterial]:
    """One booking type net of its undo over the project's boards: a row per
    article with something left, by name."""
    rows = db.execute(
        select(
            WerkstattMovement.article_id,
            WerkstattMovement.movement_type,
            WerkstattMovement.quantity,
            WerkstattMovement.created_at,
            PanelPlan.panel_number,
        )
        .join(PanelPlan, PanelPlan.id == WerkstattMovement.panel_id)
        .where(PanelPlan.project_id == project_id, WerkstattMovement.movement_type.in_((booking, undo)))
        .order_by(WerkstattMovement.id.asc())
    ).all()
    if not rows:
        return []
    per_article: dict[int, LedgerSum] = {}
    panels: dict[int, set[str]] = {}
    for article_id, movement_type, quantity, created_at, panel_number in rows:
        _add(per_article.setdefault(int(article_id), LedgerSum()), movement_type == booking, quantity, created_at)
        panels.setdefault(int(article_id), set()).add(str(panel_number))
    articles = {
        a.id: a for a in db.scalars(select(WerkstattArticle).where(WerkstattArticle.id.in_(per_article)))
    }
    out = [
        ProjectPanelMaterial(
            article=articles[article_id],
            net=entry.net,
            bookings=entry.bookings,
            last_at=entry.last_at,
            panel_numbers=sorted(panels[article_id]),
            label=articles[article_id].item_name,
        )
        for article_id, entry in per_article.items()
        if article_id in articles and entry.net > 0
    ]
    out.sort(key=lambda row: row.article.item_name.lower())
    return out
