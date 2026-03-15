"""add preferences column to users

Revision ID: 20260314_0036
Revises: 20260309_0035
Create Date: 2026-03-14

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260314_0036"
down_revision = "20260309_0035"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "preferences",
            sa.JSON(),
            nullable=False,
            server_default="{}",
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "preferences")
