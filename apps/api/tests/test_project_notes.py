"""The project's internal note feed — ``/projects/{id}/notes``.

What must hold: the feed reads newest first with the author's name; the
overview carries the latest notes; an empty posting is refused; a posting
leaves an activity row with the note's preview; a note is permanent —
nobody deletes it, not its author and not a project manager (a correction
is a new note); an employee without access to the project sees and posts
nothing; paging by ``before_id`` continues where the last page ended,
without overlap; and a note of one project never shows under another.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import auth_headers

PASSWORD = "Password123!"


def _create_user(client: TestClient, admin_token: str, email: str, role: str) -> dict:
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


def _create_project(client: TestClient, admin_token: str, number: str) -> int:
    response = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": number, "name": f"Notes {number}", "status": "active"},
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _post_note(client: TestClient, token: str, project_id: int, body: str) -> dict:
    response = client.post(f"/api/projects/{project_id}/notes", headers=auth_headers(token), json={"body": body})
    assert response.status_code == 200, response.text
    return response.json()


def _list_notes(client: TestClient, token: str, project_id: int, query: str = "") -> list[dict]:
    response = client.get(f"/api/projects/{project_id}/notes{query}", headers=auth_headers(token))
    assert response.status_code == 200, response.text
    return response.json()


def _recent_changes(client: TestClient, token: str, project_id: int) -> list[dict]:
    response = client.get(f"/api/projects/{project_id}/overview", headers=auth_headers(token))
    assert response.status_code == 200, response.text
    return response.json()["recent_changes"]


def _remove_membership(client: TestClient, admin_token: str, project_id: int, user_id: int) -> None:
    # Everyone is on every project by default, so "no access" has to be
    # made on purpose — the same way test_webdav hides a project.
    removed = client.delete(f"/api/projects/{project_id}/members/{user_id}", headers=auth_headers(admin_token))
    assert removed.status_code in (200, 204), removed.text


def test_notes_list_newest_first_with_author_name(client: TestClient, admin_token: str):
    employee = _create_user(client, admin_token, "notes-author@example.com", "employee")
    employee_token = _login(client, employee["email"])
    project_id = _create_project(client, admin_token, "2026-3001")

    first = _post_note(client, admin_token, project_id, "Erste Notiz")
    second = _post_note(client, employee_token, project_id, "  Zweite Notiz  \n")

    notes = _list_notes(client, admin_token, project_id)
    assert [note["id"] for note in notes] == [second["id"], first["id"]]
    assert notes[0]["body"] == "Zweite Notiz"
    assert notes[0]["author_name"] == "Employee User"
    assert notes[0]["author_user_id"] == employee["id"]
    assert notes[1]["author_name"]
    assert notes[1]["project_id"] == project_id
    assert notes[1]["created_at"]


def test_overview_carries_the_notes(client: TestClient, admin_token: str):
    project_id = _create_project(client, admin_token, "2026-3002")
    _post_note(client, admin_token, project_id, "Alt")
    newest = _post_note(client, admin_token, project_id, "Neu")

    overview = client.get(f"/api/projects/{project_id}/overview", headers=auth_headers(admin_token))
    assert overview.status_code == 200, overview.text
    notes = overview.json()["notes"]
    assert [note["body"] for note in notes] == ["Neu", "Alt"]
    assert notes[0]["id"] == newest["id"]
    assert notes[0]["author_name"]


def test_empty_body_is_rejected(client: TestClient, admin_token: str):
    project_id = _create_project(client, admin_token, "2026-3003")

    for body in ("", "   ", "\n\t "):
        response = client.post(
            f"/api/projects/{project_id}/notes", headers=auth_headers(admin_token), json={"body": body}
        )
        assert response.status_code == 422, response.text
    assert _list_notes(client, admin_token, project_id) == []


def test_body_over_the_limit_is_rejected(client: TestClient, admin_token: str):
    project_id = _create_project(client, admin_token, "2026-3004")

    response = client.post(
        f"/api/projects/{project_id}/notes", headers=auth_headers(admin_token), json={"body": "x" * 4001}
    )
    assert response.status_code == 422, response.text
    _post_note(client, admin_token, project_id, "y" * 4000)


def test_posting_records_activity_with_single_line_preview(client: TestClient, admin_token: str):
    project_id = _create_project(client, admin_token, "2026-3005")
    body = "Zähler getauscht.\nKunde will\r\n  Rückruf   am Montag. " + "Weitere Details " * 20
    note = _post_note(client, admin_token, project_id, body)

    expected_preview = " ".join(body.split())[:120]
    posted = [row for row in _recent_changes(client, admin_token, project_id) if row["event_type"] == "project.note_posted"]
    assert len(posted) == 1
    assert posted[0]["message"] == expected_preview
    assert posted[0]["details"] == {"note_id": note["id"], "preview": expected_preview}
    assert "\n" not in posted[0]["message"]
    assert posted[0]["actor_name"]


def test_notes_are_permanent(client: TestClient, admin_token: str):
    employee = _create_user(client, admin_token, "notes-owner@example.com", "employee")
    employee_token = _login(client, employee["email"])
    project_id = _create_project(client, admin_token, "2026-3006")
    note = _post_note(client, employee_token, project_id, "Meine Notiz")

    # Neither the author nor a project manager can take a posting back: the
    # feed is the project's record, and there is no route that removes one.
    for token in (employee_token, admin_token):
        response = client.delete(f"/api/projects/{project_id}/notes/{note['id']}", headers=auth_headers(token))
        assert response.status_code in (404, 405), response.text
    assert [row["id"] for row in _list_notes(client, admin_token, project_id)] == [note["id"]]
    changes = _recent_changes(client, admin_token, project_id)
    assert not [row for row in changes if row["event_type"] == "project.note_deleted"]


def test_employee_without_project_access_is_denied(client: TestClient, admin_token: str):
    outsider = _create_user(client, admin_token, "notes-outsider@example.com", "employee")
    outsider_token = _login(client, outsider["email"])
    project_id = _create_project(client, admin_token, "2026-3009")
    _post_note(client, admin_token, project_id, "Intern")
    _remove_membership(client, admin_token, project_id, outsider["id"])

    listing = client.get(f"/api/projects/{project_id}/notes", headers=auth_headers(outsider_token))
    assert listing.status_code == 403, listing.text
    posting = client.post(
        f"/api/projects/{project_id}/notes", headers=auth_headers(outsider_token), json={"body": "Hallo"}
    )
    assert posting.status_code == 403, posting.text
    assert len(_list_notes(client, admin_token, project_id)) == 1


def test_before_id_pages_without_overlap(client: TestClient, admin_token: str):
    project_id = _create_project(client, admin_token, "2026-3010")
    posted_ids = [_post_note(client, admin_token, project_id, f"Notiz {index}")["id"] for index in range(5)]

    first_page = _list_notes(client, admin_token, project_id, "?limit=2")
    second_page = _list_notes(client, admin_token, project_id, f"?limit=2&before_id={first_page[-1]['id']}")
    third_page = _list_notes(client, admin_token, project_id, f"?limit=2&before_id={second_page[-1]['id']}")
    beyond = _list_notes(client, admin_token, project_id, f"?limit=2&before_id={third_page[-1]['id']}")

    assert [len(first_page), len(second_page), len(third_page)] == [2, 2, 1]
    seen = [row["id"] for row in first_page + second_page + third_page]
    assert seen == list(reversed(posted_ids))
    assert beyond == []


def test_limit_is_clamped(client: TestClient, admin_token: str):
    project_id = _create_project(client, admin_token, "2026-3011")
    for index in range(3):
        _post_note(client, admin_token, project_id, f"Notiz {index}")

    assert len(_list_notes(client, admin_token, project_id, "?limit=0")) == 1
    assert len(_list_notes(client, admin_token, project_id, "?limit=-5")) == 1
    assert len(_list_notes(client, admin_token, project_id, "?limit=9999")) == 3


def test_a_note_stays_with_its_project(client: TestClient, admin_token: str):
    project_a = _create_project(client, admin_token, "2026-3012")
    project_b = _create_project(client, admin_token, "2026-3013")
    note = _post_note(client, admin_token, project_a, "Gehört zu A")

    assert [row["id"] for row in _list_notes(client, admin_token, project_a)] == [note["id"]]
    assert _list_notes(client, admin_token, project_b) == []
