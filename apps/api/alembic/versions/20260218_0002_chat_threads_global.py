from __future__ import annotations
"""allow global chat threads without project

Revision ID: 20260218_0002
Revises: 20260217_0001
Create Date: 2026-02-18
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260218_0002"
down_revision: Union[str, Sequence[str], None] = "20260217_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column("chat_threads", "project_id", existing_type=sa.Integer(), nullable=True)


def downgrade() -> None:
    op.execute("DELETE FROM chat_threads WHERE project_id IS NULL")
    op.alter_column("chat_threads", "project_id", existing_type=sa.Integer(), nullable=False)
