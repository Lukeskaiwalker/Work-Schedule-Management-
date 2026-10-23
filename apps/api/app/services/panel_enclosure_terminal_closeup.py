"""The close-up ("Nahansicht") of each field's two terminal rails (R2 §7.1).

Twin of ``apps/web/src/utils/enclosureTerminalCloseup.ts``; pinned on
``enclosureFixtures.json`` (``terminal_closeup``). The Schrank tab's
``TerminalCloseupSheet`` and the Aufbau PDF's terminal pages draw this one
layout; they only fit texts into it (``label_fit``), they never place.

Per field with terminal rails (ascending), per rail (top → bottom):

* ``devices``: what still sits on a reserved rail (back-compat, R12), left
  first, drawn grey; placeholders ("Reihenklemme N/PE") are left out — the
  strips replace them (§3.6);
* ``items``: every part of every placed strip at its offset on the rail
  (devices included), and the rail's end plate right after the last terminal
  block, before a trailing 2009-305 (which then moves right by the plate);
  the plate's open side is drawn on the right, which is UNVERIFIED (the
  legend says so, as it says that markers are drawn above the terminal while
  WAGO marks the middle/side).

``levels`` are the conductors on a terminal, top → bottom: a 2003-7641 of a
1-pole outgoing carries N, its phase (``device.phase`` when L1/L2/L3, else
"L") and PE (verified, 2003-7641 datasheet "NT/L/PE"); of a 3-pole outgoing
N, L1, PE, with L2, L3 on its 2003-7642 (that order is UNVERIFIED); the
2016-7714 feed N; a Block cell its pole; the end clamp and the plates none.
``forText`` is the Klemmen tab's "für" column
(``schaltplan_terminals.terminal_for_text``).

Numbers are rounded with ``round1`` on the way out; offsets run left → right
from the placement's (rounded) strip offsets, in a plain loop.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

from app.services.panel_enclosure_catalog import EnclosureCatalog
from app.services.panel_enclosure_layout import (
    enclosure_device_width_mm,
    enclosure_of,
    ident,
    row_devices,
    rows_of,
    text,
)
from app.services.panel_enclosure_terminals import (
    PLACEHOLDER_KINDS,
    BoardTerminals,
    board_terminals,
    place_terminals,
    round1,
)
from app.services.schaltplan_layout import DEVICE_CATALOG
from app.services.schaltplan_terminal_rules import (
    END_PART_IDS,
    END_PLATE_PART_IDS,
    TERMINAL_PARTS,
    device_poles,
    poles_as_derived,
)
from app.services.schaltplan_terminals import terminal_for_text

KIND_TERMINAL, KIND_END_CLAMP, KIND_END_PLATE = "terminal", "end_clamp", "end_plate"
_PHASES = frozenset({"L1", "L2", "L3"})
#: Terminal rails are DIN rails (R2 §3.2): a device's width as on any rail.
_DIN_RAIL: Mapping[str, Any] = {"mount": "rail"}


def _device_label(device: Mapping[str, Any]) -> str:
    """The BMK, else the catalogue's short name (as the cabinet drawing labels it)."""
    entry = DEVICE_CATALOG.get(str(device.get("kind") or ""))
    return text(device.get("designation")) or (str(entry["short"]) if entry is not None else "")


def _levels(terminal: Mapping[str, Any], device: Mapping[str, Any] | None) -> list[str]:
    part_id = str(terminal["part_id"])
    if part_id in END_PART_IDS:
        return []
    if part_id == "2016-7714":
        return ["N"]
    if part_id == "2003-7642":
        return ["L2", "L3"]
    if part_id == "2003-7641":
        if device is not None and poles_as_derived(device_poles(dict(device))) == 3:
            return ["N", "L1", "PE"]
        phase = text(device.get("phase")) if device is not None else ""
        return ["N", phase if phase in _PHASES else "L", "PE"]
    pole = terminal.get("pole")
    return [str(pole)] if pole else []


def _plate_item(part_id: str, offset: float) -> dict[str, Any]:
    part = TERMINAL_PARTS[part_id]
    return {"kind": KIND_END_PLATE, "partId": part_id, "partNo": part.part_no, "stripId": None, "xLabel": "",
            "offsetMm": round1(offset), "widthMm": round1(part.width_mm), "marker": "", "levels": [], "forText": "",
            "cable": "", "deviceId": None}


def _terminal_item(terminal: Mapping[str, Any], strip: Mapping[str, Any], offset: float,
                   devices: Mapping[str, Mapping[str, Any]], head: Mapping[str, Any] | None) -> dict[str, Any]:
    part_id = str(terminal["part_id"])
    device_id = terminal.get("device_id") or None
    device = devices.get(str(device_id)) if device_id else None
    return {
        "kind": KIND_END_CLAMP if part_id in END_PART_IDS else KIND_TERMINAL,
        "partId": part_id, "partNo": str(terminal["part_no"]), "stripId": str(strip["strip_id"]),
        "xLabel": str(strip["x_label"]), "offsetMm": round1(offset), "widthMm": round1(float(terminal["width_mm"])),
        "marker": str(terminal.get("label") or ""), "levels": _levels(terminal, device),
        "forText": terminal_for_text(terminal, devices, head),
        "cable": text(device.get("cable")) if device is not None else "", "deviceId": device_id,
    }


def _rail_items(rail: Mapping[str, Any], strips: Mapping[str, tuple[Mapping[str, Any], Mapping[str, Any]]],
                devices: Mapping[str, Mapping[str, Any]]) -> list[dict[str, Any]]:
    plates = [part["partId"] for part in rail["parts"] if part["partId"] in END_PLATE_PART_IDS]
    plate = plates[0] if plates else None
    items: list[dict[str, Any]] = []
    placed = [entry for entry in rail["strips"] if entry["stripId"] in strips]
    cursor = 0.0
    for index, entry in enumerate(placed):
        group, strip = strips[entry["stripId"]]
        last = index == len(placed) - 1
        cursor = float(entry["offsetMm"])
        for terminal in strip["terminals"]:
            if last and plate is not None and str(terminal["part_id"]) in END_PART_IDS:
                items.append(_plate_item(plate, cursor))
                cursor += TERMINAL_PARTS[plate].width_mm
                plate = None
            items.append(_terminal_item(terminal, strip, cursor, devices, group.get("head_device")))
            cursor += float(terminal["width_mm"])
    if plate is not None and placed:
        items.append(_plate_item(plate, cursor))
    return items


def _rail_devices(row: Mapping[str, Any] | None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    cursor = 0.0
    for device in row_devices(row):
        if str(device.get("kind") or "") in PLACEHOLDER_KINDS:
            continue
        width = enclosure_device_width_mm(device, _DIN_RAIL)
        out.append({"deviceId": ident(device.get("id")), "label": _device_label(device), "offsetMm": round1(cursor),
                    "widthMm": round1(width)})
        cursor += width
    return out


def _field_closeup(field: Mapping[str, Any], strips: Mapping[str, tuple[Mapping[str, Any], Mapping[str, Any]]],
                   rows: Mapping[str, Mapping[str, Any]], devices: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    rails = [{
        "moduleId": rail["moduleId"], "railKey": rail["railKey"], "title": rail["title"], "position": rail["position"],
        "capacityMm": rail["capacityMm"], "usedMm": rail["usedMm"], "insulated": rail["insulated"],
        "devices": _rail_devices(rows.get(rail["rowId"]) if rail.get("rowId") else None),
        "items": _rail_items(rail, strips, devices),
    } for rail in field["rails"]]
    unplaced = [{"stripId": entry["stripId"], "xLabel": entry["xLabel"],
                 "title": str(strips[entry["stripId"]][1]["title"]) if entry["stripId"] in strips else entry["xLabel"],
                 "widthMm": entry["widthMm"]} for entry in field["unplaced"]]
    return {"field": field["field"], "order": field["order"], "rails": rails, "unplaced": unplaced}


def terminal_closeup(document: Any, catalog: EnclosureCatalog, terms: BoardTerminals | None = None,
                     placement: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
    """The close-up of every field with terminal rails, ascending; [] without a cabinet."""
    if enclosure_of(document) is None:
        return []
    terms = board_terminals(document, catalog) if terms is None else terms
    placement = place_terminals(document, catalog, terms) if placement is None else placement
    strips = {strip["strip_id"]: (group, strip) for group in terms.groups for strip in group["strips"]}
    rows = {row["id"]: row for row in rows_of(document)}
    devices: dict[str, Mapping[str, Any]] = {}
    for row in rows.values():
        for device in row_devices(row):
            devices.setdefault(ident(device.get("id")), device)
    fields: Sequence[Mapping[str, Any]] = placement.get("fields") or []
    return [_field_closeup(field, strips, rows, devices) for field in fields]
