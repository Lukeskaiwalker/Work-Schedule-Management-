"""Parts taken out of a module, booked back into stock (docs/PANEL_ENCLOSURE.md §6, §7, §15).

A return raises stock without an earlier decrement, so what must hold is the
stock's integrity: only the Werkstatt (``werkstatt:manage``) books one, only
for an article a removed line of that very board names and never past its
planned count; taking it back is bounded by the board's net and by what is
still on the shelf; machines and archived articles are refused; every row
carries user, board, project and note. A return that loses its line (the
fitting was put back) stays visible as its own line so it can be taken
back. The Regal station never offers removed lines and refuses to scan a
part only a removed line names. The project's Material tab lists returns as
a negative "Rücklauf ins Lager" line (owner, 2026-10-21).

All data is invented.
"""

from __future__ import annotations

import copy

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.models.entities import PanelPlan, User, WerkstattArticle, WerkstattMovement
from tests.panel_enclosure_helpers import (
    article,
    auth,
    cabinet_document,
    create_panel,
    customer,
    device,
    employee,
    hidden_project,
)
from tests.test_station_werkstatt import _pair

MAPPING = "/api/schaltplan/material/mapping"
STATION = "/api/station/werkstatt"
REMOVED_KEY = "removed:ZH3EH16:hs"


def _without_hs(document: dict) -> dict:
    out = copy.deepcopy(document)
    out["rows"][1]["devices"] = []
    return out


def _board_with_removed_hs(client: TestClient, token: str, *, stock: int = 0, **panel) -> tuple[dict, int]:
    """A ZB33S board whose pre-fitted HS was deleted, the line mapped to a shelf article."""
    created = create_panel(client, token, _without_hs(cabinet_document()), **panel)
    hs = article("Hauptschalter 3-polig 63 A (Testartikel)", stock=stock)
    assert client.put(MAPPING, headers=auth(token), json={"key": REMOVED_KEY, "article_id": hs}).status_code == 200
    return created, hs


def _book(client: TestClient, token: str, panel_id: int, action: str, article_id: int, quantity: int = 1):
    return client.post(
        f"/api/schaltplan/panels/{panel_id}/material/{action}",
        headers=auth(token),
        json={"article_id": article_id, "quantity": quantity},
    )


def _line(body: dict, key: str) -> dict | None:
    return next((line for line in body["lines"] if line["key"] == key), None)


def _stock(article_id: int) -> tuple[int, int]:
    with SessionLocal() as db:
        row = db.get(WerkstattArticle, article_id)
        return int(row.stock_total), int(row.stock_available)


def _ledger(panel_id: int) -> list[WerkstattMovement]:
    with SessionLocal() as db:
        rows = db.scalars(
            select(WerkstattMovement).where(WerkstattMovement.panel_id == panel_id).order_by(WerkstattMovement.id)
        ).all()
        db.expunge_all()
        return list(rows)


# ── Booking a return ─────────────────────────────────────────────────────────


def test_a_return_raises_stock_ticks_the_line_and_cannot_exceed_it(client: TestClient, admin_token: str) -> None:
    customer_id = customer(client, admin_token)
    project = client.post(
        "/api/projects", headers=auth(admin_token),
        json={"project_number": "P-T-771", "name": "Neubau Beispiel", "customer_id": customer_id},
    ).json()["id"]
    panel, hs = _board_with_removed_hs(client, admin_token, customer_id=customer_id, project_id=project)
    before = client.get(f"/api/schaltplan/panels/{panel['id']}/material", headers=auth(admin_token)).json()
    assert before["returns_open"] == 1

    booked = _book(client, admin_token, panel["id"], "salvage", hs)
    assert booked.status_code == 200, booked.text
    line = _line(booked.json(), REMOVED_KEY)
    assert (line["scanned"], line["status"]) == (1, "done")
    assert line["last_scanned_at"] is not None
    assert booked.json()["returns_open"] == 0
    assert (booked.json()["planned_total"], booked.json()["scanned_total"]) == (before["planned_total"], 0)
    assert _stock(hs) == (1, 1)

    [row] = _ledger(panel["id"])
    with SessionLocal() as db:
        admin = db.scalars(select(User.id).where(User.email == "admin@example.com")).one()
    assert (row.movement_type, row.quantity, row.article_id, row.project_id, row.user_id) == (
        "salvage", 1, hs, project, admin
    )
    assert row.notes == f"Rücklauf — Verteiler {panel['panel_number']}"

    over = _book(client, admin_token, panel["id"], "salvage", hs)
    assert over.status_code == 400
    assert over.json()["detail"] == "Mehr als aus Modulen entfernt — offen sind noch 0."
    assert _stock(hs) == (1, 1)


def test_only_an_article_on_a_removed_line_of_this_board_comes_back(client: TestClient, admin_token: str) -> None:
    panel, _ = _board_with_removed_hs(client, admin_token)
    foreign = article("Leitungsschutzschalter B16 (Testartikel)", stock=0)
    refused = _book(client, admin_token, panel["id"], "salvage", foreign)
    assert refused.status_code == 400
    assert refused.json()["detail"] == "Dieser Artikel steht nicht als „aus Modul entfernt“ auf der Liste."
    assert _book(client, admin_token, panel["id"], "salvage", 999_999).status_code == 404
    assert client.post(
        "/api/schaltplan/panels/999999/material/salvage", headers=auth(admin_token), json={"article_id": foreign}
    ).status_code == 404
    assert _ledger(panel["id"]) == []


def test_a_fitter_cannot_book_a_return_or_take_one_back(client: TestClient, admin_token: str) -> None:
    fitter = employee(client, admin_token, "monteur.ruecklauf@example.com")
    panel, hs = _board_with_removed_hs(client, admin_token)
    assert _book(client, fitter, panel["id"], "salvage", hs).status_code == 403
    assert _book(client, admin_token, panel["id"], "salvage", hs).status_code == 200
    assert _book(client, fitter, panel["id"], "unsalvage", hs).status_code == 403
    assert _stock(hs) == (1, 1)


def test_a_board_a_fitter_wrote_never_names_the_article_a_return_books(client: TestClient, admin_token: str) -> None:
    """The module snapshot is part of the board, so any fitter can write it.
    A fixed part marked removable there, or an article number put on a part
    that really came out, must not hand the Werkstatt a return of an article
    of the fitter's choosing (D11, §15): stock from nowhere."""
    fitter = employee(client, admin_token, "monteur.schnappschuss@example.com")
    pricey = article("Hager ZX-TEUER-1 Lasttrennschalter (Testartikel)", stock=0, manufacturer="Hager")
    crafted = _without_hs(cabinet_document())
    meter_field, distribution = crafted["enclosure"]["modules"]
    meter_field["fittings"][0]["article_no"] = "ZX-TEUER-1"
    distribution["fittings"] = [{"key": "pe_n", "label": "Lasttrennschalter 63 A", "article_no": "ZX-TEUER-1",
                                 "device_kind": None, "removable": True}]
    distribution["removed_fittings"] = ["pe_n"]
    panel = create_panel(client, fitter, crafted, customer_id=customer(client, admin_token))

    body = client.get(f"/api/schaltplan/panels/{panel['id']}/material", headers=auth(admin_token)).json()
    assert [line["key"] for line in body["lines"] if line["kind"] == "removed"] == [REMOVED_KEY]
    assert _line(body, REMOVED_KEY)["article"] is None  # the catalogue names no HS article yet: the Werkstatt maps it
    refused = _book(client, admin_token, panel["id"], "salvage", pricey)
    assert refused.status_code == 400
    assert refused.json()["detail"] == "Dieser Artikel steht nicht als „aus Modul entfernt“ auf der Liste."
    assert _stock(pricey) == (0, 0)


def test_machines_and_archived_articles_never_come_back_through_the_list(client: TestClient, admin_token: str) -> None:
    panel, hs = _board_with_removed_hs(client, admin_token)
    with SessionLocal() as db:
        db.get(WerkstattArticle, hs).is_serialized = True
        db.commit()
    machine = _book(client, admin_token, panel["id"], "salvage", hs)
    assert machine.status_code == 400
    assert machine.json()["detail"] == "Maschinen kommen nicht über die Materialliste ins Lager."

    with SessionLocal() as db:
        row = db.get(WerkstattArticle, hs)
        row.is_serialized = False
        row.is_archived = True
        db.commit()
    archived = _book(client, admin_token, panel["id"], "salvage", hs)
    assert archived.status_code == 400
    assert archived.json()["detail"] == "Artikel ist archiviert — keine Buchungen möglich."
    assert _book(client, admin_token, panel["id"], "unsalvage", hs).status_code == 400
    assert _ledger(panel["id"]) == []


def test_a_return_only_a_manager_who_sees_the_board_can_book(client: TestClient, admin_token: str) -> None:
    # The user first: a new user joins every existing project by default.
    token = employee(client, admin_token, "lagerleitung@example.com")
    panel, hs = _board_with_removed_hs(client, admin_token)
    with SessionLocal() as db:
        db.get(PanelPlan, panel["id"]).project_id = hidden_project()
        db.commit()
    with SessionLocal() as db:
        user_id = db.scalars(select(User.id).where(User.email == "lagerleitung@example.com")).one()
    # Granted through the permission store, as an admin grants it: every
    # request reads the stored overrides through (app.services.permission_store).
    granted = client.put(
        f"/api/admin/user-permissions/{user_id}",
        headers=auth(admin_token),
        json={"extra": ["werkstatt:manage"], "denied": []},
    )
    assert granted.status_code == 200, granted.text
    assert _book(client, token, panel["id"], "salvage", hs).status_code in (403, 404)
    assert _book(client, token, panel["id"], "unsalvage", hs).status_code in (403, 404)
    assert _ledger(panel["id"]) == []
    # The same manager on a board without a project: the grant itself works.
    with SessionLocal() as db:
        db.get(PanelPlan, panel["id"]).project_id = None
        db.commit()
    assert _book(client, token, panel["id"], "salvage", hs).status_code == 200


# ── Taking a return back ─────────────────────────────────────────────────────


def test_taking_a_return_back_is_bounded_by_the_board_and_by_the_shelf(client: TestClient, admin_token: str) -> None:
    panel, hs = _board_with_removed_hs(client, admin_token)
    nothing = _book(client, admin_token, panel["id"], "unsalvage", hs)
    assert nothing.status_code == 400
    assert nothing.json()["detail"] == (
        f"Nichts zum Zurücknehmen — für {panel['panel_number']} sind nur 0 × "
        "„Hauptschalter 3-polig 63 A (Testartikel)“ eingelagert."
    )

    assert _book(client, admin_token, panel["id"], "salvage", hs).status_code == 200
    # The returned part went straight into another board.
    other = create_panel(client, admin_token, designation="ZS9")
    assert _book(client, admin_token, other["id"], "book", hs).status_code == 200
    assert _stock(hs) == (0, 0)
    gone = _book(client, admin_token, panel["id"], "unsalvage", hs)
    assert gone.status_code == 400
    assert gone.json()["detail"] == "Schon wieder ausgegeben oder verbaut — erst den Bestand prüfen."
    assert [row.movement_type for row in _ledger(panel["id"])] == ["salvage"]


def test_a_return_whose_fitting_was_put_back_keeps_its_own_line_until_taken_back(
    client: TestClient, admin_token: str
) -> None:
    panel, hs = _board_with_removed_hs(client, admin_token)
    assert _book(client, admin_token, panel["id"], "salvage", hs).status_code == 200

    restored = client.patch(
        f"/api/schaltplan/panels/{panel['id']}", headers=auth(admin_token), json={"document": cabinet_document()}
    )
    assert restored.status_code == 200, restored.text
    body = client.get(f"/api/schaltplan/panels/{panel['id']}/material", headers=auth(admin_token)).json()
    assert _line(body, REMOVED_KEY) is None
    orphan = _line(body, f"salvage:{hs}")
    assert orphan == {
        **orphan,
        "kind": "removed", "label": "Hauptschalter 3-polig 63 A (Testartikel)",
        "detail": "eingelagert, im Plan nicht mehr als entfernt geführt",
        "planned": 0, "scanned": 1, "status": "unplanned",
    }
    assert orphan["article"]["id"] == hs
    assert body["returns_open"] == 0
    # It sits before anything unplanned and after the hand-added lines.
    assert body["lines"][-1]["key"] == f"salvage:{hs}"

    back = _book(client, admin_token, panel["id"], "unsalvage", hs)
    assert back.status_code == 200, back.text
    assert _line(back.json(), f"salvage:{hs}") is None
    assert _stock(hs) == (0, 0)
    last = _ledger(panel["id"])[-1]
    assert (last.movement_type, last.quantity) == ("salvage_undo", 1)
    assert last.notes == f"Rücklauf storniert — Verteiler {panel['panel_number']}"


# ── Overview, station, project tab ───────────────────────────────────────────


def test_the_overview_counts_open_returns_apart_from_picking(client: TestClient, admin_token: str) -> None:
    panel, hs = _board_with_removed_hs(client, admin_token)
    rows = client.get("/api/schaltplan/material/overview", headers=auth(admin_token)).json()
    [row] = [row for row in rows if row["panel"]["id"] == panel["id"]]
    # The cabinet preparation adds ZY3N1SA and K96ESA5 (docs/PANEL_ENCLOSURE_R4.md §6).
    assert (row["returns_open"], row["planned_total"], row["open_lines"]) == (1, 8, 8)
    assert _book(client, admin_token, panel["id"], "salvage", hs).status_code == 200
    rows = client.get("/api/schaltplan/material/overview", headers=auth(admin_token)).json()
    assert [row["returns_open"] for row in rows if row["panel"]["id"] == panel["id"]] == [0]


def test_the_regal_never_shows_returns_and_refuses_to_scan_one(client: TestClient, admin_token: str) -> None:
    token, _ = _pair(client, admin_token, name="Regal Test")
    head = {"Authorization": f"Bearer {token}"}
    panel, hs = _board_with_removed_hs(client, admin_token, stock=2)
    mcb = article("Leitungsschutzschalter B16 (Testartikel)", stock=4)
    assert client.put(
        MAPPING, headers=auth(admin_token), json={"key": "device:mcb:1p:b16", "article_id": mcb}
    ).status_code == 200

    opened = client.get(f"{STATION}/panels/{panel['panel_number']}", headers=head)
    assert opened.status_code == 200, opened.text
    assert all(line["kind"] != "removed" for line in opened.json()["lines"])

    refused = client.post(f"{STATION}/panels/{panel['id']}/scan", headers=head, json={"article_id": hs})
    assert refused.status_code == 409
    assert refused.json()["detail"] == "Rücklauf: in der Materialliste „Ins Lager“ buchen, nicht scannen."
    assert _ledger(panel["id"]) == [] and _stock(hs) == (2, 2)

    scanned = client.post(f"{STATION}/panels/{panel['id']}/scan", headers=head, json={"article_id": mcb})
    assert scanned.status_code == 200, scanned.text
    assert scanned.json()["line"]["key"] == "device:mcb:1p:b16"
    assert all(line["kind"] != "removed" for line in scanned.json()["material"]["lines"])
    undone = client.post(f"{STATION}/panels/{panel['id']}/undo", headers=head, json={"article_id": mcb})
    assert undone.status_code == 200, undone.text
    assert all(line["kind"] != "removed" for line in undone.json()["material"]["lines"])


def test_a_part_that_is_also_planned_as_a_device_scans_onto_the_device_line(client: TestClient, admin_token: str) -> None:
    token, _ = _pair(client, admin_token, name="Regal Test")
    document = _without_hs(cabinet_document())
    # A second, ordinary HS further down: the same article is planned to go in.
    document["rows"][2]["devices"].append(device("dev-q5", "hauptschalter", designation="Q5"))
    panel = create_panel(client, admin_token, document)
    hs = article("Hauptschalter 3-polig 63 A (Testartikel)", stock=2)
    for key in (REMOVED_KEY, "device:hauptschalter:3p:"):
        assert client.put(MAPPING, headers=auth(admin_token), json={"key": key, "article_id": hs}).status_code == 200

    scanned = client.post(
        f"{STATION}/panels/{panel['id']}/scan", headers={"Authorization": f"Bearer {token}"}, json={"article_id": hs}
    )
    assert scanned.status_code == 200, scanned.text
    assert scanned.json()["line"]["key"] == "device:hauptschalter:3p:"
    full = client.get(f"/api/schaltplan/panels/{panel['id']}/material", headers=auth(admin_token)).json()
    assert _line(full, REMOVED_KEY)["scanned"] == 0


def test_the_project_tab_lists_a_return_as_a_negative_line(client: TestClient, admin_token: str) -> None:
    customer_id = customer(client, admin_token)
    project = client.post(
        "/api/projects", headers=auth(admin_token),
        json={"project_number": "P-T-772", "name": "Umbau Beispiel", "customer_id": customer_id},
    ).json()["id"]
    panel, hs = _board_with_removed_hs(client, admin_token, customer_id=customer_id, project_id=project)
    assert _book(client, admin_token, panel["id"], "salvage", hs).status_code == 200

    rows = client.get(f"/api/projects/{project}/materials", headers=auth(admin_token))
    assert rows.status_code == 200, rows.text
    [row] = [row for row in rows.json() if row["source"] == "verteiler"]
    assert row == {
        **row,
        "item": "Rücklauf ins Lager · Hauptschalter 3-polig 63 A (Testartikel)",
        "quantity_total": -1.0,
        "occurrence_count": 1,
        "panel_numbers": [panel["panel_number"]],
    }

    assert _book(client, admin_token, panel["id"], "unsalvage", hs).status_code == 200
    rows = client.get(f"/api/projects/{project}/materials", headers=auth(admin_token)).json()
    assert [row for row in rows if row["source"] == "verteiler"] == []
