"""add notes field to project_material_needs

Revision ID: 20260410_0045
Revises: 20260320_0044
Create Date: 2026-04-10 00:00:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260410_0045"
down_revision: Union[str, Sequence[str], None] = "20260320_0044"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("project_material_needs", sa.Column("notes", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("project_material_needs", "notes")
