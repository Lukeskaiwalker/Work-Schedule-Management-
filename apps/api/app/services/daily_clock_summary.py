"""Daily clocked-in summary report.

Produces a once-per-day digest of:
  * who is currently still clocked in (clock_out IS NULL) — the
    "did you forget to clock out?" check the user asked for, and
  * how many hours each user worked today (sum of net_hours where
    clock_in fell on the target local date).

Channels:
  * Telegram via `services.telegram.send_telegram_message`
  * Email via `services.emailer.send_email_detailed`

The worker calls `dispatch_daily_clock_summary_if_due(db)` on its poll
loop. Idempotency is enforced via an `AppSetting` bookmark so a worker
restart inside the same window doesn't fire twice. Ad-hoc triggers via
the admin endpoint always run regardless of the bookmark.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.entities import AppSetting, ClockEntry, User
from app.services.runtime_settings import get_runtime_setting, set_runtime_setting

logger = logging.getLogger("smpl.daily_clock_summary")

# AppSetting key holding the local ISO date (YYYY-MM-DD) of the last
# automatic dispatch. Used as a bookmark so the worker fires exactly
# once per local date even across restarts.
LAST_DISPATCH_KEY = "daily_clock_summary_last_run_local_date"


@dataclass(frozen=True)
class ClockedInUser:
    user_id: int
    name: str
    clocked_in_since_iso: str  # local-tz, formatted "HH:MM" for the summary
    hours_today: float


@dataclass(frozen=True)
class DailyClockSummary:
    target_local_date: date
    clocked_in: list[ClockedInUser]
    total_users_with_entries: int
    total_hours_today: float


def _app_timezone() -> ZoneInfo:
    name = (get_settings().app_timezone or "UTC").strip() or "UTC"
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def _local_day_bounds_utc(local_day: date) -> tuple[datetime, datetime]:
    tz = _app_timezone()
    start_local = datetime.combine(local_day, datetime.min.time(), tzinfo=tz)
    # End is start of *next* local day so a "<" comparison covers everything
    # without timezone-aware microsecond gymnastics on day boundaries.
    end_local = start_local + timedelta(days=1)
    start_utc = start_local.astimezone(timezone.utc).replace(tzinfo=None)
    end_utc = end_local.astimezone(timezone.utc).replace(tzinfo=None)
    return start_utc, end_utc


def _hours_between(start: datetime, end: datetime | None) -> float:
    if end is None:
        return 0.0
    return max((end - start).total_seconds(), 0.0) / 3600.0


def build_clock_summary_for_date(db: Session, target_local_date: date) -> DailyClockSummary:
    """Compute the summary for the given local date.

    Hours-today is computed from raw ClockEntry rows (clock_in/clock_out)
    rather than the derived `net_hours` field, so a user still clocked in
    contributes only the elapsed time up to the dispatch instant. That
    matches the on-screen "live counter" the user sees.
    """
    tz = _app_timezone()
    start_utc, end_utc = _local_day_bounds_utc(target_local_date)
    now_utc_naive = datetime.now(timezone.utc).replace(tzinfo=None)

    # Pull all ClockEntries that overlap the target local date OR are
    # currently open (clock_out IS NULL). Open entries that started before
    # the target day still contribute to today's totals.
    rows = db.scalars(
        select(ClockEntry).where(
            (
                (ClockEntry.clock_in < end_utc)
                & (
                    (ClockEntry.clock_out.is_(None))
                    | (ClockEntry.clock_out >= start_utc)
                )
            )
        )
    ).all()

    user_ids = sorted({row.user_id for row in rows})
    name_by_id: dict[int, str] = {}
    if user_ids:
        users = db.scalars(select(User).where(User.id.in_(user_ids))).all()
        name_by_id = {u.id: (u.full_name or u.email or f"#{u.id}") for u in users}

    hours_by_user: dict[int, float] = {}
    open_entry_by_user: dict[int, ClockEntry] = {}
    for row in rows:
        # Clamp the entry's effective range to the target day for hour
        # accounting.
        effective_start = max(row.clock_in, start_utc)
        effective_end = (
            min(row.clock_out, end_utc) if row.clock_out is not None else min(now_utc_naive, end_utc)
        )
        hours_by_user[row.user_id] = (
            hours_by_user.get(row.user_id, 0.0) + _hours_between(effective_start, effective_end)
        )
        if row.clock_out is None:
            # Track the most recent open entry (in case a user has multiple
            # — shouldn't happen but be defensive).
            current = open_entry_by_user.get(row.user_id)
            if current is None or row.clock_in > current.clock_in:
                open_entry_by_user[row.user_id] = row

    clocked_in: list[ClockedInUser] = []
    for user_id, entry in open_entry_by_user.items():
        local_clock_in = (
            entry.clock_in.replace(tzinfo=timezone.utc).astimezone(tz)
        )
        clocked_in.append(
            ClockedInUser(
                user_id=user_id,
                name=name_by_id.get(user_id, f"#{user_id}"),
                clocked_in_since_iso=local_clock_in.strftime("%H:%M"),
                hours_today=round(hours_by_user.get(user_id, 0.0), 2),
            )
        )
    clocked_in.sort(key=lambda c: c.name.lower())

    return DailyClockSummary(
        target_local_date=target_local_date,
        clocked_in=clocked_in,
        total_users_with_entries=len(user_ids),
        total_hours_today=round(sum(hours_by_user.values()), 2),
    )


def format_clock_summary_text(summary: DailyClockSummary, *, language: str = "de") -> str:
    """Render the summary as plain text suitable for Telegram/email."""
    de = language == "de"
    date_str = summary.target_local_date.strftime("%d.%m.%Y")
    if de:
        header = f"📋 Tagesabschluss {date_str}"
        no_one_line = "Niemand mehr eingestempelt — alle haben ausgestempelt."
        still_in_label = f"Noch eingestempelt ({len(summary.clocked_in)}):"
        totals_line = (
            f"Gesamtstunden heute: {summary.total_hours_today:.2f} h "
            f"über {summary.total_users_with_entries} Mitarbeitende."
        )
    else:
        header = f"📋 End-of-day summary {date_str}"
        no_one_line = "Nobody is still clocked in — all good."
        still_in_label = f"Still clocked in ({len(summary.clocked_in)}):"
        totals_line = (
            f"Total hours today: {summary.total_hours_today:.2f} h "
            f"across {summary.total_users_with_entries} employees."
        )

    lines = [header, ""]
    if not summary.clocked_in:
        lines.append(no_one_line)
    else:
        lines.append(still_in_label)
        for entry in summary.clocked_in:
            lines.append(
                f"  • {entry.name} (seit {entry.clocked_in_since_iso}, "
                f"heute {entry.hours_today:.2f} h)"
                if de
                else f"  • {entry.name} (since {entry.clocked_in_since_iso}, "
                f"{entry.hours_today:.2f} h today)"
            )
    lines.append("")
    lines.append(totals_line)
    return "\n".join(lines)


@dataclass(frozen=True)
class DispatchOutcome:
    summary: DailyClockSummary
    telegram_sent: bool
    email_sent: bool
    error: str | None = None


def dispatch_daily_clock_summary(
    db: Session,
    *,
    target_local_date: date | None = None,
    language: str = "de",
) -> DispatchOutcome:
    """Build and ship the summary for the given (or today's) local date.

    Always sends — does not consult the once-per-day bookmark. Use this
    from the admin "send now" endpoint, or the worker can call it after
    its own gating check (`dispatch_daily_clock_summary_if_due`).
    """
    settings = get_settings()
    target = target_local_date or datetime.now(_app_timezone()).date()
    summary = build_clock_summary_for_date(db, target)
    body = format_clock_summary_text(summary, language=language)

    telegram_sent = False
    if settings.daily_clock_summary_send_telegram:
        # The Telegram client uses async httpx; bridge into the worker
        # thread's loop via asyncio.run. Caller is sync (worker / FastAPI
        # endpoint with a sync handler) so this is safe.
        from app.services.telegram import send_telegram_message, telegram_enabled

        if telegram_enabled():
            try:
                telegram_sent = asyncio.run(send_telegram_message(body))
            except RuntimeError:
                # Already in an event loop (e.g. async endpoint). Fall back
                # to running the coroutine on a fresh thread to avoid
                # blocking the caller's loop.
                import threading

                container: dict[str, bool] = {"ok": False}

                def _runner():
                    container["ok"] = asyncio.run(send_telegram_message(body))

                t = threading.Thread(target=_runner)
                t.start()
                t.join(timeout=20)
                telegram_sent = container["ok"]

    email_sent = False
    if (
        settings.daily_clock_summary_send_email
        and settings.daily_clock_summary_email_recipient
    ):
        from app.services.emailer import send_email_detailed

        recipient = settings.daily_clock_summary_email_recipient.strip()
        subject = (
            f"Tagesabschluss {target.strftime('%d.%m.%Y')}"
            if language == "de"
            else f"End-of-day summary {target.strftime('%d.%m.%Y')}"
        )
        result = send_email_detailed(to_email=recipient, subject=subject, body=body, db=db)
        email_sent = bool(result.ok)

    logger.info(
        "Daily clock summary dispatched: date=%s telegram=%s email=%s clocked_in=%d",
        target,
        telegram_sent,
        email_sent,
        len(summary.clocked_in),
    )

    return DispatchOutcome(
        summary=summary,
        telegram_sent=telegram_sent,
        email_sent=email_sent,
    )


def dispatch_daily_clock_summary_if_due(db: Session) -> DispatchOutcome | None:
    """Worker entry point. Returns None when nothing to do.

    Gating, in order:
      1. Feature must be enabled in settings.
      2. Local time must be at or past the configured target hour:minute.
      3. The AppSetting bookmark must not already point at today's local
         date — if it does, we've already dispatched today and skip.

    On success, advances the bookmark before any external send so a
    failure-then-restart can't double-fire (we'd rather lose one day's
    digest than spam Telegram twice).
    """
    settings = get_settings()
    if not settings.daily_clock_summary_enabled:
        return None

    tz = _app_timezone()
    now_local = datetime.now(tz)
    today_local = now_local.date()
    target_hour = max(0, min(23, settings.daily_clock_summary_target_hour_local))
    target_minute = max(0, min(59, settings.daily_clock_summary_target_minute_local))
    target_dt = now_local.replace(
        hour=target_hour, minute=target_minute, second=0, microsecond=0
    )
    if now_local < target_dt:
        return None

    last_run = (get_runtime_setting(db, LAST_DISPATCH_KEY) or "").strip()
    if last_run == today_local.isoformat():
        return None

    # Advance the bookmark FIRST. If the dispatch crashes, we accept
    # losing today's digest rather than risk a second fire on the next
    # poll cycle.
    set_runtime_setting(db, LAST_DISPATCH_KEY, today_local.isoformat())
    db.commit()

    try:
        return dispatch_daily_clock_summary(db, target_local_date=today_local)
    except Exception as exc:  # noqa: BLE001 — log and keep the worker alive
        logger.exception("Daily clock summary dispatch failed")
        return DispatchOutcome(
            summary=build_clock_summary_for_date(db, today_local),
            telegram_sent=False,
            email_sent=False,
            error=str(exc),
        )
