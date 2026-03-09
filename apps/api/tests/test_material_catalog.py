from __future__ import annotations

import os
from pathlib import Path

from fastapi.testclient import TestClient

from app.core.db import SessionLocal
from app.services import material_catalog as material_catalog_service
from app.services.material_catalog import sync_pending_material_catalog_images
from app.services.material_catalog_images import MaterialImageCacheResult, MaterialImageLookupResult


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


def _login(client: TestClient, email: str) -> str:
    response = client.post("/api/auth/login", json={"email": email, "password": "Password123!"})
    assert response.status_code == 200
    return response.headers["X-Access-Token"]


def _reset_catalog_dir() -> Path:
    catalog_dir = Path(os.environ["MATERIAL_CATALOG_DIR"])
    for path in catalog_dir.iterdir():
        if path.is_file():
            path.unlink()
    return catalog_dir


def test_material_catalog_search_and_add_to_material_needs(client: TestClient, admin_token: str):
    employee = _create_user(client, admin_token, "catalog-employee@example.com", "employee")
    outsider = _create_user(client, admin_token, "catalog-outsider@example.com", "employee")
    employee_token = _login(client, employee["email"])
    outsider_token = _login(client, outsider["email"])

    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": "2026-CAT-1", "name": "Catalog Project", "status": "active"},
    )
    assert project.status_code == 200
    project_id = project.json()["id"]

    add_member = client.post(
        f"/api/projects/{project_id}/members",
        headers=auth_headers(admin_token),
        data={"user_id": employee["id"], "can_manage": "false"},
    )
    assert add_member.status_code == 200

    catalog_dir = _reset_catalog_dir()
    catalog_file = catalog_dir / "materials.csv"
    catalog_file.write_text(
        "\n".join(
            [
                "Artikelnummer;Bezeichnung;Einheit;Hersteller;Preis",
                "A-1001;NYM-J 3x1,5;m;SMPL;29,90",
                "B-2002;Montageschiene 2m;Stk;SMPL;12,45",
                "A-1001;NYM-J 3x1,5 Duplicate;m;SMPL;29,90",
            ]
        ),
        encoding="utf-8",
    )

    search_catalog = client.get("/api/materials/catalog?q=NYM", headers=auth_headers(employee_token))
    assert search_catalog.status_code == 200
    catalog_rows = search_catalog.json()
    assert len(catalog_rows) >= 1
    selected = next((row for row in catalog_rows if row["item_name"] == "NYM-J 3x1,5"), None)
    assert selected is not None
    assert selected["article_no"] == "A-1001"
    assert selected["unit"] == "m"

    catalog_state = client.get("/api/materials/catalog/state", headers=auth_headers(employee_token))
    assert catalog_state.status_code == 200
    assert catalog_state.json()["duplicates_skipped"] == 1

    add_material_need = client.post(
        "/api/materials",
        headers=auth_headers(employee_token),
        json={
            "project_id": project_id,
            "material_catalog_item_id": selected["id"],
            "quantity": "30",
        },
    )
    assert add_material_need.status_code == 200
    added_payload = add_material_need.json()
    assert added_payload["project_id"] == project_id
    assert added_payload["item"] == "NYM-J 3x1,5"
    assert added_payload["article_no"] == "A-1001"
    assert added_payload["unit"] == "m"
    assert added_payload["quantity"] == "30"
    assert added_payload["status"] == "order"

    material_queue = client.get("/api/materials", headers=auth_headers(employee_token))
    assert material_queue.status_code == 200
    queue_entry = next((row for row in material_queue.json() if row["id"] == added_payload["id"]), None)
    assert queue_entry is not None
    assert queue_entry["material_catalog_item_id"] == selected["id"]

    outsider_denied = client.post(
        "/api/materials",
        headers=auth_headers(outsider_token),
        json={"project_id": project_id, "item": "Unauthorized item"},
    )
    assert outsider_denied.status_code == 403


def test_material_catalog_parses_datanorm_a_and_b_records(client: TestClient, admin_token: str):
    employee = _create_user(client, admin_token, "catalog-datanorm@example.com", "employee")
    employee_token = _login(client, employee["email"])

    catalog_dir = _reset_catalog_dir()
    datanorm_file = catalog_dir / "Datanorm.001"
    datanorm_file.write_text(
        "\n".join(
            [
                "V 060226UNI ELEKTRO Fachgrosshandel GMBh&Co. Reg65760 Eschborn , Ludwig-Erhard-Strasse 2Copyright UNI ELEKTRO Fachgrosshand04EUR",
                "A;N;01000130;00;ABB S804PV-SP10;Strangsicherung 1.500V DC, 10A, 4-polig;1;0;ST;60400;;010;;",
                "B;N;01000130;S804PV-SP10;;;;;;7612271471699;;999;;;;;",
            ]
        ),
        encoding="utf-8",
    )

    search_catalog = client.get("/api/materials/catalog?q=S804PV-SP10", headers=auth_headers(employee_token))
    assert search_catalog.status_code == 200
    catalog_rows = search_catalog.json()
    selected = next((row for row in catalog_rows if row["article_no"] == "01000130"), None)
    assert selected is not None
    assert selected["item_name"] == "ABB S804PV-SP10 - Strangsicherung 1.500V DC, 10A, 4-polig"
    assert selected["unit"] == "ST"
    assert selected["ean"] == "7612271471699"
    assert selected["manufacturer"] == "ABB"
    assert selected["price_text"] == "604.00 EUR"


def test_material_catalog_search_caps_results_to_ten_items(client: TestClient, admin_token: str):
    employee = _create_user(client, admin_token, "catalog-limit@example.com", "employee")
    employee_token = _login(client, employee["email"])

    catalog_dir = _reset_catalog_dir()
    catalog_file = catalog_dir / "materials.csv"
    lines = ["Artikelnummer;Bezeichnung;Einheit;Hersteller;Preis"]
    for index in range(1, 21):
        lines.append(f"C-{index:04d};Cable Variant {index};m;SMPL;10,00")
    catalog_file.write_text("\n".join(lines), encoding="utf-8")

    search_catalog = client.get("/api/materials/catalog?q=Cable&limit=60", headers=auth_headers(employee_token))
    assert search_catalog.status_code == 200
    assert len(search_catalog.json()) == 10


def test_material_catalog_enriches_image_for_selected_item(
    client: TestClient,
    admin_token: str,
    monkeypatch,
):
    employee = _create_user(client, admin_token, "catalog-image@example.com", "employee")
    employee_token = _login(client, employee["email"])

    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": "2026-CAT-IMG", "name": "Catalog Image Project", "status": "active"},
    )
    assert project.status_code == 200
    project_id = project.json()["id"]
    add_member = client.post(
        f"/api/projects/{project_id}/members",
        headers=auth_headers(admin_token),
        data={"user_id": employee["id"], "can_manage": "false"},
    )
    assert add_member.status_code == 200

    monkeypatch.setattr(material_catalog_service, "_image_lookup_enabled", lambda: True)

    def fake_unielektro_lookup(
        *,
        ean: str | None,
        manufacturer: str | None,
        item_name: str | None = None,
        article_no: str | None = None,
    ):
        if ean == "7612271471699":
            return MaterialImageLookupResult(
                image_url="https://images.example.test/unielektro/7612271471699.jpg",
                source="unielektro_ean",
            )
        return None

    def fake_fallback_lookup(
        *,
        ean: str | None,
        manufacturer: str | None,
        item_name: str | None = None,
        article_no: str | None = None,
    ):
        return None

    def fake_cache(*, image_url: str, external_key: str, uploads_dir: str):
        return MaterialImageCacheResult(
            public_url=f"/api/materials/catalog/images/{external_key}",
            stored_path=f"{uploads_dir}/material_catalog_images/{external_key}.jpg",
            content_type="image/jpeg",
            byte_size=256,
        )

    monkeypatch.setattr(material_catalog_service, "resolve_material_catalog_image_unielektro", fake_unielektro_lookup)
    monkeypatch.setattr(material_catalog_service, "resolve_material_catalog_image_fallback", fake_fallback_lookup)
    monkeypatch.setattr(material_catalog_service, "cache_material_catalog_image", fake_cache)

    catalog_dir = _reset_catalog_dir()
    datanorm_file = catalog_dir / "Datanorm.001"
    datanorm_file.write_text(
        "\n".join(
            [
                "V 060226UNI ELEKTRO Fachgrosshandel GMBh&Co. Reg65760 Eschborn , Ludwig-Erhard-Strasse 2Copyright UNI ELEKTRO Fachgrosshand04EUR",
                "A;N;01000130;00;ABB S804PV-SP10;Strangsicherung 1.500V DC, 10A, 4-polig;1;0;ST;60400;;010;;",
                "B;N;01000130;S804PV-SP10;;;;;;7612271471699;;999;;;;;",
            ]
        ),
        encoding="utf-8",
    )

    # First search triggers the catalog import (no images yet — lookup is off the request path).
    seed_search = client.get("/api/materials/catalog?q=S804PV-SP10", headers=auth_headers(employee_token))
    assert seed_search.status_code == 200
    assert any(row["article_no"] == "01000130" for row in seed_search.json())

    # Simulate one background-loop cycle to enrich images.
    with SessionLocal() as db:
        sync_pending_material_catalog_images(db, limit=1)

    # After background processing the image should be populated.
    search_catalog = client.get("/api/materials/catalog?q=S804PV-SP10", headers=auth_headers(employee_token))
    assert search_catalog.status_code == 200
    selected = next((row for row in search_catalog.json() if row["article_no"] == "01000130"), None)
    assert selected is not None
    assert selected["image_url"].startswith("/api/materials/catalog/images/")
    assert selected["image_source"] == "unielektro_ean"

    add_material_need = client.post(
        "/api/materials",
        headers=auth_headers(employee_token),
        json={"project_id": project_id, "material_catalog_item_id": selected["id"]},
    )
    assert add_material_need.status_code == 200
    created = add_material_need.json()
    assert created["image_url"].startswith("/api/materials/catalog/images/")
    assert created["image_source"] == "unielektro_ean"

    material_queue = client.get("/api/materials", headers=auth_headers(employee_token))
    assert material_queue.status_code == 200
    queue_entry = next((row for row in material_queue.json() if row["id"] == created["id"]), None)
    assert queue_entry is not None
    assert queue_entry["image_url"].startswith("/api/materials/catalog/images/")


def test_material_catalog_cached_image_endpoint_serves_local_file(
    client: TestClient,
    admin_token: str,
    monkeypatch,
):
    employee = _create_user(client, admin_token, "catalog-image-asset@example.com", "employee")
    employee_token = _login(client, employee["email"])

    monkeypatch.setattr(material_catalog_service, "_image_lookup_enabled", lambda: True)

    def fake_unielektro_lookup(
        *,
        ean: str | None,
        manufacturer: str | None,
        item_name: str | None = None,
        article_no: str | None = None,
    ):
        if ean == "7612271471699":
            return MaterialImageLookupResult(
                image_url="https://images.example.test/unielektro/7612271471699.jpg",
                source="unielektro_ean",
            )
        return None

    def fake_fallback_lookup(
        *,
        ean: str | None,
        manufacturer: str | None,
        item_name: str | None = None,
        article_no: str | None = None,
    ):
        return None

    def fake_cache(*, image_url: str, external_key: str, uploads_dir: str):
        cache_dir = Path(uploads_dir) / "material_catalog_images"
        cache_dir.mkdir(parents=True, exist_ok=True)
        stored_path = cache_dir / f"{external_key}.jpg"
        payload = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x02\x00\x00\x01\x00\x01\x00\x00\xff\xd9"
        stored_path.write_bytes(payload)
        return MaterialImageCacheResult(
            public_url=f"/api/materials/catalog/images/{external_key}",
            stored_path=str(stored_path),
            content_type="image/jpeg",
            byte_size=len(payload),
        )

    monkeypatch.setattr(material_catalog_service, "resolve_material_catalog_image_unielektro", fake_unielektro_lookup)
    monkeypatch.setattr(material_catalog_service, "resolve_material_catalog_image_fallback", fake_fallback_lookup)
    monkeypatch.setattr(material_catalog_service, "cache_material_catalog_image", fake_cache)

    catalog_dir = _reset_catalog_dir()
    datanorm_file = catalog_dir / "Datanorm.001"
    datanorm_file.write_text(
        "\n".join(
            [
                "V 060226UNI ELEKTRO Fachgrosshandel GMBh&Co. Reg65760 Eschborn , Ludwig-Erhard-Strasse 2Copyright UNI ELEKTRO Fachgrosshand04EUR",
                "A;N;01000130;00;ABB S804PV-SP10;Strangsicherung 1.500V DC, 10A, 4-polig;1;0;ST;60400;;010;;",
                "B;N;01000130;S804PV-SP10;;;;;;7612271471699;;999;;;;;",
            ]
        ),
        encoding="utf-8",
    )

    # Seed search to trigger catalog import.
    seed_search = client.get("/api/materials/catalog?q=S804PV-SP10", headers=auth_headers(employee_token))
    assert seed_search.status_code == 200

    # Simulate one background-loop cycle to cache the image locally.
    with SessionLocal() as db:
        sync_pending_material_catalog_images(db, limit=1)

    # Now the item should have a local cached image URL.
    search_catalog = client.get("/api/materials/catalog?q=S804PV-SP10", headers=auth_headers(employee_token))
    assert search_catalog.status_code == 200
    selected = next((row for row in search_catalog.json() if row["article_no"] == "01000130"), None)
    assert selected is not None
    assert selected["image_url"].startswith("/api/materials/catalog/images/")

    image_response = client.get(selected["image_url"])
    assert image_response.status_code == 200
    assert image_response.headers["content-type"].startswith("image/jpeg")
    assert image_response.content.startswith(b"\xff\xd8")


def test_material_catalog_import_inserts_in_bounded_batches(
    client: TestClient,
    admin_token: str,
    monkeypatch,
):
    employee = _create_user(client, admin_token, "catalog-batch@example.com", "employee")
    employee_token = _login(client, employee["email"])

    catalog_dir = _reset_catalog_dir()
    catalog_file = catalog_dir / "batch-materials.csv"
    lines = ["Artikelnummer;Bezeichnung;Einheit;Hersteller;Preis"]
    for index in range(1, 121):
        lines.append(f"B-{index:05d};Batch Cable {index};m;SMPL;10,00")
    catalog_file.write_text("\n".join(lines), encoding="utf-8")

    monkeypatch.setattr(material_catalog_service, "CATALOG_IMPORT_BATCH_SIZE", 25)
    original_insert_batch = material_catalog_service._insert_catalog_batch
    observed_batch_sizes: list[int] = []

    def tracked_insert_batch(db, rows):
        observed_batch_sizes.append(len(rows))
        return original_insert_batch(db, rows)

    monkeypatch.setattr(material_catalog_service, "_insert_catalog_batch", tracked_insert_batch)

    search_catalog = client.get("/api/materials/catalog?q=Batch", headers=auth_headers(employee_token))
    assert search_catalog.status_code == 200
    assert len(search_catalog.json()) == 10

    assert observed_batch_sizes
    assert max(observed_batch_sizes) <= 25
    assert sum(observed_batch_sizes) == 120


def test_material_catalog_state_reports_image_sync_progress(
    client: TestClient,
    admin_token: str,
    monkeypatch,
):
    employee = _create_user(client, admin_token, "catalog-image-state@example.com", "employee")
    employee_token = _login(client, employee["email"])

    monkeypatch.setattr(material_catalog_service, "_image_lookup_enabled", lambda: True)
    monkeypatch.setattr(material_catalog_service, "_image_lookup_max_items_per_request", lambda: 1)
    fallback_calls = {"count": 0}

    def fake_unielektro_lookup(
        *,
        ean: str | None,
        manufacturer: str | None,
        item_name: str | None = None,
        article_no: str | None = None,
    ):
        return None

    def fake_fallback_lookup(
        *,
        ean: str | None,
        manufacturer: str | None,
        item_name: str | None = None,
        article_no: str | None = None,
    ):
        fallback_calls["count"] += 1
        if ean == "7612271471699":
            return MaterialImageLookupResult(
                image_url="https://images.example.test/abb/7612271471699.jpg",
                source="manufacturer_site",
            )
        return None

    def fake_cache(*, image_url: str, external_key: str, uploads_dir: str):
        return MaterialImageCacheResult(
            public_url=f"/api/materials/catalog/images/{external_key}",
            stored_path=f"{uploads_dir}/material_catalog_images/{external_key}.jpg",
            content_type="image/jpeg",
            byte_size=123,
        )

    monkeypatch.setattr(material_catalog_service, "resolve_material_catalog_image_unielektro", fake_unielektro_lookup)
    monkeypatch.setattr(material_catalog_service, "resolve_material_catalog_image_fallback", fake_fallback_lookup)
    monkeypatch.setattr(material_catalog_service, "cache_material_catalog_image", fake_cache)

    catalog_dir = _reset_catalog_dir()
    datanorm_file = catalog_dir / "Datanorm.001"
    datanorm_file.write_text(
        "\n".join(
            [
                "V 060226UNI ELEKTRO Fachgrosshandel GMBh&Co. Reg65760 Eschborn , Ludwig-Erhard-Strasse 2Copyright UNI ELEKTRO Fachgrosshand04EUR",
                "A;N;01000130;00;ABB S804PV-SP10;Strangsicherung 1.500V DC, 10A, 4-polig;1;0;ST;60400;;010;;",
                "B;N;01000130;S804PV-SP10;;;;;;7612271471699;;999;;;;;",
            ]
        ),
        encoding="utf-8",
    )

    # Seed: trigger catalog import via state endpoint, then run the first background cycle
    # (unielektro pass — item has no image yet, so it gets marked not_found_unielektro).
    seed_state = client.get("/api/materials/catalog/state", headers=auth_headers(employee_token))
    assert seed_state.status_code == 200

    with SessionLocal() as db:
        processed_first = sync_pending_material_catalog_images(db, limit=1)
    assert processed_first == 1

    # State endpoint is now a pure read — image_last_run_processed is always 0.
    first_run = client.get("/api/materials/catalog/state", headers=auth_headers(employee_token))
    assert first_run.status_code == 200
    first_payload = first_run.json()
    assert first_payload["image_lookup_enabled"] is True
    assert first_payload["image_last_run_processed"] == 0
    assert first_payload["image_lookup_phase"] == "fallback"
    assert first_payload["image_items_with_image"] == 0
    assert first_payload["image_items_waiting_fallback"] == 1
    assert fallback_calls["count"] == 0

    # Run the second background cycle (fallback pass — item gets image from fake_fallback_lookup).
    with SessionLocal() as db:
        processed_second = sync_pending_material_catalog_images(db, limit=1)
    assert processed_second == 1
    assert fallback_calls["count"] == 1

    second_run = client.get("/api/materials/catalog/state", headers=auth_headers(employee_token))
    assert second_run.status_code == 200
    second_payload = second_run.json()
    assert second_payload["image_last_run_processed"] == 0
    assert second_payload["image_total_items"] == 1
    assert second_payload["image_items_with_image"] == 1
    assert second_payload["image_items_pending"] == 0
    assert second_payload["image_items_not_found"] == 0
    assert second_payload["image_last_checked_at"]
