"""The cabinet's share of a board's Materialliste (docs/PANEL_ENCLOSURE.md §6).

``services/schaltplan_material`` owns the list; this module adds what a
cabinet brings to it, and books what comes back out of one:

* **Lines the cabinet adds**: the cabinet itself, its field modules
  (counted), their accessories and one blind plate per reserve meter place.
  Meters never: the grid operator supplies them (D7). Among the accessories,
  the U84T rail insulation the WAGO terminal rails need (one line with an
  admin's own U84T accessory, the larger count; docs/PANEL_ENCLOSURE_R2.md
  §5, ``panel_enclosure_terminal_material``).
* **Pre-fitted parts** (D5). A module's ``fittings`` snapshot says what came
  in the box. A device that claims one through ``supplied_by`` is the
  module's part, counted by the module line and never again as a device. A
  fitting nobody claims any more (or, without a device, one listed in
  ``removed_fittings``) was taken out: it becomes a ``removed`` line, "aus
  Modul entfernt → ins Lager", while the module line stays as bought (D3).
  Which parts there are, what they are called and how many came out is
  read from the SNAPSHOT, never the live catalogue, so a catalogue
  correction can never rewrite the list of a board that was planned, picked
  or built — only a module without a snapshot (a hand-made document) falls
  back to the catalogue. What a return books into stock is the exception:
  any fitter writes the snapshot, so whether a part may come out at all and
  the article number its line is matched on are the catalogue's (admins).
* **Returns** (D6). A removed part booked back onto the shelf is a
  ``salvage`` ledger row; taking it back is ``salvage_undo``. A return
  raises stock without an earlier decrement, so the guards are strict: the
  Werkstatt books it (the router), only for an article a removed line of
  this board names, never past that line's count, and taking it back never
  past the board's net nor past what is still on the shelf.

Matching article numbers to stock is ``panel_enclosure_catalog``'s
whole-token matcher, re-exported here (one matcher for the catalogue and the
list, so "ZH3EH16" means the same article in both).
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import PanelPlan, WerkstattArticle, WerkstattMovement
from app.schemas.schaltplan import PanelMaterialLineOut
from app.services import panel_enclosure_terminal_material as terminal_material
from app.services import schaltplan_material as material
from app.services.panel_enclosure_catalog import EnclosureCatalog, match_articles_by_number
from app.services.schaltplan_layout import iter_devices
from app.services.werkstatt_movements import MovementError, apply_movement

__all__ = [
    "RemovedFitting", "has_enclosure", "module_fittings", "supplied_device_ids", "removed_fittings",
    "enclosure_planned_lines", "accessory_quantities", "removed_planned_lines", "line_article_numbers",
    "match_articles_by_number",
    "salvaged_by_article", "apply_salvage", "book_salvage", "undo_salvage", "project_panel_returns",
]

SALVAGE = "salvage"
SALVAGE_UNDO = "salvage_undo"
LINE_ENCLOSURE = "enclosure"
LINE_REMOVED = "removed"
REMOVED_PREFIX = "removed:"
#: The 150 mm raster, for a module whose cabinet the catalogue does not know.
DEFAULT_UNIT_MM = 150
#: A DIN-rail meter on a board with a cabinet. The eHZ itself sits on a meter
#: place and is no material (D7); the label must not invite one on a rail.
METER_ON_CABINET = "Zwischenzähler (Hutschiene)"

UNKNOWN_DETAIL = "nicht im Schrankkatalog"
REMOVED_DETAIL = "aus Modul entfernt → ins Lager · {art}"
ORPHAN_DETAIL = "eingelagert, im Plan nicht mehr als entfernt geführt"
RETURN_LABEL = "Rücklauf ins Lager · {name}"

ARCHIVED = "Artikel ist archiviert — keine Buchungen möglich."
MACHINE = "Maschinen kommen nicht über die Materialliste ins Lager."
NOT_REMOVED = "Dieser Artikel steht nicht als „aus Modul entfernt“ auf der Liste."
OVER = "Mehr als aus Modulen entfernt — offen sind noch {n}."
NOTHING_BACK = "Nichts zum Zurücknehmen — für {panel} sind nur {n} × „{name}“ eingelagert."
SHELF_EMPTY = "Schon wieder ausgegeben oder verbaut — erst den Bestand prüfen."


@dataclass(frozen=True)
class RemovedFitting:
    module_id: str
    module_code: str
    module_article_no: str
    fitting_key: str
    label: str
    article_no: str | None


# ── Reading the document ─────────────────────────────────────────────────────


def has_enclosure(document: Any) -> bool:
    """A board "with a cabinet": ``document.enclosure`` is set (D2)."""
    return isinstance(document, Mapping) and isinstance(document.get("enclosure"), Mapping)


def _modules(document: Any) -> list[Mapping[str, Any]]:
    # Tolerant: a stored board may come from a tablet several versions behind.
    if not has_enclosure(document):
        return []
    modules = document["enclosure"].get("modules")
    return [module for module in modules if isinstance(module, Mapping)] if isinstance(modules, list) else []


def _code(value: Any) -> str:
    return value.strip().upper() if isinstance(value, str) else ""


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def module_fittings(module: Mapping[str, Any], catalog: EnclosureCatalog) -> list[dict[str, Any]]:
    """The module's pre-fitted parts: its snapshot, else the catalogue's non-retired ones.

    Any list is a snapshot, an empty one included ("nothing came pre-fitted");
    only a module without one (no key, or null: a hand-made document) reads
    the catalogue. One shape either way (``key``, ``label``, ``article_no``,
    ``device_kind``, ``removable``), always new dicts.
    """
    snapshot = module.get("fittings")
    if isinstance(snapshot, list):
        taken = [item for item in snapshot if isinstance(item, Mapping) and _text(item.get("key"))]
        return [_fitting(item, item.get("device_kind")) for item in taken]
    spec = catalog.module(module.get("code"))
    if spec is None:
        return []
    out: list[dict[str, Any]] = []
    for item in spec.get("fittings") or []:
        if isinstance(item, Mapping) and not item.get("retired"):
            device = item.get("device")
            out.append(_fitting(item, device.get("kind") if isinstance(device, Mapping) else None))
    return out


def _fitting(item: Mapping[str, Any], device_kind: Any) -> dict[str, Any]:
    key = _text(item.get("key"))
    return {
        "key": key,
        "label": _text(item.get("label")) or key,
        "article_no": _text(item.get("article_no")) or None,
        "device_kind": _text(device_kind) or None,
        "removable": bool(item.get("removable")),
    }


def _claims(document: Any) -> Iterator[tuple[str, str, str]]:
    """(device id, module id, fitting key) for every device naming a fitting, in row order."""
    for _row, device in iter_devices(document):
        claim = device.get("supplied_by")
        if isinstance(claim, Mapping) and isinstance(claim.get("module"), str) and isinstance(claim.get("part"), str):
            yield str(device.get("id") or ""), claim["module"], claim["part"]


def supplied_device_ids(document: Any, catalog: EnclosureCatalog) -> set[str]:
    """Devices the module counts: the FIRST claimant of a device fitting its snapshot has.

    Read from the snapshot, so it holds for unknown and invalid codes too. A
    second claimant, or one naming a module or key that is gone, is an
    ordinary device again (``encl.supplied_dangling`` says so).
    """
    device_parts = {
        str(module.get("id") or ""): {
            fitting["key"] for fitting in module_fittings(module, catalog) if fitting["device_kind"]
        }
        for module in _modules(document)
    }
    seen: set[tuple[str, str]] = set()
    supplied: set[str] = set()
    for device_id, module_id, part in _claims(document):
        if part in device_parts.get(module_id, set()) and (module_id, part) not in seen:
            seen.add((module_id, part))
            supplied.add(device_id)
    return supplied


def removed_fittings(document: Any, catalog: EnclosureCatalog) -> list[RemovedFitting]:
    """Fittings taken out, in module then snapshot order (§2.3 "Fitting removed?").

    A device fitting is out when no device claims it; one without a device
    when its key is in ``removed_fittings``. A fixed (non-removable) part is
    never out, whatever the list says.

    The snapshot is part of the board, and any fitter writes the board. So
    it says WHICH parts came out and how they are called, but what a return
    books into stock is the catalogue's (admins): a part is removable only if
    the catalogue agrees, and ``article_no`` is the catalogue's number, never
    the snapshot's. Otherwise a crafted board could free a fixed part and
    name an article of its choosing for the Werkstatt to book in (D11, §15).
    Only a code the catalogue cannot resolve leaves the snapshot alone — and
    then there is no number to match, so the Werkstatt maps the line.
    """
    claimed = {(module_id, part) for _, module_id, part in _claims(document)}
    out: list[RemovedFitting] = []
    for module in _modules(document):
        module_id = str(module.get("id") or "")
        code = _code(module.get("code"))
        spec = catalog.module(code)
        truth = _catalogue_fittings(spec) if spec is not None else None
        listed = module.get("removed_fittings")
        removed_keys = {key for key in listed if isinstance(key, str)} if isinstance(listed, list) else set()
        for fitting in module_fittings(module, catalog):
            entry = truth.get(fitting["key"]) if truth is not None else None
            if not _removable(fitting, truth, entry):
                continue
            if fitting["device_kind"]:
                gone = (module_id, fitting["key"]) not in claimed
            else:
                gone = fitting["key"] in removed_keys
            if gone:
                out.append(
                    RemovedFitting(
                        module_id=module_id,
                        module_code=code,
                        module_article_no=str(spec["article_no"]) if spec is not None else code,
                        fitting_key=fitting["key"],
                        label=fitting["label"],
                        article_no=(_text(entry.get("article_no")) or None) if entry is not None else None,
                    )
                )
    return out


def _removable(
    fitting: Mapping[str, Any], truth: Mapping[str, Mapping[str, Any]] | None, entry: Mapping[str, Any] | None
) -> bool:
    """The snapshot says so and, for a code the catalogue resolves, the catalogue too."""
    if not fitting["removable"]:
        return False
    return truth is None or (entry is not None and bool(entry.get("removable")))


def _catalogue_fittings(spec: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    """fitting key → the catalogue's fitting, retired ones included (a board
    placed before the retirement still has the part)."""
    items = spec.get("fittings")
    if not isinstance(items, list):
        return {}
    return {_text(item.get("key")): item for item in items if isinstance(item, Mapping) and _text(item.get("key"))}


def free_meter_places(module: Mapping[str, Any], spec: Mapping[str, Any]) -> int:
    """Meter places without an entry: reserve, covered by a blind plate (D7).
    An entry for a place the module does not have is ignored."""
    places = sum(int(zone.get("meter_places") or 0) for zone in spec.get("zones") or [] if zone.get("type") == "ZF")
    meters = module.get("meters")
    occupied = {
        meter.get("place")
        for meter in (meters if isinstance(meters, list) else [])
        if isinstance(meter, Mapping) and type(meter.get("place")) is int and 0 <= meter["place"] < places
    }
    return places - len(occupied)


# ── Planned lines ────────────────────────────────────────────────────────────


def _fields(count: int) -> str:
    return f"{count} Feld" if count == 1 else f"{count} Felder"


def _maker(spec: Mapping[str, Any]) -> str:
    return f"{spec.get('manufacturer') or 'Hager'} {spec['article_no']}"


def enclosure_planned_lines(document: Any, catalog: EnclosureCatalog, rail_sets: int = 0) -> list[material.PlannedLine]:
    """Cabinet, modules (counted, first-placement order), then accessories and blind plates.

    ``rail_sets``: the U84T sets the WAGO placement needs (R2 §5.1); they
    join the accessories as one line with an admin's own U84T accessory.
    """
    if not has_enclosure(document):
        return []
    code = _code(document["enclosure"].get("code"))
    cabinet = catalog.enclosure(code)
    modules = _modules(document)
    lines: list[material.PlannedLine] = []
    if code:
        lines.append(_cabinet_line(code, cabinet))
    unit_mm = int(cabinet.get("unit_mm") or DEFAULT_UNIT_MM) if cabinet is not None else DEFAULT_UNIT_MM
    lines.extend(_module_lines(modules, catalog, unit_mm))
    lines.extend(_accessory_lines(_accessories(cabinet, modules, catalog), rail_sets))
    return lines


def _cabinet_line(code: str, cabinet: Mapping[str, Any] | None) -> material.PlannedLine:
    if cabinet is None:
        label = f"Schrank {code} (unbekannt)"
        return material.PlannedLine(f"enclosure:{code}", LINE_ENCLOSURE, label, UNKNOWN_DETAIL, 1)
    size = f"{cabinet['height_mm']} × {cabinet['width_mm']} × {cabinet['depth_mm']} mm"
    detail = f"{_maker(cabinet)} · {size} · {_fields(int(cabinet['fields']))}"
    return material.PlannedLine(f"enclosure:{code}", LINE_ENCLOSURE, str(cabinet["name"]), detail, 1)


def _module_lines(
    modules: list[Mapping[str, Any]], catalog: EnclosureCatalog, unit_mm: int
) -> list[material.PlannedLine]:
    counts: dict[str, int] = {}
    for module in modules:
        code = _code(module.get("code"))
        if code:
            counts[code] = counts.get(code, 0) + 1
    lines: list[material.PlannedLine] = []
    for code, count in counts.items():
        spec = catalog.module(code)
        if spec is None:
            label = f"Modul {code} (unbekannt)"
            lines.append(material.PlannedLine(f"module:{code}", LINE_ENCLOSURE, label, UNKNOWN_DETAIL, count))
            continue
        height = int(spec["height_units"]) * unit_mm
        detail = f"{_maker(spec)} · {_fields(int(spec['width_fields']))} · {height} mm"
        lines.append(material.PlannedLine(f"module:{code}", LINE_ENCLOSURE, str(spec["name"]), detail, count))
    return lines


def _accessories(
    cabinet: Mapping[str, Any] | None, modules: list[Mapping[str, Any]], catalog: EnclosureCatalog
) -> dict[str, dict[str, Any]]:
    """article number → {label, detail, qty}, quantities summed over cabinet and modules.
    The first mention names the line; a free place adds its module's blind plate."""
    found: dict[str, dict[str, Any]] = {}

    def add(owner: Mapping[str, Any], accessory: Mapping[str, Any], prefix: str, times: int) -> None:
        number = _text(accessory.get("article_no"))
        if not number or times <= 0:
            return
        entry = found.get(number)
        if entry is None:
            unchecked = "" if accessory.get("verified", True) else " · ungeprüft"
            detail = f"{prefix} · {owner.get('manufacturer') or 'Hager'} {number}{unchecked}"
            entry = found[number] = {"label": _text(accessory.get("label")) or number, "detail": detail, "qty": 0}
        entry["qty"] += int(accessory.get("qty") or 1) * times

    for accessory in (cabinet or {}).get("accessories") or []:
        add(cabinet or {}, accessory, "Zubehör", 1)
    for module in modules:
        spec = catalog.module(module.get("code"))
        if spec is None:
            continue
        for accessory in spec.get("accessories") or []:
            add(spec, accessory, "Zubehör", 1)
        cover = spec.get("free_place_cover")
        if isinstance(cover, Mapping):
            add(spec, cover, "Blindabdeckung freier Zählerplatz", free_meter_places(module, spec))
    return found


def accessory_quantities(document: Any, catalog: EnclosureCatalog) -> dict[str, int]:
    """article number → the quantity the cabinet's and modules' accessories add up to."""
    if not has_enclosure(document):
        return {}
    cabinet = catalog.enclosure(_code(document["enclosure"].get("code")))
    return {number: int(entry["qty"]) for number, entry in _accessories(cabinet, _modules(document), catalog).items()}


def _accessory_lines(found: Mapping[str, Mapping[str, Any]], rail_sets: int) -> list[material.PlannedLine]:
    """One line per accessory article. U84T is one line with the WAGO rails'
    insulation sets: the larger count and the derived label (R2 §5.1)."""
    u84t = terminal_material.U84T_ARTICLE_NO
    lines: list[material.PlannedLine] = []
    for number, entry in found.items():
        if number == u84t:
            line = terminal_material.u84t_line(int(entry["qty"]), rail_sets)
            lines.extend([line] if line is not None else [])
            continue
        lines.append(material.PlannedLine(f"accessory:{number}", LINE_ENCLOSURE, entry["label"], entry["detail"],
                                          entry["qty"]))
    derived = terminal_material.u84t_line(0, rail_sets) if u84t not in found else None
    return [*lines, *([derived] if derived is not None else [])]


def removed_planned_lines(document: Any, catalog: EnclosureCatalog) -> list[material.PlannedLine]:
    """One ``removed:{module code}:{fitting key}`` line per kind of part taken out, counted."""
    grouped: dict[str, tuple[RemovedFitting, int]] = {}
    for item in removed_fittings(document, catalog):
        key = f"{REMOVED_PREFIX}{item.module_code}:{item.fitting_key}"
        first, count = grouped.get(key, (item, 0))
        grouped[key] = (first, count + 1)
    return [
        material.PlannedLine(key, LINE_REMOVED, first.label, REMOVED_DETAIL.format(art=first.module_article_no), count)
        for key, (first, count) in grouped.items()
    ]


def line_article_numbers(document: Any, catalog: EnclosureCatalog) -> dict[str, str]:
    """line key → the article number its automatic stock match looks for."""
    if not has_enclosure(document):
        return {}
    out: dict[str, str] = {}
    code = _code(document["enclosure"].get("code"))
    cabinet = catalog.enclosure(code)
    specs: list[Mapping[str, Any]] = []
    if cabinet is not None:
        out[f"enclosure:{code}"] = str(cabinet["article_no"])
        specs.append(cabinet)
    for module in _modules(document):
        spec = catalog.module(module.get("code"))
        if spec is not None:
            out[f"module:{_code(module.get('code'))}"] = str(spec["article_no"])
            specs.append(spec)
    for spec in specs:
        cover = spec.get("free_place_cover")
        for accessory in [*(spec.get("accessories") or []), *([cover] if isinstance(cover, Mapping) else [])]:
            number = _text(accessory.get("article_no"))
            if number:
                out[f"accessory:{number}"] = number
    for item in removed_fittings(document, catalog):
        if item.article_no:
            out.setdefault(f"{REMOVED_PREFIX}{item.module_code}:{item.fitting_key}", item.article_no)
    # The WAGO rails' insulation set (R2 §5.2): matched after its EAN.
    out.setdefault(terminal_material.U84T_KEY, terminal_material.U84T_ARTICLE_NO)
    return out


# ── Returns on the list ──────────────────────────────────────────────────────


def salvaged_by_article(db: Session, panel_id: int) -> dict[int, material.LedgerSum]:
    """article id → what the ledger says came back out of this board."""
    return material.ledger_by_article(db, panel_id, SALVAGE, SALVAGE_UNDO)


def apply_salvage(
    db: Session, panel_id: int, lines: list[PanelMaterialLineOut]
) -> tuple[list[PanelMaterialLineOut], list[PanelMaterialLineOut]]:
    """(the lines with returns ticked off the removed ones, the orphan lines).

    A return whose article no removed line names any more — the fitting was
    put back, the module or the cabinet removed, the line remapped — keeps
    its own line (planned 0), so "Zurücknehmen" stays reachable.
    """
    salvaged = salvaged_by_article(db, panel_id)
    if not salvaged:
        return lines, []
    indexes: dict[int, list[int]] = {}
    for index, line in enumerate(lines):
        if line.kind == LINE_REMOVED and line.article is not None:
            indexes.setdefault(line.article.id, []).append(index)
    ticked = lines
    for article_id, positions in indexes.items():
        entry = salvaged.get(article_id)
        if entry is not None:
            ticked = material.tick_lines(ticked, positions, entry)
    orphan_ids = [article_id for article_id, entry in salvaged.items() if entry.net > 0 and article_id not in indexes]
    if not orphan_ids:
        return ticked, []
    articles = db.scalars(select(WerkstattArticle).where(WerkstattArticle.id.in_(orphan_ids))).all()
    orphans = [
        PanelMaterialLineOut(
            key=f"salvage:{article.id}",
            kind=LINE_REMOVED,
            label=article.item_name,
            detail=ORPHAN_DETAIL,
            planned=0,
            scanned=salvaged[article.id].net,
            status=material.STATUS_UNPLANNED,
            article=material.article_out(article),
            last_scanned_at=salvaged[article.id].last_at,
        )
        for article in sorted(articles, key=lambda a: a.item_name.lower())
    ]
    return ticked, orphans


# ── Booking returns ──────────────────────────────────────────────────────────


def _assert_bookable(article: WerkstattArticle) -> None:
    if bool(article.is_archived):
        raise material.MaterialError(ARCHIVED)
    # A machine has a unit register of its own; a count raised here would
    # leave the register and the shelf disagreeing about which drill is where.
    if bool(article.is_serialized):
        raise material.MaterialError(MACHINE)


def book_salvage(
    db: Session, *, plan: PanelPlan, article: WerkstattArticle, quantity: int, user_id: int
) -> WerkstattMovement:
    """One ``salvage`` row: a removed part back on the shelf. Flushes, no commit.

    Only up to what the board's removed lines naming the article still have
    open — a return without a part taken out would be stock from nowhere.
    """
    _assert_bookable(article)
    named = [
        line
        for line in material.material_lines(db, plan)
        if line.key.startswith(REMOVED_PREFIX) and line.article is not None and line.article.id == article.id
    ]
    if not named:
        raise material.MaterialError(NOT_REMOVED)
    still_open = max(sum(line.planned for line in named) - sum(line.scanned for line in named), 0)
    if quantity > still_open:
        raise material.MaterialError(OVER.format(n=still_open))
    return _move(db, plan, article, SALVAGE, quantity, user_id, material.booking_note(plan, "Rücklauf"))


def undo_salvage(
    db: Session, *, plan: PanelPlan, article: WerkstattArticle, quantity: int, user_id: int
) -> WerkstattMovement:
    """The inverse row, bounded by the board's net returns and by the shelf.

    The shelf bound is the one that matters: the returned part may long since
    have gone into another board, and taking it back then would push the
    ledger below zero (the ``salvage_undo`` guard in ``apply_movement``).
    """
    _assert_bookable(article)
    entry = salvaged_by_article(db, plan.id).get(article.id)
    net = max(entry.net, 0) if entry is not None else 0
    if quantity > net:
        raise material.MaterialError(NOTHING_BACK.format(panel=plan.panel_number, n=net, name=article.item_name))
    if quantity > int(article.stock_available or 0):
        raise material.MaterialError(SHELF_EMPTY)
    return _move(db, plan, article, SALVAGE_UNDO, quantity, user_id, material.booking_note(plan, "Rücklauf storniert"))


def _move(
    db: Session, plan: PanelPlan, article: WerkstattArticle, movement_type: str, quantity: int, user_id: int, notes: str
) -> WerkstattMovement:
    try:
        return apply_movement(
            db,
            article=article,
            movement_type=movement_type,
            quantity=quantity,
            user_id=user_id,
            project_id=plan.project_id,
            panel_id=plan.id,
            notes=notes,
        )
    except MovementError as exc:
        raise material.MaterialError(str(exc)) from exc


# ── Project material tab (owner, 2026-10-21) ─────────────────────────────────


def project_panel_returns(db: Session, project_id: int) -> list[material.ProjectPanelMaterial]:
    """What came back out of the project's boards, as negative rows.

    Quantity only: the price credit stays a billing decision, so nothing
    here carries a price.
    """
    rows = material.project_ledger_rows(db, project_id, SALVAGE, SALVAGE_UNDO)
    return [
        material.ProjectPanelMaterial(
            article=row.article,
            net=-row.net,
            bookings=row.bookings,
            last_at=row.last_at,
            panel_numbers=row.panel_numbers,
            label=RETURN_LABEL.format(name=row.article.item_name),
        )
        for row in rows
    ]
