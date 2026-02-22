from __future__ import annotations
"""add required daily hours to users

Revision ID: 20260220_0009
Revises: 20260220_0008
Create Date: 2026-02-20
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "20260220_0009"
down_revision: Union[str, Sequence[str], None] = "20260220_0008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("required_daily_hours", sa.Float(), nullable=False, server_default=sa.text("8.0")),
    )


def downgrade() -> None:
    op.drop_column("users", "required_daily_hours")
