"""The one text-fit rule of the close-up (docs/PANEL_ENCLOSURE_R2.md §7.1).

``fit_label`` decides how a marker, a level or a "für" text is drawn in a
cell: horizontal at the largest size, shrunk to the minimum, rotated 90°,
and only then cut with an ellipsis. The app (scale 1.1, its UI font is not
Helvetica) and the PDF (scale 1) share it, and the TS twin ``labelFit.ts``
runs the same table of cases from ``enclosureFixtures.json`` (``label_fit``).

Widths are Helvetica's AFM advance widths, the font the PDF draws with, so
the table is pinned against reportlab's own metrics.
"""

from __future__ import annotations

import json

import pytest
from reportlab.pdfbase.pdfmetrics import stringWidth

from app.services.label_fit import (
    ELLIPSIS,
    FALLBACK_UNITS,
    HELVETICA_UNITS,
    LabelFit,
    fit_label,
    text_units,
    text_width,
)
from scripts.write_enclosure_fixtures import FIXTURE_PATH

MARKER_W, MARKER_H = 14.74, 28.35  # a 5.2 mm terminal under a 10 mm marker strip, in pt


def test_the_width_table_is_reportlabs_helvetica() -> None:
    assert len(HELVETICA_UNITS) >= 95 + 96
    for char, units in HELVETICA_UNITS.items():
        assert units == round(stringWidth(char, "Helvetica", 1000)), char


def test_unknown_characters_fall_back_to_556_per_em() -> None:
    assert FALLBACK_UNITS == 556
    assert text_units("→") == 556
    assert text_units("X1") == 667 + 556
    assert text_units("") == 0


def test_widths_scale_with_size_and_scale() -> None:
    assert text_width("X1", 6) == pytest.approx(7.338)
    assert text_width("X1", 6, 1.1) == pytest.approx(7.338 * 1.1)


@pytest.mark.parametrize(
    ("text", "cell", "size", "scale", "expected"),
    [
        # 1. horizontal at the largest size
        ("X1", (MARKER_W, MARKER_H), (6, 5), 1.0, LabelFit("X1", 6, False, False)),
        # 2. horizontal, shrunk to what fits (floored to 0.1)
        ("10.12", (MARKER_W, MARKER_H), (6, 5), 1.0, LabelFit("10.12", 5.8, False, False)),
        # 3. rotated 90°: the cell's height is the length
        ("Steckdosen", (MARKER_W, MARKER_H), (6, 5), 1.0, LabelFit("Steckdosen", 5.4, True, False)),
        # 4. ellipsis at the minimum, in the orientation that keeps more
        ("Steckdosen Küche", (MARKER_W, MARKER_H), (6, 5), 1.0, LabelFit("Steckdose…", 5, True, True)),
        # a tie stays horizontal: a square cell keeps as many characters either way
        ("Steckdosen Küche", (20, 20), (6, 6), 1.0, LabelFit("Stec…", 6, False, True)),
        ("ab cde", (25, 10), (10, 10), 1.0, LabelFit("ab…", 10, False, True)),
        # only trailing U+0020 is cut before the "…" (both twins alike; not JS trimEnd)
        ("ab cde", (25, 10), (10, 10), 1.0, LabelFit("ab …", 10, False, True)),
        # the app's margin: scale 1.1 shrinks "1.12" in a 26 px terminal
        ("1.12", (26, 40), (13, 11), 1.1, LabelFit("1.12", 12.1, False, False)),
        # nothing fits at all, not even the ellipsis
        ("Abc", (2, 2), (6, 5), 1.0, LabelFit("", 5, False, True)),
        ("", (MARKER_W, MARKER_H), (6, 5), 1.0, LabelFit("", 6, False, False)),
    ],
)
def test_the_fit_table(text: str, cell: tuple[float, float], size: tuple[float, float], scale: float,
                       expected: LabelFit) -> None:
    fit = fit_label(text, cell[0], cell[1], size[0], size[1], scale)
    assert fit == expected
    length, cross = (cell[1], cell[0]) if fit.rotated else (cell[0], cell[1])
    assert text_width(fit.text, fit.size, scale) <= length + 1e-9
    assert fit.text == "" or fit.size <= cross


def test_the_ellipsis_is_one_character() -> None:
    assert ELLIPSIS == "…"
    fit = fit_label("Durchlauferhitzer Bad oben", 30, 8, 6, 5)
    assert fit.truncated and fit.text.endswith(ELLIPSIS)
    assert "Durchlauferhitzer Bad oben".startswith(fit.text[:-1])


def test_the_fixture_runs_the_same_table() -> None:
    cases = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))["label_fit"]
    assert len(cases) >= 8
    for case in cases:
        fit = fit_label(case["text"], case["cell"]["w"], case["cell"]["h"], case["size"]["max"], case["size"]["min"],
                        case["scale"])
        assert fit.as_dict() == case["fit"], case["text"]
