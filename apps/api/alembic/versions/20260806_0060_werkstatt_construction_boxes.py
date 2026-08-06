"""Werkstatt construction boxes (Baustellenkisten)

Adds the box + box-item tables and a backlink column on the movement ledger.

Two tables:
  * ``werkstatt_construction_boxes`` — the crate itself. Customer-first
    ownership (customer_id) with an optional project, both ON DELETE SET NULL so
    deleting a project or customer never destroys the packing record.
  * ``werkstatt_construction_box_items`` — the packed lines. An item may come
    from a stocked article, from the Datanorm catalog, or be typed by hand, so
    both links are nullable and the identity fields are snapshotted. The catalog
    reference is stored as ``catalog_external_key`` rather than a FK because
    ``material_catalog_items.id`` is NOT stable across Datanorm re-imports (a
    re-import deletes and recreates rows).

Plus ``werkstatt_movements.construction_box_id`` so a box handover is auditable
from the ledger side. Stock only moves at assignment/return, never at packing.

Revision ID: 20260806_0060
Revises: 20260805_0059
Create Date: 2026-08-06 00:00:00.000000
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260806_0060"
down_revision: Union[str, Sequence[str], None] = "20260805_0059"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "werkstatt_construction_boxes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("box_number", sa.String(length=32), nullable=False),
        sa.Column("label", sa.String(length=160), nullable=False),
        # Rack position 1..8 of the fixed workshop boxes; NULL for ad-hoc boxes.
        sa.Column("slot", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="offen"),
        sa.Column(
            "customer_id",
            sa.Integer(),
            sa.ForeignKey("customers.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "project_id",
            sa.Integer(),
            sa.ForeignKey("projects.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("packed_at", sa.DateTime(), nullable=True),
        sa.Column("assigned_at", sa.DateTime(), nullable=True),
        sa.Column("returned_at", sa.DateTime(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "created_by",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    op.create_index(
        "ix_werkstatt_construction_boxes_box_number",
        "werkstatt_construction_boxes",
        ["box_number"],
        unique=True,
    )
    # UNIQUE on slot is what makes the standard-box seeder safe to run
    # concurrently: a second worker racing to create slot 3 loses on the index
    # rather than producing a duplicate rack position.
    op.create_index(
        "ix_werkstatt_construction_boxes_slot",
        "werkstatt_construction_boxes",
        ["slot"],
        unique=True,
    )
    for column in ("status", "customer_id", "project_id", "assigned_at", "created_by"):
        op.create_index(
            f"ix_werkstatt_construction_boxes_{column}",
            "werkstatt_construction_boxes",
            [column],
        )

    op.create_table(
        "werkstatt_construction_box_items",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "box_id",
            sa.Integer(),
            sa.ForeignKey("werkstatt_construction_boxes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("source", sa.String(length=16), nullable=False, server_default="manual"),
        sa.Column(
            "article_id",
            sa.Integer(),
            sa.ForeignKey("werkstatt_articles.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("catalog_external_key", sa.String(length=64), nullable=True),
        sa.Column("item_name", sa.String(length=255), nullable=False),
        sa.Column("article_no", sa.String(length=64), nullable=True),
        sa.Column("ean", sa.String(length=32), nullable=True),
        sa.Column("unit", sa.String(length=32), nullable=True),
        sa.Column("quantity", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "added_by",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    for column in ("box_id", "source", "article_id", "catalog_external_key", "ean", "added_by"):
        op.create_index(
            f"ix_werkstatt_construction_box_items_{column}",
            "werkstatt_construction_box_items",
            [column],
        )

    with op.batch_alter_table("werkstatt_movements", schema=None) as batch_op:
        batch_op.add_column(sa.Column("construction_box_id", sa.Integer(), nullable=True))
        batch_op.create_index(
            "ix_werkstatt_movements_construction_box_id", ["construction_box_id"], unique=False
        )
        batch_op.create_foreign_key(
            "fk_werkstatt_movements_construction_box_id",
            "werkstatt_construction_boxes",
            ["construction_box_id"],
            ["id"],
            ondelete="SET NULL",
        )


def downgrade() -> None:
    with op.batch_alter_table("werkstatt_movements", schema=None) as batch_op:
        batch_op.drop_constraint("fk_werkstatt_movements_construction_box_id", type_="foreignkey")
        batch_op.drop_index("ix_werkstatt_movements_construction_box_id")
        batch_op.drop_column("construction_box_id")

    op.drop_table("werkstatt_construction_box_items")
    op.drop_table("werkstatt_construction_boxes")
