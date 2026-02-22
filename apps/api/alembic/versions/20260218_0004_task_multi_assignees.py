from __future__ import annotations
"""task multi-assignee support

Revision ID: 20260218_0004
Revises: 20260218_0003
Create Date: 2026-02-18
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "20260218_0004"
down_revision: Union[str, Sequence[str], None] = "20260218_0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "task_assignments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("task_id", sa.Integer(), sa.ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.UniqueConstraint("task_id", "user_id", name="uq_task_assignment"),
    )
    op.create_index("ix_task_assignments_task_id", "task_assignments", ["task_id"], unique=False)
    op.create_index("ix_task_assignments_user_id", "task_assignments", ["user_id"], unique=False)

    op.execute(
        """
        INSERT INTO task_assignments (task_id, user_id)
        SELECT id, assignee_id
        FROM tasks
        WHERE assignee_id IS NOT NULL
        """
    )


def downgrade() -> None:
    op.drop_index("ix_task_assignments_user_id", table_name="task_assignments")
    op.drop_index("ix_task_assignments_task_id", table_name="task_assignments")
    op.drop_table("task_assignments")
