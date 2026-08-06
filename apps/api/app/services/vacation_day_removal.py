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
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy.orm import Session

from app.models.entities import User, VacationRequest


@dataclass(frozen=True)
class VacationDayRemoval:
    """Outcome of taking one day out of a vacation request."""

    removed_date: date
    refunded_available_days: int
    refunded_carryover_days: int
    request_deleted: bool
    split_into_second_request: bool
    was_deductible: bool

    @property
    def refunded_days(self) -> int:
        return self.refunded_available_days + self.refunded_carryover_days


def _allocate(days: int, carryover_pool: int) -> tuple[int, int]:
    """Split ``days`` into (available, carryover) keeping carryover-first order."""
    carryover = min(carryover_pool, days)
    return days - carryover, carryover


def remove_vacation_day(
    db: Session,
    *,
    request: VacationRequest,
    target_user: User,
    day: date,
    working_days_between,
    sanitize_balance,
) -> VacationDayRemoval:
    """Take ``day`` out of ``request`` and refund the entitlement it consumed.

    ``working_days_between`` and ``sanitize_balance`` are injected rather than
    imported so this module does not depend on the time-tracking router (which
    owns the NRW public-holiday calendar) — that import would be circular.
    """
    if not (request.start_date <= day <= request.end_date):
        raise ValueError("Day is outside the vacation request")

    # A weekend or public holiday never consumed entitlement, so there is
    # nothing to give back — but it should still leave the booked range.
    was_deductible = working_days_between(day, day) > 0

    refund_available = 0
    refund_carryover = 0
    if was_deductible:
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

        head_days = working_days_between(request.start_date, head_end)
        tail_days = working_days_between(tail_start, tail_end)

        # Re-split what is still deducted across the two halves, carryover
        # first, so the pair together still totals the original deduction.
        carryover_pool = request.deducted_carryover_days
        head_available, head_carryover = _allocate(head_days, carryover_pool)
        tail_available, tail_carryover = _allocate(tail_days, carryover_pool - head_carryover)

        tail = VacationRequest(
            user_id=request.user_id,
            start_date=tail_start,
            end_date=tail_end,
            note=request.note,
            status=request.status,
            deducted_available_days=tail_available,
            deducted_carryover_days=tail_carryover,
            reviewed_by=request.reviewed_by,
            reviewed_at=request.reviewed_at,
        )
        request.end_date = head_end
        request.deducted_available_days = head_available
        request.deducted_carryover_days = head_carryover
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
    )
