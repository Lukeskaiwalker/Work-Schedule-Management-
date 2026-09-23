"""Reihenklemmen — derive the WAGO terminal strips of every FI group, with
their X numbers.

Twin of ``apps/web/src/utils/schaltplanTerminals.ts``. The editor derives
the strips locally for its "Klemmen" tab, the Stückliste, the legend and the
print preview; this module derives them again for the print job and the
PDF. Both sides are pinned on the same fixtures
(``tests/test_schaltplan_terminals.py`` ↔ ``test/schaltplanTerminals.test.ts``),
which is what keeps a preview from promising a strip the printer will not
produce.

The rule (owner's numbering, 2026-09-23), per protection group G from
``build_topology`` in group order, children in physical order, with E = the
children that are eligible and flagged ``terminal_block``:

  1. E empty → G emits nothing.
  2. Every strip on the board gets the next X number, in board order. A
     group emits its **Leiste** first (when it has small outgoings), then one
     **Block** per big outgoing.
  3. The Leiste of an FI group: [2016-7714, marker "X<n>"] + per small
     outgoing its Etagenklemmen (2003-7641 for one phase; 2003-7641 +
     2003-7642 for three), each marker "<n>.<k>" with k counting through the
     whole Leiste + [2009-305, no marker]. Under a group without an FI
     (``no_rcd``) the Leiste has no feed terminal — there is no FI whose N
     bus it could open — and ``validate_document`` says so.
  4. A big outgoing (three phases above 16 A, ``is_block_device``) gets the
     16 mm² Block: [2016-7604 "N", 2016-7601 × 3 "L1" "L2" "L3", 2016-7607
     "PE"]. Its label is the owner's PV-block blueprint: the name (the
     device's description unless overridden), "X<n>", one cell per terminal.

Decisions, spelled out because the owner's words allowed two readings:
  (a) "at the end of the row" means per protection group, not per physical
      rail — every FI owns its own N bus, so its end clamp closes *that*
      group even when its breakers continue on the next rail and even when
      two FIs share a rail;
  (b) a 2-pole breaker is treated as 1-pole, a 4-pole small outgoing as
      3-pole (the Etagenklemmen come in exactly those two shapes) — reported
      as an info finding; a 4-pole Block puts its N on the feed terminal;
  (c) an RCBO never opens a terminal group and never gets one;
  (d) every marker text can be overridden in ``document["terminal_labels"]``
      (key → text, see ``override_key``); a blank override prints nothing for
      that terminal, like an unnamed device on the BMK strip.
"""

from __future__ import annotations

from typing import Any

from app.services.schaltplan_layout import BMK_EDGE_JUNK, DEVICE_CATALOG, build_topology, font_size_for_fits
from app.services.schaltplan_terminal_rules import (
    OUTGOING_PART_IDS,
    TERMINAL_PART_ORDER,
    TERMINAL_PARTS,
    VARIANT_NO_RCD,
    TerminalPart,
    is_block_device,
    outgoing_parts_for_poles,
    terminal_children,
    terminal_variant,
)

# Pad between a terminal's cut mark and its text, in dots (0.5 mm). The BMK
# strip keeps 1 mm on either side, but a 5.2 mm segment minus 2 mm of pad
# holds nothing: 5.2 × 12 − 12 = 50 dots leave "1.1" at 31 dots — the
# three characters the owner says are all a 5.2 mm marker can carry.
TERMINAL_SEG_PAD_DOTS = 6

STRIP_KIND_LEISTE = "leiste"
STRIP_KIND_BLOCK = "block"

SUPPLY_GROUP_ID = "supply"
OVERRIDES_KEY = "terminal_labels"

_BLOCK_POLES: tuple[str, ...] = ("L1", "L2", "L3")


def _clean(value: Any) -> str:
    return BMK_EDGE_JUNK.sub("", str(value or ""))


def _text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def override_key(device_id: str | None, slot: str) -> str:
    """The key of one editable text in ``document["terminal_labels"]``:
    ``"<device id>:<slot>"`` — slot ``feed`` for the FI's feed terminal,
    ``1``/``2`` for an outgoing's Etagenklemmen, ``N``/``L1``…/``PE`` for a
    Block's cells, ``name`` and ``x`` for the Block's two text rows."""
    return f"{device_id or ''}:{slot}"


def label_overrides(document: dict[str, Any]) -> dict[str, str]:
    raw = document.get(OVERRIDES_KEY)
    if not isinstance(raw, dict):
        return {}
    return {str(key): str(value) for key, value in raw.items() if value is not None}


def _entry(
    position: int,
    part_id: str,
    device_id: str | None,
    pole: str | None,
    slot: str | None,
    default_label: str,
    overrides: dict[str, str],
) -> dict[str, Any]:
    part = TERMINAL_PARTS[part_id]
    key = override_key(device_id, slot) if (part.marker and slot is not None) else ""
    default = _clean(default_label) if part.marker else ""
    label = _clean(overrides[key]) if key and key in overrides else default
    return {
        "position": position,
        "part_id": part_id,
        "part_no": part.part_no,
        "device_id": device_id,
        "pole": pole,
        "slot": slot if part.marker else None,
        "key": key,
        "default_label": default,
        "label": label,
        "width_mm": part.width_mm,
        "marker": part.marker,
    }


def _leiste(
    strip_no: int, variant: str, head: dict[str, Any] | None, children: list[dict[str, Any]], overrides: dict[str, str]
) -> list[dict[str, Any]]:
    terminals: list[dict[str, Any]] = []
    position = 1
    if variant != VARIANT_NO_RCD and head is not None:
        head_id = str(head.get("id") or "") or None
        terminals.append(_entry(position, "2016-7714", head_id, None, "feed", f"X{strip_no}", overrides))
        position += 1
    k = 1
    for device in children:
        device_id = str(device.get("id") or "") or None
        for index, part_id in enumerate(outgoing_parts_for_poles(_poles(device)), start=1):
            terminals.append(_entry(position, part_id, device_id, None, str(index), f"{strip_no}.{k}", overrides))
            position += 1
            k += 1
    if variant != VARIANT_NO_RCD and head is not None:
        terminals.append(_entry(position, "2009-305", None, None, None, "", overrides))
    return terminals


def _block(strip_no: int, device: dict[str, Any], overrides: dict[str, str]) -> list[dict[str, Any]]:
    device_id = str(device.get("id") or "") or None
    terminals = [_entry(1, "2016-7604", device_id, "N", "N", "N", overrides)]
    for index, pole in enumerate(_BLOCK_POLES, start=2):
        terminals.append(_entry(index, "2016-7601", device_id, pole, pole, pole, overrides))
    terminals.append(_entry(len(_BLOCK_POLES) + 2, "2016-7607", device_id, "PE", "PE", "PE", overrides))
    return terminals


def _poles(device: dict[str, Any]) -> int:
    from app.services.schaltplan_terminal_rules import device_poles

    return device_poles(device)


def _device_title(device: dict[str, Any]) -> str:
    short = str(DEVICE_CATALOG.get(str(device.get("kind") or ""), {}).get("short", "?"))
    designation = _text(device.get("designation")) or short
    label = _text(device.get("label"))
    return f"{designation} {label}".strip()


def _group_name(head: dict[str, Any] | None, rail_label: str) -> str:
    """"FI F1 · Reihe 1" — the group as the strip list and the PDF name it."""
    if head is None:
        return "Einspeisung"
    short = str(DEVICE_CATALOG.get(str(head.get("kind") or ""), {}).get("short", "?"))
    name = f"{short} {_text(head.get('designation')) or '?'}"
    return f"{name} · {rail_label}" if rail_label else name


def _block_name(device: dict[str, Any], overrides: dict[str, str]) -> str:
    key = override_key(str(device.get("id") or "") or None, "name")
    if key in overrides:
        return _clean(overrides[key])
    return _clean(device.get("label")) or _clean(device.get("designation"))


def _block_x(strip_no: int, device: dict[str, Any], overrides: dict[str, str]) -> str:
    key = override_key(str(device.get("id") or "") or None, "x")
    return _clean(overrides[key]) if key in overrides else f"X{strip_no}"


def derive_terminals(document: dict[str, Any]) -> list[dict[str, Any]]:
    """One entry per group that has at least one terminal, in group order.

    Returns::

        [{"group_id": "f1" | "supply",
          "head_device": <device dict> | None,
          "rail_label": "Reihe 1" | "—",
          "variant": "standard" | "no_rcd",
          "strips": [{"strip_id", "strip_no", "kind": "leiste" | "block",
                      "title", "device_id", "name", "x_label", "name_key",
                      "x_key", "terminals": [...]}, ...],
          "terminals": [...]}]        # every terminal of every strip, in order

    A terminal is ``{"position", "part_id", "part_no", "device_id", "pole",
    "slot", "key", "default_label", "label", "width_mm", "marker"}``;
    ``label`` is what its marker says after overrides.
    """
    overrides = label_overrides(document)
    groups: list[dict[str, Any]] = []
    strip_no = 0
    for group in build_topology(document)["groups"]:
        children = terminal_children(group)
        variant = terminal_variant(group, children)
        if variant is None:
            continue
        head = group.get("device")
        head_id = str(head.get("id") or "") if head is not None else SUPPLY_GROUP_ID
        rail_label = str(group.get("row_label") or "") if head is not None else "—"
        group_name = _group_name(head, rail_label)
        small = [device for device in children if not is_block_device(device)]
        big = [device for device in children if is_block_device(device)]
        strips: list[dict[str, Any]] = []
        if small:
            strip_no += 1
            strips.append(
                {
                    "strip_id": f"{head_id}:leiste",
                    "strip_no": strip_no,
                    "kind": STRIP_KIND_LEISTE,
                    "title": f"X{strip_no} · {group_name}",
                    "device_id": None,
                    "name": "",
                    "x_label": f"X{strip_no}",
                    "name_key": "",
                    "x_key": "",
                    "terminals": _leiste(strip_no, variant, head, small, overrides),
                }
            )
        for device in big:
            strip_no += 1
            device_id = str(device.get("id") or "") or None
            strips.append(
                {
                    "strip_id": f"{device_id}:block",
                    "strip_no": strip_no,
                    "kind": STRIP_KIND_BLOCK,
                    "title": f"X{strip_no} · Block {_device_title(device)}",
                    "device_id": device_id,
                    "name": _block_name(device, overrides),
                    "x_label": _block_x(strip_no, device, overrides),
                    "name_key": override_key(device_id, "name"),
                    "x_key": override_key(device_id, "x"),
                    "terminals": _block(strip_no, device, overrides),
                }
            )
        groups.append(
            {
                "group_id": head_id,
                "head_device": head,
                "rail_label": rail_label,
                "variant": variant,
                "strips": strips,
                "terminals": [terminal for strip in strips for terminal in strip["terminals"]],
            }
        )
    return groups


def terminal_group_title(group: dict[str, Any]) -> str:
    """"FI F1 · Reihe 1" — how a group is named on the strip list and the PDF."""
    return _group_name(group.get("head_device"), str(group.get("rail_label") or ""))


def device_terminal_labels(groups: list[dict[str, Any]]) -> dict[str, list[str]]:
    """device id → the X labels of its terminals, for the legend: an outgoing
    on the Leiste lists "X1.1", "X1.2"; a Block lists its "X2" once."""
    labels: dict[str, list[str]] = {}
    for group in groups:
        for strip in group["strips"]:
            if strip["kind"] == STRIP_KIND_BLOCK:
                if strip["device_id"]:
                    labels.setdefault(strip["device_id"], []).append(strip["x_label"])
                continue
            for terminal in strip["terminals"]:
                if terminal["device_id"] and terminal["part_id"] in OUTGOING_PART_IDS and terminal["label"]:
                    labels.setdefault(terminal["device_id"], []).append(f"X{terminal['label']}")
    return labels


def terminal_bom(groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Parts summed over the board, sorted by part number."""
    counts: dict[str, int] = {}
    for group in groups:
        for terminal in group["terminals"]:
            counts[terminal["part_id"]] = counts.get(terminal["part_id"], 0) + 1
    rows: list[dict[str, Any]] = []
    for part_id in TERMINAL_PART_ORDER:
        if part_id not in counts:
            continue
        part = TERMINAL_PARTS[part_id]
        rows.append(
            {
                "part_id": part_id,
                "part_no": part.part_no,
                "name": part.name,
                "count": counts[part_id],
                "width_mm": part.width_mm,
                "verified": part.verified,
            }
        )
    return rows


def terminal_counts(groups: list[dict[str, Any]]) -> dict[str, int]:
    """Terminals, strips, groups and outgoing devices with a terminal — the tab badge's numbers."""
    devices: set[str] = set()
    terminals = 0
    strips = 0
    for group in groups:
        terminals += len(group["terminals"])
        strips += len(group["strips"])
        for terminal in group["terminals"]:
            if terminal["device_id"] and terminal["part_id"] in OUTGOING_PART_IDS:
                devices.add(terminal["device_id"])
    return {"terminals": terminals, "strips": strips, "groups": len(groups), "devices": len(devices)}


def unverified_terminal_parts(groups: list[dict[str, Any]]) -> list[TerminalPart]:
    """Parts in use on this board whose width is not confirmed."""
    in_use = {terminal["part_id"] for group in groups for terminal in group["terminals"]}
    return [TERMINAL_PARTS[part_id] for part_id in TERMINAL_PART_ORDER if part_id in in_use and not TERMINAL_PARTS[part_id].verified]


def terminal_strips(groups: list[dict[str, Any]], strip_ids: list[str] | None = None) -> dict[str, Any]:
    """What goes to the printer for a selection: ``{"strips": [...], "skipped": n}``.

    One item per wanted strip, in board order. A Leiste item carries
    ``segments`` — ``(text, width_mm)`` per marker-carrying terminal whose
    label is not blank; a blank one gets no segment and no width, the strip
    continues with the next, exactly like a blank cover on the BMK strip.
    A Block item carries its ``name``, ``x_label`` and ``cells`` (every
    terminal, blank or not — the block label is one piece the width of the
    block). ``skipped`` counts the marker-carrying Leiste terminals of the
    wanted strips left without a text, the ones of a dropped strip included.

    ``strip_ids`` None = every strip; an explicit empty list = no strip at
    all (an unticked selection prints nothing, it does not print the board).
    """
    wanted = None if strip_ids is None else set(strip_ids)
    items: list[dict[str, Any]] = []
    skipped = 0
    for group in groups:
        for strip in group["strips"]:
            if wanted is not None and strip["strip_id"] not in wanted:
                continue
            if strip["kind"] == STRIP_KIND_BLOCK:
                cells = [(terminal["label"], float(terminal["width_mm"])) for terminal in strip["terminals"]]
                items.append(
                    {
                        "kind": STRIP_KIND_BLOCK,
                        "strip_id": strip["strip_id"],
                        "label": strip["title"],
                        "name": strip["name"],
                        "x_label": strip["x_label"],
                        "cells": cells,
                        "segments": [],
                        "skipped": 0,
                        "part_count": len(strip["terminals"]),
                        "length_mm": sum(width for _, width in cells),
                    }
                )
                continue
            markers = [terminal for terminal in strip["terminals"] if terminal["marker"]]
            segments = [(terminal["label"], float(terminal["width_mm"])) for terminal in markers if terminal["label"]]
            skipped += len(markers) - len(segments)
            if not segments:
                continue
            items.append(
                {
                    "kind": STRIP_KIND_LEISTE,
                    "strip_id": strip["strip_id"],
                    "label": strip["title"],
                    "name": "",
                    "x_label": strip["x_label"],
                    "cells": [],
                    "segments": segments,
                    "skipped": len(markers) - len(segments),
                    "part_count": len(strip["terminals"]),
                    "length_mm": sum(width for _, width in segments),
                }
            )
    return {"strips": items, "skipped": skipped}


def terminal_font_size(groups: list[dict[str, Any]], strip_width_mm: float) -> tuple[int, list[str]]:
    """ONE font size for every Leiste marker of the board.

    Over all strips, not the ones being printed, so a strip reprinted later
    matches the rest. Block labels size their own rows (werkstatt_labels).
    """
    segments = [
        segment
        for strip in terminal_strips(groups)["strips"]
        if strip["kind"] == STRIP_KIND_LEISTE
        for segment in strip["segments"]
    ]
    return font_size_for_fits(segments, strip_width_mm, pad_dots=TERMINAL_SEG_PAD_DOTS)
