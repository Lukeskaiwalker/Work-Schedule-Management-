"""Order lines and order totals stay inside their columns.

`werkstatt_order_lines.quantity_ordered` / `.unit_price_cents` and
`werkstatt_orders.total_amount_cents` are int4 ``Integer`` columns. A value
wider than that reaches ``db.flush()`` as OverflowError (SQLite) / DataError
(PostgreSQL) — an unhandled 500. Worse, two values that each fit multiply into
a total that does not, and the 500 then comes from whichever request happened
to recompute it.

So: a line is bounded by the schema (422), and the total every writer stores
goes through one checked helper that refuses with a German 400 and leaves the
order exactly as it was (the transaction is rolled back).

The externally fed writers — the IDS cart and the material needs — are in
`test_werkstatt_order_bounds_external.py`.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.core.limits import INT32_MAX, MAX_STOCK_QUANTITY, MAX_UNIT_PRICE_CENTS
from app.models.entities import (
    WerkstattArticleSupplier,
    WerkstattOrder,
    WerkstattOrderLine,
)

TOTAL_TOO_LARGE = "Bestellsumme zu groß – bitte Menge oder Preis prüfen."


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _supplier(client: TestClient, token: str, name: str = "Unielektro") -> int:
    resp = client.post(
        "/api/werkstatt/suppliers", headers=auth_headers(token), json={"name": name}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _article(client: TestClient, token: str, name: str = "Mantelleitung") -> int:
    resp = client.post(
        "/api/werkstatt/articles",
        headers=auth_headers(token),
        json={"item_name": name, "unit": "Stk"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _link(
    article_id: int,
    supplier_id: int,
    *,
    price: int | None,
    supplier_article_no: str = "UE-1",
) -> int:
    with SessionLocal() as db:
        link = WerkstattArticleSupplier(
            article_id=article_id,
            supplier_id=supplier_id,
            supplier_article_no=supplier_article_no,
            typical_price_cents=price,
            minimum_order_quantity=1,
            is_preferred=True,
        )
        db.add(link)
        db.commit()
        return link.id


def _draft(client: TestClient, token: str, supplier_id: int, lines: list[dict] | None = None):
    return client.post(
        "/api/werkstatt/orders",
        headers=auth_headers(token),
        json={"supplier_id": supplier_id, "lines": lines or []},
    )


def _free_line(quantity: int = 1, price: int | None = None, name: str = "Kabel") -> dict:
    line: dict = {"description": name, "quantity_ordered": quantity}
    if price is not None:
        line["unit_price_cents"] = price
    return line


def _order(client: TestClient, token: str, order_id: int) -> dict:
    resp = client.get(f"/api/werkstatt/orders/{order_id}", headers=auth_headers(token))
    assert resp.status_code == 200, resp.text
    return resp.json()


def _stored_total(order_id: int) -> int | None:
    with SessionLocal() as db:
        return db.get(WerkstattOrder, order_id).total_amount_cents


def _order_count() -> int:
    with SessionLocal() as db:
        return len(db.scalars(select(WerkstattOrder)).all())


# ──────────────────────────────────────────────────────────────────────────
# The shared helper
# ──────────────────────────────────────────────────────────────────────────


class _Line:
    def __init__(self, quantity: int, price: int | None) -> None:
        self.quantity_ordered = quantity
        self.unit_price_cents = price


def test_the_total_helper_takes_int32_max_and_refuses_one_cent_more() -> None:
    from app.services.werkstatt_order_totals import (
        OrderTotalTooLarge,
        checked_order_total_cents,
    )

    assert checked_order_total_cents([_Line(1, INT32_MAX)]) == INT32_MAX
    assert checked_order_total_cents([_Line(3, None)]) is None
    with pytest.raises(OrderTotalTooLarge):
        checked_order_total_cents([_Line(1, INT32_MAX), _Line(1, 1)])


def test_both_total_computations_use_the_checked_helper() -> None:
    """The tablet-router total and the composition recompute are one rule."""

    from app.routers._werkstatt_tablet_shared import compute_total_cents
    from app.services.werkstatt_order_totals import OrderTotalTooLarge

    with pytest.raises(OrderTotalTooLarge):
        compute_total_cents([_Line(MAX_STOCK_QUANTITY, MAX_UNIT_PRICE_CENTS)])


# ──────────────────────────────────────────────────────────────────────────
# Schema bounds — 422 before anything is written
# ──────────────────────────────────────────────────────────────────────────


def test_adding_a_line_above_the_quantity_bound_is_refused(
    client: TestClient, admin_token: str
) -> None:
    order_id = _draft(client, admin_token, _supplier(client, admin_token)).json()["id"]
    resp = client.post(
        f"/api/werkstatt/orders/{order_id}/lines",
        headers=auth_headers(admin_token),
        json=_free_line(quantity=MAX_STOCK_QUANTITY + 1),
    )
    assert resp.status_code == 422, resp.text


def test_adding_a_line_above_the_price_bound_is_refused(
    client: TestClient, admin_token: str
) -> None:
    order_id = _draft(client, admin_token, _supplier(client, admin_token)).json()["id"]
    resp = client.post(
        f"/api/werkstatt/orders/{order_id}/lines",
        headers=auth_headers(admin_token),
        json=_free_line(price=MAX_UNIT_PRICE_CENTS + 1),
    )
    assert resp.status_code == 422, resp.text


def _draft_with_one_line(client: TestClient, token: str) -> tuple[int, int]:
    resp = _draft(client, token, _supplier(client, token), [_free_line(quantity=2, price=100)])
    assert resp.status_code == 200, resp.text
    order = resp.json()
    return order["id"], order["lines"][0]["id"]


def test_patching_a_line_above_the_quantity_bound_is_refused(
    client: TestClient, admin_token: str
) -> None:
    order_id, line_id = _draft_with_one_line(client, admin_token)
    resp = client.patch(
        f"/api/werkstatt/orders/{order_id}/lines/{line_id}",
        headers=auth_headers(admin_token),
        json={"quantity_ordered": MAX_STOCK_QUANTITY + 1},
    )
    assert resp.status_code == 422, resp.text


def test_patching_a_line_above_the_price_bound_is_refused(
    client: TestClient, admin_token: str
) -> None:
    order_id, line_id = _draft_with_one_line(client, admin_token)
    resp = client.patch(
        f"/api/werkstatt/orders/{order_id}/lines/{line_id}",
        headers=auth_headers(admin_token),
        json={"unit_price_cents": MAX_UNIT_PRICE_CENTS + 1},
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.parametrize("field", ["quantity_ordered", "currency"])
def test_patching_a_not_null_line_field_to_null_is_refused(
    client: TestClient, admin_token: str, field: str
) -> None:
    """Both columns are NOT NULL: an explicit null used to reach the flush."""

    order_id, line_id = _draft_with_one_line(client, admin_token)
    resp = client.patch(
        f"/api/werkstatt/orders/{order_id}/lines/{line_id}",
        headers=auth_headers(admin_token),
        json={field: None},
    )
    assert resp.status_code == 422, resp.text


def test_a_draft_line_above_the_quantity_bound_is_refused(
    client: TestClient, admin_token: str
) -> None:
    supplier_id = _supplier(client, admin_token)
    resp = _draft(client, admin_token, supplier_id, [_free_line(quantity=MAX_STOCK_QUANTITY + 1)])
    assert resp.status_code == 422, resp.text
    assert _order_count() == 0


def test_a_draft_line_above_the_price_bound_is_refused(
    client: TestClient, admin_token: str
) -> None:
    supplier_id = _supplier(client, admin_token)
    resp = _draft(client, admin_token, supplier_id, [_free_line(price=MAX_UNIT_PRICE_CENTS + 1)])
    assert resp.status_code == 422, resp.text
    assert _order_count() == 0


def test_the_largest_allowed_line_values_are_accepted(
    client: TestClient, admin_token: str
) -> None:
    supplier_id = _supplier(client, admin_token)
    resp = _draft(
        client,
        admin_token,
        supplier_id,
        [
            _free_line(quantity=MAX_STOCK_QUANTITY, price=1, name="Kabelbinder"),
            _free_line(quantity=1, price=MAX_UNIT_PRICE_CENTS, name="Trafo"),
        ],
    )
    assert resp.status_code == 200, resp.text
    expected = MAX_STOCK_QUANTITY + MAX_UNIT_PRICE_CENTS
    assert resp.json()["total_amount_cents"] == expected
    assert _stored_total(resp.json()["id"]) == expected


# ──────────────────────────────────────────────────────────────────────────
# The total — 400, rolled back, on every route that recomputes it
# ──────────────────────────────────────────────────────────────────────────


def _assert_total_refused(resp) -> None:
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"] == TOTAL_TOO_LARGE


def test_creating_a_draft_whose_total_overflows_is_refused(
    client: TestClient, admin_token: str
) -> None:
    supplier_id = _supplier(client, admin_token)
    resp = _draft(
        client,
        admin_token,
        supplier_id,
        [_free_line(quantity=MAX_STOCK_QUANTITY, price=MAX_UNIT_PRICE_CENTS)],
    )
    _assert_total_refused(resp)
    assert _order_count() == 0, "the draft must not survive the refusal"


def test_adding_a_line_whose_total_overflows_is_refused_and_rolled_back(
    client: TestClient, admin_token: str
) -> None:
    order_id, _line_id = _draft_with_one_line(client, admin_token)
    resp = client.post(
        f"/api/werkstatt/orders/{order_id}/lines",
        headers=auth_headers(admin_token),
        json=_free_line(quantity=MAX_STOCK_QUANTITY, price=MAX_UNIT_PRICE_CENTS),
    )
    _assert_total_refused(resp)

    order = _order(client, admin_token, order_id)
    assert len(order["lines"]) == 1
    assert _stored_total(order_id) == 200


def test_patching_a_line_into_an_overflowing_total_is_refused_and_rolled_back(
    client: TestClient, admin_token: str
) -> None:
    order_id, line_id = _draft_with_one_line(client, admin_token)
    resp = client.patch(
        f"/api/werkstatt/orders/{order_id}/lines/{line_id}",
        headers=auth_headers(admin_token),
        json={"quantity_ordered": MAX_STOCK_QUANTITY, "unit_price_cents": MAX_UNIT_PRICE_CENTS},
    )
    _assert_total_refused(resp)

    line = _order(client, admin_token, order_id)["lines"][0]
    assert (line["quantity_ordered"], line["unit_price_cents"]) == (2, 100)
    assert _stored_total(order_id) == 200


def test_merging_into_an_overflowing_total_is_refused_and_rolled_back(
    client: TestClient, admin_token: str
) -> None:
    supplier_id = _supplier(client, admin_token)
    # Each order fits on its own (2.0e9 and 2.0e8 cents); together they do not.
    target = _draft(
        client, admin_token, supplier_id, [_free_line(20, MAX_UNIT_PRICE_CENTS, "Trafo A")]
    ).json()
    source = _draft(
        client, admin_token, supplier_id, [_free_line(2, MAX_UNIT_PRICE_CENTS, "Trafo B")]
    ).json()
    assert 20 * MAX_UNIT_PRICE_CENTS <= INT32_MAX < 22 * MAX_UNIT_PRICE_CENTS

    resp = client.post(
        f"/api/werkstatt/orders/{target['id']}/merge",
        headers=auth_headers(admin_token),
        json={"source_order_id": source["id"]},
    )
    _assert_total_refused(resp)

    source_after = _order(client, admin_token, source["id"])
    target_after = _order(client, admin_token, target["id"])
    assert source_after["status"] == "draft"
    assert source_after["merged_into_order_id"] is None
    assert len(source_after["lines"]) == 1
    assert len(target_after["lines"]) == 1
    assert _stored_total(target["id"]) == 20 * MAX_UNIT_PRICE_CENTS


def test_merging_never_combines_a_line_past_the_quantity_bound(
    client: TestClient, admin_token: str
) -> None:
    """A combined line above MAX_STOCK_QUANTITY could be neither delivered
    (the ledger refuses the intake) nor edited back (the schema refuses it),
    so the two lines stay separate instead."""

    supplier_id = _supplier(client, admin_token)
    line = _free_line(MAX_STOCK_QUANTITY, None, "Kabelbinder")
    target = _draft(client, admin_token, supplier_id, [line]).json()
    source = _draft(client, admin_token, supplier_id, [line]).json()

    resp = client.post(
        f"/api/werkstatt/orders/{target['id']}/merge",
        headers=auth_headers(admin_token),
        json={"source_order_id": source["id"]},
    )
    assert resp.status_code == 200, resp.text
    quantities = [line["quantity_ordered"] for line in resp.json()["lines"]]
    assert quantities == [MAX_STOCK_QUANTITY, MAX_STOCK_QUANTITY]


def test_merging_still_combines_lines_that_fit(client: TestClient, admin_token: str) -> None:
    supplier_id = _supplier(client, admin_token)
    target = _draft(client, admin_token, supplier_id, [_free_line(MAX_STOCK_QUANTITY - 5)]).json()
    source = _draft(client, admin_token, supplier_id, [_free_line(5)]).json()

    resp = client.post(
        f"/api/werkstatt/orders/{target['id']}/merge",
        headers=auth_headers(admin_token),
        json={"source_order_id": source["id"]},
    )
    assert resp.status_code == 200, resp.text
    assert [line["quantity_ordered"] for line in resp.json()["lines"]] == [MAX_STOCK_QUANTITY]


def _template_whose_refreshed_price_overflows(
    client: TestClient, token: str
) -> tuple[int, int]:
    """A template of 1,000,000 pieces; its supplier link is priced afterwards.

    Templates carry no prices — they come back from the link on use — so the
    overflow only exists at apply time.
    """

    supplier_id = _supplier(client, token)
    article_id = _article(client, token)
    link_id = _link(article_id, supplier_id, price=None)
    order = _draft(
        client, token, supplier_id, [{"article_id": article_id, "quantity_ordered": MAX_STOCK_QUANTITY}]
    ).json()
    template = client.post(
        f"/api/werkstatt/orders/{order['id']}/save-as-template",
        headers=auth_headers(token),
        json={"name": "Großpackung"},
    )
    assert template.status_code == 200, template.text
    with SessionLocal() as db:
        db.get(WerkstattArticleSupplier, link_id).typical_price_cents = 10_000
        db.commit()
    return supplier_id, template.json()["id"]


def test_applying_a_template_into_an_overflowing_total_is_refused(
    client: TestClient, admin_token: str
) -> None:
    supplier_id, template_id = _template_whose_refreshed_price_overflows(client, admin_token)
    target = _draft(client, admin_token, supplier_id).json()

    resp = client.post(
        f"/api/werkstatt/orders/{target['id']}/apply-template",
        headers=auth_headers(admin_token),
        json={"template_id": template_id},
    )
    _assert_total_refused(resp)
    assert _order(client, admin_token, target["id"])["lines"] == []
    assert _stored_total(target["id"]) is None


def test_starting_an_order_from_a_template_with_an_overflowing_total_is_refused(
    client: TestClient, admin_token: str
) -> None:
    _supplier_id, template_id = _template_whose_refreshed_price_overflows(client, admin_token)
    before = _order_count()

    resp = client.post(
        "/api/werkstatt/orders/from-template",
        headers=auth_headers(admin_token),
        json={"template_id": template_id},
    )
    _assert_total_refused(resp)
    assert _order_count() == before, "no half-built order may survive"


def test_a_reorder_whose_total_overflows_is_refused_and_nothing_is_sent(
    client: TestClient, admin_token: str
) -> None:
    supplier_id = _supplier(client, admin_token)
    article_id = _article(client, admin_token)
    _link(article_id, supplier_id, price=None, supplier_article_no="UE-77")

    resp = client.post(
        "/api/werkstatt/reorder/submit",
        headers=auth_headers(admin_token),
        json={
            "supplier_id": supplier_id,
            "lines": [
                {
                    "article_id": article_id,
                    "quantity": MAX_STOCK_QUANTITY,
                    "unit_price_cents": MAX_UNIT_PRICE_CENTS,
                }
            ],
        },
    )
    _assert_total_refused(resp)
    assert _order_count() == 0


def test_deleting_a_line_still_recomputes_the_total(client: TestClient, admin_token: str) -> None:
    order_id, line_id = _draft_with_one_line(client, admin_token)
    resp = client.delete(
        f"/api/werkstatt/orders/{order_id}/lines/{line_id}", headers=auth_headers(admin_token)
    )
    assert resp.status_code == 200, resp.text
    assert _stored_total(order_id) is None


# ──────────────────────────────────────────────────────────────────────────
# Delivery of the largest allowed line
# ──────────────────────────────────────────────────────────────────────────


def test_delivering_the_largest_allowed_line_books_it_as_intake(
    client: TestClient, admin_token: str
) -> None:
    """mark-delivered books the remaining quantity through apply_movement; a
    line at the bound must still go through."""

    supplier_id = _supplier(client, admin_token)
    article_id = _article(client, admin_token)
    order = _draft(
        client,
        admin_token,
        supplier_id,
        [{"article_id": article_id, "quantity_ordered": MAX_STOCK_QUANTITY}],
    ).json()

    sent = client.post(
        f"/api/werkstatt/orders/{order['id']}/mark-sent", headers=auth_headers(admin_token)
    )
    assert sent.status_code == 200, sent.text
    delivered = client.post(
        f"/api/werkstatt/orders/{order['id']}/mark-delivered", headers=auth_headers(admin_token)
    )
    assert delivered.status_code == 200, delivered.text
    assert delivered.json()["lines"][0]["quantity_received"] == MAX_STOCK_QUANTITY

    article = client.get(
        f"/api/werkstatt/articles/{article_id}", headers=auth_headers(admin_token)
    ).json()
    assert article["stock_total"] == MAX_STOCK_QUANTITY
    with SessionLocal() as db:
        line = db.scalar(select(WerkstattOrderLine).where(WerkstattOrderLine.order_id == order["id"]))
        assert line.line_status == "complete"
