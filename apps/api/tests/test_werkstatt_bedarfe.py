"""Projekt-Bedarfe: editing, bulk actions and the hand-off into an order.

The complaints these pin, in order:

  * completing ten projects' worth of needs one click at a time — hence the
    bulk endpoints, and hence the assertion that one bulk call writes ONE
    activity per project rather than eighty;
  * a need that names an article nobody can order from — hence `orderable`,
    the skip reasons, and the refusal to invent a free-text line;
  * a quantity typed as "2,5" silently becoming 2 or 25 in the wholesaler's
    basket — hence the round-up plus a warning the modal has to show;
  * an order that was delivered while its needs still said "Bestellen".

Visibility is the other half: every bulk endpoint acts by id, so a selection
made before a project was archived must not quietly touch rows the caller can
no longer see.
"""

from __future__ import annotations

from fastapi.testclient import TestClient


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# ── fixtures ──────────────────────────────────────────────────────────────


def _create_user(client: TestClient, admin_token: str, email: str, role: str) -> dict:
    resp = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={
            "email": email,
            "password": "Password123!",
            "full_name": "Bedarf Tester",
            "role": role,
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _login(client: TestClient, email: str) -> str:
    resp = client.post("/api/auth/login", json={"email": email, "password": "Password123!"})
    assert resp.status_code == 200, resp.text
    return resp.headers["X-Access-Token"]


def _project(client: TestClient, token: str, number: str, name: str = "Bedarf Projekt") -> int:
    resp = client.post(
        "/api/projects",
        headers=auth_headers(token),
        json={"project_number": number, "name": name, "status": "active"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _supplier(client: TestClient, token: str, name: str) -> int:
    resp = client.post(
        "/api/werkstatt/suppliers", headers=auth_headers(token), json={"name": name}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _catalog_row(
    supplier_id: int | None,
    *,
    article_no: str,
    name: str = "Katalogartikel",
    ean: str | None = None,
    unit: str | None = "Stk",
    manufacturer: str | None = "Lapp",
) -> int:
    """Insert a Datanorm row directly — the importer is not under test."""
    from app.core.db import SessionLocal
    from app.models.entities import MaterialCatalogItem

    with SessionLocal() as db:
        row = MaterialCatalogItem(
            external_key=f"{supplier_id or 0}-{article_no}-{ean or 'x'}",
            source_file="test.csv",
            source_line=1,
            article_no=article_no,
            item_name=name,
            ean=ean,
            unit=unit,
            manufacturer=manufacturer,
            supplier_id=supplier_id,
            search_text=f"{article_no} {name} {ean or ''}".lower(),
        )
        db.add(row)
        db.commit()
        return row.id


def _need(
    client: TestClient,
    token: str,
    project_id: int,
    **extra,
) -> dict:
    body: dict = {"project_id": project_id}
    body.update(extra)
    resp = client.post("/api/materials", headers=auth_headers(token), json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _bedarfe(client: TestClient, token: str, query: str = "") -> list[dict]:
    resp = client.get(f"/api/werkstatt/bedarfe{query}", headers=auth_headers(token))
    assert resp.status_code == 200, resp.text
    return resp.json()


def _activity_events(project_id: int, event_type: str) -> list[dict]:
    """Read the project feed straight from the table.

    There is no list endpoint for it — the overview embeds the last ten — and
    "one entry, not eighty" is exactly the assertion a ten-row window would
    hide.
    """
    from app.core.db import SessionLocal
    from app.models.entities import ProjectActivity
    from sqlalchemy import select

    with SessionLocal() as db:
        rows = db.scalars(
            select(ProjectActivity).where(
                ProjectActivity.project_id == project_id,
                ProjectActivity.event_type == event_type,
            )
        ).all()
        return [{"event_type": row.event_type, "details": dict(row.details or {})} for row in rows]


# ── list + filters ────────────────────────────────────────────────────────


def test_bedarfe_list_filters_by_status_supplier_and_text(client: TestClient, admin_token: str):
    project_a = _project(client, admin_token, "2026-B-1", "Halle A")
    project_b = _project(client, admin_token, "2026-B-2", "Halle B")
    supplier_id = _supplier(client, admin_token, "Unielektro")
    catalog_id = _catalog_row(supplier_id, article_no="UE-1000", name="NYM-J 3x1,5", ean="4011")

    linked = _need(
        client,
        admin_token,
        project_a,
        material_catalog_item_id=catalog_id,
        quantity="30",
    )
    loose = _need(client, admin_token, project_b, item="Kabelbinder schwarz")
    done = _need(client, admin_token, project_b, item="Abgehakt", status="completed")

    rows = _bedarfe(client, admin_token)
    ids = {row["id"] for row in rows}
    assert linked["id"] in ids and loose["id"] in ids
    assert done["id"] not in ids, "completed rows stay hidden unless asked for"

    with_completed = _bedarfe(client, admin_token, "?include_completed=true")
    assert done["id"] in {row["id"] for row in with_completed}

    by_project = _bedarfe(client, admin_token, f"?project_id={project_b}")
    assert {row["project_id"] for row in by_project} == {project_b}

    by_supplier = _bedarfe(client, admin_token, f"?supplier_id={supplier_id}")
    assert [row["id"] for row in by_supplier] == [linked["id"]]

    by_text = _bedarfe(client, admin_token, "?q=kabelbinder")
    assert [row["id"] for row in by_text] == [loose["id"]]

    # The project number is searchable too — it is what the office says out loud.
    by_number = _bedarfe(client, admin_token, "?q=2026-B-1")
    assert [row["id"] for row in by_number] == [linked["id"]]

    by_status = _bedarfe(client, admin_token, "?status=order")
    assert linked["id"] in {row["id"] for row in by_status}


def test_bedarfe_row_carries_supplier_and_orderability(client: TestClient, admin_token: str):
    project_id = _project(client, admin_token, "2026-B-3")
    supplier_id = _supplier(client, admin_token, "Unielektro")
    catalog_id = _catalog_row(
        supplier_id, article_no="UE-2000", name="Reihenklemme", ean="4012", unit="Stk"
    )
    linked = _need(client, admin_token, project_id, material_catalog_item_id=catalog_id)
    loose = _need(client, admin_token, project_id, item="Irgendwas")

    rows = {row["id"]: row for row in _bedarfe(client, admin_token)}

    assert rows[linked["id"]]["supplier_id"] == supplier_id
    assert rows[linked["id"]]["supplier_name"] == "Unielektro"
    assert rows[linked["id"]]["ean"] == "4012"
    assert rows[linked["id"]]["manufacturer"] == "Lapp"
    assert rows[linked["id"]]["catalog_item_name"] == "Reihenklemme"
    assert rows[linked["id"]]["orderable"] is True
    assert rows[linked["id"]]["source"] == "manual"

    assert rows[loose["id"]]["supplier_id"] is None
    assert rows[loose["id"]]["orderable"] is False

    only_orderable = _bedarfe(client, admin_token, "?orderable_only=true")
    assert [row["id"] for row in only_orderable] == [linked["id"]]


# ── inline edit + delete ──────────────────────────────────────────────────


def test_patch_edits_quantity_unit_item_and_relinks_catalog(client: TestClient, admin_token: str):
    project_id = _project(client, admin_token, "2026-B-4")
    supplier_id = _supplier(client, admin_token, "Unielektro")
    catalog_id = _catalog_row(
        supplier_id, article_no="UE-3000", name="Schiene 2m", unit="Stk", ean="4013"
    )
    need = _need(client, admin_token, project_id, item="Handeintrag")

    patched = client.patch(
        f"/api/materials/{need['id']}",
        headers=auth_headers(admin_token),
        json={"item": "Schiene", "quantity": "2,5", "unit": "m"},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["item"] == "Schiene"
    assert patched.json()["quantity"] == "2,5"
    assert patched.json()["unit"] == "m"

    # Linking a catalog row fills the empty article number from it but leaves
    # the unit the fitter typed alone.
    linked = client.patch(
        f"/api/materials/{need['id']}",
        headers=auth_headers(admin_token),
        json={"material_catalog_item_id": catalog_id},
    )
    assert linked.status_code == 200, linked.text
    assert linked.json()["material_catalog_item_id"] == catalog_id
    assert linked.json()["article_no"] == "UE-3000"
    assert linked.json()["unit"] == "m"
    assert linked.json()["orderable"] is True

    # An explicit null unlinks — a re-imported catalogue is how a row loses
    # its match, and the office has to be able to do it by hand too.
    unlinked = client.patch(
        f"/api/materials/{need['id']}",
        headers=auth_headers(admin_token),
        json={"material_catalog_item_id": None},
    )
    assert unlinked.status_code == 200, unlinked.text
    assert unlinked.json()["material_catalog_item_id"] is None
    assert unlinked.json()["orderable"] is False
    assert unlinked.json()["article_no"] == "UE-3000", "the number stays as a re-link hint"


def test_patch_accepts_ordered_status_and_keeps_it_distinct(client: TestClient, admin_token: str):
    project_id = _project(client, admin_token, "2026-B-5")
    need = _need(client, admin_token, project_id, item="Bestellt-Test")

    for sent in ("ordered", "bestellt"):
        resp = client.patch(
            f"/api/materials/{need['id']}",
            headers=auth_headers(admin_token),
            json={"status": sent},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "ordered"

    back = client.patch(
        f"/api/materials/{need['id']}",
        headers=auth_headers(admin_token),
        json={"status": "order"},
    )
    assert back.json()["status"] == "order"


def test_delete_need_removes_row_and_denies_foreign_project(client: TestClient, admin_token: str):
    project_id = _project(client, admin_token, "2026-B-6")
    outsider = _create_user(client, admin_token, "bedarf-outsider@example.com", "employee")
    outsider_token = _login(client, outsider["email"])
    removed = client.delete(
        f"/api/projects/{project_id}/members/{outsider['id']}", headers=auth_headers(admin_token)
    )
    assert removed.status_code in (200, 204), removed.text

    need = _need(client, admin_token, project_id, item="Zu löschen")

    denied = client.delete(
        f"/api/materials/{need['id']}", headers=auth_headers(outsider_token)
    )
    assert denied.status_code == 403

    gone = client.delete(f"/api/materials/{need['id']}", headers=auth_headers(admin_token))
    assert gone.status_code == 204, gone.text
    assert need["id"] not in {row["id"] for row in _bedarfe(client, admin_token)}

    again = client.delete(f"/api/materials/{need['id']}", headers=auth_headers(admin_token))
    assert again.status_code == 404


# ── bulk ──────────────────────────────────────────────────────────────────


def test_bulk_status_writes_one_activity_per_project(client: TestClient, admin_token: str):
    project_a = _project(client, admin_token, "2026-B-7", "Bulk A")
    project_b = _project(client, admin_token, "2026-B-8", "Bulk B")
    needs_a = [_need(client, admin_token, project_a, item=f"A{i}") for i in range(3)]
    needs_b = [_need(client, admin_token, project_b, item=f"B{i}") for i in range(2)]
    ids = [row["id"] for row in needs_a + needs_b]

    resp = client.post(
        "/api/werkstatt/bedarfe/bulk",
        headers=auth_headers(admin_token),
        json={"ids": ids, "status": "completed"},
    )
    assert resp.status_code == 200, resp.text
    assert {row["status"] for row in resp.json()} == {"completed"}
    assert len(resp.json()) == 5

    bulk_events = _activity_events(project_a, "material.bulk_status_updated")
    assert len(bulk_events) == 1, "eighty rows must not mean eighty feed entries"
    assert bulk_events[0]["details"]["count"] == 3
    assert bulk_events[0]["details"]["to"] == "completed"


def test_bulk_rejects_ids_outside_the_callers_projects(client: TestClient, admin_token: str):
    project_id = _project(client, admin_token, "2026-B-9")
    employee = _create_user(client, admin_token, "bedarf-bulk@example.com", "employee")
    employee_token = _login(client, employee["email"])
    removed = client.delete(
        f"/api/projects/{project_id}/members/{employee['id']}", headers=auth_headers(admin_token)
    )
    assert removed.status_code in (200, 204), removed.text

    hidden = _need(client, admin_token, project_id, item="Nicht sichtbar")

    resp = client.post(
        "/api/werkstatt/bedarfe/bulk",
        headers=auth_headers(employee_token),
        json={"ids": [hidden["id"]], "status": "completed"},
    )
    assert resp.status_code == 403
    assert str(hidden["id"]) in str(resp.json()["detail"])

    # Nothing was written.
    unchanged = client.get(
        f"/api/materials", headers=auth_headers(admin_token)
    ).json()
    assert next(row for row in unchanged if row["id"] == hidden["id"])["status"] == "order"


def test_bulk_delete_removes_rows_and_logs_once(client: TestClient, admin_token: str):
    project_id = _project(client, admin_token, "2026-B-10")
    needs = [_need(client, admin_token, project_id, item=f"Weg {i}") for i in range(3)]

    resp = client.post(
        "/api/werkstatt/bedarfe/bulk-delete",
        headers=auth_headers(admin_token),
        json={"ids": [row["id"] for row in needs]},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["deleted"] == 3
    assert _bedarfe(client, admin_token) == []

    events = _activity_events(project_id, "material.bulk_deleted")
    assert len(events) == 1
    assert events[0]["details"]["count"] == 3


# ── create order ──────────────────────────────────────────────────────────


def test_create_order_groups_by_supplier_and_links_needs(client: TestClient, admin_token: str):
    project_id = _project(client, admin_token, "2026-B-11", "Bestellprojekt")
    unielektro = _supplier(client, admin_token, "Unielektro")
    sonepar = _supplier(client, admin_token, "Sonepar")
    cat_ue = _catalog_row(unielektro, article_no="UE-1", name="NYM-J 5x6", ean="4014", unit="m")
    cat_sp = _catalog_row(sonepar, article_no="SP-1", name="Klemme", ean="4015")

    need_ue = _need(
        client, admin_token, project_id, material_catalog_item_id=cat_ue, quantity="30"
    )
    need_sp = _need(
        client, admin_token, project_id, material_catalog_item_id=cat_sp, quantity="4"
    )
    need_free = _need(client, admin_token, project_id, item="Ohne Katalog")

    resp = client.post(
        "/api/werkstatt/bedarfe/create-order",
        headers=auth_headers(admin_token),
        json={"need_ids": [need_ue["id"], need_sp["id"], need_free["id"]]},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert len(body["orders"]) == 2, "one draft per supplier"
    assert {order["status"] for order in body["orders"]} == {"draft"}
    assert {order["source"] for order in body["orders"]} == {"needs"}
    assert {order["project_id"] for order in body["orders"]} == {project_id}

    ue_order = next(o for o in body["orders"] if o["supplier_id"] == unielektro)
    assert len(ue_order["lines"]) == 1
    line = ue_order["lines"][0]
    assert line["supplier_article_no"] == "UE-1"
    assert line["description"] == "NYM-J 5x6"
    assert line["ean"] == "4014"
    assert line["unit"] == "m"
    assert line["quantity_ordered"] == 30
    assert "2026-B-11" in (line["notes"] or "")

    assert [entry["need_id"] for entry in body["skipped"]] == [need_free["id"]]
    assert body["skipped"][0]["reason"] == "no_catalog_item"

    rows = {row["id"]: row for row in _bedarfe(client, admin_token)}
    assert rows[need_ue["id"]]["status"] == "ordered"
    assert rows[need_ue["id"]]["werkstatt_order_id"] == ue_order["id"]
    assert rows[need_ue["id"]]["werkstatt_order_number"] == ue_order["order_number"]
    assert rows[need_ue["id"]]["werkstatt_order_line_id"] == line["id"]
    assert rows[need_ue["id"]]["ordered_at"] is not None
    assert rows[need_sp["id"]]["status"] == "ordered"
    assert rows[need_free["id"]]["status"] == "order"

    events = _activity_events(project_id, "material.ordered")
    assert len(events) == 2
    assert any(ue_order["order_number"] == event["details"].get("order_number") for event in events)


def test_create_order_rounds_fractional_quantity_up_with_a_warning(
    client: TestClient, admin_token: str
):
    project_id = _project(client, admin_token, "2026-B-12")
    supplier_id = _supplier(client, admin_token, "Unielektro")
    catalog_id = _catalog_row(supplier_id, article_no="UE-9", name="Ring", unit="m")
    rounded = _need(
        client, admin_token, project_id, material_catalog_item_id=catalog_id, quantity="2,5"
    )
    unreadable = _need(
        client,
        admin_token,
        project_id,
        material_catalog_item_id=catalog_id,
        quantity="ca. 3 Ringe",
    )

    resp = client.post(
        "/api/werkstatt/bedarfe/create-order",
        headers=auth_headers(admin_token),
        json={"need_ids": [rounded["id"], unreadable["id"]]},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    added = {entry["need_id"]: entry for entry in body["added"]}

    assert added[rounded["id"]]["quantity_warning"] is not None
    assert "2,5" in added[rounded["id"]]["quantity_warning"]
    assert added[unreadable["id"]]["quantity_warning"] is not None

    order = body["orders"][0]
    by_line = {line["id"]: line for line in order["lines"]}
    assert by_line[added[rounded["id"]]["line_id"]]["quantity_ordered"] == 3
    assert by_line[added[unreadable["id"]]["line_id"]]["quantity_ordered"] == 1
    assert "aufgerundet" in (by_line[added[rounded["id"]]["line_id"]]["notes"] or "")


def test_create_order_skips_already_ordered_completed_and_other_supplier(
    client: TestClient, admin_token: str
):
    project_id = _project(client, admin_token, "2026-B-13")
    unielektro = _supplier(client, admin_token, "Unielektro")
    sonepar = _supplier(client, admin_token, "Sonepar")
    cat_ue = _catalog_row(unielektro, article_no="UE-5", name="Dose")
    cat_sp = _catalog_row(sonepar, article_no="SP-5", name="Dose SP")

    first = _need(client, admin_token, project_id, material_catalog_item_id=cat_ue, quantity="2")
    second = _need(client, admin_token, project_id, material_catalog_item_id=cat_ue, quantity="1")
    other = _need(client, admin_token, project_id, material_catalog_item_id=cat_sp, quantity="1")
    finished = _need(
        client,
        admin_token,
        project_id,
        material_catalog_item_id=cat_ue,
        quantity="1",
        status="completed",
    )

    initial = client.post(
        "/api/werkstatt/bedarfe/create-order",
        headers=auth_headers(admin_token),
        json={"need_ids": [first["id"]]},
    )
    assert initial.status_code == 200, initial.text
    first_order = initial.json()["orders"][0]

    resp = client.post(
        "/api/werkstatt/bedarfe/create-order",
        headers=auth_headers(admin_token),
        json={
            "need_ids": [first["id"], second["id"], other["id"], finished["id"]],
            "supplier_id": unielektro,
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    reasons = {entry["need_id"]: entry["reason"] for entry in body["skipped"]}
    assert reasons[first["id"]] == "already_ordered"
    assert reasons[other["id"]] == "other_supplier"
    assert reasons[finished["id"]] == "completed"
    assert [entry["need_id"] for entry in body["added"]] == [second["id"]]
    assert body["orders"][0]["id"] != first_order["id"]


def test_create_order_appends_to_an_existing_draft(client: TestClient, admin_token: str):
    project_id = _project(client, admin_token, "2026-B-14")
    supplier_id = _supplier(client, admin_token, "Unielektro")
    catalog_id = _catalog_row(supplier_id, article_no="UE-7", name="Rohr")
    need = _need(
        client, admin_token, project_id, material_catalog_item_id=catalog_id, quantity="5"
    )

    draft = client.post(
        "/api/werkstatt/orders",
        headers=auth_headers(admin_token),
        json={"supplier_id": supplier_id, "title": "Sammelbestellung"},
    )
    assert draft.status_code == 200, draft.text
    draft_id = draft.json()["id"]

    resp = client.post(
        "/api/werkstatt/bedarfe/create-order",
        headers=auth_headers(admin_token),
        json={"need_ids": [need["id"]], "order_id": draft_id},
    )
    assert resp.status_code == 200, resp.text
    assert [order["id"] for order in resp.json()["orders"]] == [draft_id]
    assert len(resp.json()["orders"][0]["lines"]) == 1

    sent = client.post(
        f"/api/werkstatt/orders/{draft_id}/mark-sent", headers=auth_headers(admin_token)
    )
    assert sent.status_code == 200, sent.text

    blocked = client.post(
        "/api/werkstatt/bedarfe/create-order",
        headers=auth_headers(admin_token),
        json={"need_ids": [need["id"]], "order_id": draft_id},
    )
    assert blocked.status_code == 409


def test_create_order_spanning_projects_leaves_the_order_unassigned(
    client: TestClient, admin_token: str
):
    project_a = _project(client, admin_token, "2026-B-15", "Halle A")
    project_b = _project(client, admin_token, "2026-B-16", "Halle B")
    supplier_id = _supplier(client, admin_token, "Unielektro")
    catalog_id = _catalog_row(supplier_id, article_no="UE-8", name="Kanal")

    need_a = _need(
        client, admin_token, project_a, material_catalog_item_id=catalog_id, quantity="1"
    )
    need_b = _need(
        client, admin_token, project_b, material_catalog_item_id=catalog_id, quantity="1"
    )

    resp = client.post(
        "/api/werkstatt/bedarfe/create-order",
        headers=auth_headers(admin_token),
        json={"need_ids": [need_a["id"], need_b["id"]]},
    )
    assert resp.status_code == 200, resp.text
    order = resp.json()["orders"][0]
    assert order["project_id"] is None
    assert "2" in (order["title"] or ""), "the title has to say it spans several projects"
    notes = " ".join(line["notes"] or "" for line in order["lines"])
    assert "2026-B-15" in notes and "2026-B-16" in notes


def test_create_order_requires_werkstatt_manage(client: TestClient, admin_token: str):
    project_id = _project(client, admin_token, "2026-B-17")
    supplier_id = _supplier(client, admin_token, "Unielektro")
    catalog_id = _catalog_row(supplier_id, article_no="UE-11", name="Klemme")
    need = _need(
        client, admin_token, project_id, material_catalog_item_id=catalog_id, quantity="1"
    )
    employee = _create_user(client, admin_token, "bedarf-employee@example.com", "employee")
    employee_token = _login(client, employee["email"])

    resp = client.post(
        "/api/werkstatt/bedarfe/create-order",
        headers=auth_headers(employee_token),
        json={"need_ids": [need["id"]]},
    )
    assert resp.status_code == 403


def test_needs_created_order_is_a_draft_and_is_not_sent(client: TestClient, admin_token: str):
    project_id = _project(client, admin_token, "2026-B-18")
    supplier_id = _supplier(client, admin_token, "Unielektro")
    catalog_id = _catalog_row(supplier_id, article_no="UE-12", name="Schelle")
    need = _need(
        client, admin_token, project_id, material_catalog_item_id=catalog_id, quantity="1"
    )

    resp = client.post(
        "/api/werkstatt/bedarfe/create-order",
        headers=auth_headers(admin_token),
        json={"need_ids": [need["id"]]},
    )
    order = resp.json()["orders"][0]
    assert order["status"] == "draft"
    assert order["ordered_at"] is None
    assert order["submitted_at"] is None


# ── reverse hooks ─────────────────────────────────────────────────────────


def _ordered_need(client: TestClient, admin_token: str, number: str) -> tuple[dict, dict]:
    project_id = _project(client, admin_token, number)
    supplier_id = _supplier(client, admin_token, "Unielektro")
    catalog_id = _catalog_row(supplier_id, article_no=f"UE-{number}", name="Teil")
    need = _need(
        client, admin_token, project_id, material_catalog_item_id=catalog_id, quantity="2"
    )
    resp = client.post(
        "/api/werkstatt/bedarfe/create-order",
        headers=auth_headers(admin_token),
        json={"need_ids": [need["id"]]},
    )
    assert resp.status_code == 200, resp.text
    return need, resp.json()["orders"][0]


def _need_row(client: TestClient, admin_token: str, need_id: int) -> dict:
    rows = _bedarfe(client, admin_token, "?include_completed=true")
    return next(row for row in rows if row["id"] == need_id)


def test_marking_the_order_delivered_makes_its_needs_available(
    client: TestClient, admin_token: str
):
    need, order = _ordered_need(client, admin_token, "2026-B-19")

    sent = client.post(
        f"/api/werkstatt/orders/{order['id']}/mark-sent", headers=auth_headers(admin_token)
    )
    assert sent.status_code == 200, sent.text
    delivered = client.post(
        f"/api/werkstatt/orders/{order['id']}/mark-delivered", headers=auth_headers(admin_token)
    )
    assert delivered.status_code == 200, delivered.text

    row = _need_row(client, admin_token, need["id"])
    assert row["status"] == "available"
    assert row["werkstatt_order_id"] == order["id"], "the link survives — it is the receipt"


def test_cancelling_the_order_puts_its_needs_back_on_the_list(
    client: TestClient, admin_token: str
):
    need, order = _ordered_need(client, admin_token, "2026-B-20")

    cancelled = client.post(
        f"/api/werkstatt/orders/{order['id']}/cancel", headers=auth_headers(admin_token)
    )
    assert cancelled.status_code == 200, cancelled.text

    row = _need_row(client, admin_token, need["id"])
    assert row["status"] == "order"
    assert row["werkstatt_order_id"] is None
    assert row["werkstatt_order_line_id"] is None
    assert row["ordered_at"] is None


def test_deleting_the_line_puts_only_that_need_back(client: TestClient, admin_token: str):
    need, order = _ordered_need(client, admin_token, "2026-B-21")
    line_id = order["lines"][0]["id"]

    deleted = client.delete(
        f"/api/werkstatt/orders/{order['id']}/lines/{line_id}",
        headers=auth_headers(admin_token),
    )
    assert deleted.status_code == 200, deleted.text

    row = _need_row(client, admin_token, need["id"])
    assert row["status"] == "order"
    assert row["werkstatt_order_line_id"] is None


def test_deleting_a_need_only_unlinks_it_from_the_order(client: TestClient, admin_token: str):
    need, order = _ordered_need(client, admin_token, "2026-B-22")

    gone = client.delete(f"/api/materials/{need['id']}", headers=auth_headers(admin_token))
    assert gone.status_code == 204, gone.text

    still_there = client.get(
        f"/api/werkstatt/orders/{order['id']}", headers=auth_headers(admin_token)
    )
    assert still_there.status_code == 200
    assert len(still_there.json()["lines"]) == 1, "the line is what was bought"


def test_merging_the_draft_keeps_its_needs_reachable(client: TestClient, admin_token: str):
    """The fourth order event: a folded draft must not strand its Bedarfe.

    Merging retires the source without going through `cancel`, so nothing in
    the lifecycle hooks fires. Before this was handled, the six needs of a
    merged draft kept pointing at a cancelled order: "geliefert" never reached
    them, and re-ordering was refused as `already_ordered` naming an order
    that could never be cancelled again. The only way out was retyping them.
    """

    need, source = _ordered_need(client, admin_token, "2026-B-23")

    # A second draft for the same supplier — the weekly basket this is folded
    # into. Built through the needs hand-off so it has the same supplier.
    project_id = _project(client, admin_token, "2026-B-24")
    supplier_id = source["supplier_id"]
    other_catalog = _catalog_row(supplier_id, article_no="UE-OTHER", name="Dose")
    other_need = _need(
        client, admin_token, project_id, material_catalog_item_id=other_catalog, quantity="3"
    )
    target = client.post(
        "/api/werkstatt/bedarfe/create-order",
        headers=auth_headers(admin_token),
        json={"need_ids": [other_need["id"]]},
    ).json()["orders"][0]

    merged = client.post(
        f"/api/werkstatt/orders/{target['id']}/merge",
        headers=auth_headers(admin_token),
        json={"source_order_id": source["id"], "combine_duplicates": False},
    )
    assert merged.status_code == 200, merged.text
    assert len(merged.json()["lines"]) == 2

    moved = _need_row(client, admin_token, need["id"])
    assert moved["werkstatt_order_id"] == target["id"], "the need follows its line"
    assert moved["werkstatt_order_number"] == target["order_number"]
    assert moved["status"] == "ordered"

    client.post(
        f"/api/werkstatt/orders/{target['id']}/mark-sent", headers=auth_headers(admin_token)
    )
    delivered = client.post(
        f"/api/werkstatt/orders/{target['id']}/mark-delivered",
        headers=auth_headers(admin_token),
    )
    assert delivered.status_code == 200, delivered.text

    for entry in (need, other_need):
        assert _need_row(client, admin_token, entry["id"])["status"] == "available"


def test_merging_a_folded_duplicate_puts_the_need_back_on_the_list(
    client: TestClient, admin_token: str
):
    """`combine_duplicates` deletes the source line — the need loses its receipt."""

    project_id = _project(client, admin_token, "2026-B-25")
    supplier_id = _supplier(client, admin_token, "Unielektro")
    catalog_id = _catalog_row(supplier_id, article_no="UE-DUP", name="Klemme")

    first = _need(
        client, admin_token, project_id, material_catalog_item_id=catalog_id, quantity="2"
    )
    second = _need(
        client, admin_token, project_id, material_catalog_item_id=catalog_id, quantity="4"
    )
    target = client.post(
        "/api/werkstatt/bedarfe/create-order",
        headers=auth_headers(admin_token),
        json={"need_ids": [first["id"]]},
    ).json()["orders"][0]
    source = client.post(
        "/api/werkstatt/bedarfe/create-order",
        headers=auth_headers(admin_token),
        json={"need_ids": [second["id"]]},
    ).json()["orders"][0]

    merged = client.post(
        f"/api/werkstatt/orders/{target['id']}/merge",
        headers=auth_headers(admin_token),
        json={"source_order_id": source["id"], "combine_duplicates": True},
    )
    assert merged.status_code == 200, merged.text
    assert len(merged.json()["lines"]) == 1, "the duplicate was folded"
    assert merged.json()["lines"][0]["quantity_ordered"] == 6

    kept = _need_row(client, admin_token, first["id"])
    assert kept["werkstatt_order_id"] == target["id"]

    released = _need_row(client, admin_token, second["id"])
    assert released["status"] == "order", "no line of its own left — back on the list"
    assert released["werkstatt_order_id"] is None
    assert released["werkstatt_order_line_id"] is None
    assert released["ordered_at"] is None


# ── response shape ────────────────────────────────────────────────────────


def test_need_rows_keep_their_timestamps_and_actors(client: TestClient, admin_token: str):
    """Four fields other clients read. Pydantic drops unknown kwargs silently,
    so a schema that forgets them fails nowhere except at the consumer."""

    project_id = _project(client, admin_token, "2026-B-26")
    need = _need(client, admin_token, project_id, item="Zeitstempel")

    for row in (
        need,
        _need_row(client, admin_token, need["id"]),
        client.get("/api/materials", headers=auth_headers(admin_token)).json()[0],
    ):
        assert row["created_at"], row
        assert row["updated_at"], row
        assert "created_by" in row and "updated_by" in row


def test_manual_need_carries_a_note_from_the_start(client: TestClient, admin_token: str):
    project_id = _project(client, admin_token, "2026-B-27")
    need = _need(
        client,
        admin_token,
        project_id,
        item="Kabelbinder schwarz",
        notes="Rest vom Freitag reicht nicht",
    )
    assert need["notes"] == "Rest vom Freitag reicht nicht"


def test_patch_clears_a_note_with_an_explicit_null(client: TestClient, admin_token: str):
    """The row editor's only way to empty a note — it sends null, not ''."""

    project_id = _project(client, admin_token, "2026-B-28")
    need = _need(client, admin_token, project_id, item="Notiz-Test", notes="bitte prüfen")

    cleared = client.patch(
        f"/api/materials/{need['id']}",
        headers=auth_headers(admin_token),
        json={"notes": None},
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["notes"] is None

    # An omitted key still means "leave it alone".
    client.patch(
        f"/api/materials/{need['id']}",
        headers=auth_headers(admin_token),
        json={"notes": "wieder da"},
    )
    untouched = client.patch(
        f"/api/materials/{need['id']}",
        headers=auth_headers(admin_token),
        json={"quantity": "5"},
    )
    assert untouched.json()["notes"] == "wieder da"


def test_legacy_materials_list_ranks_ordered_between_order_and_on_the_way(
    client: TestClient, admin_token: str
):
    """The mobile shell reads /materials; both lists must agree on the ladder."""

    project_id = _project(client, admin_token, "2026-B-29")
    _need(client, admin_token, project_id, item="C-verfuegbar", status="available")
    _need(client, admin_token, project_id, item="B-bestellt", status="ordered")
    _need(client, admin_token, project_id, item="A-bestellen", status="order")

    rows = client.get("/api/materials", headers=auth_headers(admin_token)).json()
    items = [row["item"] for row in rows if row["project_id"] == project_id]
    assert items == ["A-bestellen", "B-bestellt", "C-verfuegbar"]


# ── filter edge cases ─────────────────────────────────────────────────────


def test_status_chips_and_show_completed_are_additive(client: TestClient, admin_token: str):
    """Two visibly active controls, both honoured — a ticked box must do something."""

    project_id = _project(client, admin_token, "2026-B-30")
    open_need = _need(client, admin_token, project_id, item="Offen")
    done = _need(client, admin_token, project_id, item="Fertig", status="completed")

    only_open = _bedarfe(client, admin_token, "?status=order")
    assert {row["id"] for row in only_open} & {open_need["id"], done["id"]} == {open_need["id"]}

    both = _bedarfe(client, admin_token, "?status=order&include_completed=true")
    ids = {row["id"] for row in both}
    assert open_need["id"] in ids and done["id"] in ids


def test_unknown_filter_values_are_refused_in_german(client: TestClient, admin_token: str):
    """A typo must narrow to nothing or explain itself — never widen the list."""

    bad_status = client.get(
        "/api/werkstatt/bedarfe?status=bestelt", headers=auth_headers(admin_token)
    )
    assert bad_status.status_code == 400
    assert "Status-Filter" in bad_status.json()["detail"]

    bad_supplier = client.get(
        "/api/werkstatt/bedarfe?supplier_id=unielektro", headers=auth_headers(admin_token)
    )
    assert bad_supplier.status_code == 400
    assert "Lieferanten-Filter" in bad_supplier.json()["detail"]


def test_supplier_filter_none_lists_exactly_the_unorderable_rows(
    client: TestClient, admin_token: str
):
    """The queue "Katalog-Artikel zuordnen" exists for — the inverse of orderable_only."""

    project_id = _project(client, admin_token, "2026-B-31")
    supplier_id = _supplier(client, admin_token, "Unielektro")
    linked = _need(
        client,
        admin_token,
        project_id,
        material_catalog_item_id=_catalog_row(supplier_id, article_no="UE-31"),
    )
    no_catalog = _need(client, admin_token, project_id, item="Freitext")
    # A legacy Datanorm row from before per-supplier imports: catalogue match,
    # nobody to buy it from. It belongs in the same queue.
    no_supplier = _need(
        client,
        admin_token,
        project_id,
        material_catalog_item_id=_catalog_row(None, article_no="LEGACY-31"),
    )

    rows = _bedarfe(client, admin_token, f"?project_id={project_id}&supplier_id=none")
    assert {row["id"] for row in rows} == {no_catalog["id"], no_supplier["id"]}

    orderable = _bedarfe(client, admin_token, f"?project_id={project_id}&orderable_only=true")
    assert [row["id"] for row in orderable] == [linked["id"]]


# ── quantity parsing ──────────────────────────────────────────────────────


def test_order_quantity_matches_the_browser_twin_case_for_case():
    """Same grammar both sides — see apps/web/src/test/materialsUtils.test.ts.

    The pair that mattered: '1e3' ordered a thousand units here while the
    preview said 1, and 'NaN'/'Infinity' raised out of the router as a bare
    500 instead of a German 4xx.
    """

    from app.services.material_need_rows import order_quantity_for_need

    assert order_quantity_for_need("30") == (30, None)
    assert order_quantity_for_need("2,5")[0] == 3
    assert order_quantity_for_need("1.234,5")[0] == 1235
    assert order_quantity_for_need("1,234.5")[0] == 1235

    for unreadable in ("1e3", "NaN", "Infinity", "-NaN", "2.", ".5", "ca. 3 Ringe"):
        quantity, warning = order_quantity_for_need(unreadable)
        assert quantity == 1, unreadable
        assert warning and "nicht lesbar" in warning, unreadable

    for refused in ("0", "-4"):
        quantity, warning = order_quantity_for_need(refused)
        assert quantity == 1
        assert warning and "nicht bestellbar" in warning

    assert order_quantity_for_need("")[1] == "Keine Menge angegeben – 1 angenommen, bitte prüfen"


def test_create_order_does_not_crash_on_an_exotic_quantity(
    client: TestClient, admin_token: str
):
    """A free-text field reaches the wholesaler line; it may warn, never 500."""

    project_id = _project(client, admin_token, "2026-B-32")
    supplier_id = _supplier(client, admin_token, "Unielektro")
    catalog_id = _catalog_row(supplier_id, article_no="UE-32", name="Rohr")
    need = _need(
        client, admin_token, project_id, material_catalog_item_id=catalog_id, quantity="1e3"
    )

    resp = client.post(
        "/api/werkstatt/bedarfe/create-order",
        headers=auth_headers(admin_token),
        json={"need_ids": [need["id"]]},
    )
    assert resp.status_code == 200, resp.text
    line = resp.json()["orders"][0]["lines"][0]
    assert line["quantity_ordered"] == 1, "unreadable is 1, never a thousand"
    assert "nicht lesbar" in (resp.json()["added"][0]["quantity_warning"] or "")
