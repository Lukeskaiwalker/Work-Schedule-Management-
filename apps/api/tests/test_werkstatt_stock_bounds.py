"""Upper bounds on the Werkstatt stock request fields (review of 2026-10-10).

Every field below lands in an ``Integer`` column — or is booked into the
ledger, whose snapshot counters are ``Integer`` too. Unbounded, a huge number
travelled all the way to ``db.flush()`` and came back as an OverflowError
(SQLite) or DataError (PostgreSQL): an unhandled 500. Or it fitted, was saved,
and overflowed a later product or sum instead. The bounds are the shared ones
in ``app/core/limits.py``; the stock-take import and the desk adjustment have
always used the same 1 000 000.

Each field: past the bound is a 422 and nothing is written; the bound itself
is still saved, where that means anything.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.core.db import SessionLocal
from app.core.limits import INT32_MAX, MAX_STOCK_QUANTITY, MAX_UNIT_PRICE_CENTS
from app.models.entities import (
    MaterialCatalogItem,
    WerkstattArticle,
    WerkstattArticleSupplier,
    WerkstattMovement,
)
from app.schemas.werkstatt import CheckoutPayload

ARTICLES = "/api/werkstatt/articles"
FROM_CATALOG = "/api/werkstatt/articles/from-catalog"

# One past the bound, and one far past the column — both must be a 422.
TOO_MANY = (MAX_STOCK_QUANTITY + 1, 10**20)
TOO_DEAR = (MAX_UNIT_PRICE_CENTS + 1, 10**20)


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _articles_named(name: str) -> int:
    with SessionLocal() as db:
        return int(db.scalar(select(func.count()).where(WerkstattArticle.item_name == name)) or 0)


def _ledger(article_id: int) -> list[tuple[str, int]]:
    with SessionLocal() as db:
        rows = db.scalars(
            select(WerkstattMovement)
            .where(WerkstattMovement.article_id == article_id)
            .order_by(WerkstattMovement.id)
        )
        return [(row.movement_type, int(row.quantity)) for row in rows]


def _stored_article(article_id: int) -> WerkstattArticle:
    with SessionLocal() as db:
        row = db.get(WerkstattArticle, article_id)
        db.expunge(row)
        return row


def _catalog_item(name: str) -> int:
    """A Datanorm row inserted directly — the importer is not under test."""
    with SessionLocal() as db:
        row = MaterialCatalogItem(
            external_key=f"bounds-{name}",
            source_file="test.datanorm",
            source_line=1,
            article_no=f"BND-{name}",
            item_name=name,
            unit="Stk",
            search_text=name.lower(),
        )
        db.add(row)
        db.commit()
        return int(row.id)


def _article(client: TestClient, token: str, name: str) -> dict:
    created = client.post(ARTICLES, headers=_auth(token), json={"item_name": name})
    assert created.status_code == 200, created.text
    return created.json()


def _supplier(client: TestClient, token: str, name: str) -> int:
    created = client.post("/api/werkstatt/suppliers", headers=_auth(token), json={"name": name})
    assert created.status_code == 200, created.text
    return int(created.json()["id"])


def _post_each(client: TestClient, token: str, path: str, bodies: list[dict]) -> list[int]:
    return [client.post(path, headers=_auth(token), json=body).status_code for body in bodies]


def _patch_each(client: TestClient, token: str, path: str, bodies: list[dict]) -> list[int]:
    return [client.patch(path, headers=_auth(token), json=body).status_code for body in bodies]


# ── POST /api/werkstatt/articles ─────────────────────────────────────────────


def test_create_refuses_an_opening_stock_past_the_bound(client: TestClient, admin_token: str) -> None:
    """``stock_total`` is booked as an ``intake`` — the one movement with no
    balance guard to fast-fail against."""
    answers = _post_each(
        client, admin_token, ARTICLES,
        [{"item_name": "Aderendhülse 1,5 mm²", "stock_total": value} for value in TOO_MANY],
    )
    assert answers == [422, 422]
    assert _articles_named("Aderendhülse 1,5 mm²") == 0


def test_create_refuses_a_minimum_stock_past_the_bound(client: TestClient, admin_token: str) -> None:
    answers = _post_each(
        client, admin_token, ARTICLES,
        [{"item_name": "Aderendhülse 2,5 mm²", "stock_min": value} for value in TOO_MANY],
    )
    assert answers == [422, 422]
    assert _articles_named("Aderendhülse 2,5 mm²") == 0


def test_create_refuses_a_purchase_price_past_the_bound(client: TestClient, admin_token: str) -> None:
    answers = _post_each(
        client, admin_token, ARTICLES,
        [{"item_name": "Aderendhülse 4 mm²", "purchase_price_cents": value} for value in TOO_DEAR],
    )
    assert answers == [422, 422]
    assert _articles_named("Aderendhülse 4 mm²") == 0


def test_create_books_the_bounds_themselves(client: TestClient, admin_token: str) -> None:
    created = client.post(
        ARTICLES,
        headers=_auth(admin_token),
        json={
            "item_name": "Aderendhülse 6 mm²",
            "stock_total": MAX_STOCK_QUANTITY,
            "stock_min": MAX_STOCK_QUANTITY,
            "purchase_price_cents": MAX_UNIT_PRICE_CENTS,
        },
    )
    assert created.status_code == 200, created.text
    body = created.json()
    assert (body["stock_total"], body["stock_available"], body["stock_min"]) == (
        MAX_STOCK_QUANTITY, MAX_STOCK_QUANTITY, MAX_STOCK_QUANTITY,
    )
    assert body["purchase_price_cents"] == MAX_UNIT_PRICE_CENTS
    assert _ledger(body["id"]) == [("intake", MAX_STOCK_QUANTITY)]


def test_create_refuses_a_nested_supplier_link_past_the_bounds(client: TestClient, admin_token: str) -> None:
    supplier_id = _supplier(client, admin_token, "Grenzwert GmbH")
    bodies = [
        {"item_name": "Wago 221-412", "supplier_links": [{"supplier_id": supplier_id, **link}]}
        for link in (
            *({"typical_price_cents": value} for value in TOO_DEAR),
            *({"minimum_order_quantity": value} for value in TOO_MANY),
        )
    ]
    assert _post_each(client, admin_token, ARTICLES, bodies) == [422, 422, 422, 422]
    assert _articles_named("Wago 221-412") == 0


# ── POST /api/werkstatt/articles/from-catalog ────────────────────────────────


def test_from_catalog_refuses_an_opening_stock_past_the_bound(client: TestClient, admin_token: str) -> None:
    item_id = _catalog_item("NYM-J 3x1,5")
    answers = _post_each(
        client, admin_token, FROM_CATALOG,
        [{"catalog_item_id": item_id, "stock_total": value} for value in TOO_MANY],
    )
    assert answers == [422, 422]
    assert _articles_named("NYM-J 3x1,5") == 0


def test_from_catalog_refuses_a_minimum_stock_past_the_bound(client: TestClient, admin_token: str) -> None:
    item_id = _catalog_item("NYM-J 5x1,5")
    answers = _post_each(
        client, admin_token, FROM_CATALOG,
        [{"catalog_item_id": item_id, "stock_min": value} for value in TOO_MANY],
    )
    assert answers == [422, 422]
    assert _articles_named("NYM-J 5x1,5") == 0


def test_from_catalog_books_the_bounds_themselves(client: TestClient, admin_token: str) -> None:
    item_id = _catalog_item("NYM-J 5x2,5")
    created = client.post(
        FROM_CATALOG,
        headers=_auth(admin_token),
        json={"catalog_item_id": item_id, "stock_total": MAX_STOCK_QUANTITY, "stock_min": MAX_STOCK_QUANTITY},
    )
    assert created.status_code == 200, created.text
    body = created.json()
    assert (body["stock_total"], body["stock_min"]) == (MAX_STOCK_QUANTITY, MAX_STOCK_QUANTITY)
    assert _ledger(body["id"]) == [("intake", MAX_STOCK_QUANTITY)]


# ── PATCH /api/werkstatt/articles/{id} ───────────────────────────────────────


def test_update_refuses_a_minimum_stock_past_the_bound(client: TestClient, admin_token: str) -> None:
    article = _article(client, admin_token, "Schukosteckdose")
    path = f"{ARTICLES}/{article['id']}"
    assert _patch_each(client, admin_token, path, [{"stock_min": value} for value in TOO_MANY]) == [422, 422]
    assert _stored_article(article["id"]).stock_min == 0


def test_update_refuses_a_purchase_price_past_the_bound(client: TestClient, admin_token: str) -> None:
    article = _article(client, admin_token, "Abzweigdose")
    path = f"{ARTICLES}/{article['id']}"
    answers = _patch_each(client, admin_token, path, [{"purchase_price_cents": value} for value in TOO_DEAR])
    assert answers == [422, 422]
    assert _stored_article(article["id"]).purchase_price_cents is None


def test_update_saves_the_bounds_themselves(client: TestClient, admin_token: str) -> None:
    article = _article(client, admin_token, "Lichtschalter")
    patched = client.patch(
        f"{ARTICLES}/{article['id']}",
        headers=_auth(admin_token),
        json={"stock_min": MAX_STOCK_QUANTITY, "purchase_price_cents": MAX_UNIT_PRICE_CENTS},
    )
    assert patched.status_code == 200, patched.text
    assert (patched.json()["stock_min"], patched.json()["purchase_price_cents"]) == (
        MAX_STOCK_QUANTITY, MAX_UNIT_PRICE_CENTS,
    )


# ── /api/werkstatt/articles/{id}/suppliers ───────────────────────────────────


def test_supplier_link_refuses_a_price_past_the_bound(client: TestClient, admin_token: str) -> None:
    article = _article(client, admin_token, "Hutschiene 35 mm")
    supplier_id = _supplier(client, admin_token, "Preisgrenze KG")
    links = f"{ARTICLES}/{article['id']}/suppliers"
    created = _post_each(
        client, admin_token, links,
        [{"supplier_id": supplier_id, "typical_price_cents": value} for value in TOO_DEAR],
    )
    assert created == [422, 422]

    link = client.post(links, headers=_auth(admin_token), json={"supplier_id": supplier_id})
    assert link.status_code == 200, link.text
    patched = _patch_each(
        client, admin_token, f"{links}/{link.json()['id']}",
        [{"typical_price_cents": value} for value in TOO_DEAR],
    )
    assert patched == [422, 422]
    with SessionLocal() as db:
        assert db.get(WerkstattArticleSupplier, link.json()["id"]).typical_price_cents is None


def test_supplier_link_refuses_a_minimum_order_quantity_past_the_bound(
    client: TestClient, admin_token: str
) -> None:
    article = _article(client, admin_token, "Hutschiene 15 mm")
    supplier_id = _supplier(client, admin_token, "Mengengrenze KG")
    links = f"{ARTICLES}/{article['id']}/suppliers"
    created = _post_each(
        client, admin_token, links,
        [{"supplier_id": supplier_id, "minimum_order_quantity": value} for value in TOO_MANY],
    )
    assert created == [422, 422]

    link = client.post(links, headers=_auth(admin_token), json={"supplier_id": supplier_id})
    assert link.status_code == 200, link.text
    patched = _patch_each(
        client, admin_token, f"{links}/{link.json()['id']}",
        [{"minimum_order_quantity": value} for value in TOO_MANY],
    )
    assert patched == [422, 422]
    with SessionLocal() as db:
        assert db.get(WerkstattArticleSupplier, link.json()["id"]).minimum_order_quantity == 1


def test_supplier_link_saves_the_bounds_themselves(client: TestClient, admin_token: str) -> None:
    article = _article(client, admin_token, "Hutschiene 7,5 mm")
    supplier_id = _supplier(client, admin_token, "Obergrenze KG")
    link = client.post(
        f"{ARTICLES}/{article['id']}/suppliers",
        headers=_auth(admin_token),
        json={
            "supplier_id": supplier_id,
            "typical_price_cents": MAX_UNIT_PRICE_CENTS,
            "minimum_order_quantity": MAX_STOCK_QUANTITY,
        },
    )
    assert link.status_code == 200, link.text
    assert (link.json()["typical_price_cents"], link.json()["minimum_order_quantity"]) == (
        MAX_UNIT_PRICE_CENTS, MAX_STOCK_QUANTITY,
    )


# ── categories and locations ─────────────────────────────────────────────────


@pytest.mark.parametrize("kind", ["categories", "locations"])
def test_display_order_outside_the_column_is_refused(client: TestClient, admin_token: str, kind: str) -> None:
    """A sort key is never summed, so its bound is the column itself."""
    path = f"/api/werkstatt/{kind}"
    outside = (INT32_MAX + 1, -INT32_MAX - 2, 10**20)
    created = _post_each(
        client, admin_token, path, [{"name": f"Regal {value}", "display_order": value} for value in outside]
    )
    assert created == [422, 422, 422]

    row = client.post(path, headers=_auth(admin_token), json={"name": "Regal A", "display_order": INT32_MAX})
    assert row.status_code == 200, row.text
    assert row.json()["display_order"] == INT32_MAX
    patched = _patch_each(
        client, admin_token, f"{path}/{row.json()['id']}", [{"display_order": value} for value in outside]
    )
    assert patched == [422, 422, 422]


# ── POST /api/werkstatt/reorder/submit ───────────────────────────────────────

REORDER = "/api/werkstatt/reorder/submit"


def _reorder_target(name: str, *, price: int | None) -> tuple[int, int]:
    """A supplier and an article linked to it under a supplier number, so the
    auto-send's pre-send resolution has nothing to refuse."""
    from tests.test_werkstatt_tablet import _seed_article, _seed_link, _seed_supplier

    with SessionLocal() as db:
        supplier = _seed_supplier(db, name=f"{name} Großhandel")
        article = _seed_article(db, article_number=f"SP-{name}", name=name, stock_total=0, stock_min=1)
        _seed_link(db, article=article, supplier=supplier, price=price, supplier_article_no=f"{name}-1")
        db.commit()
        return int(supplier.id), int(article.id)


def _reorder(client: TestClient, token: str, supplier_id: int, line: dict):
    return client.post(REORDER, headers=_auth(token), json={"supplier_id": supplier_id, "lines": [line]})


def test_reorder_refuses_a_quantity_past_the_bound(client: TestClient, admin_token: str) -> None:
    supplier_id, article_id = _reorder_target("Kabelkanal", price=None)
    answers = [
        _reorder(client, admin_token, supplier_id, {"article_id": article_id, "quantity": value}).status_code
        for value in TOO_MANY
    ]
    assert answers == [422, 422]


def test_reorder_refuses_a_unit_price_past_the_bound(client: TestClient, admin_token: str) -> None:
    supplier_id, article_id = _reorder_target("Leerrohr", price=None)
    answers = [
        _reorder(
            client, admin_token, supplier_id, {"article_id": article_id, "quantity": 1, "unit_price_cents": value}
        ).status_code
        for value in TOO_DEAR
    ]
    assert answers == [422, 422]


def test_reorder_submits_the_largest_quantity(client: TestClient, admin_token: str) -> None:
    supplier_id, article_id = _reorder_target("Mantelleitung", price=None)
    sent = _reorder(client, admin_token, supplier_id, {"article_id": article_id, "quantity": MAX_STOCK_QUANTITY})
    assert sent.status_code == 200, sent.text
    assert sent.json()["lines"][0]["quantity_ordered"] == MAX_STOCK_QUANTITY


def test_reorder_submits_the_largest_unit_price(client: TestClient, admin_token: str) -> None:
    supplier_id, article_id = _reorder_target("Zählerschrank", price=None)
    sent = _reorder(
        client, admin_token, supplier_id,
        {"article_id": article_id, "quantity": 1, "unit_price_cents": MAX_UNIT_PRICE_CENTS},
    )
    assert sent.status_code == 200, sent.text
    assert sent.json()["lines"][0]["unit_price_cents"] == MAX_UNIT_PRICE_CENTS
    assert sent.json()["total_amount_cents"] == MAX_UNIT_PRICE_CENTS


# ── the base checkout body ───────────────────────────────────────────────────


def test_the_base_checkout_body_is_bounded_too() -> None:
    """Only ``WerkstattDispensePayload`` (bounded at 10 000) is on the wire
    today; the base it extends must not be the unbounded one somebody reuses."""
    with pytest.raises(ValueError):
        CheckoutPayload(article_id=1, quantity=MAX_STOCK_QUANTITY + 1)
    assert CheckoutPayload(article_id=1, quantity=MAX_STOCK_QUANTITY).quantity == MAX_STOCK_QUANTITY
