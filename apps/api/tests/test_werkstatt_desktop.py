"""End-to-end tests for the Werkstatt Desktop BE endpoints.

Covers at least one happy-path + one error-path per endpoint shipped by the
Desktop BE agent (see `WERKSTATT_CONTRACT.md` §3.3).

Auth fixtures follow the pattern from `tests/test_material_catalog.py`.
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi.testclient import TestClient


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_user(client: TestClient, admin_token: str, email: str, role: str) -> dict:
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
    assert response.status_code == 200, response.text
    return response.json()


def _login(client: TestClient, email: str) -> str:
    response = client.post(
        "/api/auth/login", json={"email": email, "password": "Password123!"}
    )
    assert response.status_code == 200, response.text
    return response.headers["X-Access-Token"]


def _reset_catalog_dir() -> Path:
    catalog_dir = Path(os.environ["MATERIAL_CATALOG_DIR"])
    for path in catalog_dir.iterdir():
        if path.is_file():
            path.unlink()
    return catalog_dir


# ──────────────────────────────────────────────────────────────────────────
# Taxonomy — categories + locations
# ──────────────────────────────────────────────────────────────────────────


def test_create_list_update_archive_category(client: TestClient, admin_token: str) -> None:
    headers = auth_headers(admin_token)

    created = client.post(
        "/api/werkstatt/categories",
        headers=headers,
        json={"name": "Elektro", "display_order": 0, "icon_key": "bolt"},
    )
    assert created.status_code == 200, created.text
    category = created.json()
    assert category["name"] == "Elektro"
    assert category["article_count"] == 0
    category_id = category["id"]

    # Create a child so we can exercise tree ordering.
    child = client.post(
        "/api/werkstatt/categories",
        headers=headers,
        json={"name": "Kabel", "parent_id": category_id, "display_order": 0},
    )
    assert child.status_code == 200

    listed = client.get("/api/werkstatt/categories", headers=headers)
    assert listed.status_code == 200
    ids_in_order = [row["id"] for row in listed.json()]
    assert ids_in_order.index(category_id) < ids_in_order.index(child.json()["id"])

    updated = client.patch(
        f"/api/werkstatt/categories/{category_id}",
        headers=headers,
        json={"name": "Elektroinstallation"},
    )
    assert updated.status_code == 200
    assert updated.json()["name"] == "Elektroinstallation"

    archived = client.delete(f"/api/werkstatt/categories/{category_id}", headers=headers)
    assert archived.status_code == 200
    assert archived.json()["is_archived"] is True

    default_list = client.get("/api/werkstatt/categories", headers=headers)
    assert default_list.status_code == 200
    assert all(row["id"] != category_id for row in default_list.json())


def test_category_cannot_be_its_own_parent(client: TestClient, admin_token: str) -> None:
    headers = auth_headers(admin_token)
    created = client.post(
        "/api/werkstatt/categories", headers=headers, json={"name": "Werkzeuge"}
    )
    assert created.status_code == 200
    category_id = created.json()["id"]
    bad = client.patch(
        f"/api/werkstatt/categories/{category_id}",
        headers=headers,
        json={"parent_id": category_id},
    )
    assert bad.status_code == 400


def test_category_mutation_requires_permission(client: TestClient, admin_token: str) -> None:
    employee = _create_user(client, admin_token, "werk-cat-emp@example.com", "employee")
    employee_token = _login(client, employee["email"])
    denied = client.post(
        "/api/werkstatt/categories",
        headers=auth_headers(employee_token),
        json={"name": "Unauthorized"},
    )
    assert denied.status_code == 403


def test_location_crud_happy_and_missing(client: TestClient, admin_token: str) -> None:
    headers = auth_headers(admin_token)

    created = client.post(
        "/api/werkstatt/locations",
        headers=headers,
        json={"name": "Halle 1", "location_type": "hall"},
    )
    assert created.status_code == 200, created.text
    loc_id = created.json()["id"]

    missing = client.patch(
        "/api/werkstatt/locations/9999", headers=headers, json={"name": "ghost"}
    )
    assert missing.status_code == 404

    updated = client.patch(
        f"/api/werkstatt/locations/{loc_id}",
        headers=headers,
        json={"address": "Musterstr. 1"},
    )
    assert updated.status_code == 200
    assert updated.json()["address"] == "Musterstr. 1"

    archived = client.delete(f"/api/werkstatt/locations/{loc_id}", headers=headers)
    assert archived.status_code == 200
    assert archived.json()["is_archived"] is True


# ──────────────────────────────────────────────────────────────────────────
# Suppliers
# ──────────────────────────────────────────────────────────────────────────


def test_supplier_crud_and_duplicate_name_rejected(
    client: TestClient, admin_token: str
) -> None:
    headers = auth_headers(admin_token)

    created = client.post(
        "/api/werkstatt/suppliers",
        headers=headers,
        json={"name": "SMPL Supplier", "short_name": "SMPL"},
    )
    assert created.status_code == 200, created.text
    supplier_id = created.json()["id"]
    assert created.json()["article_count"] == 0
    assert created.json()["last_order_at"] is None

    # Duplicate name is rejected.
    dup = client.post(
        "/api/werkstatt/suppliers", headers=headers, json={"name": "SMPL Supplier"}
    )
    assert dup.status_code == 400

    listed = client.get("/api/werkstatt/suppliers", headers=headers)
    assert listed.status_code == 200
    names = [row["name"] for row in listed.json()]
    assert "SMPL Supplier" in names

    updated = client.patch(
        f"/api/werkstatt/suppliers/{supplier_id}",
        headers=headers,
        json={"default_lead_time_days": 7},
    )
    assert updated.status_code == 200
    assert updated.json()["default_lead_time_days"] == 7

    archived = client.delete(
        f"/api/werkstatt/suppliers/{supplier_id}", headers=headers
    )
    assert archived.status_code == 200
    assert archived.json()["is_archived"] is True


def test_supplier_mutation_requires_permission(
    client: TestClient, admin_token: str
) -> None:
    employee = _create_user(client, admin_token, "werk-sup-emp@example.com", "employee")
    employee_token = _login(client, employee["email"])
    denied = client.post(
        "/api/werkstatt/suppliers",
        headers=auth_headers(employee_token),
        json={"name": "Evil"},
    )
    assert denied.status_code == 403


# ──────────────────────────────────────────────────────────────────────────
# Articles + Article-Supplier links
# ──────────────────────────────────────────────────────────────────────────


def _make_supplier(client: TestClient, admin_token: str, name: str) -> dict:
    response = client.post(
        "/api/werkstatt/suppliers",
        headers=auth_headers(admin_token),
        json={"name": name, "default_lead_time_days": 5},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_article_create_list_patch_archive_with_supplier_link(
    client: TestClient, admin_token: str
) -> None:
    headers = auth_headers(admin_token)
    supplier = _make_supplier(client, admin_token, "Unielektro GmbH")

    created = client.post(
        "/api/werkstatt/articles",
        headers=headers,
        json={
            "item_name": "Bohrmaschine BH-500",
            "manufacturer": "Bosch",
            "unit": "Stk",
            "stock_total": 3,
            "stock_min": 1,
            "supplier_links": [
                {
                    "supplier_id": supplier["id"],
                    "supplier_article_no": "B500-42",
                    "is_preferred": True,
                }
            ],
        },
    )
    assert created.status_code == 200, created.text
    article = created.json()
    assert article["article_number"].startswith("SP-")
    assert article["stock_available"] == 3
    assert article["stock_status"] == "available"
    assert len(article["suppliers"]) == 1
    assert article["suppliers"][0]["is_preferred"] is True
    article_id = article["id"]

    # Second supplier link marked preferred should flip the first.
    other_supplier = _make_supplier(client, admin_token, "Sonepar AG")
    link_resp = client.post(
        f"/api/werkstatt/articles/{article_id}/suppliers",
        headers=headers,
        json={
            "supplier_id": other_supplier["id"],
            "supplier_article_no": "S-BOHR-500",
            "is_preferred": True,
        },
    )
    assert link_resp.status_code == 200, link_resp.text

    detail = client.get(f"/api/werkstatt/articles/{article_id}", headers=headers)
    assert detail.status_code == 200
    preferred_flags = {row["supplier_id"]: row["is_preferred"] for row in detail.json()["suppliers"]}
    assert preferred_flags[supplier["id"]] is False
    assert preferred_flags[other_supplier["id"]] is True

    # List + filter by supplier.
    listed = client.get(
        f"/api/werkstatt/articles?supplier_id={other_supplier['id']}", headers=headers
    )
    assert listed.status_code == 200
    assert any(row["id"] == article_id for row in listed.json())

    # Search by manufacturer.
    search = client.get("/api/werkstatt/articles?q=Bosch", headers=headers)
    assert search.status_code == 200
    assert any(row["id"] == article_id for row in search.json())

    # Patch stock_min + notes.
    patched = client.patch(
        f"/api/werkstatt/articles/{article_id}",
        headers=headers,
        json={"stock_min": 5, "notes": "Kritisches Gerät"},
    )
    assert patched.status_code == 200
    assert patched.json()["stock_min"] == 5
    assert patched.json()["notes"] == "Kritisches Gerät"

    archived = client.delete(f"/api/werkstatt/articles/{article_id}", headers=headers)
    assert archived.status_code == 200
    assert archived.json()["is_archived"] is True


def test_article_create_rejects_duplicate_ean(client: TestClient, admin_token: str) -> None:
    headers = auth_headers(admin_token)
    first = client.post(
        "/api/werkstatt/articles",
        headers=headers,
        json={"item_name": "First", "ean": "1234567890123"},
    )
    assert first.status_code == 200
    dup = client.post(
        "/api/werkstatt/articles",
        headers=headers,
        json={"item_name": "Second", "ean": "1234567890123"},
    )
    assert dup.status_code == 400


def test_article_update_rejects_unknown_category(
    client: TestClient, admin_token: str
) -> None:
    headers = auth_headers(admin_token)
    created = client.post(
        "/api/werkstatt/articles", headers=headers, json={"item_name": "Meter"}
    )
    assert created.status_code == 200
    bad = client.patch(
        f"/api/werkstatt/articles/{created.json()['id']}",
        headers=headers,
        json={"category_id": 999999},
    )
    assert bad.status_code == 400


def test_article_supplier_link_delete_and_missing(
    client: TestClient, admin_token: str
) -> None:
    headers = auth_headers(admin_token)
    supplier = _make_supplier(client, admin_token, "Rexel")
    created = client.post(
        "/api/werkstatt/articles",
        headers=headers,
        json={
            "item_name": "LED-Strahler",
            "supplier_links": [{"supplier_id": supplier["id"]}],
        },
    )
    assert created.status_code == 200
    article = created.json()
    link_id = article["suppliers"][0]["id"]

    patched_link = client.patch(
        f"/api/werkstatt/articles/{article['id']}/suppliers/{link_id}",
        headers=headers,
        json={"typical_price_cents": 4990, "is_preferred": True},
    )
    assert patched_link.status_code == 200
    assert patched_link.json()["typical_price_cents"] == 4990
    assert patched_link.json()["is_preferred"] is True

    missing = client.patch(
        f"/api/werkstatt/articles/{article['id']}/suppliers/999999",
        headers=headers,
        json={"notes": "x"},
    )
    assert missing.status_code == 404

    deleted = client.delete(
        f"/api/werkstatt/articles/{article['id']}/suppliers/{link_id}", headers=headers
    )
    assert deleted.status_code == 200
    assert deleted.json() == {"ok": True}

    # Re-fetch: no suppliers remain.
    detail = client.get(f"/api/werkstatt/articles/{article['id']}", headers=headers)
    assert detail.status_code == 200
    assert detail.json()["suppliers"] == []


def test_article_from_catalog_happy_and_not_found(
    client: TestClient, admin_token: str
) -> None:
    headers = auth_headers(admin_token)
    # Seed catalog.
    catalog_dir = _reset_catalog_dir()
    (catalog_dir / "materials.csv").write_text(
        "\n".join(
            [
                "Artikelnummer;Bezeichnung;Einheit;Hersteller;Preis",
                "FC-1;Kabel FC-1;m;SMPL;9,90",
            ]
        ),
        encoding="utf-8",
    )
    search = client.get("/api/materials/catalog?q=FC-1", headers=headers)
    assert search.status_code == 200
    catalog_item = next(row for row in search.json() if row["article_no"] == "FC-1")

    created = client.post(
        "/api/werkstatt/articles/from-catalog",
        headers=headers,
        json={
            "catalog_item_id": catalog_item["id"],
            "stock_total": 100,
            "stock_min": 20,
        },
    )
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["item_name"] == "Kabel FC-1"
    assert body["manufacturer"] == "SMPL"
    assert body["source_catalog_item_id"] == catalog_item["id"]
    assert body["stock_total"] == 100
    assert body["stock_available"] == 100

    not_found = client.post(
        "/api/werkstatt/articles/from-catalog",
        headers=headers,
        json={"catalog_item_id": 9999999},
    )
    assert not_found.status_code == 404


def test_article_link_catalog_happy_and_refresh_image_no_catalog(
    client: TestClient, admin_token: str
) -> None:
    headers = auth_headers(admin_token)
    catalog_dir = _reset_catalog_dir()
    (catalog_dir / "materials.csv").write_text(
        "\n".join(
            [
                "Artikelnummer;Bezeichnung;Einheit;Hersteller;Preis",
                "LINK-1;Linker Article;Stk;SMPL;1,00",
            ]
        ),
        encoding="utf-8",
    )
    search = client.get("/api/materials/catalog?q=LINK-1", headers=headers)
    catalog_item = next(row for row in search.json() if row["article_no"] == "LINK-1")

    created = client.post(
        "/api/werkstatt/articles",
        headers=headers,
        json={"item_name": "Orphan", "unit": None},
    )
    article = created.json()

    linked = client.post(
        f"/api/werkstatt/articles/{article['id']}/link-catalog",
        headers=headers,
        json={"catalog_item_id": catalog_item["id"]},
    )
    assert linked.status_code == 200, linked.text
    assert linked.json()["source_catalog_item_id"] == catalog_item["id"]
    assert linked.json()["unit"] == "Stk"

    # refresh-image works without errors even when the lookup returns nothing.
    refreshed = client.post(
        f"/api/werkstatt/articles/{article['id']}/refresh-image", headers=headers
    )
    assert refreshed.status_code == 200


# ──────────────────────────────────────────────────────────────────────────
# Datanorm
# ──────────────────────────────────────────────────────────────────────────


DATANORM_SAMPLE = (
    "V 060226UNI ELEKTRO Fachgrosshandel GMBh&Co. Reg65760 Eschborn , Ludwig-Erhard-Strasse 2Copyright UNI ELEKTRO Fachgrosshand04EUR\n"
    "A;N;01000130;00;ABB S804PV-SP10;Strangsicherung 1.500V DC, 10A, 4-polig;1;0;ST;60400;;010;;\n"
    "B;N;01000130;S804PV-SP10;;;;;;7612271471699;;999;;;;;\n"
)


def test_datanorm_upload_preview_and_commit(
    client: TestClient, admin_token: str
) -> None:
    headers = auth_headers(admin_token)
    supplier = _make_supplier(client, admin_token, "Datanorm Partner")

    upload = client.post(
        "/api/werkstatt/datanorm/upload",
        headers=headers,
        data={"supplier_id": str(supplier["id"])},
        files={"file": ("vendor.001", DATANORM_SAMPLE.encode("utf-8"), "text/plain")},
    )
    assert upload.status_code == 200, upload.text
    preview = upload.json()
    assert preview["total_rows"] == 1
    assert preview["rows_new"] == 1
    assert preview["rows_updated"] == 0
    token = preview["import_token"]
    assert token

    commit = client.post(
        "/api/werkstatt/datanorm/commit",
        headers=headers,
        json={"import_token": token, "replace_mode": True},
    )
    assert commit.status_code == 200, commit.text
    body = commit.json()
    assert body["status"] == "committed"
    assert body["total_rows"] == 1

    # Catalog search through Werkstatt namespace should now return the row with
    # supplier metadata attached.
    catalog_search = client.get(
        f"/api/werkstatt/catalog/search?q=S804PV&supplier_id={supplier['id']}",
        headers=headers,
    )
    assert catalog_search.status_code == 200
    groups = catalog_search.json()
    assert groups
    assert groups[0]["hero"]["supplier_id"] == supplier["id"]

    history = client.get("/api/werkstatt/datanorm/history", headers=headers)
    assert history.status_code == 200
    assert any(row["id"] == body["id"] for row in history.json())


def test_datanorm_upload_rejects_unknown_supplier(
    client: TestClient, admin_token: str
) -> None:
    headers = auth_headers(admin_token)
    resp = client.post(
        "/api/werkstatt/datanorm/upload",
        headers=headers,
        data={"supplier_id": "99999"},
        files={"file": ("vendor.001", DATANORM_SAMPLE.encode("utf-8"), "text/plain")},
    )
    assert resp.status_code == 400


def test_datanorm_commit_rejects_bad_token(
    client: TestClient, admin_token: str
) -> None:
    headers = auth_headers(admin_token)
    resp = client.post(
        "/api/werkstatt/datanorm/commit",
        headers=headers,
        json={"import_token": "nope-nope-nope-nope"},
    )
    assert resp.status_code == 400


# ──────────────────────────────────────────────────────────────────────────
# Catalog search + Bedarfe read-through + Dashboard
# ──────────────────────────────────────────────────────────────────────────


def test_werkstatt_catalog_search_groups_by_ean(
    client: TestClient, admin_token: str
) -> None:
    headers = auth_headers(admin_token)
    catalog_dir = _reset_catalog_dir()
    (catalog_dir / "materials.csv").write_text(
        "\n".join(
            [
                "Artikelnummer;Bezeichnung;Einheit;Hersteller;Preis;EAN",
                "ABC-1;Lampe X;Stk;SMPL;9,90;4001234567890",
                "XYZ-9;Andere Lampe;Stk;SMPL;10,00;4001234567899",
            ]
        ),
        encoding="utf-8",
    )
    # Seed via the legacy endpoint so the filesystem catalog gets imported into
    # material_catalog_items. The Werkstatt search is read-only against that
    # table — it intentionally does NOT trigger a filesystem reimport.
    seed = client.get("/api/materials/catalog?q=Lampe", headers=headers)
    assert seed.status_code == 200

    resp = client.get("/api/werkstatt/catalog/search?q=Lampe", headers=headers)
    assert resp.status_code == 200
    groups = resp.json()
    assert len(groups) == 2
    assert {g["hero"]["article_no"] for g in groups} == {"ABC-1", "XYZ-9"}


def test_werkstatt_bedarfe_read_through(client: TestClient, admin_token: str) -> None:
    # Create a project + a material need, then check it shows in /werkstatt/bedarfe.
    project_resp = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": "WERK-BED-1", "name": "Bedarfe Project", "status": "active"},
    )
    assert project_resp.status_code == 200
    project_id = project_resp.json()["id"]

    need = client.post(
        "/api/materials",
        headers=auth_headers(admin_token),
        json={"project_id": project_id, "item": "Test Item", "quantity": "5"},
    )
    assert need.status_code == 200

    resp = client.get("/api/werkstatt/bedarfe", headers=auth_headers(admin_token))
    assert resp.status_code == 200
    assert any(row["project_id"] == project_id for row in resp.json())


def test_werkstatt_bedarfe_requires_auth(client: TestClient) -> None:
    resp = client.get("/api/werkstatt/bedarfe")
    assert resp.status_code == 401


def test_werkstatt_dashboard_returns_structure(
    client: TestClient, admin_token: str
) -> None:
    headers = auth_headers(admin_token)
    # Create at least one article below min stock so the reorder preview is non-empty.
    supplier = _make_supplier(client, admin_token, "DashSup")
    article = client.post(
        "/api/werkstatt/articles",
        headers=headers,
        json={
            "item_name": "Dash Article",
            "stock_total": 1,
            "stock_min": 5,
            "supplier_links": [{"supplier_id": supplier["id"], "is_preferred": True}],
        },
    )
    assert article.status_code == 200

    resp = client.get("/api/werkstatt/dashboard", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body.keys()) == {
        "kpis",
        "reorder_preview",
        "recent_movements",
        "on_site_groups",
        "maintenance_entries",
    }
    assert body["kpis"]["total_articles"] >= 1
    assert body["kpis"]["below_min_count"] >= 1
    reorder_ids = [row["article_id"] for row in body["reorder_preview"]]
    assert article.json()["id"] in reorder_ids
