"""Which projects a person at the rack is on — this week and lately.

Owner, 2026-10-10: "When we do the item dispense and have to select a user we
can then also select one of the current and recent projects for that week of
that user to book it to that project."

Nothing in SMPL stores "who works on which project": every active user is a
member of every project (``services/project_membership.py``) and the clock has
no project column. So the answer is derived from what the person was actually
planned for and actually did:

* **heute** — a task assigned to them (the many-assignee join OR the older
  single ``tasks.assignee_id``) whose window ``[due_date, end_date or
  due_date]`` contains today;
* **woche** — a task window touching this Monday–Sunday, or a task pinned to
  this week by ``week_start`` (the Wochenplanung may pin one with no day yet);
* **zuletzt** — last week's tasks (same two arms), or within the last 14 days
  a Baustellenbericht they filed, a stock movement that names them as the
  person who took it, or a Verteiler they clocked onto.

Any task status counts — material is fetched for the job finished this
morning, too. Office tasks never count (nothing leaves the shelf for them),
nor do archived projects or customer-only tasks (nothing to book to). A
station row booked with no name is not the station owner's history, which is
why movements count by ``assignee_user_id`` only.

"Today" and the weeks are the workshop's (``app_timezone``, Europe/Berlin):
the UTC date would put Monday's first hours into last week.

The wall is unauthenticated, so callers project the result to ``id``,
``project_number``, ``name`` and the hint — never a customer, an address or a
task title.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.time import utcnow
from app.models.entities import ConstructionReport, Project, Task, WerkstattMovement
from app.models.schaltplan import PanelPlan, PanelWorkSession

HINT_TODAY = "heute"
HINT_WEEK = "woche"
HINT_RECENT = "zuletzt"
_HINT_RANK = {HINT_TODAY: 0, HINT_WEEK: 1, HINT_RECENT: 2}

# The rack's picker is a grid that must not scroll.
MAX_PROJECTS_PER_PERSON = 8
# How far back a report, a movement or a Verteiler session still makes a
# project "recent".
RECENT_DAYS = 14

OFFICE_TASK_TYPE = "office"


@dataclass(frozen=True)
class OfferedProject:
    id: int
    project_number: str
    name: str
    hint: str


@dataclass(frozen=True)
class CrewProjects:
    week_start: date
    # user id → that person's projects, best first. Every requested id is a key.
    by_user: dict[int, list[OfferedProject]]


@dataclass(frozen=True)
class _Window:
    today: date
    monday: date
    sunday: date
    last_monday: date
    last_sunday: date
    recent_since: date


def _app_timezone() -> ZoneInfo:
    """The workshop's timezone. Same helper as time_tracking / werkstatt_machines."""
    name = (get_settings().app_timezone or "UTC").strip() or "UTC"
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def local_today() -> date:
    return utcnow().replace(tzinfo=timezone.utc).astimezone(_app_timezone()).date()


def _local_date(moment: datetime) -> date:
    """A stored naive-UTC timestamp as the workshop's calendar day."""
    return moment.replace(tzinfo=timezone.utc).astimezone(_app_timezone()).date()


def _local_midnight_utc(day: date) -> datetime:
    """The start of a local day as the naive UTC the timestamp columns hold."""
    start = datetime.combine(day, time.min, tzinfo=_app_timezone())
    return start.astimezone(timezone.utc).replace(tzinfo=None)


def _window(today: date) -> _Window:
    monday = today - timedelta(days=today.weekday())
    return _Window(
        today=today,
        monday=monday,
        sunday=monday + timedelta(days=6),
        last_monday=monday - timedelta(days=7),
        last_sunday=monday - timedelta(days=1),
        recent_since=today - timedelta(days=RECENT_DAYS),
    )


# A candidate is (rank, days away from today); smaller is better.
_Candidate = tuple[int, int]


def _task_candidate(w: _Window, due: date | None, last: date | None, pinned: date | None) -> _Candidate | None:
    """The best hint one task gives its project, or ``None``."""
    found: list[_Candidate] = []
    if due is not None:
        last = last or due
        if due <= w.today <= last:
            found.append((_HINT_RANK[HINT_TODAY], 0))
        elif due <= w.sunday and last >= w.monday:
            away = (due - w.today).days if due > w.today else (w.today - last).days
            found.append((_HINT_RANK[HINT_WEEK], away))
        elif due <= w.last_sunday and last >= w.last_monday:
            found.append((_HINT_RANK[HINT_RECENT], (w.today - min(last, w.last_sunday)).days))
    # A pin without a day only says "that week": count it from its Monday.
    if pinned == w.monday:
        found.append((_HINT_RANK[HINT_WEEK], abs((w.today - w.monday).days)))
    elif pinned == w.last_monday:
        found.append((_HINT_RANK[HINT_RECENT], (w.today - w.last_monday).days))
    return min(found) if found else None


def _task_candidates(db: Session, w: _Window, user_id: int) -> dict[int, _Candidate]:
    # Imported here, not at module load: services do not import routers at
    # import time (see services/distance.py). This is the one definition of
    # "assigned to U" — the join table OR the older single column.
    from app.routers.workflow_helpers import _my_task_filter

    last_day = func.coalesce(Task.end_date, Task.due_date)
    rows = db.execute(
        select(Task.project_id, Task.due_date, last_day.label("last_day"), Task.week_start).where(
            _my_task_filter(user_id),
            Task.project_id.is_not(None),
            Task.task_type != OFFICE_TASK_TYPE,
            or_(
                Task.week_start.in_((w.last_monday, w.monday)),
                and_(Task.due_date <= w.sunday, last_day >= w.last_monday),
            ),
        )
    ).all()
    best: dict[int, _Candidate] = {}
    for row in rows:
        candidate = _task_candidate(w, row.due_date, row.last_day, row.week_start)
        if candidate is not None:
            _keep_best(best, int(row.project_id), candidate)
    return best


def _recent_evidence(db: Session, w: _Window, user_ids: Sequence[int]) -> dict[int, dict[int, date]]:
    """user id → project id → the most recent local day the person did
    something for it (report, movement, Verteiler session)."""
    since_utc = _local_midnight_utc(w.recent_since)
    latest: dict[int, dict[int, date]] = {user_id: {} for user_id in user_ids}

    def _note(user_id: int, project_id: int, day: date) -> None:
        per_user = latest.setdefault(int(user_id), {})
        if day > per_user.get(int(project_id), date.min):
            per_user[int(project_id)] = day

    reports = db.execute(
        select(ConstructionReport.user_id, ConstructionReport.project_id, func.max(ConstructionReport.report_date))
        .where(
            ConstructionReport.user_id.in_(user_ids),
            ConstructionReport.project_id.is_not(None),
            ConstructionReport.report_date >= w.recent_since,
            ConstructionReport.report_date <= w.today,
        )
        .group_by(ConstructionReport.user_id, ConstructionReport.project_id)
    ).all()
    for user_id, project_id, day in reports:
        _note(user_id, project_id, day)

    movements = db.execute(
        select(WerkstattMovement.assignee_user_id, WerkstattMovement.project_id, func.max(WerkstattMovement.created_at))
        .where(
            WerkstattMovement.assignee_user_id.in_(user_ids),
            WerkstattMovement.project_id.is_not(None),
            WerkstattMovement.created_at >= since_utc,
        )
        .group_by(WerkstattMovement.assignee_user_id, WerkstattMovement.project_id)
    ).all()
    for user_id, project_id, moment in movements:
        _note(user_id, project_id, _local_date(moment))

    # The last moment of a session: when it ended, or — still open — when it began.
    last_seen = func.coalesce(PanelWorkSession.ended_at, PanelWorkSession.started_at)
    sessions = db.execute(
        select(PanelWorkSession.user_id, PanelPlan.project_id, func.max(last_seen))
        .join(PanelPlan, PanelPlan.id == PanelWorkSession.panel_id)
        .where(
            PanelWorkSession.user_id.in_(user_ids),
            PanelPlan.project_id.is_not(None),
            last_seen >= since_utc,
        )
        .group_by(PanelWorkSession.user_id, PanelPlan.project_id)
    ).all()
    for user_id, project_id, moment in sessions:
        _note(user_id, project_id, _local_date(moment))

    return latest


def _keep_best(best: dict[int, _Candidate], project_id: int, candidate: _Candidate) -> None:
    current = best.get(project_id)
    if current is None or candidate < current:
        best[project_id] = candidate


def _is_archived(project: Project) -> bool:
    # Lazy for the same reason as ``_my_task_filter``: one definition, owned
    # by the router helpers.
    from app.routers.workflow_helpers import _is_project_archived

    return _is_project_archived(project)


def crew_projects(db: Session, user_ids: Sequence[int], *, today: date | None = None) -> CrewProjects:
    """Every requested person's projects, best first, at most eight each."""
    w = _window(today or local_today())
    ids = [int(user_id) for user_id in user_ids]
    if not ids:
        return CrewProjects(week_start=w.monday, by_user={})

    evidence = _recent_evidence(db, w, ids)
    candidates: dict[int, dict[int, _Candidate]] = {}
    for user_id in ids:
        best = _task_candidates(db, w, user_id)
        for project_id, day in evidence.get(user_id, {}).items():
            _keep_best(best, project_id, (_HINT_RANK[HINT_RECENT], (w.today - day).days))
        candidates[user_id] = best

    project_ids = {project_id for best in candidates.values() for project_id in best}
    projects = {
        row.id: row
        for row in (db.scalars(select(Project).where(Project.id.in_(project_ids))).all() if project_ids else [])
        if not _is_archived(row)
    }
    hint_of = {rank: hint for hint, rank in _HINT_RANK.items()}

    by_user: dict[int, list[OfferedProject]] = {}
    for user_id in ids:
        ranked = sorted(
            (
                (rank, away, projects[project_id].project_number, project_id)
                for project_id, (rank, away) in candidates[user_id].items()
                if project_id in projects
            )
        )
        by_user[user_id] = [
            OfferedProject(
                id=project_id,
                project_number=projects[project_id].project_number,
                name=projects[project_id].name,
                hint=hint_of[rank],
            )
            for rank, _away, _number, project_id in ranked[:MAX_PROJECTS_PER_PERSON]
        ]
    return CrewProjects(week_start=w.monday, by_user=by_user)
