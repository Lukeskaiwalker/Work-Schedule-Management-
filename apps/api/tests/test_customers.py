"""Customer router + workflow_projects sync tests.

Covers:
  * CRUD happy path (create, list, detail, update, archive, unarchive).
  * Search by `q`.
  * Creating a project with `customer_id` mirrors the five legacy fields.
  * Creating a project with only `customer_name` (legacy path)
    auto-creates a Customer and links it.
  * Dedupe: two projects with the same customer_name + address but
    different casing/whitespace collapse to one Customer.
  * Archiving doesn't cascade-delete linked projects.
"""

from __future__ import annotations

from fastapi.testclient import TestClient


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_customer(
    client: TestClient,
    admin_token: str,
    *,
    name: str,
    address: str | None = None,
    contact_person: str | None = None,
    email: str | None = None,
    phone: str | None = None,
) -> dict:
    payload: dict = {"name": name}
    if address is not None:
        payload["address"] = address
    if contact_person is not None:
        payload["contact_person"] = contact_person
    if email is not None:
        payload["email"] = email
    if phone is not None:
        payload["phone"] = phone
    response = client.post("/api/customers", headers=auth_headers(admin_token), json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def test_customer_crud_happy_path(client: TestClient, admin_token: str):
    created = _create_customer(
        client,
        admin_token,
        name="Acme Industries",
        address="1 Main St, 10115 Berlin",
        contact_person="Jane Doe",
        email="jane@acme.example",
        phone="+49 30 1234567",
    )
    assert created["id"] > 0
    assert created["name"] == "Acme Industries"
    assert created["address"] == "1 Main St, 10115 Berlin"
    assert created["email"] == "jane@acme.example"
    assert created["archived_at"] is None

    customer_id = created["id"]

    # Detail
    detail = client.get(f"/api/customers/{customer_id}", headers=auth_headers(admin_token))
    assert detail.status_code == 200
    assert detail.json()["id"] == customer_id

    # List
    listing = client.get("/api/customers", headers=auth_headers(admin_token))
    assert listing.status_code == 200
    rows = listing.json()
    assert any(row["id"] == customer_id for row in rows)

    # Update
    updated = client.patch(
        f"/api/customers/{customer_id}",
        headers=auth_headers(admin_token),
        json={"contact_person": "John Smith", "notes": "preferred"},
    )
    assert updated.status_code == 200
    assert updated.json()["contact_person"] == "John Smith"
    assert updated.json()["notes"] == "preferred"

    # Archive
    archived = client.post(
        f"/api/customers/{customer_id}/archive",
        headers=auth_headers(admin_token),
    )
    assert archived.status_code == 200
    assert archived.json()["archived_at"] is not None

    # Default list excludes archived
    listing_after_archive = client.get("/api/customers", headers=auth_headers(admin_token))
    assert listing_after_archive.status_code == 200
    assert not any(row["id"] == customer_id for row in listing_after_archive.json())

    # archived=true shows them
    archived_list = client.get("/api/customers?archived=true", headers=auth_headers(admin_token))
    assert archived_list.status_code == 200
    assert any(row["id"] == customer_id for row in archived_list.json())

    # Unarchive
    unarchived = client.post(
        f"/api/customers/{customer_id}/unarchive",
        headers=auth_headers(admin_token),
    )
    assert unarchived.status_code == 200
    assert unarchived.json()["archived_at"] is None


def test_customer_search_by_q(client: TestClient, admin_token: str):
    _create_customer(client, admin_token, name="Alpha GmbH")
    _create_customer(client, admin_token, name="Beta AG")
    _create_customer(client, admin_token, name="Gamma SE")

    response = client.get("/api/customers?q=beta", headers=auth_headers(admin_token))
    assert response.status_code == 200
    rows = response.json()
    names = {row["name"] for row in rows}
    assert "Beta AG" in names
    assert "Alpha GmbH" not in names


def test_create_project_with_customer_id_mirrors_legacy_fields(
    client: TestClient, admin_token: str
):
    customer = _create_customer(
        client,
        admin_token,
        name="Mirror Co",
        address="Hauptstr. 5",
        contact_person="Mara M.",
        email="mara@mirror.example",
        phone="+49 30 2222",
    )
    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-CUST-1",
            "name": "Mirror Project",
            "status": "active",
            "customer_id": customer["id"],
        },
    )
    assert project.status_code == 200, project.text
    body = project.json()
    assert body["customer_id"] == customer["id"]
    # All five legacy mirror fields populated from the Customer
    assert body["customer_name"] == "Mirror Co"
    assert body["customer_address"] == "Hauptstr. 5"
    assert body["customer_contact"] == "Mara M."
    assert body["customer_email"] == "mara@mirror.example"
    assert body["customer_phone"] == "+49 30 2222"


def test_create_project_with_legacy_name_auto_creates_customer(
    client: TestClient, admin_token: str
):
    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-LEGACY-1",
            "name": "Legacy Project",
            "status": "active",
            "customer_name": "Legacy GmbH",
            "customer_address": "Nebenstr. 9",
            "customer_email": "x@legacy.example",
        },
    )
    assert project.status_code == 200, project.text
    body = project.json()
    assert body["customer_id"] is not None

    # Fetch the customer and confirm the fields copied across
    customer = client.get(
        f"/api/customers/{body['customer_id']}", headers=auth_headers(admin_token)
    )
    assert customer.status_code == 200
    assert customer.json()["name"] == "Legacy GmbH"
    assert customer.json()["address"] == "Nebenstr. 9"


def test_duplicate_customer_name_address_is_deduped(
    client: TestClient, admin_token: str
):
    # Project 1 creates the customer
    p1 = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-DEDUP-1",
            "name": "Dedup 1",
            "status": "active",
            "customer_name": "Dedup Holdings",
            "customer_address": "Lindenallee 3",
        },
    )
    assert p1.status_code == 200
    cid_1 = p1.json()["customer_id"]
    assert cid_1 is not None

    # Project 2: same identity but with different casing + whitespace
    p2 = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-DEDUP-2",
            "name": "Dedup 2",
            "status": "active",
            "customer_name": "  dedup HOLDINGS  ",
            "customer_address": "lindenallee 3",
        },
    )
    assert p2.status_code == 200
    cid_2 = p2.json()["customer_id"]
    assert cid_2 == cid_1

    # And the customer's /projects endpoint returns both
    linked = client.get(
        f"/api/customers/{cid_1}/projects", headers=auth_headers(admin_token)
    )
    assert linked.status_code == 200
    project_numbers = {row["project_number"] for row in linked.json()}
    assert {"2026-DEDUP-1", "2026-DEDUP-2"}.issubset(project_numbers)


def test_archiving_customer_does_not_delete_projects(
    client: TestClient, admin_token: str
):
    customer = _create_customer(client, admin_token, name="KeepProjects GmbH")
    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-KEEP-1",
            "name": "Keep Project",
            "status": "active",
            "customer_id": customer["id"],
        },
    )
    assert project.status_code == 200
    project_id = project.json()["id"]

    archive = client.post(
        f"/api/customers/{customer['id']}/archive",
        headers=auth_headers(admin_token),
    )
    assert archive.status_code == 200

    # Project still exists and still points at the (now-archived) customer
    fetch = client.get(f"/api/customers/{customer['id']}", headers=auth_headers(admin_token))
    assert fetch.status_code == 200
    assert fetch.json()["archived_at"] is not None

    still_linked = client.get(
        f"/api/customers/{customer['id']}/projects",
        headers=auth_headers(admin_token),
    )
    assert still_linked.status_code == 200
    assert any(row["id"] == project_id for row in still_linked.json())


def test_list_customers_aggregates_project_counts(
    client: TestClient, admin_token: str
):
    customer = _create_customer(client, admin_token, name="Agg Inc")
    # Two projects, one archived-status, one active
    for n, status in [("2026-AGG-A", "active"), ("2026-AGG-B", "archived")]:
        response = client.post(
            "/api/projects",
            headers=auth_headers(admin_token),
            json={
                "project_number": n,
                "name": f"Agg {n}",
                "status": status,
                "customer_id": customer["id"],
            },
        )
        assert response.status_code == 200

    listing = client.get(
        f"/api/customers?q=Agg Inc", headers=auth_headers(admin_token)
    )
    assert listing.status_code == 200
    rows = [row for row in listing.json() if row["id"] == customer["id"]]
    assert rows, listing.json()
    row = rows[0]
    assert row["project_count"] == 2
    assert row["active_project_count"] == 1


def test_update_customer_syncs_to_linked_projects(
    client: TestClient, admin_token: str
):
    customer = _create_customer(
        client, admin_token, name="Sync GmbH", address="Old Str. 1"
    )
    project_resp = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-SYNC-1",
            "name": "Sync Project",
            "status": "active",
            "customer_id": customer["id"],
        },
    )
    assert project_resp.status_code == 200
    project_id = project_resp.json()["id"]

    # Now change the customer's address
    update = client.patch(
        f"/api/customers/{customer['id']}",
        headers=auth_headers(admin_token),
        json={"address": "New Str. 99"},
    )
    assert update.status_code == 200

    overview = client.get(
        f"/api/projects/{project_id}/overview", headers=auth_headers(admin_token)
    )
    assert overview.status_code == 200
    assert overview.json()["project"]["customer_address"] == "New Str. 99"
