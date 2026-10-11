"""Vacation that runs over New Year.

The owner's report: a request for 29.12.-05.01. was refused with "not enough
vacation days" although the old year still had enough left for its part and
the new year brings a fresh allowance for the rest. Approval used to charge
every working day of the request to the balance of the year it was approved
in.

Now the days of a later year are only *planned* at approval
(``pending_future_days``) and come off that year's balance when the yearly
rollover reaches it. These tests travel in time by patching the router's
``utcnow`` (the clock the balance year is read from) -- never the real date.

Calendar used throughout (NRW):

* 2026-12-28 Mon .. 2026-12-31 Thu are working days; 24.12. and 31.12. are not
  public holidays, 25./26.12. are (Fri/Sat).
* 2027-01-01 Fri is Neujahr; 2027-01-04 Mon .. 2027-01-08 Fri are working days.

So 29.12.2026-05.01.2027 costs 3 days in 2026 and 2 days in 2027.
"""

from __future__ import annotations

from datetime import date, datetime

import pytest
import sqlalchemy as sa
from fastapi.testclient import TestClient


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def travel(monkeypatch):
    """Move the time-tracking clock to a given day (10:00 UTC)."""
    from app.routers import time_tracking

    def _to(year: int, month: int, day: int) -> None:
        monkeypatch.setattr(time_tracking, "utcnow", lambda: datetime(year, month, day, 10, 0, 0))

    return _to


def _employee(client: TestClient, admin_token: str, email: str) -> tuple[int, str]:
    created = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={"email": email, "password": "Password123!", "full_name": "Urlaub Test", "role": "employee"},
    )
    assert created.status_code == 200, created.text
    login = client.post("/api/auth/login", json={"email": email, "password": "Password123!"})
    assert login.status_code == 200, login.text
    return created.json()["id"], login.headers["X-Access-Token"]


def _set_balance(
    client: TestClient, admin_token: str, user_id: int, *, per_year: float, available: float, carryover: float = 0
) -> None:
    resp = client.patch(
        f"/api/time/vacation-balance/{user_id}",
        headers=auth_headers(admin_token),
        json={
            "vacation_days_per_year": per_year,
            "vacation_days_available": available,
            "vacation_days_carryover": carryover,
        },
    )
    assert resp.status_code == 200, resp.text


def _request(client: TestClient, token: str, start: str, end: str) -> int:
    created = client.post(
        "/api/time/vacation-requests", headers=auth_headers(token), json={"start_date": start, "end_date": end}
    )
    assert created.status_code == 200, created.text
    return created.json()["id"]


def _review(client: TestClient, admin_token: str, request_id: int, status: str):
    return client.patch(
        f"/api/time/vacation-requests/{request_id}", headers=auth_headers(admin_token), json={"status": status}
    )


def _approve(client: TestClient, admin_token: str, request_id: int) -> None:
    resp = _review(client, admin_token, request_id, "approved")
    assert resp.status_code == 200, resp.text


def _balance(client: TestClient, token: str) -> dict:
    resp = client.get("/api/time/current", headers=auth_headers(token))
    assert resp.status_code == 200, resp.text
    return resp.json()


def _row(request_id: int) -> dict:
    from app.core.db import SessionLocal
    from app.models.entities import VacationRequest

    with SessionLocal() as db:
        row = db.get(VacationRequest, request_id)
        assert row is not None
        return {
            "start": row.start_date,
            "end": row.end_date,
            "status": row.status,
            "available": row.deducted_available_days,
            "carryover": row.deducted_carryover_days,
            "pending": row.pending_future_days,
        }


def _rows_for(user_id: int) -> list[dict]:
    from app.core.db import SessionLocal
    from app.models.entities import VacationRequest

    with SessionLocal() as db:
        rows = db.scalars(
            sa.select(VacationRequest)
            .where(VacationRequest.user_id == user_id)
            .order_by(VacationRequest.start_date.asc())
        ).all()
        return [
            {
                "start": r.start_date,
                "end": r.end_date,
                "available": r.deducted_available_days,
                "carryover": r.deducted_carryover_days,
                "pending": r.pending_future_days,
            }
            for r in rows
        ]


def _remove_day(client: TestClient, admin_token: str, user_id: int, day: str) -> dict:
    resp = client.post(
        "/api/time/vacation-days/remove", headers=auth_headers(admin_token), json={"user_id": user_id, "day": day}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


# ── Working days per calendar year ───────────────────────────────────────


def test_working_days_are_split_by_calendar_year():
    from app.routers.time_tracking import _vacation_days_by_year, _vacation_days_requested

    by_year = _vacation_days_by_year(date(2026, 12, 29), date(2027, 1, 5))
    assert by_year == {2026: 3, 2027: 2}
    assert sum(by_year.values()) == _vacation_days_requested(date(2026, 12, 29), date(2027, 1, 5))

    # Three calendar years: the whole of 2027 sits in the middle.
    long_range = _vacation_days_by_year(date(2026, 12, 28), date(2028, 1, 5))
    assert sorted(long_range) == [2026, 2027, 2028]
    assert long_range[2026] == 4
    assert sum(long_range.values()) == _vacation_days_requested(date(2026, 12, 28), date(2028, 1, 5))

    # One year only, and an empty range.
    assert _vacation_days_by_year(date(2026, 3, 2), date(2026, 3, 6)) == {2026: 5}
    assert _vacation_days_by_year(date(2026, 3, 6), date(2026, 3, 2)) == {}


# ── Approval ─────────────────────────────────────────────────────────────


def test_owners_case_over_new_year_is_approved_and_only_this_years_part_is_deducted(
    client: TestClient, admin_token: str, travel
):
    """29.12.-05.01. with exactly the 3 days left that 2026 needs: approved.

    Before, all 5 working days were checked against 2026's 3 and refused.
    """
    travel(2026, 12, 1)
    user_id, token = _employee(client, admin_token, "urlaub-owner@example.com")
    _set_balance(client, admin_token, user_id, per_year=30, available=3)

    request_id = _request(client, token, "2026-12-29", "2027-01-05")
    _approve(client, admin_token, request_id)

    balance = _balance(client, token)
    assert balance["vacation_days_available"] == 0
    assert balance["vacation_days_total_remaining"] == 0
    assert balance["vacation_days_planned_next_year"] == 2
    assert _row(request_id) == {
        "start": date(2026, 12, 29),
        "end": date(2027, 1, 5),
        "status": "approved",
        "available": 3,
        "carryover": 0,
        "pending": 2,
    }


def test_refused_in_german_when_this_years_part_is_short(client: TestClient, admin_token: str, travel):
    travel(2026, 12, 1)
    user_id, token = _employee(client, admin_token, "urlaub-short-now@example.com")
    _set_balance(client, admin_token, user_id, per_year=30, available=2)

    request_id = _request(client, token, "2026-12-29", "2027-01-05")
    refused = _review(client, admin_token, request_id, "approved")

    assert refused.status_code == 400
    assert refused.json()["detail"] == "Nicht genug Urlaubstage für 2026: 2 frei, 3 beantragt."
    assert _row(request_id)["status"] == "pending"
    assert _balance(client, token)["vacation_days_available"] == 2


def test_refused_when_next_years_part_exceeds_the_allowance(client: TestClient, admin_token: str, travel):
    """Next year's part is checked against the allowance plus what 2026 carries over.

    30.12.-15.01.: 2 days in 2026, 10 in 2027. With 5 per year and 3 left now,
    2027 can hold 5 + (3 - 2) = 6.
    """
    travel(2026, 12, 1)
    user_id, token = _employee(client, admin_token, "urlaub-short-next@example.com")
    _set_balance(client, admin_token, user_id, per_year=5, available=3)

    request_id = _request(client, token, "2026-12-30", "2027-01-15")
    refused = _review(client, admin_token, request_id, "approved")

    assert refused.status_code == 400
    assert refused.json()["detail"] == "Nicht genug Urlaubstage für 2027: 6 frei, 10 beantragt."
    balance = _balance(client, token)
    assert balance["vacation_days_available"] == 3
    assert balance["vacation_days_planned_next_year"] == 0


def test_days_already_planned_for_next_year_by_other_requests_count_against_it(
    client: TestClient, admin_token: str, travel
):
    travel(2026, 12, 1)
    user_id, token = _employee(client, admin_token, "urlaub-next-planned@example.com")
    _set_balance(client, admin_token, user_id, per_year=5, available=3)

    planned = _request(client, token, "2027-01-11", "2027-01-14")  # 4 days, all 2027
    _approve(client, admin_token, planned)

    # 30.12.-06.01.: 2 days now, 3 in 2027 -- but 2027 only has 5 + 1 - 4 = 2 free.
    crossing = _request(client, token, "2026-12-30", "2027-01-06")
    refused = _review(client, admin_token, crossing, "approved")
    assert refused.status_code == 400
    assert refused.json()["detail"] == "Nicht genug Urlaubstage für 2027: 2 frei, 3 beantragt."


def test_years_after_next_are_checked_against_the_plain_allowance(client: TestClient, admin_token: str, travel):
    travel(2026, 6, 1)
    user_id, token = _employee(client, admin_token, "urlaub-two-years@example.com")
    _set_balance(client, admin_token, user_id, per_year=5, available=20)

    # 2028-01-10..17 = Mon-Fri + Mon = 6 working days, two years ahead.
    request_id = _request(client, token, "2028-01-10", "2028-01-17")
    refused = _review(client, admin_token, request_id, "approved")
    assert refused.status_code == 400
    assert refused.json()["detail"] == "Nicht genug Urlaubstage für 2028: 5 frei, 6 beantragt."


def test_request_entirely_in_next_year_deducts_nothing_now_and_is_not_legacy(
    client: TestClient, admin_token: str, travel
):
    """Approved with 0/0 deducted, but it is planned -- not an old pre-tracking booking.

    The legacy path subtracts every approved 0/0 request on the fly; it must
    leave this one alone or 2026's balance would show 5 days fewer.
    """
    travel(2026, 11, 2)
    user_id, token = _employee(client, admin_token, "urlaub-all-next@example.com")
    _set_balance(client, admin_token, user_id, per_year=30, available=10)

    request_id = _request(client, token, "2027-01-11", "2027-01-15")
    _approve(client, admin_token, request_id)

    balance = _balance(client, token)
    assert balance["vacation_days_available"] == 10
    assert balance["vacation_days_total_remaining"] == 10
    assert balance["vacation_days_planned_next_year"] == 5
    row = _row(request_id)
    assert (row["available"], row["carryover"], row["pending"]) == (0, 0, 5)


# ── Rollover ─────────────────────────────────────────────────────────────


def test_rollover_deducts_planned_days_from_the_new_year(client: TestClient, admin_token: str, travel):
    """The owner's request, then New Year: 2027's 2 days come off 2027's balance."""
    travel(2026, 12, 1)
    user_id, token = _employee(client, admin_token, "urlaub-rollover@example.com")
    _set_balance(client, admin_token, user_id, per_year=30, available=3)
    request_id = _request(client, token, "2026-12-29", "2027-01-05")
    _approve(client, admin_token, request_id)

    travel(2027, 1, 2)
    balance = _balance(client, token)
    assert balance["vacation_days_carryover"] == 0
    assert balance["vacation_days_available"] == 28
    assert balance["vacation_days_total_remaining"] == 28
    assert balance["vacation_days_planned_next_year"] == 0
    row = _row(request_id)
    assert (row["available"], row["carryover"], row["pending"]) == (5, 0, 0)


def test_rollover_takes_planned_days_from_carryover_first(client: TestClient, admin_token: str, travel):
    travel(2026, 11, 2)
    user_id, token = _employee(client, admin_token, "urlaub-rollover-carry@example.com")
    _set_balance(client, admin_token, user_id, per_year=30, available=10)
    request_id = _request(client, token, "2027-01-11", "2027-01-15")
    _approve(client, admin_token, request_id)

    travel(2027, 1, 4)
    balance = _balance(client, token)
    # 10 left in 2026 carry over; the 5 planned days come out of them first.
    assert balance["vacation_days_carryover"] == 5
    assert balance["vacation_days_available"] == 30
    assert balance["vacation_days_total_remaining"] == 35
    row = _row(request_id)
    assert (row["available"], row["carryover"], row["pending"]) == (0, 5, 0)


def test_rollover_over_a_multi_year_gap_applies_each_year_in_turn(client: TestClient, admin_token: str, travel):
    """Approved in 2026 for 29.12.2027-05.01.2028; nobody looks until February 2028.

    3 days fall in 2027 and 3 in 2028 (01.01.2028 is a Saturday). The gap is
    walked year by year: 2027 takes its 3 from 2026's carryover, 2028 takes
    its 3 from 2027's.
    """
    travel(2026, 6, 1)
    user_id, token = _employee(client, admin_token, "urlaub-gap@example.com")
    _set_balance(client, admin_token, user_id, per_year=30, available=10)
    request_id = _request(client, token, "2027-12-29", "2028-01-05")
    _approve(client, admin_token, request_id)

    balance = _balance(client, token)
    assert balance["vacation_days_total_remaining"] == 10
    assert balance["vacation_days_planned_next_year"] == 3
    assert _row(request_id)["pending"] == 6

    travel(2028, 2, 1)
    balance = _balance(client, token)
    # 2027: carryover 10 - 3 = 7, available 30. 2028: carryover 30 - 3 = 27, available 30.
    assert balance["vacation_days_carryover"] == 27
    assert balance["vacation_days_available"] == 30
    assert balance["vacation_days_planned_next_year"] == 0
    row = _row(request_id)
    assert (row["available"], row["carryover"], row["pending"]) == (0, 6, 0)


def test_rollover_never_drives_the_balance_below_zero(client: TestClient, admin_token: str, travel):
    """If the balance was cut by hand after approval, the rollover clamps at 0."""
    travel(2026, 11, 2)
    user_id, token = _employee(client, admin_token, "urlaub-clamp@example.com")
    _set_balance(client, admin_token, user_id, per_year=30, available=10)
    request_id = _request(client, token, "2027-01-04", "2027-01-08")
    _approve(client, admin_token, request_id)
    # An admin lowers next year's allowance to 2 and empties this year.
    _set_balance(client, admin_token, user_id, per_year=2, available=0)

    travel(2027, 1, 11)
    balance = _balance(client, token)
    assert balance["vacation_days_carryover"] == 0
    assert balance["vacation_days_available"] == 0
    row = _row(request_id)
    # The 3 days 2027 could not cover stay pending: approved, never charged.
    assert (row["available"], row["carryover"], row["pending"]) == (2, 0, 3)


# ── Next year's plan versus this year's spending ─────────────────────────


def _plan_38_days_for_2027(client: TestClient, admin_token: str, token: str) -> tuple[int, int]:
    """30 days in summer and 8 in autumn 2027 -- approved against 30 + 2026's 10 left."""
    summer = _request(client, token, "2027-06-01", "2027-07-12")  # 30 working days
    autumn = _request(client, token, "2027-09-06", "2027-09-15")  # 8 working days
    _approve(client, admin_token, summer)
    _approve(client, admin_token, autumn)
    return summer, autumn


def _deducted(request_id: int) -> tuple[int, int, int]:
    row = _row(request_id)
    return row["available"], row["carryover"], row["pending"]


def test_spending_this_years_leftover_cannot_strand_days_planned_for_next_year(
    client: TestClient, admin_token: str, travel
):
    """2027 holds 38 planned days only because 2026 carries 10 over.

    Spending those 10 in November 2026 was approved without looking at 2027;
    New Year then had 30 for 38 days and silently dropped 8, the request read
    as a pre-tracking booking, and 2028 showed 22 instead of 30.
    """
    travel(2026, 10, 12)
    user_id, token = _employee(client, admin_token, "urlaub-strand@example.com")
    _set_balance(client, admin_token, user_id, per_year=30, available=10)
    summer, autumn = _plan_38_days_for_2027(client, admin_token, token)
    assert _balance(client, token)["vacation_days_planned_next_year"] == 38

    november = _request(client, token, "2026-11-02", "2026-11-13")  # 10 days, all in 2026
    refused = _review(client, admin_token, november, "approved")
    assert refused.status_code == 400
    assert refused.json()["detail"] == (
        "Nicht genug Urlaubstage für 2027: dort sind schon 38 Tage genehmigt, "
        "nach dieser Genehmigung gäbe es samt Resturlaub aus 2026 nur 30."
    )
    assert _row(november)["status"] == "pending"
    assert _balance(client, token)["vacation_days_available"] == 10

    # Two days still leave the 8 that 2027 needs on top of its 30.
    short_break = _request(client, token, "2026-11-02", "2026-11-03")
    _approve(client, admin_token, short_break)
    assert _balance(client, token)["vacation_days_available"] == 8

    travel(2027, 1, 4)
    balance = _balance(client, token)
    assert balance["vacation_days_total_remaining"] == 0
    assert _deducted(summer) == (22, 8, 0)
    assert _deducted(autumn) == (8, 0, 0)

    travel(2028, 1, 4)
    balance = _balance(client, token)
    assert balance["vacation_days_available"] == 30
    assert balance["vacation_days_total_remaining"] == 30


def test_days_paid_from_carryover_leave_next_years_plan_alone(client: TestClient, admin_token: str, travel):
    """Carryover expires at New Year, so spending it costs 2027 nothing; available does."""
    travel(2026, 10, 12)
    user_id, token = _employee(client, admin_token, "urlaub-strand-carry@example.com")
    _set_balance(client, admin_token, user_id, per_year=30, available=10, carryover=3)
    # 40 days in 2027 = 30 + the 10 available that 2026 will carry over.
    _approve(client, admin_token, _request(client, token, "2027-06-01", "2027-07-12"))
    _approve(client, admin_token, _request(client, token, "2027-09-06", "2027-09-17"))

    _approve(client, admin_token, _request(client, token, "2026-11-02", "2026-11-04"))  # 3 days of carryover
    balance = _balance(client, token)
    assert (balance["vacation_days_carryover"], balance["vacation_days_available"]) == (0, 10)

    one_more = _request(client, token, "2026-11-09", "2026-11-09")
    refused = _review(client, admin_token, one_more, "approved")
    assert refused.status_code == 400
    assert refused.json()["detail"] == (
        "Nicht genug Urlaubstage für 2027: dort sind schon 40 Tage genehmigt, "
        "nach dieser Genehmigung gäbe es samt Resturlaub aus 2026 nur 39."
    )


def test_days_the_new_year_cannot_cover_stay_planned_and_never_turn_legacy(
    client: TestClient, admin_token: str, travel
):
    """An admin empties 2026 by hand after 2027's 38 days were approved against it.

    The rollover can charge only 30. The 8 it cannot cover stay pending on
    their request -- never charged, never refunded, and never mistaken for a
    pre-tracking booking that would come off 2028 as well.
    """
    travel(2026, 10, 12)
    user_id, token = _employee(client, admin_token, "urlaub-hand-cut@example.com")
    _set_balance(client, admin_token, user_id, per_year=30, available=10)
    summer, autumn = _plan_38_days_for_2027(client, admin_token, token)
    _set_balance(client, admin_token, user_id, per_year=30, available=0)

    travel(2027, 1, 4)
    balance = _balance(client, token)
    assert balance["vacation_days_total_remaining"] == 0
    assert balance["vacation_days_planned_next_year"] == 0
    assert _deducted(summer) == (30, 0, 0)
    assert _deducted(autumn) == (0, 0, 8)

    travel(2028, 1, 4)
    balance = _balance(client, token)
    assert balance["vacation_days_available"] == 30
    assert balance["vacation_days_total_remaining"] == 30
    assert _deducted(autumn) == (0, 0, 8)

    # Rejecting it gives nothing back: nothing was ever taken for it.
    rejected = _review(client, admin_token, autumn, "rejected")
    assert rejected.status_code == 200, rejected.text
    assert _balance(client, token)["vacation_days_total_remaining"] == 30
    assert _deducted(autumn) == (0, 0, 0)


def test_removing_a_day_the_new_year_could_not_cover_refunds_nothing(
    client: TestClient, admin_token: str, travel
):
    """2027 covered 2 of 5 days after a hand cut; 3 are approved but uncovered.

    A worked day gives back an uncovered day first -- it never cost anything --
    and a split hands the uncovered days to the half after the covered ones.
    """
    travel(2026, 11, 2)
    user_id, token = _employee(client, admin_token, "urlaub-remove-uncovered@example.com")
    _set_balance(client, admin_token, user_id, per_year=30, available=10)
    request_id = _request(client, token, "2027-01-04", "2027-01-08")
    _approve(client, admin_token, request_id)
    _set_balance(client, admin_token, user_id, per_year=2, available=0)
    travel(2027, 1, 11)
    assert _balance(client, token)["vacation_days_total_remaining"] == 0
    assert _deducted(request_id) == (2, 0, 3)

    body = _remove_day(client, admin_token, user_id, "2027-01-08")
    assert body["was_deductible"] is True
    assert body["refunded_days"] == 0
    assert body["released_planned_days"] == 0
    assert body["balance"]["vacation_days_total_remaining"] == 0
    row = _row(request_id)
    assert (row["end"], row["available"], row["pending"]) == (date(2027, 1, 7), 2, 2)

    body = _remove_day(client, admin_token, user_id, "2027-01-05")
    assert body["split_into_second_request"] is True
    assert body["refunded_days"] == 0
    rows = _rows_for(user_id)
    assert [(r["start"], r["end"], r["available"], r["pending"]) for r in rows] == [
        (date(2027, 1, 4), date(2027, 1, 4), 1, 0),
        (date(2027, 1, 6), date(2027, 1, 7), 1, 1),
    ]

    # Uncovered days used up: the next worked day is a real refund.
    _remove_day(client, admin_token, user_id, "2027-01-07")
    body = _remove_day(client, admin_token, user_id, "2027-01-06")
    assert body["refunded_days"] == 1
    assert body["balance"]["vacation_days_total_remaining"] == 1


def test_splitting_off_a_planned_day_keeps_uncovered_days_with_their_own_dates(
    client: TestClient, admin_token: str, travel
):
    """27.12.2027-07.01.2028: 5 days in 2027 (2 covered after a hand cut, 3 not), 5 planned for 2028.

    A worked 05.01.2028 splits it. The head (27.12.-04.01.) keeps its own 2
    days planned for 2028 plus the 3 uncovered 2027 days; the tail (06.-07.01.)
    only its own 2 planned days -- so nothing uncovered lingers on the tail
    once 2028 has charged it.
    """
    travel(2026, 6, 1)
    user_id, token = _employee(client, admin_token, "urlaub-split-uncovered@example.com")
    _set_balance(client, admin_token, user_id, per_year=30, available=10)
    request_id = _request(client, token, "2027-12-27", "2028-01-07")
    _approve(client, admin_token, request_id)
    _set_balance(client, admin_token, user_id, per_year=2, available=0)
    travel(2027, 6, 1)
    assert _balance(client, token)["vacation_days_planned_next_year"] == 5
    assert _deducted(request_id) == (2, 0, 8)

    body = _remove_day(client, admin_token, user_id, "2028-01-05")
    assert body["released_planned_days"] == 1
    assert body["balance"]["vacation_days_planned_next_year"] == 4
    rows = _rows_for(user_id)
    assert [(r["start"], r["end"], r["available"], r["pending"]) for r in rows] == [
        (date(2027, 12, 27), date(2028, 1, 4), 2, 5),
        (date(2028, 1, 6), date(2028, 1, 7), 0, 2),
    ]

    _set_balance(client, admin_token, user_id, per_year=30, available=0)
    travel(2028, 2, 1)
    balance = _balance(client, token)
    assert (balance["vacation_days_carryover"], balance["vacation_days_available"]) == (0, 26)
    rows = _rows_for(user_id)
    assert [(r["available"], r["pending"]) for r in rows] == [(4, 3), (2, 0)]


# ── Rejection ────────────────────────────────────────────────────────────


def test_rejecting_before_new_year_refunds_now_and_drops_the_plan(client: TestClient, admin_token: str, travel):
    travel(2026, 12, 1)
    user_id, token = _employee(client, admin_token, "urlaub-reject-before@example.com")
    _set_balance(client, admin_token, user_id, per_year=30, available=10)
    request_id = _request(client, token, "2026-12-29", "2027-01-05")
    _approve(client, admin_token, request_id)
    assert _balance(client, token)["vacation_days_available"] == 7

    rejected = _review(client, admin_token, request_id, "rejected")
    assert rejected.status_code == 200, rejected.text
    balance = _balance(client, token)
    assert balance["vacation_days_available"] == 10
    assert balance["vacation_days_planned_next_year"] == 0
    row = _row(request_id)
    assert (row["available"], row["carryover"], row["pending"]) == (0, 0, 0)

    # New Year finds nothing left to deduct.
    travel(2027, 1, 4)
    balance = _balance(client, token)
    assert balance["vacation_days_carryover"] == 10
    assert balance["vacation_days_available"] == 30


def test_rejecting_after_new_year_refunds_both_years(client: TestClient, admin_token: str, travel):
    travel(2026, 12, 1)
    user_id, token = _employee(client, admin_token, "urlaub-reject-after@example.com")
    _set_balance(client, admin_token, user_id, per_year=30, available=10)
    request_id = _request(client, token, "2026-12-29", "2027-01-05")
    _approve(client, admin_token, request_id)

    travel(2027, 1, 7)
    balance = _balance(client, token)
    # 2026 left 7 → carryover 7, minus the 2 planned days of 2027.
    assert (balance["vacation_days_carryover"], balance["vacation_days_available"]) == (5, 30)

    rejected = _review(client, admin_token, request_id, "rejected")
    assert rejected.status_code == 200, rejected.text
    balance = _balance(client, token)
    # Every day comes back: 3 to available (where 2026 took them), 2 to carryover.
    assert balance["vacation_days_total_remaining"] == 40
    assert (balance["vacation_days_carryover"], balance["vacation_days_available"]) == (7, 33)
    row = _row(request_id)
    assert (row["available"], row["carryover"], row["pending"]) == (0, 0, 0)


# ── Removing single days ─────────────────────────────────────────────────


def test_removing_a_planned_next_year_day_releases_it_instead_of_refunding(
    client: TestClient, admin_token: str, travel
):
    travel(2026, 12, 1)
    user_id, token = _employee(client, admin_token, "urlaub-remove-next@example.com")
    _set_balance(client, admin_token, user_id, per_year=30, available=10)
    request_id = _request(client, token, "2026-12-29", "2027-01-05")
    _approve(client, admin_token, request_id)

    body = _remove_day(client, admin_token, user_id, "2027-01-05")
    assert body["was_deductible"] is True
    assert body["refunded_days"] == 0
    assert body["released_planned_days"] == 1
    # 2026's balance is untouched -- the day had never come off it.
    assert body["balance"]["vacation_days_available"] == 7
    assert body["balance"]["vacation_days_planned_next_year"] == 1
    row = _row(request_id)
    assert (row["end"], row["available"], row["pending"]) == (date(2027, 1, 4), 3, 1)


def test_removing_a_this_year_day_refunds_it_and_keeps_the_plan(client: TestClient, admin_token: str, travel):
    travel(2026, 12, 1)
    user_id, token = _employee(client, admin_token, "urlaub-remove-now@example.com")
    _set_balance(client, admin_token, user_id, per_year=30, available=10)
    request_id = _request(client, token, "2026-12-29", "2027-01-05")
    _approve(client, admin_token, request_id)

    body = _remove_day(client, admin_token, user_id, "2026-12-29")
    assert body["refunded_days"] == 1
    assert body["released_planned_days"] == 0
    assert body["balance"]["vacation_days_available"] == 8
    assert body["balance"]["vacation_days_planned_next_year"] == 2
    row = _row(request_id)
    assert (row["start"], row["available"], row["pending"]) == (date(2026, 12, 30), 2, 2)


def test_splitting_across_new_year_splits_deduction_and_plan_by_date(
    client: TestClient, admin_token: str, travel
):
    """28.12.-08.01. (4 days 2026, 5 days 2027), the 30.12. was worked.

    Head 28.-29.12. keeps 2 deducted days; tail 31.12.-08.01. keeps 31.12.'s
    deducted day and all 5 planned days of 2027. Nothing invented, nothing lost.
    """
    travel(2026, 12, 1)
    user_id, token = _employee(client, admin_token, "urlaub-split@example.com")
    _set_balance(client, admin_token, user_id, per_year=30, available=10)
    request_id = _request(client, token, "2026-12-28", "2027-01-08")
    _approve(client, admin_token, request_id)

    body = _remove_day(client, admin_token, user_id, "2026-12-30")
    assert body["split_into_second_request"] is True
    assert body["refunded_days"] == 1
    assert body["balance"]["vacation_days_available"] == 7
    assert body["balance"]["vacation_days_planned_next_year"] == 5

    rows = _rows_for(user_id)
    assert [(r["start"], r["end"], r["available"], r["pending"]) for r in rows] == [
        (date(2026, 12, 28), date(2026, 12, 29), 2, 0),
        (date(2026, 12, 31), date(2027, 1, 8), 1, 5),
    ]

    # A worked day in the middle of the 2027 part splits the plan as well.
    body = _remove_day(client, admin_token, user_id, "2027-01-06")
    assert body["released_planned_days"] == 1
    assert body["refunded_days"] == 0
    assert body["balance"]["vacation_days_planned_next_year"] == 4
    rows = _rows_for(user_id)
    assert [(r["start"], r["end"], r["available"], r["pending"]) for r in rows] == [
        (date(2026, 12, 28), date(2026, 12, 29), 2, 0),
        (date(2026, 12, 31), date(2027, 1, 5), 1, 2),
        (date(2027, 1, 7), date(2027, 1, 8), 0, 2),
    ]

    # And the rollover later charges exactly the 4 days still planned.
    travel(2027, 1, 11)
    balance = _balance(client, token)
    assert balance["vacation_days_carryover"] == 3
    assert balance["vacation_days_available"] == 30


def test_removing_a_day_after_new_year_refunds_from_the_current_balance(
    client: TestClient, admin_token: str, travel
):
    """Once the rollover has charged 2027's days they are ordinary deducted days."""
    travel(2026, 12, 1)
    user_id, token = _employee(client, admin_token, "urlaub-remove-after@example.com")
    _set_balance(client, admin_token, user_id, per_year=30, available=10)
    request_id = _request(client, token, "2026-12-29", "2027-01-05")
    _approve(client, admin_token, request_id)

    travel(2027, 1, 7)
    body = _remove_day(client, admin_token, user_id, "2027-01-05")
    assert body["refunded_days"] == 1
    assert body["released_planned_days"] == 0
    assert body["balance"]["vacation_days_total_remaining"] == 36


# ── Old bookings ─────────────────────────────────────────────────────────


def test_legacy_requests_are_still_subtracted_on_the_fly(client: TestClient, admin_token: str, travel):
    """A pre-tracking approved booking (0/0 deducted, nothing planned) still counts."""
    from app.core.db import SessionLocal
    from app.models.entities import VacationRequest

    travel(2026, 11, 2)
    user_id, token = _employee(client, admin_token, "urlaub-legacy@example.com")
    _set_balance(client, admin_token, user_id, per_year=30, available=10)
    with SessionLocal() as db:
        db.add(
            VacationRequest(
                user_id=user_id,
                start_date=date(2026, 11, 2),
                end_date=date(2026, 11, 4),
                status="approved",
            )
        )
        db.commit()

    assert _balance(client, token)["vacation_days_total_remaining"] == 7

    planned = _request(client, token, "2027-01-11", "2027-01-15")
    _approve(client, admin_token, planned)
    balance = _balance(client, token)
    assert balance["vacation_days_total_remaining"] == 7
    assert balance["vacation_days_planned_next_year"] == 5
