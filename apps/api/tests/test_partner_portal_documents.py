"""Plans and documents for partners: the project's ``Partnerportal`` folder.

What must hold:

* everything the office puts into a project's ``Partnerportal`` folder (and
  its subfolders, whatever the case of the name) shows up for every partner
  who sees the project — on the project and on each of their tasks in it;
* nothing else of the project's files does: not ``Bilder``, not
  ``Verwaltung``, not the ``Aufgaben`` files of anybody's tasks;
* a partner opens such a file and gets a plain 404 for every other file id,
  including partner-folder files of projects they do not see;
* handing a project to a partner creates the folder, and the office's folder
  list marks it as shown in the portal.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import auth_headers
from tests.partner_portal_helpers import create_project, create_task, portal_world

PDF_BYTES = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
JPEG_BYTES = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00" + b"\x00" * 64 + b"\xff\xd9"


def _upload(client: TestClient, admin_token: str, project_id: int, folder: str, name: str, raw: bytes = PDF_BYTES, content_type: str = "application/pdf") -> dict:
    response = client.post(
        f"/api/projects/{project_id}/files",
        headers=auth_headers(admin_token),
        data={"folder": folder},
        files=[("files", (name, raw, content_type))],
    )
    assert response.status_code == 200, response.text
    rows = response.json()
    assert len(rows) == 1, rows
    return rows[0]


def _task_upload(client: TestClient, admin_token: str, task_id: int, name: str) -> dict:
    response = client.post(
        f"/api/tasks/{task_id}/files",
        headers=auth_headers(admin_token),
        files=[("files", (name, JPEG_BYTES, "image/jpeg"))],
    )
    assert response.status_code == 200, response.text
    return response.json()[0]


def test_handing_over_a_project_creates_the_partner_folder_and_marks_it(client: TestClient, admin_token: str) -> None:
    w = portal_world(client, admin_token)
    office = auth_headers(admin_token)
    project_id = w["braun"]["id"]

    before = {row["path"] for row in client.get(f"/api/projects/{project_id}/folders", headers=office).json()}
    assert "Partnerportal" not in before

    assigned = client.put(f"/api/projects/{project_id}/partners/{w['partner']['id']}", headers=office, json={})
    assert assigned.status_code == 200, assigned.text

    folders = {row["path"]: row for row in client.get(f"/api/projects/{project_id}/folders", headers=office).json()}
    assert folders["Partnerportal"]["portal_shared"] is True
    assert folders["Partnerportal"]["is_protected"] is False
    assert folders["Bilder"]["portal_shared"] is False

    created = client.post(f"/api/projects/{project_id}/folders", headers=office, json={"path": "partnerportal/Aufmaß"})
    assert created.status_code == 200, created.text
    assert created.json()["portal_shared"] is True


def test_partners_see_exactly_the_files_in_the_partner_folder(client: TestClient, admin_token: str) -> None:
    w = portal_world(client, admin_token)
    project_id = w["project"]["id"]  # the partner sees it through its tasks only
    plan = _upload(client, admin_token, project_id, "Partnerportal", "Dachplan.pdf")
    section = _upload(client, admin_token, project_id, "Partnerportal/Pläne", "Schnitt A-A.pdf")
    lower = _upload(client, admin_token, project_id, "partnerportal", "Aufmaß.pdf")
    _upload(client, admin_token, project_id, "Bilder", "Baustelle.jpg", JPEG_BYTES, "image/jpeg")
    _upload(client, admin_token, project_id, "Verwaltung", "Nachunternehmervertrag.pdf")
    _upload(client, admin_token, project_id, "Partnerportal-Archiv", "Alt.pdf")
    _task_upload(client, admin_token, w["internal"]["id"], "Abnahme intern.jpg")
    _task_upload(client, admin_token, w["theirs"]["id"], "Elektro.jpg")

    head = auth_headers(w["token"])
    project = client.get(f"/api/portal/projects/{project_id}", headers=head)
    assert project.status_code == 200, project.text
    documents = {doc["file_name"]: doc for doc in project.json()["documents"]}
    assert set(documents) == {"Dachplan.pdf", "Schnitt A-A.pdf", "Aufmaß.pdf"}
    assert documents["Dachplan.pdf"]["folder"] == ""
    assert documents["Schnitt A-A.pdf"]["folder"] == "Pläne"
    assert documents["Aufmaß.pdf"]["id"] == lower["id"]
    assert documents["Dachplan.pdf"]["content_type"] == "application/pdf"
    for leaked in ("Nachunternehmervertrag", "Baustelle.jpg", "Abnahme intern", "Elektro.jpg", "Alt.pdf"):
        assert leaked not in project.text

    task = client.get(f"/api/portal/tasks/{w['mine']['id']}", headers=head).json()
    assert {doc["id"] for doc in task["documents"]} == {plan["id"], section["id"], lower["id"]}

    customer_task = client.get(f"/api/portal/tasks/{w['customer_only']['id']}", headers=head).json()
    assert customer_task["documents"] == []


def test_a_partner_opens_partner_folder_files_and_nothing_else(client: TestClient, admin_token: str) -> None:
    w = portal_world(client, admin_token)
    project_id = w["project"]["id"]
    plan = _upload(client, admin_token, project_id, "Partnerportal", "Dachplan.pdf")
    photo = _upload(client, admin_token, project_id, "Bilder", "Baustelle.jpg", JPEG_BYTES, "image/jpeg")
    contract = _upload(client, admin_token, project_id, "Verwaltung", "Vertrag.pdf")
    elsewhere = _upload(client, admin_token, w["hidden"]["id"], "Partnerportal", "Fremd.pdf")
    head = auth_headers(w["token"])

    opened = client.get(f"/api/portal/documents/{plan['id']}", headers=head)
    assert opened.status_code == 200, opened.text
    assert opened.content == PDF_BYTES
    assert opened.headers["content-type"].startswith("application/pdf")
    assert "inline" in opened.headers.get("content-disposition", "")
    downloaded = client.get(f"/api/portal/documents/{plan['id']}", params={"download": 1}, headers=head)
    assert "attachment" in downloaded.headers.get("content-disposition", "")

    for file_id in (photo["id"], contract["id"], elsewhere["id"], 999_999):
        response = client.get(f"/api/portal/documents/{file_id}", headers=head)
        assert response.status_code == 404, (file_id, response.text)

    # Staff use the office's own file routes, never the portal's.
    assert client.get(f"/api/portal/documents/{plan['id']}", headers=auth_headers(admin_token)).status_code == 403


def test_the_folder_follows_the_project_out_of_the_portal(client: TestClient, admin_token: str) -> None:
    w = portal_world(client, admin_token)
    office = auth_headers(admin_token)
    extra = create_project(client, admin_token, "2024-021", "Carport Schulze")
    assert client.put(f"/api/projects/{extra['id']}/partners/{w['partner']['id']}", headers=office, json={}).status_code == 200
    plan = _upload(client, admin_token, extra["id"], "Partnerportal", "Carport.pdf")
    head = auth_headers(w["token"])

    detail = client.get(f"/api/portal/projects/{extra['id']}", headers=head).json()
    assert [doc["file_name"] for doc in detail["documents"]] == ["Carport.pdf"]
    assert client.get(f"/api/portal/documents/{plan['id']}", headers=head).status_code == 200

    # A task of the partner on the project keeps it visible; taking the
    # project back with no such task closes it again.
    task = create_task(client, admin_token, project_id=extra["id"], title="Dach Carport", partner_ids=[w["other"]["id"]])
    assert task["id"]
    assert client.delete(f"/api/projects/{extra['id']}/partners/{w['partner']['id']}", headers=office).status_code == 204
    assert client.get(f"/api/portal/documents/{plan['id']}", headers=head).status_code == 404
    assert client.get(f"/api/portal/projects/{extra['id']}", headers=head).status_code == 404
