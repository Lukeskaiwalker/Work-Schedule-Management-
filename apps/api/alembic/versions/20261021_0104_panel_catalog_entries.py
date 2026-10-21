"""Verteilerpläne: the cabinet catalogue table (docs/PANEL_ENCLOSURE.md §3.3, §8).

* ``panel_catalog_entries`` -- cabinets and field modules an admin adds to
  the built-in Hager univers Z catalogue, or overrides/archives a built-in
  one with. One row per code (unique index on ``code``); ``spec`` is the
  JSON spec, null when the row only archives a built-in.

Additive, no backfill: the table ships empty and unread in the preparatory
release, ahead of the feature that uses it, so the feature can be rolled
back by swapping images -- an image only starts against an Alembic head it
knows (the api image runs ``alembic upgrade head``). Rolling back past this
release needs ``alembic downgrade 20261020_0102`` first, which drops the
table; built-in codes keep working without it.

Revision ID: 20261021_0104
Revises: 20261020_0102
Create Date: 2026-10-21 00:00:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261021_0104"
down_revision: Union[str, Sequence[str], None] = "20261020_0102"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "panel_catalog_entries",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("code", sa.String(length=40), nullable=False),
        sa.Column("entry_type", sa.String(length=16), nullable=False),
        sa.Column("spec", sa.JSON(), nullable=True),
        sa.Column("is_archived", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("updated_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["updated_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    # One unique index under the ix_ name, as the model declares it
    # (unique=True, index=True) -- not a constraint plus an index (see 0097).
    op.create_index("ix_panel_catalog_entries_code", "panel_catalog_entries", ["code"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_panel_catalog_entries_code", table_name="panel_catalog_entries")
    op.drop_table("panel_catalog_entries")
