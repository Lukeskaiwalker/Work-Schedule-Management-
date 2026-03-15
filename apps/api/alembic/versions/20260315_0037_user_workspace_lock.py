"""add workspace_lock column to users

Revision ID: 20260315_0037
Revises: 20260314_0036
Create Date: 2026-03-15

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260315_0037"
down_revision = "20260314_0036"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "workspace_lock",
            sa.String(32),
            nullable=True,
            server_default=None,
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "workspace_lock")
