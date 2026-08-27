"""Structured material lines on a task.

A task's materials were a single free-text column. That is enough for a note
to a colleague and useless for anything else: it cannot be checked off on
site, cannot carry a quantity, and above all identifies no article, so nothing
downstream can reconcile it against stock.

This table exists so a construction box can be unpacked into the task that
consumes it, and so the difference between what was packed and what was
actually fitted can be booked back to the shelf. ``quantity`` is what went
out; ``quantity_used`` is what the report says was fitted and stays NULL until
one exists — a reported zero ("came back untouched") is a different fact from
nobody having said yet, and collapsing them would silently write off stock
that is still in the crate.

``source_box_id`` records provenance because deselecting a box has to remove
exactly the lines selecting it added, and nothing a person typed by hand.

Revision ID: 20260827_0078
Revises: 20260827_0077
Create Date: 2026-08-27
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260827_0078"
down_revision: Union[str, Sequence[str], None] = "20260827_0077"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "task_materials",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("task_id", sa.Integer(), nullable=False),
        sa.Column("source_box_id", sa.Integer(), nullable=True),
        sa.Column("source_box_item_id", sa.Integer(), nullable=True),
        sa.Column("article_id", sa.Integer(), nullable=True),
        sa.Column("item_name", sa.String(length=255), nullable=False),
        sa.Column("article_no", sa.String(length=64), nullable=True),
        sa.Column("ean", sa.String(length=64), nullable=True),
        sa.Column("unit", sa.String(length=32), nullable=True),
        sa.Column("quantity", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("quantity_used", sa.Integer(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("added_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["task_id"], ["tasks.id"], name="fk_task_materials_task_id", ondelete="CASCADE"
        ),
        # SET NULL, not CASCADE: a box line is edited freely while the crate is
        # packed, and losing the task's record of what went out because someone
        # tidied the box afterwards would be the wrong way round.
        sa.ForeignKeyConstraint(
            ["source_box_id"],
            ["werkstatt_construction_boxes.id"],
            name="fk_task_materials_source_box_id",
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["source_box_item_id"],
            ["werkstatt_construction_box_items.id"],
            name="fk_task_materials_source_box_item_id",
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["article_id"],
            ["werkstatt_articles.id"],
            name="fk_task_materials_article_id",
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["added_by"], ["users.id"], name="fk_task_materials_added_by", ondelete="SET NULL"
        ),
    )
    op.create_index("ix_task_materials_task_id", "task_materials", ["task_id"])
    op.create_index("ix_task_materials_source_box_id", "task_materials", ["source_box_id"])
    op.create_index(
        "ix_task_materials_source_box_item_id", "task_materials", ["source_box_item_id"]
    )
    op.create_index("ix_task_materials_article_id", "task_materials", ["article_id"])


def downgrade() -> None:
    op.drop_index("ix_task_materials_article_id", table_name="task_materials")
    op.drop_index("ix_task_materials_source_box_item_id", table_name="task_materials")
    op.drop_index("ix_task_materials_source_box_id", table_name="task_materials")
    op.drop_index("ix_task_materials_task_id", table_name="task_materials")
    op.drop_table("task_materials")
