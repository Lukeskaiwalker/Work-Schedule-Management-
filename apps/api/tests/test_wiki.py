from __future__ import annotations
import json
import os
from urllib.parse import quote
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

def _login(client: TestClient, email: str):
    response = client.post("/api/auth/login", json={"email": email, "password": "Password123!"})
    assert response.status_code == 200
    return response.headers["X-Access-Token"]


def test_wiki_pages_crud_and_permissions(client: TestClient, admin_token: str):
    _create_user(client, admin_token, "planner3@example.com", "planning")
    _create_user(client, admin_token, "employee6@example.com", "employee")
    planner_token = _login(client, "planner3@example.com")
    employee_token = _login(client, "employee6@example.com")

    create = client.post(
        "/api/wiki/pages",
        headers=auth_headers(planner_token),
        json={
            "title": "Fronius GEN24 Quick Guide",
            "category": "Inverter",
            "content": "Reset sequence and LED meanings.",
        },
    )
    assert create.status_code == 200
    page = create.json()
    assert page["slug"] == "fronius-gen24-quick-guide"
    page_id = page["id"]

    list_as_employee = client.get("/api/wiki/pages?q=Fronius", headers=auth_headers(employee_token))
    assert list_as_employee.status_code == 200
    assert any(entry["id"] == page_id for entry in list_as_employee.json())

    get_as_employee = client.get(f"/api/wiki/pages/{page_id}", headers=auth_headers(employee_token))
    assert get_as_employee.status_code == 200
    assert get_as_employee.json()["title"] == "Fronius GEN24 Quick Guide"

    employee_create_denied = client.post(
        "/api/wiki/pages",
        headers=auth_headers(employee_token),
        json={"title": "Not allowed", "content": "x"},
    )
    assert employee_create_denied.status_code == 403

    update = client.patch(
        f"/api/wiki/pages/{page_id}",
        headers=auth_headers(planner_token),
        json={"title": "Fronius GEN24 Service Guide", "content": "Updated"},
    )
    assert update.status_code == 200
    assert update.json()["slug"] == "fronius-gen24-service-guide"
    assert update.json()["content"] == "Updated"

    delete = client.delete(f"/api/wiki/pages/{page_id}", headers=auth_headers(planner_token))
    assert delete.status_code == 200
    assert delete.json()["ok"] is True

    gone = client.get(f"/api/wiki/pages/{page_id}", headers=auth_headers(employee_token))
    assert gone.status_code == 404

def test_wiki_library_files_search_and_preview(client: TestClient, admin_token: str):
    _create_user(client, admin_token, "employee7@example.com", "employee")
    employee_token = _login(client, "employee7@example.com")

    wiki_root = os.environ["WIKI_ROOT_DIR"]
    html_rel = "fronius/inverters/gen24/Guide One.html"
    pdf_rel = "fronius/inverters/gen24/Guide One.pdf"
    zip_rel = "fronius/inverters/gen24/Guide One.zip"

    os.makedirs(os.path.join(wiki_root, "fronius", "inverters", "gen24"), exist_ok=True)
    with open(os.path.join(wiki_root, html_rel), "wb") as handle:
        handle.write(b"<html><body><h1>Guide</h1></body></html>")
    with open(os.path.join(wiki_root, pdf_rel), "wb") as handle:
        handle.write(b"%PDF-1.4 fake")
    with open(os.path.join(wiki_root, zip_rel), "wb") as handle:
        handle.write(b"PK fake")

    listed = client.get("/api/wiki/library/files", headers=auth_headers(employee_token))
    assert listed.status_code == 200
    payload = listed.json()
    paths = {entry["path"] for entry in payload}
    assert html_rel in paths
    assert pdf_rel in paths
    assert zip_rel in paths

    html_entry = next(entry for entry in payload if entry["path"] == html_rel)
    zip_entry = next(entry for entry in payload if entry["path"] == zip_rel)
    assert html_entry["previewable"] is True
    assert zip_entry["previewable"] is False

    searched = client.get("/api/wiki/library/files?q=guide%20one", headers=auth_headers(employee_token))
    assert searched.status_code == 200
    searched_paths = {entry["path"] for entry in searched.json()}
    assert html_rel in searched_paths
    assert pdf_rel in searched_paths

    html_raw = client.get(
        f"/api/wiki/library/raw/{quote(html_rel, safe='/')}",
        headers=auth_headers(employee_token),
    )
    assert html_raw.status_code == 200
    assert html_raw.text == "<html><body><h1>Guide</h1></body></html>"
    assert html_raw.headers.get("content-type", "").startswith("text/html")
    assert html_raw.headers.get("content-disposition", "").startswith("inline;")

    html_download = client.get(
        f"/api/wiki/library/raw/{quote(html_rel, safe='/')}?download=1",
        headers=auth_headers(employee_token),
    )
    assert html_download.status_code == 200
    assert html_download.headers.get("content-disposition", "").startswith("attachment;")

    traversal = client.get(
        "/api/wiki/library/raw/%2E%2E/secret.txt",
        headers=auth_headers(employee_token),
    )
    assert traversal.status_code == 400
