"""Vacation that reaches into a later year.

The case this exists for: a request for 29.12.-05.01. used to be charged in
full to the year it was approved in, so it was refused whenever that year had
enough left for *its* part but not for the whole request -- although the new
year brings a fresh allowance for the rest.

The balance (``User.vacation_days_available`` / ``_carryover``) only ever
describes ONE year, the balance year. So approval now splits a request by
calendar year:

* days up to the balance year are deducted at once, exactly as before;
* days of a later year are *planned*: they are counted in
  ``VacationRequest.pending_future_days`` and checked against what that year
  will have, but nothing is taken from the current balance;
* the yearly rollover (``_ensure_vacation_balance_year`` in the time-tracking
  router) charges each year's planned days to that year's fresh balance,
  carryover first, and records them on the request like any other deduction.

Planned days are always attributed earliest year first (``planned_days_by_year``)
-- the same order the rollover consumes them in, so the approval check, the
"planned next year" figure and the rollover can never disagree about which
year a planned day belongs to.

Next year's planned days may be approved against what this year will carry
over, so approval re-checks next year whenever it spends this year's
*available* days -- even for a request that lies wholly in this year.

If a year's fresh balance still cannot cover its planned days (only after an
admin cut the balance by hand), the uncovered days stay in
``pending_future_days``: approved, never charged, never refunded, and -- with
pending above zero -- never mistaken for a pre-tracking booking, which the
balance would otherwise subtract again in every later year. They no longer
belong to a year after the balance year, so ``uncovered_days`` tells them
apart from days still planned.

The working-day counter is injected rather than imported: the NRW public-holiday
calendar lives in the time-tracking router, which imports this module.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Callable, Iterable

from app.models.entities import VacationRequest

WorkingDaysBetween = Callable[[date, date], int]

# Balances are floats rounded to two decimals; this keeps 2.9999999 a 3.
_EPSILON = 1e-6


def vacation_days_by_year(start: date, end: date, working_days_between: WorkingDaysBetween) -> dict[int, int]:
    """Working days of ``start``..``end`` per calendar year; years without any are left out."""
    if end < start:
        return {}
    by_year: dict[int, int] = {}
    for year in range(start.year, end.year + 1):
        days = working_days_between(max(start, date(year, 1, 1)), min(end, date(year, 12, 31)))
        if days > 0:
            by_year[year] = days
    return by_year


def days_up_to(by_year: dict[int, int], balance_year: int) -> int:
    """Days charged to the current balance: the balance year and anything before it."""
    return sum(days for year, days in by_year.items() if year <= balance_year)


def days_after(by_year: dict[int, int], balance_year: int) -> dict[int, int]:
    """Days that fall in a year after the balance year, per year."""
    return {year: days for year, days in by_year.items() if year > balance_year}


def planned_days_by_year(planned: int, by_year: dict[int, int], balance_year: int) -> dict[int, int]:
    """Attribute ``planned`` (a request's pending days) to the years after ``balance_year``.

    Earliest year first, never more than the request has in a year -- the
    order in which the rollover consumes them.
    """
    left = max(int(planned or 0), 0)
    attributed: dict[int, int] = {}
    for year in sorted(year for year in by_year if year > balance_year):
        if left <= 0:
            break
        take = min(left, by_year[year])
        if take > 0:
            attributed[year] = take
            left -= take
    return attributed


def planned_days_of(
    requests: Iterable[VacationRequest], balance_year: int, working_days_between: WorkingDaysBetween
) -> dict[int, int]:
    """Planned days of ``requests`` summed per later year."""
    totals: dict[int, int] = {}
    for request in requests:
        if (request.pending_future_days or 0) <= 0:
            continue
        by_year = vacation_days_by_year(request.start_date, request.end_date, working_days_between)
        for year, days in planned_days_by_year(request.pending_future_days, by_year, balance_year).items():
            totals[year] = totals.get(year, 0) + days
    return totals


def uncovered_days(request: VacationRequest, balance_year: int, working_days_between: WorkingDaysBetween) -> int:
    """Pending days of a year the balance has already reached: approved, but never charged."""
    by_year = vacation_days_by_year(request.start_date, request.end_date, working_days_between)
    still_planned = sum(days_after(by_year, balance_year).values())
    return max((request.pending_future_days or 0) - still_planned, 0)


@dataclass(frozen=True)
class YearShortfall:
    """A later year that cannot hold its part of a request.

    ``requested`` is 0 when the request has no days there but spends this
    year's leftover that the days already ``planned`` there count on;
    ``allowance`` is what the year would have before those planned days.
    """

    year: int
    free: float
    requested: int
    planned: int = 0
    allowance: float = 0.0


def future_year_shortfall(
    *,
    future_days: dict[int, int],
    balance_year: int,
    per_year: float,
    carried_into_next_year: float,
    planned_by_others: dict[int, int],
    spends_next_years_carry: bool = False,
) -> YearShortfall | None:
    """The first later year whose part does not fit, or None.

    Next year will hold its allowance plus what this year carries over (the
    rollover turns this year's leftover ``available`` into carryover); any
    year after that can only be sure of its allowance. Days other approved
    requests already planned for a year are taken off first.

    ``spends_next_years_carry``: the request takes days from this year's
    ``available``, shrinking ``carried_into_next_year`` -- next year is then
    checked even when the request has no days there, or the days already
    planned for it could be left without cover.
    """
    years = set(future_days)
    if spends_next_years_carry:
        years.add(balance_year + 1)
    for year in sorted(years):
        allowance = per_year + (carried_into_next_year if year == balance_year + 1 else 0.0)
        planned = planned_by_others.get(year, 0)
        free = allowance - planned
        requested = future_days.get(year, 0)
        if requested > free + _EPSILON:
            return YearShortfall(
                year=year, free=max(free, 0.0), requested=requested, planned=planned, allowance=allowance
            )
    return None


def format_days(value: float) -> str:
    """German day count: ``3`` for whole days, ``2,5`` otherwise."""
    rounded = round(float(value), 2)
    if abs(rounded - round(rounded)) < _EPSILON:
        return str(int(round(rounded)))
    return f"{rounded:.2f}".rstrip("0").replace(".", ",")


def shortfall_message(year: int, free: float, requested: int) -> str:
    return f"Nicht genug Urlaubstage für {year}: {format_days(free)} frei, {requested} beantragt."


def year_shortfall_message(shortfall: YearShortfall) -> str:
    """German refusal for a later year; names the planned days when the request has none there."""
    if shortfall.requested > 0:
        return shortfall_message(shortfall.year, shortfall.free, shortfall.requested)
    already = "ist schon 1 Tag" if shortfall.planned == 1 else f"sind schon {shortfall.planned} Tage"
    return (
        f"Nicht genug Urlaubstage für {shortfall.year}: dort {already} genehmigt, "
        f"nach dieser Genehmigung gäbe es samt Resturlaub aus {shortfall.year - 1} "
        f"nur {format_days(shortfall.allowance)}."
    )


def take_whole_days(carryover: float, available: float, days: int) -> tuple[int, int]:
    """``(carryover_used, available_used)`` for ``days``, carryover first.

    Never takes more than a bucket holds, so a balance cannot go below zero;
    days neither bucket can cover are simply not taken.
    """
    carryover_used = min(max(days, 0), max(int(carryover + _EPSILON), 0))
    available_used = min(max(days, 0) - carryover_used, max(int(available + _EPSILON), 0))
    return carryover_used, available_used


def charge_planned_days_for_year(
    requests: Iterable[VacationRequest],
    *,
    year: int,
    carryover: float,
    available: float,
    working_days_between: WorkingDaysBetween,
) -> tuple[float, float]:
    """Rollover into ``year``: charge the days approved requests planned for it.

    ``carryover`` / ``available`` are the fresh balance of ``year``. Each
    request gives up ``min(pending, its working days in year)`` -- taken from
    the balance carryover first, recorded on the request as deducted, and
    removed from its pending count. Days the balance cannot cover (it was cut
    by hand after approval) stay pending, see the module docstring. Returns
    the new ``(carryover, available)``; the request rows are updated in place.
    """
    for request in requests:
        pending = request.pending_future_days or 0
        if pending <= 0:
            continue
        by_year = vacation_days_by_year(request.start_date, request.end_date, working_days_between)
        due = min(pending, by_year.get(year, 0))
        if due <= 0:
            continue
        carryover_used, available_used = take_whole_days(carryover, available, due)
        carryover = round(max(carryover - carryover_used, 0.0), 2)
        available = round(max(available - available_used, 0.0), 2)
        request.deducted_carryover_days = (request.deducted_carryover_days or 0) + carryover_used
        request.deducted_available_days = (request.deducted_available_days or 0) + available_used
        request.pending_future_days = pending - (carryover_used + available_used)
    return carryover, available
