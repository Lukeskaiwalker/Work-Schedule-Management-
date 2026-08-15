"""Wholesaler punchout (IDS-Connect) and order composition.

Weighted towards the failures that are silent rather than loud:

  * a cart line that resolves to a stocked article vs. one that does not —
    the difference decides whether delivery moves stock, and both look
    identical in the API response;
  * quantity and price arithmetic on German-formatted numbers, where a wrong
    answer is still a plausible-looking number;
  * the punchout token lifecycle, where a missing check means a replayable
    URL rather than a visible error;
  * templates leaking into the buyer's order list, which nothing else would
    catch until the list was full of them.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
import xml.etree.ElementTree as ET

from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.services.ids_cart_parser import CartParseError, decode_payload, parse_cart


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# openTRANS-flavoured cart with the two awkward cases: a fractional quantity
# and a line that prices only its total.
CART_XML = """<?xml version="1.0" encoding="UTF-8"?>
<IDS VERSION="2.5">
  <ORDER><ORDER_HEADER><ORDER_INFO><ORDER_ID>WK-42</ORDER_ID></ORDER_INFO></ORDER_HEADER>
  <ORDER_ITEM_LIST>
    <ORDER_ITEM>
      <ARTICLE_ID><SUPPLIER_AID>UE-1000</SUPPLIER_AID>
        <INTERNATIONAL_AID>4011234567890</INTERNATIONAL_AID>
        <DESCRIPTION_SHORT>NYM-J 3x1,5</DESCRIPTION_SHORT>
        <MANUFACTURER_NAME>Lapp</MANUFACTURER_NAME></ARTICLE_ID>
      <QUANTITY>100</QUANTITY><ORDER_UNIT>MTR</ORDER_UNIT>
      <ARTICLE_PRICE><PRICE_AMOUNT>1,19</PRICE_AMOUNT>
        <PRICE_CURRENCY>EUR</PRICE_CURRENCY></ARTICLE_PRICE>
    </ORDER_ITEM>
    <ORDER_ITEM>
      <ARTICLE_ID><SUPPLIER_AID>UE-2000</SUPPLIER_AID>
        <DESCRIPTION_SHORT>Reihenklemme</DESCRIPTION_SHORT></ARTICLE_ID>
      <QUANTITY>2,5</QUANTITY><ORDER_UNIT>PAK</ORDER_UNIT>
      <ARTICLE_PRICE><PRICE_LINE_AMOUNT>31,25</PRICE_LINE_AMOUNT></ARTICLE_PRICE>
    </ORDER_ITEM>
  </ORDER_ITEM_LIST></ORDER>
</IDS>"""


def _supplier(client: TestClient, token: str, name: str = "Unielektro") -> dict:
    resp = client.post(
        "/api/werkstatt/suppliers", headers=auth_headers(token), json={"name": name}
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


def _import_cart(client: TestClient, token: str, supplier_id: int, xml: str = CART_XML, **extra):
    return client.post(
        "/api/werkstatt/ids/import",
        headers=auth_headers(token),
        json={"supplier_id": supplier_id, "xml": xml, **extra},
    )


# ──────────────────────────────────────────────────────────────────────────
# Parser
# ──────────────────────────────────────────────────────────────────────────


def test_a_line_total_is_divided_by_the_quantity_the_shop_priced() -> None:
    """31,25 EUR for 2,5 packs is 12,50 a pack — not 10,42.

    The quantity is rounded up to 3 for storage, and dividing the total by the
    rounded value would invent a unit price that under-states the order by a
    third while still looking like a normal number.
    """

    cart = parse_cart(CART_XML)
    cable, terminals = cart.lines

    assert cable.quantity == 100
    assert cable.unit_price_cents == 119

    assert terminals.quantity == 3, "2,5 rounds up — a short order means a second trip"
    assert terminals.unit_price_cents == 1250
    assert any("aufgerundet" in warning for warning in terminals.warnings)


def test_german_element_names_and_a_flat_structure_parse_too() -> None:
    """The alias table is the whole point — one shop's ARTIKELNUMMER is
    another's SUPPLIER_AID, and neither may be rejected."""

    cart = parse_cart(
        """<?xml version="1.0" encoding="UTF-8"?>
        <WARENKORB><WARENKORBID>ABC-9</WARENKORBID>
          <POSITION><ARTIKELNUMMER>A-1</ARTIKELNUMMER>
            <BEZEICHNUNG>Schuko</BEZEICHNUNG><MENGE>4</MENGE>
            <EINZELPREIS>2,45</EINZELPREIS></POSITION>
        </WARENKORB>"""
    )
    assert cart.external_reference == "ABC-9"
    assert cart.lines[0].supplier_article_no == "A-1"
    assert cart.lines[0].quantity == 4
    assert cart.lines[0].unit_price_cents == 245


def test_iso_8859_1_umlauts_survive_the_decode() -> None:
    """Wrong charset handling turns "Möller" into "MÃ¶ller" in the order the
    buyer reads, and the XML declaration is the authority on its own bytes."""

    raw = (
        '<?xml version="1.0" encoding="ISO-8859-1"?><IDS><ITEM>'
        "<SUPPLIER_AID>X</SUPPLIER_AID><DESCRIPTION_SHORT>M\xf6ller</DESCRIPTION_SHORT>"
        "<QUANTITY>1</QUANTITY></ITEM></IDS>"
    ).encode("iso-8859-1")
    cart = parse_cart(decode_payload(raw, declared_charset="UTF-8"))
    assert cart.lines[0].description == "Möller"


def test_a_doctype_is_refused_before_parsing() -> None:
    """Entity-expansion blowups need a DTD internal subset; with no DOCTYPE
    there is nothing left to expand."""

    with pytest.raises(CartParseError, match="DOCTYPE"):
        parse_cart('<!DOCTYPE x [<!ENTITY a "aa">]><IDS><ITEM>&a;</ITEM></IDS>')


def test_a_doctype_hidden_behind_padding_is_still_refused() -> None:
    """The scan covers the whole document — a fixed-size prolog window could
    be walked past with megabytes of leading comments."""

    padded = "<!-- " + ("x" * 5000) + " -->\n<!DOCTYPE a><IDS/>"
    with pytest.raises(CartParseError, match="DOCTYPE"):
        parse_cart(padded)


# ──────────────────────────────────────────────────────────────────────────
# Import
# ──────────────────────────────────────────────────────────────────────────


def test_importing_a_cart_creates_a_draft_order_with_free_lines(
    client: TestClient, admin_token: str
) -> None:
    supplier = _supplier(client, admin_token)
    resp = _import_cart(client, admin_token, supplier["id"])
    assert resp.status_code == 200, resp.text
    result = resp.json()
    assert result["line_count"] == 2

    order = client.get(
        f"/api/werkstatt/orders/{result['order_id']}", headers=auth_headers(admin_token)
    ).json()
    assert order["status"] == "draft"
    assert order["source"] == "ids"
    assert order["external_reference"] == "WK-42"
    # Nothing in this cart exists in our catalogue, so every line is free.
    assert [line["is_stocked"] for line in order["lines"]] == [False, False]
    # A free line still renders with a name — the projection falls back to the
    # supplier's description rather than leaving a blank row.
    assert order["lines"][0]["article_name"] == "NYM-J 3x1,5"
    assert order["lines"][0]["supplier_article_no"] == "UE-1000"


def test_a_cart_line_matching_a_stocked_article_is_linked_to_it(
    client: TestClient, admin_token: str
) -> None:
    """This is the difference between an order that moves stock on delivery
    and one that does not, and it is invisible in the cart itself."""

    supplier = _supplier(client, admin_token)
    article = _article(client, admin_token, "Mantelleitung", ean="4011234567890")

    resp = _import_cart(client, admin_token, supplier["id"])
    order = client.get(
        f"/api/werkstatt/orders/{resp.json()['order_id']}", headers=auth_headers(admin_token)
    ).json()

    cable = order["lines"][0]
    assert cable["is_stocked"] is True
    assert cable["article_id"] == article["id"]
    # The stocked name wins over the supplier's description for display.
    assert cable["article_name"] == "Mantelleitung"
    # ...but the snapshot of what the supplier called it is still kept.
    assert cable["description"] == "NYM-J 3x1,5"


def test_a_second_trip_appends_to_the_same_order(client: TestClient, admin_token: str) -> None:
    supplier = _supplier(client, admin_token)
    first = _import_cart(client, admin_token, supplier["id"]).json()

    second = _import_cart(client, admin_token, supplier["id"], order_id=first["order_id"])
    assert second.status_code == 200, second.text
    assert second.json()["order_id"] == first["order_id"]

    order = client.get(
        f"/api/werkstatt/orders/{first['order_id']}", headers=auth_headers(admin_token)
    ).json()
    assert len(order["lines"]) == 4, "appended, not replaced"


def test_an_unparseable_cart_still_keeps_the_raw_payload(
    client: TestClient, admin_token: str
) -> None:
    """The user has already done the shopping. Losing the bytes because our
    parser guessed the dialect wrong is the most expensive failure here."""

    supplier = _supplier(client, admin_token)
    resp = _import_cart(client, admin_token, supplier["id"], xml="this is not xml")
    assert resp.status_code == 400

    imports = client.get(
        "/api/werkstatt/ids/imports", headers=auth_headers(admin_token)
    ).json()
    assert imports[0]["status"] == "failed"
    assert imports[0]["error_message"]


# ──────────────────────────────────────────────────────────────────────────
# Composition
# ──────────────────────────────────────────────────────────────────────────


def test_a_free_line_can_be_added_by_hand(client: TestClient, admin_token: str) -> None:
    supplier = _supplier(client, admin_token)
    order = client.post(
        "/api/werkstatt/orders",
        headers=auth_headers(admin_token),
        json={"supplier_id": supplier["id"], "title": "Baustelle Müller"},
    ).json()

    resp = client.post(
        f"/api/werkstatt/orders/{order['id']}/lines",
        headers=auth_headers(admin_token),
        json={"description": "Kabelbinder 200mm", "quantity_ordered": 5, "unit_price_cents": 300},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["lines"][0]["is_stocked"] is False
    assert resp.json()["total_amount_cents"] == 1500


def test_a_line_with_neither_article_nor_description_is_refused(
    client: TestClient, admin_token: str
) -> None:
    """Otherwise the order grows a row nobody can act on."""

    supplier = _supplier(client, admin_token)
    order = client.post(
        "/api/werkstatt/orders", headers=auth_headers(admin_token), json={"supplier_id": supplier["id"]}
    ).json()
    resp = client.post(
        f"/api/werkstatt/orders/{order['id']}/lines",
        headers=auth_headers(admin_token),
        json={"quantity_ordered": 1},
    )
    assert resp.status_code == 400


def test_a_free_line_can_be_promoted_to_a_stocked_one(
    client: TestClient, admin_token: str
) -> None:
    supplier = _supplier(client, admin_token)
    article = _article(client, admin_token, "Kabelbinder")
    order = client.post(
        "/api/werkstatt/orders", headers=auth_headers(admin_token), json={"supplier_id": supplier["id"]}
    ).json()
    with_line = client.post(
        f"/api/werkstatt/orders/{order['id']}/lines",
        headers=auth_headers(admin_token),
        json={"description": "Kabelbinder 200mm", "quantity_ordered": 5},
    ).json()
    line_id = with_line["lines"][0]["id"]

    resp = client.patch(
        f"/api/werkstatt/orders/{order['id']}/lines/{line_id}",
        headers=auth_headers(admin_token),
        json={"article_id": article["id"]},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["lines"][0]["is_stocked"] is True


def test_a_sent_order_can_no_longer_be_edited(client: TestClient, admin_token: str) -> None:
    """A sent order is a statement about what the wholesaler was asked for."""

    supplier = _supplier(client, admin_token)
    order = client.post(
        "/api/werkstatt/orders", headers=auth_headers(admin_token), json={"supplier_id": supplier["id"]}
    ).json()
    client.post(
        f"/api/werkstatt/orders/{order['id']}/mark-sent", headers=auth_headers(admin_token)
    )
    resp = client.post(
        f"/api/werkstatt/orders/{order['id']}/lines",
        headers=auth_headers(admin_token),
        json={"description": "zu spät", "quantity_ordered": 1},
    )
    assert resp.status_code == 409


# ──────────────────────────────────────────────────────────────────────────
# Merge
# ──────────────────────────────────────────────────────────────────────────


def test_merging_sums_identical_lines_and_retires_the_source(
    client: TestClient, admin_token: str
) -> None:
    supplier = _supplier(client, admin_token)
    target = _import_cart(client, admin_token, supplier["id"]).json()
    source = _import_cart(client, admin_token, supplier["id"]).json()

    resp = client.post(
        f"/api/werkstatt/orders/{target['order_id']}/merge",
        headers=auth_headers(admin_token),
        json={"source_order_id": source["order_id"]},
    )
    assert resp.status_code == 200, resp.text
    merged = resp.json()

    # Same two articles at the same prices, so the quantities add rather than
    # the order growing to four lines.
    assert len(merged["lines"]) == 2
    assert merged["lines"][0]["quantity_ordered"] == 200

    # The source survives for the audit trail...
    retired = client.get(
        f"/api/werkstatt/orders/{source['order_id']}", headers=auth_headers(admin_token)
    ).json()
    assert retired["status"] == "cancelled"
    assert retired["merged_into_order_id"] == target["order_id"]

    # ...but is out of the working list, or the material would be counted twice.
    listed = client.get("/api/werkstatt/orders", headers=auth_headers(admin_token)).json()
    assert [o["id"] for o in listed] == [target["order_id"]]


def test_merging_can_keep_lines_separate(client: TestClient, admin_token: str) -> None:
    """Two orders for two different jobs keep their split."""

    supplier = _supplier(client, admin_token)
    target = _import_cart(client, admin_token, supplier["id"]).json()
    source = _import_cart(client, admin_token, supplier["id"]).json()

    merged = client.post(
        f"/api/werkstatt/orders/{target['order_id']}/merge",
        headers=auth_headers(admin_token),
        json={"source_order_id": source["order_id"], "combine_duplicates": False},
    ).json()
    assert len(merged["lines"]) == 4


def test_a_priceless_template_line_merges_into_a_priced_one(
    client: TestClient, admin_token: str
) -> None:
    """Templates carry no prices on purpose, so merging one into a real cart
    would otherwise duplicate every article for no reason. "We don't know the
    price" is not a disagreement with a known one."""

    supplier = _supplier(client, admin_token)
    cart = _import_cart(client, admin_token, supplier["id"]).json()
    template = client.post(
        f"/api/werkstatt/orders/{cart['order_id']}/save-as-template",
        headers=auth_headers(admin_token),
        json={"name": "Standard"},
    ).json()
    from_template = client.post(
        "/api/werkstatt/orders/from-template",
        headers=auth_headers(admin_token),
        json={"template_id": template["id"]},
    ).json()
    assert all(line["unit_price_cents"] is None for line in from_template["lines"])

    merged = client.post(
        f"/api/werkstatt/orders/{cart['order_id']}/merge",
        headers=auth_headers(admin_token),
        json={"source_order_id": from_template["id"]},
    ).json()

    assert len(merged["lines"]) == 2, "combined, not duplicated"
    assert merged["lines"][0]["quantity_ordered"] == 200
    # The known price survives — it is not overwritten with the template's null.
    assert merged["lines"][0]["unit_price_cents"] == 119


def test_two_different_prices_for_one_article_stay_apart(
    client: TestClient, admin_token: str
) -> None:
    """The guard for the rule above: an ACTUAL price difference is either a
    price change or a mistake, and summing it away would hide both."""

    supplier = _supplier(client, admin_token)
    first = client.post(
        "/api/werkstatt/orders",
        headers=auth_headers(admin_token),
        json={"supplier_id": supplier["id"]},
    ).json()
    second = client.post(
        "/api/werkstatt/orders",
        headers=auth_headers(admin_token),
        json={"supplier_id": supplier["id"]},
    ).json()
    for order, price in ((first, 500), (second, 650)):
        client.post(
            f"/api/werkstatt/orders/{order['id']}/lines",
            headers=auth_headers(admin_token),
            json={
                "supplier_article_no": "UE-1",
                "description": "Klemme",
                "quantity_ordered": 10,
                "unit_price_cents": price,
            },
        )

    merged = client.post(
        f"/api/werkstatt/orders/{first['id']}/merge",
        headers=auth_headers(admin_token),
        json={"source_order_id": second["id"]},
    ).json()
    assert len(merged["lines"]) == 2
    assert sorted(line["unit_price_cents"] for line in merged["lines"]) == [500, 650]


def test_orders_for_different_suppliers_do_not_merge(
    client: TestClient, admin_token: str
) -> None:
    """A merged order addressed to two wholesalers cannot be sent to either."""

    one = _supplier(client, admin_token, "Unielektro")
    two = _supplier(client, admin_token, "Sonepar")
    target = _import_cart(client, admin_token, one["id"]).json()
    source = _import_cart(client, admin_token, two["id"]).json()

    resp = client.post(
        f"/api/werkstatt/orders/{target['order_id']}/merge",
        headers=auth_headers(admin_token),
        json={"source_order_id": source["order_id"]},
    )
    assert resp.status_code == 409


# ──────────────────────────────────────────────────────────────────────────
# Templates
# ──────────────────────────────────────────────────────────────────────────


def test_a_template_stays_out_of_the_order_list_and_its_number_series(
    client: TestClient, admin_token: str
) -> None:
    """A template in the buyer's list looks like work to do forever, and a
    template consuming a BST number leaves a gap that reads as a deletion."""

    supplier = _supplier(client, admin_token)
    order = _import_cart(client, admin_token, supplier["id"]).json()

    template = client.post(
        f"/api/werkstatt/orders/{order['order_id']}/save-as-template",
        headers=auth_headers(admin_token),
        json={"name": "Zählerschrank Standard"},
    )
    assert template.status_code == 200, template.text
    assert template.json()["order_number"].startswith("VRL-")
    assert template.json()["is_template"] is True

    listed = client.get("/api/werkstatt/orders", headers=auth_headers(admin_token)).json()
    assert [o["id"] for o in listed] == [order["order_id"]]

    templates = client.get(
        "/api/werkstatt/order-templates", headers=auth_headers(admin_token)
    ).json()
    assert [t["template_name"] for t in templates] == ["Zählerschrank Standard"]

    # The next real order still gets the next BST number, ungapped.
    following = client.post(
        "/api/werkstatt/orders", headers=auth_headers(admin_token), json={"supplier_id": supplier["id"]}
    ).json()
    assert following["order_number"].endswith("-0002")


def test_saving_a_template_leaves_the_original_order_alone(
    client: TestClient, admin_token: str
) -> None:
    supplier = _supplier(client, admin_token)
    order = _import_cart(client, admin_token, supplier["id"]).json()
    client.post(
        f"/api/werkstatt/orders/{order['order_id']}/save-as-template",
        headers=auth_headers(admin_token),
        json={"name": "Standard"},
    )
    still_there = client.get(
        f"/api/werkstatt/orders/{order['order_id']}", headers=auth_headers(admin_token)
    ).json()
    assert still_there["is_template"] is False
    assert len(still_there["lines"]) == 2


def test_a_template_carries_no_prices(client: TestClient, admin_token: str) -> None:
    """Wholesale prices do not survive the months a template does, and a stale
    one applied silently is worse than none because it looks authoritative."""

    supplier = _supplier(client, admin_token)
    order = _import_cart(client, admin_token, supplier["id"]).json()
    template = client.post(
        f"/api/werkstatt/orders/{order['order_id']}/save-as-template",
        headers=auth_headers(admin_token),
        json={"name": "Standard"},
    ).json()
    assert all(line["unit_price_cents"] is None for line in template["lines"])


def test_a_template_can_start_a_new_order_and_be_applied_again(
    client: TestClient, admin_token: str
) -> None:
    """Templates compose: a standard kit plus a second kit plus job extras."""

    supplier = _supplier(client, admin_token)
    seed = _import_cart(client, admin_token, supplier["id"]).json()
    template = client.post(
        f"/api/werkstatt/orders/{seed['order_id']}/save-as-template",
        headers=auth_headers(admin_token),
        json={"name": "Standard"},
    ).json()

    created = client.post(
        "/api/werkstatt/orders/from-template",
        headers=auth_headers(admin_token),
        json={"template_id": template["id"], "title": "Neubau Weber"},
    )
    assert created.status_code == 200, created.text
    assert created.json()["source"] == "template"
    assert len(created.json()["lines"]) == 2

    again = client.post(
        f"/api/werkstatt/orders/{created.json()['id']}/apply-template",
        headers=auth_headers(admin_token),
        json={"template_id": template["id"]},
    )
    assert again.status_code == 200, again.text
    assert len(again.json()["lines"]) == 4


def test_a_template_refreshes_prices_from_the_current_supplier_link(
    client: TestClient, admin_token: str
) -> None:
    supplier = _supplier(client, admin_token)
    article = _article(client, admin_token, "Mantelleitung", ean="4011234567890")
    link = client.post(
        f"/api/werkstatt/articles/{article['id']}/suppliers",
        headers=auth_headers(admin_token),
        json={"supplier_id": supplier["id"], "typical_price_cents": 149},
    )
    assert link.status_code == 200, link.text

    seed = _import_cart(client, admin_token, supplier["id"]).json()
    template = client.post(
        f"/api/werkstatt/orders/{seed['order_id']}/save-as-template",
        headers=auth_headers(admin_token),
        json={"name": "Standard"},
    ).json()

    created = client.post(
        "/api/werkstatt/orders/from-template",
        headers=auth_headers(admin_token),
        json={"template_id": template["id"]},
    ).json()
    stocked = [line for line in created["lines"] if line["is_stocked"]]
    assert stocked and stocked[0]["unit_price_cents"] == 149


# ──────────────────────────────────────────────────────────────────────────
# Delivery of catalog-less lines
# ──────────────────────────────────────────────────────────────────────────


def test_delivering_a_free_line_records_receipt_without_moving_stock(
    client: TestClient, admin_token: str
) -> None:
    """`WerkstattMovement.article_id` is NOT NULL, so a free line reaching the
    delivery path without this branch is a 500 at the worst moment."""

    supplier = _supplier(client, admin_token)
    order = _import_cart(client, admin_token, supplier["id"]).json()

    client.post(
        f"/api/werkstatt/orders/{order['order_id']}/mark-sent", headers=auth_headers(admin_token)
    )
    resp = client.post(
        f"/api/werkstatt/orders/{order['order_id']}/mark-delivered",
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 200, resp.text
    delivered = resp.json()
    assert delivered["status"] == "delivered"
    assert all(line["line_status"] == "complete" for line in delivered["lines"])
    assert all(
        line["quantity_received"] == line["quantity_ordered"] for line in delivered["lines"]
    )


def test_delivering_a_stocked_line_still_moves_stock(
    client: TestClient, admin_token: str
) -> None:
    """The regression guard for the branch above — it must skip free lines
    without also skipping the ones that DO carry stock."""

    supplier = _supplier(client, admin_token)
    article = _article(client, admin_token, "Mantelleitung", ean="4011234567890")
    order = _import_cart(client, admin_token, supplier["id"]).json()

    client.post(
        f"/api/werkstatt/orders/{order['order_id']}/mark-sent", headers=auth_headers(admin_token)
    )
    client.post(
        f"/api/werkstatt/orders/{order['order_id']}/mark-delivered",
        headers=auth_headers(admin_token),
    )

    after = client.get(
        f"/api/werkstatt/articles/{article['id']}", headers=auth_headers(admin_token)
    ).json()
    assert after["stock_total"] == 100


# ──────────────────────────────────────────────────────────────────────────
# Task attachment
# ──────────────────────────────────────────────────────────────────────────


def _task(client: TestClient, token: str) -> dict:
    project = client.post(
        "/api/projects",
        headers=auth_headers(token),
        json={"name": "Neubau Weber", "project_number": "P-001", "customer_name": "Weber"},
    )
    assert project.status_code == 200, project.text
    resp = client.post(
        "/api/tasks",
        headers=auth_headers(token),
        json={"title": "Zählerschrank setzen", "project_id": project.json()["id"]},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_attaching_an_order_to_a_task_inherits_the_project(
    client: TestClient, admin_token: str
) -> None:
    """Otherwise the user has to say the same thing twice, and the project
    roll-up silently misses orders booked only to a job."""

    supplier = _supplier(client, admin_token)
    task = _task(client, admin_token)
    order = _import_cart(client, admin_token, supplier["id"]).json()

    resp = client.patch(
        f"/api/werkstatt/orders/{order['order_id']}/attach",
        headers=auth_headers(admin_token),
        json={"task_id": task["id"]},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["task_id"] == task["id"]
    assert resp.json()["project_id"] == task["project_id"]

    for_task = client.get(
        f"/api/werkstatt/tasks/{task['id']}/orders", headers=auth_headers(admin_token)
    ).json()
    assert [o["id"] for o in for_task] == [order["order_id"]]


def test_renaming_an_order_does_not_detach_it(client: TestClient, admin_token: str) -> None:
    """`exclude_unset` is the only thing separating "not mentioned" from
    "set to null" — without it every rename would silently unlink the job."""

    supplier = _supplier(client, admin_token)
    task = _task(client, admin_token)
    order = _import_cart(client, admin_token, supplier["id"]).json()
    client.patch(
        f"/api/werkstatt/orders/{order['order_id']}/attach",
        headers=auth_headers(admin_token),
        json={"task_id": task["id"]},
    )

    renamed = client.patch(
        f"/api/werkstatt/orders/{order['order_id']}/attach",
        headers=auth_headers(admin_token),
        json={"title": "Material Weber"},
    ).json()
    assert renamed["title"] == "Material Weber"
    assert renamed["task_id"] == task["id"]

    detached = client.patch(
        f"/api/werkstatt/orders/{order['order_id']}/attach",
        headers=auth_headers(admin_token),
        json={"task_id": None},
    ).json()
    assert detached["task_id"] is None


# ──────────────────────────────────────────────────────────────────────────
# Connection + punchout
# ──────────────────────────────────────────────────────────────────────────


def _connection(client: TestClient, token: str, supplier_id: int, **extra) -> dict:
    payload = {
        "supplier_id": supplier_id,
        "is_enabled": True,
        "entry_url": "https://shop.example.com/ids",
        "username": "kunde",
        "password": "geheim",
        "customer_number": "4711",
        **extra,
    }
    resp = client.put(
        "/api/werkstatt/ids/connections", headers=auth_headers(token), json=payload
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_the_shop_password_is_never_returned(client: TestClient, admin_token: str) -> None:
    supplier = _supplier(client, admin_token)
    connection = _connection(client, admin_token, supplier["id"])
    assert connection["has_password"] is True
    assert "password" not in connection
    assert "geheim" not in str(connection)


def test_saving_other_settings_does_not_wipe_the_password(
    client: TestClient, admin_token: str
) -> None:
    """The form submits with the mask still in the field. Treating that as an
    empty password would silently break ordering on the next save."""

    supplier = _supplier(client, admin_token)
    _connection(client, admin_token, supplier["id"])

    resp = client.put(
        "/api/werkstatt/ids/connections",
        headers=auth_headers(admin_token),
        json={
            "supplier_id": supplier["id"],
            "is_enabled": True,
            "entry_url": "https://shop.example.com/ids2",
            "username": "kunde",
            # password omitted entirely
        },
    )
    assert resp.json()["has_password"] is True

    cleared = client.put(
        "/api/werkstatt/ids/connections",
        headers=auth_headers(admin_token),
        json={
            "supplier_id": supplier["id"],
            "entry_url": "https://shop.example.com/ids2",
            "password": "",
        },
    )
    assert cleared.json()["has_password"] is False


def test_the_connection_check_catches_an_unreachable_hook_url(
    client: TestClient, admin_token: str
) -> None:
    """A hook on localhost resolves to the fitter's own laptop, not the
    server, and loses the whole basket at the last step."""

    supplier = _supplier(client, admin_token)
    _connection(client, admin_token, supplier["id"], hook_base_url="http://localhost:8000")

    resp = client.post(
        f"/api/werkstatt/ids/connections/{supplier['id']}/test",
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["ok"] is False
    assert any("localhost" in problem for problem in resp.json()["problems"])
    # The preview shows what would be sent, with the credential masked.
    assert "geheim" not in str(resp.json()["preview_fields"])


def test_a_returned_cart_becomes_an_order_for_the_user_who_went_shopping(
    client: TestClient, admin_token: str
) -> None:
    supplier = _supplier(client, admin_token)
    _connection(client, admin_token, supplier["id"])

    started = client.post(
        "/api/werkstatt/ids/start",
        headers=auth_headers(admin_token),
        json={"supplier_id": supplier["id"]},
    )
    assert started.status_code == 200, started.text
    token = started.json()["token"]

    # The hand-over page carries the credentials and submits itself.
    page = client.get(f"/api/werkstatt/ids/handoff/{token}")
    assert page.status_code == 200
    assert "geheim" in page.text, "the password has to reach the shop somehow"
    assert page.headers["Cache-Control"].startswith("no-store")
    assert page.headers["Referrer-Policy"] == "no-referrer"
    assert "form-action https://shop.example.com" in page.headers["Content-Security-Policy"]

    # The shop POSTs the cart back with no auth of ours — the token is it.
    hook = client.post(f"/api/werkstatt/ids/hook/{token}", data={"IDS_XML": CART_XML})
    assert hook.status_code == 200, hook.text
    assert "übernommen" in hook.text

    orders = client.get("/api/werkstatt/orders", headers=auth_headers(admin_token)).json()
    assert len(orders) == 1
    assert orders[0]["source"] == "ids"
    assert orders[0]["line_count"] == 2


def test_the_handoff_page_is_served_only_once(client: TestClient, admin_token: str) -> None:
    """It holds a live ordering credential; a replayable URL in browser
    history would be a disclosure route."""

    supplier = _supplier(client, admin_token)
    _connection(client, admin_token, supplier["id"])
    token = client.post(
        "/api/werkstatt/ids/start",
        headers=auth_headers(admin_token),
        json={"supplier_id": supplier["id"]},
    ).json()["token"]

    assert client.get(f"/api/werkstatt/ids/handoff/{token}").status_code == 200
    second = client.get(f"/api/werkstatt/ids/handoff/{token}")
    assert second.status_code == 410
    assert "geheim" not in second.text


def test_a_cart_token_cannot_be_replayed(client: TestClient, admin_token: str) -> None:
    """Otherwise one shopping trip could mint unlimited duplicate orders."""

    supplier = _supplier(client, admin_token)
    _connection(client, admin_token, supplier["id"])
    token = client.post(
        "/api/werkstatt/ids/start",
        headers=auth_headers(admin_token),
        json={"supplier_id": supplier["id"]},
    ).json()["token"]

    assert client.post(f"/api/werkstatt/ids/hook/{token}", data={"IDS_XML": CART_XML}).status_code == 200
    replay = client.post(f"/api/werkstatt/ids/hook/{token}", data={"IDS_XML": CART_XML})
    assert replay.status_code == 410

    orders = client.get("/api/werkstatt/orders", headers=auth_headers(admin_token)).json()
    assert len(orders) == 1


def test_an_expired_token_is_refused(client: TestClient, admin_token: str) -> None:
    from app.core.db import SessionLocal
    from app.core.time import utcnow
    from app.models.entities import WerkstattIdsSession

    supplier = _supplier(client, admin_token)
    _connection(client, admin_token, supplier["id"])
    token = client.post(
        "/api/werkstatt/ids/start",
        headers=auth_headers(admin_token),
        json={"supplier_id": supplier["id"]},
    ).json()["token"]

    with SessionLocal() as db:
        session = db.query(WerkstattIdsSession).filter_by(token=token).one()
        session.expires_at = utcnow() - timedelta(minutes=1)
        db.commit()

    resp = client.post(f"/api/werkstatt/ids/hook/{token}", data={"IDS_XML": CART_XML})
    assert resp.status_code == 410
    assert "abgelaufen" in resp.text


def test_an_unknown_token_is_indistinguishable_from_a_spent_one(client: TestClient) -> None:
    """Telling the difference would let an attacker enumerate live sessions."""

    resp = client.post("/api/werkstatt/ids/hook/not-a-real-token", data={"IDS_XML": CART_XML})
    assert resp.status_code == 410
    assert "bereits verwendet" in resp.text


def test_a_cart_in_a_dialect_we_cannot_read_is_kept_not_dropped(
    client: TestClient, admin_token: str
) -> None:
    supplier = _supplier(client, admin_token)
    _connection(client, admin_token, supplier["id"])
    token = client.post(
        "/api/werkstatt/ids/start",
        headers=auth_headers(admin_token),
        json={"supplier_id": supplier["id"]},
    ).json()["token"]

    resp = client.post(f"/api/werkstatt/ids/hook/{token}", data={"IDS_XML": "<<<broken"})
    assert resp.status_code == 200
    assert "nicht gelesen werden" in resp.text

    imports = client.get("/api/werkstatt/ids/imports", headers=auth_headers(admin_token)).json()
    assert imports[0]["status"] == "failed"


def test_shopping_needs_an_enabled_connection(client: TestClient, admin_token: str) -> None:
    """A disabled connection must not drop the user on a login page with
    empty credentials."""

    supplier = _supplier(client, admin_token)
    _connection(client, admin_token, supplier["id"], is_enabled=False)
    resp = client.post(
        "/api/werkstatt/ids/start",
        headers=auth_headers(admin_token),
        json={"supplier_id": supplier["id"]},
    )
    assert resp.status_code == 400


# ──────────────────────────────────────────────────────────────────────────
# The wire protocol itself
#
# These pin the values the wholesaler actually reads. They exist because the
# punchout has now shipped TWO generations of wrong field names, and both
# failed silently — a shop ignores a field it does not recognise rather than
# rejecting it, so every call kept "succeeding" while carrying nothing usable.
#
#   1. Invented English names (USERNAME, PASSWORD, HOOK_URL). Unielektro
#      answered "Aktion 'WWWSHOP' ist nicht gültig", which reads like one wrong
#      value in an otherwise correct call. In fact every field was wrong.
#   2. The spec's German LABELS, lower-cased (benutzername, passwort,
#      kundennummer, hook_url). These look authoritative and are not what goes
#      on the wire. The IDS parameter table has two name columns and only the
#      second, headed "HTTP Parameter", is transmitted:
#
#          Kundennummer -> kndnr        Benutzername -> name_kunde
#          Passwort     -> pw_kunde     HOOK-URL     -> hookurl
#          Target       -> target
#
# The hook is the one that hurt: with `hook_url` the shop registers no return
# address and renders its transmit form with action="/ids/debug", which is the
# raw-XML page the crew kept landing on. With `hookurl` the same form points at
# our hook. Measured directly against www.unielektro.de, and corroborated by
# the spec plus four independent IDS implementations.
# ──────────────────────────────────────────────────────────────────────────


def test_the_fetch_call_uses_the_real_ids_action_and_field_names() -> None:
    from app.services.ids_connect import DEFAULT_FETCH_FIELD_MAP

    # WKE = Warenkorbübernahme, named from OUR point of view: the cart comes
    # from the shop into us. Getting this backwards is the easy mistake.
    assert DEFAULT_FETCH_FIELD_MAP["action"] == "WKE"
    assert DEFAULT_FETCH_FIELD_MAP["name_kunde"] == "{username}"
    assert DEFAULT_FETCH_FIELD_MAP["pw_kunde"] == "{password}"
    assert DEFAULT_FETCH_FIELD_MAP["kndnr"] == "{customer_number}"
    assert DEFAULT_FETCH_FIELD_MAP["hookurl"] == "{hook_url}"
    assert DEFAULT_FETCH_FIELD_MAP["target"] == "_top"
    # Both earlier generations of wrong names must be gone. `hook_url` in
    # particular is the difference between the cart coming home and the crew
    # staring at XML on the wholesaler's debug page.
    for rejected in (
        "USERNAME", "PASSWORD", "ACTION", "HOOK_URL", "TARGET",
        "benutzername", "passwort", "kundennummer", "hook_url", "returntarget",
    ):
        assert rejected not in DEFAULT_FETCH_FIELD_MAP


def test_the_submit_call_carries_the_cart_in_warenkorb() -> None:
    from app.services.ids_connect import DEFAULT_SUBMIT_FIELD_MAP

    # WKS = Warenkorbübergabe — the opposite direction to WKE.
    assert DEFAULT_SUBMIT_FIELD_MAP["action"] == "WKS"
    assert DEFAULT_SUBMIT_FIELD_MAP["warenkorb"] == "{cart_xml}"
    assert "IDS_XML" not in DEFAULT_SUBMIT_FIELD_MAP


def test_a_returned_cart_is_found_in_the_warenkorb_field() -> None:
    """The spec's own name for the payload must be recognised on the way back."""

    from app.services.ids_connect import extract_cart_payload

    payload, field = extract_cart_payload(
        {"warenkorb": "<IDS><ITEM/></IDS>", "other": "noise"}, configured_names=None
    )
    assert field == "warenkorb"
    assert payload == "<IDS><ITEM/></IDS>"


def test_an_unknown_cart_field_name_is_still_found() -> None:
    """A shop that invents its own field name must not cost the user the trip —
    anything that looks like XML is accepted as a last resort."""

    from app.services.ids_connect import extract_cart_payload

    payload, field = extract_cart_payload(
        {"someNewName": "<?xml version='1.0'?><IDS/>"}, configured_names=None
    )
    assert field == "someNewName"
    assert payload.startswith("<?xml")


def test_the_handoff_url_is_relative_to_our_own_origin(
    client: TestClient, admin_token: str
) -> None:
    """It used to be built from `app_public_url`, which defaults to
    https://localhost — that setting describes how the app refers to ITSELF,
    which behind a reverse proxy or a duckdns name is not where the user's
    browser is. The browser opening this page is already on our origin, so a
    relative path is correct everywhere.

    HOOK_URL is the one that must stay absolute: it is embedded in a form
    submitted to the wholesaler, which has no origin of ours to resolve against.
    """

    supplier = _supplier(client, admin_token, "Unielektro")
    _connection(client, admin_token, supplier["id"])

    started = client.post(
        "/api/werkstatt/ids/start",
        headers=auth_headers(admin_token),
        json={"supplier_id": supplier["id"]},
    )
    assert started.status_code == 200, started.text
    handoff = started.json()["handoff_url"]
    assert handoff.startswith("/api/werkstatt/ids/handoff/")
    assert "localhost" not in handoff
    assert not handoff.startswith("http")


# A real cart returned by Unielektro's /basket/transmit, trimmed only of the
# customer's postal details. Kept verbatim because every guess this parser
# makes about element names was wrong for this document before it existed:
# ArtNo, QU, NetPrice and Cur all missed, so every line imported with no
# article number and no price.
REAL_UNIELEKTRO_CART = """<?xml version="1.0" encoding="UTF-8"?>
<Warenkorb xmlns="http://www.itek.de/Shop-Anbindung/Warenkorb/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <WarenkorbInfo><Date>2026-08-12</Date><Time>09:16:12</Time>
      <RueckgabeKZ>Warenkorbrückgabe</RueckgabeKZ><Version>2.0</Version></WarenkorbInfo>
    <Order>
        <OrderInfo><OfferNo>IDS</OfferNo><ModeOfShipment>Lieferung</ModeOfShipment>
          <Cur>EUR</Cur></OrderInfo>
        <CustomerInfo><IDNo>0001207716</IDNo><Address><Name1>SMPL Energy GmbH</Name1>
          <City>Witten</City></Address></CustomerInfo>
        <OrderItem><ItemChara>normal</ItemChara><RefItems/>
            <EAN>4050821632627</EAN><ArtNo>01472975</ArtNo>
            <Qty>1.00</Qty><QU>PCE</QU>
            <Kurztext>WAGO 210-804 ETIKETT 44x99MM SILBER 500STK/RO</Kurztext>
            <OfferPrice>8665.0000</OfferPrice><NetPrice>53.7200</NetPrice>
            <PriceBasis>100.00</PriceBasis><VAT>19.00</VAT></OrderItem>
        <OrderItem><ItemChara>normal</ItemChara><RefItems/>
            <EAN>4055143456067</EAN><ArtNo>01273376</ArtNo>
            <Qty>1.00</Qty><QU>PCE</QU>
            <Kurztext>WAGO 210-813 Etiketten</Kurztext>
            <OfferPrice>25500.0000</OfferPrice><NetPrice>158.1000</NetPrice>
            <PriceBasis>100.00</PriceBasis><VAT>19.00</VAT></OrderItem>
    </Order>
</Warenkorb>"""


def test_the_real_unielektro_dialect_parses_completely() -> None:
    """Namespaced <Warenkorb>, <OrderItem> rows, English-ish element names."""

    cart = parse_cart(REAL_UNIELEKTRO_CART)

    assert len(cart.lines) == 2
    assert cart.currency == "EUR"
    # No doubts to report: everything resolved.
    assert cart.warnings == ()
    assert all(line.warnings == () for line in cart.lines)

    first = cart.lines[0]
    assert first.supplier_article_no == "01472975"   # <ArtNo>
    assert first.ean == "4050821632627"
    assert first.quantity == 1                        # <Qty>1.00</Qty>
    assert first.unit == "PCE"                        # <QU>
    assert "210-804" in first.description             # <Kurztext>


def test_the_net_price_is_taken_and_the_list_price_ignored() -> None:
    """The cart carries both, and confusing them is a 100x error.

        <OfferPrice>8665.0000</OfferPrice>   list, scaled by PriceBasis=100
        <NetPrice>53.7200</NetPrice>         what we actually pay

    53.72 EUR for a 500-label roll is right; 86.65 is the undiscounted list,
    8665.00 is that list unscaled, and 0.54 would be PriceBasis applied to the
    net price. Only the first is correct.
    """

    cart = parse_cart(REAL_UNIELEKTRO_CART)

    assert cart.lines[0].unit_price_cents == 5372
    assert cart.lines[1].unit_price_cents == 15810
    # The traps, spelled out so a future edit that reaches for OfferPrice fails.
    for line in cart.lines:
        assert line.unit_price_cents not in (866500, 8665, 54, 2550000, 25500, 158)


def test_the_customer_number_is_not_mistaken_for_a_cart_reference() -> None:
    """<CustomerInfo><IDNo> is our account number, not an order handle. The
    header scan flattens the whole document, so it is close enough to the
    reference aliases to be worth pinning."""

    cart = parse_cart(REAL_UNIELEKTRO_CART)
    assert cart.external_reference != "0001207716"


def test_a_connection_without_credentials_sends_none() -> None:
    """The credential-free mode, which is how other craft software does this.

    Rather than storing a live wholesale ordering password, the shop is opened
    with only the action and the hook URL; the user signs in on the
    wholesaler's own page and the browser keeps that session. The cart still
    finds its way home because hookurl travels regardless.

    This works because `render_field_map` drops a field whose template is a
    bare placeholder that resolved to nothing — sending `pw_kunde=` empty
    would earn an unhelpful login error instead.
    """

    from app.services.ids_connect import DEFAULT_FETCH_FIELD_MAP, render_field_map

    rendered = render_field_map(
        DEFAULT_FETCH_FIELD_MAP,
        {
            "username": "",
            "password": "",
            "customer_number": "",
            "hook_url": "https://example.invalid/api/werkstatt/ids/hook/TOK",
            "ids_version": "2.5",
        },
    )

    assert set(rendered) == {"action", "hookurl", "target", "version"}
    assert "pw_kunde" not in rendered
    assert "benutzername" not in rendered


def test_a_swapped_fetch_action_is_refused(client: TestClient, admin_token: str) -> None:
    """WKS as the FETCH action is the failure that looks like success.

    It hands our cart to the shop and lands the user on the basket page looking
    exactly right — but registers no return leg, so the shop's "per IDS
    übermitteln" has nowhere to post and prints the payload to a debug page.
    Nothing errors on either side; the trip is simply lost. Refusing the save
    is the only place this is cheap to catch.
    """

    supplier = _supplier(client, admin_token, "Swap-Test")
    resp = client.put(
        "/api/werkstatt/ids/connections",
        headers=auth_headers(admin_token),
        json={
            "supplier_id": supplier["id"],
            "is_enabled": True,
            "entry_url": "https://www.unielektro.de/ids",
            "fetch_field_map": {"action": "WKS", "benutzername": "{username}"},
        },
    )
    assert resp.status_code == 400, resp.text
    assert "WKE" in resp.json()["detail"]


def test_a_swapped_submit_action_is_refused(client: TestClient, admin_token: str) -> None:
    supplier = _supplier(client, admin_token, "Swap-Test-2")
    resp = client.put(
        "/api/werkstatt/ids/connections",
        headers=auth_headers(admin_token),
        json={
            "supplier_id": supplier["id"],
            "is_enabled": True,
            "entry_url": "https://www.unielektro.de/ids",
            "submit_field_map": {"action": "WKE", "warenkorb": "{cart_xml}"},
        },
    )
    assert resp.status_code == 400, resp.text
    assert "WKS" in resp.json()["detail"]


def test_an_unknown_action_is_still_allowed(client: TestClient, admin_token: str) -> None:
    """Only the exact inversion is rejected. A wholesaler needing an action
    this code has never heard of is the reason the map is editable at all."""

    supplier = _supplier(client, admin_token, "Exotic-Shop")
    resp = client.put(
        "/api/werkstatt/ids/connections",
        headers=auth_headers(admin_token),
        json={
            "supplier_id": supplier["id"],
            "is_enabled": True,
            "entry_url": "https://shop.example.com/ids",
            "fetch_field_map": {"action": "SOMETHING_ELSE", "user": "{username}"},
        },
    )
    assert resp.status_code == 200, resp.text


def test_the_real_unielektro_cart_parses(client: TestClient, admin_token: str) -> None:
    """The actual payload Unielektro returned in production.

    Kept verbatim because every previous guess about this dialect was wrong;
    a real captured cart is the only trustworthy fixture. Notable shapes it
    exercises: a default XML namespace on the root, `OrderItem` rather than
    `ITEM`, `ArtNo`/`QU`/`Kurztext` field names, and both an `OfferPrice`
    (list, x100 scale) and a `NetPrice` (what we actually pay) on every line —
    reading the wrong one of those two would overstate the order 160-fold.
    """

    real = """<?xml version="1.0" encoding="UTF-8"?><Warenkorb
        xmlns="http://www.itek.de/Shop-Anbindung/Warenkorb/">
        <WarenkorbInfo><Date>2026-08-12</Date><Version>2.0</Version></WarenkorbInfo>
        <Order>
            <OrderInfo><OfferNo>IDS</OfferNo><Cur>EUR</Cur></OrderInfo>
            <OrderItem>
                <EAN>4050821656869</EAN><ArtNo>01473035</ArtNo>
                <Qty>1.00</Qty><QU>PCE</QU>
                <Kurztext>WAGO 211-856 LEITERMARKIERER</Kurztext>
                <OfferPrice>3253.0000</OfferPrice><NetPrice>20.1700</NetPrice>
                <PriceBasis>100.00</PriceBasis><VAT>19.00</VAT>
            </OrderItem>
        </Order></Warenkorb>"""

    cart = parse_cart(real)
    assert len(cart.lines) == 1
    line = cart.lines[0]
    assert line.supplier_article_no == "01473035"
    assert line.ean == "4050821656869"
    assert line.unit == "PCE"
    assert line.quantity == 1
    assert "LEITERMARKIERER" in (line.description or "")
    # NetPrice, not OfferPrice.
    assert line.unit_price_cents == 2017


def test_a_broken_field_map_is_refused_at_punchout_not_just_at_save(
    client: TestClient, admin_token: str
) -> None:
    """Save-time validation cannot see a row that was already wrong.

    Rows get into that state by ordinary means — written by an older version,
    half-repaired by a migration, edited straight in the database — and none of
    those paths go through the save endpoint. Checking again at the moment the
    call goes out is the last place the failure is still legible: past it, the
    request reaches the shop unauthenticated, the shop treats it as an
    anonymous visitor, and the user finds out as a cart that never arrives.
    """

    from app.core.db import SessionLocal
    from app.models.entities import WerkstattIdsConnection

    supplier = _supplier(client, admin_token, "Halb-repariert")
    _connection(client, admin_token, supplier["id"])

    # Reproduce the production state: action correct, credentials under names
    # no shop reads. This bypasses the API deliberately — that is exactly how
    # such a row comes into being.
    with SessionLocal() as db:
        connection = db.query(WerkstattIdsConnection).filter_by(
            supplier_id=supplier["id"]
        ).one()
        connection.fetch_field_map = {
            "ACTION": "WKE",
            "USERNAME": "{username}",
            "PASSWORD": "{password}",
            "HOOK_URL": "{hook_url}",
        }
        db.commit()

    started = client.post(
        "/api/werkstatt/ids/start",
        headers=auth_headers(admin_token),
        json={"supplier_id": supplier["id"]},
    )
    assert started.status_code == 409, started.text
    detail = started.json()["detail"]
    # The message must name the correct field, not merely say "misconfigured".
    assert "name_kunde" in detail
    assert "Prüfen" in detail


def test_pruefen_reports_the_wrong_credential_field_name(
    client: TestClient, admin_token: str
) -> None:
    """The whole failure mode is silence, so the check screen has to say it."""

    from app.core.db import SessionLocal
    from app.models.entities import WerkstattIdsConnection

    supplier = _supplier(client, admin_token, "Pruef-Test")
    _connection(client, admin_token, supplier["id"])
    with SessionLocal() as db:
        connection = db.query(WerkstattIdsConnection).filter_by(
            supplier_id=supplier["id"]
        ).one()
        connection.fetch_field_map = {
            "ACTION": "WKE",
            "USERNAME": "{username}",
            "HOOK_URL": "{hook_url}",
        }
        db.commit()

    checked = client.post(
        f"/api/werkstatt/ids/connections/{supplier['id']}/test",
        headers=auth_headers(admin_token),
    )
    assert checked.status_code == 200, checked.text
    body = checked.json()
    assert body["ok"] is False
    assert any("name_kunde" in problem for problem in body["problems"])


def test_pruefen_catches_a_hook_under_a_field_name_the_shop_does_not_read() -> None:
    """The exact configuration that shipped for three releases, and passed.

    The old check asked whether the {hook_url} PLACEHOLDER appeared anywhere in
    the map's values. It did — under the key `hook_url`, which no shop reads.
    So a connection that could never bring a cart home reported itself healthy,
    and the failure surfaced three steps later as a wholesaler debug page full
    of XML. What matters is the field NAME, so that is what is checked.
    """

    from app.services.ids_connect import describe_field_map_problems

    broken = {
        "action": "WKE",
        "name_kunde": "{username}",
        "pw_kunde": "{password}",
        "hook_url": "{hook_url}",  # placeholder present, field name wrong
    }
    errors, _ = describe_field_map_problems(broken, direction="fetch", has_username=True)

    assert errors, "a hook the shop cannot read must not pass as healthy"
    assert any("hookurl" in error for error in errors), "the message must name the fix"
    assert any("hook_url" in error for error in errors), "and name the offender"


def test_pruefen_passes_the_shipped_defaults() -> None:
    """Whatever else changes, the defaults themselves must be clean — otherwise
    every new connection starts life reporting a problem."""

    from app.services.ids_connect import (
        DEFAULT_FETCH_FIELD_MAP,
        DEFAULT_SUBMIT_FIELD_MAP,
        describe_field_map_problems,
    )

    fetch_errors, fetch_warnings = describe_field_map_problems(
        DEFAULT_FETCH_FIELD_MAP, direction="fetch", has_username=True
    )
    assert not fetch_errors and not fetch_warnings, (fetch_errors, fetch_warnings)

    submit_errors, _ = describe_field_map_problems(
        DEFAULT_SUBMIT_FIELD_MAP, direction="submit", has_username=True
    )
    assert not submit_errors, submit_errors


def test_a_hook_field_name_nobody_recognises_warns_but_does_not_block() -> None:
    """A wholesaler we have never met may use a spelling we do not know. That
    deserves a warning, not a refusal — the maps are editable precisely for it.
    """

    from app.services.ids_connect import describe_field_map_problems

    exotic = {
        "action": "WKE",
        "name_kunde": "{username}",
        "ruecksprungadresse": "{hook_url}",
    }
    errors, warnings = describe_field_map_problems(
        exotic, direction="fetch", has_username=True
    )
    assert not errors, "an unfamiliar name is not proof of a mistake"
    assert any("hookurl" in warning for warning in warnings)


# ──────────────────────────────────────────────────────────────────────────
# NetPrice is an extended amount
#
# The whole suite passed under BOTH readings of NetPrice until these tests
# existed, because every cart fixture had Qty 1.00 on every line — and at
# quantity one a line total and a unit price are the same number. The bug that
# hid there booked 10 m of cable at 45,69 EUR/m instead of 4,569, and one live
# draft order at EUR 2.52M.
#
# The XML below is a verbatim excerpt of a real Unielektro return, kept in the
# ITEK "Warenkorb" shape it actually arrives in, including the two elements that
# make the distinction visible: a Qty that is not 1, and a PriceBasis that must
# NOT be applied to NetPrice.
# ──────────────────────────────────────────────────────────────────────────

REAL_CART_WITH_QUANTITIES = """<?xml version="1.0" encoding="UTF-8"?>
<Warenkorb xmlns="http://www.itek.de/Shop-Anbindung/Warenkorb/">
  <WarenkorbInfo><Version>2.0</Version></WarenkorbInfo>
  <Order>
    <OrderInfo><Cur>EUR</Cur></OrderInfo>
    <OrderItem>
      <ArtNo>11102138</ArtNo><Qty>10.00</Qty><QU>MTR</QU>
      <Kurztext>Kabel/Leitungen NYY-J 5X6 RE schwarz Trommel</Kurztext>
      <OfferPrice>265.3100</OfferPrice><NetPrice>45.6900</NetPrice>
      <PriceBasis>100.00</PriceBasis><VAT>19.00</VAT>
    </OrderItem>
    <OrderItem>
      <ArtNo>01004771</ArtNo><Qty>1.00</Qty><QU>PCE</QU>
      <Kurztext>HAGER CDS440D FI-Schutzschalter 4P 40A 30mA SK</Kurztext>
      <OfferPrice>137.0000</OfferPrice><NetPrice>37.4400</NetPrice>
      <PriceBasis>1.00</PriceBasis><VAT>19.00</VAT>
    </OrderItem>
  </Order>
</Warenkorb>"""


def test_netprice_is_the_line_total_not_the_unit_price() -> None:
    """45,69 EUR for 10 m is 4,57 EUR/m — not 45,69 EUR/m.

    ITEK's field table: "Nettopreis … bezieht sich immer auf die Anfragemenge
    und Mengeneinheit", and the spec's worked example transmits 522 EUR for 50 m
    at 9 EUR/m, i.e. with the quantity multiplied in.

    Confirmed against the shop: Unielektro displayed this article at
    "456,90 EUR je 100 M", which is 4,569 EUR/m.
    """

    cart = parse_cart(REAL_CART_WITH_QUANTITIES)
    cable, fi_switch = cart.lines

    assert cable.quantity == 10
    # 45,69 / 10 = 4,569, stored to the nearest cent.
    assert cable.unit_price_cents == 457, "NetPrice was read as a unit price again"
    # The reading that shipped: 4569 cents, a factor of the quantity out.
    assert cable.unit_price_cents != 4569

    # PriceBasis is 100 on that line and must NOT touch NetPrice — dividing by
    # it as well would give 0,4569 EUR/m, wrong in the other direction.
    assert cable.unit_price_cents != 46

    # A quantity-1 line is identical under either reading, which is exactly why
    # a fixture made only of these could not catch the bug.
    assert fi_switch.quantity == 1
    assert fi_switch.unit_price_cents == 3744


def test_a_quantity_one_cart_cannot_distinguish_the_two_readings() -> None:
    """Documents the trap rather than guarding against it.

    Kept so the next person to touch the price aliases sees, in a passing test,
    why the previous fixture proved nothing: at Qty 1 the extended amount and
    the unit price are the same number, so both the right answer and the wrong
    one satisfy it.
    """

    cart = parse_cart(REAL_CART_WITH_QUANTITIES)
    fi_switch = cart.lines[1]
    net_price_as_written = 3744
    assert fi_switch.unit_price_cents == net_price_as_written
    assert fi_switch.quantity == 1


def test_an_unreadable_quantity_still_prices_the_line() -> None:
    """A line the shop priced must never arrive priced at nothing.

    Moving NetPrice onto the line-total path introduced a way for the price to
    vanish: with no divisor the computation simply did not happen and the line
    went in at zero. A wrong-looking price gets questioned; a zero looks
    deliberate and gets ordered.
    """

    xml = REAL_CART_WITH_QUANTITIES.replace("<Qty>10.00</Qty>", "<Qty>abc</Qty>")
    cable = parse_cart(xml).lines[0]

    assert cable.unit_price_cents == 4569, "the line lost its price"
    assert any("Menge unlesbar" in w for w in cable.warnings)


def test_a_normal_ids_cart_raises_no_price_warnings() -> None:
    """Deriving the unit price from NetPrice is the normal path, not a fallback.

    It previously appended "Kein Einzelpreis im Warenkorb" to every line of
    every IDS cart, which trains buyers to ignore the warning column — and the
    column is where the genuinely suspect lines (rounded-up quantities,
    nameless positions) have to stand out.
    """

    cart = parse_cart(REAL_CART_WITH_QUANTITIES)
    assert [w for line in cart.lines for w in line.warnings] == []


# ──────────────────────────────────────────────────────────────────────────
# The outbound cart must be ITEK Warenkorb
#
# The builder shipped emitting openTRANS/BMEcat vocabulary — <IDS>,
# SHOPPING_CART, SUPPLIER_AID, QUANTITY — in no namespace. None of those names
# occurs in the IDS spec or in any of its four schemas. Unielektro recognised
# zero positions, so every export "succeeded" (POST 200) and arrived as an empty
# basket, with nothing reported on either side.
#
# It survived because its only check was a round trip through our own parser,
# and that parser strips namespaces and carries a deliberately wide alias table
# so it can read many shops' dialects — including the invented one. A mirror is
# not an oracle. The oracle is ITEK's schema, vendored under tests/fixtures/ids.
# ──────────────────────────────────────────────────────────────────────────

IDS_NS = "http://www.itek.de/Shop-Anbindung/Warenkorb/"
_IDS_FIXTURES = Path(__file__).resolve().parent / "fixtures" / "ids"


def _built_cart(**overrides):
    from app.services.ids_cart_builder import CartItem, build_cart_xml

    items = overrides.pop(
        "items",
        [
            CartItem(
                supplier_article_no="11102138",
                description="Kabel/Leitungen NYY-J 5X6 RE schwarz",
                quantity=10,
                unit="MTR",
                ean="4011234567890",
            ),
            CartItem(
                supplier_article_no="01004771",
                description="HAGER CDS440D FI-Schutzschalter",
                quantity=1,
                unit="PCE",
            ),
        ],
    )
    overrides.setdefault("reference", "WK-TEST")
    overrides.setdefault("now", datetime(2026, 8, 15, 21, 30, 0))
    return build_cart_xml(items, **overrides)


def test_the_outbound_cart_is_itek_warenkorb_not_opentrans() -> None:
    """Guards the vocabulary itself, which is what was wrong.

    Deliberately asserts the absence of the old names too: a half-migration that
    left one SUPPLIER_AID behind would produce a document the shop rejects
    wholesale, losing the entire cart rather than one line.
    """

    xml = _built_cart().xml
    root = ET.fromstring(xml)

    assert root.tag == f"{{{IDS_NS}}}Warenkorb"
    for dead in (
        "IDS", "SHOPPING_CART", "CART_HEADER", "ITEM_LIST", "ITEM",
        "SUPPLIER_AID", "INTERNATIONAL_AID", "DESCRIPTION_SHORT",
        "QUANTITY", "ORDER_UNIT", "PRICE_AMOUNT", "PRICE_CURRENCY",
    ):
        assert dead not in xml, f"openTRANS vocabulary {dead} is still emitted"


def test_the_outbound_cart_carries_the_three_mandatory_item_elements() -> None:
    """ArtNo, Qty and QU are the only Muss elements in typeOrderItem, and the
    xs:sequence fixes their order — a reordered document is invalid even with
    every element present."""

    root = ET.fromstring(_built_cart().xml)
    items = root.findall(f"{{{IDS_NS}}}Order/{{{IDS_NS}}}OrderItem")
    assert len(items) == 2

    names = [child.tag.split("}")[1] for child in items[0]]
    assert names == ["RefItems", "EAN", "ArtNo", "Qty", "QU", "Kurztext"]

    assert items[0].find(f"{{{IDS_NS}}}ArtNo").text == "11102138"
    # tgDecimal_13_2 — a bare "10" is invalid against the type.
    assert items[0].find(f"{{{IDS_NS}}}Qty").text == "10.00"
    assert items[0].find(f"{{{IDS_NS}}}QU").text == "MTR"


def test_a_line_without_an_article_number_is_dropped_and_reported() -> None:
    """ArtNo is mandatory, so such a line cannot be expressed at all.

    Emitting it anyway would make the whole document invalid and cost the buyer
    the entire cart instead of one position, so it is dropped — but never
    silently, or the shop's basket quietly disagrees with ours.
    """

    from app.services.ids_cart_builder import CartItem

    built = _built_cart(
        items=[
            CartItem(supplier_article_no="A1", description="fine", quantity=1, unit="PCE"),
            CartItem(supplier_article_no=None, description="Handeingabe", quantity=3),
        ]
    )
    root = ET.fromstring(built.xml)
    assert len(root.findall(f"{{{IDS_NS}}}Order/{{{IDS_NS}}}OrderItem")) == 1
    assert any("Handeingabe" in w for w in built.warnings)


def test_the_position_number_travels_so_the_shop_can_keep_line_identity() -> None:
    """RefItems/Customer is "Positionsnummer des Handwerkers" — ours. Section 5.2
    requires the shop to preserve transmitted position numbers, which it can
    only do if we send them."""

    root = ET.fromstring(_built_cart().xml)
    items = root.findall(f"{{{IDS_NS}}}Order/{{{IDS_NS}}}OrderItem")
    numbers = [i.find(f"{{{IDS_NS}}}RefItems/{{{IDS_NS}}}Customer").text for i in items]
    assert numbers == ["1", "2"]


def test_orderinfo_is_omitted_rather_than_invented() -> None:
    """OrderInfo is optional, but ModeOfShipment is mandatory inside it and we
    have nothing real to put there. Omitting the wrapper is valid; inventing a
    shipping mode to satisfy it is how the field-name bugs started."""

    assert "OrderInfo" not in _built_cart().xml


def test_a_non_numeric_ean_is_omitted_rather_than_emitted() -> None:
    """EAN is typed tgDecimal_13_0 — a number. A non-numeric value would make
    the document invalid, which costs the whole cart."""

    from app.services.ids_cart_builder import CartItem

    xml = _built_cart(
        items=[CartItem(supplier_article_no="A1", description="x", quantity=1,
                        unit="PCE", ean="nicht-numerisch")]
    ).xml
    assert "EAN" not in xml


@pytest.mark.skipif(
    importlib.util.find_spec("xmlschema") is None,
    reason="xmlschema not installed; the structural tests above still guard the vocabulary",
)
def test_the_outbound_cart_validates_against_iteks_own_schema() -> None:
    """The real oracle.

    ITEK's own example is validated first as a control: if that fails, the
    schema or the validator is at fault rather than our builder, and a bare
    assertion on our output alone would send someone hunting in the wrong place.
    """

    import xmlschema

    schema = xmlschema.XMLSchema(str(_IDS_FIXTURES / "warenkorb_senden_2_5.xsd"))
    schema.validate(str(_IDS_FIXTURES / "beispielwarenkorb_senden.xml"))
    schema.validate(_built_cart().xml)


@pytest.mark.skipif(
    importlib.util.find_spec("xmlschema") is None, reason="xmlschema not installed"
)
def test_the_old_opentrans_cart_would_have_failed_the_schema() -> None:
    """Proves the guard has teeth: the shape that shipped is rejected."""

    import xmlschema

    schema = xmlschema.XMLSchema(str(_IDS_FIXTURES / "warenkorb_senden_2_5.xsd"))
    old = (
        '<?xml version="1.0" encoding="ISO-8859-1"?>\n'
        '<IDS VERSION="2.5"><SHOPPING_CART><CART_HEADER><REFERENCE>WK-3</REFERENCE>'
        "</CART_HEADER><ITEM_LIST><ITEM><SUPPLIER_AID>11102138</SUPPLIER_AID>"
        "<QUANTITY>10</QUANTITY></ITEM></ITEM_LIST></SHOPPING_CART></IDS>"
    )
    with pytest.raises(Exception):
        schema.validate(old)


# ──────────────────────────────────────────────────────────────────────────
# The return leg: doubling, and whether an order was actually placed
#
# Neither of these can be exercised by hand without placing a real order at a
# real wholesaler, so they are pinned here instead.
# ──────────────────────────────────────────────────────────────────────────

RETURNED_CART = """<?xml version="1.0" encoding="UTF-8"?>
<Warenkorb xmlns="http://www.itek.de/Shop-Anbindung/Warenkorb/">
  <WarenkorbInfo>
    <Date>2026-08-15</Date><Time>21:30:00</Time>
    <RueckgabeKZ>{marker}</RueckgabeKZ>
    <Version>2.5</Version>
  </WarenkorbInfo>
  <Order>
    <OrderInfo><Cur>EUR</Cur></OrderInfo>
    <OrderItem><ArtNo>11102138</ArtNo><Qty>10.00</Qty><QU>MTR</QU>
      <Kurztext>NYY-J 5X6</Kurztext><NetPrice>45.6900</NetPrice></OrderItem>
  </Order>
</Warenkorb>"""


def test_a_returned_cart_reports_whether_an_order_was_placed() -> None:
    """RueckgabeKZ is the only field separating "looked" from "bought".

    The spec permits exactly two values and makes the element mandatory inbound,
    so a shop that follows it always tells us — but we were discarding it, which
    left no way to know whether a hand-over ended in a purchase.
    """

    browsed = parse_cart(RETURNED_CART.format(marker="Warenkorbrückgabe"))
    assert browsed.order_placed is False
    assert browsed.return_marker == "Warenkorbrückgabe"

    bought = parse_cart(RETURNED_CART.format(marker="Warenkorbrückgabe mit Bestellung"))
    assert bought.order_placed is True


def test_the_order_placed_flag_tolerates_the_shops_own_spelling() -> None:
    """The value is German prose, and shops differ on case and spacing. Matching
    the whole string exactly would make the flag fail open — reading "no order
    placed" when one was."""

    for marker in (
        "warenkorbrückgabe MIT BESTELLUNG",
        "  Warenkorbrückgabe mit Bestellung  ",
        "Warenkorbrueckgabe mit Bestellung",
    ):
        assert parse_cart(RETURNED_CART.format(marker=marker)).order_placed is True


def test_a_cart_without_the_marker_reads_as_not_ordered() -> None:
    """Absence must mean "not ordered", never an error: a shop that omits the
    field would otherwise break the whole hand-over over a status hint."""

    without = RETURNED_CART.replace("<RueckgabeKZ>{marker}</RueckgabeKZ>", "")
    cart = parse_cart(without)
    assert cart.order_placed is False
    assert cart.return_marker is None
    assert len(cart.lines) == 1


def test_an_exported_cart_coming_back_replaces_the_lines_rather_than_doubling(
    client: TestClient, admin_token: str
) -> None:
    """The one that costs money.

    `append_cart_lines` appends by design — a second shopping trip should extend
    the first, and it deliberately does not merge duplicates because two trips
    that both bought cable are two facts. But an EXPORTED cart coming back is
    the SAME cart, so appending files every position twice: a purchase order
    reading 20 m of cable where the buyer asked for 10.

    Driven through the real hook endpoint, because the bug lives in the branch
    that decides append-versus-replace, not in the parser.
    """

    from app.core.db import SessionLocal
    from app.models.entities import WerkstattIdsConnection, WerkstattOrderLine
    from app.services.ids_connect import create_session

    supplier = _supplier(client, admin_token, "Return-Test")
    order_id = _import_cart(client, admin_token, supplier["id"]).json()["order_id"]

    with SessionLocal() as db:
        assert db.query(WerkstattOrderLine).filter_by(order_id=order_id).count() == 2

        connection = WerkstattIdsConnection(
            supplier_id=supplier["id"],
            is_enabled=True,
            entry_url="https://shop.example.com/ids",
            hook_base_url="https://smpl.example.com",
            created_at=utcnow_for_test(),
            updated_at=utcnow_for_test(),
            **_connection_defaults(),
        )
        db.add(connection)
        db.flush()
        session = create_session(
            db, connection=connection, user_id=1, direction="submit", order_id=order_id
        )
        token = session.token
        db.commit()

    # The shop hands the cart back. One position, the same article the order
    # already holds.
    resp = client.post(
        f"/api/werkstatt/ids/hook/{token}",
        data={"warenkorb": RETURNED_CART.format(marker="Warenkorbrückgabe mit Bestellung")},
    )
    assert resp.status_code == 200, resp.text

    with SessionLocal() as db:
        lines = db.query(WerkstattOrderLine).filter_by(order_id=order_id).all()

    # One line in, one line held. Appending would have left three.
    assert len(lines) == 1, f"the returned cart was appended, not applied: {len(lines)} lines"
    assert lines[0].supplier_article_no == "11102138"


def _connection_defaults() -> dict:
    from app.services.ids_connect import default_connection_values

    return default_connection_values()


def utcnow_for_test():
    from app.core.time import utcnow

    return utcnow()
