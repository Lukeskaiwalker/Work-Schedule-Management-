"""Mark task material lines as settled.

Completing a task now books the crate's contents: the fitted part is written
off, the rest goes back on the shelf, and the crate is emptied for the next
job. That must happen exactly once per line — a task can be reopened and
completed again, and a crate can be unlinked after the fact — so each line
records when it was settled instead of the code guessing from the ledger.

Revision ID: 20260827_0079
Revises: 20260827_0078
Create Date: 2026-09-08
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260827_0079"
down_revision: Union[str, Sequence[str], None] = "20260827_0078"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("task_materials", sa.Column("settled_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column("task_materials", "settled_at")
