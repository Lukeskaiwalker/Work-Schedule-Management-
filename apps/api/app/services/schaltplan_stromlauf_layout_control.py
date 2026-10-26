"""The "Steuerung & Kommunikation" band of the cabinet sheet (docs/SCHALTPLAN_STROMLAUF.md §5.3).

120 pt under the last lane of the carrier's sheet:

* the **network lead** dashed teal, RJ45 to RJ45, "{ZZ45WAN…} · RJ45", from
  "APZ Feld a" to "RfZ|Zählerplatz Feld b";
* the **§14a block** as a terminal row on the metered side (right of the
  carrier's Trennvorrichtung column): end stop, one 2002-1671 per terminal
  with its name vertical (bottom → top), end plate, end stop. Above it the
  open customer stubs, labelled by position in a staircase (the leftmost
  group highest, so no text crosses a stub); below it the purple control
  wires straight down to a Lüsterklemme with as many poles, at the target.

Every wire here is a signal ("CTRL" / "DATA", sources "control" /
"network"): nothing joins the block or the lead to L/N/PE. Pure.
"""

from __future__ import annotations

from typing import Sequence

from app.services.schaltplan_pdf_style import CONDUCTOR_COLOURS
from app.services.schaltplan_stromlauf_cabinet import CabinetSection, ControlBand, NetworkLead
from app.services.schaltplan_stromlauf_layout_bands import BLUE, MUTED, WARN, Builder

BAND_H = 120.0
TERMINAL_W = 14.0
END_STOP_W = 5.0
PLATE_W = 2.0
BLOCK_TOP, BLOCK_BOTTOM = 58.0, 86.0       # below the band top
LUESTER_TOP, LUESTER_BOTTOM = 100.0, 108.0
STAIR_TOP, STAIR_PITCH = 16.0, 8.0
CTRL = CONDUCTOR_COLOURS["CTRL"].colour
#: The role of each position on the BDEW strip (1-based), and what its stub reads.
ROLES: tuple[tuple[tuple[int, ...], str], ...] = (
    ((1,), "← gemessener Bereich (Erzeugungsanlage/Kundenanlage)"),
    ((2, 3, 4), "→ Erzeugungsanlage"),
    ((5,), "← gemessener Bereich"),
    ((6,), "→ steuVE"),
    (tuple(range(7, 13)), ""),
)


def stub_groups(terminals: Sequence[tuple[int, str, str]]) -> list[tuple[list[int], str]]:
    """Per role present: (terminal indices, stub text). The text joins the
    non-blank stored labels with " / " and adds the role; "" when every label
    of the group is blank (no text drawn)."""
    out: list[tuple[list[int], str]] = []
    for positions, role in ROLES:
        members = [i for i, (position, _label, _colour) in enumerate(terminals) if position in positions]
        if not members:
            continue
        names = " / ".join(terminals[i][1] for i in members if terminals[i][1])
        out.append((members, " ".join(p for p in (names, role) if p) if names else ""))
    return out


def _network(b: Builder, lead: NetworkLead, top: float, x0: float) -> None:
    left, right = x0 + 60.0, x0 + 260.0
    y = top - 42.0
    for jack in (left, right):
        b.box("rj45", jack, y + 4, jack + 12, y - 4, [])
    b.wire("DATA", "network", (left + 12, y), (right, y))
    b.text((left + right + 12) / 2, top - 35.0, f"{lead.article} · RJ45", w=right - left - 12, anchor="middle",
           colour=CONDUCTOR_COLOURS["DATA"].colour)
    b.text(left, top - 56.0, lead.start, w=(right - left) / 2, colour=MUTED)
    b.text(right + 12, top - 56.0, lead.end, w=(right - left) / 2, anchor="end", colour=MUTED)


def _block_parts(b: Builder, band: ControlBand, top: float, x: float) -> list[float]:
    """End stop | terminals | plate | end stop; returns the terminal centres."""
    y0, y1 = top - BLOCK_TOP, top - BLOCK_BOTTOM
    b.box("end_stop", x, y0, x + END_STOP_W, y1, [])
    x += END_STOP_W
    centres: list[float] = []
    for _position, label, colour in band.terminals:
        b.box("control_terminal", x, y0, x + TERMINAL_W, y1, [], colour=colour)
        centre = x + TERMINAL_W / 2
        b.text(centre + 2.3, y1 + 2.0, label, w=BLOCK_BOTTOM - BLOCK_TOP - 4.0, angle=90)
        centres.append(centre)
        x += TERMINAL_W
    b.box("plate", x, y0, x + PLATE_W, y1, [])
    b.box("end_stop", x + PLATE_W, y0, x + PLATE_W + END_STOP_W, y1, [])
    return centres


def _stubs(b: Builder, band: ControlBand, centres: Sequence[float], top: float, x1: float) -> None:
    for rank, (members, text) in enumerate(stub_groups(band.terminals)):
        baseline = top - STAIR_TOP - STAIR_PITCH * rank
        for index in members:
            cx = centres[index]
            b.wire("CTRL", "control", (cx, top - BLOCK_TOP), (cx, baseline - 4.0))
            b.box("terminal", cx - 1.8, baseline - 2.2, cx + 1.8, baseline - 5.8, [], conductor="CTRL")
        start = centres[members[0]] - 1.8
        b.text(start, baseline, text, w=x1 - start, colour=MUTED)


def _wires(b: Builder, band: ControlBand, centres: Sequence[float], top: float, x: float, x1: float) -> None:
    """The control wires down to the Lüsterklemme, and the texts right of the block."""
    if band.target:
        for cx in centres:
            b.wire("CTRL", "control", (cx, top - BLOCK_BOTTOM), (cx, top - LUESTER_TOP))
        poles = [{"x": round(cx, 1), "conductor": "CTRL"} for cx in centres]
        b.box("luester", centres[0] - 6, top - LUESTER_TOP, centres[-1] + 6, top - LUESTER_BOTTOM, poles)
        b.text(x, top - 93.0, band.wires, w=x1 - x, colour=CTRL)
        short = band.luester.split(" (", 1)[0] if band.luester else f"Lüsterklemme {len(centres)}-polig"
        b.text(x, top - 106.0, f"{short} · {band.target}", w=x1 - x)
        return
    b.text(x, top - 93.0, f"§14a-Steuerleitungen ohne Ziel: {band.missing}", w=x1 - x, colour=WARN)


def draw_control_band(b: Builder, section: CabinetSection, top: float, x0: float, block_x: float, x1: float) -> None:
    """The band below ``top`` (the last lane's bottom) on the carrier's sheet."""
    b.text(x0 + 56.0, top - 16.0, "Steuerung & Kommunikation", w=block_x - x0 - 64.0, bold=True, size=7.5, colour=BLUE)
    if section.network is not None:
        _network(b, section.network, top, x0)
    band = section.control
    if band is None or not band.terminals:
        return
    centres = _block_parts(b, band, top, block_x)
    _stubs(b, band, centres, top, x1)
    right = centres[-1] + TERMINAL_W / 2 + PLATE_W + END_STOP_W + 8.0
    parts = f"{len(band.terminals)} × 2002-1671 · 2 × 249-116 · 2002-1692"
    b.text(right, top - 64.0, f"§14a-Klemmleiste · {band.rail_title}", w=x1 - right, bold=True, size=7.0)
    b.text(right, top - 72.0, parts, w=x1 - right, colour=MUTED)
    _wires(b, band, centres, top, right, x1)


def band_needed(section: CabinetSection) -> bool:
    return section.network is not None or (section.control is not None and bool(section.control.terminals))
