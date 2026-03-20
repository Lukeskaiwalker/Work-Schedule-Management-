"""add task estimated hours

Revision ID: 20260319_0039
Revises: 20260315_0038
Create Date: 2026-03-19 12:00:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260319_0039"
down_revision: Union[str, Sequence[str], None] = "20260315_0038"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("estimated_hours", sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column("tasks", "estimated_hours")
