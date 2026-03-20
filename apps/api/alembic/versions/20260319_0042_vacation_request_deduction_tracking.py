"""track vacation balance deductions per request

Revision ID: 20260319_0042
Revises: 20260319_0041
Create Date: 2026-03-19 19:05:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260319_0042"
down_revision: Union[str, Sequence[str], None] = "20260319_0041"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("vacation_requests", sa.Column("deducted_available_days", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("vacation_requests", sa.Column("deducted_carryover_days", sa.Integer(), nullable=False, server_default="0"))
    op.alter_column("vacation_requests", "deducted_available_days", server_default=None)
    op.alter_column("vacation_requests", "deducted_carryover_days", server_default=None)


def downgrade() -> None:
    op.drop_column("vacation_requests", "deducted_carryover_days")
    op.drop_column("vacation_requests", "deducted_available_days")
