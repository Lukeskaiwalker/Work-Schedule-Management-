"""„Wer fehlt heute“ — today's absences, shaped for minimisation
(docs/DASHBOARD.md §4.3, §13).

The rows come from the planning board's own helper, so the audience is
exactly the board's. What leaves the server is a name and a generic label
from the map below — never the stored type or the free-text title. Health,
accident and family reasons do not belong on a start page (GDPR Art. 9), and
office screens are often shared.

The caller must have passed the 403 check first: for anyone without planning
or time-view rights the helper quietly returns only the caller.
"""

from __future__ import annotations

from datetime import date, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.entities import User
from app.schemas.dashboard import AbsenceKind, AbsenceTodayOut, AbsentTodayOut

# Table order of §4.3: when one user has several absences today, the first
# kind in this order wins.
ABSENCE_KIND_ORDER: tuple[AbsenceKind, ...] = ("vacation", "school", "training", "company_event", "holiday", "absent")

_LABELS: dict[AbsenceKind, str] = {
    "vacation": "Urlaub",
    "school": "Berufsschule",
    "training": "Fortbildung",
    "company_event": "Betriebsveranstaltung",
    "holiday": "Feiertag",
    "absent": "Abwesend",
}


def app_today() -> date:
    """Today in the app timezone, as ``/time/clock-summary`` counts it."""
    name = (get_settings().app_timezone or "UTC").strip() or "UTC"
    try:
        zone = ZoneInfo(name)
    except ZoneInfoNotFoundError:
        zone = ZoneInfo("UTC")
    return datetime.now(zone).date()


# Vacation requests and school absences of type "vacation" both arrive as
# "vacation". Every stored type not named here — sickness, accidents, family
# leave, "other", types added later — becomes the generic "absent".
_KIND_BY_STORED_TYPE: dict[str, AbsenceKind] = {
    "vacation": "vacation",
    "school": "school",
    "training": "training",
    "company_event": "company_event",
    "holiday": "holiday",
}


def _kind(stored_type: object) -> AbsenceKind:
    return _KIND_BY_STORED_TYPE.get(stored_type, "absent") if isinstance(stored_type, str) else "absent"


def absent_today(db: Session, user: User) -> AbsentTodayOut:
    # Lazy: workflow_helpers is the planning router's helper module and pulls
    # in most of the app; importing it at module level would tie this service
    # into the router import graph.
    from app.routers.workflow_helpers import _planning_absences_by_day

    today = app_today()
    rows = _planning_absences_by_day(db, current_user=user, week_start=today, week_end=today).get(today, [])
    best: dict[int, AbsenceTodayOut] = {}
    for row in rows:
        user_id = int(row["user_id"])
        kind = _kind(row.get("type"))
        current = best.get(user_id)
        if current is not None and ABSENCE_KIND_ORDER.index(current.type) <= ABSENCE_KIND_ORDER.index(kind):
            continue
        best[user_id] = AbsenceTodayOut(user_id=user_id, user_name=str(row["user_name"]), type=kind, label=_LABELS[kind])
    ordered = sorted(best.values(), key=lambda entry: (entry.user_name.casefold(), entry.user_id))
    return AbsentTodayOut(date=today, absences=ordered)
