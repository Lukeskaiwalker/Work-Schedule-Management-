"""Add the internal planning-certainty label to tasks.

A planner places jobs on the board before they are certain: the week is
roughly right, the day may still move. Nothing on the task said so. The two
columns that sound related are both the wrong axis — ``status`` is execution
progress ("done" drives views, settlement and notifications) and
``customer_confirmation_status`` is whether the EXTERNAL customer said yes to
the date, with a token and an email trail behind it. A tentative slot is
neither: it is OUR planner not having settled yet.

``planning_status`` is that third axis on its own: "tentative" (shown as
"in Planung"), "confirmed" (shown as "bestätigt"), or NULL for an ordinary
task with nothing to say. Nullable and unindexed — it is read on the row,
never filtered on, and every existing task correctly starts with nothing.

It stays independent of the others by construction: a due_date change still
resets the customer's confirmation and leaves this column alone.

Revision ID: 20260912_0081
Revises: 20260910_0080
Create Date: 2026-09-12
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260912_0081"
down_revision: Union[str, Sequence[str], None] = "20260910_0080"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("planning_status", sa.String(length=16), nullable=True))


def downgrade() -> None:
    op.drop_column("tasks", "planning_status")
