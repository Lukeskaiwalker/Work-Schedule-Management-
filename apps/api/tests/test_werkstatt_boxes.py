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


def test_packing_zero_of_something_is_refused_rather_than_rounded_up_to_one(
    client: TestClient, admin_token: str
):
    """``int(payload.quantity or 1)`` mapped 0 to 1 before the ``<= 0`` guard
    below it could ever see it, so a client that sent 0 — a cleared spinner, a
    scanner that reported nothing — silently packed one unit into the crate.

    The guard sees the 0 now. Both callers of ``add_item_to_box`` run this same
    line, so the station path is pinned by the twin of this test in
    tests/test_station_werkstatt.py.
    """
    article = _article(client, admin_token, "Wago 221-412", 10)
    box = _box(client, admin_token, "Kiste Null")

    refused = client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"article_id": article["id"], "quantity": 0},
    )
    assert refused.status_code == 400, refused.text
    assert "quantity" in refused.json()["detail"]

    assert (
        client.get(
            f"/api/werkstatt/boxes/{box['id']}/items", headers=auth_headers(admin_token)
        ).json()
        == []
    )

    # A negative count was already refused; it must stay refused by the same line.
    negative = client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"article_id": article["id"], "quantity": -3},
    )
    assert negative.status_code == 400, negative.text


def test_packing_an_unbounded_quantity_is_refused_before_it_reaches_the_column(
    client: TestClient, admin_token: str
):
    """The two station bodies were bounded; this one — what a phone posts — was not.

    ``quantity`` was a bare ``int``, so a value wider than the column reached
    ``db.flush()`` and came back as an OverflowError/DataError: an unhandled
    500 raised *past* the endpoint's own error handling, with the session left
    dirty and nothing rolled back. The bound is on the wire now, so an absurd
    count never opens a transaction at all.

    Bounded above only, on purpose. Zero and negatives stay the business
    rule's own 400 from ``add_item_to_box`` — the line the phone and the wall
    both run — rather than becoming a 422 that says something different on the
    two paths. The PATCH that corrects a line had the identical hole and is
    pinned here too.
    """
    article = _article(client, admin_token, "Kabelkanal 60x60", 5)
    box = _box(client, admin_token, "Kiste Menge")
    url = f"/api/werkstatt/boxes/{box['id']}/items"
    head = auth_headers(admin_token)

    at_the_bound = client.post(
        url, headers=head, json={"article_id": article["id"], "quantity": 10_000}
    )
    assert at_the_bound.status_code == 200, at_the_bound.text
    assert at_the_bound.json()["quantity"] == 10_000

    for over in (10_001, 10**20):
        refused = client.post(
            url, headers=head, json={"article_id": article["id"], "quantity": over}
        )
        assert refused.status_code == 422, f"{over}: {refused.status_code} {refused.text}"

    zero = client.post(url, headers=head, json={"article_id": article["id"], "quantity": 0})
    assert zero.status_code == 400, zero.text
    assert "quantity" in zero.json()["detail"]

    # Correcting a line writes the number into the same column, so the PATCH
    # body carries the same bound — and the same 400 below it.
    line_id = at_the_bound.json()["id"]
    corrected = client.patch(f"{url}/{line_id}", headers=head, json={"quantity": 10**20})
    assert corrected.status_code == 422, corrected.text

    items = client.get(url, headers=head).json()
    assert [row["quantity"] for row in items] == [10_000], "only the meant line was packed"


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
    # German, and it names both ends of the edge it refused — the workshop
    # reads these verbatim.
    detail = resp.json()["detail"]
    assert "Offen" in detail and "Zurück" in detail


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
    assert "Standard-Kisten" in blocked.json()["detail"]

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


def test_item_search_finds_an_article_by_our_own_printed_barcode(
    client: TestClient, admin_token: str
) -> None:
    """The reported bug: in-house labels would not scan into a Kiste.

    Stock added during a stock-take gets a code this app mints and prints.
    The Kisten scanner searched item_name, article_number, EAN and supplier
    number — every column except the one that code lives in — so packing a
    crate by scanning our own labels found nothing for stock on the shelf.
    """

    from app.core.db import SessionLocal
    from app.models.entities import WerkstattArticle

    article = _article(client, admin_token, "Wago 285-1185", stock=5)
    with SessionLocal() as db:
        row = db.get(WerkstattArticle, article["id"])
        row.internal_code = "SMPL-Z7W5C9"
        db.commit()

    found = client.get(
        "/api/werkstatt/item-search?q=SMPL-Z7W5C9", headers=auth_headers(admin_token)
    )
    assert found.status_code == 200, found.text
    hits = found.json()
    assert len(hits) == 1, "an in-house code identifies exactly one article"
    assert hits[0]["article_id"] == article["id"]
    assert hits[0]["match"] == "exact_internal_code"
    # The scanner reads position 0 and refuses anything that is not exact, so
    # a "partial" here would have the same effect as finding nothing.
    assert hits[0]["match"] != "partial"


# ── Packen, Mitnehmen, Zuweisung aufheben ────────────────────────────────────
#
# ``gepackt`` means "packed AND assigned to a customer, standing in the
# workshop, ready to be taken". These pin the two halves of that sentence: no
# stock moves while the crate is still in the workshop, and the handover is a
# separate act.


def _pack(client: TestClient, admin_token: str, box_id: int, customer_id: int, **extra):
    return client.post(
        f"/api/werkstatt/boxes/{box_id}/pack",
        headers=auth_headers(admin_token),
        json={"customer_id": customer_id, **extra},
    )


def test_pack_assigns_the_customer_without_moving_stock(client: TestClient, admin_token: str):
    article = _article(client, admin_token, "Wago 2273-203", 40)
    customer_id = _customer(client, admin_token, "Kunde Gepackt")
    box = _box(client, admin_token, "Kiste Bereit")
    client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"article_id": article["id"], "quantity": 6},
    )

    packed = _pack(client, admin_token, box["id"], customer_id)
    assert packed.status_code == 200, packed.text
    body = packed.json()
    assert body["status"] == "gepackt"
    assert body["customer_id"] == customer_id
    assert body["packed_at"] is not None
    assert body["assigned_at"] is None

    got = client.get(
        f"/api/werkstatt/articles/{article['id']}", headers=auth_headers(admin_token)
    ).json()
    assert got["stock_available"] == 40


def test_pack_refuses_an_empty_crate_and_a_crate_without_a_customer(
    client: TestClient, admin_token: str
):
    customer_id = _customer(client, admin_token, "Kunde Leer")
    box = _box(client, admin_token, "Kiste Leer")

    empty = _pack(client, admin_token, box["id"], customer_id)
    assert empty.status_code == 400
    assert "Position" in empty.json()["detail"]

    client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"item_name": "Klemmen", "quantity": 2},
    )
    # The FSM guards the same rule for anybody who drives /status directly.
    bare = client.post(
        f"/api/werkstatt/boxes/{box['id']}/status",
        headers=auth_headers(admin_token),
        json={"status": "gepackt"},
    )
    assert bare.status_code == 400
    assert "Kunde" in bare.json()["detail"]


def test_a_packed_crate_can_still_be_topped_up(client: TestClient, admin_token: str):
    """Only ``zugewiesen`` freezes the contents — a top-up before it leaves is real life."""
    customer_id = _customer(client, admin_token, "Kunde Nachpacken")
    box = _box(client, admin_token, "Kiste Nachpacken")
    client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"item_name": "Dosen", "quantity": 4},
    )
    assert _pack(client, admin_token, box["id"], customer_id).status_code == 200

    added = client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"item_name": "Nachtrag", "quantity": 1},
    )
    assert added.status_code == 200, added.text


def test_handover_from_packed_checks_the_contents_out(client: TestClient, admin_token: str):
    article = _article(client, admin_token, "Hager MBN116", 12)
    customer_id = _customer(client, admin_token, "Kunde Übergabe")
    box = _box(client, admin_token, "Kiste Übergabe")
    client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"article_id": article["id"], "quantity": 5},
    )
    assert _pack(client, admin_token, box["id"], customer_id).status_code == 200

    handed = client.post(
        f"/api/werkstatt/boxes/{box['id']}/status",
        headers=auth_headers(admin_token),
        json={"status": "zugewiesen"},
    )
    assert handed.status_code == 200, handed.text
    assert handed.json()["assigned_at"] is not None
    got = client.get(
        f"/api/werkstatt/articles/{article['id']}", headers=auth_headers(admin_token)
    ).json()
    assert got["stock_available"] == 7


def test_unassigning_a_packed_crate_clears_the_customer(client: TestClient, admin_token: str):
    customer_id = _customer(client, admin_token, "Kunde Aufheben")
    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-4711",
            "name": "Projekt Aufheben",
            "status": "active",
            "customer_id": customer_id,
        },
    )
    assert project.status_code == 200, project.text
    box = _box(client, admin_token, "Kiste Aufheben")
    client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"item_name": "Leitung", "quantity": 1},
    )
    assert (
        _pack(
            client, admin_token, box["id"], customer_id, project_id=project.json()["id"]
        ).status_code
        == 200
    )

    reopened = client.post(
        f"/api/werkstatt/boxes/{box['id']}/status",
        headers=auth_headers(admin_token),
        json={"status": "offen"},
    )
    assert reopened.status_code == 200, reopened.text
    body = reopened.json()
    assert body["status"] == "offen"
    assert body["customer_id"] is None and body["project_id"] is None
    assert body["packed_at"] is None
    # The contents survive — this undoes the assignment, not the packing.
    assert body["item_count"] == 1


def test_assign_still_packs_and_hands_over_in_one_step(client: TestClient, admin_token: str):
    """The one-step route stays as a published shape; this test is what keeps it.

    No client in the repository calls it any more — the Kisten page posts
    ``/pack`` and then ``/status``. It is still a legal act ("it is going out
    right now"), so it is pinned rather than deleted.
    """
    article = _article(client, admin_token, "Kabelbinder", 10)
    customer_id = _customer(client, admin_token, "Kunde Einschritt")
    box = _box(client, admin_token, "Kiste Einschritt")
    client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"article_id": article["id"], "quantity": 3},
    )

    assigned = client.post(
        f"/api/werkstatt/boxes/{box['id']}/assign",
        headers=auth_headers(admin_token),
        json={"customer_id": customer_id},
    )
    assert assigned.status_code == 200, assigned.text
    body = assigned.json()
    assert body["status"] == "zugewiesen"
    assert body["packed_at"] is not None and body["assigned_at"] is not None


# ── A sealed crate keeps its promise ─────────────────────────────────────────
#
# "Gepackt" is read off a rack, off the wall screen, and by the station's
# handover endpoint. Everything below pins the same sentence from a different
# side: while a crate says that, it has a customer and something in it.


def _box_updated_at(box_id: int):
    """``updated_at`` is not serialised, and it is exactly what is under test."""
    from app.core.db import SessionLocal
    from app.models.entities import WerkstattConstructionBox

    with SessionLocal() as db:
        return db.get(WerkstattConstructionBox, box_id).updated_at


def test_a_sealed_crate_cannot_be_emptied(client: TestClient, admin_token: str):
    """The rule that seals a crate has to hold for as long as it is sealed.

    Emptying checked only at sealing time left the claim standing over a crate
    whose last line had since been taken back out — and the wall screen, the
    assign card and ``POST /station/.../handover`` all believe that claim.
    """
    customer_id = _customer(client, admin_token, "Kunde Versiegelt")
    box = _box(client, admin_token, "Kiste Versiegelt")
    for name in ("Klemmen", "Dosen"):
        client.post(
            f"/api/werkstatt/boxes/{box['id']}/items",
            headers=auth_headers(admin_token),
            json={"item_name": name, "quantity": 2},
        )
    assert _pack(client, admin_token, box["id"], customer_id).status_code == 200

    blocked = client.delete(
        f"/api/werkstatt/boxes/{box['id']}/items", headers=auth_headers(admin_token)
    )
    assert blocked.status_code == 400
    assert "Zuweisung aufheben" in blocked.json()["detail"]

    items = client.get(
        f"/api/werkstatt/boxes/{box['id']}/items", headers=auth_headers(admin_token)
    ).json()
    assert len(items) == 2

    # Taking one of two lines out is fine — the crate still holds something.
    first = client.delete(
        f"/api/werkstatt/boxes/{box['id']}/items/{items[0]['id']}",
        headers=auth_headers(admin_token),
    )
    assert first.status_code == 204, first.text

    # The last one is not: that is the same emptying, one request at a time.
    last = client.delete(
        f"/api/werkstatt/boxes/{box['id']}/items/{items[1]['id']}",
        headers=auth_headers(admin_token),
    )
    assert last.status_code == 400
    assert "Zuweisung aufheben" in last.json()["detail"]

    state = client.get(
        f"/api/werkstatt/boxes/{box['id']}", headers=auth_headers(admin_token)
    ).json()
    assert state["status"] == "gepackt" and state["item_count"] == 1

    # And the way out is the assignment, not the contents.
    assert (
        client.post(
            f"/api/werkstatt/boxes/{box['id']}/status",
            headers=auth_headers(admin_token),
            json={"status": "offen"},
        ).status_code
        == 200
    )
    assert (
        client.delete(
            f"/api/werkstatt/boxes/{box['id']}/items", headers=auth_headers(admin_token)
        ).status_code
        == 200
    )


def test_an_empty_crate_cannot_be_sealed_through_the_status_endpoint(
    client: TestClient, admin_token: str
):
    """The reachable hole: a returned crate keeps its customer, so ``/status``
    could seal it with nothing in it — and the wall screen would advertise it."""
    customer_id = _customer(client, admin_token, "Kunde Rückläufer")
    box = _box(client, admin_token, "Kiste Rückläufer")
    client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"item_name": "Leitung", "quantity": 1},
    )
    for status in ("zugewiesen", "zurueck", "offen"):
        if status == "zugewiesen":
            assert (
                client.post(
                    f"/api/werkstatt/boxes/{box['id']}/assign",
                    headers=auth_headers(admin_token),
                    json={"customer_id": customer_id},
                ).status_code
                == 200
            )
            continue
        assert (
            client.post(
                f"/api/werkstatt/boxes/{box['id']}/status",
                headers=auth_headers(admin_token),
                json={"status": status},
            ).status_code
            == 200
        )
    # Coming back from ``zurueck`` keeps the customer — only the gepackt → offen
    # edge is "Zuweisung aufheben".
    assert (
        client.delete(
            f"/api/werkstatt/boxes/{box['id']}/items", headers=auth_headers(admin_token)
        ).status_code
        == 200
    )

    sealed = client.post(
        f"/api/werkstatt/boxes/{box['id']}/status",
        headers=auth_headers(admin_token),
        json={"status": "gepackt"},
    )
    assert sealed.status_code == 400
    assert "leer" in sealed.json()["detail"]
    state = client.get(
        f"/api/werkstatt/boxes/{box['id']}", headers=auth_headers(admin_token)
    ).json()
    assert state["status"] == "offen"


def test_handing_an_empty_crate_over_is_still_allowed(client: TestClient, admin_token: str):
    """``/assign`` is the one caller that passes THROUGH gepackt on purpose.

    It makes no claim about a crate standing ready on a rack — it books
    whatever is inside out of the warehouse, and booking nothing out is
    harmless. The exemption is explicit so the rule above cannot break it.
    """
    customer_id = _customer(client, admin_token, "Kunde Leerübergabe")
    box = _box(client, admin_token, "Kiste Leerübergabe")

    assigned = client.post(
        f"/api/werkstatt/boxes/{box['id']}/assign",
        headers=auth_headers(admin_token),
        json={"customer_id": customer_id},
    )
    assert assigned.status_code == 200, assigned.text
    assert assigned.json()["status"] == "zugewiesen"


def test_a_sealed_crate_is_not_repacked_for_another_customer(
    client: TestClient, admin_token: str
):
    """It already holds one customer's material; re-labelling it would leave the
    rack, the wall screen and the station naming the wrong person."""
    first_id = _customer(client, admin_token, "Kunde Erst")
    second_id = _customer(client, admin_token, "Kunde Zweit")
    box = _box(client, admin_token, "Kiste Umwidmung")
    client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"item_name": "Schienen", "quantity": 3},
    )
    assert _pack(client, admin_token, box["id"], first_id).status_code == 200

    refused = _pack(client, admin_token, box["id"], second_id)
    assert refused.status_code == 400
    assert "anderen Kunden" in refused.json()["detail"]
    state = client.get(
        f"/api/werkstatt/boxes/{box['id']}", headers=auth_headers(admin_token)
    ).json()
    assert state["customer_id"] == first_id and state["status"] == "gepackt"

    # Handing it over to somebody else is the same mistake with the checkout
    # attached, so the one-step route refuses it too.
    assert (
        client.post(
            f"/api/werkstatt/boxes/{box['id']}/assign",
            headers=auth_headers(admin_token),
            json={"customer_id": second_id},
        ).status_code
        == 400
    )


def test_repacking_the_same_crate_for_the_same_customer_records_the_change(
    client: TestClient, admin_token: str
):
    """``gepackt → gepackt`` is a no-op edge, so the timestamp is stamped by the
    call that changed the owner — otherwise a moved project is invisible."""
    customer_id = _customer(client, admin_token, "Kunde Nachtrag")
    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-4712",
            "name": "Projekt Nachtrag",
            "status": "active",
            "customer_id": customer_id,
        },
    )
    assert project.status_code == 200, project.text
    box = _box(client, admin_token, "Kiste Nachtrag")
    client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"item_name": "Rohr", "quantity": 1},
    )
    first = _pack(client, admin_token, box["id"], customer_id)
    assert first.status_code == 200, first.text
    before = _box_updated_at(box["id"])

    again = _pack(client, admin_token, box["id"], customer_id, project_id=project.json()["id"])
    assert again.status_code == 200, again.text
    assert again.json()["project_id"] == project.json()["id"]
    assert _box_updated_at(box["id"]) != before


def test_a_crate_packed_for_a_customer_cannot_be_deleted(
    client: TestClient, admin_token: str
):
    """``gepackt`` became a resting state, so "handed over" no longer covers
    every crate that is spoken for — the settlement's leftover crates least of
    all, and deleting one loses the record of where the rest went."""
    customer_id = _customer(client, admin_token, "Kunde Löschen")
    box = _box(client, admin_token, "Kiste Löschen")
    client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"item_name": "Rest", "quantity": 2},
    )
    assert _pack(client, admin_token, box["id"], customer_id).status_code == 200

    blocked = client.delete(
        f"/api/werkstatt/boxes/{box['id']}", headers=auth_headers(admin_token)
    )
    assert blocked.status_code == 400
    assert "Zuweisung" in blocked.json()["detail"]

    # Freed from the customer it is deletable again.
    assert (
        client.post(
            f"/api/werkstatt/boxes/{box['id']}/status",
            headers=auth_headers(admin_token),
            json={"status": "offen"},
        ).status_code
        == 200
    )
    assert (
        client.delete(
            f"/api/werkstatt/boxes/{box['id']}", headers=auth_headers(admin_token)
        ).status_code
        == 204
    )


def test_the_item_search_rationale_is_written_down_exactly_once():
    """The ranking rules were explained twice in one 25-line window.

    ``search_box_items`` carried its real one-line docstring followed by a
    second bare string literal — a no-op expression — repeating the module
    docstring above it verbatim. Two copies of the same reasoning in a file
    created to give that reasoning one home, in the place a reader expects the
    function body, with only one of them reachable from ``help()``.
    """
    import inspect

    from app.services import werkstatt_item_search

    source = inspect.getsource(werkstatt_item_search)
    assert source.count("Results are ranked EXACT-IDENTIFIER FIRST") == 1
    assert "\n" not in (werkstatt_item_search.search_box_items.__doc__ or "").strip()
