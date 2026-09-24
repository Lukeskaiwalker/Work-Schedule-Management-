"""A user's personal calendar as an iCalendar feed, and the token behind it.

Why a subscription and not invitations: the calendar apps people already
have (iPhone, Google, Outlook) can subscribe to a URL and re-fetch it on
their own schedule, so a task that moves in SMPL moves on the phone
without anyone sending anything. The feed is rebuilt from the database on
every fetch — there is no stored copy to go stale — and every event keeps
the same UID across fetches, which is what lets the calendar app update an
entry in place instead of duplicating it.

What a user sees: the tasks assigned to them (60 days back, 400 days
ahead; done ones prefixed with a tick so history stays readable), their
approved vacation and their Berufsschule days. Times are Europe/Berlin wall
clock with a VTIMEZONE block, so a phone abroad shows the right hour.

The token (``smpl_cal_…``) is the whole credential — a calendar app cannot
send a login — so it is stored hashed for the lookup like a PAT, and
encrypted so the profile page can show the link again (a subscription link
has to be re-copied onto the next phone; a PAT does not). Rotating it is
the way to lock a lost phone out.
"""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Iterable
from zoneinfo import ZoneInfo

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.calendar import CalendarFeed
from app.models.entities import Customer, Project, SchoolAbsence, Task, TaskAssignment, User, VacationRequest
from app.schemas.calendar import CalendarFeedOut
from app.services.secret_box import decrypt_secret, encrypt_secret

TOKEN_PREFIX = "smpl_cal_"
TOKEN_RANDOM_BYTES = 32
FEED_PATH = "/api/calendar/{token}/feed.ics"
LOCAL_TZ = ZoneInfo("Europe/Berlin")
TZID = "Europe/Berlin"

PAST_DAYS = 60
FUTURE_DAYS = 400
DEFAULT_HOURS = 1.0
DESCRIPTION_MAX = 1500
_SEQUENCE_EPOCH = datetime(2026, 1, 1)
_TOUCH_INTERVAL = timedelta(minutes=1)

STATUS_LABELS = {"open": "offen", "in_progress": "in Arbeit", "on_hold": "pausiert", "done": "erledigt", "overdue": "überfällig"}
PLANNING_LABELS = {"tentative": "in Planung", "confirmed": "bestätigt"}
CONFIRMATION_LABELS = {"pending": "ausstehend", "confirmed": "bestätigt", "declined": "abgelehnt"}

# Europe/Berlin: CET/CEST with the EU rules. Static on purpose — the rules
# have not changed since 1996 and a VTIMEZONE that a calendar app can trust
# is worth more than one derived at runtime from the host's tz database.
VTIMEZONE_BERLIN = (
    "BEGIN:VTIMEZONE\r\n"
    "TZID:Europe/Berlin\r\n"
    "X-LIC-LOCATION:Europe/Berlin\r\n"
    "BEGIN:DAYLIGHT\r\n"
    "TZOFFSETFROM:+0100\r\n"
    "TZOFFSETTO:+0200\r\n"
    "TZNAME:CEST\r\n"
    "DTSTART:19700329T020000\r\n"
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\r\n"
    "END:DAYLIGHT\r\n"
    "BEGIN:STANDARD\r\n"
    "TZOFFSETFROM:+0200\r\n"
    "TZOFFSETTO:+0100\r\n"
    "TZNAME:CET\r\n"
    "DTSTART:19701025T030000\r\n"
    "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\r\n"
    "END:STANDARD\r\n"
    "END:VTIMEZONE\r\n"
)


# ── Tokens ────────────────────────────────────────────────────────────────────


def mint_token() -> str:
    return f"{TOKEN_PREFIX}{secrets.token_urlsafe(TOKEN_RANDOM_BYTES)}"


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def get_feed(db: Session, user_id: int) -> CalendarFeed | None:
    return db.scalars(select(CalendarFeed).where(CalendarFeed.user_id == user_id)).first()


def create_or_rotate_feed(db: Session, user: User) -> CalendarFeed:
    """A fresh token; the old link stops working. Flushes, does not commit."""
    raw = mint_token()
    feed = get_feed(db, user.id)
    if feed is None:
        feed = CalendarFeed(user_id=user.id, token_hash=hash_token(raw), token_encrypted=encrypt_secret(raw))
    else:
        feed.token_hash = hash_token(raw)
        feed.token_encrypted = encrypt_secret(raw)
        feed.created_at = utcnow()
        feed.last_fetched_at = None
        feed.last_fetch_agent = None
        feed.fetch_count = 0
    db.add(feed)
    db.flush()
    return feed


def delete_feed(db: Session, user_id: int) -> bool:
    feed = get_feed(db, user_id)
    if feed is None:
        return False
    db.delete(feed)
    db.flush()
    return True


def resolve_feed(db: Session, raw_token: str) -> tuple[CalendarFeed, User] | None:
    """The feed a scanned-in token opens, or None — an unknown token, a
    rotated one, a deleted subscription and a deactivated user all look the
    same to the caller: nothing here."""
    raw = (raw_token or "").strip()
    if not raw.startswith(TOKEN_PREFIX) or len(raw) > 200:
        return None
    feed = db.scalars(select(CalendarFeed).where(CalendarFeed.token_hash == hash_token(raw))).first()
    if feed is None:
        return None
    user = db.get(User, feed.user_id)
    if user is None or not user.is_active:
        return None
    return feed, user


def touch_fetch(db: Session, feed: CalendarFeed, agent: str | None) -> None:
    """Remember the fetch — at most one write a minute, phones poll often."""
    now = utcnow()
    if feed.last_fetched_at is not None and now - feed.last_fetched_at < _TOUCH_INTERVAL:
        return
    feed.last_fetched_at = now
    feed.last_fetch_agent = (agent or "").strip()[:200] or None
    feed.fetch_count = int(feed.fetch_count or 0) + 1
    db.add(feed)
    db.commit()


def feed_url(base_url: str, raw_token: str) -> str:
    return base_url.rstrip("/") + FEED_PATH.format(token=raw_token)


def webcal_url(https_url: str) -> str:
    for scheme in ("https://", "http://"):
        if https_url.startswith(scheme):
            return "webcal://" + https_url[len(scheme):]
    return https_url


def feed_out(feed: CalendarFeed, base_url: str) -> CalendarFeedOut:
    url = feed_url(base_url, decrypt_secret(feed.token_encrypted))
    return CalendarFeedOut(
        url=url,
        webcal_url=webcal_url(url),
        created_at=feed.created_at,
        last_fetched_at=feed.last_fetched_at,
        last_fetch_agent=feed.last_fetch_agent,
        fetch_count=int(feed.fetch_count or 0),
    )


# ── iCalendar text ────────────────────────────────────────────────────────────


def ics_escape(text: str) -> str:
    return (
        str(text)
        .replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\r\n", "\\n")
        .replace("\n", "\\n")
    )


def ics_fold(line: str) -> str:
    """RFC 5545 §3.1: content lines are at most 75 octets; the continuation
    starts with one space. Split between characters, never inside one."""
    out: list[str] = []
    current = ""
    current_len = 0
    limit = 75
    for char in line:
        size = len(char.encode("utf-8"))
        if current_len + size > limit:
            out.append(current)
            current = " " + char
            current_len = 1 + size
            limit = 75
        else:
            current += char
            current_len += size
    out.append(current)
    return "\r\n".join(out)


def _stamp(moment: datetime) -> str:
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _local(moment: datetime) -> str:
    return moment.strftime("%Y%m%dT%H%M%S")


def _date(day: date) -> str:
    return day.strftime("%Y%m%d")


def _sequence(updated_at: datetime | None) -> int:
    if updated_at is None:
        return 0
    return max(0, int((updated_at.replace(tzinfo=None) - _SEQUENCE_EPOCH).total_seconds()))


@dataclass
class Event:
    uid: str
    summary: str
    start: str  # the DTSTART property line (with its parameters)
    end: str  # the DTEND property line
    stamp: datetime
    description: str = ""
    location: str = ""
    status: str = "CONFIRMED"
    categories: tuple[str, ...] = ("SMPL",)
    rrule: str | None = None
    extra: list[str] = field(default_factory=list)

    def lines(self) -> list[str]:
        out = [
            "BEGIN:VEVENT",
            f"UID:{self.uid}",
            f"DTSTAMP:{_stamp(self.stamp)}",
            f"LAST-MODIFIED:{_stamp(self.stamp)}",
            f"SEQUENCE:{_sequence(self.stamp)}",
            self.start,
            self.end,
        ]
        if self.rrule:
            out.append(f"RRULE:{self.rrule}")
        out.append(f"SUMMARY:{ics_escape(self.summary)}")
        if self.location:
            out.append(f"LOCATION:{ics_escape(self.location)}")
        if self.description:
            out.append(f"DESCRIPTION:{ics_escape(self.description)}")
        out.append(f"STATUS:{self.status}")
        out.append("CATEGORIES:" + ",".join(ics_escape(c) for c in self.categories))
        out.extend(self.extra)
        out.append("END:VEVENT")
        return out


def render_calendar(name: str, events: Iterable[Event]) -> str:
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//SMPL//Kalender-Abo//DE",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        f"X-WR-CALNAME:{ics_escape(name)}",
        f"X-WR-TIMEZONE:{TZID}",
        "REFRESH-INTERVAL;VALUE=DURATION:PT30M",
        "X-PUBLISHED-TTL:PT30M",
    ]
    body = "\r\n".join(ics_fold(line) for line in lines) + "\r\n" + VTIMEZONE_BERLIN
    for event in events:
        body += "\r\n".join(ics_fold(line) for line in event.lines()) + "\r\n"
    return body + "END:VCALENDAR\r\n"


# ── What goes in ──────────────────────────────────────────────────────────────


def _task_filter(user_id: int):
    assigned = select(TaskAssignment.task_id).where(TaskAssignment.user_id == user_id)
    return or_(Task.assignee_id == user_id, Task.id.in_(assigned))


def _user_tasks(db: Session, user_id: int, today: date) -> list[Task]:
    window_start = today - timedelta(days=PAST_DAYS)
    window_end = today + timedelta(days=FUTURE_DAYS)
    return list(
        db.scalars(
            select(Task)
            .where(
                _task_filter(user_id),
                Task.due_date.is_not(None),
                Task.due_date <= window_end,
                func.coalesce(Task.end_date, Task.due_date) >= window_start,
            )
            .order_by(Task.due_date.asc(), Task.id.asc())
        )
    )


def _task_context(db: Session, tasks: list[Task]) -> tuple[dict[int, Project], dict[int, Customer], dict[int, list[str]]]:
    project_ids = {t.project_id for t in tasks if t.project_id}
    projects = {p.id: p for p in db.scalars(select(Project).where(Project.id.in_(project_ids)))} if project_ids else {}
    customer_ids = {t.customer_id for t in tasks if t.customer_id} | {p.customer_id for p in projects.values() if p.customer_id}
    customers = {c.id: c for c in db.scalars(select(Customer).where(Customer.id.in_(customer_ids)))} if customer_ids else {}
    task_ids = [t.id for t in tasks]
    crew: dict[int, list[str]] = {}
    if task_ids:
        rows = db.execute(
            select(TaskAssignment.task_id, User.full_name, User.email)
            .join(User, User.id == TaskAssignment.user_id)
            .where(TaskAssignment.task_id.in_(task_ids))
            .order_by(TaskAssignment.task_id, User.full_name)
        ).all()
        for task_id, full_name, email in rows:
            crew.setdefault(int(task_id), []).append((full_name or email or "").strip())
    return projects, customers, crew


def _task_event(task: Task, *, uid_domain: str, project: Project | None, customer: Customer | None, crew: list[str], me: str, now: datetime) -> Event:
    title = (task.title or "Aufgabe").strip()
    summary = f"✓ {title}" if task.status == "done" else title
    location = ""
    if project is not None:
        location = (project.construction_site_address or project.customer_address or "").strip()
    if not location and customer is not None:
        location = (customer.address or "").strip()

    lines: list[str] = []
    customer_name = (customer.name if customer is not None else None) or (project.customer_name if project is not None else None)
    if customer_name:
        lines.append(f"Kunde: {customer_name}")
    if project is not None:
        lines.append(f"Projekt: {' · '.join(p for p in ((project.project_number or '').strip(), (project.name or '').strip()) if p)}")
    lines.append(f"Status: {STATUS_LABELS.get(task.status or '', task.status or '—')}")
    if task.planning_status:
        lines.append(f"Planung: {PLANNING_LABELS.get(task.planning_status, task.planning_status)}")
    if task.customer_confirmation_status:
        lines.append(f"Kundenbestätigung: {CONFIRMATION_LABELS.get(task.customer_confirmation_status, task.customer_confirmation_status)}")
    if task.estimated_hours:
        lines.append(f"Aufwand: {task.estimated_hours:g} h")
    others = [name for name in crew if name and name != me]
    if others:
        lines.append("Mit: " + ", ".join(others))
    text = (task.description or "").strip()
    if text:
        lines.append("")
        lines.append(text[:DESCRIPTION_MAX] + ("…" if len(text) > DESCRIPTION_MAX else ""))

    first_day: date = task.due_date
    last_day: date = task.end_date or task.due_date
    days = max(1, (last_day - first_day).days + 1)
    rrule = None
    if task.start_time is not None:
        start_local = datetime.combine(first_day, task.start_time)
        hours = float(task.estimated_hours or DEFAULT_HOURS)
        end_local = start_local + timedelta(hours=hours)
        if end_local.date() > first_day:
            end_local = datetime.combine(first_day, datetime.max.time()).replace(microsecond=0, second=0)
        start = f"DTSTART;TZID={TZID}:{_local(start_local)}"
        end = f"DTEND;TZID={TZID}:{_local(end_local)}"
        if days > 1:
            rrule = f"FREQ=DAILY;COUNT={days}"
    else:
        start = f"DTSTART;VALUE=DATE:{_date(first_day)}"
        end = f"DTEND;VALUE=DATE:{_date(last_day + timedelta(days=1))}"

    return Event(
        uid=f"smpl-task-{task.id}@{uid_domain}",
        summary=summary,
        start=start,
        end=end,
        stamp=task.updated_at or now,
        description="\n".join(lines),
        location=location,
        status="TENTATIVE" if task.planning_status == "tentative" else "CONFIRMED",
        categories=("SMPL", "Aufgabe"),
        rrule=rrule,
    )


def _vacation_events(db: Session, user_id: int, today: date, uid_domain: str, now: datetime) -> list[Event]:
    window_start = today - timedelta(days=PAST_DAYS)
    window_end = today + timedelta(days=FUTURE_DAYS)
    rows = db.scalars(
        select(VacationRequest).where(
            VacationRequest.user_id == user_id,
            VacationRequest.status == "approved",
            VacationRequest.start_date <= window_end,
            VacationRequest.end_date >= window_start,
        )
    )
    return [
        Event(
            uid=f"smpl-vacation-{row.id}@{uid_domain}",
            summary="Urlaub",
            start=f"DTSTART;VALUE=DATE:{_date(row.start_date)}",
            end=f"DTEND;VALUE=DATE:{_date(row.end_date + timedelta(days=1))}",
            stamp=row.reviewed_at or row.created_at or now,
            categories=("SMPL", "Urlaub"),
            extra=["TRANSP:TRANSPARENT"],
        )
        for row in rows
    ]


def _absence_events(db: Session, user_id: int, today: date, uid_domain: str, now: datetime) -> list[Event]:
    window_start = today - timedelta(days=PAST_DAYS)
    window_end = today + timedelta(days=FUTURE_DAYS)
    rows = db.scalars(
        select(SchoolAbsence).where(
            SchoolAbsence.user_id == user_id,
            SchoolAbsence.status == "approved",
            SchoolAbsence.start_date <= window_end,
            func.coalesce(SchoolAbsence.recurrence_until, SchoolAbsence.end_date) >= window_start,
        )
    )
    events: list[Event] = []
    for row in rows:
        title = (row.title or "Berufsschule").strip() or "Berufsschule"
        if row.recurrence_weekday is None:
            start = f"DTSTART;VALUE=DATE:{_date(row.start_date)}"
            end = f"DTEND;VALUE=DATE:{_date(row.end_date + timedelta(days=1))}"
            rrule = None
        else:
            offset = (int(row.recurrence_weekday) - row.start_date.weekday()) % 7
            first = row.start_date + timedelta(days=offset)
            until = row.recurrence_until or (row.start_date + timedelta(days=365))
            start = f"DTSTART;VALUE=DATE:{_date(first)}"
            end = f"DTEND;VALUE=DATE:{_date(first + timedelta(days=1))}"
            rrule = f"FREQ=WEEKLY;UNTIL={_date(until)}"
        events.append(
            Event(
                uid=f"smpl-absence-{row.id}@{uid_domain}",
                summary=title,
                start=start,
                end=end,
                stamp=row.reviewed_at or row.created_at or now,
                categories=("SMPL", "Abwesenheit"),
                rrule=rrule,
                extra=["TRANSP:TRANSPARENT"],
            )
        )
    return events


def build_user_calendar(db: Session, user: User, *, uid_domain: str, now: datetime | None = None) -> str:
    """The whole feed for one user, as iCalendar text."""
    now = now or utcnow()
    today = datetime.now(LOCAL_TZ).date()
    tasks = _user_tasks(db, user.id, today)
    projects, customers, crew = _task_context(db, tasks)
    me = (user.full_name or user.email or "").strip()
    events: list[Event] = []
    for task in tasks:
        project = projects.get(task.project_id) if task.project_id else None
        customer = customers.get(task.customer_id) if task.customer_id else None
        if customer is None and project is not None and project.customer_id:
            customer = customers.get(project.customer_id)
        events.append(_task_event(task, uid_domain=uid_domain, project=project, customer=customer, crew=crew.get(task.id, []), me=me, now=now))
    events.extend(_vacation_events(db, user.id, today, uid_domain, now))
    events.extend(_absence_events(db, user.id, today, uid_domain, now))
    return render_calendar(f"SMPL · {user.display_name}", events)
