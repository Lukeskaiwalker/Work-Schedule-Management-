"""Construction box (Baustellenkiste) tests.

Covers the two things most likely to break silently: the status FSM, and the
stock semantics (packing must NOT move stock; assignment must).
"""
from __future__ import annotations

from fastapi.testclient import TestClient


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _customer(client: TestClient, admin_token: str, name: str) -> int:
    resp = client.post("/api/customers", headers=auth_headers(admin_token), json={"name": name})
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _article(client: TestClient, admin_token: str, name: str, stock: int) -> dict:
    """Create an article, then seed its stock with an intake ledger row.

    Stock is seeded directly (like tests/test_werkstatt_mobile.py does) because
    the snapshot counters are recomputed from the ledger — setting stock_total on
    create alone would leave the ledger and the counters disagreeing.
    """
    created = client.post(
        "/api/werkstatt/articles",
        headers=auth_headers(admin_token),
        json={"item_name": name, "unit": "Stk"},
    )
    assert created.status_code == 200, created.text
    article = created.json()
    if stock:
        from app.core.db import SessionLocal
        from app.models.entities import User, WerkstattArticle
        from app.services.werkstatt_movements import apply_movement

        with SessionLocal() as db:
            row = db.get(WerkstattArticle, article["id"])
            admin = db.scalars(
                __import__("sqlalchemy").select(User).where(User.email == "admin@example.com")
            ).first()
            apply_movement(
                db,
                article=row,
                movement_type="intake",
                quantity=stock,
                user_id=admin.id,
                notes="test-intake",
            )
            db.commit()
        article = client.get(
            f"/api/werkstatt/articles/{article['id']}", headers=auth_headers(admin_token)
        ).json()
    return article


def _box(client: TestClient, admin_token: str, label: str) -> dict:
    resp = client.post(
        "/api/werkstatt/boxes", headers=auth_headers(admin_token), json={"label": label}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_box_number_is_generated_and_starts_open(client: TestClient, admin_token: str):
    box = _box(client, admin_token, "Kiste Dachmontage")
    assert box["status"] == "offen"
    assert box["box_number"].startswith("BK-")
    assert box["item_count"] == 0


def test_manual_item_can_be_added_and_updated(client: TestClient, admin_token: str):
    box = _box(client, admin_token, "Kiste Kleinteile")

    added = client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"item_name": "Kabelbinder 200mm", "quantity": 3, "unit": "Beutel"},
    )
    assert added.status_code == 200, added.text
    item = added.json()
    assert item["item_name"] == "Kabelbinder 200mm"
    assert item["quantity"] == 3
    assert item["source"] == "manual"

    bumped = client.patch(
        f"/api/werkstatt/boxes/{box['id']}/items/{item['id']}",
        headers=auth_headers(admin_token),
        json={"quantity": 5},
    )
    assert bumped.status_code == 200
    assert bumped.json()["quantity"] == 5

    removed = client.delete(
        f"/api/werkstatt/boxes/{box['id']}/items/{item['id']}", headers=auth_headers(admin_token)
    )
    assert removed.status_code == 204


def test_rescanning_same_article_merges_into_one_line(client: TestClient, admin_token: str):
    article = _article(client, admin_token, "NYM-J 3x1.5", 100)
    box = _box(client, admin_token, "Kiste Kabel")

    for _ in range(2):
        resp = client.post(
            f"/api/werkstatt/boxes/{box['id']}/items",
            headers=auth_headers(admin_token),
            json={"article_id": article["id"], "quantity": 2},
        )
        assert resp.status_code == 200, resp.text

    items = client.get(
        f"/api/werkstatt/boxes/{box['id']}/items", headers=auth_headers(admin_token)
    ).json()
    assert len(items) == 1, "a second scan of the same article must top up, not duplicate"
    assert items[0]["quantity"] == 4
    # Identity is snapshotted from the article.
    assert items[0]["source"] == "article"
    assert items[0]["item_name"] == "NYM-J 3x1.5"


def test_packing_does_not_move_stock_but_assignment_does(client: TestClient, admin_token: str):
    article = _article(client, admin_token, "Wago 221", 50)
    customer_id = _customer(client, admin_token, "Kisten Kunde")
    box = _box(client, admin_token, "Kiste Verbinder")

    def stock_available() -> int:
        got = client.get(
            f"/api/werkstatt/articles/{article['id']}", headers=auth_headers(admin_token)
        )
        assert got.status_code == 200, got.text
        return got.json()["stock_available"]

    before = stock_available()

    client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"article_id": article["id"], "quantity": 10},
    )
    # Packing is a picking list — stock must be untouched.
    assert stock_available() == before

    assigned = client.post(
        f"/api/werkstatt/boxes/{box['id']}/assign",
        headers=auth_headers(admin_token),
        json={"customer_id": customer_id},
    )
    assert assigned.status_code == 200, assigned.text
    assert assigned.json()["status"] == "zugewiesen"
    assert assigned.json()["customer_id"] == customer_id
    # Handover checks the contents out of the warehouse.
    assert stock_available() == before - 10

    returned = client.post(
        f"/api/werkstatt/boxes/{box['id']}/status",
        headers=auth_headers(admin_token),
        json={"status": "zurueck"},
    )
    assert returned.status_code == 200, returned.text
    # Returning puts it back.
    assert stock_available() == before


def test_assigned_box_contents_are_locked(client: TestClient, admin_token: str):
    customer_id = _customer(client, admin_token, "Locked Kunde")
    box = _box(client, admin_token, "Kiste Fixed")
    client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"item_name": "Isolierband", "quantity": 1},
    )
    client.post(
        f"/api/werkstatt/boxes/{box['id']}/assign",
        headers=auth_headers(admin_token),
        json={"customer_id": customer_id},
    )

    blocked = client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"item_name": "Nachtrag", "quantity": 1},
    )
    assert blocked.status_code == 400


def test_illegal_status_transition_is_rejected(client: TestClient, admin_token: str):
    box = _box(client, admin_token, "Kiste FSM")
    # offen → zurueck is not a legal edge.
    resp = client.post(
        f"/api/werkstatt/boxes/{box['id']}/status",
        headers=auth_headers(admin_token),
        json={"status": "zurueck"},
    )
    assert resp.status_code == 400
    assert "Cannot change box status" in resp.json()["detail"]


def test_customer_boxes_endpoint(client: TestClient, admin_token: str):
    customer_id = _customer(client, admin_token, "Kisten Übersicht")
    box = _box(client, admin_token, "Kiste Kundenseite")
    client.post(
        f"/api/werkstatt/boxes/{box['id']}/assign",
        headers=auth_headers(admin_token),
        json={"customer_id": customer_id},
    )

    listing = client.get(f"/api/customers/{customer_id}/boxes", headers=auth_headers(admin_token))
    assert listing.status_code == 200, listing.text
    rows = listing.json()
    assert len(rows) == 1
    assert rows[0]["box_number"] == box["box_number"]
    assert rows[0]["status"] == "zugewiesen"

    # Returned boxes drop out of the default view but show up in the history.
    client.post(
        f"/api/werkstatt/boxes/{box['id']}/status",
        headers=auth_headers(admin_token),
        json={"status": "zurueck"},
    )
    assert client.get(
        f"/api/customers/{customer_id}/boxes", headers=auth_headers(admin_token)
    ).json() == []
    history = client.get(
        f"/api/customers/{customer_id}/boxes?include_returned=true",
        headers=auth_headers(admin_token),
    )
    assert len(history.json()) == 1

    assert (
        client.get("/api/customers/999999/boxes", headers=auth_headers(admin_token)).status_code
        == 404
    )


def test_item_search_spans_articles_and_catalog(client: TestClient, admin_token: str):
    _article(client, admin_token, "Suchbarer Artikel XYZ", 5)
    found = client.get(
        "/api/werkstatt/item-search?q=Suchbarer", headers=auth_headers(admin_token)
    )
    assert found.status_code == 200, found.text
    rows = found.json()
    assert any(r["source"] == "article" and r["stock_available"] == 5 for r in rows)


def test_standard_rack_is_seeded_on_first_listing_and_is_idempotent(
    client: TestClient, admin_token: str
):
    """The eight physical workshop boxes must exist without anybody creating them.

    Seeding happens on read, so listing twice must not produce sixteen boxes.
    """
    first = client.get("/api/werkstatt/boxes", headers=auth_headers(admin_token))
    assert first.status_code == 200, first.text
    standard = [row for row in first.json() if row["slot"] is not None]
    assert [row["slot"] for row in standard] == [1, 2, 3, 4, 5, 6, 7, 8]
    assert [row["box_number"] for row in standard] == [f"K{n}" for n in range(1, 9)]
    assert all(row["status"] == "offen" for row in standard)

    second = client.get("/api/werkstatt/boxes", headers=auth_headers(admin_token))
    assert len([row for row in second.json() if row["slot"] is not None]) == 8


def test_standard_boxes_sort_ahead_of_ad_hoc_ones(client: TestClient, admin_token: str):
    _box(client, admin_token, "Sonderkiste Umbau")
    rows = client.get("/api/werkstatt/boxes", headers=auth_headers(admin_token)).json()
    slots = [row["slot"] for row in rows]
    assert slots[:8] == [1, 2, 3, 4, 5, 6, 7, 8]
    assert slots[8:] == [None]


def test_standard_box_cannot_be_deleted(client: TestClient, admin_token: str):
    rows = client.get("/api/werkstatt/boxes", headers=auth_headers(admin_token)).json()
    standard = next(row for row in rows if row["slot"] == 1)

    blocked = client.delete(
        f"/api/werkstatt/boxes/{standard['id']}", headers=auth_headers(admin_token)
    )
    assert blocked.status_code == 400
    assert "permanent" in blocked.json()["detail"]

    # An ad-hoc box is still deletable.
    ad_hoc = _box(client, admin_token, "Wegwerfkiste")
    assert (
        client.delete(
            f"/api/werkstatt/boxes/{ad_hoc['id']}", headers=auth_headers(admin_token)
        ).status_code
        == 204
    )


def test_standard_box_is_packable_and_reusable(client: TestClient, admin_token: str):
    """A standard box goes out and comes back, then is available again."""
    customer_id = _customer(client, admin_token, "Stammkunde")
    rows = client.get("/api/werkstatt/boxes", headers=auth_headers(admin_token)).json()
    box = next(row for row in rows if row["slot"] == 3)

    client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"item_name": "Bohrhammer-Zubehör", "quantity": 1},
    )
    assigned = client.post(
        f"/api/werkstatt/boxes/{box['id']}/assign",
        headers=auth_headers(admin_token),
        json={"customer_id": customer_id},
    )
    assert assigned.status_code == 200, assigned.text

    client.post(
        f"/api/werkstatt/boxes/{box['id']}/status",
        headers=auth_headers(admin_token),
        json={"status": "zurueck"},
    )
    reopened = client.post(
        f"/api/werkstatt/boxes/{box['id']}/status",
        headers=auth_headers(admin_token),
        json={"status": "offen"},
    )
    assert reopened.status_code == 200, reopened.text
    assert reopened.json()["status"] == "offen"
    # Still slot 3, still the same crate.
    assert reopened.json()["slot"] == 3
    assert reopened.json()["box_number"] == "K3"


def test_clear_items_empties_a_box_but_not_a_handed_over_one(
    client: TestClient, admin_token: str
):
    customer_id = _customer(client, admin_token, "Leer Kunde")
    box = _box(client, admin_token, "Kiste Leeren")
    for name in ("Klemme", "Dose", "Kabel"):
        client.post(
            f"/api/werkstatt/boxes/{box['id']}/items",
            headers=auth_headers(admin_token),
            json={"item_name": name, "quantity": 1},
        )

    cleared = client.delete(
        f"/api/werkstatt/boxes/{box['id']}/items", headers=auth_headers(admin_token)
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["item_count"] == 0
    assert cleared.json()["items"] == []

    # Once handed over the contents are locked, so clearing must be refused too.
    client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"item_name": "Nachschub", "quantity": 1},
    )
    client.post(
        f"/api/werkstatt/boxes/{box['id']}/assign",
        headers=auth_headers(admin_token),
        json={"customer_id": customer_id},
    )
    blocked = client.delete(
        f"/api/werkstatt/boxes/{box['id']}/items", headers=auth_headers(admin_token)
    )
    assert blocked.status_code == 400


def test_selectable_boxes_group_customer_free_and_other(client: TestClient, admin_token: str):
    """The picker's one call must answer "this customer's boxes + the free rack".

    Neither of the pre-existing lists can: both match customer_id exactly, so at
    task-creation time — when the right crate is still in the rack, unowned —
    they return nothing.
    """
    customer_a = _customer(client, admin_token, "Kunde A")
    customer_b = _customer(client, admin_token, "Kunde B")

    box_a = _box(client, admin_token, "Kiste A")
    box_b = _box(client, admin_token, "Kiste B")
    for box, customer_id in ((box_a, customer_a), (box_b, customer_b)):
        client.post(
            f"/api/werkstatt/boxes/{box['id']}/items",
            headers=auth_headers(admin_token),
            json={"item_name": "Inhalt", "quantity": 1},
        )
        client.post(
            f"/api/werkstatt/boxes/{box['id']}/assign",
            headers=auth_headers(admin_token),
            json={"customer_id": customer_id},
        )

    resp = client.get(
        f"/api/werkstatt/boxes/selectable?customer_id={customer_a}",
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    by_id = {row["id"]: row for row in rows}

    assert by_id[box_a["id"]]["group"] == "customer"
    assert box_b["id"] not in by_id, "another customer's box must not show up while browsing"
    # The eight rack boxes are seeded on demand and offered as free.
    rack = [row for row in rows if row["slot"] is not None]
    assert len(rack) == 8
    assert all(row["group"] == "free" for row in rack)
    # Customer's own boxes first, then the rack in slot order.
    assert rows[0]["id"] == box_a["id"]
    assert [row["slot"] for row in rows[1:9]] == [1, 2, 3, 4, 5, 6, 7, 8]


def test_selectable_boxes_reach_other_customers_only_by_search(
    client: TestClient, admin_token: str
):
    customer_a = _customer(client, admin_token, "Sucher")
    customer_b = _customer(client, admin_token, "Fremdbesitzer")
    box_b = _box(client, admin_token, "Kiste Fremd")
    client.post(
        f"/api/werkstatt/boxes/{box_b['id']}/items",
        headers=auth_headers(admin_token),
        json={"item_name": "Inhalt", "quantity": 1},
    )
    client.post(
        f"/api/werkstatt/boxes/{box_b['id']}/assign",
        headers=auth_headers(admin_token),
        json={"customer_id": customer_b},
    )

    found = client.get(
        f"/api/werkstatt/boxes/selectable?customer_id={customer_a}&q={box_b['box_number']}",
        headers=auth_headers(admin_token),
    ).json()
    hit = next(row for row in found if row["id"] == box_b["id"])
    assert hit["group"] == "other"
    assert hit["customer_name"] == "Fremdbesitzer", "the office must see whose crate it is"


def test_selectable_boxes_hide_returned_unless_explicitly_included(
    client: TestClient, admin_token: str
):
    """A returned box is history — but the edit form must still render it."""
    customer_id = _customer(client, admin_token, "Rückgabe Kunde")
    box = _box(client, admin_token, "Kiste Rückläufer")
    client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"item_name": "Inhalt", "quantity": 1},
    )
    client.post(
        f"/api/werkstatt/boxes/{box['id']}/assign",
        headers=auth_headers(admin_token),
        json={"customer_id": customer_id},
    )
    client.post(
        f"/api/werkstatt/boxes/{box['id']}/status",
        headers=auth_headers(admin_token),
        json={"status": "zurueck"},
    )

    default = client.get(
        f"/api/werkstatt/boxes/selectable?customer_id={customer_id}",
        headers=auth_headers(admin_token),
    ).json()
    assert box["id"] not in {row["id"] for row in default}

    included = client.get(
        f"/api/werkstatt/boxes/selectable?customer_id={customer_id}"
        f"&include_box_id={box['id']}",
        headers=auth_headers(admin_token),
    ).json()
    assert box["id"] in {row["id"] for row in included}


def test_selectable_boxes_offer_a_box_already_at_this_customer(
    client: TestClient, admin_token: str
):
    """Confirmed with the product owner: a crate already on site is exactly
    what a follow-up task wants to reference."""
    customer_id = _customer(client, admin_token, "Vor Ort")
    box = _box(client, admin_token, "Kiste unterwegs")
    client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"item_name": "Inhalt", "quantity": 1},
    )
    client.post(
        f"/api/werkstatt/boxes/{box['id']}/assign",
        headers=auth_headers(admin_token),
        json={"customer_id": customer_id},
    )

    rows = client.get(
        f"/api/werkstatt/boxes/selectable?customer_id={customer_id}",
        headers=auth_headers(admin_token),
    ).json()
    hit = next(row for row in rows if row["id"] == box["id"])
    assert hit["status"] == "zugewiesen"
    assert hit["group"] == "customer"
    assert hit["item_count"] == 1


def test_selectable_boxes_seed_the_rack_without_the_werkstatt_tab(
    client: TestClient, admin_token: str
):
    """The picker must not depend on somebody opening the Werkstatt tab first."""
    rows = client.get(
        "/api/werkstatt/boxes/selectable", headers=auth_headers(admin_token)
    ).json()
    assert sorted(row["slot"] for row in rows if row["slot"] is not None) == [1, 2, 3, 4, 5, 6, 7, 8]
    assert all(row["group"] == "free" for row in rows)


def test_selectable_route_is_not_shadowed_by_the_box_id_route(
    client: TestClient, admin_token: str
):
    """'selectable' must not be parsed as a box_id path param."""
    resp = client.get("/api/werkstatt/boxes/selectable", headers=auth_headers(admin_token))
    assert resp.status_code == 200, resp.text
    assert isinstance(resp.json(), list)


def _supplier(client: TestClient, admin_token: str, name: str) -> int:
    resp = client.post(
        "/api/werkstatt/suppliers", headers=auth_headers(admin_token), json={"name": name}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _link_supplier_article_no(article_id: int, supplier_id: int, supplier_article_no: str) -> None:
    """Attach a wholesaler's own article number to one of our articles."""
    from app.core.db import SessionLocal
    from app.models.entities import WerkstattArticleSupplier

    with SessionLocal() as db:
        db.add(
            WerkstattArticleSupplier(
                article_id=article_id,
                supplier_id=supplier_id,
                supplier_article_no=supplier_article_no,
            )
        )
        db.commit()


def test_item_search_finds_an_article_by_its_supplier_article_number(
    client: TestClient, admin_token: str
):
    """A wholesaler labels goods with THEIR number, not our SP-number.

    Without the supplier join, scanning a Unielektro barcode found nothing even
    though the article sits in our rack.
    """
    article = _article(client, admin_token, "Schütz 3-polig 25A", 4)
    supplier_id = _supplier(client, admin_token, "Unielektro")
    _link_supplier_article_no(article["id"], supplier_id, "UE-998877")

    found = client.get(
        "/api/werkstatt/item-search?q=UE-998877", headers=auth_headers(admin_token)
    )
    assert found.status_code == 200, found.text
    rows = found.json()
    assert rows, "supplier article number must resolve to the stocked article"
    hit = rows[0]
    assert hit["article_id"] == article["id"]
    assert hit["match"] == "exact_supplier_no"
    assert hit["supplier_name"] == "Unielektro"
    assert hit["supplier_article_no"] == "UE-998877"


def test_item_search_ranks_an_exact_ean_above_a_substring_match(
    client: TestClient, admin_token: str
):
    """The scanner reads position 0, so an exact hit must never rank below a
    coincidental substring match on another article."""
    from app.core.db import SessionLocal
    from app.models.entities import WerkstattArticle

    decoy = _article(client, admin_token, "AAA Erste Alphabetisch", 1)
    target = _article(client, admin_token, "ZZZ Letzte Alphabetisch", 1)
    with SessionLocal() as db:
        # The decoy's EAN merely CONTAINS the scanned code; the target's IS it.
        db.get(WerkstattArticle, decoy["id"]).ean = "99940123456789"
        db.get(WerkstattArticle, target["id"]).ean = "4012345678"
        db.commit()

    rows = client.get(
        "/api/werkstatt/item-search?q=4012345678", headers=auth_headers(admin_token)
    ).json()
    assert len(rows) == 2, "both should be found — ordering is what matters"
    assert rows[0]["article_id"] == target["id"]
    assert rows[0]["match"] == "exact_ean"
    assert rows[1]["match"] == "partial"


def test_item_search_still_matches_our_own_article_number_and_free_text(
    client: TestClient, admin_token: str
):
    article = _article(client, admin_token, "Kabelkanal 40x40", 3)
    by_sp = client.get(
        f"/api/werkstatt/item-search?q={article['article_number']}",
        headers=auth_headers(admin_token),
    ).json()
    assert by_sp[0]["article_id"] == article["id"]
    assert by_sp[0]["match"] == "exact_article_no"

    by_text = client.get(
        "/api/werkstatt/item-search?q=Kabelkanal", headers=auth_headers(admin_token)
    ).json()
    assert any(row["article_id"] == article["id"] for row in by_text)
    assert all(row["match"] == "partial" for row in by_text)


def test_item_search_tokenises_multi_word_queries(client: TestClient, admin_token: str):
    """The reported failure: an article we stock is not found when searched.

    ``item-search`` used to wrap the ENTIRE query in one ``ILIKE '%…%'``, so it
    only ever matched a contiguous substring. Every query below names the
    article that is actually in stock, but differs in the ways people type:
    a dropped suffix, reordered words, and a point instead of a comma.
    """
    article = _article(client, admin_token, "NYM-J 3x1,5 Mantelleitung grau", 10)

    def found(query: str) -> bool:
        response = client.get(
            f"/api/werkstatt/item-search?q={query}", headers=auth_headers(admin_token)
        )
        assert response.status_code == 200, response.text
        return any(row["article_id"] == article["id"] for row in response.json())

    assert found("NYM%203x1,5")            # partial first token
    assert found("Mantelleitung%20NYM")    # reversed order
    assert found("NYM%203x1.5")            # point instead of comma
    assert not found("Schuko")             # unrelated term still misses


def test_item_search_ignores_whitespace_only_query(client: TestClient, admin_token: str):
    """A blank query must not drop an arbitrary article at position 0.

    The scanner auto-adds the first hit when it is unambiguous, so returning
    "everything" for a query that tokenises to nothing could put the wrong
    article into a crate.
    """
    _article(client, admin_token, "Kabelbinder schwarz", 5)
    response = client.get("/api/werkstatt/item-search?q=%20", headers=auth_headers(admin_token))
    assert response.status_code == 200
    assert response.json() == []
