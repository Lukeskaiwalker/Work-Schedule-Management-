"""project_class_assignments: add tasks_created_at marker

Adds the deferred-task-creation marker on project_class_assignments
so the v2.4.2 "Auftrag angenommen gate" works without inventing a
parallel pending-templates table.

Backfill: existing assignments are stamped to NOW() so they're treated
as "tasks already created, do not touch." This preserves the user's
explicit "for #4 only new ones; old ones stay" requirement —
projects that already had auto-created tasks keep them, regardless
of their current status.

New behaviour after this migration ships:
  - On project create / template add: only create Tasks when the
    project status is currently "Auftrag angenommen" (otherwise leave
    tasks_created_at NULL).
  - When a project transitions INTO "Auftrag angenommen" status, the
    update endpoint walks all assignments with tasks_created_at IS
    NULL and creates their deferred Tasks, then stamps the column.

Revision ID: 20260605_0054
Revises: 20260603_0053
Create Date: 2026-05-03 17:00:00.000000
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260605_0054"
down_revision: Union[str, Sequence[str], None] = "20260603_0053"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "project_class_assignments",
        sa.Column("tasks_created_at", sa.DateTime(), nullable=True),
    )
    # Backfill: existing assignments are stamped as already-done so
    # the new gate doesn't trigger a flood of duplicate tasks on the
    # next status transition. Pre-existing tasks remain in place.
    op.execute(
        "UPDATE project_class_assignments "
        "SET tasks_created_at = COALESCE(created_at, CURRENT_TIMESTAMP) "
        "WHERE tasks_created_at IS NULL"
    )


def downgrade() -> None:
    op.drop_column("project_class_assignments", "tasks_created_at")
