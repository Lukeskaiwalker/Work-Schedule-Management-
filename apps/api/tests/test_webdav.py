from __future__ import annotations
import json
import os
from fastapi.testclient import TestClient
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


def test_webdav_projects_root_respects_project_access(client: TestClient, admin_token: str):
    employee = _create_user(client, admin_token, "employee-dav@example.com", "employee")

    visible_project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": "2026-2101", "name": "DAV Visible", "description": "visible", "status": "active"},
    )
    assert visible_project.status_code == 200
    visible_project_id = visible_project.json()["id"]
    visible_project_number = visible_project.json()["project_number"]

    hidden_project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": "2026-2102", "name": "DAV Hidden", "description": "hidden", "status": "active"},
    )
    assert hidden_project.status_code == 200
    hidden_project_number = hidden_project.json()["project_number"]

    member_response = client.post(
        f"/api/projects/{visible_project_id}/members",
        headers=auth_headers(admin_token),
        data={"user_id": employee["id"], "can_manage": "false"},
    )
    assert member_response.status_code == 200

    propfind = client.request(
        "PROPFIND",
        "/api/dav/projects/",
        auth=("employee-dav@example.com", "Password123!"),
        headers={"Depth": "1"},
    )
    assert propfind.status_code == 207
    assert f"/api/dav/projects/{visible_project_number}/" in propfind.text
    assert f"/api/dav/projects/{hidden_project_number}/" not in propfind.text

def test_webdav_projects_root_includes_archive_and_general_collections(client: TestClient, admin_token: str):
    active_project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": "2026-2201", "name": "DAV Active", "description": "active", "status": "active"},
    )
    assert active_project.status_code == 200
    active_project_id = active_project.json()["id"]
    active_project_number = active_project.json()["project_number"]

    archived_project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": "2026-2202", "name": "DAV Archived", "description": "archived", "status": "active"},
    )
    assert archived_project.status_code == 200
    archived_project_id = archived_project.json()["id"]
    archived_project_number = archived_project.json()["project_number"]

    archived_status = client.patch(
        f"/api/projects/{archived_project_id}",
        headers=auth_headers(admin_token),
        json={"status": "archived"},
    )
    assert archived_status.status_code == 200

    archived_upload = client.post(
        f"/api/projects/{archived_project_id}/files",
        headers=auth_headers(admin_token),
        files={"file": ("archived-note.txt", b"archive", "text/plain")},
    )
    assert archived_upload.status_code == 200

    global_report = client.post(
        "/api/construction-reports",
        headers=auth_headers(admin_token),
        json={
            "report_date": "2026-02-20",
            "send_telegram": False,
            "payload": {
                "customer": "General",
                "project_name": "General report",
                "project_number": "",
                "workers": [{"name": "Alex"}],
                "work_done": "General report content",
            },
        },
    )
    assert global_report.status_code == 200
    global_file_name = global_report.json()["attachment_file_name"]

    root_propfind = client.request(
        "PROPFIND",
        "/api/dav/projects/",
        auth=("admin@example.com", "ChangeMe123!"),
        headers={"Depth": "1"},
    )
    assert root_propfind.status_code == 207
    assert "/api/dav/projects/general-projects/" in root_propfind.text
    assert "/api/dav/projects/archive/" in root_propfind.text
    assert f"/api/dav/projects/{active_project_number}/" in root_propfind.text
    assert f"/api/dav/projects/{archived_project_number}/" not in root_propfind.text

    archive_propfind = client.request(
        "PROPFIND",
        "/api/dav/projects/archive/",
        auth=("admin@example.com", "ChangeMe123!"),
        headers={"Depth": "1"},
    )
    assert archive_propfind.status_code == 207
    assert f"/api/dav/projects/archive/{archived_project_id}/" in archive_propfind.text

    archive_project_propfind = client.request(
        "PROPFIND",
        f"/api/dav/projects/archive/{archived_project_id}/",
        auth=("admin@example.com", "ChangeMe123!"),
        headers={"Depth": "1"},
    )
    assert archive_project_propfind.status_code == 207
    assert "archived-note.txt" in archive_project_propfind.text

    general_propfind = client.request(
        "PROPFIND",
        "/api/dav/projects/general-projects/",
        auth=("admin@example.com", "ChangeMe123!"),
        headers={"Depth": "1"},
    )
    assert general_propfind.status_code == 207
    assert "Berichte" in general_propfind.text

    general_reports_propfind = client.request(
        "PROPFIND",
        "/api/dav/projects/general-projects/Berichte/",
        auth=("admin@example.com", "ChangeMe123!"),
        headers={"Depth": "1"},
    )
    assert general_reports_propfind.status_code == 207
    assert global_file_name in general_reports_propfind.text

def test_webdav_protected_folder_blocks_employee_write_and_direct_access(client: TestClient, admin_token: str):
    employee = _create_user(client, admin_token, "employee-protected-dav@example.com", "employee")

    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-5201",
            "name": "Protected DAV",
            "description": "protected",
            "status": "active",
            "customer_name": "Protected Kunde",
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

    private_upload = client.post(
        f"/api/projects/{project_id}/files",
        headers=auth_headers(admin_token),
        data={"folder": "Verwaltung"},
        files={"file": ("private-note.txt", b"private data", "text/plain")},
    )
    assert private_upload.status_code == 200

    employee_mkcol_denied = client.request(
        "MKCOL",
        f"/api/dav/projects/{project_id}/Verwaltung/Subfolder",
        auth=("employee-protected-dav@example.com", "Password123!"),
    )
    assert employee_mkcol_denied.status_code == 403

    employee_put_denied = client.put(
        f"/api/dav/projects/{project_id}/Verwaltung/blocked.txt",
        auth=("employee-protected-dav@example.com", "Password123!"),
        data=b"blocked",
        headers={"Content-Type": "text/plain"},
    )
    assert employee_put_denied.status_code == 403

    employee_propfind_hidden = client.request(
        "PROPFIND",
        f"/api/dav/projects/{project_id}/Verwaltung/",
        auth=("employee-protected-dav@example.com", "Password123!"),
        headers={"Depth": "1"},
    )
    assert employee_propfind_hidden.status_code == 404

    employee_get_hidden = client.get(
        f"/api/dav/projects/{project_id}/Verwaltung/private-note.txt",
        auth=("employee-protected-dav@example.com", "Password123!"),
    )
    assert employee_get_hidden.status_code == 404

    admin_get_ok = client.get(
        f"/api/dav/projects/{project_id}/Verwaltung/private-note.txt",
        auth=("admin@example.com", "ChangeMe123!"),
    )
    assert admin_get_ok.status_code == 200
    assert admin_get_ok.content == b"private data"
