"""Verteiler Materialliste: lines added by hand.

* ``panel_material_manual_lines`` -- material the schematic cannot derive
  (cable duct, DIN rail, ferrules …) added to one board's list: a shelf
  article or a free text, with a quantity and a note. CASCADE with the
  board, SET NULL with the article (the line keeps its name in ``label``).

No backfill: nobody could add such a line before.

Revision ID: 20261009_0099
Revises: 20261009_0098
Create Date: 2026-10-09 00:00:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261009_0099"
down_revision: Union[str, Sequence[str], None] = "20261009_0098"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "panel_material_manual_lines",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("panel_id", sa.Integer(), nullable=False),
        sa.Column("article_id", sa.Integer(), nullable=True),
        sa.Column("label", sa.String(length=255), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("note", sa.String(length=500), nullable=True),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["panel_id"], ["panel_plans.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["article_id"], ["werkstatt_articles.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_panel_material_manual_lines_panel_id", "panel_material_manual_lines", ["panel_id"])
    op.create_index("ix_panel_material_manual_lines_article_id", "panel_material_manual_lines", ["article_id"])


def downgrade() -> None:
    op.drop_index("ix_panel_material_manual_lines_article_id", table_name="panel_material_manual_lines")
    op.drop_index("ix_panel_material_manual_lines_panel_id", table_name="panel_material_manual_lines")
    op.drop_table("panel_material_manual_lines")
