"""Give a task a last day, so a job that runs Monday to Wednesday is one task.

Until now a task had exactly one date, ``due_date``, and everything that
reasons about "when" — overdue, the overlap check, the planning week, the
day-activity view, the ICS export, the customer's confirmation email — read
that one column as THE day. A three-day installation therefore had to be three
tasks, or one task that the board showed on its first day only and that turned
overdue while the crew was still on site.

``end_date`` is the last day of the window. NULL means single-day (Bis = Von),
which is what every existing row is, so there is no backfill: an absent value
reads exactly as before. The CHECK pins the two invariants the schema layer
also enforces — an end without a start is meaningless, and the end may not lie
before the start — so a stray UPDATE cannot leave a window the readers would
have to guess at.

``batch_alter_table`` is what makes the CHECK land on SQLite (which cannot ADD
CONSTRAINT in place and rebuilds the table instead); on Postgres batch mode
degrades to plain ALTERs.

Revision ID: 20260918_0083
Revises: 20260917_0082
Create Date: 2026-09-18
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260918_0083"
down_revision: Union[str, Sequence[str], None] = "20260917_0082"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

CHECK_NAME = "ck_tasks_end_date_after_due_date"
CHECK_SQL = "end_date IS NULL OR (due_date IS NOT NULL AND end_date >= due_date)"


def upgrade() -> None:
    with op.batch_alter_table("tasks") as batch:
        batch.add_column(sa.Column("end_date", sa.Date(), nullable=True))
        batch.create_check_constraint(CHECK_NAME, CHECK_SQL)


def downgrade() -> None:
    with op.batch_alter_table("tasks") as batch:
        batch.drop_constraint(CHECK_NAME, type_="check")
        batch.drop_column("end_date")
