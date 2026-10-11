"""Feeding chains in the Verteilerplan (owner, 2026-10-09).

"I can not assign an SLS to an RCD … as well as assigning an SLS to a
Hauptschalter and then a Hauptschalter to an FI to complete the row. Also
after a Hauptschalter sometimes comes a Hensel KKL54 to distribute to the
next components."

What must hold:

* an FI, Hauptschalter, SLS or Verteilerblock may name the SLS, Hauptschalter
  or Verteilerblock that feeds it (``parent_id``); the topology carries the
  link both ways — the fed group's ``fed_by``, the feeder's ``feeds`` — and a
  fuse named there stays the Vorsicherung it always was;
* a chain may run SLS → Hauptschalter → Verteilerblock → several FIs;
* a link that would close a circle is ignored and reported, a link to
  something that cannot feed is reported, and neither ever breaks a load;
* the Verteilerblock (Hensel KKL 54) is a device of its own: it opens a group
  like a Hauptschalter, LS placed after it hang off it, and it is one line of
  the Materialliste;
* the legend's Vorsicherung column follows the chain up to the first fuse or
  SLS, so a circuit behind FI ← HS ← SLS reads "Q0 SLS E35";
* the PDF draws the link: "über Q1 HS" on the fed group's drop line and
  "speist F1, F2" in the feeder's box.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.services.schaltplan_layout import DEVICE_CATALOG, build_legend, build_topology, validate_document
from app.services.schaltplan_material import planned_lines
from tests.test_schaltplan import _auth, _create_panel, _customer, _device, _document, _pdf_text


def _groups(document: dict) -> dict[str, dict]:
    return {group["device"]["id"]: group for group in build_topology(document)["groups"] if group["device"]}


def _ids(devices: list[dict]) -> list[str]:
    return [device["id"] for device in devices]


def _chain_board() -> dict:
    """SLS → Hauptschalter → Verteilerblock → two FIs with their LS."""
    return _document(
        [
            _device("q0", "sls", designation="Q0", te=3, poles=3, rating="E35"),
            _device("q1", "hauptschalter", designation="Q1", te=3, poles=3, rating="63 A", parent_id="q0"),
            _device("x1", "distribution_block", designation="X1", te=4, poles=4, parent_id="q1"),
            _device("f1", "rcd", designation="F1", te=4, poles=4, rating="40 A", residual_current="30 mA", parent_id="x1"),
            _device("f1.1", "mcb", designation="F1.1", circuit="1", rating="B16", label="Küche"),
            _device("f2", "rcd", designation="F2", te=4, poles=4, rating="40 A", residual_current="30 mA", parent_id="x1"),
            _device("f2.1", "mcb", designation="F2.1", circuit="2", rating="B16", label="Bad"),
        ]
    )


def test_the_verteilerblock_is_a_device_that_opens_a_group():
    entry = DEVICE_CATALOG["distribution_block"]
    assert entry["label"] == "Verteilerblock (Hensel KKL 54)"
    assert (entry["group"], entry["circuit"]) == (True, False)
    # LS placed after it hang off it, like after a Hauptschalter.
    document = _document([_device("x1", "distribution_block", designation="X1"), _device("a", "mcb", circuit="1")])
    assert _ids(_groups(document)["x1"]["children"]) == ["a"]


def test_an_sls_feeds_an_fi_directly():
    document = _document(
        [
            _device("q0", "sls", designation="Q0", rating="E35"),
            _device("f1", "rcd", designation="F1", parent_id="q0"),
            _device("a", "mcb", circuit="1"),
        ]
    )
    groups = _groups(document)
    assert groups["f1"]["fed_by"]["id"] == "q0"
    assert groups["f1"]["pre_fuse"] is None
    assert _ids(groups["q0"]["feeds"]) == ["f1"]
    # The LS still hang off the FI before them, not off the SLS.
    assert _ids(groups["f1"]["children"]) == ["a"]
    assert not [f for f in validate_document(document) if f["scope"] == "f1"]


def test_a_whole_chain_sls_hauptschalter_verteilerblock_two_fis():
    groups = _groups(_chain_board())
    assert groups["q1"]["fed_by"]["id"] == "q0"
    assert groups["x1"]["fed_by"]["id"] == "q1"
    assert [groups[fi]["fed_by"]["id"] for fi in ("f1", "f2")] == ["x1", "x1"]
    assert _ids(groups["q0"]["feeds"]) == ["q1"]
    assert _ids(groups["q1"]["feeds"]) == ["x1"]
    assert _ids(groups["x1"]["feeds"]) == ["f1", "f2"]
    assert _ids(groups["f1"]["children"]) == ["f1.1"] and _ids(groups["f2"]["children"]) == ["f2.1"]


def test_the_legend_follows_the_chain_to_the_first_fuse_or_sls():
    rows = {row["circuit"]: row for row in build_legend(_chain_board())}
    assert rows["1"]["pre_fuse"] == "Q0 SLS E35"
    assert rows["1"]["rcd"] == "30 mA"
    # A fuse in front of the Hauptschalter is closer than the SLS behind it.
    document = _document(
        [
            _device("n0", "fuse", designation="F0", rating="35 A"),
            _device("q1", "hauptschalter", designation="Q1", parent_id="n0"),
            _device("f1", "rcd", designation="F1", parent_id="q1"),
            _device("a", "mcb", circuit="7"),
        ]
    )
    [row] = build_legend(document)
    assert row["pre_fuse"] == "F0 35 A"


def test_a_fuse_named_by_an_fi_is_still_its_vorsicherung():
    document = _document(
        [
            _device("n0", "fuse", designation="F0", rating="35 A"),
            _device("f1", "rcd", designation="F1", parent_id="n0"),
            _device("a", "mcb", circuit="1"),
        ]
    )
    group = _groups(document)["f1"]
    assert group["pre_fuse"]["id"] == "n0"
    assert group["fed_by"] is None


def test_a_circle_is_ignored_and_reported():
    document = _document(
        [
            _device("q0", "sls", designation="Q0", parent_id="q1"),
            _device("q1", "hauptschalter", designation="Q1", parent_id="q0"),
            _device("a", "mcb", circuit="1"),
        ]
    )
    groups = _groups(document)
    assert groups["q0"]["fed_by"] is None and groups["q1"]["fed_by"] is None
    assert groups["q0"]["feeds"] == [] and groups["q1"]["feeds"] == []
    messages = {f["scope"]: f["message"] for f in validate_document(document)}
    assert "Kreis" in messages["q0"] and "Kreis" in messages["q1"]


def test_a_link_to_something_that_cannot_feed_is_reported():
    document = _document(
        [
            _device("a", "mcb", circuit="1"),
            _device("f1", "rcd", designation="F1", parent_id="a"),
            _device("f2", "rcd", designation="F2", parent_id="ghost"),
        ]
    )
    groups = _groups(document)
    assert groups["f1"]["fed_by"] is None and groups["f2"]["fed_by"] is None
    findings = validate_document(document)
    assert any(f["scope"] == "f1" and "Einspeisung nicht gefunden" in f["message"] for f in findings), findings
    assert any(f["scope"] == "f2" and "Einspeisung nicht gefunden" in f["message"] for f in findings), findings


def test_the_verteilerblock_is_a_line_of_the_materialliste():
    lines = {line.key: line for line in planned_lines(_chain_board())}
    line = lines["device:distribution_block:4p:"]
    assert line.label == "Verteilerblock (Hensel KKL 54)"
    assert line.planned == 1


def test_the_pdf_draws_the_chain(client: TestClient, admin_token: str):
    customer_id = _customer(client, admin_token)
    panel = _create_panel(client, admin_token, customer_id)
    saved = client.patch(
        f"/api/schaltplan/panels/{panel['id']}", headers=_auth(admin_token), json={"document": _chain_board()}
    )
    assert saved.status_code == 200, saved.text
    assert [d["kind"] for d in saved.json()["document"]["rows"][0]["devices"]][2] == "distribution_block"
    pdf = client.get(f"/api/schaltplan/panels/{panel['id']}/pdf", headers=_auth(admin_token))
    assert pdf.status_code == 200, pdf.text
    text = _pdf_text(pdf.content)
    # "über …" — the u-umlaut is WinAnsi-encoded in the content stream.
    assert b"ber Q1 HS" in text and b"ber X1 VB" in text
    assert b"speist F1, F2" in text


def test_a_device_named_like_a_terminal_strip_is_reported():
    """X is the Verteilerblock's natural BMK letter and the letter the derived
    Klemmleisten count in: "X1" twice on one board prints one label on two
    different parts. Reported, never refused — and a rail "terminal" device
    may carry its own strip's name."""
    def board(block_name: str, rail_terminal: str | None = None) -> dict:
        devices = [
            _device("q1", "hauptschalter", designation="Q1", te=3, poles=3),
            _device("x1", "distribution_block", designation=block_name, te=4, poles=4, parent_id="q1"),
            _device("f1", "rcd", designation="F1", te=4, poles=4, parent_id="x1"),
            _device("a", "mcb", designation="F1.1", circuit="1", rating="B16", terminal_block=True),
        ]
        if rail_terminal:
            devices.append(_device("t1", "terminal", designation=rail_terminal))
        return _document(devices)

    clash = [f for f in validate_document(board("X1")) if f["scope"] == "x1"]
    assert [f["level"] for f in clash] == ["warn"]
    assert clash[0]["message"].startswith("X1: so heißt auch eine Klemmleiste")
    # Any case: "x1" is the same label on a printed strip.
    assert [f for f in validate_document(board("x1")) if f["scope"] == "x1"]
    assert not [f for f in validate_document(board("X0")) if f["scope"] == "x1"]
    assert not [f for f in validate_document(board("X0", rail_terminal="X1")) if f["scope"] == "t1"]
