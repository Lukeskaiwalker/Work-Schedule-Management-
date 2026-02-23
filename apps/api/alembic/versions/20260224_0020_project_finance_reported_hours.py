"""add reported_hours_total to project_finances

Revision ID: 20260224_0020
Revises: 20260224_0019
Create Date: 2026-02-24 08:10:00.000000
"""

from __future__ import annotations
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260224_0020"
down_revision: Union[str, Sequence[str], None] = "20260224_0019"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "project_finances",
        sa.Column("reported_hours_total", sa.Float(), nullable=False, server_default="0"),
    )
    op.alter_column("project_finances", "reported_hours_total", server_default=None)


def downgrade() -> None:
    op.drop_column("project_finances", "reported_hours_total")
