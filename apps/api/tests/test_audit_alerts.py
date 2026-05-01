"""Tests for brute-force login alerts.

Each test stubs the external dispatch (Telegram + email) so we exercise
only the threshold + dedup logic without making real network calls.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select


def test_alert_fires_when_email_threshold_crossed(client, monkeypatch):
    """Five auth.login_failed rows for the same email within 5 min →
    one alert dispatched. Audit log records the dispatch event."""
    from app.core.config import get_settings
    from app.core.db import SessionLocal
    from app.models.entities import AuditLog
    from app.services import auth_alerts

    settings = get_settings()
    monkeypatch.setattr(settings, "audit_alerts_enabled", True, raising=False)
    monkeypatch.setattr(settings, "audit_alerts_failures_per_email_threshold", 5, raising=False)
    monkeypatch.setattr(settings, "audit_alerts_failures_per_email_window_seconds", 300, raising=False)

    sent_messages: list[str] = []
    monkeypatch.setattr(
        auth_alerts,
        "_dispatch_external",
        lambda msg: (sent_messages.append(msg) or (True, False)),
    )

    target_email = "victim@example.com"
    now_naive = datetime.now(timezone.utc).replace(tzinfo=None)
    with SessionLocal() as db:
        # Seed 5 recent failures
        for i in range(5):
            db.add(
                AuditLog(
                    actor_user_id=None,
                    category="auth",
                    action="auth.login_failed",
                    target_type="user",
                    target_id=target_email,
                    details={"email": target_email, "ip": "1.2.3.4"},
                    created_at=now_naive - timedelta(seconds=10 * i),
                )
            )
        db.commit()

        event = auth_alerts.evaluate_after_failed_login(
            db, email=target_email, ip="1.2.3.4"
        )

        assert event is not None
        assert event.rule == "email_threshold"
        assert event.failure_count >= 5

        # Dedup row was written
        dedup = db.scalars(
            select(AuditLog).where(AuditLog.action == "auth.alert_brute_force")
        ).all()
        assert len(dedup) == 1
        assert dedup[0].target_id == f"email:{target_email}"

    assert len(sent_messages) == 1
    assert "Brute-force login alert" in sent_messages[0]


def test_alert_does_not_double_fire_within_dedup_window(client, monkeypatch):
    """After the first alert fires, a 6th failure within the dedup window
    must NOT trigger a second alert."""
    from app.core.config import get_settings
    from app.core.db import SessionLocal
    from app.models.entities import AuditLog
    from app.services import auth_alerts

    settings = get_settings()
    monkeypatch.setattr(settings, "audit_alerts_enabled", True, raising=False)
    monkeypatch.setattr(settings, "audit_alerts_failures_per_email_threshold", 5, raising=False)
    monkeypatch.setattr(settings, "audit_alerts_dedup_window_seconds", 600, raising=False)

    sent_messages: list[str] = []
    monkeypatch.setattr(
        auth_alerts,
        "_dispatch_external",
        lambda msg: (sent_messages.append(msg) or (True, False)),
    )

    target_email = "dedup@example.com"
    now_naive = datetime.now(timezone.utc).replace(tzinfo=None)
    with SessionLocal() as db:
        for i in range(5):
            db.add(
                AuditLog(
                    actor_user_id=None,
                    category="auth",
                    action="auth.login_failed",
                    target_type="user",
                    target_id=target_email,
                    details={"email": target_email, "ip": "9.9.9.9"},
                    created_at=now_naive - timedelta(seconds=i),
                )
            )
        db.commit()

        first = auth_alerts.evaluate_after_failed_login(
            db, email=target_email, ip="9.9.9.9"
        )
        assert first is not None

        # Sixth failure right after — should hit dedup, not alert again
        db.add(
            AuditLog(
                actor_user_id=None,
                category="auth",
                action="auth.login_failed",
                target_type="user",
                target_id=target_email,
                details={"email": target_email, "ip": "9.9.9.9"},
                created_at=datetime.now(timezone.utc).replace(tzinfo=None),
            )
        )
        db.commit()

        second = auth_alerts.evaluate_after_failed_login(
            db, email=target_email, ip="9.9.9.9"
        )
        assert second is None  # dedupped

    assert len(sent_messages) == 1  # only the first one was dispatched


def test_alert_disabled_by_default(client, monkeypatch):
    """The feature flag is OFF by default; even with 100 failed logins
    the evaluator must return None."""
    from app.core.db import SessionLocal
    from app.models.entities import AuditLog
    from app.services import auth_alerts

    sent_messages: list[str] = []
    monkeypatch.setattr(
        auth_alerts,
        "_dispatch_external",
        lambda msg: (sent_messages.append(msg) or (True, False)),
    )

    now_naive = datetime.now(timezone.utc).replace(tzinfo=None)
    with SessionLocal() as db:
        for i in range(100):
            db.add(
                AuditLog(
                    actor_user_id=None,
                    category="auth",
                    action="auth.login_failed",
                    target_type="user",
                    target_id="optout@example.com",
                    details={"email": "optout@example.com", "ip": "1.1.1.1"},
                    created_at=now_naive - timedelta(seconds=i),
                )
            )
        db.commit()

        event = auth_alerts.evaluate_after_failed_login(
            db, email="optout@example.com", ip="1.1.1.1"
        )
        assert event is None

    assert sent_messages == []
