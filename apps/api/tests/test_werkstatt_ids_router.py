"""The IDS router after the split, and the one write it does on the side.

`workflow_werkstatt_ids.py` lost its hand-over pages to
`workflow_werkstatt_ids_handoff.py`; these pin that every route is still
mounted and reachable, including the convenience re-read the import screen
uses, which had lost its import in the move before this one and answered 500
without any test noticing.
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


def _supplier_row(client: TestClient, token: str, supplier_id: int) -> dict:
    listed = client.get("/api/werkstatt/suppliers", headers=auth_headers(token)).json()
    return next(row for row in listed if row["id"] == supplier_id)


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
            **extra,
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_an_order_can_be_re_read_through_the_ids_router(
    client: TestClient, admin_token: str
) -> None:
    """GET /werkstatt/ids/orders/{id} — the import screen's re-read. It
    referenced `load_order_full` after the import had been removed, so every
    call raised NameError; `import app.main` cannot catch a name resolved at
    call time."""

    supplier = _supplier(client, admin_token)
    created = client.post(
        "/api/werkstatt/orders",
        headers=auth_headers(admin_token),
        json={"supplier_id": supplier["id"], "lines": [{"description": "Klemme", "quantity_ordered": 2}]},
    )
    assert created.status_code == 200, created.text

    reread = client.get(
        f"/api/werkstatt/ids/orders/{created.json()['id']}", headers=auth_headers(admin_token)
    )
    assert reread.status_code == 200, reread.text
    assert reread.json()["order_number"] == created.json()["order_number"]
    assert reread.json()["lines"][0]["article_name"] == "Klemme"

    missing = client.get("/api/werkstatt/ids/orders/999999", headers=auth_headers(admin_token))
    assert missing.status_code == 404


def test_the_hand_over_pages_are_mounted_from_their_own_module(client: TestClient) -> None:
    """Both unauthenticated pages answer as before the split: an unknown
    token is a 410 page, not a 404 from a route that is no longer there."""

    page = client.get("/api/werkstatt/ids/handoff/no-such-token")
    assert page.status_code == 410, page.text
    assert "Sitzung nicht mehr gültig" in page.text

    hook = client.post("/api/werkstatt/ids/hook/no-such-token", data={"warenkorb": "<x/>"})
    assert hook.status_code == 410, hook.text
    assert "Warenkorb nicht übernommen" in hook.text


def test_an_enabled_connection_makes_the_supplier_a_shop_supplier(
    client: TestClient, admin_token: str
) -> None:
    """`order_channel` defaults to manual and nothing used to set it, so the
    one supplier with a live shop kept preselecting behind whoever sorted
    first. Saving an enabled connection flips it; disabling leaves it alone
    (a credential rotation does not turn Unielektro into a CSV shop), and an
    explicit choice on the supplier survives a later save."""

    supplier = _supplier(client, admin_token)
    assert _supplier_row(client, admin_token, supplier["id"])["order_channel"] == "manual"

    _connection(client, admin_token, supplier["id"])
    assert _supplier_row(client, admin_token, supplier["id"])["order_channel"] == "ids"

    _connection(client, admin_token, supplier["id"], is_enabled=False)
    assert _supplier_row(client, admin_token, supplier["id"])["order_channel"] == "ids"

    patched = client.patch(
        f"/api/werkstatt/suppliers/{supplier['id']}",
        headers=auth_headers(admin_token),
        json={"order_channel": "manual"},
    )
    assert patched.status_code == 200, patched.text
    _connection(client, admin_token, supplier["id"], is_enabled=False)
    assert _supplier_row(client, admin_token, supplier["id"])["order_channel"] == "manual"


def test_a_disabled_connection_does_not_flip_the_channel_on_creation(
    client: TestClient, admin_token: str
) -> None:
    supplier = _supplier(client, admin_token)
    _connection(client, admin_token, supplier["id"], is_enabled=False)
    assert _supplier_row(client, admin_token, supplier["id"])["order_channel"] == "manual"
