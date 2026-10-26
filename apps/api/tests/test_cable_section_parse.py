"""Infeed cross-section and fuse rating out of free text (docs/PANEL_ENCLOSURE_R4.md §3.5).

The TypeScript twin is pinned on the same answers through the fixture tables
``infeed_parse`` and ``fuse_parse`` of ``enclosureFixtures.json``.
"""

from __future__ import annotations

import pytest

from app.services.cable_section_parse import normalise_cable_text, parse_cable_section, parse_fuse_amps


def _section(mm2: float | None, cores: int | None, aluminium: bool = False) -> dict:
    return {"mm2": mm2, "cores": cores, "aluminium": aluminium}


@pytest.mark.parametrize(("text", "expected"), [
    ("NYY-J 5x16 mm²", _section(16.0, 5)),
    ("NYY-J 5×35mm²", _section(35.0, 5)),
    ("5G25", _section(25.0, 5)),
    ("4x35+16", _section(35.0, 5)),
    ("NYCWY 3x35/16", _section(35.0, 4)),
    ("NAYY-J 4x50", _section(50.0, 4, True)),
    ("NA2XY 4x150", _section(150.0, 4, True)),
    ("35 mm2", _section(35.0, None)),
    ("35 qmm", _section(35.0, None)),
    ("NYY-J 5x16, 3x63A", _section(16.0, 5)),
    ("NYY-J 5x16 mm²", _section(16.0, 5)),
    ("1x500+5x35", _section(35.0, 5)),
    ("", _section(None, None)),
    ("Hausanschluss", _section(None, None)),
    ("NYM-J 5x2,5", _section(2.5, 5)),
])
def test_the_contract_table(text: str, expected: dict) -> None:
    assert parse_cable_section(text) == expected


def test_the_first_of_the_largest_pairs_wins_and_out_of_range_pairs_are_dropped() -> None:
    assert parse_cable_section("5x25 und 5x35 und 4x35")["cores"] == 5
    assert parse_cable_section("5x0.75 5x10") == _section(10.0, 5)
    assert parse_cable_section("5x400") == _section(None, None)


def test_a_decimal_is_never_cut_short_and_amperes_are_no_pair() -> None:
    assert parse_cable_section("5x16.5") == _section(16.5, 5)
    assert parse_cable_section("3x63A") == _section(None, None)
    assert parse_cable_section("3 x 63 a") == _section(None, None)
    assert parse_cable_section("12x16") == _section(None, None)


def test_cores_outside_two_to_five_are_unknown_and_the_extra_conductor_is_clamped() -> None:
    assert parse_cable_section("1x35") == _section(35.0, None)
    assert parse_cable_section("7x25") == _section(25.0, None)
    assert parse_cable_section("5x35+16") == _section(35.0, 5)
    assert parse_cable_section("1x35+16") == _section(35.0, None)


def test_a_plain_mm_figure_counts_only_without_any_pair_and_only_in_range() -> None:
    assert parse_cable_section("0,75 mm2 und 50 mm²") == _section(50.0, None)
    assert parse_cable_section("500 mm") == _section(None, None)


def test_aluminium_spellings() -> None:
    for text in ("NAYY 4x50", "na2xs2y 4x95", "Alu 4x50", "Aluminium 4x50", "AL 4x50"):
        assert parse_cable_section(text)["aluminium"] is True, text
    for text in ("NYY-J 4x50", "Kabel 4x50", "Talstraße 4x50", "NYM 5x10"):
        assert parse_cable_section(text)["aluminium"] is False, text


def test_lenient_on_anything_that_is_not_text() -> None:
    for value in (None, 16, 2.5, ["5x16"], {"mm2": 16}):
        assert parse_cable_section(value) == _section(None, None)
        assert parse_fuse_amps(value) is None


def test_normalisation_maps_every_listed_space_and_symbol() -> None:
    spaces = "\t\n\x0b\x0c\r         　﻿"
    assert normalise_cable_text(spaces) == " " * len(spaces)
    assert normalise_cable_text("5×16 QMM²,5*") == "5x16 mm2.5x"
    assert normalise_cable_text("​") == "​"


@pytest.mark.parametrize(("text", "expected"), [
    ("NH 63 A", 63),
    ("3x63A", 63),
    ("125 Ampere", 125),
    ("", None),
    ("NH00 100A", 100),
    ("NH00 gG 63 A / SLS 50 A", 63),
    ("63 Amp", None),
    ("2.5a", None),
])
def test_fuse_amps(text: str, expected: int | None) -> None:
    assert parse_fuse_amps(text) == expected
