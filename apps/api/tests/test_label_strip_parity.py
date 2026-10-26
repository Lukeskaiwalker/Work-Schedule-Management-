"""The BMK strip the editor previews is the strip the printer prints — one fixture.

``apps/web/src/test/fixtures/stripParityFixtures.json`` holds sample boards
and Block labels with everything both sides compute: the dots per mm, the
strip's largest font, each rail's segments, the board font size, every cut
mark in dots (``mm_to_dots`` of lead + running millimetres) and the Block
label's row and cell sizes. This file holds the API to it — layout AND the
rendered EZPL — and ``schaltplanStripParity.test.ts`` holds the TypeScript
twin to the same numbers, so a scale or rounding changed on one side only
turns one of them red.

The fixture was computed from the formulas alone (300 dpi, half-up rounding
once, per-glyph Arial advances), not from either implementation. A deliberate
change to the strip geometry regenerates it and states why in the commit.

The terminal fixtures (``terminalFixtures.json``, walked by
``schaltplanTerminalFixtures.test.ts``) carry the board's Leisten font size
too; it is checked against the Python derivation here.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from app.services import werkstatt_labels as wl
from app.services.schaltplan_layout import board_font_size, strip_max_font_size, strip_segments
from app.services.schaltplan_terminals import derive_terminals, terminal_font_size
from app.services.werkstatt_label_builtins import DEFAULT_MATERIALS
from app.services.werkstatt_label_profile import PHYSICAL_DOTS_PER_MM, mm_to_dots

FIXTURES = Path(__file__).resolve().parents[2] / "web" / "src" / "test" / "fixtures"
PARITY = FIXTURES / "stripParityFixtures.json"
TERMINALS = FIXTURES / "terminalFixtures.json"

pytestmark = pytest.mark.skipif(not PARITY.exists(), reason="the api image is built without apps/web")

P2009 = next(profile for profile in DEFAULT_MATERIALS if profile.id == "wago-2009-110")


def _fixture() -> dict:
    return json.loads(PARITY.read_text(encoding="utf-8"))


def _elements(job: list[str]) -> list[str]:
    return job[job.index("^L") + 1 : len(job) - 1 - job[::-1].index("E")]


def _vertical_marks(job: list[str]) -> list[int]:
    """Centres (machine y, print-origin offset removed) of the cut marks across the strip."""
    x_offset = mm_to_dots(P2009.x_offset_mm)
    centres = []
    for line in _elements(job):
        match = re.match(r"^Lo,(-?\d+),(-?\d+),(-?\d+),(-?\d+)$", line)
        if match and int(match.group(4)) - int(match.group(2)) in (2, 4):
            centres.append((int(match.group(2)) + int(match.group(4))) // 2 - x_offset)
    return sorted(centres)


def _at_sizes(job: list[str]) -> list[int]:
    return [int(line.split(",")[3]) for line in _elements(job) if line.startswith("AT,")]


def test_the_fixture_is_drawn_at_the_physical_300_dpi() -> None:
    fixture = _fixture()
    assert fixture["dots_per_mm"] == PHYSICAL_DOTS_PER_MM == 300 / 25.4
    assert strip_max_font_size(fixture["strip_width_mm"]) == fixture["max_font_dots"] == 93
    # The strip's physical height, not a whole-millimetre one: 10,5 mm = 124
    # dots → 89 (schaltplanStrip.test.ts pins the same edge rule).
    assert strip_max_font_size(10.5) == 89


@pytest.mark.parametrize("name", ["twelve_breakers", "mixed"])
def test_a_board_lays_out_and_prints_as_the_fixture_says(name: str) -> None:
    fixture = _fixture()
    board = fixture["boards"][name]
    size, overflowing = board_font_size(board["document"], fixture["strip_width_mm"])
    assert [size, overflowing] == board["font"]

    rows = {row["id"]: row for row in board["document"]["rows"]}
    for rail in board["rails"]:
        segments = strip_segments(rows[rail["row_id"]])
        assert [{"text": s.text, "width_mm": s.width_mm, "start_mm": s.start_mm} for s in segments] == rail["segments"]
        job = wl._render_rail_strip(P2009, [(s.text, s.width_mm) for s in segments], size=size)
        assert _vertical_marks(job) == rail["cuts_dots"], f"{name}/{rail['row_id']}: cut marks"
        assert set(_at_sizes(job)) == {size}
        # The form covers the whole strip plus the print-origin offset.
        q = int(job[0][2:].split(",")[0])
        assert q * 12 >= rail["total_dots"] + mm_to_dots(P2009.x_offset_mm)


@pytest.mark.parametrize("index", [0, 1])
def test_a_block_label_prints_the_fixture_sizes_and_cuts(index: int) -> None:
    block = _fixture()["blocks"][index]
    job = wl._render_block_label(
        P2009, name=block["name"], x_label=block["x_label"], cells=[(text, width) for text, width in block["cells"]]
    )
    assert _at_sizes(job) == block["row_sizes"] + block["cell_sizes"]
    assert _vertical_marks(job) == block["cuts_dots"]


@pytest.mark.skipif(not TERMINALS.exists(), reason="the api image is built without apps/web")
def test_the_terminal_fixtures_font_is_the_python_one() -> None:
    boards = json.loads(TERMINALS.read_text(encoding="utf-8"))
    for name, board in boards.items():
        size, overflowing = terminal_font_size(derive_terminals(board["document"]), 11.0)
        assert [size, overflowing] == board["font"], name
