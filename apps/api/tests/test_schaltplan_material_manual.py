"""Material added to a Verteiler by hand, and the list as a PDF (owner,
2026-10-09: "I should be able to add material to a panel manually as well in
the list and export that list as a PDF").

What must hold:

* a manual line is a shelf article or a free text, with a quantity and an
  optional note; it joins the derived lines (``manual:<id>``) and their
  totals, and a booked article ticks it off like any planned line;
* it can be changed and removed, only on its own board, and only with
  ``reports:create`` — the same bar as booking;
* nonsense is refused: no article and no text, a quantity under one, an
  archived or unknown article;
* removing the board removes its manual lines;
* ``GET …/material/pdf`` is the whole list as an A4 PDF: board number and
  name, every line with planned and booked quantities, manual lines marked.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.core.db import SessionLocal
from app.models.schaltplan import PanelMaterialManualLine
from tests.test_schaltplan import _auth, _create_panel, _customer, _pdf_text
from tests.test_schaltplan_material import _article, _board

PASSWORD = "Password123!"


def _url(panel_id: int, suffix: str = "") -> str:
    return f"/api/schaltplan/panels/{panel_id}/material/manual{suffix}"


def _add(client: TestClient, token: str, panel_id: int, **payload) -> dict:
    resp = client.post(_url(panel_id), headers=_auth(token), json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _manual(material: dict) -> list[dict]:
    return [line for line in material["lines"] if line["kind"] == "manual"]


def _login_as(client: TestClient, admin_token: str, role: str, email: str) -> str:
    created = client.post(
        "/api/admin/users",
        headers=_auth(admin_token),
        json={"email": email, "password": PASSWORD, "full_name": f"{role} user", "role": role},
    )
    assert created.status_code == 200, created.text
    login = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    return login.headers["X-Access-Token"]


def test_an_article_and_a_free_text_join_the_list_with_their_totals(client: TestClient, admin_token: str):
    panel = _board(client, admin_token, _customer(client, admin_token))
    before = client.get(f"/api/schaltplan/panels/{panel['id']}/material", headers=_auth(admin_token)).json()
    duct = _article(client, admin_token, "Verdrahtungskanal 40x60 grau")

    with_article = _add(client, admin_token, panel["id"], article_id=duct["id"], quantity=2, note="für Reihe 2")
    [line] = _manual(with_article)
    assert line["key"].startswith("manual:") and line["manual_id"] > 0
    assert (line["label"], line["planned"], line["detail"]) == ("Verdrahtungskanal 40x60 grau", 2, "für Reihe 2")
    assert line["article"]["id"] == duct["id"] and line["article_source"] == "manual"
    assert line["status"] == "open"
    assert with_article["planned_total"] == before["planned_total"] + 2

    free = _add(client, admin_token, panel["id"], label="Aderendhülsen 1,5 mm² (Beutel)", quantity=1)
    lines = _manual(free)
    assert [entry["label"] for entry in lines] == ["Verdrahtungskanal 40x60 grau", "Aderendhülsen 1,5 mm² (Beutel)"]
    assert lines[1]["article"] is None and lines[1]["detail"] == "manuell"
    # Derived lines first, then the manual ones in the order they were added.
    assert [entry["kind"] for entry in free["lines"]][-2:] == ["manual", "manual"]


def test_a_booked_article_ticks_its_manual_line_off(client: TestClient, admin_token: str):
    panel = _board(client, admin_token, _customer(client, admin_token))
    rail = _article(client, admin_token, "Hutschiene 35 mm, 1 m", stock=5)
    _add(client, admin_token, panel["id"], article_id=rail["id"], quantity=2)
    booked = client.post(
        f"/api/schaltplan/panels/{panel['id']}/material/book",
        headers=_auth(admin_token),
        json={"article_id": rail["id"], "quantity": 2},
    )
    assert booked.status_code == 200, booked.text
    [line] = _manual(booked.json())
    assert (line["scanned"], line["status"]) == (2, "done")
    assert not [entry for entry in booked.json()["lines"] if entry["kind"] == "extra"]


def test_a_manual_line_is_changed_and_removed_only_on_its_board(client: TestClient, admin_token: str):
    customer_id = _customer(client, admin_token)
    panel = _board(client, admin_token, customer_id)
    other = _board(client, admin_token, customer_id, designation="UV2")
    line = _manual(_add(client, admin_token, panel["id"], label="Kabelbinder", quantity=10))[0]

    changed = client.patch(_url(panel["id"], f"/{line['manual_id']}"), headers=_auth(admin_token), json={"quantity": 25, "note": "schwarz"})
    assert changed.status_code == 200, changed.text
    [after] = _manual(changed.json())
    assert (after["planned"], after["detail"]) == (25, "schwarz")

    assert client.patch(_url(other["id"], f"/{line['manual_id']}"), headers=_auth(admin_token), json={"quantity": 1}).status_code == 404
    assert client.delete(_url(other["id"], f"/{line['manual_id']}"), headers=_auth(admin_token)).status_code == 404

    removed = client.delete(_url(panel["id"], f"/{line['manual_id']}"), headers=_auth(admin_token))
    assert removed.status_code == 200, removed.text
    assert _manual(removed.json()) == []


def test_nonsense_is_refused(client: TestClient, admin_token: str):
    panel = _board(client, admin_token, _customer(client, admin_token))
    assert client.post(_url(panel["id"]), headers=_auth(admin_token), json={"quantity": 1}).status_code == 422
    assert client.post(_url(panel["id"]), headers=_auth(admin_token), json={"label": "  ", "quantity": 1}).status_code == 422
    assert client.post(_url(panel["id"]), headers=_auth(admin_token), json={"label": "X", "quantity": 0}).status_code == 422
    assert client.post(_url(panel["id"]), headers=_auth(admin_token), json={"article_id": 999999, "quantity": 1}).status_code == 404
    old = _article(client, admin_token, "Alter Artikel")
    archived = client.delete(f"/api/werkstatt/articles/{old['id']}", headers=_auth(admin_token))
    assert archived.status_code == 200, archived.text
    assert client.post(_url(panel["id"]), headers=_auth(admin_token), json={"article_id": old["id"], "quantity": 1}).status_code == 400


def test_only_people_who_may_book_may_add(client: TestClient, admin_token: str):
    panel = _board(client, admin_token, _customer(client, admin_token))
    accountant = _login_as(client, admin_token, "accountant", "buchhaltung@example.com")
    assert client.post(_url(panel["id"]), headers=_auth(accountant), json={"label": "X", "quantity": 1}).status_code == 403
    employee = _login_as(client, admin_token, "employee", "monteur@example.com")
    assert client.post(_url(panel["id"]), headers=_auth(employee), json={"label": "X", "quantity": 1}).status_code == 200


def test_removing_the_board_removes_its_manual_lines(client: TestClient, admin_token: str):
    panel = _board(client, admin_token, _customer(client, admin_token))
    _add(client, admin_token, panel["id"], label="Kabelbinder", quantity=10)
    assert client.delete(f"/api/schaltplan/panels/{panel['id']}", headers=_auth(admin_token)).status_code in (200, 204)
    with SessionLocal() as db:
        assert db.query(PanelMaterialManualLine).filter_by(panel_id=panel["id"]).count() == 0


def test_the_list_exports_as_a_pdf(client: TestClient, admin_token: str):
    panel = _board(client, admin_token, _customer(client, admin_token))
    _add(client, admin_token, panel["id"], label="Kabelbinder schwarz", quantity=10)
    resp = client.get(f"/api/schaltplan/panels/{panel['id']}/material/pdf", headers=_auth(admin_token))
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "application/pdf"
    assert resp.content.startswith(b"%PDF")
    assert f"{panel['panel_number']}" in resp.headers.get("content-disposition", "")
    text = _pdf_text(resp.content)
    assert b"Materialliste" in text
    assert panel["panel_number"].encode() in text
    assert b"Kabelbinder schwarz" in text and b"manuell" in text
    # The derived lines are there too; reportlab escapes the brackets.
    assert rb"Leitungsschutzschalter \(LS\) B16" in text


def test_a_manual_line_carries_its_note_apart_from_the_detail(client: TestClient, admin_token: str):
    """The editor prefills the note; ``detail`` says "manuell" when there is none."""
    panel = _board(client, admin_token, _customer(client, admin_token))
    with_note = _manual(_add(client, admin_token, panel["id"], label="Kabelbinder", quantity=10, note="schwarz"))[0]
    assert (with_note["note"], with_note["detail"]) == ("schwarz", "schwarz")
    without = _manual(_add(client, admin_token, panel["id"], label="Aderendhülsen", quantity=1))[1]
    assert (without["note"], without["detail"]) == (None, "manuell")
    cleared = client.patch(_url(panel["id"], f"/{with_note['manual_id']}"), headers=_auth(admin_token), json={"note": ""})
    assert _manual(cleared.json())[0]["note"] is None


def test_scans_of_one_article_fill_its_lines_in_order(client: TestClient, admin_token: str):
    """Two planned LS B16 and one more added by hand, all the same shelf
    article: scans fill the planned line first, then the added one, and only
    a surplus shows as "zu viel" — on the last line that names the article."""
    panel = _board(client, admin_token, _customer(client, admin_token))
    breaker = _article(client, admin_token, "LS B16 1-polig", stock=10)
    mapped = client.put(
        "/api/schaltplan/material/mapping",
        headers=_auth(admin_token),
        json={"key": "device:mcb:1p:b16", "article_id": breaker["id"]},
    )
    assert mapped.status_code == 200, mapped.text
    _add(client, admin_token, panel["id"], article_id=breaker["id"], quantity=1, note="Reserve")

    def book(quantity: int) -> tuple[dict, dict]:
        resp = client.post(
            f"/api/schaltplan/panels/{panel['id']}/material/book",
            headers=_auth(admin_token),
            json={"article_id": breaker["id"], "quantity": quantity},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        planned = next(line for line in body["lines"] if line["key"] == "device:mcb:1p:b16")
        return planned, _manual(body)[0]

    planned, added = book(2)
    assert (planned["scanned"], planned["status"], added["scanned"], added["status"]) == (2, "done", 0, "open")
    assert added["last_scanned_at"] is None
    planned, added = book(1)
    assert (planned["scanned"], planned["status"], added["scanned"], added["status"]) == (2, "done", 1, "done")
    assert added["last_scanned_at"] is not None
    planned, added = book(1)
    assert (planned["status"], added["scanned"], added["status"]) == ("done", 2, "over")


def test_a_copied_board_keeps_its_manual_lines(client: TestClient, admin_token: str):
    panel = _board(client, admin_token, _customer(client, admin_token))
    _add(client, admin_token, panel["id"], label="Kabelbinder", quantity=10, note="schwarz")
    copy = client.post(f"/api/schaltplan/panels/{panel['id']}/duplicate", headers=_auth(admin_token))
    assert copy.status_code == 200, copy.text
    lines = _manual(client.get(f"/api/schaltplan/panels/{copy.json()['id']}/material", headers=_auth(admin_token)).json())
    assert [(line["label"], line["planned"], line["note"]) for line in lines] == [("Kabelbinder", 10, "schwarz")]
    # Its own rows, not the original's: removing one leaves the other alone.
    client.delete(_url(copy.json()["id"], f"/{lines[0]['manual_id']}"), headers=_auth(admin_token))
    assert len(_manual(client.get(f"/api/schaltplan/panels/{panel['id']}/material", headers=_auth(admin_token)).json())) == 1


def test_a_board_takes_a_bounded_number_of_manual_lines(client: TestClient, admin_token: str, monkeypatch):
    from app.routers import workflow_schaltplan_material

    monkeypatch.setattr(workflow_schaltplan_material, "MAX_MANUAL_LINES", 2)
    panel = _board(client, admin_token, _customer(client, admin_token))
    _add(client, admin_token, panel["id"], label="Eins", quantity=1)
    _add(client, admin_token, panel["id"], label="Zwei", quantity=1)
    refused = client.post(_url(panel["id"]), headers=_auth(admin_token), json={"label": "Drei", "quantity": 1})
    assert refused.status_code == 400
    assert "Höchstens 2" in refused.json()["detail"]


def test_the_station_names_the_line_a_scan_landed_on(client: TestClient, admin_token: str):
    """Two planned LS B16 and one more by hand, one shelf article: the Regal's
    flash ("3 / 8 · label") and row highlight come from ``line`` — it must
    follow the scan onto the hand-added line once the planned one is full,
    show the surplus where it sits, and name the line an undo took from."""
    from tests.test_schaltplan_material import STATION
    from tests.test_station_werkstatt import _pair

    token, _ = _pair(client, admin_token, name="Werkstatt")
    head = {"Authorization": f"Bearer {token}"}
    panel = _board(client, admin_token, _customer(client, admin_token))
    breaker = _article(client, admin_token, "LS B16 1-polig", stock=10)
    assert client.put(
        "/api/schaltplan/material/mapping",
        headers=_auth(admin_token),
        json={"key": "device:mcb:1p:b16", "article_id": breaker["id"]},
    ).status_code == 200
    spare = _manual(_add(client, admin_token, panel["id"], article_id=breaker["id"], quantity=1, note="Reserve"))[0]

    def station(action: str) -> tuple[str, int, str]:
        resp = client.post(
            f"{STATION}/panels/{panel['id']}/{action}", headers=head, json={"article_id": breaker["id"], "quantity": 1}
        )
        assert resp.status_code == 200, resp.text
        line = resp.json()["line"]
        return line["key"], line["scanned"], line["status"]

    planned = "device:mcb:1p:b16"
    assert station("scan") == (planned, 1, "open")
    assert station("scan") == (planned, 2, "done")
    assert station("scan") == (spare["key"], 1, "done")
    assert station("scan") == (spare["key"], 2, "over")
    assert station("undo") == (spare["key"], 1, "done")
    assert station("undo") == (spare["key"], 0, "open")
    assert station("undo") == (planned, 1, "open")


def test_a_merged_article_takes_its_manual_lines_and_mappings_along(client: TestClient, admin_token: str):
    """Merging duplicate shelf articles moves the ledger onto the survivor.
    The lines that name the duplicate must follow — a hand-added line and the
    global mapping alike — or the survivor's scans land as "nicht geplant"
    and "+1" on the line fails on an archived article (review, 2026-10-09)."""
    panel = _board(client, admin_token, _customer(client, admin_token))
    survivor = _article(client, admin_token, "Hager MBN116 LS B16 1-polig", stock=5)
    duplicate = _article(client, admin_token, "Hager MBN116 LS B16 1polig", stock=5)
    assert client.put(
        "/api/schaltplan/material/mapping",
        headers=_auth(admin_token),
        json={"key": "device:mcb:1p:b16", "article_id": duplicate["id"]},
    ).status_code == 200
    _add(client, admin_token, panel["id"], article_id=duplicate["id"], quantity=1, note="Reserve")

    merged = client.post(
        "/api/werkstatt/articles/merge",
        headers=_auth(admin_token),
        json={"survivor_id": survivor["id"], "duplicate_id": duplicate["id"]},
    )
    assert merged.status_code == 200, merged.text
    assert merged.json()["panel_material_moved"] == 2

    booked = client.post(
        f"/api/schaltplan/panels/{panel['id']}/material/book",
        headers=_auth(admin_token),
        json={"article_id": survivor["id"], "quantity": 3},
    )
    assert booked.status_code == 200, booked.text
    body = booked.json()
    planned = next(line for line in body["lines"] if line["key"] == "device:mcb:1p:b16")
    [spare] = _manual(body)
    assert (planned["article"]["id"], planned["scanned"], planned["status"]) == (survivor["id"], 2, "done")
    assert (spare["article"]["id"], spare["scanned"], spare["status"]) == (survivor["id"], 1, "done")
    assert not [line for line in body["lines"] if line["kind"] == "extra"]


def test_a_free_text_line_is_listed_but_never_holds_a_board_open(client: TestClient, admin_token: str):
    """Nothing can be scanned against a free text, so it stays out of the
    picking totals — or a fully picked board would read "1 offen" forever,
    in the list, the Werkstatt overview and on the Regal screen alike."""
    panel = _board(client, admin_token, _customer(client, admin_token))
    before = client.get(f"/api/schaltplan/panels/{panel['id']}/material", headers=_auth(admin_token)).json()
    after = _add(client, admin_token, panel["id"], label="Kabelbinder", quantity=20)
    assert _manual(after)[0]["planned"] == 20
    totals = ("planned_total", "scanned_total", "open_lines")
    assert [after[key] for key in totals] == [before[key] for key in totals]
    overview = client.get("/api/schaltplan/material/overview", headers=_auth(admin_token)).json()
    [row] = [entry for entry in overview if entry["panel"]["id"] == panel["id"]]
    assert [row[key] for key in totals] == [before[key] for key in totals]
    # The PDF lists it and says why it is not counted.
    text = _pdf_text(client.get(f"/api/schaltplan/panels/{panel['id']}/material/pdf", headers=_auth(admin_token)).content)
    assert b"Kabelbinder" in text and b"nicht gez" in text
