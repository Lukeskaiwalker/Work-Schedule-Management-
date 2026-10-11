"""The pure helpers behind vacation over New Year (services/vacation_years.py).

No database: the working-day counter is injected, so a plain Mon-Fri counter
stands in for the NRW calendar here.
"""

from __future__ import annotations

from datetime import date, timedelta
from types import SimpleNamespace

from app.services.vacation_years import (
    charge_planned_days_for_year,
    format_days,
    future_year_shortfall,
    planned_days_by_year,
    planned_days_of,
    shortfall_message,
    take_whole_days,
    vacation_days_by_year,
    year_shortfall_message,
)


def _weekdays(start: date, end: date) -> int:
    days = 0
    cursor = start
    while cursor <= end:
        if cursor.weekday() < 5:
            days += 1
        cursor += timedelta(days=1)
    return days


def _request(start: date, end: date, *, pending: int, available: int = 0, carryover: int = 0):
    return SimpleNamespace(
        start_date=start,
        end_date=end,
        pending_future_days=pending,
        deducted_available_days=available,
        deducted_carryover_days=carryover,
    )


def test_days_by_year_leaves_out_years_without_working_days():
    # 2027-01-01..03 is Fri..Sun: one weekday in 2027 (no holiday calendar here).
    assert vacation_days_by_year(date(2026, 12, 26), date(2027, 1, 3), _weekdays) == {2026: 4, 2027: 1}
    # Sat 26.12.2026 .. Sun 27.12.2026: nothing at all.
    assert vacation_days_by_year(date(2026, 12, 26), date(2026, 12, 27), _weekdays) == {}


def test_planned_days_are_attributed_earliest_year_first():
    by_year = {2026: 3, 2027: 5, 2028: 4}
    assert planned_days_by_year(9, by_year, 2026) == {2027: 5, 2028: 4}
    # Fewer planned than the later years hold: the earliest year gets them.
    assert planned_days_by_year(6, by_year, 2026) == {2027: 5, 2028: 1}
    # The balance year itself and earlier never take planned days.
    assert planned_days_by_year(4, by_year, 2027) == {2028: 4}
    assert planned_days_by_year(0, by_year, 2026) == {}


def test_planned_days_of_sums_requests_per_year():
    requests = [
        _request(date(2026, 12, 28), date(2027, 1, 8), pending=5),
        _request(date(2027, 2, 1), date(2027, 2, 2), pending=2),
        _request(date(2026, 3, 2), date(2026, 3, 6), pending=0, available=5),
    ]
    assert planned_days_of(requests, 2026, _weekdays) == {2027: 7}


def test_next_year_counts_the_carryover_but_later_years_only_the_allowance():
    common = dict(balance_year=2026, per_year=5, carried_into_next_year=3, planned_by_others={})
    assert future_year_shortfall(future_days={2027: 8}, **common) is None
    short = future_year_shortfall(future_days={2027: 9}, **common)
    assert (short.year, short.free, short.requested) == (2027, 8, 9)
    short = future_year_shortfall(future_days={2028: 6}, **common)
    assert (short.year, short.free, short.requested) == (2028, 5, 6)


def test_days_other_requests_planned_count_against_a_year():
    short = future_year_shortfall(
        future_days={2027: 3},
        balance_year=2026,
        per_year=5,
        carried_into_next_year=0,
        planned_by_others={2027: 4},
    )
    assert (short.year, short.free, short.requested) == (2027, 1, 3)
    # Over-planned by others: the message never shows a negative number.
    short = future_year_shortfall(
        future_days={2027: 1},
        balance_year=2026,
        per_year=5,
        carried_into_next_year=0,
        planned_by_others={2027: 7},
    )
    assert short.free == 0


def test_spending_this_years_carry_rechecks_next_year_without_days_there():
    """A request wholly in the balance year can still break next year.

    Days already approved for next year may count on what this year carries
    over; spending this year's available days shrinks that carry.
    """
    common = dict(future_days={}, balance_year=2026, per_year=30, planned_by_others={2027: 38})

    short = future_year_shortfall(carried_into_next_year=0, spends_next_years_carry=True, **common)
    assert (short.year, short.free, short.requested) == (2027, 0, 0)
    assert (short.planned, short.allowance) == (38, 30)
    # Enough carry left: fine.
    assert future_year_shortfall(carried_into_next_year=8, spends_next_years_carry=True, **common) is None
    # Untouched carry (paid from carryover): next year is not this approval's business.
    assert future_year_shortfall(carried_into_next_year=0, **common) is None


def test_year_shortfall_message_names_what_is_already_planned_when_nothing_is_requested():
    short = future_year_shortfall(
        future_days={},
        balance_year=2026,
        per_year=30,
        carried_into_next_year=0,
        planned_by_others={2027: 38},
        spends_next_years_carry=True,
    )
    assert year_shortfall_message(short) == (
        "Nicht genug Urlaubstage für 2027: dort sind schon 38 Tage genehmigt, "
        "nach dieser Genehmigung gäbe es samt Resturlaub aus 2026 nur 30."
    )
    one = future_year_shortfall(
        future_days={},
        balance_year=2026,
        per_year=0,
        carried_into_next_year=0,
        planned_by_others={2027: 1},
        spends_next_years_carry=True,
    )
    assert year_shortfall_message(one) == (
        "Nicht genug Urlaubstage für 2027: dort ist schon 1 Tag genehmigt, "
        "nach dieser Genehmigung gäbe es samt Resturlaub aus 2026 nur 0."
    )
    # A request with days of its own there keeps the short form.
    asked = future_year_shortfall(
        future_days={2027: 10},
        balance_year=2026,
        per_year=5,
        carried_into_next_year=1,
        planned_by_others={},
    )
    assert year_shortfall_message(asked) == "Nicht genug Urlaubstage für 2027: 6 frei, 10 beantragt."


def test_shortfall_message_is_german_with_decimal_comma():
    assert shortfall_message(2027, 6, 10) == "Nicht genug Urlaubstage für 2027: 6 frei, 10 beantragt."
    assert format_days(2.5) == "2,5"
    assert format_days(3.0) == "3"
    assert format_days(0.25) == "0,25"


def test_take_whole_days_is_carryover_first_and_never_overdraws():
    assert take_whole_days(2, 10, 5) == (2, 3)
    assert take_whole_days(0, 10, 5) == (0, 5)
    assert take_whole_days(1, 2, 5) == (1, 2)
    # A half day left in a bucket cannot pay for a whole one.
    assert take_whole_days(1.5, 0.5, 2) == (1, 0)


def test_charging_a_year_takes_only_that_years_days_and_records_them():
    first = _request(date(2026, 12, 28), date(2027, 1, 8), pending=5, available=4)
    later = _request(date(2027, 12, 27), date(2028, 1, 7), pending=10)  # 5 in 2027, 5 in 2028

    carryover, available = charge_planned_days_for_year(
        [first, later], year=2027, carryover=6, available=30, working_days_between=_weekdays
    )

    assert (carryover, available) == (0, 26)
    assert (first.deducted_carryover_days, first.deducted_available_days, first.pending_future_days) == (5, 4, 0)
    assert (later.deducted_carryover_days, later.deducted_available_days, later.pending_future_days) == (1, 4, 5)


def test_charging_keeps_days_the_balance_cannot_cover_pending():
    """Only possible after a hand-cut balance: the uncovered days stay pending.

    Dropping them would leave a 0/0/0 request that the legacy path then takes
    off every later year's balance again.
    """
    request = _request(date(2027, 1, 4), date(2027, 1, 8), pending=5)
    carryover, available = charge_planned_days_for_year(
        [request], year=2027, carryover=0, available=2, working_days_between=_weekdays
    )
    assert (carryover, available) == (0, 0)
    assert (request.deducted_available_days, request.pending_future_days) == (2, 3)

    nothing = _request(date(2027, 9, 6), date(2027, 9, 15), pending=8)
    charge_planned_days_for_year([nothing], year=2027, carryover=0, available=0, working_days_between=_weekdays)
    assert (nothing.deducted_available_days, nothing.deducted_carryover_days, nothing.pending_future_days) == (0, 0, 8)


def test_uncovered_days_never_move_to_a_later_year():
    """5 days in 2027, 5 in 2028; 2027 covers 1. 2028 still takes exactly its own 5."""
    request = _request(date(2027, 12, 27), date(2028, 1, 7), pending=10)
    charge_planned_days_for_year([request], year=2027, carryover=0, available=1, working_days_between=_weekdays)
    assert (request.deducted_available_days, request.pending_future_days) == (1, 9)
    assert planned_days_by_year(9, {2027: 5, 2028: 5}, 2027) == {2028: 5}

    carryover, available = charge_planned_days_for_year(
        [request], year=2028, carryover=0, available=30, working_days_between=_weekdays
    )
    assert (carryover, available) == (0, 25)
    assert (request.deducted_available_days, request.pending_future_days) == (6, 4)
    # Nothing is left after 2028, so the 4 uncovered 2027 days are never charged.
    charge_planned_days_for_year([request], year=2029, carryover=0, available=30, working_days_between=_weekdays)
    assert (request.deducted_available_days, request.pending_future_days) == (6, 4)
