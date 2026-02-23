"""add site access fields to projects

Revision ID: 20260224_0021
Revises: 20260224_0020
Create Date: 2026-02-24 09:15:00.000000
"""

from __future__ import annotations
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260224_0021"
down_revision: Union[str, Sequence[str], None] = "20260224_0020"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("projects", sa.Column("site_access_type", sa.String(length=64), nullable=True))
    op.add_column("projects", sa.Column("site_access_note", sa.String(length=500), nullable=True))


def downgrade() -> None:
    op.drop_column("projects", "site_access_note")
    op.drop_column("projects", "site_access_type")
