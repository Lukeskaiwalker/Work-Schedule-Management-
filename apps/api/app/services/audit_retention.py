"""Audit log retention — daily prune of rows older than the threshold.

Without bounded retention the `audit_logs` table grows linearly forever
(currently ~one row per noteworthy admin action — meaningful but not
infinite). Two years of typical operation lands the table around the
single-digit-million rows mark; not a performance crisis, but worth
trimming for compliance ("we don't keep auth events forever") and to
keep table scans fast on the audit-tab UI.

The worker calls `prune_audit_logs_if_due(db)` on its poll loop. Gating
mimics the daily-summary service:
    1. Setting `audit_log_retention_days` must be > 0 (operator opt-out
       sets it to 0 explicitly).
    2. Local time must be at or past the configured run-hour.
    3. The AppSetting bookmark must not already point at today's local
       date — if it does, we've already pruned today and skip.

The bookmark advances BEFORE the DELETE so a crash means we lose at most
one prune cycle, never duplicate work in the same day.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.entities import AppSetting, AuditLog
from app.services.runtime_settings import get_runtime_setting, set_runtime_setting

logger = logging.getLogger("smpl.audit_retention")

# AppSetting key holding the local ISO date (YYYY-MM-DD) of the last prune.
LAST_PRUNE_KEY = "audit_log_retention_last_run_local_date"


@dataclass(frozen=True)
class PruneOutcome:
    cutoff_utc: datetime
    deleted_count: int
    target_local_date: str


def _app_timezone() -> ZoneInfo:
    name = (get_settings().app_timezone or "UTC").strip() or "UTC"
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def prune_audit_logs(db: Session, *, retention_days: int) -> PruneOutcome:
    """Delete audit_logs rows older than ``retention_days`` and return the
    number of rows removed. Always runs — does not consult the bookmark.

    Use this from the worker's ``prune_audit_logs_if_due`` (which adds
    once-per-day gating) or from an admin "prune now" endpoint.
    """
    cutoff_utc = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=retention_days)
    result = db.execute(
        delete(AuditLog).where(AuditLog.created_at < cutoff_utc)
    )
    db.commit()
    deleted = int(result.rowcount or 0)
    logger.info(
        "Pruned %d audit_logs row(s) older than %s (retention=%dd)",
        deleted,
        cutoff_utc.isoformat(),
        retention_days,
    )
    return PruneOutcome(
        cutoff_utc=cutoff_utc,
        deleted_count=deleted,
        target_local_date=datetime.now(_app_timezone()).date().isoformat(),
    )


def prune_audit_logs_if_due(db: Session) -> PruneOutcome | None:
    """Worker entry point. Returns None when nothing to do.

    Gating, in order:
      1. Feature must be enabled (retention_days > 0).
      2. Local time must be at or past the configured run-hour.
      3. The bookmark must not already point at today's local date.

    On success, advances the bookmark BEFORE the DELETE. If the prune
    crashes, we accept losing today's run rather than risk a second
    DELETE on the next poll.
    """
    settings = get_settings()
    retention_days = max(0, int(settings.audit_log_retention_days))
    if retention_days <= 0:
        return None

    tz = _app_timezone()
    now_local = datetime.now(tz)
    today_iso = now_local.date().isoformat()
    target_hour = max(0, min(23, settings.audit_log_retention_run_hour_local))
    if now_local.hour < target_hour:
        return None

    last_run = (get_runtime_setting(db, LAST_PRUNE_KEY) or "").strip()
    if last_run == today_iso:
        return None

    # Advance bookmark first — see module docstring for why.
    set_runtime_setting(db, LAST_PRUNE_KEY, today_iso)
    db.commit()

    try:
        return prune_audit_logs(db, retention_days=retention_days)
    except Exception:
        logger.exception("Audit retention prune failed; bookmark already advanced")
        return PruneOutcome(
            cutoff_utc=datetime.now(timezone.utc).replace(tzinfo=None),
            deleted_count=-1,
            target_local_date=today_iso,
        )


def count_purgeable(db: Session, *, retention_days: int) -> int:
    """How many rows would the next prune remove? Used by the admin UI
    to show 'Next prune will delete N rows' without actually deleting."""
    if retention_days <= 0:
        return 0
    cutoff_utc = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=retention_days)
    return int(
        db.execute(
            select(func.count()).select_from(AuditLog).where(AuditLog.created_at < cutoff_utc)
        ).scalar_one()
    )
