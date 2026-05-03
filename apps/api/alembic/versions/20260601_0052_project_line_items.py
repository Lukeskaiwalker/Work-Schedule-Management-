"""project_line_items table

Captures the line items from a project's Auftragsbestätigung (and later
Bestellbestätigungen / Lieferscheine), so the operations team can see
what was sold, what's been ordered, what's been delivered, and what's
still missing — all derived from quantity columns rather than a state
enum (the v2.4.0 design discussion settled on computed status from
quantities to avoid state-machine maintenance).

Foreign keys:
  - project_id → projects.id          (CASCADE on project delete)
  - supplier_id → werkstatt_suppliers.id  (SET NULL on supplier delete)
  - created_by → users.id             (SET NULL on user delete)

No backfill: net-new feature, existing projects start with zero items.

Revision ID: 20260601_0052
Revises: 20260605_0051
Create Date: 2026-05-03 12:00:00.000000
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260601_0052"
down_revision: Union[str, Sequence[str], None] = "20260605_0051"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "project_line_items",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "project_id",
            sa.Integer(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        # ── classification ──────────────────────────────────────────────
        sa.Column("type", sa.String(length=32), nullable=False),
        # "material" | "leistung" | "sonstige"
        # ── core fields ─────────────────────────────────────────────────
        sa.Column("section_title", sa.String(length=255), nullable=True),
        sa.Column("position", sa.String(length=32), nullable=True),
        sa.Column("description", sa.Text(), nullable=False),
        # ── identifiers ─────────────────────────────────────────────────
        sa.Column("sku", sa.String(length=255), nullable=True),
        sa.Column("manufacturer", sa.String(length=128), nullable=True),
        # ── quantities (Numeric so we can store fractional units like
        #    8.5m of cable without losing precision) ──────────────────
        sa.Column("quantity_required", sa.Numeric(12, 2), nullable=False),
        sa.Column(
            "quantity_ordered",
            sa.Numeric(12, 2),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "quantity_delivered",
            sa.Numeric(12, 2),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "quantity_at_site",
            sa.Numeric(12, 2),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "quantity_reserved",
            sa.Numeric(12, 2),
            nullable=False,
            server_default="0",
        ),
        sa.Column("unit", sa.String(length=32), nullable=True),
        # ── pricing (only AB carries this; nullable for Lieferschein) ──
        sa.Column("unit_price_eur", sa.Numeric(12, 2), nullable=True),
        sa.Column("total_price_eur", sa.Numeric(12, 2), nullable=True),
        # ── linkage ──────────────────────────────────────────────────────
        sa.Column(
            "supplier_id",
            sa.Integer(),
            sa.ForeignKey("werkstatt_suppliers.id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
        # ── extraction audit trail ──────────────────────────────────────
        sa.Column("source_doc_type", sa.String(length=64), nullable=True),
        sa.Column("source_doc_filename", sa.String(length=500), nullable=True),
        sa.Column("extracted_by_model", sa.String(length=128), nullable=True),
        sa.Column("extraction_confidence", sa.Numeric(4, 2), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "is_active",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
        # ── audit ────────────────────────────────────────────────────────
        sa.Column(
            "created_by",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )


def downgrade() -> None:
    op.drop_table("project_line_items")
