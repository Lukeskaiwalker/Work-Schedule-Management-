"""Partner (external contractor) router + task-partner sync tests.

Covers:
  * CRUD happy path (create, list, detail, update, archive, unarchive).
  * Search by `q`, filter by `trade`.
  * Task create with `partner_ids` persists rows in `task_partners`.
  * Task update replaces links: remove-some / keep-some / add-new.
  * Archiving a partner doesn't drop its existing task_partners rows.
  * `GET /api/tasks?has_partners=true` filters to partner-linked tasks.
  * `GET /api/tasks?partner_id=X` filters to a specific partner.
  * Aggregate counts (`task_count`, `open_task_count`) compute correctly.
"""

from __future__ import annotations

from fastapi.testclient import TestClient


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_partner(
    client: TestClient,
    admin_token: str,
    *,
    name: str,
    contact_person: str | None = None,
    email: str | None = None,
    phone: str | None = None,
    address: str | None = None,
    trade: str | None = None,
    tax_id: str | None = None,
    notes: str | None = None,
) -> dict:
    payload: dict = {"name": name}
    if contact_person is not None:
        payload["contact_person"] = contact_person
    if email is not None:
        payload["email"] = email
    if phone is not None:
        payload["phone"] = phone
    if address is not None:
        payload["address"] = address
    if trade is not None:
        payload["trade"] = trade
    if tax_id is not None:
        payload["tax_id"] = tax_id
    if notes is not None:
        payload["notes"] = notes
    response = client.post("/api/partners", headers=auth_headers(admin_token), json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def _create_project(client: TestClient, admin_token: str, number: str, name: str = "Partner Test Project") -> dict:
    response = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": number,
            "name": name,
            "status": "active",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def _create_task(
    client: TestClient,
    admin_token: str,
    *,
    project_id: int,
    title: str,
    partner_ids: list[int] | None = None,
    status: str = "open",
) -> dict:
    payload: dict = {
        "project_id": project_id,
        "title": title,
        "status": status,
    }
    if partner_ids is not None:
        payload["partner_ids"] = partner_ids
    response = client.post("/api/tasks", headers=auth_headers(admin_token), json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def test_partner_crud_happy_path(client: TestClient, admin_token: str):
    created = _create_partner(
        client,
        admin_token,
        name="Elektro Meier",
        contact_person="Hans Meier",
        email="hans@meier.example",
        phone="+49 30 9876543",
        address="Baustraße 7, 10115 Berlin",
        trade="Elektro",
        tax_id="DE123456789",
        notes="zuverlässig",
    )
    assert created["id"] > 0
    assert created["name"] == "Elektro Meier"
    assert created["trade"] == "Elektro"
    assert created["archived_at"] is None

    partner_id = created["id"]

    # Detail
    detail = client.get(f"/api/partners/{partner_id}", headers=auth_headers(admin_token))
    assert detail.status_code == 200
    assert detail.json()["id"] == partner_id
    assert detail.json()["trade"] == "Elektro"

    # List
    listing = client.get("/api/partners", headers=auth_headers(admin_token))
    assert listing.status_code == 200
    rows = listing.json()
    assert any(row["id"] == partner_id for row in rows)

    # Update
    updated = client.patch(
        f"/api/partners/{partner_id}",
        headers=auth_headers(admin_token),
        json={"contact_person": "Erika M.", "notes": "TOP"},
    )
    assert updated.status_code == 200
    assert updated.json()["contact_person"] == "Erika M."
    assert updated.json()["notes"] == "TOP"

    # Archive
    archived = client.post(
        f"/api/partners/{partner_id}/archive",
        headers=auth_headers(admin_token),
    )
    assert archived.status_code == 200
    assert archived.json()["archived_at"] is not None

    # Default list excludes archived
    listing_after = client.get("/api/partners", headers=auth_headers(admin_token))
    assert listing_after.status_code == 200
    assert not any(row["id"] == partner_id for row in listing_after.json())

    # archived=true shows them
    archived_list = client.get(
        "/api/partners?archived=true", headers=auth_headers(admin_token)
    )
    assert archived_list.status_code == 200
    assert any(row["id"] == partner_id for row in archived_list.json())

    # Unarchive
    unarchived = client.post(
        f"/api/partners/{partner_id}/unarchive",
        headers=auth_headers(admin_token),
    )
    assert unarchived.status_code == 200
    assert unarchived.json()["archived_at"] is None


def test_partner_search_by_q_and_trade(client: TestClient, admin_token: str):
    _create_partner(client, admin_token, name="Alpha Elektro", trade="Elektro")
    _create_partner(client, admin_token, name="Beta Sanitär", trade="Sanitär")
    _create_partner(client, admin_token, name="Gamma Dach", trade="Dach")

    by_q = client.get("/api/partners?q=beta", headers=auth_headers(admin_token))
    assert by_q.status_code == 200
    names = {row["name"] for row in by_q.json()}
    assert "Beta Sanitär" in names
    assert "Alpha Elektro" not in names

    by_trade = client.get(
        "/api/partners?trade=Elektro", headers=auth_headers(admin_token)
    )
    assert by_trade.status_code == 200
    trade_names = {row["name"] for row in by_trade.json()}
    assert "Alpha Elektro" in trade_names
    assert "Beta Sanitär" not in trade_names


def test_create_task_with_partner_ids_persists_links(
    client: TestClient, admin_token: str
):
    project = _create_project(client, admin_token, "2026-PAR-1")
    p1 = _create_partner(client, admin_token, name="P1 Elektro", trade="Elektro")
    p2 = _create_partner(client, admin_token, name="P2 Sanitär", trade="Sanitär")

    task = _create_task(
        client,
        admin_token,
        project_id=project["id"],
        title="Multi-trade task",
        partner_ids=[p1["id"], p2["id"]],
    )
    assert sorted(task["partner_ids"]) == sorted([p1["id"], p2["id"]])
    # Lightweight partner rows embedded
    partner_names = {p["name"] for p in task["partners"]}
    assert partner_names == {"P1 Elektro", "P2 Sanitär"}

    # List endpoint returns them too
    listing = client.get(
        f"/api/tasks?view=projects_overview&project_id={project['id']}",
        headers=auth_headers(admin_token),
    )
    assert listing.status_code == 200
    matching = [row for row in listing.json() if row["id"] == task["id"]]
    assert matching
    assert sorted(matching[0]["partner_ids"]) == sorted([p1["id"], p2["id"]])


def test_update_task_replaces_partner_links(client: TestClient, admin_token: str):
    project = _create_project(client, admin_token, "2026-PAR-2")
    p1 = _create_partner(client, admin_token, name="ReplaceP1", trade="Elektro")
    p2 = _create_partner(client, admin_token, name="ReplaceP2", trade="Sanitär")
    p3 = _create_partner(client, admin_token, name="ReplaceP3", trade="Dach")

    task = _create_task(
        client,
        admin_token,
        project_id=project["id"],
        title="Replacement task",
        partner_ids=[p1["id"], p2["id"]],
    )

    # Replace: remove p1, keep p2, add p3.
    patch = client.patch(
        f"/api/tasks/{task['id']}",
        headers=auth_headers(admin_token),
        json={"partner_ids": [p2["id"], p3["id"]]},
    )
    assert patch.status_code == 200, patch.text
    assert sorted(patch.json()["partner_ids"]) == sorted([p2["id"], p3["id"]])

    # Partner endpoint: p1 has no tasks, p2/p3 each have 1.
    for pid, expected in [(p1["id"], 0), (p2["id"], 1), (p3["id"], 1)]:
        linked = client.get(
            f"/api/partners/{pid}/tasks", headers=auth_headers(admin_token)
        )
        assert linked.status_code == 200
        assert len(linked.json()) == expected


def test_archiving_partner_keeps_task_partner_links(
    client: TestClient, admin_token: str
):
    project = _create_project(client, admin_token, "2026-PAR-3")
    partner = _create_partner(client, admin_token, name="ArchMe", trade="Elektro")
    task = _create_task(
        client,
        admin_token,
        project_id=project["id"],
        title="Keeps its link",
        partner_ids=[partner["id"]],
    )

    archive = client.post(
        f"/api/partners/{partner['id']}/archive", headers=auth_headers(admin_token)
    )
    assert archive.status_code == 200

    # Task still shows the partner
    listing = client.get(
        f"/api/tasks?view=projects_overview&project_id={project['id']}",
        headers=auth_headers(admin_token),
    )
    assert listing.status_code == 200
    matching = [row for row in listing.json() if row["id"] == task["id"]]
    assert matching
    assert partner["id"] in matching[0]["partner_ids"]

    # Partner's /tasks endpoint still returns the task
    linked = client.get(
        f"/api/partners/{partner['id']}/tasks", headers=auth_headers(admin_token)
    )
    assert linked.status_code == 200
    assert any(t["id"] == task["id"] for t in linked.json())


def test_task_list_has_partners_filter(client: TestClient, admin_token: str):
    project = _create_project(client, admin_token, "2026-PAR-4")
    partner = _create_partner(client, admin_token, name="FilterP", trade="Elektro")

    t_with = _create_task(
        client,
        admin_token,
        project_id=project["id"],
        title="With partner",
        partner_ids=[partner["id"]],
    )
    t_without = _create_task(
        client,
        admin_token,
        project_id=project["id"],
        title="Without partner",
    )

    only_with = client.get(
        f"/api/tasks?view=projects_overview&project_id={project['id']}&has_partners=true",
        headers=auth_headers(admin_token),
    )
    assert only_with.status_code == 200
    ids_with = {row["id"] for row in only_with.json()}
    assert t_with["id"] in ids_with
    assert t_without["id"] not in ids_with

    only_without = client.get(
        f"/api/tasks?view=projects_overview&project_id={project['id']}&has_partners=false",
        headers=auth_headers(admin_token),
    )
    assert only_without.status_code == 200
    ids_without = {row["id"] for row in only_without.json()}
    assert t_without["id"] in ids_without
    assert t_with["id"] not in ids_without


def test_task_list_filter_by_partner_id(client: TestClient, admin_token: str):
    project = _create_project(client, admin_token, "2026-PAR-5")
    p1 = _create_partner(client, admin_token, name="SpecP1", trade="Elektro")
    p2 = _create_partner(client, admin_token, name="SpecP2", trade="Sanitär")

    t_p1 = _create_task(
        client, admin_token, project_id=project["id"], title="P1", partner_ids=[p1["id"]]
    )
    t_p2 = _create_task(
        client, admin_token, project_id=project["id"], title="P2", partner_ids=[p2["id"]]
    )
    t_both = _create_task(
        client,
        admin_token,
        project_id=project["id"],
        title="Both",
        partner_ids=[p1["id"], p2["id"]],
    )

    resp = client.get(
        f"/api/tasks?view=projects_overview&project_id={project['id']}&partner_id={p1['id']}",
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 200
    ids = {row["id"] for row in resp.json()}
    assert t_p1["id"] in ids
    assert t_both["id"] in ids
    assert t_p2["id"] not in ids


def test_partner_list_aggregate_counts(client: TestClient, admin_token: str):
    project = _create_project(client, admin_token, "2026-PAR-6")
    partner = _create_partner(client, admin_token, name="AggPartner", trade="Elektro")

    # Three tasks: two open, one done.
    _create_task(
        client,
        admin_token,
        project_id=project["id"],
        title="Open 1",
        partner_ids=[partner["id"]],
    )
    _create_task(
        client,
        admin_token,
        project_id=project["id"],
        title="Open 2",
        partner_ids=[partner["id"]],
    )
    done_task = _create_task(
        client,
        admin_token,
        project_id=project["id"],
        title="Will be done",
        partner_ids=[partner["id"]],
    )
    patch = client.patch(
        f"/api/tasks/{done_task['id']}",
        headers=auth_headers(admin_token),
        json={"status": "done"},
    )
    assert patch.status_code == 200

    listing = client.get(
        "/api/partners?q=AggPartner", headers=auth_headers(admin_token)
    )
    assert listing.status_code == 200
    rows = [row for row in listing.json() if row["id"] == partner["id"]]
    assert rows, listing.json()
    row = rows[0]
    assert row["task_count"] == 3
    assert row["open_task_count"] == 2
    assert row["last_task_activity_at"] is not None


def test_create_task_with_unknown_partner_rejected(client: TestClient, admin_token: str):
    project = _create_project(client, admin_token, "2026-PAR-7")
    resp = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project["id"],
            "title": "Bad partner",
            "partner_ids": [99999],
        },
    )
    assert resp.status_code == 400
    assert "99999" in resp.text


def test_update_task_to_empty_partner_ids_removes_all(
    client: TestClient, admin_token: str
):
    project = _create_project(client, admin_token, "2026-PAR-8")
    partner = _create_partner(client, admin_token, name="ToRemove", trade="Elektro")

    task = _create_task(
        client,
        admin_token,
        project_id=project["id"],
        title="Clear partners",
        partner_ids=[partner["id"]],
    )
    patch = client.patch(
        f"/api/tasks/{task['id']}",
        headers=auth_headers(admin_token),
        json={"partner_ids": []},
    )
    assert patch.status_code == 200, patch.text
    assert patch.json()["partner_ids"] == []
    assert patch.json()["partners"] == []

    linked = client.get(
        f"/api/partners/{partner['id']}/tasks", headers=auth_headers(admin_token)
    )
    assert linked.status_code == 200
    assert linked.json() == []
