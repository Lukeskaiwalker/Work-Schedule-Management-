"""Removing a single day from an approved vacation request.

The case this exists for: someone was booked on holiday but actually came in
and worked. A manager needs to take that one day back out of their vacation so
the worked hours stand on their own, and the day has to return to the person's
remaining entitlement.

Two things make this more than a delete.

**Vacation is stored as a range, not as days.** ``VacationRequest`` holds
``start_date``..``end_date``, so removing a day in the *middle* of a booked week
means splitting one request into two, and removing the only day of a one-day
request means the request disappears entirely.

**The deduction was split across two buckets.** Approval consumes carryover
days before current-year days (``_split_vacation_deduction``) and records the
result on the request. A refund therefore has to say *which* bucket it is giving
back, and the remaining days must still respect "carryover is consumed first" or
the two records drift apart. We refund from ``available`` first — the reverse of
the consumption order — which leaves carryover fully consumed on whatever days
remain, exactly as a fresh approval of those days would have recorded it.

Weekends and public holidays cost nothing when the request was approved, so
removing one refunds nothing. That is not an error; the day still leaves the
range.

**Days of a later year were never deducted.** A request reaching past the
balance year only *plans* those days (``pending_future_days``, see
services/vacation_years.py); the rollover charges them later. Removing such a
day takes it out of the plan rather than refunding the current year, and a
split hands each half the deducted and planned days of its own dates.

**Some approved days were never covered.** When a rollover found a balance
cut by hand too small for the days planned for its year, the uncovered days
stay pending (``uncovered_days``). Removing a day of such a request gives back
an uncovered day first -- it never cost anything -- before any day that was
really deducted, the reverse of the order the rollover charged them in.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy.orm import Session

from app.models.entities import User, VacationRequest
from app.services.vacation_years import days_after, days_up_to, uncovered_days, vacation_days_by_year


@dataclass(frozen=True)
class VacationDayRemoval:
    """Outcome of taking one day out of a vacation request."""

    removed_date: date
    refunded_available_days: int
    refunded_carryover_days: int
    request_deleted: bool
    split_into_second_request: bool
    was_deductible: bool
    # 1 when the day lay after the balance year and was only planned.
    released_planned_days: int = 0

    @property
    def refunded_days(self) -> int:
        return self.refunded_available_days + self.refunded_carryover_days


@dataclass(frozen=True)
class _HalfShare:
    available: int
    carryover: int
    planned: int


def _split_shares(
    request: VacationRequest,
    head_end: date,
    *,
    balance_year: int | None,
    working_days_between,
) -> tuple[_HalfShare, _HalfShare]:
    """Hand each half the deducted and planned days of its own dates.

    The head takes from what is recorded first -- carryover before available,
    the order approval consumed them, then days left uncovered -- but never
    more than its own deductible days; the tail gets the rest, so the pair
    totals exactly what the request held. Planned days likewise go to the
    half whose later-year days they are, head first (the order the rollover
    would charge them).
    """
    carryover_pool = max(request.deducted_carryover_days or 0, 0)
    available_pool = max(request.deducted_available_days or 0, 0)
    planned_pool = max(request.pending_future_days or 0, 0)

    head_by_year = vacation_days_by_year(request.start_date, head_end, working_days_between)
    if balance_year is None:
        head_now, head_later = sum(head_by_year.values()), 0
        uncovered_pool = 0
    else:
        head_now = days_up_to(head_by_year, balance_year)
        head_later = sum(days_after(head_by_year, balance_year).values())
        # The removed day (head_end + 1) has already left the pools, so only
        # the two halves' own later days are still planned.
        tail_by_year = vacation_days_by_year(head_end + timedelta(days=2), request.end_date, working_days_between)
        tail_later = sum(days_after(tail_by_year, balance_year).values())
        uncovered_pool = max(planned_pool - head_later - tail_later, 0)

    head_carryover = min(carryover_pool, head_now)
    head_available = min(available_pool, head_now - head_carryover)
    head_uncovered = min(uncovered_pool, head_now - head_carryover - head_available)
    head_planned = min(planned_pool - uncovered_pool, head_later) + head_uncovered
    return (
        _HalfShare(head_available, head_carryover, head_planned),
        _HalfShare(
            available_pool - head_available,
            carryover_pool - head_carryover,
            planned_pool - head_planned,
        ),
    )


def remove_vacation_day(
    db: Session,
    *,
    request: VacationRequest,
    target_user: User,
    day: date,
    working_days_between,
    sanitize_balance,
    balance_year: int | None = None,
) -> VacationDayRemoval:
    """Take ``day`` out of ``request`` and refund the entitlement it consumed.

    ``working_days_between`` and ``sanitize_balance`` are injected rather than
    imported so this module does not depend on the time-tracking router (which
    owns the NRW public-holiday calendar) — that import would be circular.
    ``balance_year`` is the holder's current balance year; a day after it was
    only planned (None: treat every day as already deducted).
    """
    if not (request.start_date <= day <= request.end_date):
        raise ValueError("Day is outside the vacation request")

    # A weekend or public holiday never consumed entitlement, so there is
    # nothing to give back — but it should still leave the booked range.
    was_deductible = working_days_between(day, day) > 0

    refund_available = 0
    refund_carryover = 0
    released_planned = 0
    planned_day = (
        balance_year is not None and day.year > balance_year and (request.pending_future_days or 0) > 0
    )
    uncovered_day = (
        balance_year is not None
        and day.year <= balance_year
        and uncovered_days(request, balance_year, working_days_between) > 0
    )
    if was_deductible and planned_day:
        # Never deducted: it leaves next year's plan, the balance is untouched.
        request.pending_future_days -= 1
        released_planned = 1
    elif was_deductible and uncovered_day:
        # Approved but never covered by a balance: nothing to give back.
        request.pending_future_days -= 1
    elif was_deductible:
        # Reverse of the consumption order: give back a current-year day first
        # so carryover stays fully consumed across the days that remain.
        if request.deducted_available_days > 0:
            refund_available = 1
            request.deducted_available_days -= 1
        elif request.deducted_carryover_days > 0:
            refund_carryover = 1
            request.deducted_carryover_days -= 1

        target_user.vacation_days_available = sanitize_balance(
            target_user.vacation_days_available + refund_available
        )
        target_user.vacation_days_carryover = sanitize_balance(
            target_user.vacation_days_carryover + refund_carryover
        )
        db.add(target_user)

    deleted = False
    split = False

    if request.start_date == day and request.end_date == day:
        # The request was this one day and nothing else.
        db.delete(request)
        deleted = True
    elif day == request.start_date:
        request.start_date = day + timedelta(days=1)
        db.add(request)
    elif day == request.end_date:
        request.end_date = day - timedelta(days=1)
        db.add(request)
    else:
        # Middle of the range: keep [start, day-1] and open a second request
        # for [day+1, end] so the remaining booked days survive as real records.
        tail_start = day + timedelta(days=1)
        tail_end = request.end_date
        head_end = day - timedelta(days=1)

        # Re-split what is still deducted and planned across the two halves
        # so the pair together still totals exactly what the request held.
        head_share, tail_share = _split_shares(
            request,
            head_end,
            balance_year=balance_year,
            working_days_between=working_days_between,
        )

        tail = VacationRequest(
            user_id=request.user_id,
            start_date=tail_start,
            end_date=tail_end,
            note=request.note,
            status=request.status,
            deducted_available_days=tail_share.available,
            deducted_carryover_days=tail_share.carryover,
            pending_future_days=tail_share.planned,
            reviewed_by=request.reviewed_by,
            reviewed_at=request.reviewed_at,
        )
        request.end_date = head_end
        request.deducted_available_days = head_share.available
        request.deducted_carryover_days = head_share.carryover
        request.pending_future_days = head_share.planned
        db.add(request)
        db.add(tail)
        split = True

    db.flush()
    return VacationDayRemoval(
        removed_date=day,
        refunded_available_days=refund_available,
        refunded_carryover_days=refund_carryover,
        request_deleted=deleted,
        split_into_second_request=split,
        was_deductible=was_deductible,
        released_planned_days=released_planned,
    )
