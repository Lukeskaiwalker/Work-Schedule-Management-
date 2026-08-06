"""Deciding whether someone may fill in a working day they never clocked.

Two audiences, two rules.

**Managers** (`time:manage`) may create an entry for any user on any day. They
are accountable for the records, and correcting an old month is a normal part of
running payroll.

**Employees** may only fill in a gap inside the window they can *already* edit.
That existing rule lives in `_entry_update_scope`: a member of an
``EmployeeGroup`` with ``can_update_recent_own_time_entries`` may edit their
**3 most recent entries** — entries, note, not days. Ordering by ``id`` desc and
taking three says nothing about dates: clock in and out three times in one
afternoon and all three sit on the same day; work only Mondays and the same
three span a month.

So "the last three entries" has no meaning for a day that has *no* entry, and
creation needs a day-based window instead. We use the span the edit rule already
exposes — from the local date of the oldest of those three entries through today
— floored at the last three calendar days. The floor matters twice: a new hire
with no entries at all would otherwise have an empty window and be unable to
record anything, and three days is what people already believe the rule to be.

Widening this window widens how far back working-time records can be written
after the fact, which is exactly what Arbeitszeiterfassung audits look at. It is
deliberately expressed in one place so it can be argued about in one place.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import ClockEntry

# How many recent entries the edit rule exposes. Mirrors the default limit of
# `_recent_entry_ids_for_user` in the time-tracking router; if that changes,
# this must change with it.
RECENT_ENTRY_SPAN = 3

# Minimum self-service window, in calendar days including today. Guarantees a
# usable window when someone has few or no entries to derive a span from.
MINIMUM_WINDOW_DAYS = 3


@dataclass(frozen=True)
class BackfillWindow:
    """The inclusive range of days a person may fill in for themselves."""

    earliest: date
    latest: date

    def allows(self, day: date) -> bool:
        return self.earliest <= day <= self.latest


def self_backfill_window(
    db: Session,
    *,
    user_id: int,
    today: date,
    local_date_of,
) -> BackfillWindow:
    """The days this employee may fill in without a manager.

    ``local_date_of`` converts a stored UTC datetime to the local calendar date;
    it is injected rather than imported so this module stays independent of the
    time-tracking router's timezone helpers.
    """
    floor = today - timedelta(days=MINIMUM_WINDOW_DAYS - 1)

    recent_clock_ins = db.scalars(
        select(ClockEntry.clock_in)
        .where(ClockEntry.user_id == user_id)
        .order_by(ClockEntry.id.desc())
        .limit(RECENT_ENTRY_SPAN)
    ).all()

    earliest = floor
    for clock_in in recent_clock_ins:
        entry_day = local_date_of(clock_in)
        if entry_day < earliest:
            earliest = entry_day

    # Never open a window into the future: today is the last day anyone can
    # have worked.
    return BackfillWindow(earliest=earliest, latest=today)
