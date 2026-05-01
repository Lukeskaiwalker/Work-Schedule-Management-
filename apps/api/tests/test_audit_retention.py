"""Tests for the audit-log retention service.

Uses SessionLocal directly because the existing conftest doesn't expose
a session fixture. The `client` fixture wires the schema migrations via
the autouse `reset_db` fixture, so opening our own session is safe.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select


def test_prune_deletes_only_rows_older_than_threshold(client):
    """A row from 100 days ago is purged when retention is 30 days. A row
    from 5 days ago survives. Younger rows are untouched."""
    from app.core.db import SessionLocal
    from app.models.entities import AuditLog
    from app.services.audit_retention import prune_audit_logs

    now_naive = datetime.now(timezone.utc).replace(tzinfo=None)
    with SessionLocal() as db:
        db.add_all(
            [
                AuditLog(
                    actor_user_id=None,
                    category="auth",
                    action="auth.login_failed",
                    target_type="user",
                    target_id="old@example.com",
                    details={"reason": "invalid_credentials"},
                    created_at=now_naive - timedelta(days=100),
                ),
                AuditLog(
                    actor_user_id=None,
                    category="auth",
                    action="auth.login_failed",
                    target_type="user",
                    target_id="recent@example.com",
                    details={"reason": "invalid_credentials"},
                    created_at=now_naive - timedelta(days=5),
                ),
                AuditLog(
                    actor_user_id=None,
                    category="auth",
                    action="auth.login_succeeded",
                    target_type="user",
                    target_id="today@example.com",
                    details={},
                    created_at=now_naive - timedelta(hours=2),
                ),
            ]
        )
        db.commit()

        outcome = prune_audit_logs(db, retention_days=30)
        assert outcome.deleted_count == 1
        remaining = db.scalars(select(AuditLog.target_id)).all()
        assert "old@example.com" not in remaining
        assert "recent@example.com" in remaining
        assert "today@example.com" in remaining


def test_prune_with_zero_retention_is_noop(client):
    """retention_days=0 means 'feature disabled' — count_purgeable should
    return 0 even if old rows exist."""
    from app.core.db import SessionLocal
    from app.models.entities import AuditLog
    from app.services.audit_retention import count_purgeable

    with SessionLocal() as db:
        db.add(
            AuditLog(
                actor_user_id=None,
                category="auth",
                action="auth.login_failed",
                target_type="user",
                target_id="ancient@example.com",
                details={},
                created_at=datetime.now(timezone.utc).replace(tzinfo=None)
                - timedelta(days=10000),
            )
        )
        db.commit()

        assert count_purgeable(db, retention_days=0) == 0
        assert count_purgeable(db, retention_days=30) == 1
