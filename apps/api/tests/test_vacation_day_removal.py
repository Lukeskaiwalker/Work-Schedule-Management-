"""Removing a single booked vacation day and refunding the entitlement.

The scenario: someone was booked off but came in and worked. A manager takes
that one day back out, and it returns to their remaining vacation.

The interesting cases are structural — vacation is stored as a *range*, so
removing a day at the start, in the middle, or as the whole request are three
different operations — plus the accounting, which must not invent or lose days.
"""

from __future__ import annotations

from datetime import date

import sqlalchemy as sa
from fastapi.testclient import TestClient


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _set_balance(client: TestClient, admin_token: str, user_id: int, *, available: float, carryover: float = 0.0):
    resp = client.patch(
        f"/api/time/vacation-balance/{user_id}",
        headers=auth_headers(admin_token),
        json={
            "vacation_days_per_year": 30,
            "vacation_days_available": available,
            "vacation_days_carryover": carryover,
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _admin_id(client: TestClient, admin_token: str) -> int:
    me = client.get("/api/auth/me", headers=auth_headers(admin_token))
    assert me.status_code == 200, me.text
    return me.json()["id"]


def _booked(client: TestClient, admin_token: str, start: str, end: str) -> dict:
    """Create a vacation request and approve it, so entitlement is deducted."""
    created = client.post(
        "/api/time/vacation-requests",
        headers=auth_headers(admin_token),
        json={"start_date": start, "end_date": end},
    )
    assert created.status_code == 200, created.text
    row = created.json()
    approved = client.patch(
        f"/api/time/vacation-requests/{row['id']}",
        headers=auth_headers(admin_token),
        json={"status": "approved"},
    )
    assert approved.status_code == 200, approved.text
    return approved.json()


def _remove(client: TestClient, admin_token: str, user_id: int, day: str):
    return client.post(
        "/api/time/vacation-days/remove",
        headers=auth_headers(admin_token),
        json={"user_id": user_id, "day": day},
    )


def _requests_for(client: TestClient, admin_token: str, user_id: int) -> list[dict]:
    listed = client.get(
        f"/api/time/vacation-requests?user_id={user_id}", headers=auth_headers(admin_token)
    )
    assert listed.status_code == 200, listed.text
    return [r for r in listed.json() if r["user_id"] == user_id]


# ── The reported case ─────────────────────────────────────────────────────


def test_removing_a_worked_day_refunds_it_and_splits_the_week(
    client: TestClient, admin_token: str
):
    """Booked Mon-Fri, worked the Wednesday: that one day comes back.

    2026-03-02..06 is a Mon-Fri week with no NRW public holiday, so it costs
    exactly 5 days.
    """
    user_id = _admin_id(client, admin_token)
    _set_balance(client, admin_token, user_id, available=20)
    _booked(client, admin_token, "2026-03-02", "2026-03-06")

    before = client.get("/api/time/vacation-requests", headers=auth_headers(admin_token))
    assert before.status_code == 200

    removed = _remove(client, admin_token, user_id, "2026-03-04")
    assert removed.status_code == 200, removed.text
    body = removed.json()

    assert body["was_deductible"] is True
    assert body["refunded_days"] == 1
    assert body["split_into_second_request"] is True
    # 20 - 5 booked = 15, then one day back = 16.
    assert body["balance"]["vacation_days_available"] == 16

    # The week is now Mon-Tue plus Thu-Fri, and Wednesday belongs to neither.
    ranges = sorted((r["start_date"], r["end_date"]) for r in _requests_for(client, admin_token, user_id))
    assert ranges == [("2026-03-02", "2026-03-03"), ("2026-03-05", "2026-03-06")]


def test_removing_the_only_day_deletes_the_request(client: TestClient, admin_token: str):
    user_id = _admin_id(client, admin_token)
    _set_balance(client, admin_token, user_id, available=10)
    _booked(client, admin_token, "2026-03-02", "2026-03-02")

    removed = _remove(client, admin_token, user_id, "2026-03-02")
    assert removed.status_code == 200, removed.text
    body = removed.json()

    assert body["request_deleted"] is True
    assert body["refunded_days"] == 1
    assert body["balance"]["vacation_days_available"] == 10
    assert _requests_for(client, admin_token, user_id) == []


def test_removing_the_first_day_trims_instead_of_splitting(
    client: TestClient, admin_token: str
):
    user_id = _admin_id(client, admin_token)
    _set_balance(client, admin_token, user_id, available=20)
    _booked(client, admin_token, "2026-03-02", "2026-03-06")

    removed = _remove(client, admin_token, user_id, "2026-03-02")
    assert removed.status_code == 200, removed.text
    assert removed.json()["split_into_second_request"] is False

    ranges = [(r["start_date"], r["end_date"]) for r in _requests_for(client, admin_token, user_id)]
    assert ranges == [("2026-03-03", "2026-03-06")]


# ── Accounting must not invent or lose days ───────────────────────────────


def test_carryover_is_refunded_only_after_current_year_days_are_exhausted(
    client: TestClient, admin_token: str
):
    """Approval consumes carryover first, so a refund must return the other bucket.

    With 2 carryover and 5 available, a 3-day booking consumes 2 carryover + 1
    available. Removing one day gives back the *available* day, leaving carryover
    fully consumed across the two days that remain — which is exactly what a
    fresh approval of those two days would have recorded.
    """
    user_id = _admin_id(client, admin_token)
    _set_balance(client, admin_token, user_id, available=5, carryover=2)
    _booked(client, admin_token, "2026-03-02", "2026-03-04")

    removed = _remove(client, admin_token, user_id, "2026-03-03")
    assert removed.status_code == 200, removed.text
    body = removed.json()

    assert body["refunded_available_days"] == 1
    assert body["refunded_carryover_days"] == 0
    assert body["balance"]["vacation_days_carryover"] == 0
    assert body["balance"]["vacation_days_available"] == 5


def test_removing_a_weekend_day_refunds_nothing(client: TestClient, admin_token: str):
    """A Saturday inside a booked range never cost entitlement.

    2026-03-07 is a Saturday. It still leaves the range, but giving a day back
    would hand out vacation that was never spent.
    """
    user_id = _admin_id(client, admin_token)
    _set_balance(client, admin_token, user_id, available=20)
    _booked(client, admin_token, "2026-03-05", "2026-03-10")
    balance_after_booking = client.get(
        "/api/time/vacation-requests", headers=auth_headers(admin_token)
    )
    assert balance_after_booking.status_code == 200

    removed = _remove(client, admin_token, user_id, "2026-03-07")
    assert removed.status_code == 200, removed.text
    body = removed.json()

    assert body["was_deductible"] is False
    assert body["refunded_days"] == 0


def test_total_deducted_days_stay_consistent_after_a_split(
    client: TestClient, admin_token: str
):
    """The two halves together must still account for every remaining day."""
    from app.core.db import SessionLocal
    from app.models.entities import VacationRequest

    user_id = _admin_id(client, admin_token)
    _set_balance(client, admin_token, user_id, available=20)
    _booked(client, admin_token, "2026-03-02", "2026-03-06")

    assert _remove(client, admin_token, user_id, "2026-03-04").status_code == 200

    with SessionLocal() as db:
        rows = db.scalars(
            sa.select(VacationRequest).where(VacationRequest.user_id == user_id)
        ).all()
        total = sum(r.deducted_available_days + r.deducted_carryover_days for r in rows)
    # 5 booked working days minus the one removed.
    assert total == 4


# ── Guards ────────────────────────────────────────────────────────────────


def test_day_without_approved_vacation_is_404(client: TestClient, admin_token: str):
    user_id = _admin_id(client, admin_token)
    _set_balance(client, admin_token, user_id, available=10)
    response = _remove(client, admin_token, user_id, "2026-03-02")
    assert response.status_code == 404


def test_non_reviewer_cannot_remove_a_vacation_day(client: TestClient, admin_token: str):
    """Only a managing role may edit someone else's booked vacation."""
    created = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={
            "email": "worker-vac@example.com",
            "password": "Password123!",
            "full_name": "Worker",
            "role": "employee",
        },
    )
    assert created.status_code == 200, created.text
    worker = created.json()

    login = client.post(
        "/api/auth/login",
        json={"email": "worker-vac@example.com", "password": "Password123!"},
    )
    assert login.status_code == 200, login.text
    # The token rides on a response header here, not in the JSON body.
    worker_token = login.headers["X-Access-Token"]

    response = client.post(
        "/api/time/vacation-days/remove",
        headers=auth_headers(worker_token),
        json={"user_id": worker["id"], "day": "2026-03-02"},
    )
    assert response.status_code == 403
