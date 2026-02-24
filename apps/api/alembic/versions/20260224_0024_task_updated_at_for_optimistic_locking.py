"""add tasks.updated_at for optimistic locking

Revision ID: 20260224_0024
Revises: 20260224_0023
Create Date: 2026-02-24 21:45:00.000000
"""

from __future__ import annotations
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260224_0024"
down_revision: Union[str, Sequence[str], None] = "20260224_0023"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "tasks",
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
    )


def downgrade() -> None:
    op.drop_column("tasks", "updated_at")
