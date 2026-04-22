"""werkstatt core schema

Creates the full Werkstatt (workshop / inventory) schema:
  - werkstatt_categories / werkstatt_locations (self-ref trees)
  - werkstatt_suppliers
  - werkstatt_articles                (with partial-unique EAN index)
  - werkstatt_article_suppliers       (M:N with metadata)
  - werkstatt_movements               (append-only ledger)
  - werkstatt_orders / werkstatt_order_lines
  - werkstatt_datanorm_imports        (audit trail)

Also extends the existing `material_catalog_items` table with a nullable
`supplier_id` FK, so each Datanorm row can be attributed to its source
supplier (prior rows backfilled as NULL).

Revision ID: 20260425_0047
Revises: 20260415_0046
Create Date: 2026-04-25 00:00:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260425_0047"
down_revision: Union[str, Sequence[str], None] = "20260415_0046"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── Suppliers ────────────────────────────────────────────────────────
    op.create_table(
        "werkstatt_suppliers",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("short_name", sa.String(length=64), nullable=True),
        sa.Column("email", sa.String(length=255), nullable=True),
        sa.Column("order_email", sa.String(length=255), nullable=True),
        sa.Column("phone", sa.String(length=64), nullable=True),
        sa.Column("contact_person", sa.String(length=255), nullable=True),
        sa.Column("address_street", sa.String(length=255), nullable=True),
        sa.Column("address_zip", sa.String(length=32), nullable=True),
        sa.Column("address_city", sa.String(length=255), nullable=True),
        sa.Column("address_country", sa.String(length=64), nullable=True),
        sa.Column("default_lead_time_days", sa.Integer(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("is_archived", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_werkstatt_suppliers_name", "werkstatt_suppliers", ["name"])
    op.create_index("ix_werkstatt_suppliers_is_archived", "werkstatt_suppliers", ["is_archived"])
    op.create_index("ix_werkstatt_suppliers_created_by", "werkstatt_suppliers", ["created_by"])

    # ── Categories ──────────────────────────────────────────────────────
    op.create_table(
        "werkstatt_categories",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("parent_id", sa.Integer(), nullable=True),
        sa.Column("display_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("icon_key", sa.String(length=64), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("is_archived", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["parent_id"], ["werkstatt_categories.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_werkstatt_categories_name", "werkstatt_categories", ["name"])
    op.create_index("ix_werkstatt_categories_parent_id", "werkstatt_categories", ["parent_id"])
    op.create_index("ix_werkstatt_categories_is_archived", "werkstatt_categories", ["is_archived"])

    # ── Locations ───────────────────────────────────────────────────────
    op.create_table(
        "werkstatt_locations",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("location_type", sa.String(length=32), nullable=False, server_default="hall"),
        sa.Column("parent_id", sa.Integer(), nullable=True),
        sa.Column("address", sa.String(length=500), nullable=True),
        sa.Column("display_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("is_archived", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["parent_id"], ["werkstatt_locations.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_werkstatt_locations_name", "werkstatt_locations", ["name"])
    op.create_index("ix_werkstatt_locations_location_type", "werkstatt_locations", ["location_type"])
    op.create_index("ix_werkstatt_locations_parent_id", "werkstatt_locations", ["parent_id"])
    op.create_index("ix_werkstatt_locations_is_archived", "werkstatt_locations", ["is_archived"])

    # ── Articles ────────────────────────────────────────────────────────
    op.create_table(
        "werkstatt_articles",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("article_number", sa.String(length=32), nullable=False),
        sa.Column("ean", sa.String(length=64), nullable=True),
        sa.Column("item_name", sa.String(length=500), nullable=False),
        sa.Column("manufacturer", sa.String(length=255), nullable=True),
        sa.Column("category_id", sa.Integer(), nullable=True),
        sa.Column("location_id", sa.Integer(), nullable=True),
        sa.Column("unit", sa.String(length=64), nullable=True),
        sa.Column("image_url", sa.String(length=1000), nullable=True),
        sa.Column("image_source", sa.String(length=32), nullable=True),
        sa.Column("image_checked_at", sa.DateTime(), nullable=True),
        sa.Column("source_catalog_item_id", sa.Integer(), nullable=True),
        sa.Column("stock_total", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("stock_available", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("stock_out", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("stock_repair", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("stock_min", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_serialized", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("bg_inspection_required", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("bg_inspection_interval_days", sa.Integer(), nullable=True),
        sa.Column("last_bg_inspected_at", sa.DateTime(), nullable=True),
        sa.Column("next_bg_due_at", sa.DateTime(), nullable=True),
        sa.Column("purchase_price_cents", sa.Integer(), nullable=True),
        sa.Column("currency", sa.String(length=8), nullable=False, server_default="EUR"),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("is_archived", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["category_id"], ["werkstatt_categories.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["location_id"], ["werkstatt_locations.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["source_catalog_item_id"], ["material_catalog_items.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("article_number", name="uq_werkstatt_articles_article_number"),
    )
    op.create_index("ix_werkstatt_articles_article_number", "werkstatt_articles", ["article_number"])
    op.create_index("ix_werkstatt_articles_ean", "werkstatt_articles", ["ean"])
    op.create_index("ix_werkstatt_articles_item_name", "werkstatt_articles", ["item_name"])
    op.create_index("ix_werkstatt_articles_category_id", "werkstatt_articles", ["category_id"])
    op.create_index("ix_werkstatt_articles_location_id", "werkstatt_articles", ["location_id"])
    op.create_index("ix_werkstatt_articles_source_catalog_item_id", "werkstatt_articles", ["source_catalog_item_id"])
    op.create_index("ix_werkstatt_articles_next_bg_due_at", "werkstatt_articles", ["next_bg_due_at"])
    op.create_index("ix_werkstatt_articles_is_archived", "werkstatt_articles", ["is_archived"])
    op.create_index("ix_werkstatt_articles_created_by", "werkstatt_articles", ["created_by"])

    # Partial unique index on EAN — unique only when not NULL. Works on
    # SQLite (>= 3.8), PostgreSQL, and recent MySQL via functional index.
    op.create_index(
        "uq_werkstatt_articles_ean_not_null",
        "werkstatt_articles",
        ["ean"],
        unique=True,
        sqlite_where=sa.text("ean IS NOT NULL"),
        postgresql_where=sa.text("ean IS NOT NULL"),
    )

    # ── Article ↔ Supplier link ────────────────────────────────────────
    op.create_table(
        "werkstatt_article_suppliers",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("article_id", sa.Integer(), nullable=False),
        sa.Column("supplier_id", sa.Integer(), nullable=False),
        sa.Column("supplier_article_no", sa.String(length=160), nullable=True),
        sa.Column("typical_price_cents", sa.Integer(), nullable=True),
        sa.Column("currency", sa.String(length=8), nullable=False, server_default="EUR"),
        sa.Column("typical_lead_time_days", sa.Integer(), nullable=True),
        sa.Column("minimum_order_quantity", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("is_preferred", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("source_catalog_item_id", sa.Integer(), nullable=True),
        sa.Column("last_ordered_at", sa.DateTime(), nullable=True),
        sa.Column("last_confirmed_lead_time_days", sa.Integer(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["article_id"], ["werkstatt_articles.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["supplier_id"], ["werkstatt_suppliers.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["source_catalog_item_id"], ["material_catalog_items.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("article_id", "supplier_id", name="uq_wasup_article_supplier"),
    )
    op.create_index("ix_wasup_article_id", "werkstatt_article_suppliers", ["article_id"])
    op.create_index("ix_wasup_supplier_id", "werkstatt_article_suppliers", ["supplier_id"])
    op.create_index("ix_wasup_supplier_article_no", "werkstatt_article_suppliers", ["supplier_article_no"])
    op.create_index("ix_wasup_is_preferred", "werkstatt_article_suppliers", ["is_preferred"])
    op.create_index("ix_wasup_source_catalog_item_id", "werkstatt_article_suppliers", ["source_catalog_item_id"])
    op.create_index(
        "uq_wasup_supplier_article_no_not_null",
        "werkstatt_article_suppliers",
        ["supplier_id", "supplier_article_no"],
        unique=True,
        sqlite_where=sa.text("supplier_article_no IS NOT NULL"),
        postgresql_where=sa.text("supplier_article_no IS NOT NULL"),
    )

    # ── Movements ───────────────────────────────────────────────────────
    op.create_table(
        "werkstatt_movements",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("article_id", sa.Integer(), nullable=False),
        sa.Column("movement_type", sa.String(length=32), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("from_location_id", sa.Integer(), nullable=True),
        sa.Column("to_location_id", sa.Integer(), nullable=True),
        sa.Column("project_id", sa.Integer(), nullable=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("assignee_user_id", sa.Integer(), nullable=True),
        sa.Column("expected_return_at", sa.DateTime(), nullable=True),
        sa.Column("related_order_line_id", sa.Integer(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["article_id"], ["werkstatt_articles.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["from_location_id"], ["werkstatt_locations.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["to_location_id"], ["werkstatt_locations.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["assignee_user_id"], ["users.id"], ondelete="SET NULL"),
        # related_order_line_id FK added AFTER werkstatt_order_lines is created,
        # below, because the two tables form a cycle.
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_werkstatt_movements_article_id", "werkstatt_movements", ["article_id"])
    op.create_index("ix_werkstatt_movements_movement_type", "werkstatt_movements", ["movement_type"])
    op.create_index("ix_werkstatt_movements_from_location_id", "werkstatt_movements", ["from_location_id"])
    op.create_index("ix_werkstatt_movements_to_location_id", "werkstatt_movements", ["to_location_id"])
    op.create_index("ix_werkstatt_movements_project_id", "werkstatt_movements", ["project_id"])
    op.create_index("ix_werkstatt_movements_user_id", "werkstatt_movements", ["user_id"])
    op.create_index("ix_werkstatt_movements_assignee_user_id", "werkstatt_movements", ["assignee_user_id"])
    op.create_index("ix_werkstatt_movements_expected_return_at", "werkstatt_movements", ["expected_return_at"])
    op.create_index("ix_werkstatt_movements_related_order_line_id", "werkstatt_movements", ["related_order_line_id"])
    op.create_index("ix_werkstatt_movements_created_at", "werkstatt_movements", ["created_at"])

    # ── Orders ──────────────────────────────────────────────────────────
    op.create_table(
        "werkstatt_orders",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("order_number", sa.String(length=32), nullable=False),
        sa.Column("supplier_id", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="draft"),
        sa.Column("total_amount_cents", sa.Integer(), nullable=True),
        sa.Column("currency", sa.String(length=8), nullable=False, server_default="EUR"),
        sa.Column("ordered_at", sa.DateTime(), nullable=True),
        sa.Column("expected_delivery_at", sa.DateTime(), nullable=True),
        sa.Column("delivered_at", sa.DateTime(), nullable=True),
        sa.Column("delivery_reference", sa.String(length=128), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["supplier_id"], ["werkstatt_suppliers.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("order_number", name="uq_werkstatt_orders_order_number"),
    )
    op.create_index("ix_werkstatt_orders_order_number", "werkstatt_orders", ["order_number"])
    op.create_index("ix_werkstatt_orders_supplier_id", "werkstatt_orders", ["supplier_id"])
    op.create_index("ix_werkstatt_orders_status", "werkstatt_orders", ["status"])
    op.create_index("ix_werkstatt_orders_ordered_at", "werkstatt_orders", ["ordered_at"])
    op.create_index("ix_werkstatt_orders_expected_delivery_at", "werkstatt_orders", ["expected_delivery_at"])
    op.create_index("ix_werkstatt_orders_created_by", "werkstatt_orders", ["created_by"])

    # ── Order lines ─────────────────────────────────────────────────────
    op.create_table(
        "werkstatt_order_lines",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("order_id", sa.Integer(), nullable=False),
        sa.Column("article_id", sa.Integer(), nullable=False),
        sa.Column("article_supplier_id", sa.Integer(), nullable=True),
        sa.Column("quantity_ordered", sa.Integer(), nullable=False),
        sa.Column("quantity_received", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("unit_price_cents", sa.Integer(), nullable=True),
        sa.Column("currency", sa.String(length=8), nullable=False, server_default="EUR"),
        sa.Column("line_status", sa.String(length=32), nullable=False, server_default="pending"),
        sa.Column("received_at", sa.DateTime(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["order_id"], ["werkstatt_orders.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["article_id"], ["werkstatt_articles.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["article_supplier_id"], ["werkstatt_article_suppliers.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_werkstatt_order_lines_order_id", "werkstatt_order_lines", ["order_id"])
    op.create_index("ix_werkstatt_order_lines_article_id", "werkstatt_order_lines", ["article_id"])
    op.create_index("ix_werkstatt_order_lines_article_supplier_id", "werkstatt_order_lines", ["article_supplier_id"])
    op.create_index("ix_werkstatt_order_lines_line_status", "werkstatt_order_lines", ["line_status"])

    # ── Close the movement→order_line cycle ────────────────────────────
    # Now that werkstatt_order_lines exists, wire the FK from movements.
    with op.batch_alter_table("werkstatt_movements") as batch:
        batch.create_foreign_key(
            "fk_werkstatt_movements_related_order_line_id",
            "werkstatt_order_lines",
            ["related_order_line_id"],
            ["id"],
            ondelete="SET NULL",
        )

    # ── Datanorm import history ─────────────────────────────────────────
    op.create_table(
        "werkstatt_datanorm_imports",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("supplier_id", sa.Integer(), nullable=False),
        sa.Column("filename", sa.String(length=500), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="uploaded"),
        sa.Column("total_rows", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("rows_new", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("rows_updated", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("rows_failed", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["supplier_id"], ["werkstatt_suppliers.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_werkstatt_datanorm_imports_supplier_id", "werkstatt_datanorm_imports", ["supplier_id"])
    op.create_index("ix_werkstatt_datanorm_imports_status", "werkstatt_datanorm_imports", ["status"])
    op.create_index("ix_werkstatt_datanorm_imports_created_by", "werkstatt_datanorm_imports", ["created_by"])

    # ── Extend material_catalog_items with supplier_id ─────────────────
    with op.batch_alter_table("material_catalog_items") as batch:
        batch.add_column(sa.Column("supplier_id", sa.Integer(), nullable=True))
        batch.create_foreign_key(
            "fk_mci_supplier",
            "werkstatt_suppliers",
            ["supplier_id"],
            ["id"],
            ondelete="SET NULL",
        )
    op.create_index("ix_material_catalog_items_supplier_id", "material_catalog_items", ["supplier_id"])


def downgrade() -> None:
    # Reverse order of upgrade() to respect FK dependencies.

    op.drop_index("ix_material_catalog_items_supplier_id", table_name="material_catalog_items")
    with op.batch_alter_table("material_catalog_items") as batch:
        batch.drop_constraint("fk_mci_supplier", type_="foreignkey")
        batch.drop_column("supplier_id")

    op.drop_index("ix_werkstatt_datanorm_imports_created_by", table_name="werkstatt_datanorm_imports")
    op.drop_index("ix_werkstatt_datanorm_imports_status", table_name="werkstatt_datanorm_imports")
    op.drop_index("ix_werkstatt_datanorm_imports_supplier_id", table_name="werkstatt_datanorm_imports")
    op.drop_table("werkstatt_datanorm_imports")

    with op.batch_alter_table("werkstatt_movements") as batch:
        batch.drop_constraint("fk_werkstatt_movements_related_order_line_id", type_="foreignkey")

    op.drop_index("ix_werkstatt_order_lines_line_status", table_name="werkstatt_order_lines")
    op.drop_index("ix_werkstatt_order_lines_article_supplier_id", table_name="werkstatt_order_lines")
    op.drop_index("ix_werkstatt_order_lines_article_id", table_name="werkstatt_order_lines")
    op.drop_index("ix_werkstatt_order_lines_order_id", table_name="werkstatt_order_lines")
    op.drop_table("werkstatt_order_lines")

    op.drop_index("ix_werkstatt_orders_created_by", table_name="werkstatt_orders")
    op.drop_index("ix_werkstatt_orders_expected_delivery_at", table_name="werkstatt_orders")
    op.drop_index("ix_werkstatt_orders_ordered_at", table_name="werkstatt_orders")
    op.drop_index("ix_werkstatt_orders_status", table_name="werkstatt_orders")
    op.drop_index("ix_werkstatt_orders_supplier_id", table_name="werkstatt_orders")
    op.drop_index("ix_werkstatt_orders_order_number", table_name="werkstatt_orders")
    op.drop_table("werkstatt_orders")

    op.drop_index("ix_werkstatt_movements_created_at", table_name="werkstatt_movements")
    op.drop_index("ix_werkstatt_movements_related_order_line_id", table_name="werkstatt_movements")
    op.drop_index("ix_werkstatt_movements_expected_return_at", table_name="werkstatt_movements")
    op.drop_index("ix_werkstatt_movements_assignee_user_id", table_name="werkstatt_movements")
    op.drop_index("ix_werkstatt_movements_user_id", table_name="werkstatt_movements")
    op.drop_index("ix_werkstatt_movements_project_id", table_name="werkstatt_movements")
    op.drop_index("ix_werkstatt_movements_to_location_id", table_name="werkstatt_movements")
    op.drop_index("ix_werkstatt_movements_from_location_id", table_name="werkstatt_movements")
    op.drop_index("ix_werkstatt_movements_movement_type", table_name="werkstatt_movements")
    op.drop_index("ix_werkstatt_movements_article_id", table_name="werkstatt_movements")
    op.drop_table("werkstatt_movements")

    op.drop_index("uq_wasup_supplier_article_no_not_null", table_name="werkstatt_article_suppliers")
    op.drop_index("ix_wasup_source_catalog_item_id", table_name="werkstatt_article_suppliers")
    op.drop_index("ix_wasup_is_preferred", table_name="werkstatt_article_suppliers")
    op.drop_index("ix_wasup_supplier_article_no", table_name="werkstatt_article_suppliers")
    op.drop_index("ix_wasup_supplier_id", table_name="werkstatt_article_suppliers")
    op.drop_index("ix_wasup_article_id", table_name="werkstatt_article_suppliers")
    op.drop_table("werkstatt_article_suppliers")

    op.drop_index("uq_werkstatt_articles_ean_not_null", table_name="werkstatt_articles")
    op.drop_index("ix_werkstatt_articles_created_by", table_name="werkstatt_articles")
    op.drop_index("ix_werkstatt_articles_is_archived", table_name="werkstatt_articles")
    op.drop_index("ix_werkstatt_articles_next_bg_due_at", table_name="werkstatt_articles")
    op.drop_index("ix_werkstatt_articles_source_catalog_item_id", table_name="werkstatt_articles")
    op.drop_index("ix_werkstatt_articles_location_id", table_name="werkstatt_articles")
    op.drop_index("ix_werkstatt_articles_category_id", table_name="werkstatt_articles")
    op.drop_index("ix_werkstatt_articles_item_name", table_name="werkstatt_articles")
    op.drop_index("ix_werkstatt_articles_ean", table_name="werkstatt_articles")
    op.drop_index("ix_werkstatt_articles_article_number", table_name="werkstatt_articles")
    op.drop_table("werkstatt_articles")

    op.drop_index("ix_werkstatt_locations_is_archived", table_name="werkstatt_locations")
    op.drop_index("ix_werkstatt_locations_parent_id", table_name="werkstatt_locations")
    op.drop_index("ix_werkstatt_locations_location_type", table_name="werkstatt_locations")
    op.drop_index("ix_werkstatt_locations_name", table_name="werkstatt_locations")
    op.drop_table("werkstatt_locations")

    op.drop_index("ix_werkstatt_categories_is_archived", table_name="werkstatt_categories")
    op.drop_index("ix_werkstatt_categories_parent_id", table_name="werkstatt_categories")
    op.drop_index("ix_werkstatt_categories_name", table_name="werkstatt_categories")
    op.drop_table("werkstatt_categories")

    op.drop_index("ix_werkstatt_suppliers_created_by", table_name="werkstatt_suppliers")
    op.drop_index("ix_werkstatt_suppliers_is_archived", table_name="werkstatt_suppliers")
    op.drop_index("ix_werkstatt_suppliers_name", table_name="werkstatt_suppliers")
    op.drop_table("werkstatt_suppliers")
