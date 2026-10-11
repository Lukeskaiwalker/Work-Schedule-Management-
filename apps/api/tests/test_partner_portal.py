"""The partner portal — ``/api/portal`` — and the office side that feeds it.

What must hold:

* the office invites a login on a partner; the invite link opens the
  portal's own page; a second link is an invite while the first is unused
  and a password reset afterwards; a login can be locked and unlocked;
* a partner sees exactly the tasks the office linked to the partner and the
  projects it was given (directly or through one of those tasks), and gets a
  plain 404 for anything else — never a hint that it exists;
* a task shows what the job needs (when, where, access, what, files, who of
  ours is there) and nothing internal (no customer phone, no finances);
* "erledigt melden" completes the task exactly once, with the office's
  side effects, and an optional message lands in the project's note feed;
* photos go onto the task the office already looks at, only images and
  PDFs, with a size cap, and only on the partner's own tasks;
* a project shows the office's note for this partner and only the
  partner's own tasks in it; the project phase never reveals invoicing;
* an archived partner's logins stop working without being deleted.
"""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.models.entities import CustomerNote, ProjectActivity, ProjectNote, Task
from tests.conftest import auth_headers
from tests.partner_portal_helpers import (
    PORTAL_PASSWORD,
    create_employee as _employee,
    portal_world as _world,
    accept_and_login,
    create_partner,
    create_project,
    create_task,
    invite_portal_user,
    portal_login,
    token_from_link,
)

JPEG_BYTES = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00" + b"\x00" * 64 + b"\xff\xd9"
PDF_BYTES = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"


# ── The office side: logins on a partner ─────────────────────────────────────

def test_the_office_invites_a_login_that_opens_the_portal(client: TestClient, admin_token: str) -> None:
    partner = create_partner(client, admin_token)
    invite = invite_portal_user(client, admin_token, partner["id"])
    assert "/partner/einladung?token=" in invite["invite_link"]
    assert invite["user"]["status"] == "invited" and invite["user"]["is_active"] is True
    assert invite["expires_at"]

    listed = client.get(f"/api/partners/{partner['id']}/portal-users", headers=auth_headers(admin_token))
    assert listed.status_code == 200 and [row["email"] for row in listed.json()] == ["a.hoffmann@hoffmann-dach.de"]

    token = accept_and_login(client, invite)
    me = client.get("/api/portal/me", headers=auth_headers(token))
    assert me.status_code == 200, me.text
    body = me.json()
    assert body["user"]["full_name"] == "Andreas Hoffmann"
    assert body["partner"] == {"id": partner["id"], "name": "Bedachungen Hoffmann KG", "trade": "Dachdecker"}
    assert body["company"]["name"]

    after = client.get(f"/api/partners/{partner['id']}/portal-users", headers=auth_headers(admin_token)).json()[0]
    assert after["status"] == "active" and after["invite_accepted_at"] and after["last_login_at"]

    listing = client.get("/api/partners", headers=auth_headers(admin_token)).json()
    assert [row["portal_user_count"] for row in listing if row["id"] == partner["id"]] == [1]


def test_invites_refuse_taken_emails_archived_partners_and_staff_without_project_rights(client: TestClient, admin_token: str) -> None:
    partner = create_partner(client, admin_token)
    head = auth_headers(admin_token)
    taken = client.post(f"/api/partners/{partner['id']}/portal-users", headers=head, json={"full_name": "Admin", "email": "admin@example.com"})
    assert taken.status_code == 409
    bad = client.post(f"/api/partners/{partner['id']}/portal-users", headers=head, json={"full_name": "  ", "email": "x@example.com"})
    assert bad.status_code == 422
    assert client.post("/api/partners/999999/portal-users", headers=head, json={"full_name": "X", "email": "x@example.com"}).status_code == 404
    assert client.post(f"/api/partners/{partner['id']}/archive", headers=head).status_code == 200
    archived = client.post(f"/api/partners/{partner['id']}/portal-users", headers=head, json={"full_name": "X", "email": "x@example.com"})
    assert archived.status_code == 409

    _employee(client, admin_token, "fitter@example.com", "Fritz Fitter")
    login = client.post("/api/auth/login", json={"email": "fitter@example.com", "password": "Password123!"})
    fitter = auth_headers(login.headers["X-Access-Token"])
    second = create_partner(client, admin_token, name="Wagner Sanitär e.K.")
    assert client.get(f"/api/partners/{second['id']}/portal-users", headers=fitter).status_code == 403
    assert client.post(f"/api/partners/{second['id']}/portal-users", headers=fitter, json={"full_name": "X", "email": "y@example.com"}).status_code == 403


def test_a_new_link_is_an_invite_until_used_and_a_password_reset_after(client: TestClient, admin_token: str) -> None:
    partner = create_partner(client, admin_token)
    head = auth_headers(admin_token)
    first = invite_portal_user(client, admin_token, partner["id"])
    uid = first["user"]["id"]

    again = client.post(f"/api/partners/{partner['id']}/portal-users/{uid}/send-link", headers=head)
    assert again.status_code == 200 and "/partner/einladung?token=" in again.json()["invite_link"]
    # The fresh invite burned the first one.
    stale = client.post("/api/auth/invites/accept", json={"token": token_from_link(first["invite_link"]), "new_password": PORTAL_PASSWORD})
    assert stale.status_code in (400, 404)
    accept_and_login(client, again.json())

    reset = client.post(f"/api/partners/{partner['id']}/portal-users/{uid}/send-link", headers=head)
    assert reset.status_code == 200 and "/partner/passwort?token=" in reset.json()["invite_link"]
    confirmed = client.post("/api/auth/password-reset/confirm", json={"token": token_from_link(reset.json()["invite_link"]), "new_password": "NeuesPasswort1!"})
    assert confirmed.status_code == 200, confirmed.text
    assert client.post("/api/auth/login", json={"email": first["user"]["email"], "password": "NeuesPasswort1!"}).status_code == 200

    other = create_partner(client, admin_token, name="Wagner Sanitär e.K.")
    assert client.post(f"/api/partners/{other['id']}/portal-users/{uid}/send-link", headers=head).status_code == 404


def test_locking_a_login_burns_its_links_and_unlocking_restores_it(client: TestClient, admin_token: str) -> None:
    partner = create_partner(client, admin_token)
    head = auth_headers(admin_token)
    invite = invite_portal_user(client, admin_token, partner["id"])
    uid = invite["user"]["id"]
    locked = client.post(f"/api/partners/{partner['id']}/portal-users/{uid}/deactivate", headers=head)
    assert locked.status_code == 200 and locked.json()["status"] == "disabled"
    # The unused invite can no longer switch the account back on.
    burned = client.post("/api/auth/invites/accept", json={"token": token_from_link(invite["invite_link"]), "new_password": PORTAL_PASSWORD})
    assert burned.status_code in (400, 404)
    assert client.post(f"/api/partners/{partner['id']}/portal-users/{uid}/send-link", headers=head).status_code == 409

    unlocked = client.post(f"/api/partners/{partner['id']}/portal-users/{uid}/activate", headers=head)
    assert unlocked.status_code == 200 and unlocked.json()["status"] == "invited"
    fresh = client.post(f"/api/partners/{partner['id']}/portal-users/{uid}/send-link", headers=head)
    accept_and_login(client, fresh.json())


# ── The portal: tasks ────────────────────────────────────────────────────────

def test_the_task_list_holds_exactly_the_partners_tasks(client: TestClient, admin_token: str) -> None:
    w = _world(client, admin_token)
    head = auth_headers(w["token"])
    rows = client.get("/api/portal/tasks", headers=head)
    assert rows.status_code == 200, rows.text
    by_title = {row["title"]: row for row in rows.json()}
    assert set(by_title) == {"Dachrinne und Fallrohre erneuern", "Ortgang verkleiden", "Schneefanggitter montieren", "Aufmaß Gaube"}

    today_row = by_title["Dachrinne und Fallrohre erneuern"]
    assert today_row["project"] == {"id": w["project"]["id"], "number": "2024-008", "name": "Neubau EFH König"}
    assert today_row["address"] == "Lindenstr. 5, 58452 Witten"
    assert today_row["start_time"].startswith("07:30") and today_row["estimated_hours"] == 6
    assert today_row["is_overdue"] is False and today_row["status"] == "open"
    assert by_title["Ortgang verkleiden"]["is_overdue"] is True
    customer_row = by_title["Schneefanggitter montieren"]
    assert customer_row["project"] is None and customer_row["customer_name"] == "Familie Schulze"
    assert customer_row["address"] == "Hauptstr. 5, 58452 Witten"

    assert client.get("/api/portal/tasks", params={"scope": "done"}, headers=head).json() == []
    assert client.get("/api/portal/tasks", params={"scope": "everything"}, headers=head).status_code == 422


def test_a_task_shows_what_the_job_needs_and_nothing_internal(client: TestClient, admin_token: str) -> None:
    w = _world(client, admin_token)
    head = auth_headers(w["token"])
    detail = client.get(f"/api/portal/tasks/{w['mine']['id']}", headers=head)
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["description"] == "Alte Zinkrinne entfernen, Kupferrinne setzen."
    assert body["subtasks"] == ["Altrinne demontieren", "Rinnenhalter setzen"]
    assert body["materials"] == "Kupferrinne 333 mm, 12 m"
    assert body["site_access_type"] == "key_pickup" and body["site_access_note"] == "Nachbar Haus Nr. 7"
    assert body["team"] == ["Kai Monteur"]
    assert body["can_complete"] is True and body["files"] == []
    text = detail.text
    for secret in ("0201 999999", "0171 1234567", "Interne Kalkulation", "Wagner"):
        assert secret not in text

    for task_key in ("theirs", "internal", "foreign"):
        assert client.get(f"/api/portal/tasks/{w[task_key]['id']}", headers=head).status_code == 404
    assert client.get("/api/portal/tasks/999999", headers=head).status_code == 404


def test_reporting_done_completes_once_and_posts_the_message_to_the_office(client: TestClient, admin_token: str) -> None:
    w = _world(client, admin_token)
    head = auth_headers(w["token"])
    done = client.post(f"/api/portal/tasks/{w['mine']['id']}/complete", headers=head, json={"note": "Rinne fertig, ein Fallrohr fehlt noch."})
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "done" and done.json()["can_complete"] is False

    with SessionLocal() as db:
        assert db.get(Task, w["mine"]["id"]).status == "done"
        notes = db.scalars(select(ProjectNote).where(ProjectNote.project_id == w["project"]["id"])).all()
        assert len(notes) == 1 and "ein Fallrohr fehlt noch" in notes[0].body and "Dachrinne" in notes[0].body
        assert notes[0].author_user_id == w["user"]["id"]
        activity = db.scalars(select(ProjectActivity).where(ProjectActivity.project_id == w["project"]["id"], ProjectActivity.actor_user_id == w["user"]["id"])).all()
        assert any(row.details.get("status") == "done" for row in activity)

    again = client.post(f"/api/portal/tasks/{w['mine']['id']}/complete", headers=head, json={})
    assert again.status_code == 409
    finished = client.get("/api/portal/tasks", params={"scope": "done"}, headers=head).json()
    assert [row["id"] for row in finished] == [w["mine"]["id"]]

    customer_done = client.post(f"/api/portal/tasks/{w['customer_only']['id']}/complete", headers=head, json={"note": "Gitter montiert."})
    assert customer_done.status_code == 200
    with SessionLocal() as db:
        notes = db.scalars(select(CustomerNote).where(CustomerNote.customer_id == w["customer"]["id"])).all()
        assert len(notes) == 1 and "Gitter montiert." in notes[0].body

    assert client.post(f"/api/portal/tasks/{w['theirs']['id']}/complete", headers=head, json={}).status_code == 404
    with SessionLocal() as db:
        assert db.get(Task, w["theirs"]["id"]).status == "open"


def test_photos_land_on_the_partners_own_task_and_only_photos_or_pdfs(client: TestClient, admin_token: str) -> None:
    w = _world(client, admin_token)
    head = auth_headers(w["token"])
    office_file = client.post(
        f"/api/tasks/{w['mine']['id']}/files",
        headers=auth_headers(admin_token),
        files={"files": ("Dachplan.pdf", PDF_BYTES, "application/pdf")},
    )
    assert office_file.status_code == 200, office_file.text

    uploaded = client.post(
        f"/api/portal/tasks/{w['mine']['id']}/files",
        headers=head,
        files=[("files", ("rinne.jpg", JPEG_BYTES, "image/jpeg"))],
    )
    assert uploaded.status_code == 200, uploaded.text
    assert [(row["file_name"], row["source"]) for row in uploaded.json()] == [("rinne.jpg", "partner")]

    detail = client.get(f"/api/portal/tasks/{w['mine']['id']}", headers=head).json()
    assert sorted((row["file_name"], row["source"]) for row in detail["files"]) == [("Dachplan.pdf", "office"), ("rinne.jpg", "partner")]
    office_view = client.get(f"/api/tasks/{w['mine']['id']}/files", headers=auth_headers(admin_token)).json()
    assert sorted(row["file_name"] for row in office_view) == ["Dachplan.pdf", "rinne.jpg"]

    photo_id = next(row["id"] for row in detail["files"] if row["file_name"] == "rinne.jpg")
    fetched = client.get(f"/api/portal/tasks/{w['mine']['id']}/files/{photo_id}", headers=head)
    assert fetched.status_code == 200 and fetched.content == JPEG_BYTES
    assert fetched.headers["content-type"].startswith("image/jpeg")
    # A file is only reachable through the task it belongs to.
    assert client.get(f"/api/portal/tasks/{w['overdue']['id']}/files/{photo_id}", headers=head).status_code == 404

    lying = client.post(f"/api/portal/tasks/{w['mine']['id']}/files", headers=head, files={"files": ("foto.jpg", b"<html><script>alert(1)</script></html>", "image/jpeg")})
    assert lying.status_code == 400
    script = client.post(f"/api/portal/tasks/{w['mine']['id']}/files", headers=head, files={"files": ("x.svg", b"<svg onload=alert(1)>", "image/svg+xml")})
    assert script.status_code == 400
    huge = client.post(f"/api/portal/tasks/{w['mine']['id']}/files", headers=head, files={"files": ("gross.jpg", JPEG_BYTES + b"\x00" * (25 * 1024 * 1024), "image/jpeg")})
    assert huge.status_code == 413
    too_many = client.post(f"/api/portal/tasks/{w['mine']['id']}/files", headers=head, files=[("files", (f"f{i}.jpg", JPEG_BYTES, "image/jpeg")) for i in range(11)])
    assert too_many.status_code == 400
    assert client.post(f"/api/portal/tasks/{w['theirs']['id']}/files", headers=head, files={"files": ("x.jpg", JPEG_BYTES, "image/jpeg")}).status_code == 404


# ── The portal: projects ─────────────────────────────────────────────────────

def test_projects_come_from_tasks_or_a_direct_assignment_with_the_offices_note(client: TestClient, admin_token: str) -> None:
    w = _world(client, admin_token)
    office = auth_headers(admin_token)
    extra = create_project(client, admin_token, "2024-021", "Carport und Gartenhaus Schulze", construction_site_address="Hauptstr. 5, 58452 Witten")
    assigned = client.put(
        f"/api/projects/{extra['id']}/partners/{w['partner']['id']}",
        headers=office,
        json={"note": "Material bitte über die Hofeinfahrt anliefern."},
    )
    assert assigned.status_code == 200, assigned.text
    assert assigned.json()["note"] == "Material bitte über die Hofeinfahrt anliefern."
    client.put(f"/api/projects/{w['project']['id']}/partners/{w['partner']['id']}", headers=office, json={"note": "Bauleitung: Herr Kaiser"})

    head = auth_headers(w["token"])
    rows = client.get("/api/portal/projects", headers=head)
    assert rows.status_code == 200, rows.text
    by_number = {row["number"]: row for row in rows.json()}
    assert set(by_number) == {"2024-008", "2024-015", "2024-021"}
    assert by_number["2024-008"]["open_task_count"] == 2 and by_number["2024-008"]["phase"] == "running"
    assert by_number["2024-015"]["overdue_task_count"] == 1
    assert by_number["2024-021"]["open_task_count"] == 0

    detail = client.get(f"/api/portal/projects/{w['project']['id']}", headers=head)
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["partner_note"] == "Bauleitung: Herr Kaiser"
    assert body["address"] == "Lindenstr. 5, 58452 Witten" and body["site_access_type"] == "key_pickup"
    assert sorted(task["title"] for task in body["tasks"]) == ["Aufmaß Gaube", "Dachrinne und Fallrohre erneuern"]
    assert "Interne Kalkulation" not in detail.text and "Elektro" not in detail.text
    task_detail = client.get(f"/api/portal/tasks/{w['mine']['id']}", headers=head).json()
    assert task_detail["project_note"] == "Bauleitung: Herr Kaiser"

    assert client.get(f"/api/portal/projects/{w['hidden']['id']}", headers=head).status_code == 404

    # Invoicing is the office's business: the funnel's later stages read as finished.
    assert client.patch(f"/api/projects/{w['braun']['id']}", headers=office, json={"status": "rechnung_verschickt"}).status_code == 200
    running = [row["number"] for row in client.get("/api/portal/projects", headers=head).json()]
    finished = client.get("/api/portal/projects", params={"scope": "done"}, headers=head).json()
    assert "2024-015" not in running and [row["phase"] for row in finished] == ["finished"]
    assert "rechnung" not in client.get(f"/api/portal/projects/{w['braun']['id']}", headers=head).text

    removed = client.delete(f"/api/projects/{extra['id']}/partners/{w['partner']['id']}", headers=office)
    assert removed.status_code == 204
    assert "2024-021" not in [row["number"] for row in client.get("/api/portal/projects", headers=head).json()]
    assert client.get(f"/api/portal/projects/{extra['id']}", headers=head).status_code == 404


def test_project_partner_assignment_needs_project_rights(client: TestClient, admin_token: str) -> None:
    partner = create_partner(client, admin_token)
    project = create_project(client, admin_token, "2024-040", "Rechteprüfung")
    _employee(client, admin_token, "fitter@example.com", "Fritz Fitter")
    login = client.post("/api/auth/login", json={"email": "fitter@example.com", "password": "Password123!"})
    fitter = auth_headers(login.headers["X-Access-Token"])
    assert client.put(f"/api/projects/{project['id']}/partners/{partner['id']}", headers=fitter, json={}).status_code == 403
    office = auth_headers(admin_token)
    assert client.put(f"/api/projects/{project['id']}/partners/{partner['id']}", headers=office, json={}).status_code == 200
    listed = client.get(f"/api/projects/{project['id']}/partners", headers=fitter)
    assert listed.status_code == 200 and [row["partner"]["name"] for row in listed.json()] == ["Bedachungen Hoffmann KG"]
    assert listed.json()[0]["portal_user_count"] == 0
    assert client.put(f"/api/projects/{project['id']}/partners/999999", headers=office, json={}).status_code == 404
    assert client.delete(f"/api/projects/{project['id']}/partners/{partner['id']}", headers=fitter).status_code == 403


# ── Account and lifecycle ────────────────────────────────────────────────────

def test_a_partner_changes_their_own_password(client: TestClient, admin_token: str) -> None:
    _, user, token = portal_login(client, admin_token)
    head = auth_headers(token)
    wrong = client.post("/api/portal/me/password", headers=head, json={"current_password": "falsch", "new_password": "NeuesPasswort1!"})
    assert wrong.status_code == 403
    short = client.post("/api/portal/me/password", headers=head, json={"current_password": PORTAL_PASSWORD, "new_password": "kurz"})
    assert short.status_code == 422
    changed = client.post("/api/portal/me/password", headers=head, json={"current_password": PORTAL_PASSWORD, "new_password": "NeuesPasswort1!"})
    assert changed.status_code == 204
    assert client.post("/api/auth/login", json={"email": user["email"], "password": "NeuesPasswort1!"}).status_code == 200


def test_archiving_the_partner_shuts_its_portal_without_deleting_logins(client: TestClient, admin_token: str) -> None:
    partner, _, token = portal_login(client, admin_token)
    office = auth_headers(admin_token)
    assert client.post(f"/api/partners/{partner['id']}/archive", headers=office).status_code == 200
    shut = client.get("/api/portal/tasks", headers=auth_headers(token))
    assert shut.status_code == 403
    assert len(client.get(f"/api/partners/{partner['id']}/portal-users", headers=office).json()) == 1
    assert client.post(f"/api/partners/{partner['id']}/unarchive", headers=office).status_code == 200
    assert client.get("/api/portal/tasks", headers=auth_headers(token)).status_code == 200


def test_the_company_phone_from_the_settings_reaches_the_portal(client: TestClient, admin_token: str) -> None:
    office = auth_headers(admin_token)
    current = client.get("/api/admin/settings/company", headers=office).json()
    saved = client.patch("/api/admin/settings/company", headers=office, json={**current, "company_phone": "02302 91 44 0", "company_email": "buero@example.com"})
    assert saved.status_code == 200 and saved.json()["company_phone"] == "02302 91 44 0"
    public = client.get("/api/admin/settings/company/public").json()
    assert public["company_phone"] == "02302 91 44 0"
    _, _, token = portal_login(client, admin_token)
    company = client.get("/api/portal/me", headers=auth_headers(token)).json()["company"]
    assert company["phone"] == "02302 91 44 0" and company["email"] == "buero@example.com"
