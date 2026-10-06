"""Time a person spends building a Verteiler, clocked with their badge.

The station sends (badge, the board open at the rack or none); this module
turns that into exactly one action, so the decision lives on the server and
two stations scanning the same badge can never disagree:

    board open?  the person is ...             action
    -----------  ----------------------------  -----------
    yes          on nothing                    clock_in
    yes          on this board                 clock_out
    yes          on another board              switch
    no           on a board                    clock_out
    no           on nothing                    identify     (no write)

and one guard over all of it: the same badge again within ``RESCAN_GUARD_S``
of clocking in is ``already_in``, because the commonest double scan is a
trigger pulled twice by habit, and turning that into "in, then straight back
out" would lose the session the person meant to start.

"A person is on at most one board at a time" is the partial unique index on
``panel_work_sessions`` (one row per user with ``ended_at IS NULL``), not a
check in here. A switch closes the old row before inserting the new one, in
one transaction; a race between two stations surfaces as an IntegrityError
the router answers with a "scan again", never as two open sessions.

This is job costing, not attendance. Nothing here touches ``clock_entries``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import PanelPlan, PanelWorkSession, Station, User
from app.schemas.schaltplan import PanelLabourLineOut, PanelWorkSessionOut

#: A second scan of the same badge sooner than this after clocking in is a
#: double scan, not a clock-out.
RESCAN_GUARD_S = 30

#: How far a browser's clock may run ahead of the server before an end time
#: counts as "in the future". The end form offers the browser's own "now", and
#: a workshop PC a minute or two fast must not be told its now has not
#: happened yet; within this margin the end is the server's now instead.
CLOCK_SKEW_TOLERANCE = timedelta(minutes=5)

VIA_STATION = "station"
VIA_WEB = "web"


class WorkSessionError(Exception):
    """A request the rules refuse, with the sentence to show for it."""


@dataclass(frozen=True)
class ScanOutcome:
    action: str
    person: User
    panel: PanelPlan | None = None
    session: PanelWorkSession | None = None
    closed: PanelWorkSession | None = None


def open_session_for(db: Session, user_id: int) -> PanelWorkSession | None:
    return db.scalars(
        select(PanelWorkSession).where(
            PanelWorkSession.user_id == user_id, PanelWorkSession.ended_at.is_(None)
        )
    ).first()


def _close(session: PanelWorkSession, *, now: datetime, via: str, by: int | None) -> None:
    session.ended_at = now
    session.ended_via = via
    session.ended_by = by


def badge_scan(
    db: Session,
    *,
    person: User,
    panel: PanelPlan | None,
    station: Station,
    now: datetime | None = None,
    identify_only: bool = False,
) -> ScanOutcome:
    """Decide and apply one badge scan. Flushes; the caller commits.

    ``identify_only``: the rack asked "who is this Ausgabe for?" and the badge
    is the answer. Nothing moves -- somebody on a board stays on it -- and the
    outcome carries the running session so the wall can say so.
    """
    now = now or utcnow()
    current = open_session_for(db, person.id)

    if identify_only:
        board = db.get(PanelPlan, current.panel_id) if current is not None else None
        return ScanOutcome("identify", person, board, current)

    if current is not None and (now - current.started_at).total_seconds() < RESCAN_GUARD_S:
        if panel is None or panel.id == current.panel_id:
            return ScanOutcome("already_in", person, db.get(PanelPlan, current.panel_id), current)

    if panel is None:
        if current is None:
            return ScanOutcome("identify", person)
        _close(current, now=now, via=VIA_STATION, by=person.id)
        db.add(current)
        db.flush()
        return ScanOutcome("clock_out", person, db.get(PanelPlan, current.panel_id), current)

    if current is not None and current.panel_id == panel.id:
        _close(current, now=now, via=VIA_STATION, by=person.id)
        db.add(current)
        db.flush()
        return ScanOutcome("clock_out", person, panel, current)

    closed = None
    if current is not None:
        _close(current, now=now, via=VIA_STATION, by=person.id)
        db.add(current)
        # Flushed BEFORE the insert: the partial unique index must see the old
        # row closed, or the switch would collide with itself.
        db.flush()
        closed = current

    opened = PanelWorkSession(
        panel_id=panel.id, user_id=person.id, started_at=now, station_id=station.id
    )
    db.add(opened)
    db.flush()
    return ScanOutcome("switch" if closed is not None else "clock_in", person, panel, opened, closed)


def end_session(
    db: Session,
    session: PanelWorkSession,
    *,
    actor: User,
    ended_at: datetime | None,
    now: datetime | None = None,
) -> PanelWorkSession:
    """Close a session by hand -- the correction for a forgotten clock-out.

    The time may not precede the start (a negative session) and may not lie in
    the future (hours that have not happened) -- beyond CLOCK_SKEW_TOLERANCE,
    that is: a browser a little ahead of the server ends the session at the
    server's now. Permission is the router's business; this only guards the
    arithmetic.
    """
    now = now or utcnow()
    if session.ended_at is not None:
        raise WorkSessionError("Diese Arbeitszeit ist bereits beendet.")
    when = ended_at or now
    if when > now:
        if when - now > CLOCK_SKEW_TOLERANCE:
            raise WorkSessionError("Das Ende liegt in der Zukunft.")
        when = now
    if when < session.started_at:
        raise WorkSessionError("Das Ende liegt vor dem Beginn.")
    _close(session, now=when, via=VIA_WEB, by=actor.id)
    db.add(session)
    db.flush()
    return session


def _minutes(session: PanelWorkSession, now: datetime) -> int:
    end = session.ended_at or now
    return max(0, int((end - session.started_at).total_seconds() // 60))


def session_out(
    db: Session, session: PanelWorkSession, *, now: datetime | None = None
) -> PanelWorkSessionOut:
    now = now or utcnow()
    user = db.get(User, session.user_id)
    plan = db.get(PanelPlan, session.panel_id)
    return PanelWorkSessionOut(
        id=session.id,
        panel_id=session.panel_id,
        panel_number=getattr(plan, "panel_number", None),
        user_id=session.user_id,
        user_name=user.display_name if user is not None else "—",
        started_at=session.started_at,
        ended_at=session.ended_at,
        minutes=_minutes(session, now),
        running=session.ended_at is None,
        ended_via=session.ended_via,
    )


def labour(db: Session, panel_id: int) -> tuple[list[PanelLabourLineOut], int, int]:
    """The board's Arbeitszeit block: (one line per person, closed minutes, running count).

    Closed sessions are summed per person; a running one is reported beside
    them, not added in. People come in the order they first worked on the
    board, so the block reads like the job's history.
    """
    rows = db.scalars(
        select(PanelWorkSession)
        .where(PanelWorkSession.panel_id == panel_id)
        .order_by(PanelWorkSession.started_at.asc(), PanelWorkSession.id.asc())
    ).all()
    lines: dict[int, PanelLabourLineOut] = {}
    total = 0
    running = 0
    for row in rows:
        line = lines.get(row.user_id)
        if line is None:
            user = db.get(User, row.user_id)
            line = PanelLabourLineOut(
                user_id=row.user_id, name=user.display_name if user is not None else "—"
            )
            lines[row.user_id] = line
        if row.ended_at is None:
            line.running_since = row.started_at
            line.running_session_id = row.id
            running += 1
        else:
            minutes = int((row.ended_at - row.started_at).total_seconds() // 60)
            line.minutes += max(0, minutes)
            line.sessions += 1
            total += max(0, minutes)
    return list(lines.values()), total, running
