from __future__ import annotations
import json
import os
from pathlib import Path

from fastapi.testclient import TestClient

from app.core.db import SessionLocal
from app.models.entities import Attachment
def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}



def _create_user(client: TestClient, admin_token: str, email: str, role: str):
    response = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={
            "email": email,
            "password": "Password123!",
            "full_name": f"{role.title()} User",
            "role": role,
        },
    )
    assert response.status_code == 200
    return response.json()

def _login(client: TestClient, email: str):
    response = client.post("/api/auth/login", json={"email": email, "password": "Password123!"})
    assert response.status_code == 200
    return response.headers["X-Access-Token"]


def test_project_files_webdav_mount_flow(client: TestClient, admin_token: str):
    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-2001",
            "name": "WebDAV Project",
            "description": "dav",
            "status": "active",
            "customer_name": "Musterkunde",
        },
    )
    assert project.status_code == 200
    project_id = project.json()["id"]
    project_number = project.json()["project_number"]

    employee = _create_user(client, admin_token, "employee-dav-mount@example.com", "employee")
    member = client.post(
        f"/api/projects/{project_id}/members",
        headers=auth_headers(admin_token),
        data={"user_id": employee["id"], "can_manage": "false"},
    )
    assert member.status_code == 200

    put_response = client.put(
        f"/api/dav/projects/{project_id}/spec.txt",
        auth=("admin@example.com", "ChangeMe123!"),
        data=b"shared spec",
        headers={"Content-Type": "text/plain"},
    )
    assert put_response.status_code == 201

    propfind = client.request(
        "PROPFIND",
        f"/api/dav/projects/{project_id}",
        auth=("admin@example.com", "ChangeMe123!"),
        headers={"Depth": "1"},
    )
    assert propfind.status_code == 207
    assert "spec.txt" in propfind.text
    assert "<D:getcontentlength>11</D:getcontentlength>" in propfind.text

    propfind_projects_root = client.request(
        "PROPFIND",
        "/api/dav/projects/",
        auth=("admin@example.com", "ChangeMe123!"),
        headers={"Depth": "1"},
    )
    assert propfind_projects_root.status_code == 207
    assert f"/api/dav/projects/{project_number}/" in propfind_projects_root.text
    assert "Musterkunde" in propfind_projects_root.text

    propfind_trailing_slash = client.request(
        "PROPFIND",
        f"/api/dav/projects/{project_id}/",
        auth=("admin@example.com", "ChangeMe123!"),
        headers={"Depth": "1"},
    )
    assert propfind_trailing_slash.status_code == 207
    assert "spec.txt" in propfind_trailing_slash.text

    get_response = client.get(
        f"/api/dav/projects/{project_id}/spec.txt",
        auth=("admin@example.com", "ChangeMe123!"),
    )
    assert get_response.status_code == 200
    assert get_response.content == b"shared spec"

    employee_propfind_number = client.request(
        "PROPFIND",
        f"/api/dav/projects/{project_number}/",
        auth=("employee-dav-mount@example.com", "Password123!"),
        headers={"Depth": "1"},
    )
    assert employee_propfind_number.status_code == 207
    assert "spec.txt" in employee_propfind_number.text

    employee_put_by_number = client.put(
        f"/api/dav/projects/{project_number}/crew-note.txt",
        auth=("employee-dav-mount@example.com", "Password123!"),
        data=b"crew-visible",
        headers={"Content-Type": "text/plain"},
    )
    assert employee_put_by_number.status_code == 201

    admin_get_by_id = client.get(
        f"/api/dav/projects/{project_id}/crew-note.txt",
        auth=("admin@example.com", "ChangeMe123!"),
    )
    assert admin_get_by_id.status_code == 200
    assert admin_get_by_id.content == b"crew-visible"

def test_preview_falls_back_to_octet_stream_for_invalid_stored_content_type(client: TestClient, admin_token: str):
    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": "2026-2002", "name": "Preview MIME", "description": "mime", "status": "active"},
    )
    assert project.status_code == 200
    project_id = project.json()["id"]

    put_response = client.put(
        f"/api/dav/projects/{project_id}/broken-mime.bin",
        auth=("admin@example.com", "ChangeMe123!"),
        data=b"binary payload",
        headers={"Content-Type": "definitely-not-a-mime"},
    )
    assert put_response.status_code == 201

    files = client.get(f"/api/projects/{project_id}/files", headers=auth_headers(admin_token))
    assert files.status_code == 200
    uploaded = next((row for row in files.json() if row["file_name"] == "broken-mime.bin"), None)
    assert uploaded is not None

    preview = client.get(f"/api/files/{uploaded['id']}/preview", headers=auth_headers(admin_token))
    assert preview.status_code == 200
    assert preview.content == b"binary payload"
    assert preview.headers.get("content-type", "").startswith("application/octet-stream")


def test_corrupted_chunked_attachment_returns_http_error_instead_of_stream_abort(
    client: TestClient,
    admin_token: str,
) -> None:
    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": "2026-2004", "name": "Corrupt Attachment", "description": "files", "status": "active"},
    )
    assert project.status_code == 200
    project_id = project.json()["id"]

    upload = client.post(
        f"/api/projects/{project_id}/files",
        headers=auth_headers(admin_token),
        files={"file": ("corrupt-me.txt", b"original payload", "text/plain")},
    )
    assert upload.status_code == 200
    attachment_id = int(upload.json()["id"])

    with SessionLocal() as db:
        attachment = db.get(Attachment, attachment_id)
        assert attachment is not None
        stored_path = Path(attachment.stored_path)

    stored_path.write_bytes(stored_path.read_bytes()[:-8])

    preview = client.get(f"/api/files/{attachment_id}/preview", headers=auth_headers(admin_token))
    assert preview.status_code == 409
    assert preview.json()["detail"] == "Stored file payload is corrupted; please re-upload the file"

def test_project_file_upload_rejects_empty_payload(client: TestClient, admin_token: str):
    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-2003",
            "name": "Empty Upload Guard",
            "description": "files",
            "status": "active",
        },
    )
    assert project.status_code == 200
    project_id = project.json()["id"]

    upload = client.post(
        f"/api/projects/{project_id}/files",
        headers=auth_headers(admin_token),
        files={"file": ("empty.txt", b"", "text/plain")},
    )
    assert upload.status_code == 400
    assert upload.json().get("detail") == "File body is required"

def test_project_files_folder_visibility_and_webdav_structure(client: TestClient, admin_token: str):
    employee = _create_user(client, admin_token, "employee-folders@example.com", "employee")
    employee_token = _login(client, "employee-folders@example.com")

    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-5101",
            "name": "Folder Test",
            "description": "folders",
            "status": "active",
            "customer_name": "Folder Kunde",
        },
    )
    assert project.status_code == 200
    project_id = project.json()["id"]

    member = client.post(
        f"/api/projects/{project_id}/members",
        headers=auth_headers(admin_token),
        data={"user_id": employee["id"], "can_manage": "false"},
    )
    assert member.status_code == 200

    create_public_folder = client.post(
        f"/api/projects/{project_id}/folders",
        headers=auth_headers(admin_token),
        json={"path": "Bilder/Tag1"},
    )
    assert create_public_folder.status_code == 200
    assert create_public_folder.json()["path"] == "Bilder/Tag1"

    public_upload = client.post(
        f"/api/projects/{project_id}/files",
        headers=auth_headers(admin_token),
        data={"folder": "Bilder/Tag1"},
        files={"file": ("public-note.txt", b"public", "text/plain")},
    )
    assert public_upload.status_code == 200
    assert public_upload.json()["folder"] == "Bilder/Tag1"
    assert public_upload.json()["path"] == "Bilder/Tag1/public-note.txt"

    auto_image_upload = client.post(
        f"/api/projects/{project_id}/files",
        headers=auth_headers(admin_token),
        files={"file": ("photo-auto.jpg", b"photo-bytes", "image/jpeg")},
    )
    assert auto_image_upload.status_code == 200
    assert auto_image_upload.json()["folder"] == "Bilder"

    auto_pdf_upload = client.post(
        f"/api/projects/{project_id}/files",
        headers=auth_headers(admin_token),
        files={"file": ("report-auto.pdf", b"%PDF-sample", "application/pdf")},
    )
    assert auto_pdf_upload.status_code == 200
    assert auto_pdf_upload.json()["folder"] == "Berichte"

    root_upload = client.post(
        f"/api/projects/{project_id}/files",
        headers=auth_headers(admin_token),
        data={"folder": "/"},
        files={"file": ("root-note.txt", b"root", "text/plain")},
    )
    assert root_upload.status_code == 200
    assert root_upload.json()["folder"] == ""
    assert root_upload.json()["path"] == "root-note.txt"

    protected_upload = client.post(
        f"/api/projects/{project_id}/files",
        headers=auth_headers(admin_token),
        data={"folder": "Verwaltung"},
        files={"file": ("private-note.txt", b"private", "text/plain")},
    )
    assert protected_upload.status_code == 200

    protected_upload_denied = client.post(
        f"/api/projects/{project_id}/files",
        headers=auth_headers(employee_token),
        data={"folder": "Verwaltung"},
        files={"file": ("blocked.txt", b"blocked", "text/plain")},
    )
    assert protected_upload_denied.status_code == 403

    employee_files = client.get(f"/api/projects/{project_id}/files", headers=auth_headers(employee_token))
    assert employee_files.status_code == 200
    assert all(not str(row["folder"]).startswith("Verwaltung") for row in employee_files.json())
    assert any(str(row["folder"]).startswith("Bilder") for row in employee_files.json())

    grant_protected_access = client.put(
        f"/api/admin/user-permissions/{employee['id']}",
        headers=auth_headers(admin_token),
        json={"extra": ["files:view_protected"], "denied": []},
    )
    assert grant_protected_access.status_code == 200

    protected_upload_allowed = client.post(
        f"/api/projects/{project_id}/files",
        headers=auth_headers(employee_token),
        data={"folder": "Verwaltung"},
        files={"file": ("allowed.txt", b"allowed", "text/plain")},
    )
    assert protected_upload_allowed.status_code == 200

    employee_files_with_permission = client.get(
        f"/api/projects/{project_id}/files",
        headers=auth_headers(employee_token),
    )
    assert employee_files_with_permission.status_code == 200
    assert any(str(row["folder"]).startswith("Verwaltung") for row in employee_files_with_permission.json())

    admin_files = client.get(f"/api/projects/{project_id}/files", headers=auth_headers(admin_token))
    assert admin_files.status_code == 200
    assert any(str(row["folder"]).startswith("Verwaltung") for row in admin_files.json())

    dav_root = client.request(
        "PROPFIND",
        f"/api/dav/projects/{project_id}/",
        auth=("employee-folders@example.com", "Password123!"),
        headers={"Depth": "1"},
    )
    assert dav_root.status_code == 207
    assert "Bilder" in dav_root.text
    assert "Verwaltung" in dav_root.text
