"""Building an order and getting it out of the building.

The order flow used to have two quiet failure modes: a basket handed to the
shop with positions silently missing, and a supplier who imports only their
own article number receiving a cart that also carried the EAN. Both are
invisible in the API response. These tests pin the pieces that make them
visible:

  * the identifier policy — what the cart / export carries per line, decided
    per supplier and applied identically on every outbound path;
  * the pre-send resolution — read-only, per line, so the buyer sees a red
    badge before pressing anything;
  * the 409 on an unresolved line, and the one-click override past it;
  * creating an order from catalogue rows, which is where the supplier number
    lives in the first place.
"""

from __future__ import annotations

import importlib.util
from datetime import datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.services.ids_cart_builder import CartItem, build_cart_xml

_IDS_FIXTURES = Path(__file__).resolve().parent / "fixtures" / "ids"


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# ──────────────────────────────────────────────────────────────────────────
# Fixtures
# ──────────────────────────────────────────────────────────────────────────


def _supplier(client: TestClient, token: str, name: str = "Unielektro", **extra) -> dict:
    resp = client.post(
        "/api/werkstatt/suppliers", headers=auth_headers(token), json={"name": name, **extra}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _article(client: TestClient, token: str, name: str, **extra) -> dict:
    resp = client.post(
        "/api/werkstatt/articles",
        headers=auth_headers(token),
        json={"item_name": name, "unit": "Stk", **extra},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _catalog_row(
    supplier_id: int,
    *,
    article_no: str,
    ean: str | None = None,
    name: str = "Katalogartikel",
    unit: str | None = "Stk",
) -> int:
    """Insert a Datanorm row directly — the importer is not under test."""
    from app.core.db import SessionLocal
    from app.models.entities import MaterialCatalogItem

    with SessionLocal() as db:
        row = MaterialCatalogItem(
            external_key=f"{supplier_id}-{article_no}-{ean or 'x'}",
            source_file="test.csv",
            source_line=1,
            article_no=article_no,
            item_name=name,
            ean=ean,
            unit=unit,
            supplier_id=supplier_id,
            search_text=f"{article_no} {name} {ean or ''}".lower(),
        )
        db.add(row)
        db.commit()
        return row.id


def _link(client: TestClient, token: str, article_id: int, supplier_id: int, **extra) -> dict:
    resp = client.post(
        f"/api/werkstatt/articles/{article_id}/suppliers",
        headers=auth_headers(token),
        json={"supplier_id": supplier_id, **extra},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _connection(client: TestClient, token: str, supplier_id: int, **extra) -> dict:
    resp = client.put(
        "/api/werkstatt/ids/connections",
        headers=auth_headers(token),
        json={
            "supplier_id": supplier_id,
            "is_enabled": True,
            "entry_url": "https://shop.example.com/ids",
            "username": "kunde",
            "password": "geheim",
            "customer_number": "4711",
            **extra,
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _order(client: TestClient, token: str, supplier_id: int, **extra) -> dict:
    resp = client.post(
        "/api/werkstatt/orders",
        headers=auth_headers(token),
        json={"supplier_id": supplier_id, "title": "Baustelle Müller", **extra},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _add_line(client: TestClient, token: str, order_id: int, **payload) -> dict:
    resp = client.post(
        f"/api/werkstatt/orders/{order_id}/lines",
        headers=auth_headers(token),
        json={"quantity_ordered": 1, **payload},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _resolution(client: TestClient, token: str, order_id: int) -> dict:
    resp = client.get(f"/api/werkstatt/orders/{order_id}/resolution", headers=auth_headers(token))
    assert resp.status_code == 200, resp.text
    return resp.json()


def _items() -> list[CartItem]:
    return [
        CartItem(
            supplier_article_no="11102138",
            description="NYY-J 5x6",
            quantity=10,
            unit="MTR",
            ean="4011234567890",
        ),
        CartItem(supplier_article_no="01004771", description="FI 40A", quantity=1),
    ]


def _build(identifier: str, items: list[CartItem] | None = None):
    return build_cart_xml(
        items if items is not None else _items(),
        reference="WK-TEST",
        now=datetime(2026, 9, 18, 8, 0, 0),
        identifier=identifier,  # type: ignore[arg-type]
    )


# ──────────────────────────────────────────────────────────────────────────
# The identifier policy in the cart builder
# ──────────────────────────────────────────────────────────────────────────


def test_supplier_no_mode_omits_the_ean_element() -> None:
    """The owner's case: the shop imports only its own number, so the EAN
    element goes — and it is the default, so an untouched supplier gets it."""

    xml = _build("supplier_no").xml
    assert "<ArtNo>11102138</ArtNo>" in xml
    assert "<EAN>" not in xml

    # The default matches.
    default = build_cart_xml(_items(), reference="WK-TEST").xml
    assert "<EAN>" not in default


def test_both_mode_keeps_the_ean_element() -> None:
    xml = _build("both").xml
    assert "<EAN>4011234567890</EAN>" in xml
    assert "<ArtNo>11102138</ArtNo>" in xml


def test_ean_mode_puts_the_gtin_in_artno_and_drops_a_line_without_one() -> None:
    """ArtNo is mandatory in the schema, so a GTIN-keyed shop still gets
    something there — and a line with no GTIN cannot be expressed at all."""

    built = _build("ean")
    assert "<ArtNo>4011234567890</ArtNo>" in built.xml
    assert "<EAN>4011234567890</EAN>" in built.xml
    # The FI has no EAN: it is dropped and said so, never sent with the
    # supplier number a GTIN-keyed shop would not recognise.
    assert "<ArtNo>01004771</ArtNo>" not in built.xml
    assert any("Position 2" in w and "EAN" in w for w in built.warnings)


def test_supplier_no_or_ean_falls_back_to_the_ean_with_a_warning() -> None:
    items = [
        CartItem(supplier_article_no=None, description="Unbekannt", quantity=2, ean="4099999999999"),
        CartItem(supplier_article_no="01004771", description="FI 40A", quantity=1),
    ]
    built = _build("supplier_no_or_ean", items)
    assert "<ArtNo>4099999999999</ArtNo>" in built.xml
    assert "<ArtNo>01004771</ArtNo>" in built.xml
    assert "<EAN>" not in built.xml
    assert any("Position 1" in w and "EAN statt Artikelnummer" in w for w in built.warnings)


@pytest.mark.skipif(
    importlib.util.find_spec("xmlschema") is None, reason="xmlschema not installed"
)
@pytest.mark.parametrize("identifier", ["supplier_no", "supplier_no_or_ean", "ean", "both"])
def test_every_identifier_mode_validates_against_the_schema(identifier: str) -> None:
    import xmlschema

    schema = xmlschema.XMLSchema(str(_IDS_FIXTURES / "warenkorb_senden_2_5.xsd"))
    schema.validate(_build(identifier).xml)


# ──────────────────────────────────────────────────────────────────────────
# Creating an order from catalogue rows
# ──────────────────────────────────────────────────────────────────────────


def test_a_catalogue_row_becomes_a_line_with_the_suppliers_number(
    client: TestClient, admin_token: str
) -> None:
    """The whole point of the catalogue picker: the Unielektro number is on the
    Datanorm row, and it must land on the line at creation — not be
    rediscovered cold at submit time."""

    supplier = _supplier(client, admin_token)
    row_id = _catalog_row(
        supplier["id"], article_no="11102138", ean="4011234567890", name="NYY-J 5x6", unit="MTR"
    )
    article = _article(client, admin_token, "Schuko-Steckdose")

    order = _order(
        client,
        admin_token,
        supplier["id"],
        lines=[
            {"catalog_item_id": row_id, "quantity_ordered": 25},
            {"article_id": article["id"], "quantity_ordered": 3},
            {"description": "Kabelbinder 200 mm", "quantity_ordered": 1},
        ],
    )
    catalog_line, article_line, free_line = order["lines"]

    assert catalog_line["supplier_article_no"] == "11102138"
    assert catalog_line["ean"] == "4011234567890"
    assert catalog_line["article_name"] == "NYY-J 5x6"
    assert catalog_line["unit"] == "MTR"
    assert catalog_line["is_stocked"] is False

    assert article_line["article_id"] == article["id"]
    assert article_line["article_name"] == "Schuko-Steckdose"

    assert free_line["article_name"] == "Kabelbinder 200 mm"
    assert free_line["is_stocked"] is False


def test_a_catalogue_row_of_another_supplier_is_refused(
    client: TestClient, admin_token: str
) -> None:
    """Two wholesalers reuse numbers freely; a Sonepar row on a Unielektro
    order would confidently order the wrong product."""

    unielektro = _supplier(client, admin_token, "Unielektro")
    sonepar = _supplier(client, admin_token, "Sonepar")
    row_id = _catalog_row(sonepar["id"], article_no="S-1")

    resp = client.post(
        "/api/werkstatt/orders",
        headers=auth_headers(admin_token),
        json={
            "supplier_id": unielektro["id"],
            "lines": [{"catalog_item_id": row_id, "quantity_ordered": 1}],
        },
    )
    assert resp.status_code == 409, resp.text
    assert "anderen Lieferanten" in resp.json()["detail"]

    # Nothing half-created.
    orders = client.get("/api/werkstatt/orders", headers=auth_headers(admin_token)).json()
    assert orders == []


def test_a_catalogue_row_links_a_stocked_article_by_ean(
    client: TestClient, admin_token: str
) -> None:
    """A catalogue pick for something we stock moves stock on delivery."""

    supplier = _supplier(client, admin_token)
    article = _article(client, admin_token, "NYY-J 5x6", ean="4011234567890")
    row_id = _catalog_row(supplier["id"], article_no="11102138", ean="4011234567890")

    order = _order(client, admin_token, supplier["id"])
    updated = _add_line(client, admin_token, order["id"], catalog_item_id=row_id, quantity_ordered=5)
    line = updated["lines"][0]
    assert line["article_id"] == article["id"]
    assert line["is_stocked"] is True
    assert line["supplier_article_no"] == "11102138"


def test_a_free_line_without_any_identity_is_refused(
    client: TestClient, admin_token: str
) -> None:
    supplier = _supplier(client, admin_token)
    resp = client.post(
        "/api/werkstatt/orders",
        headers=auth_headers(admin_token),
        json={"supplier_id": supplier["id"], "lines": [{"quantity_ordered": 1}]},
    )
    assert resp.status_code == 400, resp.text


# ──────────────────────────────────────────────────────────────────────────
# Pre-send resolution
# ──────────────────────────────────────────────────────────────────────────


def test_the_resolution_endpoint_reads_without_writing(
    client: TestClient, admin_token: str
) -> None:
    """The drawer calls this on every open. A read that wrote a link would
    make "look at the order" indistinguishable from "submit it" in the data."""

    from app.core.db import SessionLocal
    from app.models.entities import WerkstattArticleSupplier, WerkstattOrderLine

    supplier = _supplier(client, admin_token)
    _catalog_row(supplier["id"], article_no="11102138", ean="4011234567890")
    article = _article(client, admin_token, "NYY-J 5x6", ean="4011234567890")
    unknown = _article(client, admin_token, "Unbekannte Klemme", ean="4099999999999")
    order = _order(client, admin_token, supplier["id"])
    _add_line(client, admin_token, order["id"], article_id=article["id"])
    _add_line(client, admin_token, order["id"], article_id=unknown["id"])

    resolution = _resolution(client, admin_token, order["id"])
    assert resolution["identifier"] == "supplier_no"
    assert resolution["channel"] == "manual"
    assert resolution["line_count"] == 2
    assert resolution["ready_count"] == 1
    cable, terminal = resolution["lines"]
    assert cable["is_resolved"] is True
    assert cable["matched_by"] == "catalog_ean"
    assert cable["will_send"] == "11102138"
    assert terminal["is_resolved"] is False
    assert terminal["will_send"] is None
    assert terminal["matched_by"] == "unresolved"

    with SessionLocal() as db:
        assert db.query(WerkstattArticleSupplier).count() == 0, "a read created a link"
        stored = db.query(WerkstattOrderLine).filter_by(article_id=article["id"]).one()
        assert stored.supplier_article_no is None, "a read wrote a snapshot"


def test_the_resolution_endpoint_lists_catalogue_alternatives(
    client: TestClient, admin_token: str
) -> None:
    """Pack sizes hide behind several rows for one EAN. The buyer needs to
    see the others, not just a count."""

    supplier = _supplier(client, admin_token)
    _catalog_row(supplier["id"], article_no="11102138", ean="4011234567890", name="NYY-J 5x6 Ring 50m")
    _catalog_row(supplier["id"], article_no="11102139", ean="4011234567890", name="NYY-J 5x6 Trommel")
    order = _order(client, admin_token, supplier["id"])
    _add_line(client, admin_token, order["id"], description="NYY-J", ean="4011234567890")

    line = _resolution(client, admin_token, order["id"])["lines"][0]
    assert line["ambiguous_alternatives"] == 1
    assert [alt["article_no"] for alt in line["alternatives"]] == ["11102139"]
    assert line["alternatives"][0]["item_name"] == "NYY-J 5x6 Trommel"


def test_in_ean_mode_a_line_without_an_ean_counts_as_unresolved(
    client: TestClient, admin_token: str
) -> None:
    supplier = _supplier(client, admin_token, order_identifier="ean")
    order = _order(client, admin_token, supplier["id"])
    _add_line(client, admin_token, order["id"], description="Ohne EAN", supplier_article_no="X-1")

    resolution = _resolution(client, admin_token, order["id"])
    assert resolution["identifier"] == "ean"
    assert resolution["ready_count"] == 0
    assert resolution["lines"][0]["is_resolved"] is False


# ──────────────────────────────────────────────────────────────────────────
# Submitting to the shop
# ──────────────────────────────────────────────────────────────────────────


def test_submit_is_refused_while_a_line_has_no_supplier_number(
    client: TestClient, admin_token: str
) -> None:
    """The silent short basket becomes a 409 the buyer has to click through.
    Nothing is stamped: the numbers did not leave the building."""

    supplier = _supplier(client, admin_token)
    _connection(client, admin_token, supplier["id"])
    _catalog_row(supplier["id"], article_no="11102138", ean="4011234567890")
    order = _order(client, admin_token, supplier["id"])
    _add_line(client, admin_token, order["id"], description="NYY-J 5x6", ean="4011234567890")
    unknown = _article(client, admin_token, "Unbekannte Klemme", ean="4099999999999")
    _add_line(client, admin_token, order["id"], article_id=unknown["id"])

    resp = client.post(
        f"/api/werkstatt/ids/submit?order_id={order['id']}", headers=auth_headers(admin_token)
    )
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert detail["message"] == "1 Position ohne Lieferanten-Artikelnummer"
    assert detail["code"] == "unresolved_lines"
    assert len(detail["warnings"]) == 1
    assert "Unbekannte Klemme" in detail["warnings"][0]
    assert detail["unresolved_positions"] == [2]

    reread = client.get(f"/api/werkstatt/orders/{order['id']}", headers=auth_headers(admin_token))
    assert reread.json()["submitted_at"] is None


def test_submit_can_be_forced_past_unresolved_lines(
    client: TestClient, admin_token: str
) -> None:
    """'Trotzdem übergeben' — today's behaviour, now opt-in."""

    supplier = _supplier(client, admin_token)
    _connection(client, admin_token, supplier["id"])
    _catalog_row(supplier["id"], article_no="11102138", ean="4011234567890")
    order = _order(client, admin_token, supplier["id"])
    _add_line(client, admin_token, order["id"], description="NYY-J 5x6", ean="4011234567890")
    _add_line(client, admin_token, order["id"], description="Unbekannt", ean="4099999999999")

    resp = client.post(
        f"/api/werkstatt/ids/submit?order_id={order['id']}&allow_unresolved=true",
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 200, resp.text
    assert len(resp.json()["warnings"]) == 1
    reread = client.get(f"/api/werkstatt/orders/{order['id']}", headers=auth_headers(admin_token))
    assert reread.json()["submitted_at"] is not None


def test_submit_validates_the_submit_field_map(client: TestClient, admin_token: str) -> None:
    """A WKS map without {cart_xml} hands the shop an empty basket and errors
    nowhere. /start checks its map at the moment of use; /submit now does too."""

    supplier = _supplier(client, admin_token)
    _connection(
        client,
        admin_token,
        supplier["id"],
        submit_field_map={"action": "WKS", "name_kunde": "{username}", "pw_kunde": "{password}"},
    )
    _catalog_row(supplier["id"], article_no="11102138", ean="4011234567890")
    order = _order(client, admin_token, supplier["id"])
    _add_line(client, admin_token, order["id"], description="NYY-J 5x6", ean="4011234567890")

    resp = client.post(
        f"/api/werkstatt/ids/submit?order_id={order['id']}", headers=auth_headers(admin_token)
    )
    assert resp.status_code == 409, resp.text
    assert "cart_xml" in resp.json()["detail"]


def test_the_handoff_cart_honours_the_suppliers_identifier(
    client: TestClient, admin_token: str
) -> None:
    """End to end over the two calls the browser makes: a supplier switched to
    `both` gets the EAN element back; the default does not carry it."""

    import html as html_module

    supplier = _supplier(client, admin_token, order_identifier="both")
    _connection(client, admin_token, supplier["id"])
    _catalog_row(supplier["id"], article_no="11102138", ean="4011234567890")
    order = _order(client, admin_token, supplier["id"])
    _add_line(client, admin_token, order["id"], description="NYY-J 5x6", ean="4011234567890")

    submitted = client.post(
        f"/api/werkstatt/ids/submit?order_id={order['id']}", headers=auth_headers(admin_token)
    )
    assert submitted.status_code == 200, submitted.text
    page = client.get(submitted.json()["handoff_url"])
    cart = html_module.unescape(page.text)
    assert "<EAN>4011234567890</EAN>" in cart
    assert "<ArtNo>11102138</ArtNo>" in cart


# ──────────────────────────────────────────────────────────────────────────
# Supplier settings
# ──────────────────────────────────────────────────────────────────────────


def test_supplier_identifier_and_channel_round_trip(client: TestClient, admin_token: str) -> None:
    created = _supplier(client, admin_token, "Sonepar", order_identifier="both", order_channel="ids")
    assert created["order_identifier"] == "both"
    assert created["order_channel"] == "ids"

    default = _supplier(client, admin_token, "Rexel")
    assert default["order_identifier"] == "supplier_no"
    assert default["order_channel"] == "manual"

    patched = client.patch(
        f"/api/werkstatt/suppliers/{created['id']}",
        headers=auth_headers(admin_token),
        json={"order_identifier": "supplier_no_or_ean"},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["order_identifier"] == "supplier_no_or_ean"
    assert patched.json()["order_channel"] == "ids", "an unrelated patch must not reset the channel"

    listed = client.get("/api/werkstatt/suppliers", headers=auth_headers(admin_token)).json()
    by_name = {row["name"]: row for row in listed}
    assert by_name["Sonepar"]["order_identifier"] == "supplier_no_or_ean"


def test_an_unknown_identifier_is_rejected(client: TestClient, admin_token: str) -> None:
    resp = client.post(
        "/api/werkstatt/suppliers",
        headers=auth_headers(admin_token),
        json={"name": "Falsch", "order_identifier": "gtin"},
    )
    assert resp.status_code == 422, resp.text


# ──────────────────────────────────────────────────────────────────────────
# Reorder goes through the same gate
# ──────────────────────────────────────────────────────────────────────────


def test_reorder_blocks_on_an_unresolved_line_and_can_be_forced(
    client: TestClient, admin_token: str
) -> None:
    """The reorder endpoint auto-sends. Before, that bypassed every check and
    shipped an order whose lines the supplier could not identify."""

    supplier = _supplier(client, admin_token)
    article = _article(client, admin_token, "Hammer")
    _link(client, admin_token, article["id"], supplier["id"], typical_price_cents=250)

    refused = client.post(
        "/api/werkstatt/reorder/submit",
        headers=auth_headers(admin_token),
        json={"supplier_id": supplier["id"], "lines": [{"article_id": article["id"], "quantity": 2}]},
    )
    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"]["code"] == "unresolved_lines"
    assert client.get("/api/werkstatt/orders", headers=auth_headers(admin_token)).json() == []

    forced = client.post(
        "/api/werkstatt/reorder/submit",
        headers=auth_headers(admin_token),
        json={
            "supplier_id": supplier["id"],
            "lines": [{"article_id": article["id"], "quantity": 2}],
            "allow_unresolved": True,
        },
    )
    assert forced.status_code == 200, forced.text
    assert forced.json()["status"] == "sent"
    assert forced.json()["source"] == "reorder"
    assert forced.json()["lines"][0]["unit_price_cents"] == 250


# ──────────────────────────────────────────────────────────────────────────
# supplier_no_or_ean — a fallback is not a missing number
# ──────────────────────────────────────────────────────────────────────────


def _fallback_order(client: TestClient, token: str, **supplier_extra) -> tuple[dict, dict]:
    """One line that resolves through its link, one that only has a GTIN."""

    supplier = _supplier(client, token, order_identifier="supplier_no_or_ean", **supplier_extra)
    article = _article(client, token, "FI 40A")
    _link(client, token, article["id"], supplier["id"], supplier_article_no="01004771")
    order = _order(client, token, supplier["id"])
    _add_line(client, token, order["id"], article_id=article["id"])
    _add_line(client, token, order["id"], description="Unbekannt", ean="4099999999999")
    return supplier, order


FALLBACK_NOTE = "Position 2 (Unbekannt) wird mit EAN statt Artikelnummer übergeben"


def test_the_fallback_line_is_warned_about_as_a_fallback_not_as_missing(
    client: TestClient, admin_token: str
) -> None:
    """Under `supplier_no_or_ean` position 2 travels as its GTIN. Every list
    the buyer reads — the preview, the submit response — must say exactly
    that, once, and must not also claim the position cannot be handed over:
    that sentence had buyers deleting a line the cart carried."""

    supplier, order = _fallback_order(client, admin_token)
    _connection(client, admin_token, supplier["id"])

    resolution = _resolution(client, admin_token, order["id"])
    assert resolution["ready_count"] == 2
    assert resolution["lines"][1]["is_resolved"] is True
    assert resolution["lines"][1]["will_send"] == "4099999999999"
    assert resolution["lines"][1]["warning"] == FALLBACK_NOTE
    assert resolution["warnings"] == [FALLBACK_NOTE]

    submitted = client.post(
        f"/api/werkstatt/ids/submit?order_id={order['id']}", headers=auth_headers(admin_token)
    )
    assert submitted.status_code == 200, submitted.text
    assert submitted.json()["warnings"] == [FALLBACK_NOTE]


def test_a_shop_supplier_is_told_about_the_shop(client: TestClient, admin_token: str) -> None:
    supplier = _supplier(client, admin_token, order_channel="ids")
    order = _order(client, admin_token, supplier["id"])
    _add_line(client, admin_token, order["id"], description="Ohne alles")
    line = _resolution(client, admin_token, order["id"])["lines"][0]
    assert line["warning"].endswith("kann nicht an den Shop übergeben werden")
