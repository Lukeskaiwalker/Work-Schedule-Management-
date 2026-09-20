"""The customer's Kundenbesuch feed — ``/customers/{id}/visits``.

What must hold: the feed reads newest posting first with the visitor's
name and the linked project's number; an entry may name only one of this
customer's projects; a posting, an edit and a deletion each log where the
entry lives — on the project when linked, on the customer when not — and
never twice; the visitor or a project manager may edit and delete, another
employee may not; a PATCH changes only what it sends and ``project_id:
null`` unlinks; an employee who can see none of the customer's projects
sees and posts nothing; and an entry of another customer is not found
under this one.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import auth_headers

PASSWORD = "Password123!"


def _create_user(client: TestClient, admin_token: str, email: str, full_name: str, role: str = "employee") -> dict:
    response = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={"email": email, "password": PASSWORD, "full_name": full_name, "role": role},
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


def _create_project(client: TestClient, admin_token: str, number: str, customer_id: int | None) -> int:
    body: dict = {"project_number": number, "name": f"Besuch {number}", "status": "active"}
    if customer_id is not None:
        body["customer_id"] = customer_id
    response = client.post("/api/projects", headers=auth_headers(admin_token), json=body)
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _post_visit(client: TestClient, token: str, customer_id: int, **body) -> dict:
    response = client.post(f"/api/customers/{customer_id}/visits", headers=auth_headers(token), json=body)
    assert response.status_code == 200, response.text
    return response.json()


def _list_visits(client: TestClient, token: str, customer_id: int) -> list[dict]:
    response = client.get(f"/api/customers/{customer_id}/visits", headers=auth_headers(token))
    assert response.status_code == 200, response.text
    return response.json()


def _activity(client: TestClient, token: str, customer_id: int) -> list[dict]:
    response = client.get(f"/api/customers/{customer_id}/activity", headers=auth_headers(token))
    assert response.status_code == 200, response.text
    return response.json()


def _events(client: TestClient, token: str, customer_id: int, prefix: str) -> list[dict]:
    return [row for row in _activity(client, token, customer_id) if row["event_type"].startswith(prefix)]


def _remove_membership(client: TestClient, admin_token: str, project_id: int, user_id: int) -> None:
    removed = client.delete(f"/api/projects/{project_id}/members/{user_id}", headers=auth_headers(admin_token))
    assert removed.status_code in (200, 204), removed.text


# ── Reading and posting ───────────────────────────────────────────────────────


def test_feed_lists_newest_posting_first_with_visitor_and_project_label(client: TestClient, admin_token: str):
    customer_id = _create_customer(client, admin_token, "Feed Kunde")
    project_id = _create_project(client, admin_token, "2026-5001", customer_id)

    first = _post_visit(client, admin_token, customer_id, summary="  Erster Kontakt.\r\nZähler im Keller.  ", visit_date="2026-09-01")
    second = _post_visit(client, admin_token, customer_id, summary="Für das Projekt.", visit_date="2026-09-10", project_id=project_id)

    # Stored stripped, with the browser's line endings normalised.
    assert first["summary"] == "Erster Kontakt.\nZähler im Keller."
    assert first["project_id"] is None and first["project_number"] is None and first["project_name"] is None
    assert first["visit_by_name"] == "Initial Admin"
    assert second["project_id"] == project_id
    assert second["project_number"] == "2026-5001"
    assert second["project_name"] == "Besuch 2026-5001"
    assert second["visit_date"] == "2026-09-10"

    rows = _list_visits(client, admin_token, customer_id)
    assert [row["id"] for row in rows] == [second["id"], first["id"]]
    assert {row["customer_id"] for row in rows} == {customer_id}


def test_empty_summary_and_bad_links_are_refused(client: TestClient, admin_token: str):
    customer_id = _create_customer(client, admin_token, "Streng GmbH")
    stranger_id = _create_customer(client, admin_token, "Fremd GmbH")
    foreign_project = _create_project(client, admin_token, "2026-5002", stranger_id)
    orphan_project = _create_project(client, admin_token, "2026-5003", None)
    headers = auth_headers(admin_token)

    blank = client.post(f"/api/customers/{customer_id}/visits", headers=headers, json={"summary": "   \n "})
    assert blank.status_code == 422, blank.text

    for project_id in (foreign_project, orphan_project, 999999):
        wrong = client.post(f"/api/customers/{customer_id}/visits", headers=headers, json={"summary": "x", "project_id": project_id})
        assert wrong.status_code == 400, wrong.text
        assert wrong.json()["detail"] == "Project does not belong to this customer"

    ghost = client.post(f"/api/customers/{customer_id}/visits", headers=headers, json={"summary": "x", "visit_by_user_id": 999999})
    assert ghost.status_code == 400, ghost.text

    assert _list_visits(client, admin_token, customer_id) == []


def test_named_visitor_is_kept_and_the_poster_is_the_default(client: TestClient, admin_token: str):
    customer_id = _create_customer(client, admin_token, "Wer war da GmbH")
    colleague = _create_user(client, admin_token, "cvisit-vera@example.com", "Vera Vorort")

    by_default = _post_visit(client, admin_token, customer_id, summary="Ich war da.")
    named = _post_visit(client, admin_token, customer_id, summary="Vera war da.", visit_by_user_id=colleague["id"])

    assert by_default["visit_by_name"] == "Initial Admin"
    assert named["visit_by_user_id"] == colleague["id"]
    assert named["visit_by_name"] == "Vera Vorort"


# ── Where an entry logs ───────────────────────────────────────────────────────


def test_unlinked_entry_logs_on_the_customer_and_linked_entry_on_the_project(client: TestClient, admin_token: str):
    customer_id = _create_customer(client, admin_token, "Protokoll GmbH")
    project_id = _create_project(client, admin_token, "2026-5004", customer_id)

    general = _post_visit(client, admin_token, customer_id, summary="Allgemein: Altbau.", visit_date="2026-09-01")
    linked = _post_visit(client, admin_token, customer_id, summary="Projekt: Hofzuleitung.", project_id=project_id)

    posted = _events(client, admin_token, customer_id, "customer.visit_posted")
    assert len(posted) == 1
    assert posted[0]["source"] == "customer" and posted[0]["project_id"] is None
    assert posted[0]["message"] == "Kundenbesuch am 01.09.2026"
    assert posted[0]["details"] == {
        "visit_id": general["id"],
        "visit_date": "2026-09-01",
        "project_id": None,
        "preview": "Allgemein: Altbau.",
    }

    on_project = _events(client, admin_token, customer_id, "project.visit_posted")
    assert len(on_project) == 1
    assert on_project[0]["source"] == "project" and on_project[0]["project_id"] == project_id
    assert on_project[0]["message"] == "Kundenbesuch erfasst"
    assert on_project[0]["details"]["visit_id"] == linked["id"]
    assert on_project[0]["details"]["project_id"] == project_id

    # The project's own log has it too — it is the same row, read from the project.
    overview = client.get(f"/api/projects/{project_id}/overview", headers=auth_headers(admin_token))
    assert overview.status_code == 200, overview.text
    assert [row["event_type"] for row in overview.json()["recent_changes"] if row["event_type"].startswith("project.visit")] == [
        "project.visit_posted"
    ]

    # Never twice: one row per event across the union.
    all_visit_rows = _events(client, admin_token, customer_id, "customer.visit") + _events(client, admin_token, customer_id, "project.visit")
    assert len(all_visit_rows) == 2


def test_edit_changes_only_what_it_sends_and_relinking_moves_the_log(client: TestClient, admin_token: str):
    customer_id = _create_customer(client, admin_token, "Ändern GmbH")
    project_id = _create_project(client, admin_token, "2026-5005", customer_id)
    headers = auth_headers(admin_token)
    visit = _post_visit(client, admin_token, customer_id, summary="Erste Fassung.", visit_date="2026-09-01")

    # Only the summary: the date stays.
    edited = client.patch(f"/api/customers/{customer_id}/visits/{visit['id']}", headers=headers, json={"summary": "  Zweite Fassung. "})
    assert edited.status_code == 200, edited.text
    assert edited.json()["summary"] == "Zweite Fassung."
    assert edited.json()["visit_date"] == "2026-09-01"
    assert _events(client, admin_token, customer_id, "customer.visit_updated")[0]["details"]["preview"] == "Zweite Fassung."

    # Linking it to the project: the entry now logs there.
    relinked = client.patch(f"/api/customers/{customer_id}/visits/{visit['id']}", headers=headers, json={"project_id": project_id})
    assert relinked.status_code == 200, relinked.text
    assert relinked.json()["project_number"] == "2026-5005"
    assert len(_events(client, admin_token, customer_id, "project.visit_updated")) == 1

    # And back: null unlinks.
    unlinked = client.patch(f"/api/customers/{customer_id}/visits/{visit['id']}", headers=headers, json={"project_id": None})
    assert unlinked.status_code == 200, unlinked.text
    assert unlinked.json()["project_id"] is None and unlinked.json()["project_number"] is None

    # A summary cannot be cleared, only replaced; a foreign project is refused.
    assert client.patch(f"/api/customers/{customer_id}/visits/{visit['id']}", headers=headers, json={"summary": None}).status_code == 400
    other_customer = _create_customer(client, admin_token, "Andere GmbH")
    other_project = _create_project(client, admin_token, "2026-5006", other_customer)
    assert client.patch(f"/api/customers/{customer_id}/visits/{visit['id']}", headers=headers, json={"project_id": other_project}).status_code == 400

    # Nothing but the edits above happened to the feed.
    assert [row["summary"] for row in _list_visits(client, admin_token, customer_id)] == ["Zweite Fassung."]


def test_delete_logs_the_entry_it_removed(client: TestClient, admin_token: str):
    customer_id = _create_customer(client, admin_token, "Löschen GmbH")
    project_id = _create_project(client, admin_token, "2026-5007", customer_id)
    headers = auth_headers(admin_token)
    linked = _post_visit(client, admin_token, customer_id, summary="Weg damit.", visit_date="2026-09-03", project_id=project_id)

    gone = client.delete(f"/api/customers/{customer_id}/visits/{linked['id']}", headers=headers)
    assert gone.status_code == 204, gone.text
    assert _list_visits(client, admin_token, customer_id) == []

    deleted = _events(client, admin_token, customer_id, "project.visit_deleted")
    assert len(deleted) == 1
    assert deleted[0]["message"] == "Kundenbesuch entfernt"
    assert deleted[0]["details"] == {"visit_id": linked["id"], "visit_date": "2026-09-03", "project_id": project_id, "preview": "Weg damit."}

    # Gone is gone: a second delete, an edit — not found.
    assert client.delete(f"/api/customers/{customer_id}/visits/{linked['id']}", headers=headers).status_code == 404
    assert client.patch(f"/api/customers/{customer_id}/visits/{linked['id']}", headers=headers, json={"summary": "x"}).status_code == 404


# ── Who may ───────────────────────────────────────────────────────────────────


def test_visitor_or_manager_may_change_an_entry_another_employee_may_not(client: TestClient, admin_token: str):
    customer_id = _create_customer(client, admin_token, "Rechte GmbH")
    _create_project(client, admin_token, "2026-5008", customer_id)
    visitor = _create_user(client, admin_token, "cvisit-visitor@example.com", "Vero Vorort")
    other = _create_user(client, admin_token, "cvisit-other@example.com", "Otto Anders")
    visitor_token = _login(client, visitor["email"])
    other_token = _login(client, other["email"])

    # An employee who may open the customer may post — and is the visitor.
    mine = _post_visit(client, visitor_token, customer_id, summary="Mein Besuch.")
    assert mine["visit_by_user_id"] == visitor["id"]

    path = f"/api/customers/{customer_id}/visits/{mine['id']}"
    refused = client.patch(path, headers=auth_headers(other_token), json={"summary": "Nicht meiner."})
    assert refused.status_code == 403, refused.text
    assert client.delete(path, headers=auth_headers(other_token)).status_code == 403

    edited = client.patch(path, headers=auth_headers(visitor_token), json={"summary": "Mein Besuch, ergänzt."})
    assert edited.status_code == 200, edited.text
    assert client.delete(path, headers=auth_headers(admin_token)).status_code == 204

    # The other employee reads the feed all the same.
    assert _list_visits(client, other_token, customer_id) == []


def test_employee_without_a_visible_project_sees_and_posts_nothing(client: TestClient, admin_token: str):
    customer_id = _create_customer(client, admin_token, "Verborgen GmbH")
    project_id = _create_project(client, admin_token, "2026-5009", customer_id)
    outsider = _create_user(client, admin_token, "cvisit-outsider@example.com", "Ossi Aussen")
    outsider_token = _login(client, outsider["email"])
    _remove_membership(client, admin_token, project_id, outsider["id"])
    _post_visit(client, admin_token, customer_id, summary="Intern.")

    assert client.get(f"/api/customers/{customer_id}/visits", headers=auth_headers(outsider_token)).status_code == 403
    posting = client.post(f"/api/customers/{customer_id}/visits", headers=auth_headers(outsider_token), json={"summary": "Hallo"})
    assert posting.status_code == 403, posting.text
    assert len(_list_visits(client, admin_token, customer_id)) == 1


def test_entry_of_another_customer_is_not_found_under_this_one(client: TestClient, admin_token: str):
    here = _create_customer(client, admin_token, "Hier GmbH")
    there = _create_customer(client, admin_token, "Dort GmbH")
    theirs = _post_visit(client, admin_token, there, summary="Dort gewesen.")
    headers = auth_headers(admin_token)

    assert client.patch(f"/api/customers/{here}/visits/{theirs['id']}", headers=headers, json={"summary": "x"}).status_code == 404
    assert client.delete(f"/api/customers/{here}/visits/{theirs['id']}", headers=headers).status_code == 404
    assert [row["id"] for row in _list_visits(client, admin_token, there)] == [theirs["id"]]
    assert client.get("/api/customers/999999/visits", headers=headers).status_code == 404
