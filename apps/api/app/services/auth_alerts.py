"""Brute-force login alerting.

Hook called from the login endpoint AFTER each `auth.login_failed` audit
row is written. It evaluates two thresholds against the recent audit
log history and dispatches a Telegram and/or email alert when either
crosses, with audit-log-anchored dedup so:

  * Multiple api workers see the same dedup state (it's in the DB).
  * Restarts don't reset the dedup window.
  * The alert fires once per event window, never twice for the same
    flapping email/IP pair.

Detection rules (configurable via Settings):

  rule A: ≥ N login_failed for the same email within `email_window_seconds`
  rule B: ≥ M login_failed from the same IP within a 60-second window

Either rule firing → one alert. The `auth.alert_brute_force` audit
log row is written BEFORE the external send so a transient send failure
doesn't cause the next failed-login to re-fire (which would spam if the
alert backend was offline).
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.entities import AuditLog
from app.services.audit import log_admin_action

logger = logging.getLogger("smpl.auth_alerts")


@dataclass(frozen=True)
class AlertEvent:
    rule: str  # "email_threshold" | "ip_threshold"
    email: str | None
    ip: str | None
    failure_count: int
    window_seconds: int


def _utcnow_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _recent_failed_login_count_for_email(db: Session, *, email: str, window_seconds: int) -> int:
    if not email:
        return 0
    cutoff = _utcnow_naive() - timedelta(seconds=window_seconds)
    return int(
        db.scalar(
            select(_count(AuditLog.id))
            .where(AuditLog.action == "auth.login_failed")
            .where(AuditLog.target_id == email)
            .where(AuditLog.created_at >= cutoff)
        )
        or 0
    )


def _recent_failed_login_count_for_ip(db: Session, *, ip: str, window_seconds: int) -> int:
    if not ip:
        return 0
    cutoff = _utcnow_naive() - timedelta(seconds=window_seconds)
    # IP isn't a column — it lives inside details->>'ip'. We have to scan
    # the recent failed-login rows and filter in Python. Cheap because we
    # bound the scan to the small window (default 60s) which on a healthy
    # system sees zero or one failure.
    rows = db.scalars(
        select(AuditLog)
        .where(AuditLog.action == "auth.login_failed")
        .where(AuditLog.created_at >= cutoff)
    ).all()
    return sum(1 for r in rows if (r.details or {}).get("ip") == ip)


def _alert_already_sent_recently(
    db: Session,
    *,
    rule: str,
    target_id: str,
    dedup_window_seconds: int,
) -> bool:
    cutoff = _utcnow_naive() - timedelta(seconds=dedup_window_seconds)
    row = db.scalars(
        select(AuditLog)
        .where(AuditLog.action == "auth.alert_brute_force")
        .where(AuditLog.target_id == target_id)
        .where(AuditLog.created_at >= cutoff)
    ).first()
    if row is None:
        return False
    # Same rule fired? If a different rule already alerted on this target
    # within the window, suppress (one alert per target per window — don't
    # double-fire because both rules tripped).
    return True


def _format_alert(event: AlertEvent) -> str:
    parts = [
        "🚨 SMPL — Brute-force login alert",
        "",
        f"Rule: {event.rule}",
    ]
    if event.email:
        parts.append(f"Email: {event.email}")
    if event.ip:
        parts.append(f"IP:    {event.ip}")
    parts.extend([
        f"Failures in window: {event.failure_count} / last {event.window_seconds}s",
        "",
        "Open the admin Audit tab and filter to category 'Anmeldung' for context.",
    ])
    return "\n".join(parts)


def _dispatch_external(message: str) -> tuple[bool, bool]:
    """Send the alert via the configured channels. Returns (telegram_ok, email_ok)."""
    settings = get_settings()

    telegram_sent = False
    if settings.audit_alerts_send_telegram:
        from app.services.telegram import send_telegram_message, telegram_enabled

        if telegram_enabled():
            try:
                telegram_sent = asyncio.run(send_telegram_message(message))
            except RuntimeError:
                # Already in an event loop — bridge via thread.
                import threading

                container: dict[str, bool] = {"ok": False}

                def _runner():
                    container["ok"] = asyncio.run(send_telegram_message(message))

                t = threading.Thread(target=_runner, daemon=True)
                t.start()
                t.join(timeout=15)
                telegram_sent = container["ok"]

    email_sent = False
    if (
        settings.audit_alerts_send_email
        and settings.audit_alerts_email_recipient
    ):
        from app.services.emailer import send_email_detailed

        result = send_email_detailed(
            to_email=settings.audit_alerts_email_recipient.strip(),
            subject="SMPL — Brute-force login alert",
            body=message,
            db=None,
        )
        email_sent = bool(result.ok)

    return telegram_sent, email_sent


def evaluate_after_failed_login(
    db: Session,
    *,
    email: str,
    ip: str,
) -> AlertEvent | None:
    """Run after each `auth.login_failed` row is committed. Returns the
    AlertEvent that was dispatched, or None when nothing fired."""
    settings = get_settings()
    if not settings.audit_alerts_enabled:
        return None

    # Rule A: per-email threshold within the configured window
    email_threshold = max(1, int(settings.audit_alerts_failures_per_email_threshold))
    email_window = max(1, int(settings.audit_alerts_failures_per_email_window_seconds))
    email_count = _recent_failed_login_count_for_email(
        db, email=email, window_seconds=email_window
    )

    # Rule B: per-IP threshold within a fixed 60-second window
    ip_threshold = max(1, int(settings.audit_alerts_failures_per_ip_threshold))
    ip_window = 60
    ip_count = _recent_failed_login_count_for_ip(
        db, ip=ip, window_seconds=ip_window
    ) if ip else 0

    event: AlertEvent | None = None
    target_id: str | None = None
    if email and email_count >= email_threshold:
        event = AlertEvent(
            rule="email_threshold",
            email=email,
            ip=ip or None,
            failure_count=email_count,
            window_seconds=email_window,
        )
        target_id = f"email:{email}"
    elif ip and ip_count >= ip_threshold:
        event = AlertEvent(
            rule="ip_threshold",
            email=None,
            ip=ip,
            failure_count=ip_count,
            window_seconds=ip_window,
        )
        target_id = f"ip:{ip}"

    if event is None or target_id is None:
        return None

    # Dedup against the audit log itself
    dedup_window = max(60, int(settings.audit_alerts_dedup_window_seconds))
    if _alert_already_sent_recently(
        db, rule=event.rule, target_id=target_id, dedup_window_seconds=dedup_window
    ):
        return None

    # Write the dedup row FIRST so a send failure doesn't make us spam.
    log_admin_action(
        db,
        None,
        "auth.alert_brute_force",
        "user",
        target_id,
        details={
            "rule": event.rule,
            "email": event.email,
            "ip": event.ip,
            "failure_count": event.failure_count,
            "window_seconds": event.window_seconds,
        },
        category="auth",
    )

    message = _format_alert(event)
    telegram_sent, email_sent = _dispatch_external(message)
    logger.info(
        "Brute-force alert dispatched: rule=%s target=%s telegram=%s email=%s",
        event.rule,
        target_id,
        telegram_sent,
        email_sent,
    )
    return event


# ── small helper: count() compatibility shim ──────────────────────────────────
# SQLAlchemy 2.x has func.count via sqlalchemy.func, but using `_count` as a
# private alias keeps the import surface tight and the call sites readable.
from sqlalchemy import func as _sa_func


def _count(column):
    return _sa_func.count(column)
