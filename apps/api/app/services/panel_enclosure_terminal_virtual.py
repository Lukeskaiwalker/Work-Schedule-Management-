"""Virtual document transforms for the terminal suggestions (R2 §4.2).

Twin of ``apps/web/src/utils/enclosureTerminalVirtual.ts``. The suggestion
pass asks "what would the placement be if …?" — after the reserved rows were
re-linked to empty rails (``virtual_relink``), or after a group was moved into
another field (``virtual_move``) — and answers it by re-placing a transformed
document. These transforms exist only for that question: nothing is
relabelled, and the result is never stored. The real ops (``relinkRows``,
``moveGroupToRails`` in ``enclosureOpsTerminals.ts``) finish with the C§2.4
tail; TS tests assert that they give the same placement.

Both transforms end like that tail: rows in the C§2.3 physical reading order
(``physical_row_order``), so a row that moved, or a row created on an empty
target rail, sits where the cabinet puts it; then the tail's feed rule
(``preserveFeeds``): a circuit whose feed the reordering changed, and whose
old head is still a head, is pinned to that head. Without the pins a run
that continues past a moved row (a group spilling over a field line, or from
a reserved r2 onto r3) would join another group here but not on the real
board, and the pass would refuse moves the button makes work.

``fill_rails`` is the one filling rule of a move, shared with the suggestion
that picks the targets: each device onto the current rail until it is full
(its PLE length, 0.05 mm tolerance), then the next rail, never reordered.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from app.services.panel_enclosure_catalog import EnclosureCatalog
from app.services.panel_enclosure_layout import (
    PLE_MM,
    as_int,
    default_rail_label,
    enclosure_device_width_mm,
    ident,
    linked_rows,
    module_spec,
    modules_of,
    physical_row_order,
    row_devices,
    rows_of,
    spec_rails,
    zone_field,
)
from app.services.panel_enclosure_terminals import STANDARD_RAIL_PLE, TOLERANCE_MM
from app.services.schaltplan_layout import build_topology

VIRTUAL_ROW_PREFIX = "virtual"


@dataclass(frozen=True)
class RailRef:
    """A resolvable rail of the cabinet and the row linked to it, if any."""

    field: int
    sort: tuple[int, str, str]  # (module unit + zone unit + rail unit, module id, rail key): top → bottom
    module: Mapping[str, Any]
    zone: Mapping[str, Any]
    rail: Mapping[str, Any]
    position: int  # 1-based place of the rail in its zone
    row: Mapping[str, Any] | None

    @property
    def module_id(self) -> str:
        return ident(self.module.get("id"))

    @property
    def key(self) -> str:
        return str(self.rail.get("key"))

    @property
    def title(self) -> str:
        return default_rail_label(self.module, self.zone, self.position)

    @property
    def capacity_mm(self) -> float:
        return as_int(self.rail.get("ple"), STANDARD_RAIL_PLE) * PLE_MM

    def target(self) -> dict[str, Any]:
        """The suggestion's ``RailTarget``."""
        return {"moduleId": self.module_id, "railKey": self.key, "title": self.title, "field": self.field}


def _rail_refs(document: Any, catalog: EnclosureCatalog) -> list[RailRef]:
    rows = {row["id"]: row for row in rows_of(document)}
    by_rail = {rail: row_id for row_id, rail in linked_rows(document, catalog).items()}
    refs: list[RailRef] = []
    seen: set[str] = set()
    for module in modules_of(document):
        module_id = ident(module.get("id"))
        spec = module_spec(module, catalog)
        if spec is None or module_id in seen:
            continue
        seen.add(module_id)
        for zone, rail, position in spec_rails(spec):
            key = str(rail.get("key"))
            row_id = by_rail.get((module_id, key))
            refs.append(RailRef(
                field=zone_field(module, zone),
                sort=(as_int(module.get("unit")) + as_int(zone.get("unit")) + as_int(rail.get("unit")), module_id, key),
                module=module, zone=zone, rail=rail, position=position, row=rows.get(row_id) if row_id else None,
            ))
    return refs


def vt_rails(document: Any, catalog: EnclosureCatalog) -> dict[int, list[RailRef]]:
    """field → its VT rails (retired ones included), top → bottom."""
    out: dict[int, list[RailRef]] = {}
    for ref in _rail_refs(document, catalog):
        if str(ref.zone.get("type")) == "VT":
            out.setdefault(ref.field, []).append(ref)
    return {field: sorted(refs, key=lambda ref: ref.sort) for field, refs in sorted(out.items())}


def rail_ref(document: Any, catalog: EnclosureCatalog, module_id: Any, rail_key: Any) -> RailRef | None:
    """The rail ``rail_key`` of the module ``module_id``; None when it does not resolve."""
    for ref in _rail_refs(document, catalog):
        if ref.module_id == module_id and ref.key == rail_key:
            return ref
    return None


def fill_rails(devices: Sequence[Mapping[str, Any]], rails: Sequence[RailRef]) -> tuple[list[int], bool]:
    """(index of the rail each device goes onto, whether all fit).

    Each device goes onto the current rail until it is full, then the next,
    never reordered; a rail starts with what its row already holds. What
    does not fit any more goes onto the last rail and makes it incomplete.
    """
    if not rails:
        return [], not devices
    index = 0
    used = _row_mm(rails[0])
    out: list[int] = []
    complete = True
    for device in devices:
        while True:
            width = enclosure_device_width_mm(device, rails[index].rail)
            if used + width <= rails[index].capacity_mm + TOLERANCE_MM:
                used += width
                out.append(index)
                break
            if index == len(rails) - 1:
                complete = False
                used += width
                out.append(index)
                break
            index += 1
            used = _row_mm(rails[index])
    return out, complete


def _row_mm(ref: RailRef) -> float:
    total = 0.0
    for device in row_devices(ref.row):
        total += enclosure_device_width_mm(device, ref.rail)
    return total


def _in_physical_order(document: dict[str, Any], catalog: EnclosureCatalog) -> dict[str, Any]:
    rows = {row["id"]: row for row in rows_of(document)}
    return {**document, "rows": [rows[row_id] for row_id in physical_row_order(document, catalog)]}


def _feeds(document: Any) -> tuple[dict[str, str], set[str]]:
    """(circuit id → its head's id, "" = Einspeisung; the heads), read over the
    rows the transforms keep (``rows_of``, their device dicts)."""
    readable = {"rows": [{**row, "devices": row_devices(row)} for row in rows_of(document)]}
    feeds: dict[str, str] = {}
    heads: set[str] = set()
    for group in build_topology(readable)["groups"]:
        head = ident(group["device"].get("id")) if group["device"] is not None else ""
        if group["device"] is not None:
            heads.add(head)
        for child in group["children"]:
            feeds[ident(child.get("id"))] = head
    return feeds, heads


def _with_kept_feeds(before: Any, after: dict[str, Any]) -> dict[str, Any]:
    """``after`` with the real ops' pins (``preserveFeeds``, C§2.4): every
    circuit whose feed changed, and whose old head is still a head, names
    that head as its ``parent_id``. The input itself when nothing is pinned."""
    old, _ = _feeds(before)
    now, heads = _feeds(after)
    pins: dict[str, str] = {}
    for row in rows_of(after):
        for device in row_devices(row):
            device_id = ident(device.get("id"))
            was, feed = old.get(device_id), now.get(device_id)
            if was is not None and feed is not None and was != feed and was and was in heads:
                pins[device_id] = was
    if not pins:
        return after
    rows = [
        {**row, "devices": [{**d, "parent_id": pins[ident(d.get("id"))]} if ident(d.get("id")) in pins else d
                            for d in row_devices(row)]}
        if any(ident(d.get("id")) in pins for d in row_devices(row)) else row
        for row in rows_of(after)
    ]
    return {**after, "rows": rows}


def _with_rails(document: Mapping[str, Any], links: Mapping[str, tuple[str, str]]) -> dict[str, Any]:
    """Every row in ``links`` named under its new (module id, rail key) only.
    A stored rail entry that is no text id is left as it is (the twin's rule)."""
    enclosure = document["enclosure"]
    modules = []
    for module in enclosure.get("modules") or []:
        if not isinstance(module, dict) or not ident(module.get("id")):
            modules.append(module)
            continue
        rails = module.get("rails") if isinstance(module.get("rails"), dict) else {}
        kept = {key: row_id for key, row_id in rails.items() if not (isinstance(row_id, str) and row_id in links)}
        added = {key: row_id for row_id, (module_id, key) in links.items() if module_id == module["id"]}
        modules.append({**module, "rails": {**kept, **added}})
    return {**document, "enclosure": {**enclosure, "modules": modules}}


def virtual_relink(document: Any, catalog: EnclosureCatalog, moves: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """The board with each move's row named under its target rail instead,
    in physical order and pinned like the real op (``_with_kept_feeds``).

    ``moves``: ``[{"rowId", "target": {"moduleId", "railKey", …}}]``. A move
    whose row or rail does not resolve is ignored; with none left, the
    document comes back as it is.
    """
    rows = {row["id"] for row in rows_of(document)}
    links: dict[str, tuple[str, str]] = {}
    for move in moves:
        target = move.get("target") if isinstance(move, Mapping) else None
        if not isinstance(target, Mapping) or move.get("rowId") not in rows:
            continue
        ref = rail_ref(document, catalog, target.get("moduleId"), target.get("railKey"))
        if ref is not None:
            links[str(move["rowId"])] = (ref.module_id, ref.key)
    if not links:
        return document
    return _with_kept_feeds(document, _in_physical_order(_with_rails(document, links), catalog))


def virtual_move(document: Any, catalog: EnclosureCatalog, device_ids: Sequence[str],
                 targets: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """The board with ``device_ids`` taken out of their rows and filled, in
    order, onto ``targets`` (``[{"moduleId", "railKey", …}]``, top → bottom).

    A target rail without a row gets one (``virtual:{module}:{rail}``,
    labelled like a new row), placed by the physical order; circuits are
    pinned like the real op pins them (``_with_kept_feeds``). Unknown ids and
    targets are ignored; with nothing left, the document comes back as it is.
    """
    refs: list[RailRef] = []
    for target in targets:
        if not isinstance(target, Mapping):
            continue
        ref = rail_ref(document, catalog, target.get("moduleId"), target.get("railKey"))
        if ref is not None and all((ref.module_id, ref.key) != (other.module_id, other.key) for other in refs):
            refs.append(ref)
    by_id: dict[str, dict[str, Any]] = {}
    for row in rows_of(document):
        for device in row_devices(row):
            by_id.setdefault(ident(device.get("id")), device)
    wanted = [by_id[device_id] for device_id in dict.fromkeys(device_ids) if device_id and device_id in by_id]
    if not wanted or not refs:
        return document
    leaving = {ident(device.get("id")) for device in wanted}
    rows = [
        {**row, "devices": [d for d in row_devices(row) if ident(d.get("id")) not in leaving]}
        if any(ident(d.get("id")) in leaving for d in row_devices(row)) else row
        for row in rows_of(document)
    ]
    assignment, _ = fill_rails(wanted, refs)
    links: dict[str, tuple[str, str]] = {}
    taken_ids = {row["id"] for row in rows}
    for index, ref in enumerate(refs):
        moved = [device for device, at in zip(wanted, assignment) if at == index]
        if not moved:
            continue
        if ref.row is not None:
            rows = [{**row, "devices": [*row_devices(row), *moved]} if row["id"] == ref.row["id"] else row for row in rows]
            continue
        row_id = f"{VIRTUAL_ROW_PREFIX}:{ref.module_id}:{ref.key}"
        while row_id in taken_ids:
            row_id += "'"
        taken_ids.add(row_id)
        rows.append({"id": row_id, "label": ref.title, "slots": as_int(ref.rail.get("ple"), STANDARD_RAIL_PLE),
                     "devices": moved})
        links[row_id] = (ref.module_id, ref.key)
    moved_doc = {**document, "rows": rows}
    if links:
        moved_doc = _with_rails(moved_doc, links)
    return _with_kept_feeds(document, _in_physical_order(moved_doc, catalog))
