"""Order lines fed from outside a request schema stay inside their columns.

Two writers put lines on an order without an ``OrderLineCreatePayload`` from
the user in between:

  * the IDS cart (punchout hook and manual import) — a wholesaler's XML, so
    every number in it is external input. The parser bounds each line
    (warning on the line, never an exception), and the order total is
    refused with the same German 400 as everywhere else while the raw cart
    stays on file as a failed import;
  * the material needs — a fitter's free-text quantity becomes an order
    quantity, and the catalogue price multiplies it.

The request-schema writers are in `test_werkstatt_order_bounds.py`.
"""

from __future__ import annotations

import decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.core.limits import MAX_STOCK_QUANTITY, MAX_UNIT_PRICE_CENTS
from app.models.entities import (
    MaterialCatalogItem,
    ProjectMaterialNeed,
    WerkstattArticleSupplier,
    WerkstattOrder,
    WerkstattOrderImport,
    WerkstattOrderLine,
)
from app.services import ids_cart_parser
from app.services.ids_cart_parser import CartParseError, parse_cart

TOTAL_TOO_LARGE = "Bestellsumme zu groß – bitte Menge oder Preis prüfen."


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _cart(*items: str) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?><IDS><ORDER_ITEM_LIST>'
        + "".join(items)
        + "</ORDER_ITEM_LIST></IDS>"
    )


def _item(
    *,
    article_no: str = "UE-1",
    quantity: str | None = "1",
    price: str | None = None,
    line_total: str | None = None,
) -> str:
    parts = [f"<SUPPLIER_AID>{article_no}</SUPPLIER_AID>", "<DESCRIPTION_SHORT>Teil</DESCRIPTION_SHORT>"]
    if quantity is not None:
        parts.append(f"<QUANTITY>{quantity}</QUANTITY>")
    if price is not None:
        parts.append(f"<PRICE_AMOUNT>{price}</PRICE_AMOUNT>")
    if line_total is not None:
        parts.append(f"<PRICE_LINE_AMOUNT>{line_total}</PRICE_LINE_AMOUNT>")
    return "<ORDER_ITEM>" + "".join(parts) + "</ORDER_ITEM>"


def _supplier(client: TestClient, token: str, name: str = "Unielektro") -> int:
    resp = client.post(
        "/api/werkstatt/suppliers", headers=auth_headers(token), json={"name": name}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _order_count() -> int:
    with SessionLocal() as db:
        return len(db.scalars(select(WerkstattOrder)).all())


def _imports() -> list[WerkstattOrderImport]:
    with SessionLocal() as db:
        rows = db.scalars(select(WerkstattOrderImport).order_by(WerkstattOrderImport.id)).all()
        for row in rows:
            db.expunge(row)
        return list(rows)


# 22 lines × 1 × 1,000,000.00 € — each line at its bound, the sum past int4.
OVERFLOWING_CART = _cart(
    *(_item(article_no=f"UE-{n}", quantity="1", price="1000000,00") for n in range(22))
)


# ──────────────────────────────────────────────────────────────────────────
# Parser — each line bounded, a warning instead of an exception
# ──────────────────────────────────────────────────────────────────────────


def test_a_cart_quantity_above_the_bound_becomes_one_with_a_warning() -> None:
    line = parse_cart(_cart(_item(quantity=str(MAX_STOCK_QUANTITY + 1), price="1,00"))).lines[0]
    assert line.quantity == 1
    assert any("zu groß" in warning for warning in line.warnings), line.warnings


def test_the_largest_allowed_cart_quantity_is_kept() -> None:
    line = parse_cart(_cart(_item(quantity=str(MAX_STOCK_QUANTITY), price="1,00"))).lines[0]
    assert line.quantity == MAX_STOCK_QUANTITY
    assert line.unit_price_cents == 100


def test_a_cart_unit_price_above_the_bound_is_dropped_with_a_warning() -> None:
    line = parse_cart(_cart(_item(price="1000000,01"))).lines[0]
    assert line.unit_price_cents is None
    assert any("Einzelpreis" in warning for warning in line.warnings), line.warnings


def test_the_largest_allowed_cart_unit_price_is_kept() -> None:
    line = parse_cart(_cart(_item(price="1000000,00"))).lines[0]
    assert line.unit_price_cents == MAX_UNIT_PRICE_CENTS


def test_a_derived_unit_price_above_the_bound_is_dropped() -> None:
    """A line total over a fractional quantity divides UP: 2 € for 0,000001
    pieces would be a 2,000,000 € unit price."""

    line = parse_cart(_cart(_item(quantity="0,000001", line_total="2,00"))).lines[0]
    assert line.unit_price_cents is None
    assert any("Einzelpreis" in warning for warning in line.warnings), line.warnings


def test_absurdly_long_numbers_in_a_cart_never_raise() -> None:
    """Past 28 digits `Decimal.quantize` raises InvalidOperation, and past
    4300 digits even printing the int raises — neither may escape the parser
    as a 500 from an unauthenticated hook."""

    huge = "9" * 5000
    cart = parse_cart(
        _cart(
            _item(article_no="A", quantity=huge, price="1,00"),
            _item(article_no="B", quantity="1", price=huge),
            _item(article_no="C", quantity="2", line_total=huge),
            _item(article_no="D", quantity=huge + ",5", price="1,00"),
            _item(article_no="E", quantity="0," + "0" * 40 + "1", line_total="5,00"),
            _item(article_no="F", quantity=huge + ".123", price="1,00"),
        )
    )
    quantities = [line.quantity for line in cart.lines]
    prices = [line.unit_price_cents for line in cart.lines]
    assert quantities == [1, 1, 2, 1, 1, 1]
    assert prices[1] is None and prices[2] is None and prices[4] is None
    assert any("Positionswert" in warning for warning in cart.lines[2].warnings)
    for line in cart.lines:
        assert all(len(warning) < 300 for warning in line.warnings), "echo is clipped"


# Past the decimal context's exponent range (Emax 999999) every arithmetic
# operation traps `decimal.Overflow` — an ArithmeticError, not the
# InvalidOperation the parser used to guard against. A megabyte of digits is
# enough, and a cart may carry five.
PAST_EMAX = "9" * 1_000_001
BELOW_EMIN = "0," + "0" * 1_000_005 + "1"


@pytest.mark.parametrize(
    ("item", "warning_part"),
    [
        ({"price": PAST_EMAX}, "Einzelpreis"),
        ({"line_total": PAST_EMAX}, "Positionswert"),
        # 5 € over a quantity of 1e-1000006 divides to past Emax.
        ({"quantity": BELOW_EMIN, "line_total": "5"}, "errechneter Einzelpreis"),
    ],
    ids=["unit-price", "line-total", "line-total-over-tiny-quantity"],
)
def test_numbers_past_the_decimal_exponent_range_never_raise(
    item: dict[str, str], warning_part: str
) -> None:
    line = parse_cart(_cart(_item(**item))).lines[0]
    assert line.unit_price_cents is None
    assert any(
        warning_part in warning and "unplausibel hoch" in warning for warning in line.warnings
    ), line.warnings
    assert all(len(warning) < 300 for warning in line.warnings), "echo is clipped"


def test_a_line_total_of_zero_over_a_tiny_quantity_is_a_zero_price() -> None:
    """0 € divided by 1e-1000006 is a zero with a clamped exponent, not an error."""

    line = parse_cart(_cart(_item(quantity=BELOW_EMIN, line_total="0"))).lines[0]
    assert line.unit_price_cents == 0
    assert line.quantity == 1


def test_any_other_arithmetic_error_while_parsing_is_a_cart_parse_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The backstop for the next Decimal trap nobody has thought of: both IDS
    routes turn a CartParseError into a failed import that keeps the raw
    cart, where an ArithmeticError would be a 500 that rolls it back."""

    def overflow(*_args: object, **_kwargs: object) -> None:
        raise decimal.Overflow

    monkeypatch.setattr(ids_cart_parser, "_price_cents_from", overflow)
    with pytest.raises(CartParseError, match="Position 2"):
        parse_cart(_cart(_item(article_no="A"), _item(article_no="B", price="1,00")))


# ──────────────────────────────────────────────────────────────────────────
# Manual import — 400, the raw cart kept as a failed import
# ──────────────────────────────────────────────────────────────────────────


def test_importing_a_cart_whose_total_overflows_is_refused_and_kept_as_failed(
    client: TestClient, admin_token: str
) -> None:
    supplier_id = _supplier(client, admin_token)
    resp = client.post(
        "/api/werkstatt/ids/import",
        headers=auth_headers(admin_token),
        json={"supplier_id": supplier_id, "xml": OVERFLOWING_CART},
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"] == TOTAL_TOO_LARGE
    assert _order_count() == 0

    (row,) = _imports()
    assert row.status == "failed"
    assert row.error_message == TOTAL_TOO_LARGE
    assert row.raw_payload == OVERFLOWING_CART
    assert row.order_id is None


def test_appending_a_cart_that_overflows_leaves_the_draft_alone(
    client: TestClient, admin_token: str
) -> None:
    supplier_id = _supplier(client, admin_token)
    draft = client.post(
        "/api/werkstatt/orders",
        headers=auth_headers(admin_token),
        json={
            "supplier_id": supplier_id,
            "lines": [{"description": "Kabel", "quantity_ordered": 2, "unit_price_cents": 100}],
        },
    ).json()

    resp = client.post(
        "/api/werkstatt/ids/import",
        headers=auth_headers(admin_token),
        json={"supplier_id": supplier_id, "xml": OVERFLOWING_CART, "order_id": draft["id"]},
    )
    assert resp.status_code == 400, resp.text

    after = client.get(
        f"/api/werkstatt/orders/{draft['id']}", headers=auth_headers(admin_token)
    ).json()
    assert len(after["lines"]) == 1
    with SessionLocal() as db:
        assert db.get(WerkstattOrder, draft["id"]).total_amount_cents == 200


# ──────────────────────────────────────────────────────────────────────────
# Punchout hook — an error page, never a 500
# ──────────────────────────────────────────────────────────────────────────


def _punchout_token(client: TestClient, token: str, supplier_id: int) -> str:
    connection = client.put(
        "/api/werkstatt/ids/connections",
        headers=auth_headers(token),
        json={
            "supplier_id": supplier_id,
            "is_enabled": True,
            "entry_url": "https://shop.example.com/ids",
            "username": "kunde",
            "password": "geheim",
            "customer_number": "4711",
        },
    )
    assert connection.status_code == 200, connection.text
    started = client.post(
        "/api/werkstatt/ids/start",
        headers=auth_headers(token),
        json={"supplier_id": supplier_id},
    )
    assert started.status_code == 200, started.text
    return started.json()["token"]


def test_a_returned_cart_whose_total_overflows_gets_an_error_page(
    client: TestClient, admin_token: str
) -> None:
    supplier_id = _supplier(client, admin_token)
    token = _punchout_token(client, admin_token, supplier_id)

    resp = client.post(f"/api/werkstatt/ids/hook/{token}", data={"IDS_XML": OVERFLOWING_CART})
    assert resp.status_code == 400, resp.text
    assert "Bestellsumme zu groß" in resp.text
    assert _order_count() == 0

    (row,) = _imports()
    assert row.status == "failed"
    assert row.error_message == TOTAL_TOO_LARGE
    assert row.raw_payload == OVERFLOWING_CART

    # The token is spent like on every other exit: a replay is not a retry.
    replay = client.post(f"/api/werkstatt/ids/hook/{token}", data={"IDS_XML": OVERFLOWING_CART})
    assert replay.status_code == 410


def test_a_returned_cart_with_numbers_past_the_exponent_range_is_taken_unpriced(
    client: TestClient, admin_token: str
) -> None:
    """The unauthenticated hook, raw XML body (5 MB cap): the lines arrive
    without a price and with the warning, the cart is committed, no 500."""

    supplier_id = _supplier(client, admin_token)
    token = _punchout_token(client, admin_token, supplier_id)
    cart = _cart(
        _item(article_no="A", price=PAST_EMAX),
        _item(article_no="B", quantity=BELOW_EMIN, line_total="5"),
    )

    resp = client.post(
        f"/api/werkstatt/ids/hook/{token}",
        content=cart.encode("utf-8"),
        headers={"content-type": "application/xml"},
    )
    assert resp.status_code == 200, resp.text[:500]
    assert "Warenkorb übernommen" in resp.text

    (row,) = _imports()
    assert row.status == "committed"
    with SessionLocal() as db:
        order = db.get(WerkstattOrder, row.order_id)
        lines = db.scalars(
            select(WerkstattOrderLine)
            .where(WerkstattOrderLine.order_id == order.id)
            .order_by(WerkstattOrderLine.id)
        ).all()
        assert [line.unit_price_cents for line in lines] == [None, None]
        assert [line.quantity_ordered for line in lines] == [1, 1]
        assert all("unplausibel hoch" in (line.notes or "") for line in lines)
        # No line has a price, so the total is "Preis auf Anfrage", not 0 €.
        assert order.total_amount_cents is None


# ──────────────────────────────────────────────────────────────────────────
# Material needs → order
# ──────────────────────────────────────────────────────────────────────────


def _project(client: TestClient, token: str, number: str) -> int:
    resp = client.post(
        "/api/projects",
        headers=auth_headers(token),
        json={"project_number": number, "name": "Bedarf Projekt", "status": "active"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _catalog_row(supplier_id: int, article_no: str) -> int:
    with SessionLocal() as db:
        row = MaterialCatalogItem(
            external_key=f"{supplier_id}-{article_no}",
            source_file="test.csv",
            source_line=1,
            article_no=article_no,
            item_name="Katalogartikel",
            unit="Stk",
            supplier_id=supplier_id,
            search_text=f"{article_no} katalogartikel",
        )
        db.add(row)
        db.commit()
        return row.id


def _need(client: TestClient, token: str, project_id: int, catalog_id: int, quantity: str) -> int:
    resp = client.post(
        "/api/materials",
        headers=auth_headers(token),
        json={"project_id": project_id, "material_catalog_item_id": catalog_id, "quantity": quantity},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _order_needs(client: TestClient, token: str, need_ids: list[int]):
    return client.post(
        "/api/werkstatt/bedarfe/create-order",
        headers=auth_headers(token),
        json={"need_ids": need_ids},
    )


def test_a_need_quantity_above_the_bound_orders_one_with_a_warning(
    client: TestClient, admin_token: str
) -> None:
    """Free text: "99999999999999" parses, and used to reach the flush."""

    project_id = _project(client, admin_token, "2026-BND-1")
    supplier_id = _supplier(client, admin_token)
    catalog_id = _catalog_row(supplier_id, "UE-BIG")
    need_id = _need(client, admin_token, project_id, catalog_id, "99999999999999")

    resp = _order_needs(client, admin_token, [need_id])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["orders"][0]["lines"][0]["quantity_ordered"] == 1
    assert "zu groß" in (body["added"][0]["quantity_warning"] or "")


def test_the_largest_allowed_need_quantity_is_ordered_as_is(
    client: TestClient, admin_token: str
) -> None:
    project_id = _project(client, admin_token, "2026-BND-2")
    supplier_id = _supplier(client, admin_token)
    catalog_id = _catalog_row(supplier_id, "UE-MAX")
    need_id = _need(client, admin_token, project_id, catalog_id, str(MAX_STOCK_QUANTITY))

    resp = _order_needs(client, admin_token, [need_id])
    assert resp.status_code == 200, resp.text
    assert resp.json()["orders"][0]["lines"][0]["quantity_ordered"] == MAX_STOCK_QUANTITY
    assert resp.json()["added"][0]["quantity_warning"] is None


def test_needs_whose_order_total_overflows_are_refused_and_stay_unordered(
    client: TestClient, admin_token: str
) -> None:
    """The catalogue line resolves to a stocked article whose supplier link
    carries the price — 1,000,000 × 1,000,000.00 € is far past int4."""

    project_id = _project(client, admin_token, "2026-BND-3")
    supplier_id = _supplier(client, admin_token)
    article = client.post(
        "/api/werkstatt/articles",
        headers=auth_headers(admin_token),
        json={"item_name": "Trafo", "unit": "Stk"},
    ).json()
    with SessionLocal() as db:
        db.add(
            WerkstattArticleSupplier(
                article_id=article["id"],
                supplier_id=supplier_id,
                supplier_article_no="UE-TRAFO",
                typical_price_cents=MAX_UNIT_PRICE_CENTS,
                minimum_order_quantity=1,
                is_preferred=True,
            )
        )
        db.commit()
    catalog_id = _catalog_row(supplier_id, "UE-TRAFO")
    need_id = _need(client, admin_token, project_id, catalog_id, str(MAX_STOCK_QUANTITY))

    resp = _order_needs(client, admin_token, [need_id])
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"] == TOTAL_TOO_LARGE
    assert _order_count() == 0

    with SessionLocal() as db:
        row = db.get(ProjectMaterialNeed, need_id)
        assert row.werkstatt_order_id is None
        assert row.status != "ordered"
