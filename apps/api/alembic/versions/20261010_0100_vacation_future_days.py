"""Vacation over New Year: days planned for a later year.

* ``vacation_requests.pending_future_days`` -- working days of an approved
  request that fall in a year after the holder's balance year and have not
  been deducted yet. Approval deducts only the days up to the balance year;
  the yearly rollover charges the rest to the year they fall in.

Backfill: none needed. Every existing request was approved under the old rule,
which deducted all of its days at once, so nothing of it is still planned --
0 is the truth for every row.

Revision ID: 20261010_0100
Revises: 20261009_0099
Create Date: 2026-10-10 00:00:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261010_0100"
down_revision: Union[str, Sequence[str], None] = "20261009_0099"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "vacation_requests",
        sa.Column("pending_future_days", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("vacation_requests", "pending_future_days")
