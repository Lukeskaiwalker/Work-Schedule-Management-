"""What the order picker sees, and what it may write.

Two halves of one flow. The "Neue Bestellung" dialog and the drawer search
our own stocked articles beside the supplier's catalogue; a stocked article
with no link to the chosen supplier yet must still turn up — it is exactly
the one whose number the buyer is about to type. And typing that number from
the drawer must land on the article↔supplier link even when the line was
drafted before any link existed, which is why POST on the link endpoint is
an upsert on the (article, supplier) pair.
"""

from __future__ import annotations

from fastapi.testclient import TestClient


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


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


def _post_link(client: TestClient, token: str, article_id: int, supplier_id: int, **extra):
    return client.post(
        f"/api/werkstatt/articles/{article_id}/suppliers",
        headers=auth_headers(token),
        json={"supplier_id": supplier_id, **extra},
    )


def _link(client: TestClient, token: str, article_id: int, supplier_id: int, **extra) -> dict:
    resp = _post_link(client, token, article_id, supplier_id, **extra)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _articles(client: TestClient, token: str, query: str) -> list[dict]:
    resp = client.get(f"/api/werkstatt/articles?{query}", headers=auth_headers(token))
    assert resp.status_code == 200, resp.text
    return resp.json()


def _order_with(client: TestClient, token: str, supplier_id: int, article_id: int) -> dict:
    resp = client.post(
        "/api/werkstatt/orders",
        headers=auth_headers(token),
        json={
            "supplier_id": supplier_id,
            "lines": [{"article_id": article_id, "quantity_ordered": 1}],
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _resolution(client: TestClient, token: str, order_id: int) -> dict:
    resp = client.get(f"/api/werkstatt/orders/{order_id}/resolution", headers=auth_headers(token))
    assert resp.status_code == 200, resp.text
    return resp.json()


# ──────────────────────────────────────────────────────────────────────────
# GET /articles — two ways of naming a supplier
# ──────────────────────────────────────────────────────────────────────────


def test_article_list_carries_the_supplier_number_when_filtered_by_supplier(
    client: TestClient, admin_token: str
) -> None:
    """`supplier_id` keeps its meaning: only linked articles, each with the
    number this supplier uses. Other callers depend on the filter."""

    supplier = _supplier(client, admin_token)
    article = _article(client, admin_token, "NYY-J 5x6")
    _link(client, admin_token, article["id"], supplier["id"], supplier_article_no="11102138")
    unlinked = _article(client, admin_token, "Kabelbinder")

    rows = _articles(client, admin_token, f"supplier_id={supplier['id']}")
    assert [row["id"] for row in rows] == [article["id"]]
    assert rows[0]["supplier_article_no"] == "11102138"

    everything = _articles(client, admin_token, "")
    by_id = {row["id"]: row for row in everything}
    assert by_id[unlinked["id"]]["supplier_article_no"] is None
    assert by_id[article["id"]]["supplier_article_no"] is None, "no supplier, no number"


def test_annotate_supplier_id_numbers_the_rows_without_restricting_them(
    client: TestClient, admin_token: str
) -> None:
    """The picker's question. "Kabelbinder 200 mm" is stocked and has no link
    to Unielektro; it must still be a hit, just without a number — and the
    number shown must be Unielektro's, not the one Sonepar uses."""

    unielektro = _supplier(client, admin_token, "Unielektro")
    sonepar = _supplier(client, admin_token, "Sonepar")
    cable = _article(client, admin_token, "NYY-J 5x6")
    _link(client, admin_token, cable["id"], unielektro["id"], supplier_article_no="11102138")
    _link(client, admin_token, cable["id"], sonepar["id"], supplier_article_no="S-9")
    ties = _article(client, admin_token, "Kabelbinder 200 mm")
    _link(client, admin_token, ties["id"], sonepar["id"], supplier_article_no="S-1")

    rows = _articles(client, admin_token, f"annotate_supplier_id={unielektro['id']}")
    by_id = {row["id"]: row for row in rows}
    assert set(by_id) == {cable["id"], ties["id"]}, "annotation must not filter"
    assert by_id[cable["id"]]["supplier_article_no"] == "11102138"
    assert by_id[ties["id"]]["supplier_article_no"] is None

    # The search still narrows the rows; the annotation rides along.
    hits = _articles(client, admin_token, f"q=Kabelbinder&annotate_supplier_id={sonepar['id']}")
    assert [row["id"] for row in hits] == [ties["id"]]
    assert hits[0]["supplier_article_no"] == "S-1"


# ──────────────────────────────────────────────────────────────────────────
# POST /articles/{id}/suppliers — an upsert on the pair
# ──────────────────────────────────────────────────────────────────────────


def test_posting_the_number_for_an_existing_pair_updates_that_link(
    client: TestClient, admin_token: str
) -> None:
    """The drawer's write. The link was created without a number (the
    from-catalogue path does that); posting again with the number must fill
    it in on the SAME link, not answer 400 and leave the number on the line."""

    supplier = _supplier(client, admin_token)
    article = _article(client, admin_token, "Reihenklemme")
    first = _link(client, admin_token, article["id"], supplier["id"], is_preferred=True)
    assert first["supplier_article_no"] is None

    resp = _post_link(
        client, admin_token, article["id"], supplier["id"], supplier_article_no="01004771"
    )
    assert resp.status_code == 200, resp.text
    second = resp.json()
    assert second["id"] == first["id"]
    assert second["supplier_article_no"] == "01004771"
    assert second["is_preferred"] is True, "a field that was not sent must not move"

    detail = client.get(f"/api/werkstatt/articles/{article['id']}", headers=auth_headers(admin_token))
    links = detail.json()["suppliers"]
    assert len(links) == 1, "an upsert must not add a second link for the pair"

    # An empty number is not a request to erase the one just recorded.
    blank = _post_link(client, admin_token, article["id"], supplier["id"], supplier_article_no="  ")
    assert blank.status_code == 200, blank.text
    assert blank.json()["supplier_article_no"] == "01004771"


def test_a_number_typed_in_the_drawer_resolves_the_next_order_at_step_one(
    client: TestClient, admin_token: str
) -> None:
    """Why the upsert matters: the next order for the same article must not
    ask again."""

    supplier = _supplier(client, admin_token)
    article = _article(client, admin_token, "Reihenklemme")
    _link(client, admin_token, article["id"], supplier["id"])  # link without a number
    _link(client, admin_token, article["id"], supplier["id"], supplier_article_no="01004771")

    order = _order_with(client, admin_token, supplier["id"], article["id"])
    # The line builder snapshots the link's number at creation, so the
    # resolver finds it on the line itself; either way nobody is asked.
    assert order["lines"][0]["supplier_article_no"] == "01004771"
    line = _resolution(client, admin_token, order["id"])["lines"][0]
    assert line["is_resolved"] is True
    assert line["matched_by"] in ("line_snapshot", "supplier_link")
    assert line["will_send"] == "01004771"


def test_a_link_for_an_unknown_supplier_is_refused_in_german(
    client: TestClient, admin_token: str
) -> None:
    article = _article(client, admin_token, "Reihenklemme")
    resp = _post_link(client, admin_token, article["id"], 999_999)
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"] == "Lieferant nicht gefunden"
