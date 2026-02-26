"""add task subtasks

Revision ID: 20260226_0031
Revises: 20260226_0030
Create Date: 2026-02-26 23:58:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260226_0031"
down_revision: Union[str, Sequence[str], None] = "20260226_0030"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    column_names = {column["name"] for column in inspector.get_columns("tasks")}
    if "subtasks" not in column_names:
        op.add_column(
            "tasks",
            sa.Column("subtasks", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    column_names = {column["name"] for column in inspector.get_columns("tasks")}
    if "subtasks" in column_names:
        op.drop_column("tasks", "subtasks")
