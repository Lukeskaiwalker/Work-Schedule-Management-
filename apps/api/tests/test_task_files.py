"""Files attached to a task — the API surface of docs/FILE_SCOPES.md, "task".

A task file is dual-anchored: it carries ``task_id`` AND the task's project
(or customer) and sits in that scope's ``Aufgaben`` folder. These tests pin
what follows from that: the row shape, who may see and add files (the task's
own rule, not the project's), who may remove them, that losing the task also
loses the bytes, and that the same file is just a project file everywhere
else (file browser, WebDAV, activity feed, the paperclip count on the task).
"""

from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.models.entities import Attachment, CustomerFolder, ProjectActivity, ProjectFolder

ADMIN_AUTH = ("admin@example.com", "ChangeMe123!")
EMPLOYEE_PASSWORD = "Password123!"


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_user(client: TestClient, admin_token: str, email: str, role: str = "employee") -> dict:
    response = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={
            "email": email,
            "password": EMPLOYEE_PASSWORD,
            "full_name": f"{role.title()} User",
            "role": role,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def _login(client: TestClient, email: str) -> str:
    response = client.post("/api/auth/login", json={"email": email, "password": EMPLOYEE_PASSWORD})
    assert response.status_code == 200, response.text
    return response.headers["X-Access-Token"]


def _create_project(client: TestClient, admin_token: str, number: str) -> dict:
    response = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": number,
            "name": f"Task files {number}",
            "description": "task files",
            "status": "active",
            "customer_name": f"Kunde {number}",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def _create_customer(client: TestClient, admin_token: str, name: str) -> dict:
    response = client.post("/api/customers", headers=auth_headers(admin_token), json={"name": name})
    assert response.status_code == 200, response.text
    return response.json()


def _create_task(client: TestClient, admin_token: str, **fields) -> dict:
    payload = {"title": "Zählerschrank tauschen", "task_type": "construction", **fields}
    response = client.post("/api/tasks", headers=auth_headers(admin_token), json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def _remove_membership(client: TestClient, admin_token: str, project_id: int, user_id: int) -> None:
    # Everyone is on every project by default, so "not a member" has to be
    # arranged on purpose — what is under test is the task's own rule.
    response = client.delete(f"/api/projects/{project_id}/members/{user_id}", headers=auth_headers(admin_token))
    assert response.status_code in (200, 204), response.text


def _upload(client: TestClient, token: str, task_id: int, *files: tuple[str, bytes, str]):
    return client.post(
        f"/api/tasks/{task_id}/files",
        headers=auth_headers(token),
        files=[("files", (name, body, content_type)) for name, body, content_type in files],
    )


def _attachment_rows(task_id: int) -> list[Attachment]:
    with SessionLocal() as db:
        rows = db.scalars(select(Attachment).where(Attachment.task_id == task_id).order_by(Attachment.id)).all()
        db.expunge_all()
        return list(rows)


def _next_monday() -> date:
    today = date.today()
    return today + timedelta(days=7 - today.weekday())


# ── row shape and where the file lands ───────────────────────────────────


def test_uploading_to_a_project_task_anchors_the_file_in_the_project(client: TestClient, admin_token: str):
    project = _create_project(client, admin_token, "2026-7001")
    task = _create_task(client, admin_token, project_id=project["id"])

    first = _upload(client, admin_token, task["id"], ("plan.pdf", b"%PDF-plan", "application/pdf"))
    assert first.status_code == 200, first.text
    second = _upload(client, admin_token, task["id"], ("foto.jpg", b"jpeg-bytes", "image/jpeg"))
    assert second.status_code == 200, second.text

    created = first.json() + second.json()
    assert len(created) == 2
    for row in created:
        assert row["task_id"] == task["id"]
        assert row["project_id"] == project["id"]
        assert row["customer_id"] is None
        assert row["folder"] == "Aufgaben"
    assert first.json()[0]["path"] == "Aufgaben/plan.pdf"

    rows = _attachment_rows(task["id"])
    assert [row.file_name for row in rows] == ["plan.pdf", "foto.jpg"]
    for row in rows:
        assert row.project_id == project["id"]
        assert row.customer_id is None
        assert row.folder_path == "Aufgaben"
        assert row.is_encrypted is True
        assert Path(row.stored_path).exists()

    # Newest first on the task itself.
    listing = client.get(f"/api/tasks/{task['id']}/files", headers=auth_headers(admin_token))
    assert listing.status_code == 200, listing.text
    assert [row["file_name"] for row in listing.json()] == ["foto.jpg", "plan.pdf"]

    # …and the same rows are ordinary project files in the "Aufgaben" folder.
    project_files = client.get(f"/api/projects/{project['id']}/files", headers=auth_headers(admin_token))
    assert project_files.status_code == 200
    task_rows = [row for row in project_files.json() if row["task_id"] == task["id"]]
    assert {row["file_name"] for row in task_rows} == {"plan.pdf", "foto.jpg"}
    assert all(row["folder"] == "Aufgaben" for row in task_rows)

    with SessionLocal() as db:
        folder = db.scalars(
            select(ProjectFolder).where(ProjectFolder.project_id == project["id"], ProjectFolder.path == "Aufgaben")
        ).first()
        assert folder is not None
        assert folder.is_protected is False
        activities = db.scalars(
            select(ProjectActivity).where(
                ProjectActivity.project_id == project["id"], ProjectActivity.event_type == "file.uploaded"
            )
        ).all()
        assert {activity.details.get("file_name") for activity in activities} == {"plan.pdf", "foto.jpg"}
        assert all(activity.details.get("task_id") == task["id"] for activity in activities)
        assert all(activity.details.get("folder") == "Aufgaben" for activity in activities)


def test_the_legacy_single_file_field_still_uploads(client: TestClient, admin_token: str):
    project = _create_project(client, admin_token, "2026-7002")
    task = _create_task(client, admin_token, project_id=project["id"])

    response = client.post(
        f"/api/tasks/{task['id']}/files",
        headers=auth_headers(admin_token),
        files={"file": ("notiz.txt", b"notiz", "text/plain")},
    )
    assert response.status_code == 200, response.text
    assert [row["file_name"] for row in response.json()] == ["notiz.txt"]


# ── the paperclip count ──────────────────────────────────────────────────


def test_task_lists_and_the_patch_response_carry_the_attachment_count(client: TestClient, admin_token: str):
    project = _create_project(client, admin_token, "2026-7003")
    monday = _next_monday()
    task = _create_task(client, admin_token, project_id=project["id"], due_date=monday.isoformat())
    assert task["attachment_count"] == 0
    bare = _create_task(client, admin_token, project_id=project["id"], title="ohne Anhang")

    uploaded = _upload(
        client,
        admin_token,
        task["id"],
        ("plan.pdf", b"%PDF-plan", "application/pdf"),
        ("foto.jpg", b"jpeg-bytes", "image/jpeg"),
    )
    assert uploaded.status_code == 200, uploaded.text

    patched = client.patch(
        f"/api/tasks/{task['id']}",
        headers=auth_headers(admin_token),
        json={"description": "Plan liegt bei"},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["attachment_count"] == 2

    listing = client.get(
        f"/api/tasks?view=all_open&project_id={project['id']}",
        headers=auth_headers(admin_token),
    )
    assert listing.status_code == 200, listing.text
    counts = {row["id"]: row["attachment_count"] for row in listing.json()}
    assert counts[task["id"]] == 2
    assert counts[bare["id"]] == 0

    week = client.get(f"/api/planning/week/{monday.isoformat()}", headers=auth_headers(admin_token))
    assert week.status_code == 200, week.text
    on_board = [row for day in week.json()["days"] for row in day["tasks"] if row["id"] == task["id"]]
    assert on_board, "the task must be on its due day"
    assert all(row["attachment_count"] == 2 for row in on_board)

    manual = client.post(
        f"/api/tasks/{task['id']}/customer-confirmation/manual",
        headers=auth_headers(admin_token),
        json={"action": "confirm", "method": "phone"},
    )
    assert manual.status_code == 200, manual.text
    assert manual.json()["attachment_count"] == 2


# ── who may see, add and remove ──────────────────────────────────────────


def test_the_assignee_reaches_task_files_without_project_membership(client: TestClient, admin_token: str):
    project = _create_project(client, admin_token, "2026-7004")
    crew = _create_user(client, admin_token, "crew-task-files@example.com")
    _remove_membership(client, admin_token, project["id"], crew["id"])
    task = _create_task(client, admin_token, project_id=project["id"], assignee_ids=[crew["id"]])
    crew_token = _login(client, "crew-task-files@example.com")

    # Sanity: the project itself stays closed to them (the fallback that would
    # open it is the very task assignment under test, so use a second project).
    other = _create_project(client, admin_token, "2026-7005")
    _remove_membership(client, admin_token, other["id"], crew["id"])
    assert client.get(f"/api/projects/{other['id']}/files", headers=auth_headers(crew_token)).status_code == 403

    uploaded = _upload(client, admin_token, task["id"], ("plan.pdf", b"%PDF-plan", "application/pdf"))
    assert uploaded.status_code == 200, uploaded.text
    plan_id = uploaded.json()[0]["id"]

    listing = client.get(f"/api/tasks/{task['id']}/files", headers=auth_headers(crew_token))
    assert listing.status_code == 200, listing.text
    assert [row["id"] for row in listing.json()] == [plan_id]

    preview = client.get(f"/api/files/{plan_id}/preview", headers=auth_headers(crew_token))
    assert preview.status_code == 200, preview.text
    download = client.get(f"/api/files/{plan_id}/download", headers=auth_headers(crew_token))
    assert download.status_code == 200, download.text
    assert download.content == b"%PDF-plan"

    added = _upload(client, crew_token, task["id"], ("baustelle.jpg", b"jpeg-bytes", "image/jpeg"))
    assert added.status_code == 200, added.text
    assert added.json()[0]["task_id"] == task["id"]
    assert added.json()[0]["project_id"] == project["id"]

    rows = {row.file_name: row for row in _attachment_rows(task["id"])}
    assert rows["baustelle.jpg"].uploaded_by == crew["id"]

    mine = client.get("/api/tasks?view=my", headers=auth_headers(crew_token))
    assert mine.status_code == 200, mine.text
    assert {row["id"]: row["attachment_count"] for row in mine.json()}[task["id"]] == 2


def test_an_unrelated_employee_is_denied_task_files(client: TestClient, admin_token: str):
    project = _create_project(client, admin_token, "2026-7006")
    outsider = _create_user(client, admin_token, "outsider-task-files@example.com")
    _remove_membership(client, admin_token, project["id"], outsider["id"])
    task = _create_task(client, admin_token, project_id=project["id"])
    outsider_token = _login(client, "outsider-task-files@example.com")

    uploaded = _upload(client, admin_token, task["id"], ("plan.pdf", b"%PDF-plan", "application/pdf"))
    assert uploaded.status_code == 200, uploaded.text
    plan_id = uploaded.json()[0]["id"]

    assert client.get(f"/api/tasks/{task['id']}/files", headers=auth_headers(outsider_token)).status_code == 403
    denied_upload = _upload(client, outsider_token, task["id"], ("fremd.txt", b"fremd", "text/plain"))
    assert denied_upload.status_code == 403, denied_upload.text
    assert client.get(f"/api/files/{plan_id}/preview", headers=auth_headers(outsider_token)).status_code == 403
    assert client.get(f"/api/files/{plan_id}/download", headers=auth_headers(outsider_token)).status_code == 403
    assert len(_attachment_rows(task["id"])) == 1


def test_who_may_delete_a_task_file(client: TestClient, admin_token: str):
    project = _create_project(client, admin_token, "2026-7007")
    crew = _create_user(client, admin_token, "crew-deletes-task-files@example.com")
    _remove_membership(client, admin_token, project["id"], crew["id"])
    task = _create_task(client, admin_token, project_id=project["id"], assignee_ids=[crew["id"]])
    crew_token = _login(client, "crew-deletes-task-files@example.com")

    admins_file = _upload(client, admin_token, task["id"], ("plan.pdf", b"%PDF-plan", "application/pdf"))
    assert admins_file.status_code == 200, admins_file.text
    admins_id = admins_file.json()[0]["id"]
    own_file = _upload(client, crew_token, task["id"], ("baustelle.jpg", b"jpeg-bytes", "image/jpeg"))
    assert own_file.status_code == 200, own_file.text
    own_id = own_file.json()[0]["id"]
    own_path = {row.id: row.stored_path for row in _attachment_rows(task["id"])}[own_id]

    # The uploader takes their own photo back, but not the office's plan.
    assert client.delete(f"/api/files/{admins_id}", headers=auth_headers(crew_token)).status_code == 403
    assert client.delete(f"/api/files/{own_id}", headers=auth_headers(crew_token)).status_code == 204
    assert not Path(own_path).exists()
    assert [row.id for row in _attachment_rows(task["id"])] == [admins_id]

    # files:manage deletes anything.
    assert client.delete(f"/api/files/{admins_id}", headers=auth_headers(admin_token)).status_code == 204
    assert _attachment_rows(task["id"]) == []


# ── losing the task ──────────────────────────────────────────────────────


def test_deleting_the_task_removes_the_rows_and_the_bytes(client: TestClient, admin_token: str):
    project = _create_project(client, admin_token, "2026-7008")
    task = _create_task(client, admin_token, project_id=project["id"])
    uploaded = _upload(
        client,
        admin_token,
        task["id"],
        ("plan.pdf", b"%PDF-plan", "application/pdf"),
        ("foto.jpg", b"jpeg-bytes", "image/jpeg"),
    )
    assert uploaded.status_code == 200, uploaded.text
    ids = [row["id"] for row in uploaded.json()]
    paths = [row.stored_path for row in _attachment_rows(task["id"])]
    assert len(paths) == 2 and all(Path(path).exists() for path in paths)

    deleted = client.delete(f"/api/tasks/{task['id']}", headers=auth_headers(admin_token))
    assert deleted.status_code == 200, deleted.text

    with SessionLocal() as db:
        assert db.scalars(select(Attachment.id).where(Attachment.id.in_(ids))).all() == []
    assert all(not Path(path).exists() for path in paths)
    assert client.get(f"/api/tasks/{task['id']}/files", headers=auth_headers(admin_token)).status_code == 404


# ── customer-only tasks ──────────────────────────────────────────────────


def test_a_customer_only_task_files_into_the_customer_scope(client: TestClient, admin_token: str):
    customer = _create_customer(client, admin_token, "Rückruf Kunde")
    task = _create_task(client, admin_token, customer_id=customer["id"], title="Angebot nachfassen", task_type="office")
    assert task["project_id"] is None

    uploaded = _upload(client, admin_token, task["id"], ("angebot.pdf", b"%PDF-angebot", "application/pdf"))
    assert uploaded.status_code == 200, uploaded.text
    row = uploaded.json()[0]
    assert row["task_id"] == task["id"]
    assert row["project_id"] is None
    assert row["customer_id"] == customer["id"]
    assert row["folder"] == "Aufgaben"

    rows = _attachment_rows(task["id"])
    assert len(rows) == 1
    assert rows[0].customer_id == customer["id"]
    assert rows[0].project_id is None
    assert rows[0].folder_path == "Aufgaben"

    with SessionLocal() as db:
        folder = db.scalars(
            select(CustomerFolder).where(CustomerFolder.customer_id == customer["id"], CustomerFolder.path == "Aufgaben")
        ).first()
        assert folder is not None
        assert folder.is_protected is False

    listing = client.get(f"/api/tasks/{task['id']}/files", headers=auth_headers(admin_token))
    assert listing.status_code == 200, listing.text
    assert [entry["id"] for entry in listing.json()] == [row["id"]]
    assert client.get(f"/api/files/{row['id']}/preview", headers=auth_headers(admin_token)).status_code == 200


# ── WebDAV ───────────────────────────────────────────────────────────────


def test_task_files_appear_in_the_project_webdav_tree(client: TestClient, admin_token: str):
    project = _create_project(client, admin_token, "2026-7009")
    task = _create_task(client, admin_token, project_id=project["id"])
    uploaded = _upload(client, admin_token, task["id"], ("plan.pdf", b"%PDF-plan", "application/pdf"))
    assert uploaded.status_code == 200, uploaded.text
    ref = project["project_number"]

    root = client.request("PROPFIND", f"/api/dav/projects/{ref}/", auth=ADMIN_AUTH, headers={"Depth": "1"})
    assert root.status_code == 207, root.text
    assert f"/api/dav/projects/{ref}/Aufgaben/" in root.text

    folder = client.request("PROPFIND", f"/api/dav/projects/{ref}/Aufgaben/", auth=ADMIN_AUTH, headers={"Depth": "1"})
    assert folder.status_code == 207, folder.text
    assert "plan.pdf" in folder.text

    fetched = client.get(f"/api/dav/projects/{ref}/Aufgaben/plan.pdf", auth=ADMIN_AUTH)
    assert fetched.status_code == 200
    assert fetched.content == b"%PDF-plan"


# ── refusals ─────────────────────────────────────────────────────────────


def test_empty_batches_and_unknown_tasks_are_refused(client: TestClient, admin_token: str):
    project = _create_project(client, admin_token, "2026-7010")
    task = _create_task(client, admin_token, project_id=project["id"])

    nothing = client.post(f"/api/tasks/{task['id']}/files", headers=auth_headers(admin_token))
    assert nothing.status_code == 400, nothing.text
    only_empty = _upload(client, admin_token, task["id"], ("leer.txt", b"", "text/plain"))
    assert only_empty.status_code == 400, only_empty.text
    # One empty file in a batch is skipped, not fatal.
    mixed = _upload(client, admin_token, task["id"], ("leer.txt", b"", "text/plain"), ("voll.txt", b"voll", "text/plain"))
    assert mixed.status_code == 200, mixed.text
    assert [row["file_name"] for row in mixed.json()] == ["voll.txt"]

    assert client.get("/api/tasks/999999/files", headers=auth_headers(admin_token)).status_code == 404
    assert _upload(client, admin_token, 999999, ("plan.pdf", b"%PDF", "application/pdf")).status_code == 404
