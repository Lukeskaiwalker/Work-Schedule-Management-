"""Verteiler numbers, the Materialliste and the Regal's picking flow.

What must hold: a board gets the next ``VT-`` number when it is planned and
a copy gets its own; the planned lines fall out of the document (device
types in catalog order, then the WAGO terminal parts) and never out of a
store; a WAGO part finds its shelf article by the catalog's naming, anything
else through the global mapping; a scan at the station books one
``consumption`` row against the board (with its station, project and note),
the list comes back with the server's sums, an unknown code is refused, a
short shelf is warned about but not refused; ABBRUCH is the inverse row and
is bounded; forgetting a mapping re-sorts what was scanned under an extra
line without touching a booking; the project's Material tab lists what the
Werkstatt built in; the recent list is newest-edit-first; the overview puts
boards somebody scanned for first.
"""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.models.entities import WerkstattArticle, WerkstattMovement
from app.services import schaltplan_material as material
from app.services.schaltplan_panel_numbers import normalize_panel_code
from tests.test_schaltplan import _auth, _create_panel, _customer, _device, _document, _project
from tests.test_station_werkstatt import _pair

STATION = "/api/station/werkstatt"


# ── Helpers ───────────────────────────────────────────────────────────────────


def _article(client: TestClient, token: str, name: str, *, manufacturer: str | None = None, stock: int = 0) -> dict:
    payload: dict = {"item_name": name, "unit": "Stk"}
    if manufacturer:
        payload["manufacturer"] = manufacturer
    created = client.post("/api/werkstatt/articles", headers=_auth(token), json=payload)
    assert created.status_code == 200, created.text
    article = created.json()
    if stock:
        from app.models.entities import User
        from app.services.werkstatt_movements import apply_movement

        with SessionLocal() as db:
            row = db.get(WerkstattArticle, article["id"])
            admin = db.scalars(select(User).where(User.email == "admin@example.com")).first()
            apply_movement(db, article=row, movement_type="intake", quantity=stock, user_id=admin.id)
            db.commit()
    return article


def _board_document() -> dict:
    """An FI with two B16 and one B10 behind it, two of them on Reihenklemmen."""
    return _document(
        [
            _device("f1", "rcd", te=4, poles=4, rating="40 A"),
            _device("f1.1", "mcb", rating="B16", terminal_block=True),
            _device("f1.2", "mcb", rating="B16", terminal_block=True),
            _device("f1.3", "mcb", rating="B10"),
        ]
    )


def _board(client: TestClient, token: str, customer_id: int, project_id: int | None = None, **overrides) -> dict:
    payload = {"document": _board_document()}
    if project_id is not None:
        payload["project_id"] = project_id
    payload.update(overrides)
    return _create_panel(client, token, customer_id, **payload)


def _lines(client: TestClient, token: str, panel_id: int) -> dict:
    resp = client.get(f"/api/schaltplan/panels/{panel_id}/material", headers=_auth(token))
    assert resp.status_code == 200, resp.text
    return resp.json()


def _line(body: dict, key: str) -> dict:
    return next(line for line in body["lines"] if line["key"] == key)


# ── Numbers ───────────────────────────────────────────────────────────────────


def test_a_board_gets_the_next_number_and_a_copy_its_own(client: TestClient, admin_token: str) -> None:
    customer = _customer(client, admin_token)
    first = _create_panel(client, admin_token, customer)
    second = _create_panel(client, admin_token, customer, designation="UV2")
    assert (first["panel_number"], second["panel_number"]) == ("VT-0001", "VT-0002")

    copy = client.post(f"/api/schaltplan/panels/{first['id']}/duplicate", headers=_auth(admin_token))
    assert copy.status_code == 200, copy.text
    assert copy.json()["panel_number"] == "VT-0003"

    # A deleted board's number stays a gap; nobody inherits it. (The number
    # is the row id — PostgreSQL never reuses one. SQLite would hand the
    # highest id out again, so the test deletes a board in the middle.)
    assert client.delete(f"/api/schaltplan/panels/{second['id']}", headers=_auth(admin_token)).status_code == 204
    fourth = _create_panel(client, admin_token, customer, designation="UV4")
    assert fourth["panel_number"] == "VT-0004"

    listed = client.get("/api/schaltplan/panels", params={"customer_id": customer}, headers=_auth(admin_token))
    assert {row["panel_number"] for row in listed.json()} == {"VT-0001", "VT-0003", "VT-0004"}


def test_scanned_codes_normalise_to_the_printed_number() -> None:
    assert normalize_panel_code(" vt-7 ") == "VT-0007"
    assert normalize_panel_code("VT0007") == "VT-0007"
    assert normalize_panel_code("VT-00123") == "VT-0123"
    assert normalize_panel_code("SP-0007") == "SP-0007"


# ── Planned side ──────────────────────────────────────────────────────────────


def test_planned_lines_come_from_the_document_in_catalog_then_part_order() -> None:
    lines = material.planned_lines(_board_document())
    assert [(line.key, line.planned) for line in lines] == [
        ("device:rcd:4p:40a", 1),
        ("device:mcb:1p:b10", 1),
        ("device:mcb:1p:b16", 2),
        ("part:2003-7641", 2),
        ("part:2009-305", 1),
        ("part:2016-7714", 1),
    ]
    rcd, b16, etage = lines[0], lines[2], lines[3]
    assert (rcd.kind, rcd.label, rcd.detail) == ("device", "FI-Schutzschalter (RCD) 40 A", "4-polig · 4 TE")
    assert (b16.label, b16.detail) == ("Leitungsschutzschalter (LS) B16", "1-polig · 1 TE")
    assert (etage.kind, etage.label) == ("terminal", "WAGO 2003-7641")


def test_a_wago_part_finds_its_shelf_article_by_name_and_the_rest_waits_for_a_mapping(
    client: TestClient, admin_token: str
) -> None:
    etage = _article(client, admin_token, "WAGO 2003-7641 - TOPJOB S IEK NT/L/PE 2,5/4QMM", manufacturer="WAGO")
    # An archived twin never matches, and a mere mention inside a name is not a head.
    decoy = _article(client, admin_token, "Beschriftung für 2003-7641 Klemmen")
    customer = _customer(client, admin_token)
    board = _board(client, admin_token, customer)

    body = _lines(client, admin_token, board["id"])
    assert body["panel"]["panel_number"] == board["panel_number"]
    part = _line(body, "part:2003-7641")
    assert part["article"]["id"] == etage["id"] and part["article_source"] == "auto"
    assert part["article"]["article_number"] == etage["article_number"]
    assert part["status"] == "open" and part["scanned"] == 0
    assert _line(body, "device:mcb:1p:b16")["article"] is None
    assert _line(body, "part:2016-7714")["article"] is None
    assert decoy["id"] not in {line["article"]["id"] for line in body["lines"] if line["article"]}
    assert (body["planned_total"], body["scanned_total"], body["open_lines"]) == (8, 0, 6)


def test_a_mapping_is_global_and_a_bad_key_is_refused(client: TestClient, admin_token: str) -> None:
    mcb = _article(client, admin_token, "HAGER MBS116 - Sicherungsautomat 1P B-16A")
    customer = _customer(client, admin_token)
    first = _board(client, admin_token, customer)
    second = _board(client, admin_token, customer, designation="UV2")

    mapped = client.put(
        "/api/schaltplan/material/mapping",
        headers=_auth(admin_token),
        json={"key": "device:mcb:1p:b16", "article_id": mcb["id"]},
    )
    assert mapped.status_code == 200, mapped.text
    assert mapped.json()["article"]["id"] == mcb["id"]
    for board in (first, second):
        line = _line(_lines(client, admin_token, board["id"]), "device:mcb:1p:b16")
        assert line["article"]["id"] == mcb["id"] and line["article_source"] == "mapping"

    forgotten = client.put(
        "/api/schaltplan/material/mapping", headers=_auth(admin_token), json={"key": "device:mcb:1p:b16", "article_id": None}
    )
    assert forgotten.status_code == 200 and forgotten.json()["article"] is None
    assert _line(_lines(client, admin_token, first["id"]), "device:mcb:1p:b16")["article"] is None

    bad = client.put(
        "/api/schaltplan/material/mapping", headers=_auth(admin_token), json={"key": "article:5", "article_id": mcb["id"]}
    )
    assert bad.status_code == 400


# ── Bookings from the browser ─────────────────────────────────────────────────


def test_booking_by_hand_moves_stock_and_the_line_and_undo_is_bounded(client: TestClient, admin_token: str) -> None:
    etage = _article(client, admin_token, "WAGO 2003-7641 - TOPJOB S IEK", manufacturer="WAGO", stock=10)
    customer = _customer(client, admin_token)
    project = _project(client, admin_token, customer)
    board = _board(client, admin_token, customer, project)
    head = _auth(admin_token)

    booked = client.post(f"/api/schaltplan/panels/{board['id']}/material/book", headers=head, json={"article_id": etage["id"], "quantity": 2})
    assert booked.status_code == 200, booked.text
    line = _line(booked.json(), "part:2003-7641")
    assert (line["scanned"], line["planned"], line["status"]) == (2, 2, "done")
    assert line["last_scanned_at"] is not None
    assert booked.json()["scanned_total"] == 2 and booked.json()["last_scanned_at"] == line["last_scanned_at"]

    over = client.post(f"/api/schaltplan/panels/{board['id']}/material/book", headers=head, json={"article_id": etage["id"], "quantity": 1})
    assert _line(over.json(), "part:2003-7641")["status"] == "over"

    with SessionLocal() as db:
        row = db.get(WerkstattArticle, etage["id"])
        assert (row.stock_total, row.stock_available) == (7, 7)
        movements = db.scalars(select(WerkstattMovement).where(WerkstattMovement.panel_id == board["id"])).all()
        assert [(m.movement_type, m.quantity, m.project_id, m.notes) for m in movements] == [
            ("consumption", 2, project, f"Verteiler {board['panel_number']}"),
            ("consumption", 1, project, f"Verteiler {board['panel_number']}"),
        ]

    undone = client.post(f"/api/schaltplan/panels/{board['id']}/material/unbook", headers=head, json={"article_id": etage["id"], "quantity": 1})
    assert undone.status_code == 200, undone.text
    assert _line(undone.json(), "part:2003-7641")["status"] == "done"
    too_much = client.post(f"/api/schaltplan/panels/{board['id']}/material/unbook", headers=head, json={"article_id": etage["id"], "quantity": 5})
    assert too_much.status_code == 400 and "Zurücknehmen" in too_much.json()["detail"]
    with SessionLocal() as db:
        row = db.get(WerkstattArticle, etage["id"])
        assert (row.stock_total, row.stock_available) == (8, 8)


def test_an_article_nobody_planned_shows_as_an_extra_line(client: TestClient, admin_token: str) -> None:
    tape = _article(client, admin_token, "Isolierband schwarz", stock=3)
    customer = _customer(client, admin_token)
    board = _board(client, admin_token, customer)
    booked = client.post(
        f"/api/schaltplan/panels/{board['id']}/material/book", headers=_auth(admin_token), json={"article_id": tape["id"], "quantity": 1}
    )
    assert booked.status_code == 200, booked.text
    extra = booked.json()["lines"][-1]
    assert (extra["key"], extra["kind"], extra["status"], extra["planned"], extra["scanned"]) == (
        f"article:{tape['id']}", "extra", "unplanned", 0, 1
    )
    assert extra["detail"] == "nicht geplant" and extra["article"]["id"] == tape["id"]
    assert booked.json()["open_lines"] == 6  # the extra is not "open"


# ── The Regal station ─────────────────────────────────────────────────────────


def test_the_station_opens_a_board_by_its_number_and_books_scans_against_it(client: TestClient, admin_token: str) -> None:
    token, station = _pair(client, admin_token, name="Werkstatt")
    etage = _article(client, admin_token, "WAGO 2003-7641 - TOPJOB S IEK", manufacturer="WAGO", stock=5)
    customer = _customer(client, admin_token, name="Schulze")
    project = _project(client, admin_token, customer, number="381")
    board = _board(client, admin_token, customer, project)
    head = {"Authorization": f"Bearer {token}"}

    opened = client.get(f"{STATION}/panels/vt-1", headers=head)
    assert opened.status_code == 200, opened.text
    assert opened.json()["panel"] == {
        **opened.json()["panel"],
        "panel_number": "VT-0001", "customer_name": "Schulze", "project_number": "381", "designation": "UV1",
    }
    assert client.get(f"{STATION}/panels/VT-0099", headers=head).status_code == 404
    assert "VT-0099" in client.get(f"{STATION}/panels/VT-0099", headers=head).json()["detail"]
    assert client.get(f"{STATION}/panels/VT-0001", headers=_auth(admin_token)).status_code == 401

    scanned = client.post(
        f"{STATION}/panels/{board['id']}/scan", headers=head, json={"code": etage["article_number"], "quantity": 1}
    )
    assert scanned.status_code == 200, scanned.text
    body = scanned.json()
    assert body["line"]["key"] == "part:2003-7641" and (body["line"]["scanned"], body["line"]["status"]) == (1, "open")
    assert body["article"]["id"] == etage["id"] and body["article"]["stock_available"] == 4
    assert body["stock_warning"] is None
    assert body["material"]["scanned_total"] == 1

    with SessionLocal() as db:
        row = db.get(WerkstattMovement, body["movement_id"])
        assert (row.movement_type, row.quantity, row.panel_id, row.project_id, row.station_id) == (
            "consumption", 1, board["id"], project, station["id"]
        )
        assert row.notes == f"Regal-Station Werkstatt — Verteiler {board['panel_number']}"

    unknown = client.post(f"{STATION}/panels/{board['id']}/scan", headers=head, json={"code": "4006381333931"})
    assert unknown.status_code == 400 and "Kein Lagerartikel" in unknown.json()["detail"]
    assert client.post(f"{STATION}/panels/{board['id']}/scan", headers=head, json={"quantity": 1}).status_code == 400
    assert client.post(f"{STATION}/panels/9999/scan", headers=head, json={"article_id": etage["id"]}).status_code == 404

    # The desktop list agrees with the station's.
    assert _line(_lines(client, admin_token, board["id"]), "part:2003-7641")["scanned"] == 1


def test_a_short_shelf_is_warned_about_not_refused_and_undo_is_the_inverse_row(client: TestClient, admin_token: str) -> None:
    token, station = _pair(client, admin_token, name="Werkstatt")
    etage = _article(client, admin_token, "WAGO 2003-7641 - TOPJOB S IEK", manufacturer="WAGO", stock=1)
    customer = _customer(client, admin_token)
    board = _board(client, admin_token, customer)
    head = {"Authorization": f"Bearer {token}"}

    scanned = client.post(f"{STATION}/panels/{board['id']}/scan", headers=head, json={"article_id": etage["id"], "quantity": 2})
    assert scanned.status_code == 200, scanned.text
    assert scanned.json()["stock_warning"] == "Bestand war 1 — Inventur prüfen."
    assert scanned.json()["line"]["scanned"] == 2 and scanned.json()["article"]["stock_available"] == 0

    undone = client.post(f"{STATION}/panels/{board['id']}/undo", headers=head, json={"article_id": etage["id"], "quantity": 2})
    assert undone.status_code == 200, undone.text
    assert undone.json()["line"]["scanned"] == 0 and undone.json()["material"]["scanned_total"] == 0
    with SessionLocal() as db:
        row = db.get(WerkstattMovement, undone.json()["movement_id"])
        assert (row.movement_type, row.quantity, row.panel_id, row.station_id) == ("consumption_undo", 2, board["id"], station["id"])
        assert row.notes == f"Regal-Station Werkstatt — Storno — Verteiler {board['panel_number']}"
        article = db.get(WerkstattArticle, etage["id"])
        assert (article.stock_total, article.stock_available) == (1, 1)

    nothing = client.post(f"{STATION}/panels/{board['id']}/undo", headers=head, json={"article_id": etage["id"], "quantity": 1})
    assert nothing.status_code == 400 and "Zurücknehmen" in nothing.json()["detail"]


def test_forgetting_a_mapping_resorts_what_was_scanned_without_touching_the_ledger(client: TestClient, admin_token: str) -> None:
    token, _ = _pair(client, admin_token, name="Werkstatt")
    mcb = _article(client, admin_token, "HAGER MBS116 - Sicherungsautomat 1P B-16A", stock=4)
    customer = _customer(client, admin_token)
    board = _board(client, admin_token, customer)
    head = {"Authorization": f"Bearer {token}"}

    assert client.put(
        "/api/schaltplan/material/mapping", headers=_auth(admin_token), json={"key": "device:mcb:1p:b16", "article_id": mcb["id"]}
    ).status_code == 200
    scanned = client.post(f"{STATION}/panels/{board['id']}/scan", headers=head, json={"article_id": mcb["id"], "quantity": 2})
    assert scanned.status_code == 200, scanned.text
    assert scanned.json()["line"]["key"] == "device:mcb:1p:b16" and scanned.json()["line"]["status"] == "done"

    assert client.put(
        "/api/schaltplan/material/mapping", headers=_auth(admin_token), json={"key": "device:mcb:1p:b16", "article_id": None}
    ).status_code == 200
    body = _lines(client, admin_token, board["id"])
    assert _line(body, "device:mcb:1p:b16")["scanned"] == 0
    assert _line(body, f"article:{mcb['id']}")["scanned"] == 2
    with SessionLocal() as db:
        assert db.scalar(select(WerkstattMovement.id).where(WerkstattMovement.panel_id == board["id"]).limit(1)) is not None
        assert len(db.scalars(select(WerkstattMovement).where(WerkstattMovement.panel_id == board["id"])).all()) == 1


# ── Project tab, recents, overview ───────────────────────────────────────────


def test_the_projects_material_tab_lists_what_the_werkstatt_built_in(client: TestClient, admin_token: str) -> None:
    token, _ = _pair(client, admin_token, name="Werkstatt")
    etage = _article(client, admin_token, "WAGO 2003-7641 - TOPJOB S IEK", manufacturer="WAGO", stock=9)
    customer = _customer(client, admin_token)
    project = _project(client, admin_token, customer)
    first = _board(client, admin_token, customer, project)
    second = _board(client, admin_token, customer, project, designation="UV2")
    elsewhere = _board(client, admin_token, customer, designation="UV3")  # no project
    head = {"Authorization": f"Bearer {token}"}
    for board, qty in ((first, 2), (second, 3), (elsewhere, 1)):
        assert client.post(f"{STATION}/panels/{board['id']}/scan", headers=head, json={"article_id": etage["id"], "quantity": qty}).status_code == 200
    assert client.post(f"{STATION}/panels/{first['id']}/undo", headers=head, json={"article_id": etage["id"], "quantity": 1}).status_code == 200

    rows = client.get(f"/api/projects/{project}/materials", headers=_auth(admin_token))
    assert rows.status_code == 200, rows.text
    assert rows.json() == [
        {
            "item": "WAGO 2003-7641 - TOPJOB S IEK",
            "unit": "Stk",
            "article_no": etage["article_number"],
            "quantity_total": 4.0,
            "quantity_notes": [],
            "occurrence_count": 2,
            "report_count": 0,
            "last_report_date": rows.json()[0]["last_report_date"],
            "source": "verteiler",
            "panel_numbers": [first["panel_number"], second["panel_number"]],
        }
    ]
    assert rows.json()[0]["last_report_date"] is not None


def test_recent_panels_are_newest_edit_first(client: TestClient, admin_token: str) -> None:
    customer = _customer(client, admin_token)
    first = _create_panel(client, admin_token, customer)
    second = _create_panel(client, admin_token, customer, designation="UV2")
    third = _create_panel(client, admin_token, customer, designation="UV3")
    touched = client.patch(
        f"/api/schaltplan/panels/{first['id']}", headers=_auth(admin_token), json={"document": _board_document()}
    )
    assert touched.status_code == 200, touched.text

    recent = client.get("/api/schaltplan/panels/recent", params={"limit": 2}, headers=_auth(admin_token))
    assert recent.status_code == 200, recent.text
    assert [row["id"] for row in recent.json()] == [first["id"], third["id"]]
    assert recent.json()[0]["panel_number"] == first["panel_number"]
    assert client.get("/api/schaltplan/panels/recent", params={"limit": 0}, headers=_auth(admin_token)).status_code == 422
    assert second["id"] in {row["id"] for row in client.get("/api/schaltplan/panels/recent", headers=_auth(admin_token)).json()}


def test_the_overview_puts_boards_somebody_scanned_for_first(client: TestClient, admin_token: str) -> None:
    etage = _article(client, admin_token, "WAGO 2003-7641 - TOPJOB S IEK", manufacturer="WAGO", stock=9)
    customer = _customer(client, admin_token)
    untouched = _board(client, admin_token, customer)
    picked = _board(client, admin_token, customer, designation="UV2")
    assert client.post(
        f"/api/schaltplan/panels/{picked['id']}/material/book", headers=_auth(admin_token), json={"article_id": etage["id"], "quantity": 1}
    ).status_code == 200

    overview = client.get("/api/schaltplan/material/overview", headers=_auth(admin_token))
    assert overview.status_code == 200, overview.text
    rows = overview.json()
    assert [row["panel"]["id"] for row in rows] == [picked["id"], untouched["id"]]
    assert (rows[0]["planned_total"], rows[0]["scanned_total"], rows[0]["open_lines"]) == (8, 1, 6)
    assert rows[0]["last_scanned_at"] is not None and rows[1]["last_scanned_at"] is None
    assert rows[1]["panel"]["panel_number"] == untouched["panel_number"]
