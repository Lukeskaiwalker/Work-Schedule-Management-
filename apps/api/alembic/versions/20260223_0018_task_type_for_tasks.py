"""add task_type to tasks

Revision ID: 20260223_0018
Revises: 20260223_0017
Create Date: 2026-02-23 22:15:00.000000
"""

from __future__ import annotations
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260223_0018"
down_revision: Union[str, Sequence[str], None] = "20260223_0017"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "tasks",
        sa.Column("task_type", sa.String(length=32), nullable=False, server_default="construction"),
    )
    op.alter_column("tasks", "task_type", server_default=None)


def downgrade() -> None:
    op.drop_column("tasks", "task_type")
