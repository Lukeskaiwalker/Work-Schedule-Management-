"""Conductors of the all-conductor schematic (docs/SCHALTPLAN_STROMLAUF.md §5.1).

Pure tables: which conductors a device switches, which cores an outgoing
cable carries, what the supply brings in. Nothing here draws; the
Stromlauf model reads these and the layout colours the wires by them.

Conductor names: "L1", "L2", "L3", "N", "PE", "PEN", and "L?" for a phase
the plan does not name. "L?" is drawn in WARN and counted in ONE note per
sheet ("L? = Phase nicht angegeben (n Stromkreise)") instead of a note per
circuit, because "-" is the schema default and most legacy circuits carry it.

The cable cross-section is read by the parser the cabinet preparation uses
for the infeed (``cable_section_parse``, R4 §3.5), so a cable reads the same
on the Materialliste and on the drawing.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Mapping

from app.services.cable_section_parse import normalise_cable_text, parse_cable_section
from app.services.schaltplan_layout import DEVICE_CATALOG

PHASES: tuple[str, str, str] = ("L1", "L2", "L3")
UNKNOWN_PHASE = "L?"
NO_CABLE_TEXT = "Leitung —"
_PHASE_OF: Mapping[str, str] = {"L1": "L1", "L2": "L2", "L3": "L3", "L1/N": "L1"}
#: The core count as written, also past the infeed parser's 2..5 ("NYM-J 7x1,5").
_RAW_CORES = re.compile(r"(?<![0-9.])([0-9]{1,2}) *[xg] *[0-9]", re.ASCII)


def device_poles(device: Mapping[str, Any]) -> int:
    """The device's pole count, the catalogue default when the document has none."""
    try:
        poles = int(device.get("poles") or 0)
    except (TypeError, ValueError):
        poles = 0
    if poles > 0:
        return poles
    return int(DEVICE_CATALOG.get(str(device.get("kind", "")), {}).get("poles", 1))


def _phase(device: Mapping[str, Any]) -> str:
    return _PHASE_OF.get(str(device.get("phase") or "").strip(), UNKNOWN_PHASE)


def device_conductors(device: Mapping[str, Any]) -> tuple[str, ...]:
    """1 pole → (Lx,); 2 → (Lx, N); 3 → (L1, L2, L3); 4 → (L1, L2, L3, N).

    Lx is the device's ``phase`` ("L1"/"L2"/"L3", "L1/N" → L1); "L1-L3",
    "N", "-" and anything else → "L?"."""
    poles = device_poles(device)
    if poles >= 4:
        return (*PHASES, "N")
    if poles == 3:
        return PHASES
    if poles == 2:
        return (_phase(device), "N")
    return (_phase(device),)


@dataclass(frozen=True)
class Outgoing:
    """The cores of a circuit's cable as the drawing shows them."""

    conductors: tuple[str, ...]
    text: str            # the cable as written, or "Leitung —"
    note: str = ""       # "7-adrig": more cores than the drawing names
    cores: int | None = None
    mm2: float | None = None


def _with_n_pe(conductors: tuple[str, ...]) -> tuple[str, ...]:
    phases = tuple(c for c in conductors if c not in ("N", "PE"))
    return (*phases, "N", "PE")


def _raw_cores(text: str) -> int | None:
    match = _RAW_CORES.search(normalise_cable_text(text))
    return int(match.group(1)) if match else None


def outgoing_conductors(device: Mapping[str, Any], cable: Any) -> Outgoing:
    """The outgoing cores from the cable's core count (§5.1):
    2 → (Lx, N); 3 → (Lx, N, PE); 4 → (L1, L2, L3, PE); 5 → (L1, L2, L3, N, PE);
    7+ → the device's conductors + N + PE with the note "{n}-adrig"; unknown →
    the device's conductors + N + PE, and "Leitung —" when there is no cable."""
    text = cable.strip() if isinstance(cable, str) else ""
    own = device_conductors(device)
    parsed = parse_cable_section(text)
    cores, mm2 = parsed["cores"], parsed["mm2"]
    lx = own[0]
    by_cores: Mapping[int, tuple[str, ...]] = {
        2: (lx, "N"), 3: (lx, "N", "PE"), 4: (*PHASES, "PE"), 5: (*PHASES, "N", "PE"),
    }
    if cores in by_cores:
        return Outgoing(by_cores[cores], text, "", cores, mm2)
    raw = _raw_cores(text) if text else None
    note = f"{raw}-adrig" if raw is not None and raw >= 7 else ""
    return Outgoing(_with_n_pe(own), text or NO_CABLE_TEXT, note, raw if note else None, mm2)


@dataclass(frozen=True)
class SupplyConductors:
    """What enters the board: the incoming conductors, where the PEN is split,
    where a separate PE comes from, and a warning when that is unknown."""

    conductors: tuple[str, ...]
    label: str = ""      # "PEN-Aufteilung im HAK" / "… im NAR"
    warn: str = ""       # "PEN-Aufteilungspunkt unbekannt" (never together with a label)
    pe_from: str = ""    # "PE (Anlagenerder)" (TT) / "Anlagenerder" (IT)
    cores: int | None = None
    mm2: float | None = None


def supply_conductors(system: Any, incoming: Any) -> SupplyConductors:
    """The supply's conductors by system and the infeed's core count (§5.1)."""
    parsed = parse_cable_section(incoming)
    cores, mm2 = parsed["cores"], parsed["mm2"]
    five = (*PHASES, "N", "PE")
    name = str(system or "").strip()
    if name == "TN-C-S":
        if cores == 4:
            return SupplyConductors((*PHASES, "PEN"), "PEN-Aufteilung im NAR", cores=cores, mm2=mm2)
        if cores == 5:
            return SupplyConductors(five, "PEN-Aufteilung im HAK", cores=cores, mm2=mm2)
        # Cores unknown: drawn as five conductors, but the split point is not stated as a fact.
        return SupplyConductors(five, "", "PEN-Aufteilungspunkt unbekannt", cores=cores, mm2=mm2)
    if name == "TT":
        return SupplyConductors((*PHASES, "N"), pe_from="PE (Anlagenerder)", cores=cores, mm2=mm2)
    if name == "IT":
        conductors = (*PHASES, "N") if cores == 5 else PHASES
        return SupplyConductors(conductors, pe_from="Anlagenerder", cores=cores, mm2=mm2)
    return SupplyConductors(five, cores=cores, mm2=mm2)


def unknown_phase_note(count: int) -> str:
    """The one sheet note for every "L?" on it; "" when there is none."""
    if count <= 0:
        return ""
    return f"L? = Phase nicht angegeben ({count} {'Stromkreis' if count == 1 else 'Stromkreise'})"
