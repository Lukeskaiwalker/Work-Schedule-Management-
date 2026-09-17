"""The hand-over for a supplier who has no shop: the CSV and the clipboard.

Split from `test_werkstatt_order_send.py`, which keeps the identifier policy,
the pre-send resolution and the IDS submit. The export shares their resolver
and their `SendPreparation.warnings`, so the pins here are about what the
export adds: the two renderings, the download headers, the stamp on a draft,
the permission — and that the warning list arrives as the preparation built
it, one sentence per line, with no second reconciliation in between.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.services.ids_cart_builder import CartItem


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# ──────────────────────────────────────────────────────────────────────────
# Fixtures (the same shapes as in test_werkstatt_order_send.py)
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


# ──────────────────────────────────────────────────────────────────────────
# The export for suppliers without a shop
# ──────────────────────────────────────────────────────────────────────────


def test_the_export_csv_carries_the_supplier_number_and_omits_the_ean_by_default() -> None:
    from app.services.werkstatt_order_export import build_order_csv

    csv_text = build_order_csv(_items(), "supplier_no")
    lines = csv_text.splitlines()
    assert lines[0] == "Artikelnummer;Menge;Einheit;Bezeichnung"
    assert lines[1] == "11102138;10;MTR;NYY-J 5x6"
    assert "4011234567890" not in csv_text

    with_ean = build_order_csv(_items(), "both")
    assert with_ean.splitlines()[0].endswith(";EAN")
    assert "4011234567890" in with_ean


def test_the_export_text_is_one_number_and_quantity_per_line() -> None:
    from app.services.werkstatt_order_export import build_order_text

    assert build_order_text(_items(), "supplier_no") == "11102138\t10\n01004771\t1"


def test_the_export_skips_an_unresolved_line_and_reports_it() -> None:
    from app.services.werkstatt_order_export import export_order_items

    items = [CartItem(supplier_article_no=None, description="Unbekannt", quantity=2), *_items()]
    exported = export_order_items(items, "supplier_no")
    assert exported.sent_positions == 2
    assert exported.dropped_positions == 1
    assert "Unbekannt" not in exported.csv
    assert any("Position 1" in w for w in exported.warnings)


# ──────────────────────────────────────────────────────────────────────────
# Export for manual-channel suppliers
# ──────────────────────────────────────────────────────────────────────────


def _exportable_order(client: TestClient, token: str, *, with_unknown: bool) -> tuple[dict, dict]:
    supplier = _supplier(client, token, order_channel="manual")
    _catalog_row(supplier["id"], article_no="11102138", ean="4011234567890", unit="MTR")
    order = _order(client, token, supplier["id"])
    # The unit is the line's own: a free line resolves its NUMBER through the
    # catalogue, but what it is counted in was decided when it was typed.
    _add_line(
        client, token, order["id"],
        description="NYY-J 5x6", ean="4011234567890", unit="MTR", quantity_ordered=10,
    )
    if with_unknown:
        _add_line(client, token, order["id"], description="Unbekannt", ean="4099999999999")
    return supplier, order


def test_export_refuses_unresolved_lines_unless_overridden(
    client: TestClient, admin_token: str
) -> None:
    _, order = _exportable_order(client, admin_token, with_unknown=True)

    refused = client.get(
        f"/api/werkstatt/orders/{order['id']}/export?format=json", headers=auth_headers(admin_token)
    )
    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"]["code"] == "unresolved_lines"
    reread = client.get(f"/api/werkstatt/orders/{order['id']}", headers=auth_headers(admin_token))
    assert reread.json()["submitted_at"] is None, "a refused export must not stamp"

    forced = client.get(
        f"/api/werkstatt/orders/{order['id']}/export?format=json&allow_unresolved=true",
        headers=auth_headers(admin_token),
    )
    assert forced.status_code == 200, forced.text
    body = forced.json()
    assert body["text"] == "11102138\t10"
    assert body["csv"].splitlines()[1] == "11102138;10;MTR;NYY-J 5x6"
    assert body["dropped_positions"] == 1
    assert len(body["warnings"]) == 1
    assert body["filename"] == f"{order['order_number']}.csv"
    assert body["submitted_at"] is not None


def test_export_csv_download_has_a_filename(client: TestClient, admin_token: str) -> None:
    _, order = _exportable_order(client, admin_token, with_unknown=False)

    resp = client.get(
        f"/api/werkstatt/orders/{order['id']}/export?format=csv", headers=auth_headers(admin_token)
    )
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/csv")
    assert f'filename="{order["order_number"]}.csv"' in resp.headers["content-disposition"]
    assert resp.text.splitlines()[0].lstrip("﻿") == "Artikelnummer;Menge;Einheit;Bezeichnung"

    text = client.get(
        f"/api/werkstatt/orders/{order['id']}/export?format=text", headers=auth_headers(admin_token)
    )
    assert text.status_code == 200
    assert text.text == "11102138\t10"


def test_export_of_a_sent_order_does_not_restamp(client: TestClient, admin_token: str) -> None:
    """Re-downloading the list a week later is bookkeeping, not a hand-over."""

    _, order = _exportable_order(client, admin_token, with_unknown=False)
    first = client.get(
        f"/api/werkstatt/orders/{order['id']}/export?format=json", headers=auth_headers(admin_token)
    ).json()
    sent = client.post(
        f"/api/werkstatt/orders/{order['id']}/mark-sent", headers=auth_headers(admin_token)
    )
    assert sent.status_code == 200, sent.text

    again = client.get(
        f"/api/werkstatt/orders/{order['id']}/export?format=json", headers=auth_headers(admin_token)
    )
    assert again.status_code == 200, again.text
    assert again.json()["submitted_at"] == first["submitted_at"]


def test_export_needs_the_manage_permission(client: TestClient, admin_token: str) -> None:
    """The export stamps the order; reading the resolution does not."""

    _, order = _exportable_order(client, admin_token, with_unknown=False)
    resp = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={
            "email": "buyer@example.com",
            "password": "Passwort123!",
            "full_name": "Buyer",
            "role": "employee",
        },
    )
    assert resp.status_code in (200, 201), resp.text
    login = client.post(
        "/api/auth/login", json={"email": "buyer@example.com", "password": "Passwort123!"}
    )
    employee = login.headers["X-Access-Token"]

    assert (
        client.get(
            f"/api/werkstatt/orders/{order['id']}/resolution", headers=auth_headers(employee)
        ).status_code
        == 200
    )
    assert (
        client.get(
            f"/api/werkstatt/orders/{order['id']}/export?format=json", headers=auth_headers(employee)
        ).status_code
        == 403
    )


# ──────────────────────────────────────────────────────────────────────────
# The warning list is the preparation's, untouched
# ──────────────────────────────────────────────────────────────────────────


def test_the_export_keeps_the_fallback_note_and_names_the_lieferant_for_a_manual_supplier(
    client: TestClient, admin_token: str
) -> None:
    """The export used to de-duplicate warnings by position and keep the
    wrong one of two sentences. Now the reconciled list goes through as is:
    the dropped line first, in the resolver's words, then the fallback note.
    A manual-channel supplier has no shop, so the policy's own sentence says
    "an den Lieferanten"."""

    _, order = _fallback_order(client, admin_token, order_channel="manual")
    _add_line(client, admin_token, order["id"], description="Ohne alles")

    resolution = _resolution(client, admin_token, order["id"])
    assert resolution["channel"] == "manual"
    assert resolution["lines"][2]["warning"] == (
        "Position 3 (Ohne alles) hat keine Lieferanten-Artikelnummer und "
        "kann nicht an den Lieferanten übergeben werden"
    )

    exported = client.get(
        f"/api/werkstatt/orders/{order['id']}/export?format=json&allow_unresolved=true",
        headers=auth_headers(admin_token),
    )
    assert exported.status_code == 200, exported.text
    body = exported.json()
    assert body["sent_positions"] == 2
    assert body["dropped_positions"] == 1
    assert body["text"] == "01004771\t1\n4099999999999\t1"
    assert len(body["warnings"]) == 2, body["warnings"]
    assert body["warnings"][0].startswith("Position 3 (Ohne alles) hat keine Artikelnummer für Unielektro")
    assert body["warnings"][1] == FALLBACK_NOTE


def test_the_export_helper_passes_a_reconciled_list_through_untouched() -> None:
    from app.services.werkstatt_order_export import export_order_items

    items = [
        CartItem(supplier_article_no=None, description="Unbekannt", quantity=2, ean="4099999999999")
    ]
    given = ["Position 1 (Unbekannt) wird mit EAN statt Artikelnummer übergeben"]
    exported = export_order_items(items, "supplier_no_or_ean", warnings=given)
    assert list(exported.warnings) == given
    assert exported.sent_positions == 1

    # Without a list the policy's own sentence stands in, worded for the channel.
    derived = export_order_items(
        [CartItem(supplier_article_no=None, description="Unbekannt", quantity=1)],
        "supplier_no",
        channel="manual",
    )
    assert derived.warnings == (
        "Position 1 (Unbekannt) hat keine Lieferanten-Artikelnummer und "
        "kann nicht an den Lieferanten übergeben werden",
    )
