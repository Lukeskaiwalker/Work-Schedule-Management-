"""The cabinet as a list of boxes (docs/PANEL_ENCLOSURE.md §4).

Twin of ``apps/web/src/utils/enclosureGeometry.ts``: the same ``(document,
catalogue, view)`` gives the same box list on both sides, pinned on
``apps/web/src/test/fixtures/enclosureFixtures.json``. Renderers (the SVG,
three.js, the Aufbau PDF) only draw boxes; none of them computes a position,
so the screen and the paper can only disagree if the two twins do.

Conventions both twins keep:

* millimetres; origin at the top-left corner of the cabinet's **back** face,
  ``x`` right, ``y`` down, ``z`` toward the viewer (front face at ``z = depth``);
* positions are computed unrounded and ``round1`` (half up, never Python's
  half-to-even) is applied to every number on the way out;
* output sorted by ``(z, y, x, id)`` on the rounded numbers, ids by code
  point; ``flags`` sorted;
* keys are the TypeScript ``SceneBox`` names (``moduleId``, ``railKey`` …),
  so the fixture compares without translation.

Where the contract's table leaves a detail open, this module decides, and the
fixture carries the decision to the twin: a rail without a row is labelled
with the name its row would get (``F1 · AAR 1``); a device front repeats its
device's flags; a blind plate carries ``free``; a door leaf whose centre is
exactly the cabinet centre (three leaves) counts as right of centre; labels
of the shell, doors, handles, covers and windows are "".

WAGO terminals (docs/PANEL_ENCLOSURE_R2.md §8) come from the placement
(``panel_enclosure_terminals.place_terminals``; pass it in when it is at
hand): a terminal rail carries the flag ``terminals`` in both views, and in
the open view every placed strip is one ``terminal_strip`` box on its rail.
A hand-placed "Reihenklemme N/PE" on a terminal rail is a placeholder the
strips replace (R2 §3.6), so it is not drawn there.

The display sizes below are drawing approximations, not catalogue facts:
a device is drawn 90 × 70 mm, an eHZ 110 × 210 mm, a 3-Punkt meter
180 × 330 mm, an SLS on a busbar 78.75 mm wide (``panel_enclosure_layout``),
a terminal strip 96 mm high and 42.3 mm deep (the 2003-7641 body), and every
``z`` is a layer, not a measurement.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Iterator, Literal, Mapping

from app.services.panel_enclosure_catalog import EnclosureCatalog
from app.services.panel_enclosure_layout import (
    PLE_MM,
    as_int,
    default_rail_label,
    dicts,
    enclosure_device_width_mm,
    enclosure_of,
    ident,
    linked_rows,
    meter_zones,
    module_rails,
    module_spec,
    modules_of,
    occupied_meters,
    row_devices,
    rows_of,
    supplied_device_ids,
    text,
    zone_label,
)
from app.services.panel_enclosure_terminals import PLACEHOLDER_KINDS, place_terminals
from app.services.schaltplan_layout import DEVICE_CATALOG

View = Literal["open", "closed"]
Box = dict[str, Any]

# Drawing approximations (see the module docstring).
_DEVICE_H, _DEVICE_D, _DEVICE_Z = 90.0, 70.0, 47.5
_EHZ = (110.0, 210.0)
_THREE_POINT = (180.0, 330.0)
_RAIL_H, _RAIL_Z, _RAIL_D = 35.0, 40.0, 7.5
_BUSBAR_H, _BUSBAR_Z, _BUSBAR_D = 60.0, 30.0, 12.0
_OVERFLOW_TOLERANCE_MM = 0.05
_COVER_INSET_MM = 2.0
_SLOT_H, _FRONT_H = 46.0, 45.0
_HANDLE_W, _HANDLE_H, _HANDLE_D = 15.0, 120.0, 20.0
# A placed WAGO strip: the 2003-7641 body, 96 × 42.3 mm (a drawing approximation).
_STRIP_H, _STRIP_D, _STRIP_Z = 96.0, 42.3, 47.5

_KEY_ORDER = ("id", "kind", "x", "y", "z", "w", "h", "d", "label",
              "moduleId", "railKey", "rowId", "deviceId", "zoneType", "flags")


def round1(value: float) -> float:
    """``floor(v·10 + 0.5) / 10`` — the same in both languages, unlike ``round``."""
    return math.floor(value * 10 + 0.5) / 10


def mm_text(value: float) -> str:
    """"29,9", "1050": a length as a finding's sentence shows it."""
    rounded = round1(value)
    return str(int(rounded)) if rounded == int(rounded) else f"{rounded:.1f}".replace(".", ",")


def _box(box_id: str, kind: str, x: float, y: float, z: float, w: float, h: float, d: float, *,
         label: str = "", module: str | None = None, rail: str | None = None, row: str | None = None,
         device: str | None = None, zone: str | None = None, flags: tuple[str, ...] | list[str] = ()) -> Box:
    values = {"x": x, "y": y, "z": z, "w": w, "h": h, "d": d}
    out: Box = {"id": box_id, "kind": kind, **{k: round1(v) for k, v in values.items()}, "label": label,
                "moduleId": module, "railKey": rail, "rowId": row, "deviceId": device, "zoneType": zone,
                "flags": sorted(set(flags))}
    return {key: out[key] for key in _KEY_ORDER}


@dataclass(frozen=True)
class _Cabinet:
    width: float
    height: float
    depth: float
    fields: int
    leaves: int
    field_width: float
    unit: float
    margin: float
    units_per_field: int

    @classmethod
    def of(cls, spec: Mapping[str, Any]) -> _Cabinet:
        # Validated specs carry every key; the defaults are the spec model's,
        # for a catalogue built by hand (``EnclosureCatalog.from_out``).
        return cls(
            width=float(as_int(spec.get("width_mm"))), height=float(as_int(spec.get("height_mm"))),
            depth=float(as_int(spec.get("depth_mm"))), fields=as_int(spec.get("fields"), 1),
            leaves=max(1, as_int(spec.get("door_leaves"), 1)), field_width=float(as_int(spec.get("field_width_mm"), 250)),
            unit=float(as_int(spec.get("unit_mm"), 150)), margin=float(as_int(spec.get("margin_mm"), 25)),
            units_per_field=as_int(spec.get("units_per_field"), 1),
        )


@dataclass(frozen=True)
class _Context:
    cabinet: _Cabinet
    catalog: EnclosureCatalog
    closed: bool
    rows: Mapping[str, dict[str, Any]]
    linked: Mapping[str, tuple[str, str]]
    supplied: frozenset[str]
    terminals: Mapping[tuple[str, str], Mapping[str, Any]]  # (module id, rail key) → the placement's rail


def build_enclosure_scene(document: Any, catalog: EnclosureCatalog, *, view: View = "open",
                          placement: Mapping[str, Any] | None = None) -> dict[str, Any] | None:
    """Every box of the cabinet in one view; None without a known cabinet.

    ``placement``: the board's ``place_terminals`` result, when the caller
    already has it; derived here otherwise.
    """
    enclosure = enclosure_of(document)
    code = enclosure.get("code") if enclosure is not None else None
    spec = catalog.enclosure(code) if isinstance(code, str) else None
    if spec is None:
        return None
    cabinet = _Cabinet.of(spec)
    placement = place_terminals(document, catalog) if placement is None else placement
    context = _Context(
        cabinet=cabinet, catalog=catalog, closed=view == "closed",
        rows={row["id"]: row for row in rows_of(document)},
        linked=linked_rows(document, catalog),
        supplied=frozenset(supplied_device_ids(document, catalog)),
        terminals={(rail["moduleId"], rail["railKey"]): rail
                   for field in placement.get("fields") or [] for rail in field["rails"]},
    )
    boxes = [*_cabinet_boxes(cabinet)]
    for module in modules_of(document):
        boxes.extend(_module_boxes(context, module))
    boxes.extend(_door_boxes(cabinet))
    boxes.sort(key=lambda box: (box["z"], box["y"], box["x"], box["id"]))
    return {
        "width": round1(cabinet.width), "height": round1(cabinet.height), "depth": round1(cabinet.depth),
        "view": "closed" if context.closed else "open", "boxes": boxes,
    }


def _cabinet_boxes(cab: _Cabinet) -> Iterator[Box]:
    yield _box("shell", "shell", 0, 0, 0, cab.width, cab.height, cab.depth)
    for index in range(cab.fields):
        yield _box(f"field:{index}", "field", cab.margin + index * cab.field_width, cab.margin, 10,
                   cab.field_width, cab.units_per_field * cab.unit, 2, label=f"Feld {index + 1}")


def _door_boxes(cab: _Cabinet) -> Iterator[Box]:
    leaf = cab.width / cab.leaves
    for index in range(cab.leaves):
        yield _box(f"door:{index}", "door", index * leaf, 0, cab.depth, leaf, cab.height, 2)
    for index in range(cab.leaves):
        if cab.leaves == 1:
            x = cab.width - 30
        elif index * leaf + leaf / 2 < cab.width / 2:
            x = (index + 1) * leaf - 30  # left of centre: handle on its right edge
        else:
            x = index * leaf + 15
        yield _box(f"handle:{index}", "handle", x, cab.height / 2 - 60, cab.depth + 2, _HANDLE_W, _HANDLE_H, _HANDLE_D)


def _module_boxes(ctx: _Context, module: dict[str, Any]) -> Iterator[Box]:
    cab = ctx.cabinet
    module_id = ident(module.get("id"))
    x = cab.margin + as_int(module.get("field")) * cab.field_width
    y = cab.margin + as_int(module.get("unit")) * cab.unit
    spec = module_spec(module, ctx.catalog)
    if spec is None:
        yield _box(f"module:{module_id}", "module", x, y, 12, cab.field_width, cab.unit, 3,
                   label=text(module.get("code")), module=module_id, flags=["unknown_code"])
        return
    yield _box(f"module:{module_id}", "module", x, y, 12, as_int(spec.get("width_fields"), 1) * cab.field_width,
               as_int(spec.get("height_units"), 1) * cab.unit, 3, label=str(spec.get("article_no") or ""),
               module=module_id, flags=[] if spec.get("verified") else ["unverified"])
    first_place = {id(zone): first for zone, first in meter_zones(spec)}
    for zone in dicts(spec.get("zones")):
        zone_x = x + as_int(zone.get("field")) * cab.field_width
        zone_y = y + as_int(zone.get("unit")) * cab.unit
        yield from _zone_boxes(ctx, module, zone, zone_x, zone_y)
        if id(zone) in first_place:
            yield from _meter_boxes(ctx, module, zone, first_place[id(zone)], zone_x, zone_y)


def _zone_boxes(ctx: _Context, module: dict[str, Any], zone: dict[str, Any], zone_x: float, zone_y: float) -> Iterator[Box]:
    cab = ctx.cabinet
    module_id = ident(module.get("id"))
    key, kind = str(zone.get("key")), str(zone.get("type"))
    height = as_int(zone.get("units"), 1) * cab.unit
    yield _box(f"zone:{module_id}:{key}", "zone", zone_x, zone_y, 15, cab.field_width, height, 1,
               label=zone_label(zone), module=module_id, zone=kind)
    if ctx.closed:
        inset = _COVER_INSET_MM
        yield _box(f"cover:{module_id}:{key}", "cover", zone_x + inset, zone_y + inset, 120,
                   cab.field_width - 2 * inset, height - 2 * inset, 2, module=module_id, zone=kind,
                   flags=["sealable"] if zone.get("sealable") else [])
    for position, rail in enumerate(dicts(zone.get("rails")), start=1):
        yield from _rail_boxes(ctx, module, zone, rail, position, zone_x, zone_y)


def _rail_boxes(ctx: _Context, module: dict[str, Any], zone: dict[str, Any], rail: dict[str, Any],
                position: int, zone_x: float, zone_y: float) -> Iterator[Box]:
    cab = ctx.cabinet
    module_id = ident(module.get("id"))
    key, kind = str(rail.get("key")), str(zone.get("type"))
    row_id = module_rails(module).get(key)
    if row_id is not None and ctx.linked.get(row_id) != (module_id, key):
        row_id = None  # a dangling name: the rail is drawn empty
    row = ctx.rows.get(row_id) if row_id is not None else None
    terminal_rail = ctx.terminals.get((module_id, key))
    devices = row_devices(row)
    if terminal_rail is not None:  # the strips replace the hand-placed placeholders (R2 §3.6)
        devices = [device for device in devices if str(device.get("kind") or "") not in PLACEHOLDER_KINDS]
    retired = bool(rail.get("retired"))
    if retired and not devices:
        return  # a retired rail stays only while its row still holds devices
    rail_w = as_int(rail.get("ple"), 1) * PLE_MM
    centre = zone_y + as_int(rail.get("unit")) * cab.unit + cab.unit / 2
    rail_x = zone_x + (cab.field_width - rail_w) / 2
    label = text(row.get("label")) if row is not None else ""
    common = {"module": module_id, "rail": key, "row": row_id, "zone": kind}
    rail_flags = [*(["retired"] if retired else []), *(["terminals"] if terminal_rail is not None else [])]
    if rail.get("mount") == "busbar":
        yield _box(f"rail:{module_id}:{key}", "busbar", rail_x, centre - _BUSBAR_H / 2, _BUSBAR_Z, rail_w, _BUSBAR_H,
                   _BUSBAR_D, label=label or default_rail_label(module, zone, position), flags=rail_flags, **common)
    else:
        yield _box(f"rail:{module_id}:{key}", "rail", rail_x, centre - _RAIL_H / 2, _RAIL_Z, rail_w, _RAIL_H, _RAIL_D,
                   label=label or default_rail_label(module, zone, position), flags=rail_flags, **common)
    if ctx.closed:
        yield _box(f"slot:{module_id}:{key}", "cover_slot", rail_x, centre - _SLOT_H / 2, 122, rail_w, _SLOT_H, 0.5,
                   **common)
    cursor = rail_x
    for device in devices:
        width = enclosure_device_width_mm(device, rail)
        device_id = ident(device.get("id"))
        flags = ["overflow"] if cursor + width > rail_x + rail_w + _OVERFLOW_TOLERANCE_MM else []
        if device_id and device_id in ctx.supplied:
            flags.append("supplied")
        name = _device_label(device)
        if ctx.closed:
            yield _box(f"front:{device_id}", "device_front", cursor, centre - _FRONT_H / 2, 123, width, _FRONT_H, 0.5,
                       label=name, device=device_id, flags=flags, **common)
        else:
            yield _box(f"device:{device_id}", "device", cursor, centre - _DEVICE_H / 2, _DEVICE_Z, width, _DEVICE_H,
                       _DEVICE_D, label=name, device=device_id, flags=flags, **common)
        cursor += width
    if terminal_rail is not None and not ctx.closed:  # behind the cover in the closed view
        for strip in terminal_rail["strips"]:
            yield _box(f"terminal:{strip['stripId']}", "terminal_strip", rail_x + strip["offsetMm"], centre - _STRIP_H / 2,
                       _STRIP_Z, strip["extentMm"], _STRIP_H, _STRIP_D, label=strip["xLabel"], **common)


def _device_label(device: Mapping[str, Any]) -> str:
    """The BMK, else the catalogue's short name."""
    entry = DEVICE_CATALOG.get(str(device.get("kind") or ""))
    return text(device.get("designation")) or (str(entry["short"]) if entry is not None else "")


def _meter_boxes(ctx: _Context, module: dict[str, Any], zone: dict[str, Any], first: int,
                 zone_x: float, zone_y: float) -> Iterator[Box]:
    cab = ctx.cabinet
    module_id = ident(module.get("id"))
    places = as_int(zone.get("meter_places"))
    zone_h = as_int(zone.get("units"), 1) * cab.unit
    stacked = zone.get("meter_type") == "3punkt"  # Doppelstock: top → bottom; eHZ side by side
    width, height = _THREE_POINT if stacked else _EHZ
    occupied = occupied_meters(module)
    for index in range(places):
        if stacked:
            cell = zone_h / places
            x, y = zone_x + (cab.field_width - width) / 2, zone_y + index * cell + (cell - height) / 2
        else:
            cell = cab.field_width / places
            x, y = zone_x + index * cell + (cell - width) / 2, zone_y + (zone_h - height) / 2
        place = first + index
        entry = occupied.get(place)
        number = text(entry.get("number")) if entry is not None else ""
        common = {"module": module_id, "zone": "ZF"}
        if not ctx.closed:
            if entry is not None:
                yield _box(f"meter:{module_id}:{place}", "meter", x, y, 40, width, height, 80,
                           label=number or "Zähler", **common)
            else:
                yield _box(f"meter:{module_id}:{place}", "meter_place", x, y, 15, width, height, 1,
                           label="frei", flags=["free"], **common)
            continue
        yield _box(f"window:{module_id}:{place}", "window", x, y, 122, width, height, 0.5, **common)
        if entry is not None:
            yield _box(f"mfront:{module_id}:{place}", "meter_front", x, y, 123, width, height, 0.5, label=number, **common)
        else:
            yield _box(f"blind:{module_id}:{place}", "blind_plate", x, y, 123, width, height, 0.5,
                       label="Blindabdeckung", flags=["free"], **common)
