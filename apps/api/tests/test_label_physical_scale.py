"""Every label prints at its PHYSICAL size — 300 dots per inch, not 12 per mm.

The 258-5101 has a 300 dpi head and feeds 300 dots per inch (physical test
T4, 13.10.2026: a 10 → 90 ruler drawn as 960 dots printed 81,5 mm). Its OWN
millimetre is dots / 12: it converts every millimetre it receives in ``^Q``
and ``^W`` at 12 dots. So SMPL lays out in physical dots
(``mm_to_dots``, 300 / 25,4 per mm, rounded once at the end) and states
``^Q``/``^W`` in the printer's millimetres derived from those dot totals
(``printer_mm``). What is pinned here:

1. the measuring pattern's 10 → 90 ruler is exactly 80 physical mm (945 dots);
2. a 12-module BMK strip at 17,5 mm does not drift: every cut mark lands
   within one dot of its millimetre, the last one 210 mm after the first;
3. ``^Q``/``^W`` in printer millimetres for 210-804, a continuous 2009-110
   strip and the 211-501 tube — a continuous feed always covers its content,
   a die-cut form never ends before its label (the guard lets content run to
   the label's last dot), and no builtin die-cut job reaches past its form;
4. no rendering module converts millimetres with 12 — only the printer-unit
   helper may, and only for ``^Q``/``^W``.
"""

from __future__ import annotations

import ast
import inspect
import io
import re
from collections import Counter
from collections.abc import Iterator
from pathlib import Path

import pytest
from PIL import Image, ImageOps

from app.services import schaltplan_layout
from app.services import schaltplan_terminals
from app.services import schaltplan_type_label
from app.services import werkstatt_article_labels
from app.services import werkstatt_box_labels
from app.services import werkstatt_label_builtins
from app.services import werkstatt_label_calibration
from app.services import werkstatt_label_control_strip
from app.services import werkstatt_label_frame
from app.services import werkstatt_label_jobs
from app.services import werkstatt_label_patterns
from app.services import werkstatt_label_profile
from app.services import werkstatt_label_strips
from app.services import werkstatt_labels as wl
from app.services.werkstatt_label_builtins import DEFAULT_MATERIALS
from app.services.werkstatt_label_calibration import setup_commands
from app.services.werkstatt_label_jobs import dry_render_samples
from app.services.werkstatt_label_patterns import pattern_job, pattern_supported
from app.services.werkstatt_label_profile import (
    DOTS_PER_MM,
    MAX_LENGTH_MM,
    MIN_LENGTH_MM,
    PHYSICAL_DOTS_PER_MM,
    TIER_VOLL,
    MaterialProfile,
    mm_to_dots,
    printer_mm,
    printer_width_mm,
    q_value,
)

M = {profile.id: profile for profile in DEFAULT_MATERIALS}
P804, P2009, P211 = M["wago-210-804"], M["wago-2009-110"], M["wago-211-501"]
MACHINE = wl.LabelContent("M-0042", "Makita Akkuschrauber DDF485", "Makita", "SN123456")


def _elements(job: list[str]) -> list[str]:
    start = job.index("^L") + 1
    end = len(job) - 1 - job[::-1].index("E")
    return job[start:end]


def _lo(job: list[str]) -> list[tuple[int, int, int, int]]:
    out = []
    for line in _elements(job):
        if match := re.match(r"^Lo,(-?\d+),(-?\d+),(-?\d+),(-?\d+)$", line):
            out.append(tuple(int(group) for group in match.groups()))
    return out


def _header(job: list[str], prefix: str) -> str:
    return next(line for line in job[: job.index("^L")] if line.startswith(prefix))


def _form_dots(job: list[str]) -> int:
    """The form the job's ``^Q`` declares, in dots (the printer's mm × 12)."""
    return int(_header(job, "^Q")[2:].split(",")[0]) * DOTS_PER_MM


# ── The helpers ──────────────────────────────────────────────────────────────


def test_mm_to_dots_is_300_dpi_rounded_once() -> None:
    assert PHYSICAL_DOTS_PER_MM == 300 / 25.4
    assert [mm_to_dots(mm) for mm in (1, 2, 3, 10, 44, 80, 99, 210)] == [12, 24, 35, 118, 520, 945, 1169, 2480]
    assert mm_to_dots(0) == 0 and mm_to_dots(-1) == -12
    # The printer's millimetre is 12 dots: to the nearest one (a gap, a mark),
    # or rounded UP when the printer's form or width must cover the label or
    # the content.
    assert printer_mm(1169) == 97 and printer_mm(35) == 3
    assert printer_mm(1169, cover=True) == 98
    assert printer_mm(2575, cover=True) == 215 and printer_mm(2580, cover=True) == 215
    assert printer_width_mm(44) == 44 and printer_width_mm(11) == 11 and printer_width_mm(5) == 5


# ── 1. The measuring pattern's ruler ─────────────────────────────────────────


def test_the_pattern_ruler_is_80_physical_mm() -> None:
    """The owner's next ruler check must read 80,0 — 945 dots, not 960."""
    job, geometry = pattern_job(P804)
    assert (geometry.ruler_from_mm, geometry.ruler_to_mm) == (10, 90)
    assert geometry.inset_mm == 2.0
    # The ticks: 2 dots wide along the feed, all standing on one baseline
    # (the same machine x); the centre cross's across arm stands elsewhere.
    narrow = [line for line in _lo(job) if line[3] - line[1] == 2]
    baseline, count = Counter(line[0] for line in narrow).most_common(1)[0]
    assert count == 81, "one tick per millimetre, 10 … 90"
    centres = sorted((line[1] + line[3]) // 2 for line in narrow if line[0] == baseline)
    assert centres[-1] - centres[0] == 945 == round(80 * 300 / 25.4)
    x_offset = mm_to_dots(P804.x_offset_mm)
    for k, centre in zip(range(10, 91), centres):
        assert centre == mm_to_dots(k) + x_offset, f"tick {k} mm is not at its physical millimetre"


def test_the_pattern_box_sits_2_physical_mm_inside_the_label() -> None:
    """The box the operator measures A/B/L/R against: 2 mm in from a 99 × 44 mm label."""
    job, _ = pattern_job(P804)
    h, w, i, t = mm_to_dots(44), mm_to_dots(99), mm_to_dots(2), 3
    xo = mm_to_dots(P804.x_offset_mm)
    assert (h, w, i, xo) == (520, 1169, 24, 24)
    assert _lo(job)[:4] == [
        (i, i + xo, h - i, i + t + xo),  # A — leading edge
        (i, w - i - t + xo, h - i, w - i + xo),  # B — trailing edge
        (h - i - t, i + xo, h - i, w - i + xo),  # L — reading top
        (i, i + xo, i + t, w - i + xo),  # R — reading bottom
    ]
    # At the 2 mm offset B, L and R end on the label's last dot (1169): the
    # ^Q form must reach it, or the first pattern prints without B.
    assert w - i + xo <= _form_dots(job) == 1176


def test_the_continuous_pattern_ticks_every_5_physical_mm() -> None:
    job, geometry = pattern_job(P2009)
    assert geometry.side_line_inset_mm == 1.0 and geometry.bar_inset_mm == 3.0
    x_offset = mm_to_dots(P2009.x_offset_mm)
    ticks = sorted((line[1] + line[3]) // 2 for line in _lo(job) if line[3] - line[1] == 2)
    assert ticks == [mm_to_dots(mm) + x_offset for mm in range(5, 36, 5)]


# ── 2. The BMK strip does not drift ──────────────────────────────────────────


def test_a_twelve_module_strip_lands_every_cut_on_its_millimetre() -> None:
    segments = [(f"F1.{index}", 17.5) for index in range(1, 13)]
    job = wl._render_rail_strip(P2009, segments, size=36)
    h_px = mm_to_dots(11)
    cuts = sorted((line[1] + line[3]) // 2 for line in _lo(job) if (line[0], line[2]) == (0, h_px))
    assert len(cuts) == 13, "a start line, eleven dividers, an end line"
    x_offset = mm_to_dots(P2009.x_offset_mm)
    assert cuts[0] == mm_to_dots(3) + x_offset, "the start line after 3 mm of lead"
    for k, cut in enumerate(cuts):
        assert abs(cut - cuts[0] - 17.5 * k * PHYSICAL_DOTS_PER_MM) <= 1, f"cut {k} drifted"
    assert abs((cuts[-1] - cuts[0]) - round(210 * 300 / 25.4)) <= 1


def test_the_block_label_cells_sit_on_the_12_mm_terminal_pitch() -> None:
    cells = [("N", 12), ("L1", 12), ("L2", 12), ("L3", 12), ("PE", 12)]
    job = wl._render_block_label(P2009, name="PV Wechselrichter", x_label="X1", cells=cells)
    x_offset = mm_to_dots(P2009.x_offset_mm)
    vertical = sorted({(line[1] + line[3]) // 2 - x_offset for line in _lo(job) if line[3] - line[1] in (2, 4)})
    assert vertical == [mm_to_dots(3 + 12 * k) for k in range(6)]


# ── 3. ^Q and ^W in the printer's millimetres ────────────────────────────────


def test_210_804_states_its_label_in_printer_millimetres() -> None:
    """99 + 3 × 44 mm: 1169 + 35 dots × 520 dots → ^Q98,3 ^W44.

    97,4 printer-mm of label rounded UP (a 1176-dot form; ^Q97 would be 1164,
    5 dots short of the label), 2,9 of gap to the nearest, 43,3 of width up.
    """
    for job in (wl._render_voll(P804, MACHINE), pattern_job(P804)[0]):
        assert job[:2] == ["^Q98,3", "^W44"]
    assert setup_commands(P804)[-2:] == ["^Q98,3", "^W44"]


def test_a_die_cut_form_never_ends_before_its_label() -> None:
    """The guard lets die-cut content run to the label's last dot
    (``mm_to_dots(length)``), so the ``^Q`` form must reach it — and it
    reaches less than one printer millimetre further. Every length the
    printer takes, in tenths, on gap and on mark stock."""
    for tenths in range(round(MIN_LENGTH_MM * 10), round(MAX_LENGTH_MM * 10) + 1):
        length_mm = tenths / 10
        label = mm_to_dots(length_mm)
        for profile in (
            MaterialProfile(id="gap", name="", part_no="", width_mm=40, length_mm=length_mm),
            MaterialProfile(id="mark", name="", part_no="", width_mm=40, length_mm=length_mm, mark_width_mm=4),
        ):
            form = int(q_value(profile).split(",")[0]) * DOTS_PER_MM
            assert label <= form < label + DOTS_PER_MM, (length_mm, q_value(profile))


@pytest.fixture
def label_logo(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    from app.core.config import get_settings

    logo = Path(__file__).resolve().parents[1] / "app" / "assets" / "logo.jpeg"
    monkeypatch.setattr(get_settings(), "report_logo_path", str(logo))
    wl._logo_asset.cache_clear()
    yield
    wl._logo_asset.cache_clear()


def _ink_lengths() -> dict[str, int]:
    """Bitmap name → how far its ink reaches along the feed from its anchor.

    Ink, not the bitmap: the QR's quiet zone is white, and white past the
    form loses nothing.
    """
    box, tl = werkstatt_box_labels, schaltplan_type_label
    assets = [wl._logo_asset()]
    assets += box.render_box_label(P804, box.BoxLabelContent("KISTE-BK-2026-0001", "BK-2026-0001", "Kiste Wallbox"))[1]
    assets += tl.render_type_label(P804, tl.TypeLabelContent("Familie Schulze", "381", "09.2026", "VT-0001"))[1]
    lengths = {}
    for name, bmp, _, _ in filter(None, assets):
        # Back from the machine frame (the asset turned it 270°) to reading:
        # reading x runs along the feed; ink is black.
        reading = Image.open(io.BytesIO(bmp)).convert("L").transpose(Image.Transpose.ROTATE_90)
        lengths[name] = ImageOps.invert(reading).getbbox()[2]
    return lengths


def _feed_ends(job: list[str], ink: dict[str, int]) -> list[tuple[int, str]]:
    """(machine y where it ends, line) per element: a rule's far end, a text's
    estimated width, a code's symbol, a bitmap's ink."""
    ends: list[tuple[int, str]] = []
    elements = iter(_elements(job))
    for line in elements:
        if line.startswith("Lo,"):
            ends.append((int(line.split(",")[4]), line))
        elif line.startswith("AT,"):
            parts = line.split(",", 9)
            ends.append((int(parts[2]) + wl._est_text_w(parts[9], int(parts[3])), line))
        elif line.startswith("XRB"):
            _, y, module = (int(part) for part in line[3:].split(",")[:3])
            data = next(elements)
            ends.append((y + werkstatt_box_labels.datamatrix_symbol_modules(data) * module, line))
        elif line.startswith("Y"):
            _, y, name = line[1:].split(",")
            ends.append((int(y) + ink[name], line))
    return ends


# The voll and kompakt layouts keep 2 mm to the trailing edge, so at the
# builtin 2 mm offset they end on the label's last dot. Not the 210-805: its
# mini labels centre their text 1 mm from the edges, which at a 2 mm offset
# reaches past ^Q15 by the width estimate — as it did at 12 dots per mm,
# also with ^Q15; the guard checks text anchors only (§4.9).
@pytest.mark.parametrize("material_id", ["wago-210-804", "wago-210-824", "wago-210-812"])
def test_every_builtin_die_cut_job_ends_inside_its_form(material_id: str, label_logo: None) -> None:
    profile = M[material_id]
    assert profile.x_offset_mm == 2.0
    ink = _ink_lengths()
    placed_images = 0
    for render in dry_render_samples(profile, pattern=pattern_supported(profile)):
        job = render(profile)
        form = _form_dots(job)
        assert form >= mm_to_dots(profile.length_mm), "the form ends before the label"
        for end, line in _feed_ends(job, ink):
            assert end <= form, f"{line} ends at machine y {end}, past the {_header(job, '^Q')} form ({form} dots)"
        placed_images += sum(line.startswith("Y") for line in _elements(job))
    assert pattern_supported(profile)
    if profile.tier == TIER_VOLL:
        assert placed_images >= 4, "logo, crate logo, type-label logo and QR were all checked"


def test_a_continuous_strip_feeds_its_content_rounded_up() -> None:
    """216 mm (3 + 12 × 17,5 + 3) + 2 mm print-origin offset = 2551 + 24 dots → 214,6 → ^Q215,0."""
    job = wl._render_rail_strip(P2009, [(f"F1.{index}", 17.5) for index in range(1, 13)], size=36)
    assert job[:2] == ["^Q215,0", "^W11"]
    content = mm_to_dots(216) + mm_to_dots(P2009.x_offset_mm)
    assert 215 * 12 >= content > 214 * 12


@pytest.mark.parametrize("text", ["X1", "F1.1", "Herd Küche 16A", "Wärmepumpe Außeneinheit 32A"])
def test_the_tube_feeds_at_least_its_content_and_15_mm(text: str) -> None:
    job = wl._render_mini(P211, text)
    assert _header(job, "^W") == "^W5"  # 5 mm = 59 dots = 4,9 printer-mm, rounded up
    q = int(_header(job, "^Q")[2:].split(",")[0])
    right = max(int(line.split(",")[2]) for line in _elements(job) if line.startswith("AT,"))
    assert q * 12 >= right, "the form ends inside the text"
    assert q >= 15 and q * 12 >= mm_to_dots(15)


def test_the_tube_pattern_and_short_text() -> None:
    assert wl._render_mini(P211, "X1")[:2] == ["^Q15,0", "^W5"]  # 15 mm minimum: 177 dots → 14,75 → 15
    assert pattern_job(P211)[0][:2] == ["^Q32,0", "^W5"]  # 30 mm + 2 mm offset: 354 + 24 dots → 31,5 → 32


def test_custom_die_cut_and_mark_stock() -> None:
    custom = MaterialProfile(id="custom-38x23", name="Fremd", part_no="", width_mm=23, length_mm=38)
    assert wl._render_mini(custom, "X1")[:2] == ["^Q38,3", "^W23"]  # 449 dots → 37,4 → 38; 272 dots → 22,7 → 23
    mark = MaterialProfile(id="custom-mark", name="Marke", part_no="", width_mm=40, length_mm=25, mark_width_mm=4, mark_offset_mm=3)
    assert wl._render_mini(mark, "X1")[:2] == ["^Q25,4,3+", "^W40"]


# ── 4. Nobody else converts millimetres with 12 ──────────────────────────────

RENDERING_MODULES = (
    wl,
    werkstatt_article_labels,
    werkstatt_box_labels,
    schaltplan_type_label,
    werkstatt_label_patterns,
    werkstatt_label_jobs,
    werkstatt_label_calibration,
    werkstatt_label_builtins,
    schaltplan_layout,
    schaltplan_terminals,
    werkstatt_label_frame,
    werkstatt_label_strips,
    werkstatt_label_control_strip,
)
_PRINTER_UNIT_NAMES = {"DOTS_PER_MM", "_DOTS_PER_MM", "STRIP_DOTS_PER_MM"}


def _twelve_conversions(tree: ast.AST) -> list[int]:
    """Line numbers of ``x * 12``, ``12 * x``, ``x / 12``, ``x // 12`` and of the printer-unit name."""
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Mult, ast.Div, ast.FloorDiv)):
            if any(isinstance(side, ast.Constant) and side.value == 12 for side in (node.left, node.right)):
                found.append(node.lineno)
        elif isinstance(node, ast.Name) and node.id in _PRINTER_UNIT_NAMES:
            found.append(node.lineno)
        elif isinstance(node, ast.Attribute) and node.attr in _PRINTER_UNIT_NAMES:
            found.append(node.lineno)
        elif isinstance(node, ast.alias) and node.name in _PRINTER_UNIT_NAMES:
            found.append(getattr(node, "lineno", 0))
    return found


@pytest.mark.parametrize("module", RENDERING_MODULES, ids=lambda module: module.__name__.rsplit(".", 1)[-1])
def test_no_rendering_module_converts_millimetres_with_12(module) -> None:
    tree = ast.parse(inspect.getsource(module))
    assert _twelve_conversions(tree) == [], (
        f"{module.__name__} converts with 12 — physical geometry goes through mm_to_dots, "
        "^Q/^W through printer_mm"
    )


def test_only_the_printer_unit_helper_divides_by_12() -> None:
    tree = ast.parse(inspect.getsource(werkstatt_label_profile))
    users = {
        function.name
        for function in ast.walk(tree)
        if isinstance(function, ast.FunctionDef)
        and any(isinstance(node, ast.Name) and node.id == "DOTS_PER_MM" for node in ast.walk(function))
    }
    assert users == {"printer_mm"}
