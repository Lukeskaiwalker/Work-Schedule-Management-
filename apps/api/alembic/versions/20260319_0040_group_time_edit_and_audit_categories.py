"""add group time edit flag and audit categories

Revision ID: 20260319_0040
Revises: 20260319_0039
Create Date: 2026-03-19 16:10:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260319_0040"
down_revision: Union[str, Sequence[str], None] = "20260319_0039"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "employee_groups",
        sa.Column("can_update_recent_own_time_entries", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "audit_logs",
        sa.Column("category", sa.String(length=64), nullable=False, server_default="system"),
    )
    op.create_index("ix_audit_logs_category", "audit_logs", ["category"], unique=False)

    connection = op.get_bind()
    connection.execute(
        sa.text(
            """
            UPDATE audit_logs
            SET category = CASE
                WHEN action LIKE 'user.%' THEN 'users'
                WHEN action LIKE 'employee_group.%' THEN 'groups'
                WHEN action LIKE 'role_permissions.%' OR action LIKE 'user_permissions.%' THEN 'permissions'
                WHEN action LIKE 'time.%' OR action LIKE 'time_entry.%' OR action LIKE 'vacation_request.%' OR action LIKE 'school_absence.%' THEN 'time'
                WHEN action LIKE 'project.%' OR action LIKE 'project_class_template.%' THEN 'projects'
                WHEN action LIKE 'task.%' THEN 'tasks'
                WHEN action LIKE 'planning.%' THEN 'planning'
                WHEN action LIKE 'ticket.%' THEN 'tickets'
                WHEN action LIKE 'chat.%' THEN 'chat'
                WHEN action LIKE 'report.%' THEN 'reports'
                WHEN action LIKE 'wiki.%' THEN 'wiki'
                WHEN action LIKE 'settings.%' THEN 'settings'
                WHEN action LIKE 'system.%' OR action LIKE 'backup.%' THEN 'system'
                WHEN action LIKE 'auth.%' THEN 'auth'
                WHEN action LIKE 'finance.%' THEN 'finance'
                WHEN action LIKE 'file.%' THEN 'files'
                ELSE category
            END
            """
        )
    )

    op.alter_column("employee_groups", "can_update_recent_own_time_entries", server_default=None)
    op.alter_column("audit_logs", "category", server_default=None)


def downgrade() -> None:
    op.drop_index("ix_audit_logs_category", table_name="audit_logs")
    op.drop_column("audit_logs", "category")
    op.drop_column("employee_groups", "can_update_recent_own_time_entries")
