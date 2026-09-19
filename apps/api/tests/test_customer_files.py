"""Customer-level files — the REST half of docs/FILE_SCOPES.md.

``/customers/{id}/folders`` and ``/customers/{id}/files`` mirror the project
endpoints; preview, download and delete go through the shared ``/files/{id}``
routes, whose customer branch is exercised here too. The access rule is
borrowed from the projects: an employee sees a customer's files exactly when
they can see one of the customer's projects, so every employee case below is
set up by adding or removing one project membership.
"""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.models.entities import Attachment, CustomerFolder

EMPLOYEE_PASSWORD = "Password123!"


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_user(client: TestClient, admin_token: str, email: str, role: str = "employee") -> dict:
    response = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={"email": email, "password": EMPLOYEE_PASSWORD, "full_name": f"{role.title()} User", "role": role},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _login(client: TestClient, email: str) -> str:
    response = client.post("/api/auth/login", json={"email": email, "password": EMPLOYEE_PASSWORD})
    assert response.status_code == 200, response.text
    return response.headers["X-Access-Token"]


def _create_customer(client: TestClient, admin_token: str, name: str) -> dict:
    response = client.post("/api/customers", headers=auth_headers(admin_token), json={"name": name})
    assert response.status_code == 200, response.text
    return response.json()


def _create_project(client: TestClient, admin_token: str, number: str, customer_id: int) -> dict:
    response = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": number, "name": f"Projekt {number}", "status": "active", "customer_id": customer_id},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _customer_with_project(client: TestClient, admin_token: str, *, name: str, number: str) -> tuple[int, int]:
    customer = _create_customer(client, admin_token, name)
    project = _create_project(client, admin_token, number, customer["id"])
    return customer["id"], project["id"]


def _remove_member(client: TestClient, admin_token: str, project_id: int, user_id: int) -> None:
    # New users are put on every project by default, so "no project of that
    # customer" has to be made true on purpose.
    response = client.delete(f"/api/projects/{project_id}/members/{user_id}", headers=auth_headers(admin_token))
    assert response.status_code in (200, 204), response.text


def _add_member(client: TestClient, admin_token: str, project_id: int, user_id: int) -> None:
    response = client.post(
        f"/api/projects/{project_id}/members",
        headers=auth_headers(admin_token),
        json={"user_id": user_id, "can_manage": False},
    )
    assert response.status_code == 200, response.text


def _upload(client: TestClient, token: str, customer_id: int, name: str, body: bytes, *, folder: str | None = None) -> dict:
    data = {"folder": folder} if folder is not None else None
    response = client.post(
        f"/api/customers/{customer_id}/files",
        headers=auth_headers(token),
        data=data,
        files={"file": (name, body, "text/plain")},
    )
    assert response.status_code == 200, response.text
    return response.json()[0]


def _stored_path(attachment_id: int) -> Path:
    with SessionLocal() as db:
        row = db.get(Attachment, attachment_id)
        assert row is not None
        return Path(row.stored_path)


def test_a_fresh_customer_lists_its_default_folders_by_permission(client: TestClient, admin_token: str):
    customer_id, _ = _customer_with_project(client, admin_token, name="Folder Kunde", number="2026-CF-1")
    employee = _create_user(client, admin_token, "cf-folders@example.com")
    employee_token = _login(client, "cf-folders@example.com")

    admin_folders = client.get(f"/api/customers/{customer_id}/folders", headers=auth_headers(admin_token))
    assert admin_folders.status_code == 200, admin_folders.text
    assert [(row["path"], row["is_protected"]) for row in admin_folders.json()] == [
        ("Dokumente", False),
        ("Verwaltung", True),
    ]

    employee_folders = client.get(f"/api/customers/{customer_id}/folders", headers=auth_headers(employee_token))
    assert employee_folders.status_code == 200, employee_folders.text
    assert [row["path"] for row in employee_folders.json()] == ["Dokumente"]

    # Seeded, not just rendered: the WebDAV tree and later uploads rely on the rows.
    with SessionLocal() as db:
        seeded = db.scalars(select(CustomerFolder.path).where(CustomerFolder.customer_id == customer_id)).all()
    assert sorted(seeded) == ["Dokumente", "Verwaltung"]

    granted = client.put(
        f"/api/admin/user-permissions/{employee['id']}",
        headers=auth_headers(admin_token),
        json={"extra": ["files:view_protected"], "denied": []},
    )
    assert granted.status_code == 200, granted.text
    with_permission = client.get(f"/api/customers/{customer_id}/folders", headers=auth_headers(employee_token))
    assert [row["path"] for row in with_permission.json()] == ["Dokumente", "Verwaltung"]


def test_creating_a_folder_registers_every_segment(client: TestClient, admin_token: str):
    customer_id, _ = _customer_with_project(client, admin_token, name="Ordner Kunde", number="2026-CF-2")
    _create_user(client, admin_token, "cf-mkdir@example.com")
    employee_token = _login(client, "cf-mkdir@example.com")

    created = client.post(
        f"/api/customers/{customer_id}/folders",
        headers=auth_headers(admin_token),
        json={"path": " Pläne/2026/ "},
    )
    assert created.status_code == 200, created.text
    assert created.json() == {"path": "Pläne/2026", "is_protected": False}
    paths = [row["path"] for row in client.get(f"/api/customers/{customer_id}/folders", headers=auth_headers(admin_token)).json()]
    assert "Pläne" in paths and "Pläne/2026" in paths

    invalid = client.post(f"/api/customers/{customer_id}/folders", headers=auth_headers(admin_token), json={"path": "../x"})
    assert invalid.status_code == 400

    employee_protected = client.post(
        f"/api/customers/{customer_id}/folders",
        headers=auth_headers(employee_token),
        json={"path": "Verwaltung/Intern"},
    )
    assert employee_protected.status_code == 403

    admin_protected = client.post(
        f"/api/customers/{customer_id}/folders",
        headers=auth_headers(admin_token),
        json={"path": "Verwaltung/Intern"},
    )
    assert admin_protected.status_code == 200, admin_protected.text
    assert admin_protected.json() == {"path": "Verwaltung/Intern", "is_protected": True}


def test_uploads_land_on_the_customer_in_the_requested_folder(client: TestClient, admin_token: str):
    customer_id, _ = _customer_with_project(client, admin_token, name="Upload Kunde", number="2026-CF-3")

    multi = client.post(
        f"/api/customers/{customer_id}/files",
        headers=auth_headers(admin_token),
        data={"folder": "Dokumente"},
        files=[
            ("files", ("vertrag.pdf", b"%PDF-vertrag", "application/pdf")),
            ("files", ("foto.jpg", b"jpeg-bytes", "image/jpeg")),
        ],
    )
    assert multi.status_code == 200, multi.text
    rows = multi.json()
    assert [row["file_name"] for row in rows] == ["vertrag.pdf", "foto.jpg"]
    assert all(row["customer_id"] == customer_id for row in rows)
    assert all(row["project_id"] is None and row["task_id"] is None for row in rows)
    assert all(row["folder"] == "Dokumente" for row in rows)
    assert rows[0]["path"] == "Dokumente/vertrag.pdf"

    # The legacy single ``file`` part still works, and "/" means the root.
    root_note = _upload(client, admin_token, customer_id, "notiz.txt", b"root", folder="/")
    assert root_note["folder"] == "" and root_note["path"] == "notiz.txt"

    # No folder at all is the root as well: a customer's photo is not sorted
    # into "Bilder" the way a project's is — there is no such default here.
    unsorted = client.post(
        f"/api/customers/{customer_id}/files",
        headers=auth_headers(admin_token),
        files={"file": ("bild.jpg", b"jpeg", "image/jpeg")},
    )
    assert unsorted.status_code == 200, unsorted.text
    assert unsorted.json()[0]["folder"] == ""

    # An upload into a folder nobody registered creates it, every segment.
    nested = _upload(client, admin_token, customer_id, "brief.txt", b"brief", folder="Briefe/2026")
    assert nested["folder"] == "Briefe/2026"
    folder_paths = [row["path"] for row in client.get(f"/api/customers/{customer_id}/folders", headers=auth_headers(admin_token)).json()]
    assert "Briefe" in folder_paths and "Briefe/2026" in folder_paths

    with SessionLocal() as db:
        stored = db.scalars(select(Attachment).where(Attachment.customer_id == customer_id)).all()
    assert len(stored) == 5
    assert all(row.project_id is None and row.is_encrypted for row in stored)
    assert all(Path(row.stored_path).exists() for row in stored)

    listing = client.get(f"/api/customers/{customer_id}/files", headers=auth_headers(admin_token))
    assert listing.status_code == 200, listing.text
    assert [row["file_name"] for row in listing.json()] == ["brief.txt", "bild.jpg", "notiz.txt", "foto.jpg", "vertrag.pdf"]


def test_uploads_without_a_usable_body_are_rejected(client: TestClient, admin_token: str):
    customer_id, _ = _customer_with_project(client, admin_token, name="Leer Kunde", number="2026-CF-4")

    nothing = client.post(f"/api/customers/{customer_id}/files", headers=auth_headers(admin_token), data={"folder": ""})
    assert nothing.status_code == 400
    assert nothing.json()["detail"] == "At least one file is required"

    empty = client.post(
        f"/api/customers/{customer_id}/files",
        headers=auth_headers(admin_token),
        files={"file": ("empty.txt", b"", "text/plain")},
    )
    assert empty.status_code == 400
    assert empty.json()["detail"] == "No valid file bodies in the request"

    # One zero-byte placeholder in a batch is skipped, not fatal.
    mixed = client.post(
        f"/api/customers/{customer_id}/files",
        headers=auth_headers(admin_token),
        files=[("files", ("real.txt", b"real", "text/plain")), ("files", ("empty.txt", b"", "text/plain"))],
    )
    assert mixed.status_code == 200, mixed.text
    assert [row["file_name"] for row in mixed.json()] == ["real.txt"]


def test_preview_and_download_serve_customer_files(client: TestClient, admin_token: str):
    customer_id, _ = _customer_with_project(client, admin_token, name="Vorschau Kunde", number="2026-CF-5")
    uploaded = _upload(client, admin_token, customer_id, "hinweis.txt", b"customer bytes", folder="Dokumente")

    preview = client.get(f"/api/files/{uploaded['id']}/preview", headers=auth_headers(admin_token))
    assert preview.status_code == 200, preview.text
    assert preview.content == b"customer bytes"
    assert "inline" in preview.headers.get("content-disposition", "")

    download = client.get(f"/api/files/{uploaded['id']}/download", headers=auth_headers(admin_token))
    assert download.status_code == 200, download.text
    assert download.content == b"customer bytes"
    assert "attachment" in download.headers.get("content-disposition", "")


def test_an_employee_without_a_project_of_the_customer_is_locked_out(client: TestClient, admin_token: str):
    customer_id, project_id = _customer_with_project(client, admin_token, name="Fremd Kunde", number="2026-CF-6")
    uploaded = _upload(client, admin_token, customer_id, "intern.txt", b"customer", folder="Dokumente")
    employee = _create_user(client, admin_token, "cf-outsider@example.com")
    _remove_member(client, admin_token, project_id, employee["id"])
    employee_token = _login(client, "cf-outsider@example.com")

    assert client.get(f"/api/customers/{customer_id}/files", headers=auth_headers(employee_token)).status_code == 403
    assert client.get(f"/api/customers/{customer_id}/folders", headers=auth_headers(employee_token)).status_code == 403
    denied_upload = client.post(
        f"/api/customers/{customer_id}/files",
        headers=auth_headers(employee_token),
        files={"file": ("mine.txt", b"mine", "text/plain")},
    )
    assert denied_upload.status_code == 403
    assert client.get(f"/api/files/{uploaded['id']}/preview", headers=auth_headers(employee_token)).status_code == 403
    assert client.get(f"/api/files/{uploaded['id']}/download", headers=auth_headers(employee_token)).status_code == 403

    # One project of the customer is all it takes.
    _add_member(client, admin_token, project_id, employee["id"])
    listing = client.get(f"/api/customers/{customer_id}/files", headers=auth_headers(employee_token))
    assert listing.status_code == 200, listing.text
    assert [row["file_name"] for row in listing.json()] == ["intern.txt"]
    assert client.get(f"/api/files/{uploaded['id']}/preview", headers=auth_headers(employee_token)).status_code == 200


def test_verwaltung_is_closed_to_employees(client: TestClient, admin_token: str):
    customer_id, _ = _customer_with_project(client, admin_token, name="Verwaltung Kunde", number="2026-CF-7")
    _create_user(client, admin_token, "cf-member@example.com")
    employee_token = _login(client, "cf-member@example.com")

    for folder in ("Verwaltung", "verwaltung/intern"):
        denied = client.post(
            f"/api/customers/{customer_id}/files",
            headers=auth_headers(employee_token),
            data={"folder": folder},
            files={"file": ("blocked.txt", b"blocked", "text/plain")},
        )
        assert denied.status_code == 403, folder

    secret = _upload(client, admin_token, customer_id, "geheim.txt", b"secret", folder="Verwaltung")
    visible = _upload(client, admin_token, customer_id, "offen.txt", b"open", folder="Dokumente")

    employee_listing = client.get(f"/api/customers/{customer_id}/files", headers=auth_headers(employee_token))
    assert employee_listing.status_code == 200, employee_listing.text
    assert [row["file_name"] for row in employee_listing.json()] == ["offen.txt"]
    assert client.get(f"/api/files/{secret['id']}/preview", headers=auth_headers(employee_token)).status_code == 403
    assert client.get(f"/api/files/{visible['id']}/preview", headers=auth_headers(employee_token)).status_code == 200

    admin_listing = client.get(f"/api/customers/{customer_id}/files", headers=auth_headers(admin_token))
    assert {row["file_name"] for row in admin_listing.json()} == {"geheim.txt", "offen.txt"}


def test_delete_needs_files_manage_and_removes_the_bytes(client: TestClient, admin_token: str):
    customer_id, _ = _customer_with_project(client, admin_token, name="Lösch Kunde", number="2026-CF-8")
    _create_user(client, admin_token, "cf-deleter@example.com")
    employee_token = _login(client, "cf-deleter@example.com")
    uploaded = _upload(client, admin_token, customer_id, "weg.txt", b"gone soon", folder="Dokumente")
    stored_path = _stored_path(uploaded["id"])
    assert stored_path.exists()

    employee_delete = client.delete(f"/api/files/{uploaded['id']}", headers=auth_headers(employee_token))
    assert employee_delete.status_code == 403
    assert stored_path.exists()

    admin_delete = client.delete(f"/api/files/{uploaded['id']}", headers=auth_headers(admin_token))
    assert admin_delete.status_code == 204, admin_delete.text
    assert not stored_path.exists()
    with SessionLocal() as db:
        assert db.get(Attachment, uploaded["id"]) is None
    assert client.get(f"/api/files/{uploaded['id']}/preview", headers=auth_headers(admin_token)).status_code == 404
    assert client.get(f"/api/customers/{customer_id}/files", headers=auth_headers(admin_token)).json() == []


def test_an_unknown_customer_is_404_everywhere(client: TestClient, admin_token: str):
    missing = 999_999
    assert client.get(f"/api/customers/{missing}/folders", headers=auth_headers(admin_token)).status_code == 404
    assert client.get(f"/api/customers/{missing}/files", headers=auth_headers(admin_token)).status_code == 404
    create_folder = client.post(f"/api/customers/{missing}/folders", headers=auth_headers(admin_token), json={"path": "X"})
    assert create_folder.status_code == 404
    upload = client.post(
        f"/api/customers/{missing}/files",
        headers=auth_headers(admin_token),
        files={"file": ("x.txt", b"x", "text/plain")},
    )
    assert upload.status_code == 404
