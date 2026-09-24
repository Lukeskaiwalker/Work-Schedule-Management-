"""The Übersichtsschaltplan's sheet layout — three things the owner's print
of 2026-09-24 showed wrong.

What must hold: a group too wide for band 1 (which shares the sheet with the
Schriftfeld) starts a new sheet instead of running under the title block;
the second band's busbar sits below the deepest text a circuit in band 0 can
stack; and the pole count is visible — on the symbol, beside the rating and
in the legend's device column — because a 1-pole and a 3-pole LS read
identically otherwise.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.services import schaltplan_pdf as pdf
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
