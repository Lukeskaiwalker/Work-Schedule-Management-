"""add material catalog image metadata and duplicate import counter

Revision ID: 20260304_0033
Revises: 20260304_0032
Create Date: 2026-03-04 23:45:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260304_0033"
down_revision: Union[str, Sequence[str], None] = "20260304_0032"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("material_catalog_items", sa.Column("image_url", sa.String(length=1000), nullable=True))
    op.add_column("material_catalog_items", sa.Column("image_source", sa.String(length=64), nullable=True))
    op.add_column("material_catalog_items", sa.Column("image_checked_at", sa.DateTime(), nullable=True))
    op.add_column(
        "material_catalog_import_state",
        sa.Column("duplicates_skipped", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("material_catalog_import_state", "duplicates_skipped")
    op.drop_column("material_catalog_items", "image_checked_at")
    op.drop_column("material_catalog_items", "image_source")
    op.drop_column("material_catalog_items", "image_url")
