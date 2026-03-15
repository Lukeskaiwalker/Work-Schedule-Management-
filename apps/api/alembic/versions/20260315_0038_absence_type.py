"""add absence_type and counts_as_hours to school_absences

Revision ID: 20260315_0038
Revises: 20260315_0037
Create Date: 2026-03-15

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260315_0038"
down_revision = "20260315_0037"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "school_absences",
        sa.Column("absence_type", sa.String(64), nullable=False, server_default="other"),
    )
    op.add_column(
        "school_absences",
        sa.Column("counts_as_hours", sa.Boolean(), nullable=False, server_default="true"),
    )


def downgrade() -> None:
    op.drop_column("school_absences", "counts_as_hours")
    op.drop_column("school_absences", "absence_type")
