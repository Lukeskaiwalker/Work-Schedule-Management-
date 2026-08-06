"""Dismissable notifications

Adds ``notifications.dismissed_at``.

Until now the panel had exactly one state bit, ``read_at``, and it was set for
every entry at once when the panel opened. Nothing could remove a single
notification, so clicking one navigated away and left it in the list — the
reported "notifications do not really disappear when clicking on them".

``dismissed_at`` is the state that makes an entry leave the list. It is set
either by the user (``PATCH /notifications/{id}/dismiss``) or by the server
when the notification's subject stops being actionable — ``workflow_tasks``
resolves task notifications when the task is completed or deleted.

Soft delete rather than a row delete: the notification history stays auditable,
and "why did this disappear" remains answerable (``dismissed_at`` next to
``read_at`` and ``created_at``).

Backfill: none, on purpose. Existing rows keep ``dismissed_at IS NULL`` and
therefore stay listed, which is exactly their current behaviour. The ones whose
task is already done are still hidden by the read-time filter in
``workflow_notifications._is_notification_visible``, and they get their
``dismissed_at`` the next time that task is touched.

NOTE: the SQLite test path builds its schema with ``Base.metadata.create_all``
(tests/conftest.py), so this migration only ever runs against PostgreSQL and is
never exercised by the test suite. Review it by hand.

Revision ID: 20260808_0063
Revises: 20260808_0062
Create Date: 2026-08-08 00:00:00.000000
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260808_0063"
down_revision: Union[str, Sequence[str], None] = "20260808_0062"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "notifications",
        sa.Column("dismissed_at", sa.DateTime(), nullable=True),
    )
    # Every list query filters on ``dismissed_at IS NULL``.
    op.create_index(
        "ix_notifications_dismissed_at", "notifications", ["dismissed_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_notifications_dismissed_at", table_name="notifications")
    op.drop_column("notifications", "dismissed_at")
