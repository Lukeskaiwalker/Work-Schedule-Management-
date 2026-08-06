"""Folding multi-Datanorm duplicates, merging articles, and similar-item lookup.

Covers the three things a second supplier's Datanorm breaks: the same product
appearing twice in the catalog, two article rows for one physical item, and
"what else like this do we actually have on the shelf".
"""

from __future__ import annotations

import sqlalchemy as sa
from fastapi.testclient import TestClient


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _supplier(client: TestClient, admin_token: str, name: str) -> int:
    created = client.post(
        "/api/werkstatt/suppliers", headers=auth_headers(admin_token), json={"name": name}
    )
    assert created.status_code == 200, created.text
    return created.json()["id"]


def _catalog_row(supplier_id: int, *, article_no: str, ean: str | None, name: str) -> int:
    """Insert a Datanorm row directly — the importer is not what is under test."""
    from app.core.db import SessionLocal
    from app.models.entities import MaterialCatalogItem

    with SessionLocal() as db:
        row = MaterialCatalogItem(
            external_key=f"{supplier_id}-{article_no}",
            source_file="test.csv",
            source_line=1,
            article_no=article_no,
            item_name=name,
            ean=ean,
            supplier_id=supplier_id,
            search_text=f"{article_no} {name} {ean or ''}".lower(),
        )
        db.add(row)
        db.commit()
        return row.id


def _article(client: TestClient, admin_token: str, name: str, *, ean: str | None = None) -> dict:
    payload: dict = {"item_name": name, "unit": "Stk"}
    if ean:
        payload["ean"] = ean
    created = client.post(
        "/api/werkstatt/articles", headers=auth_headers(admin_token), json=payload
    )
    assert created.status_code == 200, created.text
    return created.json()


def _seed_stock(article_id: int, quantity: int) -> None:
    from app.core.db import SessionLocal
    from app.models.entities import User, WerkstattArticle
    from app.services.werkstatt_movements import apply_movement

    with SessionLocal() as db:
        row = db.get(WerkstattArticle, article_id)
        admin = db.scalars(sa.select(User).where(User.email == "admin@example.com")).first()
        apply_movement(
            db,
            article=row,
            movement_type="intake",
            quantity=quantity,
            user_id=admin.id,
            notes="test-intake",
        )
        db.commit()


# ── Folding catalog duplicates ────────────────────────────────────────────


def test_fold_attaches_every_suppliers_article_number_for_one_ean(
    client: TestClient, admin_token: str
):
    """The reported problem: two Datanorms, one product, two disconnected rows.

    After folding, a single article carries supplier A's article number AND
    supplier B's — which is what the reorder and barcode-scan paths need.
    """
    supplier_a = _supplier(client, admin_token, "Unielektro")
    supplier_b = _supplier(client, admin_token, "Sonepar")
    _catalog_row(supplier_a, article_no="A-111", ean="4012345678901", name="Schuko Steckdose")
    _catalog_row(supplier_b, article_no="B-999", ean="4012345678901", name="Schuko Steckdose")

    article = _article(client, admin_token, "Schuko Steckdose", ean="4012345678901")

    folded = client.post(
        f"/api/werkstatt/articles/{article['id']}/fold-catalog-duplicates",
        headers=auth_headers(admin_token),
    )
    assert folded.status_code == 200, folded.text
    body = folded.json()

    linked = {row["supplier_name"]: row["supplier_article_no"] for row in body["linked"]}
    assert linked == {"Unielektro": "A-111", "Sonepar": "B-999"}


def test_fold_is_idempotent_and_preserves_existing_links(
    client: TestClient, admin_token: str
):
    """Re-running must not duplicate links or clobber curated supplier data."""
    supplier_a = _supplier(client, admin_token, "Unielektro")
    _catalog_row(supplier_a, article_no="A-111", ean="4012345678901", name="Schuko Steckdose")
    article = _article(client, admin_token, "Schuko Steckdose", ean="4012345678901")

    first = client.post(
        f"/api/werkstatt/articles/{article['id']}/fold-catalog-duplicates",
        headers=auth_headers(admin_token),
    ).json()
    assert len(first["linked"]) == 1

    second = client.post(
        f"/api/werkstatt/articles/{article['id']}/fold-catalog-duplicates",
        headers=auth_headers(admin_token),
    ).json()
    assert second["linked"] == []
    assert second["already_linked"] == 1


def test_fold_does_nothing_without_an_ean(client: TestClient, admin_token: str):
    """No EAN means no identifier strong enough to fold on — guess nothing."""
    supplier_a = _supplier(client, admin_token, "Unielektro")
    _catalog_row(supplier_a, article_no="A-111", ean="4012345678901", name="Schuko Steckdose")
    article = _article(client, admin_token, "Schuko Steckdose")

    folded = client.post(
        f"/api/werkstatt/articles/{article['id']}/fold-catalog-duplicates",
        headers=auth_headers(admin_token),
    )
    assert folded.status_code == 200
    assert folded.json()["linked"] == []


# ── Duplicate review queue ────────────────────────────────────────────────


def test_duplicates_endpoint_is_not_shadowed_by_the_article_id_route(
    client: TestClient, admin_token: str
):
    """Regression guard: /articles/duplicates must not parse as article_id.

    FastAPI matches routes in registration order, so this literal path has to
    stay declared above `GET /articles/{article_id}` or it 422s.
    """
    response = client.get("/api/werkstatt/articles/duplicates", headers=auth_headers(admin_token))
    assert response.status_code == 200
    assert isinstance(response.json(), list)


def test_near_identical_names_without_ean_are_offered_for_review(
    client: TestClient, admin_token: str
):
    _article(client, admin_token, "Schuko Steckdose weiss")
    _article(client, admin_token, "Schuko Steckdose weiss aufputz")

    listed = client.get(
        "/api/werkstatt/articles/duplicates", headers=auth_headers(admin_token)
    ).json()
    assert any("Schuko" in row["article_name"] for row in listed)


def test_two_known_eans_are_never_offered_as_duplicates(client: TestClient, admin_token: str):
    """Different EANs are different products no matter how alike the names read."""
    _article(client, admin_token, "Schuko Steckdose weiss", ean="4012345678901")
    _article(client, admin_token, "Schuko Steckdose weiss", ean="4012345678902")

    listed = client.get(
        "/api/werkstatt/articles/duplicates", headers=auth_headers(admin_token)
    ).json()
    assert listed == []


# ── Merging ───────────────────────────────────────────────────────────────


def test_merge_moves_stock_ledger_and_archives_the_duplicate(
    client: TestClient, admin_token: str
):
    """Stock is recomputed from the moved ledger, not added as two snapshots."""
    survivor = _article(client, admin_token, "Kabelbinder schwarz 200mm")
    duplicate = _article(client, admin_token, "Kabelbinder schwarz 200 mm")
    _seed_stock(survivor["id"], 10)
    _seed_stock(duplicate["id"], 15)

    merged = client.post(
        "/api/werkstatt/articles/merge",
        headers=auth_headers(admin_token),
        json={"survivor_id": survivor["id"], "duplicate_id": duplicate["id"]},
    )
    assert merged.status_code == 200, merged.text
    assert merged.json()["movements_moved"] == 1

    after = client.get(
        f"/api/werkstatt/articles/{survivor['id']}", headers=auth_headers(admin_token)
    ).json()
    assert after["stock_available"] == 25

    retired = client.get(
        f"/api/werkstatt/articles/{duplicate['id']}", headers=auth_headers(admin_token)
    ).json()
    assert retired["is_archived"] is True
    assert retired["stock_available"] == 0


def test_merge_unions_supplier_links_and_fills_blank_fields(
    client: TestClient, admin_token: str
):
    """A merge must not lose what the duplicate knew that the survivor didn't."""
    supplier_a = _supplier(client, admin_token, "Unielektro")
    supplier_b = _supplier(client, admin_token, "Sonepar")
    survivor = _article(client, admin_token, "Schuko Steckdose")
    duplicate = _article(client, admin_token, "Schuko Steckdose weiss", ean="4012345678901")

    for article_id, supplier_id, number in (
        (survivor["id"], supplier_a, "A-111"),
        (duplicate["id"], supplier_b, "B-999"),
    ):
        created = client.post(
            f"/api/werkstatt/articles/{article_id}/suppliers",
            headers=auth_headers(admin_token),
            json={"supplier_id": supplier_id, "supplier_article_no": number},
        )
        assert created.status_code == 200, created.text

    merged = client.post(
        "/api/werkstatt/articles/merge",
        headers=auth_headers(admin_token),
        json={"survivor_id": survivor["id"], "duplicate_id": duplicate["id"]},
    )
    assert merged.status_code == 200, merged.text
    assert merged.json()["supplier_links_moved"] == 1
    # The duplicate carried the EAN; the survivor had none, so it inherits it.
    assert "ean" in merged.json()["fields_filled"]

    after = client.get(
        f"/api/werkstatt/articles/{survivor['id']}", headers=auth_headers(admin_token)
    ).json()
    assert after["ean"] == "4012345678901"
    numbers = {link["supplier_article_no"] for link in after["suppliers"]}
    assert numbers == {"A-111", "B-999"}


def test_merge_rejects_self_merge(client: TestClient, admin_token: str):
    article = _article(client, admin_token, "Kabelkanal 60x40")
    response = client.post(
        "/api/werkstatt/articles/merge",
        headers=auth_headers(admin_token),
        json={"survivor_id": article["id"], "duplicate_id": article["id"]},
    )
    assert response.status_code == 400


# ── Similar items ─────────────────────────────────────────────────────────


def test_similar_articles_are_ordered_by_stock_on_hand(client: TestClient, admin_token: str):
    """On a site, "similar" is only useful if it surfaces what you can grab.

    Stock is therefore the primary sort and closeness the tie-break.
    """
    target = _article(client, admin_token, "Kabelbinder schwarz 200mm")
    plenty = _article(client, admin_token, "Kabelbinder schwarz 300mm")
    scarce = _article(client, admin_token, "Kabelbinder weiss 200mm")
    _seed_stock(plenty["id"], 40)
    _seed_stock(scarce["id"], 2)

    similar = client.get(
        f"/api/werkstatt/articles/{target['id']}/similar", headers=auth_headers(admin_token)
    )
    assert similar.status_code == 200, similar.text
    rows = similar.json()
    assert [row["article_id"] for row in rows][:2] == [plenty["id"], scarce["id"]]
    assert rows[0]["stock_available"] == 40
    # The article itself is never its own suggestion.
    assert all(row["article_id"] != target["id"] for row in rows)


def test_similar_articles_404_for_unknown_article(client: TestClient, admin_token: str):
    response = client.get(
        "/api/werkstatt/articles/999999/similar", headers=auth_headers(admin_token)
    )
    assert response.status_code == 404
