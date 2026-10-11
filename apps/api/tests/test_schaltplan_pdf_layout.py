"""The Übersichtsschaltplan's sheet layout — three things the owner's print
of 2026-09-24 showed wrong.

What must hold: a group too wide for band 1 (which shares the sheet with the
Schriftfeld) starts a new sheet instead of running under the title block;
the second band's busbar sits below the deepest text a circuit in band 0 can
stack; and the pole count is visible — on the symbol, beside the rating and
in the legend's device column — because a 1-pole and a 3-pole LS read
identically otherwise. On the Stromkreisliste no text may run into the next
column: every header fits its column (owner's print of 2026-10-09: "Verbraucher
/ Bezeichnung" ran into "Raum") and every wrapped cell line fits, the
truncated last one included — at the same total width as before, so the
sheet glued into the door keeps its size.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from reportlab.pdfbase.pdfmetrics import stringWidth

from app.services import schaltplan_pdf as pdf
from app.services.schaltplan_pdf_style import FONT, FONT_BOLD, wrap
from app.services.schaltplan_layout import build_legend
from tests.test_schaltplan import _auth, _create_panel, _customer, _device, _document


def _group(circuits: int) -> dict:
    return {"device": _device("f1", "rcd", te=4, poles=4), "children": [_device(f"f1.{i}", "mcb") for i in range(circuits)], "pre_fuse": None}


def test_a_group_too_wide_for_the_lower_band_starts_a_new_sheet() -> None:
    # Six circuits = 468 pt: more than band 1 can hold left of the title block.
    sheets = pdf._paginate_groups([_group(4), _group(6)])
    assert [(len(b0), len(b1)) for b0, b1 in sheets] == [(1, 0), (1, 0)]
    # Five circuits = 390 pt still fit the lower band, so one sheet does.
    sheets = pdf._paginate_groups([_group(4), _group(5)])
    assert [(len(b0), len(b1)) for b0, b1 in sheets] == [(1, 1)]
    # A group wider than band 0 itself still gets a band of its own (runs to the frame edge).
    sheets = pdf._paginate_groups([_group(8), _group(2)])
    assert [(len(b0), len(b1)) for b0, b1 in sheets] == [(1, 1)]


def test_the_lower_busbar_clears_the_deepest_circuit_text_of_the_upper_band() -> None:
    # A circuit stacks two label lines, room, cable and phase under its chip.
    deepest_baseline = pdf._Y_TEXT - 8.5 - 3 * 8.0
    lower_bar = pdf._Y_BUS - pdf._BAND_DY
    caption_top = lower_bar + 5 + 6.5
    assert caption_top < deepest_baseline - 6
    # …and the lower band's own deepest line stays inside the frame.
    assert deepest_baseline - pdf._BAND_DY > 24


def test_pole_counts_reach_the_diagram_and_the_legend() -> None:
    assert pdf._poles(_device("f1.1", "mcb")) == 1
    assert pdf._poles(_device("f1.3", "mcb", te=3, poles=3)) == 3
    assert pdf._poles({"kind": "rcd"}) == 4  # catalog default when the document has none
    rows = build_legend(
        _document(
            [
                _device("f1", "rcd", te=4, poles=4, rating="40 A"),
                _device("f1.1", "mcb", rating="B16", circuit="1"),
                _device("f1.2", "mcb", te=3, poles=3, rating="B16", circuit="2"),
            ]
        )
    )
    assert [(row["device"], row["poles"]) for row in rows] == [("LS", "1"), ("LS", "3")]


def test_a_six_circuit_second_group_gets_its_own_diagram_sheet(client: TestClient, admin_token: str) -> None:
    def board(second_group_circuits: int) -> dict:
        devices = [_device("f1", "rcd", te=4, poles=4, rating="40 A")]
        devices += [_device(f"f1.{i}", "mcb", rating="B16", circuit=str(i)) for i in range(1, 5)]
        devices.append(_device("f2", "rcd", te=4, poles=4, rating="40 A"))
        devices += [_device(f"f2.{i}", "mcb", rating="B16", circuit=str(10 + i)) for i in range(1, second_group_circuits + 1)]
        return _document(devices)

    customer = _customer(client, admin_token)
    five = _create_panel(client, admin_token, customer, designation="UV5", document=board(5))
    six = _create_panel(client, admin_token, customer, designation="UV6", document=board(6))
    pages = {}
    for designation, panel in (("five", five), ("six", six)):
        resp = client.get(f"/api/schaltplan/panels/{panel['id']}/pdf", headers=_auth(admin_token))
        assert resp.status_code == 200, resp.text
        pages[designation] = resp.content.count(b"/Type /Page") - resp.content.count(b"/Type /Pages")
    assert pages["five"] >= 2 and pages["six"] == pages["five"] + 1


def test_every_legend_header_fits_its_column_at_the_same_total_width() -> None:
    assert sum(width for _key, _title, width in pdf._LEGEND_COLUMNS) == 534
    for key, title, width in pdf._LEGEND_COLUMNS:
        size = pdf._legend_header_size(title, width)
        assert stringWidth(title, FONT_BOLD, size) <= width - 6, (key, title, size)
        assert size >= 6.5, (key, title, size)  # still readable in a dark cellar


@pytest.mark.parametrize(
    "text",
    [
        "Waschmaschine Hauswirtschaftsraum Untergeschoss links neben der Tür",
        "Küchenarbeitsplattensteckdosenleiste",
        "Außenbeleuchtung Terrasse, Garten und Einfahrt mit Bewegungsmelder und Dämmerungsschalter",
        "NYM-J5x2,5mm²-Zuleitung-Unterverteilung-Dachgeschoss",
        # A short word first, then one wider than the column: the second
        # word must be cut too, not let into "Gerät" (review, 2026-10-09).
        "UG Hauswirtschaftsraum",
        "F1 Küchenarbeitsplattensteckdosenleiste und Kühlschrank",
    ],
)
def test_no_wrapped_legend_line_is_wider_than_its_column(text: str) -> None:
    for _key, _title, width in pdf._LEGEND_COLUMNS:
        for line in wrap(text, FONT, 7.5, width - 6, 3):
            assert stringWidth(line, FONT, 7.5) <= width - 6, (width, line)



def test_a_wide_word_after_a_short_one_is_cut_and_marked_not_dropped() -> None:
    lines = wrap("UG Hauswirtschaftsraum", FONT, 7.5, 50, 3)
    assert lines[0] == "UG"
    assert lines[1].startswith("Hauswirt") and lines[1].endswith("…")
    assert all(stringWidth(line, FONT, 7.5) <= 50 for line in lines)
    # Text left over when the lines run out ends in "…", and a line that
    # still has room keeps its last word whole.
    assert wrap("Steckdosen Küche Arbeitsplatte links", FONT, 7.5, 92, 1) == ["Steckdosen Küche…"]
