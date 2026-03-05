"""add material catalog and manual material need fields

Revision ID: 20260304_0032
Revises: 20260226_0031
Create Date: 2026-03-04 22:20:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260304_0032"
down_revision: Union[str, Sequence[str], None] = "20260226_0031"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "material_catalog_items",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("external_key", sa.String(length=128), nullable=False),
        sa.Column("source_file", sa.String(length=255), nullable=False),
        sa.Column("source_line", sa.Integer(), nullable=False),
        sa.Column("article_no", sa.String(length=160), nullable=True),
        sa.Column("item_name", sa.String(length=500), nullable=False),
        sa.Column("unit", sa.String(length=64), nullable=True),
        sa.Column("manufacturer", sa.String(length=255), nullable=True),
        sa.Column("ean", sa.String(length=64), nullable=True),
        sa.Column("price_text", sa.String(length=120), nullable=True),
        sa.Column("search_text", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("external_key"),
    )
    op.create_index(op.f("ix_material_catalog_items_external_key"), "material_catalog_items", ["external_key"], unique=True)
    op.create_index(op.f("ix_material_catalog_items_source_file"), "material_catalog_items", ["source_file"], unique=False)
    op.create_index(op.f("ix_material_catalog_items_article_no"), "material_catalog_items", ["article_no"], unique=False)
    op.create_index(op.f("ix_material_catalog_items_item_name"), "material_catalog_items", ["item_name"], unique=False)
    op.create_index(op.f("ix_material_catalog_items_ean"), "material_catalog_items", ["ean"], unique=False)

    op.create_table(
        "material_catalog_import_state",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("source_dir", sa.String(length=500), nullable=False),
        sa.Column("source_signature", sa.String(length=128), nullable=False),
        sa.Column("file_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("item_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("imported_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )

    op.add_column("project_material_needs", sa.Column("material_catalog_item_id", sa.Integer(), nullable=True))
    op.add_column("project_material_needs", sa.Column("article_no", sa.String(length=160), nullable=True))
    op.add_column("project_material_needs", sa.Column("unit", sa.String(length=64), nullable=True))
    op.add_column("project_material_needs", sa.Column("quantity", sa.String(length=64), nullable=True))
    op.create_index(
        op.f("ix_project_material_needs_material_catalog_item_id"),
        "project_material_needs",
        ["material_catalog_item_id"],
        unique=False,
    )
    op.create_foreign_key(
        "fk_pmn_catalog_item",
        "project_material_needs",
        "material_catalog_items",
        ["material_catalog_item_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_pmn_catalog_item",
        "project_material_needs",
        type_="foreignkey",
    )
    op.drop_index(op.f("ix_project_material_needs_material_catalog_item_id"), table_name="project_material_needs")
    op.drop_column("project_material_needs", "quantity")
    op.drop_column("project_material_needs", "unit")
    op.drop_column("project_material_needs", "article_no")
    op.drop_column("project_material_needs", "material_catalog_item_id")

    op.drop_table("material_catalog_import_state")

    op.drop_index(op.f("ix_material_catalog_items_ean"), table_name="material_catalog_items")
    op.drop_index(op.f("ix_material_catalog_items_item_name"), table_name="material_catalog_items")
    op.drop_index(op.f("ix_material_catalog_items_article_no"), table_name="material_catalog_items")
    op.drop_index(op.f("ix_material_catalog_items_source_file"), table_name="material_catalog_items")
    op.drop_index(op.f("ix_material_catalog_items_external_key"), table_name="material_catalog_items")
    op.drop_table("material_catalog_items")
