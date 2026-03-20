"""track current vacation balance year per user

Revision ID: 20260320_0044
Revises: 20260320_0043
Create Date: 2026-03-20 23:28:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260320_0044"
down_revision: Union[str, Sequence[str], None] = "20260320_0043"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("vacation_balance_year", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "vacation_balance_year")
