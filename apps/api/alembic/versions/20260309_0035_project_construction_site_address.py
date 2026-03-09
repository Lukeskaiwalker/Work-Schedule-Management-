"""add construction site address field to projects

Revision ID: 20260309_0035
Revises: 20260309_0034
Create Date: 2026-03-09 19:45:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260309_0035"
down_revision: Union[str, Sequence[str], None] = "20260309_0034"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _column_names(table_name: str) -> set[str]:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return {column["name"] for column in inspector.get_columns(table_name)}


def upgrade() -> None:
    if "construction_site_address" not in _column_names("projects"):
        op.add_column(
            "projects",
            sa.Column("construction_site_address", sa.String(length=500), nullable=True),
        )


def downgrade() -> None:
    if "construction_site_address" in _column_names("projects"):
        op.drop_column("projects", "construction_site_address")
