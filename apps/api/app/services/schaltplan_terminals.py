"""Reihenklemmen — derive the WAGO terminal sequence of every FI group.

Twin of ``apps/web/src/utils/schaltplanTerminals.ts``. The editor derives
the sequence locally for its "Klemmen" tab, the Stückliste and the print
preview; this module derives it again for the print job and the PDF. Both
sides are pinned on the same fixtures (``tests/test_schaltplan_terminals.py``
↔ ``test/schaltplanTerminals.test.ts``), which is what keeps a preview from
promising a strip the printer will not produce.

The rule, per protection group G (from ``build_topology``, in group order,
children in physical order), with E = the children that are eligible and
flagged ``terminal_block``:

  1. E empty → G emits nothing.
  2. Head is an FI and E is one device with ≥ 3 poles → "single3p":
     [2016-7604 (FI's BMK)] + [2016-7601 × poles (L1, L2, L3, N)] + [2016-7607 (PE)].
  3. Head is an FI otherwise → "standard":
     [2016-7714 (FI's BMK)] + per device (2003-7641 for ≤ 2 poles,
     2003-7642 for ≥ 3) + [2009-305].
  4. Head is not an FI → "no_rcd": the per-device terminals only, and
     ``validate_document`` says why there is no feed terminal.

Decisions, spelled out because the owner's words allowed two readings:
  (a) "at the end of the row" means per protection group, not per physical
      rail — every FI owns its own N bus, so its end element closes *that*
      group even when its breakers continue on the next rail and even when
      two FIs share a rail;
  (b) a 2-pole breaker is treated as 1-pole, a 4-pole outgoing as 3-pole
      (the Etagenklemmen come in exactly those two shapes) — reported as an
      info finding;
  (c) an RCBO never opens a terminal group and never gets one.
"""

from __future__ import annotations

from typing import Any

from app.services.schaltplan_layout import BMK_EDGE_JUNK, DEVICE_CATALOG, build_topology, font_size_for_fits
from app.services.schaltplan_terminal_rules import (
    OUTGOING_PART_IDS,
    TERMINAL_PART_ORDER,
    TERMINAL_PARTS,
    VARIANT_NO_RCD,
    VARIANT_SINGLE_3P,
    TerminalPart,
    device_poles,
    outgoing_part_for_poles,
    terminal_children,
    terminal_variant,
)

# Pad between a terminal's cut mark and its text, in dots (0.5 mm). The BMK
# strip keeps 1 mm on either side, but a 5.2 mm segment minus 2 mm of pad
# holds nothing: 5.2 × 12 − 12 = 50 dots leave "7" at 90 dots and "F1.3" at
# 25 — just above the 24-dot readability floor. "F1.12" still overflows and
# is reported like any other overflow.
TERMINAL_SEG_PAD_DOTS = 6

TEXT_MODE_BMK = "bmk"
TEXT_MODE_CIRCUIT = "circuit"

_POLE_NAMES: tuple[str, ...] = ("L1", "L2", "L3", "N")

SUPPLY_GROUP_ID = "supply"


def _clean(value: Any) -> str:
    return BMK_EDGE_JUNK.sub("", str(value or ""))


def _entry(
    position: int,
    part_id: str,
    device_id: str | None,
    pole: str | None,
    label_bmk: str,
    label_circuit: str,
) -> dict[str, Any]:
    part = TERMINAL_PARTS[part_id]
    return {
        "position": position,
        "part_id": part_id,
        "part_no": part.part_no,
        "device_id": device_id,
        "pole": pole,
        "label_bmk": label_bmk if part.marker else "",
        "label_circuit": label_circuit if part.marker else "",
        "width_mm": part.width_mm,
        "marker": part.marker,
    }


def _feed_entry(position: int, part_id: str, head: dict[str, Any]) -> dict[str, Any]:
    bmk = _clean(head.get("designation"))
    return _entry(position, part_id, str(head.get("id") or "") or None, None, bmk, bmk)


def _outgoing_entry(position: int, device: dict[str, Any]) -> dict[str, Any]:
    return _entry(
        position,
        outgoing_part_for_poles(device_poles(device)),
        str(device.get("id") or "") or None,
        None,
        _clean(device.get("designation")),
        _clean(device.get("circuit")),
    )


def _sequence(variant: str, head: dict[str, Any] | None, children: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if variant == VARIANT_NO_RCD or head is None:
        return [_outgoing_entry(index + 1, device) for index, device in enumerate(children)]
    if variant == VARIANT_SINGLE_3P:
        device = children[0]
        poles = _POLE_NAMES[: device_poles(device)]
        device_id = str(device.get("id") or "") or None
        return [
            _feed_entry(1, "2016-7604", head),
            *[_entry(index + 2, "2016-7601", device_id, pole, pole, pole) for index, pole in enumerate(poles)],
            _entry(len(poles) + 2, "2016-7607", device_id, "PE", "PE", "PE"),
        ]
    return [
        _feed_entry(1, "2016-7714", head),
        *[_outgoing_entry(index + 2, device) for index, device in enumerate(children)],
        _entry(len(children) + 2, "2009-305", None, None, "", ""),
    ]


def derive_terminals(document: dict[str, Any]) -> list[dict[str, Any]]:
    """One entry per group that has at least one terminal, in group order.

    Returns::

        [{"group_id": "f1" | "supply",
          "head_device": <device dict> | None,
          "rail_label": "Reihe 1" | "—",
          "variant": "standard" | "single3p" | "no_rcd",
          "terminals": [{"position", "part_id", "part_no", "device_id",
                         "pole", "label_bmk", "label_circuit", "width_mm",
                         "marker"}, ...]}]
    """
    groups: list[dict[str, Any]] = []
    for group in build_topology(document)["groups"]:
        children = terminal_children(group)
        variant = terminal_variant(group, children)
        if variant is None:
            continue
        head = group.get("device")
        groups.append(
            {
                "group_id": str(head.get("id") or "") if head is not None else SUPPLY_GROUP_ID,
                "head_device": head,
                "rail_label": str(group.get("row_label") or "") if head is not None else "—",
                "variant": variant,
                "terminals": _sequence(variant, head, children),
            }
        )
    return groups


def terminal_group_title(group: dict[str, Any]) -> str:
    """"FI F1 · Reihe 1" — how a group is named on the strip list and the PDF."""
    head = group.get("head_device")
    if head is None:
        return "Einspeisung"
    short = str(DEVICE_CATALOG.get(str(head.get("kind") or ""), {}).get("short", "?"))
    name = f"{short} {str(head.get('designation') or '').strip() or '?'}"
    rail = str(group.get("rail_label") or "")
    return f"{name} · {rail}" if rail else name


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
    """Terminals, groups and outgoing devices with a terminal — the tab badge's numbers."""
    devices: set[str] = set()
    terminals = 0
    for group in groups:
        terminals += len(group["terminals"])
        for terminal in group["terminals"]:
            if terminal["device_id"] and terminal["part_id"] in OUTGOING_PART_IDS:
                devices.add(terminal["device_id"])
    return {"terminals": terminals, "groups": len(groups), "devices": len(devices)}


def unverified_terminal_parts(groups: list[dict[str, Any]]) -> list[TerminalPart]:
    """Parts in use on this board whose width is not confirmed."""
    in_use = {terminal["part_id"] for group in groups for terminal in group["terminals"]}
    return [TERMINAL_PARTS[part_id] for part_id in TERMINAL_PART_ORDER if part_id in in_use and not TERMINAL_PARTS[part_id].verified]


def terminal_text(terminal: dict[str, Any], mode: str) -> str:
    """What a terminal's marker says in the chosen mode; "" for an end element or a missing text."""
    if not terminal["marker"]:
        return ""
    return str(terminal["label_bmk"] if mode == TEXT_MODE_BMK else terminal["label_circuit"])


def terminal_strips(
    groups: list[dict[str, Any]],
    mode: str,
    group_ids: list[str] | None = None,
) -> dict[str, Any]:
    """The strips of a selection: ``{"strips": [...], "skipped": n}``.

    One strip per wanted group, in group order, as ``(text, width_mm)``
    segments. A terminal without a text in the chosen mode gets no segment
    and no width — the strip continues with the next one, exactly like a
    blank cover on the BMK strip — and a group left with no segment is
    dropped from ``strips``. ``skipped`` counts every marker-carrying
    terminal of the wanted groups that got no segment, the ones of a dropped
    group included: that is the number the dialog summary and the print
    notice report, and a dropped group must not make it shrink.

    ``group_ids`` None = every group; an explicit empty list = no group at
    all (an unticked selection prints nothing, it does not print the board).
    """
    wanted = None if group_ids is None else set(group_ids)
    strips: list[dict[str, Any]] = []
    skipped = 0
    for group in groups:
        if wanted is not None and group["group_id"] not in wanted:
            continue
        markers = [terminal for terminal in group["terminals"] if terminal["marker"]]
        segments = [
            (text, float(terminal["width_mm"]))
            for terminal in markers
            for text in (terminal_text(terminal, mode),)
            if text
        ]
        skipped += len(markers) - len(segments)
        if not segments:
            continue
        strips.append(
            {
                "group_id": group["group_id"],
                "label": terminal_group_title(group),
                "segments": segments,
                "skipped": len(markers) - len(segments),
                "part_count": len(group["terminals"]),
                "length_mm": sum(width for _, width in segments),
            }
        )
    return {"strips": strips, "skipped": skipped}


def terminal_font_size(groups: list[dict[str, Any]], mode: str, strip_width_mm: float) -> tuple[int, list[str]]:
    """ONE font size for every terminal strip of the board, in the chosen mode.

    Over all groups, not the ones being printed, so a group reprinted later
    matches the rest. Not the BMK board size: the pitch is different.
    """
    segments = [segment for strip in terminal_strips(groups, mode)["strips"] for segment in strip["segments"]]
    return font_size_for_fits(segments, strip_width_mm, pad_dots=TERMINAL_SEG_PAD_DOTS)
