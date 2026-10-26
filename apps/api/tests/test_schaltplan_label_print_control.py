"""Printing the §14a block: the vertical strip and the Aderbeschriftung (R4 §9.1, §9.2).

The block strip rides the Reihenklemmen print as its LAST item (``strip_ids``
null included); the wire labels are their own target, ``adern``, on the
board's own tube. The printer is faked at the socket — nothing leaves the
test. Every board here is invented.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.routers import workflow_schaltplan_labels
from app.services.panel_enclosure_control_block import default_control_block
from test_schaltplan import (
    _auth,
    _capture_label_jobs,
    _configure_label_printer,
    _create_panel,
    _customer,
    _device,
    _document,
    _jobs,
)
from test_schaltplan_terminals import _two_rcd_board

STALE_BLOCK = (
    "Die §14a-Klemmleiste wurde geändert oder entfernt — nichts gedruckt. "
    "Bitte die Seite neu laden und erneut drucken."
)


def _with_block(document: dict, block: dict | None) -> dict:
    enclosure = {"code": "ZB33S", "modules": []}
    if block is not None:
        enclosure["control_block"] = block
    return {**document, "enclosure": enclosure}


def _block(labels: list[str], **extra) -> dict:
    return {
        **default_control_block(),
        "terminals": [{"id": f"t{i + 1}", "label": label, "color": "braun"} for i, label in enumerate(labels)],
        **extra,
    }


def _no_terminals() -> dict:
    return _document([_device("f1", "rcd", designation="F1"), _device("a", "mcb", designation="F1.1")])


def _panel(client: TestClient, admin_token: str, document: dict) -> dict:
    customer_id = _customer(client, admin_token, "Steuerbox Kunde")
    return _create_panel(client, admin_token, customer_id, document=document)


def _print(client: TestClient, admin_token: str, panel: dict, **body) -> object:
    return client.post(f"/api/schaltplan/panels/{panel['id']}/labels", headers=_auth(admin_token), json=body)


def _at_texts(job: bytes) -> list[bytes]:
    return [line.split(b",", 9)[-1] for line in job.split(b"\r\n") if line.startswith(b"AT,")]


# ── The block strip on the Klemmen print ───────────────────────────────────


def test_the_block_strip_is_the_last_item_of_the_reihenklemmen_print(client: TestClient, admin_token: str, monkeypatch):
    _configure_label_printer(client, admin_token)
    sent = _capture_label_jobs(monkeypatch)
    panel = _panel(client, admin_token, _with_block(_two_rcd_board(), default_control_block()))

    resp = _print(client, admin_token, panel, target="reihenklemmen")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [(s["row_id"], s["row_label"], s["length_mm"], s["part_count"]) for s in body["strips"]] == [
        ("f1:leiste", "X1 · FI F1 · Reihe 1", 17.2, 3),
        ("f2:leiste", "X2 · FI F2 · Reihe 1", 17.2, 3),
        ("control:block", "§14a-Klemmleiste", 31.2, 6),
    ]
    assert body["printed"] == 4 + 6
    assert body["font_size_dots"] == 35  # the Leiste size, as before
    assert len(sent) == 1  # one connection
    jobs = _jobs(sent[0])
    assert len(jobs) == 3
    block = jobs[-1]
    assert _at_texts(block) == [b"UNSM", b"60%", b"30%", b"0%", b"UStve", b"Stve"]
    assert all(b",35,35,0,0E,0,0," in line for line in block.split(b"\r\n") if line.startswith(b"AT,"))
    assert b"^W11" in block


def test_an_explicit_selection_can_print_the_block_alone(client: TestClient, admin_token: str, monkeypatch):
    _configure_label_printer(client, admin_token)
    sent = _capture_label_jobs(monkeypatch)
    panel = _panel(client, admin_token, _with_block(_two_rcd_board(), default_control_block()))
    resp = _print(client, admin_token, panel, target="reihenklemmen", strip_ids=["control:block"])
    assert resp.status_code == 200, resp.text
    assert [s["row_id"] for s in resp.json()["strips"]] == ["control:block"]
    assert resp.json()["printed"] == 6
    assert len(_jobs(sent[0])) == 1
    resp = _print(client, admin_token, panel, target="reihenklemmen", strip_ids=["f1:leiste"])
    assert [s["row_id"] for s in resp.json()["strips"]] == ["f1:leiste"]


def test_a_board_with_only_the_block_prints_it(client: TestClient, admin_token: str, monkeypatch):
    _configure_label_printer(client, admin_token)
    sent = _capture_label_jobs(monkeypatch)
    panel = _panel(client, admin_token, _with_block(_no_terminals(), _block(["UNSM", "", "0%"])))
    resp = _print(client, admin_token, panel, target="reihenklemmen")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [(s["row_id"], s["length_mm"], s["part_count"]) for s in body["strips"]] == [("control:block", 15.6, 3)]
    # A blank label prints an empty segment and is counted, not hidden.
    assert (body["printed"], body["skipped_without_bmk"]) == (2, 1)
    (job,) = _jobs(sent[0])
    assert _at_texts(job) == [b"UNSM", b"0%"]
    assert job.count(b"Lo,") == 2 + 2


def test_without_terminals_and_without_a_block_the_400_stays(client: TestClient, admin_token: str, monkeypatch):
    _configure_label_printer(client, admin_token)
    sent = _capture_label_jobs(monkeypatch)
    for block in (None, _block(["UNSM"], off=True), _block([])):
        panel = _panel(client, admin_token, _with_block(_no_terminals(), block)) if block is not None else _panel(
            client, admin_token, _no_terminals()
        )
        resp = _print(client, admin_token, panel, target="reihenklemmen")
        assert resp.status_code == 400, resp.text
        assert resp.json()["detail"] == "Keine Reihenklemmen abgeleitet — erst Abgänge mit „Reihenklemme am Abgang“ markieren."
    assert sent == []


def test_a_block_selected_but_no_longer_derived_is_409(client: TestClient, admin_token: str, monkeypatch):
    _configure_label_printer(client, admin_token)
    sent = _capture_label_jobs(monkeypatch)
    for block in (None, _block(["UNSM"], off=True)):
        panel = _panel(client, admin_token, _with_block(_two_rcd_board(), block))
        resp = _print(client, admin_token, panel, target="reihenklemmen", strip_ids=["f1:leiste", "control:block"])
        assert resp.status_code == 409, resp.text
        assert resp.json()["detail"] == STALE_BLOCK
    # A Leiste id the board does not derive keeps the round-2 text.
    panel = _panel(client, admin_token, _with_block(_two_rcd_board(), default_control_block()))
    resp = _print(client, admin_token, panel, target="reihenklemmen", strip_ids=["gone:leiste", "control:block"])
    assert resp.status_code == 409 and "neu nummeriert" in resp.json()["detail"]
    assert sent == []


def test_a_label_too_long_for_the_terminal_is_never_printed(client: TestClient, admin_token: str, monkeypatch):
    _configure_label_printer(client, admin_token)
    sent = _capture_label_jobs(monkeypatch)
    panel = _panel(client, admin_token, _with_block(_two_rcd_board(), _block(["UNSM", "Steuerbox 12", "WWWWW"])))
    for strip_ids in (None, ["control:block"]):
        resp = _print(client, admin_token, panel, target="reihenklemmen", strip_ids=strip_ids)
        assert resp.status_code == 400, resp.text
        assert resp.json()["detail"] == "„Steuerbox 12“ ist zu lang für die Klemme — in der §14a-Klemmleiste kürzen."
    assert sent == []
    # The Leisten still print when the block is not selected.
    resp = _print(client, admin_token, panel, target="reihenklemmen", strip_ids=["f1:leiste", "f2:leiste"])
    assert resp.status_code == 200, resp.text


# ── Aderbeschriftung ───────────────────────────────────────────────────────


def test_adern_prints_every_label_twice_on_the_boards_tube(client: TestClient, admin_token: str, monkeypatch):
    _configure_label_printer(client, admin_token)
    sent = _capture_label_jobs(monkeypatch)
    panel = _panel(client, admin_token, _with_block(_no_terminals(), default_control_block()))
    # strip_ids and material_id are ignored: the block names its tube.
    resp = _print(client, admin_token, panel, target="adern", strip_ids=["control:wires"], material_id="wago-2009-110")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["material"], body["printed"], body["skipped_without_bmk"], body["font_size_dots"]) == ("wago-211-502", 12, 0, 48)
    assert body["strips"] == [
        {"row_id": "control:wires", "row_label": "Aderbeschriftung", "length_mm": 180.0, "part_count": 12}
    ]
    (job,) = _jobs(sent[0])
    labels = [b"UNSM", b"60%", b"30%", b"0%", b"UStve", b"Stve"]
    assert _at_texts(job) == [label for label in labels for _ in (0, 1)]
    assert b"^W8" in job and b"^C1" in job and b"^C2" not in job
    assert job.count(b"Lo,") == 2 + 11


def test_adern_follows_the_tube_and_skips_blank_terminals(client: TestClient, admin_token: str, monkeypatch):
    _configure_label_printer(client, admin_token)
    sent = _capture_label_jobs(monkeypatch)
    block = _block(["UNSM", "", "0%"], label_material="wago-211-501", wire_mm2=1.5)
    panel = _panel(client, admin_token, _with_block(_two_rcd_board(), block))
    resp = _print(client, admin_token, panel, target="adern")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["material"], body["printed"], body["skipped_without_bmk"], body["font_size_dots"]) == ("wago-211-501", 4, 1, 42)
    assert body["strips"][0]["length_mm"] == 60.0
    (job,) = _jobs(sent[0])
    assert b"^W5" in job
    assert _at_texts(job) == [b"UNSM", b"UNSM", b"0%", b"0%"]


def test_adern_without_named_terminals_is_400(client: TestClient, admin_token: str, monkeypatch):
    _configure_label_printer(client, admin_token)
    sent = _capture_label_jobs(monkeypatch)
    for document in (
        _two_rcd_board(),
        _with_block(_two_rcd_board(), None),
        _with_block(_two_rcd_board(), _block(["", ""])),
        _with_block(_two_rcd_board(), _block(["UNSM"], off=True)),
    ):
        resp = _print(client, admin_token, _panel(client, admin_token, document), target="adern")
        assert resp.status_code == 400, resp.text
        assert resp.json()["detail"] == "Keine Aderbeschriftung — erst Klemmen benennen."
    assert sent == []


def test_an_unknown_target_is_refused_by_the_schema(client: TestClient, admin_token: str):
    panel = _panel(client, admin_token, _with_block(_no_terminals(), default_control_block()))
    assert _print(client, admin_token, panel, target="schlauch").status_code == 422


def test_the_print_route_lives_in_the_labels_router():
    """Moved out of workflow_schaltplan (R4 §9); same path, one registration."""
    from fastapi.routing import APIRoute, _iter_routes_with_context  # FastAPI ≥ 0.140 nests included routers

    from app.main import app

    paths = [
        context.path
        for route, context in _iter_routes_with_context(app.routes)
        if isinstance(route, APIRoute) and route.endpoint is workflow_schaltplan_labels.print_panel_labels
    ]
    assert paths == ["/api/schaltplan/panels/{plan_id}/labels"]
