"""The customer's note feed — ``/customers/{id}/notes``.

What must hold: the feed reads newest first with the author's name; an
empty posting is refused; a posting and a deletion each leave a
``customer.*`` row on the customer's change log with the note's preview,
and that log pages by cursor; the author or a project manager may delete,
another employee may not; the carried-over first entry has no author and
only a manager removes it; an employee who can see none of the customer's
projects sees and posts nothing; paging by ``before_id`` (or ``cursor``)
continues where the last page ended, without overlap; and a note of
another customer is not found under this one.
"""

from __future__ import annotations

from urllib.parse import quote

from fastapi.testclient import TestClient

from app.core.db import SessionLocal
from app.models.entities import CustomerNote
from tests.conftest import auth_headers

PASSWORD = "Password123!"


def _create_user(client: TestClient, admin_token: str, email: str, role: str = "employee") -> dict:
    response = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={"email": email, "password": PASSWORD, "full_name": f"{role.title()} User", "role": role},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _login(client: TestClient, email: str) -> str:
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    return response.headers["X-Access-Token"]


def _create_customer(client: TestClient, admin_token: str, name: str) -> int:
    response = client.post("/api/customers", headers=auth_headers(admin_token), json={"name": name})
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _create_project(client: TestClient, admin_token: str, number: str, customer_id: int) -> int:
    # An employee's access to a customer is borrowed from the customer's
    # projects, so most employee cases need one.
    response = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": number, "name": f"Notes {number}", "status": "active", "customer_id": customer_id},
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _post_note(client: TestClient, token: str, customer_id: int, body: str) -> dict:
    response = client.post(f"/api/customers/{customer_id}/notes", headers=auth_headers(token), json={"body": body})
    assert response.status_code == 200, response.text
    return response.json()


def _list_notes(client: TestClient, token: str, customer_id: int, query: str = "") -> list[dict]:
    response = client.get(f"/api/customers/{customer_id}/notes{query}", headers=auth_headers(token))
    assert response.status_code == 200, response.text
    return response.json()


def _activity(client: TestClient, token: str, customer_id: int, query: str = "") -> list[dict]:
    response = client.get(f"/api/customers/{customer_id}/activity{query}", headers=auth_headers(token))
    assert response.status_code == 200, response.text
    return response.json()


def _remove_membership(client: TestClient, admin_token: str, project_id: int, user_id: int) -> None:
    # Everyone is on every project by default, so "no access" has to be
    # made on purpose — the same way test_customer_files hides a customer.
    removed = client.delete(f"/api/projects/{project_id}/members/{user_id}", headers=auth_headers(admin_token))
    assert removed.status_code in (200, 204), removed.text


def test_notes_list_newest_first_with_author_name(client: TestClient, admin_token: str):
    employee = _create_user(client, admin_token, "cnotes-author@example.com")
    employee_token = _login(client, employee["email"])
    customer_id = _create_customer(client, admin_token, "Feed Kunde")
    _create_project(client, admin_token, "2026-4001", customer_id)

    first = _post_note(client, admin_token, customer_id, "Erste Notiz")
    second = _post_note(client, employee_token, customer_id, "  Zweite Notiz  \n")

    notes = _list_notes(client, admin_token, customer_id)
    assert [note["id"] for note in notes] == [second["id"], first["id"]]
    assert notes[0]["body"] == "Zweite Notiz"
    assert notes[0]["author_name"] == "Employee User"
    assert notes[0]["author_user_id"] == employee["id"]
    assert notes[1]["author_name"]
    assert notes[1]["customer_id"] == customer_id
    assert notes[1]["created_at"]


def test_empty_body_is_rejected(client: TestClient, admin_token: str):
    customer_id = _create_customer(client, admin_token, "Leer")

    for body in ("", "   ", "\n\t "):
        response = client.post(
            f"/api/customers/{customer_id}/notes", headers=auth_headers(admin_token), json={"body": body}
        )
        assert response.status_code == 422, response.text
    assert _list_notes(client, admin_token, customer_id) == []


def test_body_over_the_limit_is_rejected(client: TestClient, admin_token: str):
    customer_id = _create_customer(client, admin_token, "Lang")

    response = client.post(
        f"/api/customers/{customer_id}/notes", headers=auth_headers(admin_token), json={"body": "x" * 4001}
    )
    assert response.status_code == 422, response.text
    _post_note(client, admin_token, customer_id, "y" * 4000)


def test_posting_records_activity_with_single_line_preview(client: TestClient, admin_token: str):
    customer_id = _create_customer(client, admin_token, "Protokolliert")
    body = "Zähler getauscht.\nKunde will\r\n  Rückruf   am Montag. " + "Weitere Details " * 20
    note = _post_note(client, admin_token, customer_id, body)

    expected_preview = " ".join(body.split())[:120]
    posted = [row for row in _activity(client, admin_token, customer_id) if row["event_type"] == "customer.note_posted"]
    assert len(posted) == 1
    assert posted[0]["message"] == expected_preview
    assert posted[0]["details"] == {"note_id": note["id"], "preview": expected_preview}
    assert "\n" not in posted[0]["message"]
    assert posted[0]["actor_name"]
    # A customer's own event: no project to name, and a cursor to page by.
    assert posted[0]["source"] == "customer"
    assert posted[0]["project_id"] is None
    assert posted[0]["customer_id"] == customer_id
    assert posted[0]["cursor"]


def test_note_activity_pages_by_cursor(client: TestClient, admin_token: str):
    customer_id = _create_customer(client, admin_token, "Seitenweise")
    notes = [_post_note(client, admin_token, customer_id, f"Notiz {index}") for index in range(3)]

    first_page = _activity(client, admin_token, customer_id, "?limit=2")
    assert [row["details"]["note_id"] for row in first_page] == [notes[2]["id"], notes[1]["id"]]
    assert all(row["source"] == "customer" for row in first_page)

    second_page = _activity(client, admin_token, customer_id, f"?limit=2&cursor={quote(first_page[-1]['cursor'])}")
    assert [row["event_type"] for row in second_page] == ["customer.note_posted", "customer.created"]
    assert second_page[0]["details"]["note_id"] == notes[0]["id"]

    beyond = _activity(client, admin_token, customer_id, f"?limit=2&cursor={quote(second_page[-1]['cursor'])}")
    assert beyond == []


def test_author_may_delete_own_note(client: TestClient, admin_token: str):
    employee = _create_user(client, admin_token, "cnotes-owner@example.com")
    employee_token = _login(client, employee["email"])
    customer_id = _create_customer(client, admin_token, "Eigene")
    _create_project(client, admin_token, "2026-4002", customer_id)
    note = _post_note(client, employee_token, customer_id, "Meine Notiz")

    response = client.delete(f"/api/customers/{customer_id}/notes/{note['id']}", headers=auth_headers(employee_token))
    assert response.status_code == 204, response.text
    assert _list_notes(client, admin_token, customer_id) == []


def test_other_employee_may_not_delete(client: TestClient, admin_token: str):
    author = _create_user(client, admin_token, "cnotes-a@example.com")
    other = _create_user(client, admin_token, "cnotes-b@example.com")
    author_token = _login(client, author["email"])
    other_token = _login(client, other["email"])
    customer_id = _create_customer(client, admin_token, "Fremde")
    _create_project(client, admin_token, "2026-4003", customer_id)
    note = _post_note(client, author_token, customer_id, "Nicht deine")

    # The other employee can read the feed — the default membership holds …
    assert [row["id"] for row in _list_notes(client, other_token, customer_id)] == [note["id"]]
    # … but the posting is not theirs to remove.
    response = client.delete(f"/api/customers/{customer_id}/notes/{note['id']}", headers=auth_headers(other_token))
    assert response.status_code == 403, response.text
    assert len(_list_notes(client, admin_token, customer_id)) == 1


def test_manager_may_delete_and_it_is_recorded(client: TestClient, admin_token: str):
    employee = _create_user(client, admin_token, "cnotes-c@example.com")
    employee_token = _login(client, employee["email"])
    customer_id = _create_customer(client, admin_token, "Aufgeräumt")
    _create_project(client, admin_token, "2026-4004", customer_id)
    note = _post_note(client, employee_token, customer_id, "Bitte löschen, war falsch")

    response = client.delete(f"/api/customers/{customer_id}/notes/{note['id']}", headers=auth_headers(admin_token))
    assert response.status_code == 204, response.text
    assert _list_notes(client, admin_token, customer_id) == []

    deleted = [row for row in _activity(client, admin_token, customer_id) if row["event_type"] == "customer.note_deleted"]
    assert len(deleted) == 1
    assert deleted[0]["message"] == "Bitte löschen, war falsch"
    assert deleted[0]["details"] == {"note_id": note["id"], "preview": "Bitte löschen, war falsch"}
    assert deleted[0]["source"] == "customer"


def test_carried_over_entry_has_no_author_and_only_a_manager_removes_it(client: TestClient, admin_token: str):
    employee = _create_user(client, admin_token, "cnotes-legacy@example.com")
    employee_token = _login(client, employee["email"])
    customer_id = _create_customer(client, admin_token, "Altbestand")
    _create_project(client, admin_token, "2026-4005", customer_id)
    # What migration 0092 makes of the old notes text: an entry nobody signed.
    with SessionLocal() as db:
        db.add(CustomerNote(customer_id=customer_id, author_user_id=None, body="Alte Notiz"))
        db.commit()

    notes = _list_notes(client, employee_token, customer_id)
    assert [(note["body"], note["author_user_id"], note["author_name"]) for note in notes] == [("Alte Notiz", None, None)]

    refused = client.delete(f"/api/customers/{customer_id}/notes/{notes[0]['id']}", headers=auth_headers(employee_token))
    assert refused.status_code == 403, refused.text
    removed = client.delete(f"/api/customers/{customer_id}/notes/{notes[0]['id']}", headers=auth_headers(admin_token))
    assert removed.status_code == 204, removed.text
    assert _list_notes(client, admin_token, customer_id) == []


def test_employee_without_customer_access_is_denied(client: TestClient, admin_token: str):
    outsider = _create_user(client, admin_token, "cnotes-outsider@example.com")
    outsider_token = _login(client, outsider["email"])
    customer_id = _create_customer(client, admin_token, "Verschlossen")
    project_id = _create_project(client, admin_token, "2026-4006", customer_id)
    _post_note(client, admin_token, customer_id, "Intern")
    _remove_membership(client, admin_token, project_id, outsider["id"])

    listing = client.get(f"/api/customers/{customer_id}/notes", headers=auth_headers(outsider_token))
    assert listing.status_code == 403, listing.text
    posting = client.post(
        f"/api/customers/{customer_id}/notes", headers=auth_headers(outsider_token), json={"body": "Hallo"}
    )
    assert posting.status_code == 403, posting.text
    assert len(_list_notes(client, admin_token, customer_id)) == 1

    # A customer without any project gives an employee nothing to borrow.
    lonely_id = _create_customer(client, admin_token, "Ohne Projekt")
    assert client.get(f"/api/customers/{lonely_id}/notes", headers=auth_headers(outsider_token)).status_code == 403


def test_before_id_and_cursor_page_without_overlap(client: TestClient, admin_token: str):
    customer_id = _create_customer(client, admin_token, "Blättern")
    posted_ids = [_post_note(client, admin_token, customer_id, f"Notiz {index}")["id"] for index in range(5)]

    first_page = _list_notes(client, admin_token, customer_id, "?limit=2")
    second_page = _list_notes(client, admin_token, customer_id, f"?limit=2&before_id={first_page[-1]['id']}")
    # ``cursor`` is the same key under the activity feed's name.
    third_page = _list_notes(client, admin_token, customer_id, f"?limit=2&cursor={second_page[-1]['id']}")
    beyond = _list_notes(client, admin_token, customer_id, f"?limit=2&before_id={third_page[-1]['id']}")

    assert [len(first_page), len(second_page), len(third_page)] == [2, 2, 1]
    seen = [row["id"] for row in first_page + second_page + third_page]
    assert seen == list(reversed(posted_ids))
    assert beyond == []


def test_limit_is_clamped(client: TestClient, admin_token: str):
    customer_id = _create_customer(client, admin_token, "Begrenzt")
    for index in range(3):
        _post_note(client, admin_token, customer_id, f"Notiz {index}")

    assert len(_list_notes(client, admin_token, customer_id, "?limit=0")) == 1
    assert len(_list_notes(client, admin_token, customer_id, "?limit=-5")) == 1
    assert len(_list_notes(client, admin_token, customer_id, "?limit=9999")) == 3


def test_note_of_another_customer_is_not_found(client: TestClient, admin_token: str):
    customer_a = _create_customer(client, admin_token, "Kunde A")
    customer_b = _create_customer(client, admin_token, "Kunde B")
    note = _post_note(client, admin_token, customer_a, "Gehört zu A")

    response = client.delete(f"/api/customers/{customer_b}/notes/{note['id']}", headers=auth_headers(admin_token))
    assert response.status_code == 404, response.text
    assert len(_list_notes(client, admin_token, customer_a)) == 1
    assert _list_notes(client, admin_token, customer_b) == []

    missing = client.delete(f"/api/customers/{customer_a}/notes/999999", headers=auth_headers(admin_token))
    assert missing.status_code == 404, missing.text


def test_unknown_customer_is_404(client: TestClient, admin_token: str):
    assert client.get("/api/customers/999999/notes", headers=auth_headers(admin_token)).status_code == 404
    posting = client.post("/api/customers/999999/notes", headers=auth_headers(admin_token), json={"body": "Hallo"})
    assert posting.status_code == 404, posting.text
