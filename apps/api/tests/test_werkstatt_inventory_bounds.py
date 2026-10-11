"""Upper bounds on a stock-take (Inventur) — review of 2026-10-11.

The ledger refuses a booking past ``MAX_STOCK_QUANTITY`` (``apply_movement``).
A stock-take books the difference between a count and the shelf, and nothing
used to bound either side of that difference:

* the count is built scan by scan — ``_bump`` added every scan's quantity
  with no ceiling on the total, so eleven scans of 100 000 produced a count
  the ledger then refused;
* the shelf can hold more than ``counted + MAX_STOCK_QUANTITY`` (several
  bounded intakes), so the ``inventory_minus`` booking is past the bound too.

``finalize_session`` did not catch the ledger's ``MovementError`` and the
router did not either: an unhandled 500, and a session that could not be
closed. Now the count stops at the bound (a 400 on the scan that would pass
it, nothing counted), and a variance the ledger still refuses answers a 400
that names the article — the session stays open and books nothing.
"""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.core.limits import MAX_STOCK_QUANTITY
from app.models.entities import WerkstattInventoryCount, WerkstattMovement

SESSIONS = "/api/werkstatt/inventory/sessions"
# The largest quantity one scan may carry (``InventoryScanRequest.quantity``).
SCAN_MAX = 100_000


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _article(client: TestClient, token: str, name: str, *, ean: str, stock: int = 0) -> dict:
    resp = client.post(
        "/api/werkstatt/articles",
        headers=_auth(token),
        json={"item_name": name, "unit": "Stk", "ean": ean, "stock_total": stock},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _session(client: TestClient, token: str, name: str) -> int:
    resp = client.post(SESSIONS, headers=_auth(token), json={"name": name})
    assert resp.status_code == 200, resp.text
    return int(resp.json()["id"])


def _scan(client: TestClient, token: str, session_id: int, code: str, qty: int):
    return client.post(
        f"{SESSIONS}/{session_id}/scan", headers=_auth(token), json={"code": code, "quantity": qty}
    )


def _finalize(client: TestClient, token: str, session_id: int):
    return client.post(f"{SESSIONS}/{session_id}/finalize", headers=_auth(token))


def _count_row(session_id: int, article_id: int) -> tuple[int, int]:
    """(counted_qty, scan_count) as stored."""
    with SessionLocal() as db:
        row = db.scalars(
            select(WerkstattInventoryCount).where(
                WerkstattInventoryCount.session_id == session_id,
                WerkstattInventoryCount.article_id == article_id,
            )
        ).one()
        return int(row.counted_qty), int(row.scan_count)


def _ledger(article_id: int) -> list[tuple[str, int]]:
    with SessionLocal() as db:
        rows = db.scalars(
            select(WerkstattMovement)
            .where(WerkstattMovement.article_id == article_id)
            .order_by(WerkstattMovement.id)
        )
        return [(row.movement_type, int(row.quantity)) for row in rows]


def _session_status(client: TestClient, token: str, session_id: int) -> str:
    resp = client.get(f"{SESSIONS}/{session_id}", headers=_auth(token))
    assert resp.status_code == 200, resp.text
    return resp.json()["status"]


# ── the count stops at the bound ─────────────────────────────────────────────


def test_eleven_scans_of_the_largest_quantity_stop_at_the_bound_and_finalize(
    client: TestClient, admin_token: str
) -> None:
    """The reviewer's reproduction: eleven scans of 100 000 into one session.
    Ten reach the bound exactly and are counted; the eleventh is refused with
    a 400 and counts nothing; finalize then books the bound and answers 200."""
    ean = "4019000000011"
    article = _article(client, admin_token, "Aderendhülse 1,5 mm² Grenze", ean=ean)
    session_id = _session(client, admin_token, "Inventur Grenze 1")

    for _ in range(MAX_STOCK_QUANTITY // SCAN_MAX):
        resp = _scan(client, admin_token, session_id, ean, SCAN_MAX)
        assert resp.status_code == 200, resp.text
    assert resp.json()["counted_qty"] == MAX_STOCK_QUANTITY
    before = _count_row(session_id, article["id"])

    refused = _scan(client, admin_token, session_id, ean, SCAN_MAX)
    assert refused.status_code == 400, refused.text
    assert f"höchstens {MAX_STOCK_QUANTITY}" in refused.json()["detail"]
    assert _count_row(session_id, article["id"]) == before, "a refused scan counts nothing"

    finalized = _finalize(client, admin_token, session_id)
    assert finalized.status_code == 200, finalized.text
    assert finalized.json()["units_added"] == MAX_STOCK_QUANTITY
    assert _ledger(article["id"]) == [("inventory_plus", MAX_STOCK_QUANTITY)]


def test_a_single_scan_onto_a_full_count_is_refused(client: TestClient, admin_token: str) -> None:
    """The first, implicit +1 of every scan is bounded too — not only the
    typed quantity on top of it."""
    ean = "4019000000028"
    article = _article(client, admin_token, "Kabelbinder Grenze", ean=ean)
    session_id = _session(client, admin_token, "Inventur Grenze 2")
    assert _scan(client, admin_token, session_id, ean, 1).status_code == 200
    patched = client.patch(
        f"{SESSIONS}/{session_id}/counts/{article['id']}",
        headers=_auth(admin_token),
        json={"counted_qty": MAX_STOCK_QUANTITY},
    )
    assert patched.status_code == 200, patched.text

    refused = _scan(client, admin_token, session_id, ean, 1)
    assert refused.status_code == 400, refused.text
    assert _count_row(session_id, article["id"]) == (MAX_STOCK_QUANTITY, 1)


def test_a_typed_quantity_that_would_pass_the_bound_counts_nothing(
    client: TestClient, admin_token: str
) -> None:
    """A typed quantity is booked as +1 and then +(n−1). When only the second
    half passes the bound, the first half must not survive either: the scan
    is refused as a whole and the count is what it was before."""
    ean = "4019000000035"
    article = _article(client, admin_token, "Wago 221-413 Grenze", ean=ean)
    session_id = _session(client, admin_token, "Inventur Grenze 3")
    assert _scan(client, admin_token, session_id, ean, 1).status_code == 200
    patched = client.patch(
        f"{SESSIONS}/{session_id}/counts/{article['id']}",
        headers=_auth(admin_token),
        json={"counted_qty": MAX_STOCK_QUANTITY - 1},
    )
    assert patched.status_code == 200, patched.text

    refused = _scan(client, admin_token, session_id, ean, 2)
    assert refused.status_code == 400, refused.text
    assert _count_row(session_id, article["id"]) == (MAX_STOCK_QUANTITY - 1, 1)

    exact = _scan(client, admin_token, session_id, ean, 1)
    assert exact.status_code == 200, exact.text
    assert exact.json()["counted_qty"] == MAX_STOCK_QUANTITY


# ── a variance the ledger refuses is a 400, and books nothing ───────────────


def test_a_stored_count_past_the_bound_answers_400_on_finalize(client: TestClient, admin_token: str) -> None:
    """A count row written before the scan bound existed — or by a path that
    does not bound it — still reaches finalize. The ledger refuses the
    booking; that must be a 400 naming the article, not a 500."""
    ean = "4019000000042"
    article = _article(client, admin_token, "Altzählung Grenze", ean=ean)
    session_id = _session(client, admin_token, "Inventur Grenze 4")
    assert _scan(client, admin_token, session_id, ean, 1).status_code == 200
    with SessionLocal() as db:
        row = db.scalars(
            select(WerkstattInventoryCount).where(WerkstattInventoryCount.session_id == session_id)
        ).one()
        row.counted_qty = MAX_STOCK_QUANTITY + 100_000
        db.commit()

    refused = _finalize(client, admin_token, session_id)
    assert refused.status_code == 400, refused.text
    detail = refused.json()["detail"]
    assert detail.startswith("Inventur kann nicht abgeschlossen werden")
    assert article["article_number"] in detail
    assert _session_status(client, admin_token, session_id) == "open"
    assert _ledger(article["id"]) == []


def test_a_shrinkage_past_the_bound_answers_400_and_books_nothing(
    client: TestClient, admin_token: str
) -> None:
    """The ``inventory_minus`` half: the shelf holds more than the count plus
    the bound. The session books entirely or not at all, so an article
    already booked earlier in the same finalize is rolled back too."""
    small_ean, big_ean = "4019000000059", "4019000000066"
    small = _article(client, admin_token, "Schrauben Grenze klein", ean=small_ean, stock=5)
    big = _article(client, admin_token, "Litze Grenze groß", ean=big_ean, stock=MAX_STOCK_QUANTITY)
    intake = client.post(
        f"/api/werkstatt/articles/{big['id']}/movements",
        headers=_auth(admin_token),
        json={"kind": "intake", "quantity": MAX_STOCK_QUANTITY, "reason": "Lieferschein Grenze"},
    )
    assert intake.status_code == 200, intake.text
    ledger_before = {small["id"]: _ledger(small["id"]), big["id"]: _ledger(big["id"])}

    session_id = _session(client, admin_token, "Inventur Grenze 5")
    # The small article first, so its +2 is booked before the big one fails.
    assert _scan(client, admin_token, session_id, small_ean, 7).status_code == 200
    assert _scan(client, admin_token, session_id, big_ean, 1).status_code == 200

    refused = _finalize(client, admin_token, session_id)
    assert refused.status_code == 400, refused.text
    assert big["article_number"] in refused.json()["detail"]
    assert _session_status(client, admin_token, session_id) == "open"
    assert {small["id"]: _ledger(small["id"]), big["id"]: _ledger(big["id"])} == ledger_before
