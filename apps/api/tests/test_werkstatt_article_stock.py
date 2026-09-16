"""Manual stock adjustment — ``POST /api/werkstatt/articles/{id}/movements``.

The desktop "Bestand anpassen" dialog books through here. What these tests pin
is not the HTTP plumbing but the stock maths, because every way of getting it
wrong corrupts real inventory silently rather than failing:

  * each of the three kinds must land on the RIGHT movement type — in
    particular neither ``defect`` nor ``inventory`` may book ``correction``,
    which also decrements ``stock_out``: a delivery and a shelf count can both
    see nothing but the shelf, so touching the checked-out column from here
    would write off tools that are sitting in a van, in perfect order;
  * the absolute ("Inventur-Korrektur") case must derive its delta from the
    article's current total in both directions, and write nothing at all when
    the count agrees;
  * nothing may drive a counter below zero. The recompute clamps the SNAPSHOT
    at zero while the LEDGER keeps the hole, so a negative booking does not
    show up as a wrong number — it shows up months later as an article stuck
    at 0 that swallows every delivery;
  * ``total == available + out + repair`` holds after every one of them.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

BASE = "/api/werkstatt"


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# ──────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────


def _article(client: TestClient, admin_token: str, name: str, *, stock: int = 0) -> dict:
    resp = client.post(
        f"{BASE}/articles",
        headers=auth_headers(admin_token),
        json={"item_name": name, "unit": "Stk", "stock_total": stock},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _get(client: TestClient, admin_token: str, article_id: int) -> dict:
    resp = client.get(f"{BASE}/articles/{article_id}", headers=auth_headers(admin_token))
    assert resp.status_code == 200, resp.text
    return resp.json()


def _adjust(client: TestClient, token: str, article_id: int, **body):
    return client.post(
        f"{BASE}/articles/{article_id}/movements",
        headers=auth_headers(token),
        json=body,
    )


def _movements(article_id: int) -> list[tuple[str, int, str | None]]:
    """(movement_type, quantity, notes) for one article, oldest first."""
    from sqlalchemy import select

    from app.core.db import SessionLocal
    from app.models.entities import WerkstattMovement

    with SessionLocal() as db:
        rows = list(
            db.scalars(
                select(WerkstattMovement)
                .where(WerkstattMovement.article_id == article_id)
                .order_by(WerkstattMovement.id.asc())
            ).all()
        )
        return [(r.movement_type, int(r.quantity), r.notes) for r in rows]


def _lend_and_repair(article_id: int, *, checkout: int, repair: int) -> None:
    """Put stock into the ``out`` and ``repair`` columns, so a later adjustment
    has something to wrongly disturb."""
    from sqlalchemy import select

    from app.core.db import SessionLocal
    from app.models.entities import User, WerkstattArticle
    from app.services.werkstatt_movements import apply_movement

    with SessionLocal() as db:
        row = db.get(WerkstattArticle, article_id)
        admin = db.scalars(select(User).where(User.email == "admin@example.com")).first()
        apply_movement(db, article=row, movement_type="checkout", quantity=checkout, user_id=admin.id)
        if repair:
            apply_movement(db, article=row, movement_type="repair_out", quantity=repair, user_id=admin.id)
        db.commit()


def _force_snapshot(article_id: int, *, total: int, available: int) -> None:
    """Make the stored snapshot disagree with the ledger.

    Assigning a stock counter directly is the one thing production code may
    never do — ``werkstatt_movements`` is the source of truth and the four
    ``stock_*`` columns are derived from it, so the only legal way to change
    one is to append a movement. That is exactly why the write belongs here and
    nowhere else: there is no legitimate route to the drifted state, and the
    endpoint still has to behave correctly in it (a half-finished migration, a
    hand-edited row, a future write path that forgets to recompute).
    """
    from app.core.db import SessionLocal
    from app.models.entities import WerkstattArticle

    with SessionLocal() as db:
        row = db.get(WerkstattArticle, article_id)
        row.stock_total = total
        row.stock_available = available
        db.add(row)
        db.commit()


def _assert_invariant(snapshot: dict) -> None:
    assert snapshot["stock_total"] == (
        snapshot["stock_available"] + snapshot["stock_out"] + snapshot["stock_repair"]
    ), f"invariant broken: {snapshot}"


# ──────────────────────────────────────────────────────────────────────────
# The three kinds → the right movement type
# ──────────────────────────────────────────────────────────────────────────


def test_wareneingang_books_an_intake(client: TestClient, admin_token: str) -> None:
    article = _article(client, admin_token, "Wago 221-413", stock=10)

    resp = _adjust(client, admin_token, article["id"], kind="intake", quantity=25, reason="LS 4711")
    assert resp.status_code == 200, resp.text
    assert resp.json()["stock_total"] == 35
    assert resp.json()["stock_available"] == 35

    assert [(t, q) for t, q, _ in _movements(article["id"])] == [("intake", 10), ("intake", 25)]
    _assert_invariant(_get(client, admin_token, article["id"]))


def test_schwund_books_inventory_minus_never_correction(
    client: TestClient, admin_token: str
) -> None:
    """``correction`` would also decrement ``stock_out`` — it means "the item
    somebody checked out is confirmed lost". Shrinkage found on the shelf is a
    different event and must not touch what is out on a van."""
    article = _article(client, admin_token, "Schrauben 4x40", stock=100)
    _lend_and_repair(article["id"], checkout=30, repair=10)

    resp = _adjust(client, admin_token, article["id"], kind="defect", quantity=5, reason="Wasserschaden")
    assert resp.status_code == 200, resp.text

    booked = [t for t, _, _ in _movements(article["id"])]
    assert booked[-1] == "inventory_minus"
    assert "correction" not in booked

    after = _get(client, admin_token, article["id"])
    assert after["stock_total"] == 95
    assert after["stock_available"] == 65
    assert after["stock_out"] == 20, "a shelf write-off must not touch checked-out stock"
    assert after["stock_repair"] == 10, "a shelf write-off must not touch repair stock"
    _assert_invariant(after)


def test_inventur_korrektur_upwards_computes_the_delta_from_the_target(
    client: TestClient, admin_token: str
) -> None:
    article = _article(client, admin_token, "Kabelbinder 200mm", stock=40)

    resp = _adjust(client, admin_token, article["id"], kind="inventory", target_total=52, reason="Inventur Q3")
    assert resp.status_code == 200, resp.text
    assert resp.json()["stock_total"] == 52

    assert _movements(article["id"])[-1][:2] == ("inventory_plus", 12)
    _assert_invariant(_get(client, admin_token, article["id"]))


def test_inventur_korrektur_downwards_computes_the_delta_from_the_target(
    client: TestClient, admin_token: str
) -> None:
    article = _article(client, admin_token, "Isolierband", stock=40)

    resp = _adjust(client, admin_token, article["id"], kind="inventory", target_total=33, reason="Inventur Q3")
    assert resp.status_code == 200, resp.text
    assert resp.json()["stock_total"] == 33
    assert resp.json()["stock_available"] == 33

    assert _movements(article["id"])[-1][:2] == ("inventory_minus", 7)
    _assert_invariant(_get(client, admin_token, article["id"]))


def test_inventur_korrektur_that_agrees_writes_no_ledger_row(
    client: TestClient, admin_token: str
) -> None:
    """A count that matches is not a correction. A zero-quantity row would be
    refused by ``apply_movement`` anyway and is noise in an audit trail."""
    article = _article(client, admin_token, "Aderendhülsen 1.5", stock=40)
    before = _movements(article["id"])

    resp = _adjust(client, admin_token, article["id"], kind="inventory", target_total=40, reason="Inventur Q3")
    assert resp.status_code == 200, resp.text
    assert resp.json()["stock_total"] == 40

    assert _movements(article["id"]) == before, "a matching count must write nothing"
    _assert_invariant(_get(client, admin_token, article["id"]))


def test_an_inventur_korrektur_leaves_out_and_repair_alone(
    client: TestClient, admin_token: str
) -> None:
    """The bug ``correction`` would cause, on the absolute path too."""
    article = _article(client, admin_token, "Makita DTD153", stock=100)
    _lend_and_repair(article["id"], checkout=30, repair=10)

    resp = _adjust(client, admin_token, article["id"], kind="inventory", target_total=90, reason="Inventur")
    assert resp.status_code == 200, resp.text

    after = _get(client, admin_token, article["id"])
    assert (after["stock_total"], after["stock_available"]) == (90, 60)
    assert after["stock_out"] == 20
    assert after["stock_repair"] == 10
    _assert_invariant(after)


# ──────────────────────────────────────────────────────────────────────────
# A stock-take lands on the counted number, whatever the snapshot said
# ──────────────────────────────────────────────────────────────────────────
#
# The delta used to be ``target − stock_total``, read off the stored snapshot,
# and handed to ``apply_movement``, which then rewrote that snapshot from the
# LEDGER. While the two agree — and in production today all 250 articles do —
# the difference is invisible. When they ever diverge it is backwards: the
# count lands on ``target ± drift``, so the one operation whose entire purpose
# is to end a discrepancy doubles it instead. These tests manufacture the
# disagreement and pin the property that matters: after a stock-take the total
# IS what was counted.


def test_a_stock_take_lands_on_the_counted_number_when_the_snapshot_reads_low(
    client: TestClient, admin_token: str
) -> None:
    article = _article(client, admin_token, "Wago 2273-204", stock=10)
    _force_snapshot(article["id"], total=7, available=7)  # ledger still says 10

    resp = _adjust(client, admin_token, article["id"], kind="inventory", target_total=6, reason="Inventur")
    assert resp.status_code == 200, resp.text

    # Counted 6, so the shelf holds 6. Deriving the delta from the stale 7
    # would have booked −1 against a ledger of 10 and left the article at 9.
    assert resp.json()["stock_total"] == 6
    assert _movements(article["id"])[-1][:2] == ("inventory_minus", 4)
    after = _get(client, admin_token, article["id"])
    assert after["stock_total"] == 6
    _assert_invariant(after)


def test_a_stock_take_lands_on_the_counted_number_when_the_snapshot_reads_high(
    client: TestClient, admin_token: str
) -> None:
    """The same in the other direction — and note the sign of the movement
    flips with it. Against the stale 14 the count of 12 looks like shrinkage;
    against the ledger's 10 it is a find."""
    article = _article(client, admin_token, "Wago 2273-208", stock=10)
    _force_snapshot(article["id"], total=14, available=14)

    resp = _adjust(client, admin_token, article["id"], kind="inventory", target_total=12, reason="Inventur")
    assert resp.status_code == 200, resp.text

    assert resp.json()["stock_total"] == 12
    assert _movements(article["id"])[-1][:2] == ("inventory_plus", 2)
    after = _get(client, admin_token, article["id"])
    assert after["stock_total"] == 12
    _assert_invariant(after)


def test_a_count_that_agrees_with_the_ledger_repairs_the_snapshot_and_books_nothing(
    client: TestClient, admin_token: str
) -> None:
    """The no-op path still has something to do: the count confirms the ledger,
    so there is nothing to book, but the drifted snapshot must not survive the
    request — least of all be reported back as the new truth."""
    article = _article(client, admin_token, "Aderendhülsen 2.5", stock=10)
    _force_snapshot(article["id"], total=7, available=7)
    before = _movements(article["id"])

    resp = _adjust(client, admin_token, article["id"], kind="inventory", target_total=10, reason="Inventur")
    assert resp.status_code == 200, resp.text
    assert resp.json()["stock_total"] == 10

    assert _movements(article["id"]) == before, "a matching count must write nothing"
    after = _get(client, admin_token, article["id"])
    assert (after["stock_total"], after["stock_available"]) == (10, 10), (
        "the repaired snapshot must be committed, not just returned"
    )
    _assert_invariant(after)


def test_the_shelf_guard_judges_the_ledger_not_an_inflated_snapshot(
    client: TestClient, admin_token: str
) -> None:
    """Five exist, four are out on a van, and the snapshot has somehow come to
    claim nine on the shelf.

    Both the router pre-check and ``apply_movement``'s own guard read the
    article's counters, so an inflated snapshot would wave the booking past
    both and leave the LEDGER at −2 — the hole that swallows every later
    delivery. Reconciling before the guards run is what closes that.
    """
    article = _article(client, admin_token, "Bosch GSR 12V", stock=5)
    _lend_and_repair(article["id"], checkout=4, repair=0)
    _force_snapshot(article["id"], total=13, available=9)
    before = _movements(article["id"])

    resp = _adjust(client, admin_token, article["id"], kind="defect", quantity=3, reason="zerbrochen")
    assert resp.status_code == 400, resp.text
    assert "nur 1 Stk" in resp.json()["detail"]
    assert _movements(article["id"]) == before, "a refused adjustment must write nothing"

    # And a booking that does fit repairs the snapshot on its way through.
    ok = _adjust(client, admin_token, article["id"], kind="intake", quantity=2, reason="LS 12")
    assert ok.status_code == 200, ok.text
    after = _get(client, admin_token, article["id"])
    assert (after["stock_total"], after["stock_available"], after["stock_out"]) == (7, 3, 4)
    _assert_invariant(after)


def test_the_optimistic_check_compares_against_the_ledger(
    client: TestClient, admin_token: str
) -> None:
    """``expected_total`` asks "is this still the number I was shown?". The
    honest answer is the one the booking will actually be measured against, so
    a dialog that displayed the drifted 7 is told about the 10 and sent back to
    the shelf, rather than being let through against a number that the write
    would then overrule."""
    article = _article(client, admin_token, "Gira 5570", stock=10)
    _force_snapshot(article["id"], total=7, available=7)
    before = _movements(article["id"])

    stale = _adjust(
        client, admin_token, article["id"],
        kind="inventory", target_total=9, reason="Inventur", expected_total=7,
    )
    assert stale.status_code == 409, stale.text
    assert "7" in stale.json()["detail"] and "10" in stale.json()["detail"]
    assert _movements(article["id"]) == before

    fresh = _adjust(
        client, admin_token, article["id"],
        kind="inventory", target_total=9, reason="Inventur", expected_total=10,
    )
    assert fresh.status_code == 200, fresh.text
    assert fresh.json()["stock_total"] == 9
    _assert_invariant(_get(client, admin_token, article["id"]))


# ──────────────────────────────────────────────────────────────────────────
# Rejections
# ──────────────────────────────────────────────────────────────────────────


def test_a_non_positive_quantity_is_refused(client: TestClient, admin_token: str) -> None:
    article = _article(client, admin_token, "Dübel 8mm", stock=10)

    for bad in (0, -3):
        resp = _adjust(client, admin_token, article["id"], kind="intake", quantity=bad, reason="x")
        assert resp.status_code == 400, resp.text
        assert "Menge" in resp.json()["detail"]

    missing = _adjust(client, admin_token, article["id"], kind="defect", reason="x")
    assert missing.status_code == 400, missing.text

    assert [t for t, _, _ in _movements(article["id"])] == ["intake"], "nothing may have been booked"


def test_an_empty_reason_is_refused(client: TestClient, admin_token: str) -> None:
    """The dialog marks "Begründung / Beleg" required with a ``*``; the server
    enforces it rather than trusting the client to."""
    article = _article(client, admin_token, "Klemmen 2.5", stock=10)

    for bad in ("", "   ", "\n\t "):
        resp = _adjust(client, admin_token, article["id"], kind="intake", quantity=2, reason=bad)
        assert resp.status_code == 400, resp.text
        assert "Begründung" in resp.json()["detail"]

    assert [t for t, _, _ in _movements(article["id"])] == ["intake"]


def test_an_adjustment_that_would_go_negative_is_refused(
    client: TestClient, admin_token: str
) -> None:
    """Five exist, four are out on a van: only one is on the shelf to write off.

    Booking three anyway would leave the ledger at −2 while the recompute
    clamps the snapshot to 0 — and every later delivery would vanish into it.
    """
    article = _article(client, admin_token, "Bosch GBH 2-28", stock=5)
    _lend_and_repair(article["id"], checkout=4, repair=0)
    before = _movements(article["id"])

    resp = _adjust(client, admin_token, article["id"], kind="defect", quantity=3, reason="zerbrochen")
    assert resp.status_code == 400, resp.text
    detail = resp.json()["detail"]
    assert "nur 1 Stk" in detail and "Ausgegeben (4 Stk)" in detail

    # The absolute path must be guarded identically: counting the shelf down to
    # zero cannot write off the four that are not on it.
    absolute = _adjust(client, admin_token, article["id"], kind="inventory", target_total=0, reason="Inventur")
    assert absolute.status_code == 400, absolute.text

    assert _movements(article["id"]) == before, "a refused adjustment must write nothing"
    after = _get(client, admin_token, article["id"])
    assert (after["stock_total"], after["stock_available"], after["stock_out"]) == (5, 1, 4)
    _assert_invariant(after)


def test_the_second_of_two_bookings_is_judged_against_what_the_first_left(
    client: TestClient, admin_token: str
) -> None:
    """Two tablets, the same article, "Schwund 5" typed on both against a
    displayed 8.

    Each request re-reads the article and re-derives its own delta, so the
    second is measured against the 3 the first one left — not against the 8 on
    the screen it was typed into. That is what keeps the ledger off −2 once the
    two arrive back to back.

    What this test CANNOT show is the two arriving at the same instant: the
    read and the write are separate statements, and only ``SELECT … FOR UPDATE``
    (see ``werkstatt_movements.load_article_for_update``) stops a second
    transaction reading 8 in the window before the first commits. ``FOR UPDATE``
    does not exist on SQLite, which is what the tests run on, so the lock is
    real in production and absent here. The guard below is the half that can be
    pinned.
    """
    article = _article(client, admin_token, "Knipex 03 01 180", stock=8)

    first = _adjust(client, admin_token, article["id"], kind="defect", quantity=5, reason="Kiste 1")
    assert first.status_code == 200, first.text
    assert first.json()["stock_available"] == 3

    second = _adjust(client, admin_token, article["id"], kind="defect", quantity=5, reason="Kiste 1")
    assert second.status_code == 400, second.text
    assert "nur 3 Stk" in second.json()["detail"]

    # And with the optimistic lock filled in from the same stale screen, the
    # refusal names both numbers instead of being a bare 400.
    stale = _adjust(
        client, admin_token, article["id"],
        kind="defect", quantity=5, reason="Kiste 1", expected_total=8,
    )
    assert stale.status_code == 409, stale.text

    assert [(t, q) for t, q, _ in _movements(article["id"])] == [
        ("intake", 8),
        ("inventory_minus", 5),
    ]
    after = _get(client, admin_token, article["id"])
    assert (after["stock_total"], after["stock_available"]) == (3, 3)
    _assert_invariant(after)


def test_a_stale_dialog_is_refused_when_it_says_what_it_displayed(
    client: TestClient, admin_token: str
) -> None:
    """``expected_total`` is the opt-in optimistic lock: the count and the
    snapshot disagreeing is exactly the case only the person at the shelf can
    resolve, so it is surfaced as 409 rather than guessed at."""
    article = _article(client, admin_token, "Leitung NYM-J 3x1.5", stock=200)
    before = _movements(article["id"])

    stale = _adjust(
        client, admin_token, article["id"],
        kind="inventory", target_total=180, reason="Inventur", expected_total=150,
    )
    assert stale.status_code == 409, stale.text
    assert "150" in stale.json()["detail"] and "200" in stale.json()["detail"]
    assert _movements(article["id"]) == before

    fresh = _adjust(
        client, admin_token, article["id"],
        kind="inventory", target_total=180, reason="Inventur", expected_total=200,
    )
    assert fresh.status_code == 200, fresh.text
    assert fresh.json()["stock_total"] == 180


def test_unknown_and_archived_articles_are_refused(client: TestClient, admin_token: str) -> None:
    missing = _adjust(client, admin_token, 9_999_999, kind="intake", quantity=1, reason="x")
    assert missing.status_code == 404, missing.text

    article = _article(client, admin_token, "Altbestand", stock=3)
    assert client.delete(
        f"{BASE}/articles/{article['id']}", headers=auth_headers(admin_token)
    ).status_code == 200

    archived = _adjust(client, admin_token, article["id"], kind="intake", quantity=1, reason="x")
    assert archived.status_code == 400, archived.text
    assert "archiviert" in archived.json()["detail"]


def test_stock_adjustment_requires_werkstatt_manage(client: TestClient, admin_token: str) -> None:
    """Same permission the neighbouring article writes require — no new grant."""
    created = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={
            "email": "monteur@example.com",
            "password": "Password123!",
            "full_name": "Monteur",
            "role": "employee",
        },
    )
    assert created.status_code == 200, created.text
    login = client.post(
        "/api/auth/login", json={"email": "monteur@example.com", "password": "Password123!"}
    )
    assert login.status_code == 200, login.text
    employee_token = login.headers["X-Access-Token"]

    article = _article(client, admin_token, "Fluke 117", stock=2)
    resp = _adjust(client, employee_token, article["id"], kind="intake", quantity=1, reason="x")
    assert resp.status_code == 403, resp.text
    assert [t for t, _, _ in _movements(article["id"])] == ["intake"]

    # Every other refusal this dialog can produce is German prose; the shared
    # `require_permission` answers "Permission denied", so this endpoint
    # translates its own 403 rather than showing the workshop one English
    # sentence among five German ones.
    assert resp.json()["detail"] == "Keine Berechtigung, den Bestand zu ändern"


# ──────────────────────────────────────────────────────────────────────────
# Contract with the list view
# ──────────────────────────────────────────────────────────────────────────


def test_the_response_is_the_same_row_shape_the_list_returns(
    client: TestClient, admin_token: str
) -> None:
    """The FE swaps one row in place after an adjustment instead of refetching
    the whole list, so the payload has to be the list's row verbatim."""
    article = _article(client, admin_token, "Hager MBN116", stock=6)

    resp = _adjust(client, admin_token, article["id"], kind="intake", quantity=4, reason="LS 99")
    assert resp.status_code == 200, resp.text

    listed = client.get(f"{BASE}/articles", headers=auth_headers(admin_token))
    assert listed.status_code == 200, listed.text
    row = next(r for r in listed.json() if r["id"] == article["id"])

    assert resp.json().keys() == row.keys()
    assert resp.json() == row


def test_the_row_carries_the_articles_own_unit(client: TestClient, admin_token: str) -> None:
    """The list row and the dialog both print a quantity for the same article.

    Without `unit` on this row one of them has to fall back to a default, so
    the same shelf reads "12 m" in the table and "12 Stk" in the dialog that
    just changed it.
    """
    resp = client.post(
        f"{BASE}/articles",
        headers=auth_headers(admin_token),
        json={"item_name": "NYM-J 3x1,5", "unit": "m", "stock_total": 50},
    )
    assert resp.status_code == 200, resp.text
    article = resp.json()

    adjusted = _adjust(client, admin_token, article["id"], kind="intake", quantity=25, reason="LS 7")
    assert adjusted.status_code == 200, adjusted.text
    assert adjusted.json()["unit"] == "m"

    listed = client.get(f"{BASE}/articles", headers=auth_headers(admin_token))
    row = next(r for r in listed.json() if r["id"] == article["id"])
    assert row["unit"] == "m"


def test_the_reason_reaches_the_ledger_with_its_kind(client: TestClient, admin_token: str) -> None:
    """``defect`` and ``inventory`` both book ``inventory_minus``, so without
    the kind on the note the ledger cannot tell shrinkage from a stock-take."""
    article = _article(client, admin_token, "Gira 0282 00", stock=20)

    assert _adjust(
        client, admin_token, article["id"], kind="defect", quantity=2, reason="Transportschaden"
    ).status_code == 200
    assert _adjust(
        client, admin_token, article["id"], kind="inventory", target_total=15, reason="Inventur Halle 1"
    ).status_code == 200

    notes = [n for _, _, n in _movements(article["id"])]
    assert notes[-2] == "Schwund / Defekt: Transportschaden"
    assert notes[-1] == "Inventur-Korrektur (Ziel 15 Stk): Inventur Halle 1"
