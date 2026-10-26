"""Which conductors a device switches, a cable carries and the supply brings
(docs/SCHALTPLAN_STROMLAUF.md §5.1) — the tables the all-conductor drawing
is built from. Pure functions; every input deep-frozen so a mutation fails."""

from __future__ import annotations

from types import MappingProxyType

import pytest

from app.services.schaltplan_conductors import (
    device_conductors,
    outgoing_conductors,
    supply_conductors,
    unknown_phase_note,
)


def _frozen(**fields: object) -> MappingProxyType:
    return MappingProxyType(dict(fields))


@pytest.mark.parametrize(
    ("kind", "poles", "phase", "expected"),
    [
        ("mcb", 1, "L1", ("L1",)),
        ("mcb", 1, "L2", ("L2",)),
        ("mcb", 1, "L3", ("L3",)),
        ("mcb", 1, "L1/N", ("L1",)),
        ("mcb", 1, "L1-L3", ("L?",)),
        ("mcb", 1, "N", ("L?",)),
        ("mcb", 1, "-", ("L?",)),
        ("mcb", 1, None, ("L?",)),
        ("rcbo", 2, "L2", ("L2", "N")),
        ("rcbo", 2, "-", ("L?", "N")),
        ("mcb", 3, "L1-L3", ("L1", "L2", "L3")),
        ("rcd", 4, "-", ("L1", "L2", "L3", "N")),
        ("rcd", None, "-", ("L1", "L2", "L3", "N")),  # poles from the catalogue (FI: 4)
        ("hauptschalter", 0, "-", ("L1", "L2", "L3")),
    ],
)
def test_device_conductors(kind: str, poles: int | None, phase: str | None, expected: tuple[str, ...]) -> None:
    assert device_conductors(_frozen(kind=kind, poles=poles, phase=phase)) == expected


@pytest.mark.parametrize(
    ("poles", "phase", "cable", "conductors", "text", "note"),
    [
        (1, "L2", "NYM-J 3x2,5 mm²", ("L2", "N", "PE"), "NYM-J 3x2,5 mm²", ""),
        (1, "L1", "NYM-O 2x1,5", ("L1", "N"), "NYM-O 2x1,5", ""),
        (3, "-", "NYM-J 4x2,5", ("L1", "L2", "L3", "PE"), "NYM-J 4x2,5", ""),
        (3, "-", "NYM-J 5x2,5 mm²", ("L1", "L2", "L3", "N", "PE"), "NYM-J 5x2,5 mm²", ""),
        (1, "L3", "NYM-J 7x1,5", ("L3", "N", "PE"), "NYM-J 7x1,5", "7-adrig"),
        (1, "L1", "NYM-J 12x1,5", ("L1", "N", "PE"), "NYM-J 12x1,5", "12-adrig"),
        (1, "L1", "", ("L1", "N", "PE"), "Leitung —", ""),
        (2, "L1", None, ("L1", "N", "PE"), "Leitung —", ""),
        (3, "-", "", ("L1", "L2", "L3", "N", "PE"), "Leitung —", ""),
        (4, "-", "  ", ("L1", "L2", "L3", "N", "PE"), "Leitung —", ""),
        (1, "-", "NYM-J", ("L?", "N", "PE"), "NYM-J", ""),
        (1, "-", "NYM-J 3x1,5", ("L?", "N", "PE"), "NYM-J 3x1,5", ""),
    ],
)
def test_outgoing_conductors(poles: int, phase: str, cable: str | None, conductors: tuple[str, ...],
                             text: str, note: str) -> None:
    out = outgoing_conductors(_frozen(kind="mcb", poles=poles, phase=phase), cable)
    assert (out.conductors, out.text, out.note) == (conductors, text, note)


def test_outgoing_conductors_read_the_cross_section() -> None:
    out = outgoing_conductors(_frozen(kind="mcb", poles=1, phase="L1"), "NYM-J 3x2,5 mm²")
    assert (out.cores, out.mm2) == (3, 2.5)


@pytest.mark.parametrize(
    ("system", "incoming", "conductors", "label", "warn", "pe_from"),
    [
        ("TN-S", "NYY-J 5x16 mm²", ("L1", "L2", "L3", "N", "PE"), "", "", ""),
        ("TN-C-S", "NYY-J 5x16 mm²", ("L1", "L2", "L3", "N", "PE"), "PEN-Aufteilung im HAK", "", ""),
        ("TN-C-S", "NYY-J 4x35", ("L1", "L2", "L3", "PEN"), "PEN-Aufteilung im NAR", "", ""),
        ("TN-C-S", "Hausanschluss", ("L1", "L2", "L3", "N", "PE"), "PEN-Aufteilung im HAK",
         "Aufteilungspunkt unbekannt", ""),
        ("TT", "NYY-J 5x16", ("L1", "L2", "L3", "N"), "", "", "PE (Anlagenerder)"),
        ("IT", "NYY-J 4x16", ("L1", "L2", "L3"), "", "", "Anlagenerder"),
        ("IT", "NYY-J 5x16", ("L1", "L2", "L3", "N"), "", "", "Anlagenerder"),
        ("", "NYY-J 5x16", ("L1", "L2", "L3", "N", "PE"), "", "", ""),
    ],
)
def test_supply_conductors(system: str, incoming: str, conductors: tuple[str, ...], label: str, warn: str,
                           pe_from: str) -> None:
    supply = supply_conductors(system, incoming)
    assert (supply.conductors, supply.label, supply.warn, supply.pe_from) == (conductors, label, warn, pe_from)


def test_one_sheet_note_counts_the_unknown_phases() -> None:
    assert unknown_phase_note(3) == "L? = Phase nicht angegeben (3 Stromkreise)"
    assert unknown_phase_note(1) == "L? = Phase nicht angegeben (1 Stromkreis)"
    assert unknown_phase_note(0) == ""
