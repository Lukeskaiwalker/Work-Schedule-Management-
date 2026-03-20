"""add absence request status and review fields

Revision ID: 20260320_0043
Revises: 20260319_0042
Create Date: 2026-03-20 22:55:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260320_0043"
down_revision: Union[str, Sequence[str], None] = "20260319_0042"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "school_absences",
        sa.Column("status", sa.String(length=32), nullable=False, server_default="approved"),
    )
    op.add_column(
        "school_absences",
        sa.Column("reviewed_by", sa.Integer(), nullable=True),
    )
    op.add_column(
        "school_absences",
        sa.Column("reviewed_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_school_absences_status", "school_absences", ["status"], unique=False)
    op.create_index("ix_school_absences_reviewed_by", "school_absences", ["reviewed_by"], unique=False)
    op.create_foreign_key(
        "fk_school_absences_reviewed_by_users",
        "school_absences",
        "users",
        ["reviewed_by"],
        ["id"],
        ondelete="SET NULL",
    )
    op.alter_column("school_absences", "status", server_default=None)


def downgrade() -> None:
    op.drop_constraint("fk_school_absences_reviewed_by_users", "school_absences", type_="foreignkey")
    op.drop_index("ix_school_absences_reviewed_by", table_name="school_absences")
    op.drop_index("ix_school_absences_status", table_name="school_absences")
    op.drop_column("school_absences", "reviewed_at")
    op.drop_column("school_absences", "reviewed_by")
    op.drop_column("school_absences", "status")
