"""The customer WebDAV tree — docs/FILE_SCOPES.md, section "WebDAV".

``/api/dav/customers/<id - name>/`` shows the customer's own folders and files
and one collection per project, and serves each project's files under it.
The project tree at ``/api/dav/projects/`` is untouched; these tests pin what
the customer view adds: refs, hrefs, access, and that both levels behave like
the project tree they mirror. Basic auth throughout, as a mounted drive does.
"""

from __future__ import annotations

from pathlib import Path
from urllib.parse import quote

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.models.entities import Attachment, Customer, ProjectActivity
from app.routers.workflow_webdav_customers import customer_webdav_ref

ADMIN_AUTH = ("admin@example.com", "ChangeMe123!")
EMPLOYEE_PASSWORD = "Password123!"


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _employee_auth(email: str) -> tuple[str, str]:
    return (email, EMPLOYEE_PASSWORD)


def _create_user(client: TestClient, admin_token: str, email: str, role: str = "employee") -> dict:
    response = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={"email": email, "password": EMPLOYEE_PASSWORD, "full_name": f"{role.title()} User", "role": role},
    )
    assert response.status_code == 200, response.text
    return response.json()


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


def _remove_member(client: TestClient, admin_token: str, project_id: int, user_id: int) -> None:
    # New users are put on every project by default; an "unrelated" employee
    # has to be made unrelated on purpose.
    response = client.delete(f"/api/projects/{project_id}/members/{user_id}", headers=auth_headers(admin_token))
    assert response.status_code in (200, 204), response.text


def _ref(customer: dict) -> str:
    return f"{customer['id']} - {customer['name']}"


def _base(customer: dict) -> str:
    return "/api/dav/customers/" + quote(_ref(customer), safe="") + "/"


def _propfind(client: TestClient, path: str, auth: tuple[str, str], depth: str = "1"):
    return client.request("PROPFIND", path, auth=auth, headers={"Depth": depth})


def _put(client: TestClient, path: str, body: bytes, auth: tuple[str, str] = ADMIN_AUTH):
    return client.put(path, auth=auth, content=body, headers={"Content-Type": "text/plain"})


def _customer_files(client: TestClient, admin_token: str, customer_id: int) -> list[dict]:
    response = client.get(f"/api/customers/{customer_id}/files", headers=auth_headers(admin_token))
    assert response.status_code == 200, response.text
    return response.json()


def test_the_customer_ref_is_a_safe_file_name():
    # Finder names the mounted folder after the href's last segment, so the
    # customer name has to survive as a file name — no slashes, no control
    # characters, no runs of whitespace — and the id in front is what resolves.
    assert customer_webdav_ref(Customer(id=5, name="Müller / Sohn\tGmbH")) == "5 - Müller Sohn GmbH"
    assert customer_webdav_ref(Customer(id=7, name="///")) == "7"
    assert customer_webdav_ref(Customer(id=8, name="  Firma   Weit  ")) == "8 - Firma Weit"


def test_refs_resolve_by_their_leading_id(client: TestClient, admin_token: str):
    customer = _create_customer(client, admin_token, "Ref Kunde")
    _create_project(client, admin_token, "2026-DC-REF", customer["id"])

    # The bare id works (scripts), the full ref works (Finder), a stale name
    # after the id still works (the customer was renamed, the drive was not
    # remounted); anything without a leading integer is not a customer.
    assert _propfind(client, f"/api/dav/customers/{customer['id']}/", ADMIN_AUTH).status_code == 207
    assert _propfind(client, _base(customer), ADMIN_AUTH).status_code == 207
    stale = quote(f"{customer['id']} - Alter Name", safe="")
    assert _propfind(client, f"/api/dav/customers/{stale}/", ADMIN_AUTH).status_code == 207
    assert _propfind(client, "/api/dav/customers/abc/", ADMIN_AUTH).status_code == 404
    missing = quote("999999 - Niemand", safe="")
    assert _propfind(client, f"/api/dav/customers/{missing}/", ADMIN_AUTH).status_code == 404
    assert _propfind(client, f"/api/dav/customers/{missing}/Dokumente/", ADMIN_AUTH).status_code == 404


def test_the_root_lists_only_customers_the_user_may_see(client: TestClient, admin_token: str):
    seen = _create_customer(client, admin_token, "Sichtbar GmbH")
    hidden = _create_customer(client, admin_token, "Verborgen AG")
    archived = _create_customer(client, admin_token, "Archiv KG")
    _create_project(client, admin_token, "2026-DC-1", seen["id"])
    hidden_project = _create_project(client, admin_token, "2026-DC-2", hidden["id"])
    _create_project(client, admin_token, "2026-DC-3", archived["id"])
    archive = client.post(f"/api/customers/{archived['id']}/archive", headers=auth_headers(admin_token))
    assert archive.status_code == 200, archive.text
    employee = _create_user(client, admin_token, "dav-root@example.com")
    _remove_member(client, admin_token, hidden_project["id"], employee["id"])

    unauthenticated = client.request("PROPFIND", "/api/dav/customers/", headers={"Depth": "1"})
    assert unauthenticated.status_code == 401

    admin_root = _propfind(client, "/api/dav/customers/", ADMIN_AUTH)
    assert admin_root.status_code == 207, admin_root.text
    assert _base(seen) in admin_root.text
    assert _base(hidden) in admin_root.text
    # Archived customers stay out of the listing, like archived projects at
    # the project root; they remain reachable by ref.
    assert _base(archived) not in admin_root.text
    assert _propfind(client, _base(archived), ADMIN_AUTH).status_code == 207

    without_slash = _propfind(client, "/api/dav/customers", ADMIN_AUTH)
    assert without_slash.status_code == 207
    assert _base(seen) in without_slash.text

    depth_zero = _propfind(client, "/api/dav/customers/", ADMIN_AUTH, depth="0")
    assert depth_zero.status_code == 207
    assert "/api/dav/customers/" in depth_zero.text
    assert _base(seen) not in depth_zero.text

    employee_root = _propfind(client, "/api/dav/customers/", _employee_auth("dav-root@example.com"))
    assert employee_root.status_code == 207, employee_root.text
    assert _base(seen) in employee_root.text
    assert _base(hidden) not in employee_root.text

    # The listing and the door agree.
    assert _propfind(client, _base(hidden), _employee_auth("dav-root@example.com")).status_code == 403
    denied_put = _put(client, _base(hidden) + "Dokumente/x.txt", b"x", auth=_employee_auth("dav-root@example.com"))
    assert denied_put.status_code == 403


def test_the_customer_listing_shows_folders_and_project_collections(client: TestClient, admin_token: str):
    customer = _create_customer(client, admin_token, "Struktur Kunde")
    project = _create_project(client, admin_token, "2026-DC-10", customer["id"])
    other = _create_project(client, admin_token, "2026-DC-11", customer["id"])
    employee = _create_user(client, admin_token, "dav-struct@example.com")
    _remove_member(client, admin_token, other["id"], employee["id"])
    base = _base(customer)

    admin_listing = _propfind(client, base, ADMIN_AUTH)
    assert admin_listing.status_code == 207, admin_listing.text
    assert base + "Dokumente/" in admin_listing.text
    assert base + "Verwaltung/" in admin_listing.text
    # The project sits inside the customer, with a customer-rooted href and
    # the same display name the project tree uses.
    assert base + f"{project['project_number']}/" in admin_listing.text
    assert base + f"{other['project_number']}/" in admin_listing.text
    assert f"{project['project_number']} - {customer['name']}" in admin_listing.text
    assert "/api/dav/projects/" not in admin_listing.text

    depth_zero = _propfind(client, base, ADMIN_AUTH, depth="0")
    assert depth_zero.status_code == 207
    assert "Dokumente" not in depth_zero.text
    assert project["project_number"] not in depth_zero.text

    # Only projects the employee can see are listed, and the door agrees.
    employee_auth = _employee_auth("dav-struct@example.com")
    employee_listing = _propfind(client, base, employee_auth)
    assert employee_listing.status_code == 207, employee_listing.text
    assert base + f"{project['project_number']}/" in employee_listing.text
    assert base + f"{other['project_number']}/" not in employee_listing.text
    assert "Verwaltung" not in employee_listing.text
    assert _propfind(client, base + f"{other['project_number']}/", employee_auth).status_code == 403

    for method in ("OPTIONS", "GET", "HEAD"):
        probe = client.request(method, base, auth=ADMIN_AUTH)
        assert probe.status_code == 204, method
        assert "PROPFIND" in probe.headers.get("Allow", "")


def test_customer_files_round_trip_over_webdav(client: TestClient, admin_token: str):
    customer = _create_customer(client, admin_token, "Roundtrip Kunde")
    _create_project(client, admin_token, "2026-DC-20", customer["id"])
    base = _base(customer)

    put = _put(client, base + "Dokumente/vertrag.txt", b"customer contract")
    assert put.status_code == 201, put.text
    assert _put(client, base + "wurzel.txt", b"root file").status_code == 201
    assert _put(client, base + "Dokumente/leer.txt", b"").status_code == 400

    rows = _customer_files(client, admin_token, customer["id"])
    by_name = {row["file_name"]: row for row in rows}
    assert by_name["vertrag.txt"]["customer_id"] == customer["id"]
    assert by_name["vertrag.txt"]["project_id"] is None
    assert by_name["vertrag.txt"]["folder"] == "Dokumente"
    assert by_name["wurzel.txt"]["folder"] == ""

    folder_listing = _propfind(client, base + "Dokumente/", ADMIN_AUTH)
    assert folder_listing.status_code == 207, folder_listing.text
    assert base + "Dokumente/vertrag.txt" in folder_listing.text
    assert f"<D:getcontentlength>{len(b'customer contract')}</D:getcontentlength>" in folder_listing.text

    root_listing = _propfind(client, base, ADMIN_AUTH)
    assert base + "wurzel.txt" in root_listing.text

    file_props = _propfind(client, base + "Dokumente/vertrag.txt", ADMIN_AUTH, depth="0")
    assert file_props.status_code == 207
    assert "<D:resourcetype/>" in file_props.text
    assert _propfind(client, base + "Dokumente/fehlt.txt", ADMIN_AUTH).status_code == 404

    fetched = client.get(base + "Dokumente/vertrag.txt", auth=ADMIN_AUTH)
    assert fetched.status_code == 200
    assert fetched.content == b"customer contract"
    head = client.head(base + "Dokumente/vertrag.txt", auth=ADMIN_AUTH)
    assert head.status_code == 200
    assert head.content == b""
    assert client.get(base + "Dokumente/fehlt.txt", auth=ADMIN_AUTH).status_code == 404

    # A second PUT of the same name is a new version; the listing shows the newest.
    assert _put(client, base + "Dokumente/vertrag.txt", b"customer contract v2").status_code == 201
    assert client.get(base + "Dokumente/vertrag.txt", auth=ADMIN_AUTH).content == b"customer contract v2"


def test_mkcol_creates_a_customer_folder(client: TestClient, admin_token: str):
    customer = _create_customer(client, admin_token, "Ordner Kunde")
    _create_project(client, admin_token, "2026-DC-30", customer["id"])
    base = _base(customer)

    created = client.request("MKCOL", base + "Pläne/2026", auth=ADMIN_AUTH)
    assert created.status_code == 201, created.text
    # Creating it again is harmless: the segment exists, nothing collides.
    assert client.request("MKCOL", base + "Pläne", auth=ADMIN_AUTH).status_code == 201

    folders = client.get(f"/api/customers/{customer['id']}/folders", headers=auth_headers(admin_token))
    paths = [row["path"] for row in folders.json()]
    assert "Pläne" in paths and "Pläne/2026" in paths

    listing = _propfind(client, base, ADMIN_AUTH)
    assert base + quote("Pläne", safe="") + "/" in listing.text
    nested = _propfind(client, base + quote("Pläne", safe="") + "/", ADMIN_AUTH)
    assert nested.status_code == 207
    assert base + quote("Pläne", safe="") + "/2026/" in nested.text
    assert _propfind(client, base + "Gibtsnicht/", ADMIN_AUTH).status_code == 404


def test_project_files_are_served_under_the_customer(client: TestClient, admin_token: str):
    customer = _create_customer(client, admin_token, "Projekt Kunde")
    project = _create_project(client, admin_token, "2026-DC-40", customer["id"])
    stranger = _create_customer(client, admin_token, "Anderer Kunde")
    foreign = _create_project(client, admin_token, "2026-DC-41", stranger["id"])
    base = _base(customer)
    project_base = base + f"{project['project_number']}/"

    upload = client.post(
        f"/api/projects/{project['id']}/files",
        headers=auth_headers(admin_token),
        data={"folder": "Bilder"},
        files={"file": ("foto.jpg", b"jpeg-bytes", "image/jpeg")},
    )
    assert upload.status_code == 200, upload.text

    project_root = _propfind(client, project_base, ADMIN_AUTH)
    assert project_root.status_code == 207, project_root.text
    assert project_base + "Bilder/" in project_root.text
    assert project_base + "Verwaltung/" in project_root.text
    assert "/api/dav/projects/" not in project_root.text
    assert _propfind(client, project_base.rstrip("/"), ADMIN_AUTH).status_code == 207

    pictures = _propfind(client, project_base + "Bilder/", ADMIN_AUTH)
    assert pictures.status_code == 207, pictures.text
    assert project_base + "Bilder/foto.jpg" in pictures.text
    assert f"<D:getcontentlength>{len(b'jpeg-bytes')}</D:getcontentlength>" in pictures.text
    fetched = client.get(project_base + "Bilder/foto.jpg", auth=ADMIN_AUTH)
    assert fetched.status_code == 200
    assert fetched.content == b"jpeg-bytes"

    # Writes through the customer path are project writes: the row belongs to
    # the project, the folder is registered there, the activity log gets its
    # entry — exactly as through /api/dav/projects/.
    put = _put(client, project_base + "Berichte/notiz.txt", b"project note")
    assert put.status_code == 201, put.text
    assert client.request("MKCOL", project_base + "Pläne", auth=ADMIN_AUTH).status_code == 201
    project_files = client.get(f"/api/projects/{project['id']}/files", headers=auth_headers(admin_token)).json()
    note = next(row for row in project_files if row["file_name"] == "notiz.txt")
    assert note["project_id"] == project["id"] and note["customer_id"] is None
    assert note["folder"] == "Berichte"
    assert "Pläne" in [row["path"] for row in client.get(f"/api/projects/{project['id']}/folders", headers=auth_headers(admin_token)).json()]
    with SessionLocal() as db:
        events = db.scalars(
            select(ProjectActivity.event_type).where(ProjectActivity.project_id == project["id"])
        ).all()
    assert "file.uploaded" in events
    assert _customer_files(client, admin_token, customer["id"]) == []

    # The project tree still serves the same file, with its own hrefs.
    via_projects = _propfind(client, f"/api/dav/projects/{project['project_number']}/Berichte/", ADMIN_AUTH)
    assert f"/api/dav/projects/{project['project_number']}/Berichte/notiz.txt" in via_projects.text

    # A project of another customer is not reachable through this customer,
    # so its number is read as a plain customer folder name and is unknown.
    assert _propfind(client, base + f"{foreign['project_number']}/", ADMIN_AUTH).status_code == 404
    assert client.get(base + f"{foreign['project_number']}/Bilder/foto.jpg", auth=ADMIN_AUTH).status_code == 404


def test_delete_is_gated_by_files_manage_on_both_levels(client: TestClient, admin_token: str):
    customer = _create_customer(client, admin_token, "Lösch Kunde")
    project = _create_project(client, admin_token, "2026-DC-50", customer["id"])
    _create_user(client, admin_token, "dav-delete@example.com")
    employee_auth = _employee_auth("dav-delete@example.com")
    base = _base(customer)
    project_base = base + f"{project['project_number']}/"

    assert _put(client, base + "Dokumente/weg.txt", b"customer file").status_code == 201
    assert _put(client, project_base + "Berichte/weg.txt", b"project file").status_code == 201
    with SessionLocal() as db:
        customer_row = db.scalars(select(Attachment).where(Attachment.customer_id == customer["id"])).one()
        stored_path = Path(customer_row.stored_path)
    assert stored_path.exists()

    # A member reads it but may not delete it: files:manage is the office's.
    assert client.get(base + "Dokumente/weg.txt", auth=employee_auth).status_code == 200
    assert client.delete(base + "Dokumente/weg.txt", auth=employee_auth).status_code == 403
    assert client.delete(project_base + "Berichte/weg.txt", auth=employee_auth).status_code == 403
    assert stored_path.exists()

    assert client.delete(base + "Dokumente/weg.txt", auth=ADMIN_AUTH).status_code == 204
    assert client.delete(project_base + "Berichte/weg.txt", auth=ADMIN_AUTH).status_code == 204
    assert client.delete(base + "Dokumente/weg.txt", auth=ADMIN_AUTH).status_code == 404
    assert client.get(base + "Dokumente/weg.txt", auth=ADMIN_AUTH).status_code == 404
    assert client.get(project_base + "Berichte/weg.txt", auth=ADMIN_AUTH).status_code == 404
    assert not stored_path.exists()
    with SessionLocal() as db:
        events = db.scalars(
            select(ProjectActivity.event_type).where(ProjectActivity.project_id == project["id"])
        ).all()
    assert "file.deleted" in events


def test_verwaltung_is_hidden_from_employees_and_closed_to_their_writes(client: TestClient, admin_token: str):
    customer = _create_customer(client, admin_token, "Geheim Kunde")
    project = _create_project(client, admin_token, "2026-DC-60", customer["id"])
    _create_user(client, admin_token, "dav-protected@example.com")
    employee_auth = _employee_auth("dav-protected@example.com")
    base = _base(customer)
    project_base = base + f"{project['project_number']}/"

    assert _put(client, base + "Verwaltung/geheim.txt", b"customer secret").status_code == 201
    assert _put(client, project_base + "Verwaltung/geheim.txt", b"project secret").status_code == 201

    for level in (base, project_base):
        listing = _propfind(client, level, employee_auth)
        assert listing.status_code == 207, listing.text
        assert "Verwaltung" not in listing.text
        assert _propfind(client, level + "Verwaltung/", employee_auth).status_code == 404
        assert client.get(level + "Verwaltung/geheim.txt", auth=employee_auth).status_code == 404
        assert client.request("MKCOL", level + "Verwaltung/Sub", auth=employee_auth).status_code == 403
        assert _put(client, level + "Verwaltung/blocked.txt", b"blocked", auth=employee_auth).status_code == 403
        assert client.get(level + "Verwaltung/geheim.txt", auth=ADMIN_AUTH).status_code == 200
