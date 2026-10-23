"""The plan routes number WAGO terminals as the cabinet does (docs/PANEL_ENCLOSURE_R2.md §3.1, §5.1).

On a cabinet board every caller passes the same skip set: an AAR, NAR, RfZ
or APZ circuit gets no Reihenklemme whatever its flag says, and the X numbers
run over what is left — in the detail route's legend and Stückliste, the
label print and the Plan PDF alike. Every Stückliste carries the rail parts
(the end plates), so the detail route's terminal BOM equals the
Materialliste's terminal lines. A board without a cabinet is unchanged, and
so is one whose stored cabinet block the types refuse (D14): every route
leaves that block out, as the detail route does. Every name and number here
is invented.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.services import schaltplan_pdf
from app.services.panel_enclosure_catalog import builtin_catalog
from app.services.panel_enclosure_terminals import board_terminals
from app.services.schaltplan_layout import build_legend
from app.services.schaltplan_terminals import derive_terminals, terminal_bom
from scripts.write_enclosure_fixtures import terminals_zb34s
from tests.panel_enclosure_helpers import auth, create_panel, store_directly
from tests.test_schaltplan import _capture_label_jobs, _configure_label_printer, _pdf_text


def _detail(client: TestClient, token: str, panel_id: int) -> dict:
    resp = client.get(f"/api/schaltplan/panels/{panel_id}", headers=auth(token))
    assert resp.status_code == 200, resp.text
    return resp.json()


def _legacy() -> dict:
    document = terminals_zb34s()
    document["enclosure"] = None
    return document


def test_the_detail_stueckliste_uses_the_skip_set_and_the_rail_parts(
    client: TestClient, admin_token: str
) -> None:
    panel = create_panel(client, admin_token, terminals_zb34s())
    detail = _detail(client, admin_token, panel["id"])
    bom = [(row["part_no"], row["count"]) for row in detail["terminal_bom"]]
    assert ("WAGO 2003-7692", 3) in bom and ("WAGO 2016-7691", 1) in bom

    material = client.get(f"/api/schaltplan/panels/{panel['id']}/material", headers=auth(admin_token)).json()
    assert bom == [(line["label"], line["planned"]) for line in material["lines"] if line["kind"] == "terminal"]
    assert any(finding["rule"] == "encl.terminals_zone" for finding in detail["findings"])


def test_a_board_without_a_cabinet_keeps_its_old_numbers_and_stueckliste(client: TestClient, admin_token: str) -> None:
    document = _legacy()
    panel = create_panel(client, admin_token, document)
    detail = _detail(client, admin_token, panel["id"])
    expected = [(row["part_no"], row["count"]) for row in terminal_bom(derive_terminals(document))]
    assert [(row["part_no"], row["count"]) for row in detail["terminal_bom"]] == expected


def test_the_label_print_numbers_strips_like_the_cabinet(client: TestClient, admin_token: str, monkeypatch) -> None:
    _configure_label_printer(client, admin_token)
    sent = _capture_label_jobs(monkeypatch)
    panel = create_panel(client, admin_token, terminals_zb34s())
    resp = client.post(f"/api/schaltplan/panels/{panel['id']}/labels", headers=auth(admin_token),
                       json={"target": "reihenklemmen"})
    assert resp.status_code == 200, resp.text
    strips = [(strip["row_id"], strip["row_label"]) for strip in resp.json()["strips"]]
    assert strips[0] == ("dev-f1:leiste", "X1 · FI F1 · F2 · Verteiler 1")
    assert "dev-q1:leiste" not in [strip_id for strip_id, _ in strips]  # the AAR circuit's strip is gone
    assert len(sent) == 1


def test_a_selection_naming_a_strip_the_board_no_longer_has_is_refused(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    """A tab opened before round 2 (or an iOS app built before it) numbers the
    board without the skip set: the AAR circuit's strip is X1 there, F1 is X2,
    and the Klemmen tab ticks both. Printing what is left would put X1 on F1's
    rail while that screen says X2, so the print is refused, nothing goes to
    the printer, and the message says to reload (review UPG-5)."""
    _configure_label_printer(client, admin_token)
    sent = _capture_label_jobs(monkeypatch)
    panel = create_panel(client, admin_token, terminals_zb34s())
    url = f"/api/schaltplan/panels/{panel['id']}/labels"
    stale = client.post(url, headers=auth(admin_token),
                        json={"target": "reihenklemmen", "strip_ids": ["dev-q1:leiste", "dev-f1:leiste"]})
    assert stale.status_code == 409, stale.text
    assert "neu laden" in stale.json()["detail"]
    assert sent == []

    current = client.post(url, headers=auth(admin_token), json={"target": "reihenklemmen", "strip_ids": ["dev-f1:leiste"]})
    assert current.status_code == 200, current.text
    assert [strip["row_id"] for strip in current.json()["strips"]] == ["dev-f1:leiste"]
    assert len(sent) == 1


def test_the_plan_pdf_legend_gets_the_skip_set(client: TestClient, admin_token: str, monkeypatch) -> None:
    seen: list[frozenset[str]] = []
    original = schaltplan_pdf.build_legend

    def spy(document, *, terminal_skip=frozenset()):
        seen.append(terminal_skip)
        return original(document, terminal_skip=terminal_skip)

    monkeypatch.setattr(schaltplan_pdf, "build_legend", spy)
    panel = create_panel(client, admin_token, terminals_zb34s())
    resp = client.get(f"/api/schaltplan/panels/{panel['id']}/pdf?legend_only=true", headers=auth(admin_token))
    assert resp.status_code == 200, resp.text
    assert seen == [board_terminals(terminals_zb34s(), builtin_catalog()).skip]
    assert "dev-aar-ls1" in seen[0]
    rows = {row["designation"]: row["terminals"] for row in build_legend(terminals_zb34s(), terminal_skip=seen[0])}
    assert (rows["F0.1"], rows["F1.1"]) == ("", "X1.1")  # on the AAR: no X label; F1 is X1


def test_the_klemmenliste_pdf_numbers_like_the_cabinet_and_lists_the_end_plates(
    client: TestClient, admin_token: str
) -> None:
    panel = create_panel(client, admin_token, terminals_zb34s())
    resp = client.get(f"/api/schaltplan/panels/{panel['id']}/pdf?terminals_only=true", headers=auth(admin_token))
    assert resp.status_code == 200, resp.text
    text = _pdf_text(resp.content)
    assert b"WAGO 2003-7692" in text and b"WAGO 2016-7691" in text
    assert b"HS Q1" not in text  # the AAR circuit's Leiste is not derived on a cabinet board

    legacy = create_panel(client, admin_token, _legacy())
    plain = _pdf_text(client.get(f"/api/schaltplan/panels/{legacy['id']}/pdf?terminals_only=true",
                                 headers=auth(admin_token)).content)
    assert b"HS Q1" in plain and b"WAGO 2003-7692" not in plain


def _refused_block() -> dict:
    """The owner-style board with a module label past the schema's 64
    characters: a block Slice P (or a rollback to it) could store and the
    current types refuse. Its modules still resolve, so a reader that skips
    validation would still compute a skip set from it."""
    document = terminals_zb34s()
    document["enclosure"]["modules"][0]["label"] = "L" * 65
    return document


def test_a_refused_cabinet_block_is_left_out_by_every_route(client: TestClient, admin_token: str, monkeypatch) -> None:
    """The detail route leaves the block out (D14), so the Klemmen tab numbers
    the board as one without a cabinet. The label print, the Plan PDF and the
    Materialliste must do the same, or the printed X numbers and the lists
    disagree with the screen until the next save drops the block."""
    _configure_label_printer(client, admin_token)
    _capture_label_jobs(monkeypatch)
    seen: list[frozenset[str]] = []
    original = schaltplan_pdf.build_legend

    def spy(document, *, terminal_skip=frozenset()):
        seen.append(terminal_skip)
        return original(document, terminal_skip=terminal_skip)

    monkeypatch.setattr(schaltplan_pdf, "build_legend", spy)
    panel = create_panel(client, admin_token)
    store_directly(panel["id"], _refused_block())
    url = f"/api/schaltplan/panels/{panel['id']}"

    detail = _detail(client, admin_token, panel["id"])
    assert any(finding["rule"] == "encl.invalid_block" for finding in detail["findings"])
    plain = terminal_bom(derive_terminals(_legacy()))
    bom = [(row["part_no"], row["count"]) for row in detail["terminal_bom"]]
    assert bom == [(row["part_no"], row["count"]) for row in plain]

    material = client.get(f"{url}/material", headers=auth(admin_token)).json()
    assert [(line["label"], line["planned"]) for line in material["lines"] if line["kind"] == "terminal"] == bom

    labels = client.post(f"{url}/labels", headers=auth(admin_token), json={"target": "reihenklemmen"})
    assert labels.status_code == 200, labels.text
    strips = [(strip["row_id"], strip["row_label"].split(" · ")[0]) for strip in labels.json()["strips"]]
    assert strips[:2] == [("dev-q1:leiste", "X1"), ("dev-f1:leiste", "X2")]

    pdf = client.get(f"{url}/pdf?legend_only=true", headers=auth(admin_token))
    assert pdf.status_code == 200, pdf.text
    assert seen == [frozenset()]
    text = _pdf_text(client.get(f"{url}/pdf?terminals_only=true", headers=auth(admin_token)).content)
    assert b"HS Q1" in text and b"WAGO 2003-7692" not in text

    aufbau = client.get(f"{url}/aufbau/pdf", headers=auth(admin_token))
    assert aufbau.status_code == 409, aufbau.text
