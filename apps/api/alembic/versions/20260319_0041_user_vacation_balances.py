"""add user vacation balance fields

Revision ID: 20260319_0041
Revises: 20260319_0040
Create Date: 2026-03-19 18:30:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260319_0041"
down_revision: Union[str, Sequence[str], None] = "20260319_0040"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("vacation_days_per_year", sa.Float(), nullable=False, server_default="0"))
    op.add_column("users", sa.Column("vacation_days_available", sa.Float(), nullable=False, server_default="0"))
    op.add_column("users", sa.Column("vacation_days_carryover", sa.Float(), nullable=False, server_default="0"))
    op.alter_column("users", "vacation_days_per_year", server_default=None)
    op.alter_column("users", "vacation_days_available", server_default=None)
    op.alter_column("users", "vacation_days_carryover", server_default=None)


def downgrade() -> None:
    op.drop_column("users", "vacation_days_carryover")
    op.drop_column("users", "vacation_days_available")
    op.drop_column("users", "vacation_days_per_year")
