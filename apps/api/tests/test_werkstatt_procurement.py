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

from datetime import timedelta

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
# punchout originally shipped with invented field names, and the way that
# failed hid the cause: Unielektro answered "Aktion 'WWWSHOP' ist nicht
# gültig", which reads like one wrong value in an otherwise correct call. In
# fact every field was wrong — `USERNAME` is not a mis-cased `benutzername`
# but a different word, so the credentials were never read at all.
#
# Values confirmed against ITEK's IDS-Connect 2.5 spec and Unielektro's own
# `action=LI` / `action=SV` discovery responses.
# ──────────────────────────────────────────────────────────────────────────


def test_the_fetch_call_uses_the_real_ids_action_and_field_names() -> None:
    from app.services.ids_connect import DEFAULT_FETCH_FIELD_MAP

    # WKE = Warenkorbübernahme, named from OUR point of view: the cart comes
    # from the shop into us. Getting this backwards is the easy mistake.
    assert DEFAULT_FETCH_FIELD_MAP["action"] == "WKE"
    assert DEFAULT_FETCH_FIELD_MAP["benutzername"] == "{username}"
    assert DEFAULT_FETCH_FIELD_MAP["passwort"] == "{password}"
    assert DEFAULT_FETCH_FIELD_MAP["hook_url"] == "{hook_url}"
    assert DEFAULT_FETCH_FIELD_MAP["returntarget"] == "_top"
    # The English names are what the wholesaler silently ignores.
    for rejected in ("USERNAME", "PASSWORD", "ACTION", "HOOK_URL", "TARGET"):
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
    finds its way home because hook_url travels regardless.

    This works because `render_field_map` drops a field whose template is a
    bare placeholder that resolved to nothing — sending `passwort=` empty
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

    assert set(rendered) == {"action", "hook_url", "returntarget", "Version"}
    assert "passwort" not in rendered
    assert "benutzername" not in rendered
