"""Werkstatt (workshop / inventory) ORM models.

All tables in this file are scoped to the Werkstatt feature, except for a
small `supplier_id` extension on the pre-existing `material_catalog_items`
table (declared via migration in `20260425_0047_werkstatt_core.py`; this
file does not re-declare that column — it lives on `MaterialCatalogItem`
in `app/models/materials.py` once its migration has been applied).

See `WERKSTATT_CONTRACT.md` at the repo root for the feature spec and the
per-column meaning. This file is authoritative for the schema shape;
Pydantic schemas in `app/schemas/werkstatt.py` must stay in lock-step.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.core.time import utcnow


# ──────────────────────────────────────────────────────────────────────────
# Taxonomy: categories and locations
# ──────────────────────────────────────────────────────────────────────────


class WerkstattCategory(Base):
    __tablename__ = "werkstatt_categories"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("werkstatt_categories.id", ondelete="SET NULL"), index=True
    )
    display_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    icon_key: Mapped[str | None] = mapped_column(String(64))
    notes: Mapped[str | None] = mapped_column(Text)
    is_archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


class WerkstattLocation(Base):
    __tablename__ = "werkstatt_locations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    # hall | shelf | vehicle | external — enforced in app layer
    location_type: Mapped[str] = mapped_column(String(32), nullable=False, default="hall", index=True)
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("werkstatt_locations.id", ondelete="SET NULL"), index=True
    )
    address: Mapped[str | None] = mapped_column(String(500))
    display_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    notes: Mapped[str | None] = mapped_column(Text)
    is_archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


# ──────────────────────────────────────────────────────────────────────────
# Suppliers
# ──────────────────────────────────────────────────────────────────────────


class WerkstattSupplier(Base):
    __tablename__ = "werkstatt_suppliers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    short_name: Mapped[str | None] = mapped_column(String(64))
    email: Mapped[str | None] = mapped_column(String(255))
    order_email: Mapped[str | None] = mapped_column(String(255))
    phone: Mapped[str | None] = mapped_column(String(64))
    contact_person: Mapped[str | None] = mapped_column(String(255))
    address_street: Mapped[str | None] = mapped_column(String(255))
    address_zip: Mapped[str | None] = mapped_column(String(32))
    address_city: Mapped[str | None] = mapped_column(String(255))
    address_country: Mapped[str | None] = mapped_column(String(64))
    default_lead_time_days: Mapped[int | None] = mapped_column(Integer)
    notes: Mapped[str | None] = mapped_column(Text)
    is_archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)
    created_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )


# ──────────────────────────────────────────────────────────────────────────
# Articles — the physical inventory record
# ──────────────────────────────────────────────────────────────────────────


class WerkstattArticle(Base):
    __tablename__ = "werkstatt_articles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Auto-generated "SP-0001"; see services/werkstatt_article_numbers.py
    article_number: Mapped[str] = mapped_column(
        String(32), nullable=False, unique=True, index=True
    )
    # Partial-unique index declared in migration: unique WHERE ean IS NOT NULL.
    # Here it's just declared as indexed for fast lookups.
    ean: Mapped[str | None] = mapped_column(String(64), index=True)
    item_name: Mapped[str] = mapped_column(String(500), nullable=False, index=True)
    manufacturer: Mapped[str | None] = mapped_column(String(255))

    category_id: Mapped[int | None] = mapped_column(
        ForeignKey("werkstatt_categories.id", ondelete="SET NULL"), index=True
    )
    location_id: Mapped[int | None] = mapped_column(
        ForeignKey("werkstatt_locations.id", ondelete="SET NULL"), index=True
    )
    unit: Mapped[str | None] = mapped_column(String(64))

    image_url: Mapped[str | None] = mapped_column(String(1000))
    # "unielektro" | "manual" | "catalog" — enforced in app layer
    image_source: Mapped[str | None] = mapped_column(String(32))
    image_checked_at: Mapped[datetime | None] = mapped_column(DateTime)

    # Link to the Datanorm catalog row this article was originally created from.
    # Independent of the article-supplier link table (which may have its own
    # per-supplier catalog refs).
    source_catalog_item_id: Mapped[int | None] = mapped_column(
        ForeignKey("material_catalog_items.id", ondelete="SET NULL"), index=True
    )

    # Stock counters — denormalised snapshots. Source of truth is the
    # werkstatt_movements ledger; these are recomputed after every movement.
    stock_total: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    stock_available: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    stock_out: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    stock_repair: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    stock_min: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    is_serialized: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # BG-Prüfung ("Berufsgenossenschaft" tool safety inspection) — mandatory
    # for many German construction tools at regular intervals.
    bg_inspection_required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    bg_inspection_interval_days: Mapped[int | None] = mapped_column(Integer)
    last_bg_inspected_at: Mapped[datetime | None] = mapped_column(DateTime)
    next_bg_due_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)

    purchase_price_cents: Mapped[int | None] = mapped_column(Integer)
    currency: Mapped[str] = mapped_column(String(8), nullable=False, default="EUR")

    notes: Mapped[str | None] = mapped_column(Text)
    is_archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)
    created_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )


# ──────────────────────────────────────────────────────────────────────────
# Article ↔ Supplier (many-to-many with rich metadata)
# ──────────────────────────────────────────────────────────────────────────


class WerkstattArticleSupplier(Base):
    __tablename__ = "werkstatt_article_suppliers"
    __table_args__ = (
        UniqueConstraint("article_id", "supplier_id", name="uq_wasup_article_supplier"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    article_id: Mapped[int] = mapped_column(
        ForeignKey("werkstatt_articles.id", ondelete="CASCADE"), nullable=False, index=True
    )
    supplier_id: Mapped[int] = mapped_column(
        ForeignKey("werkstatt_suppliers.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    # What *this* supplier calls the article in their Datanorm. Partial-
    # unique across (supplier_id, supplier_article_no) — declared in migration.
    supplier_article_no: Mapped[str | None] = mapped_column(String(160), index=True)

    typical_price_cents: Mapped[int | None] = mapped_column(Integer)
    currency: Mapped[str] = mapped_column(String(8), nullable=False, default="EUR")
    typical_lead_time_days: Mapped[int | None] = mapped_column(Integer)
    minimum_order_quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    is_preferred: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)

    # Traceability: which Datanorm row this specific supplier-link came from.
    source_catalog_item_id: Mapped[int | None] = mapped_column(
        ForeignKey("material_catalog_items.id", ondelete="SET NULL"), index=True
    )

    last_ordered_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_confirmed_lead_time_days: Mapped[int | None] = mapped_column(Integer)

    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


# ──────────────────────────────────────────────────────────────────────────
# Movements — append-only ledger
# ──────────────────────────────────────────────────────────────────────────


class WerkstattMovement(Base):
    __tablename__ = "werkstatt_movements"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    article_id: Mapped[int] = mapped_column(
        ForeignKey("werkstatt_articles.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    # checkout | return | intake | correction | repair_out | repair_back
    movement_type: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)

    from_location_id: Mapped[int | None] = mapped_column(
        ForeignKey("werkstatt_locations.id", ondelete="SET NULL"), index=True
    )
    to_location_id: Mapped[int | None] = mapped_column(
        ForeignKey("werkstatt_locations.id", ondelete="SET NULL"), index=True
    )
    project_id: Mapped[int | None] = mapped_column(
        ForeignKey("projects.id", ondelete="SET NULL"), index=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    assignee_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    expected_return_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)

    # Links an incoming (intake) movement back to the order line it fulfilled.
    related_order_line_id: Mapped[int | None] = mapped_column(
        ForeignKey("werkstatt_order_lines.id", ondelete="SET NULL"), index=True
    )

    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False, index=True)


# ──────────────────────────────────────────────────────────────────────────
# Orders & Order Lines
# ──────────────────────────────────────────────────────────────────────────


class WerkstattOrder(Base):
    __tablename__ = "werkstatt_orders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # "BST-2026-0042" — auto-generated, reset counter per year
    order_number: Mapped[str] = mapped_column(String(32), nullable=False, unique=True, index=True)

    supplier_id: Mapped[int] = mapped_column(
        ForeignKey("werkstatt_suppliers.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    # draft | sent | confirmed | partially_delivered | delivered | cancelled
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="draft", index=True)

    total_amount_cents: Mapped[int | None] = mapped_column(Integer)
    currency: Mapped[str] = mapped_column(String(8), nullable=False, default="EUR")

    ordered_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)
    expected_delivery_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime)

    delivery_reference: Mapped[str | None] = mapped_column(String(128))

    notes: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


class WerkstattOrderLine(Base):
    __tablename__ = "werkstatt_order_lines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    order_id: Mapped[int] = mapped_column(
        ForeignKey("werkstatt_orders.id", ondelete="CASCADE"), nullable=False, index=True
    )
    article_id: Mapped[int] = mapped_column(
        ForeignKey("werkstatt_articles.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    # Snapshot of the article-supplier link at the time of ordering, so the
    # article_no + unit price we used are preserved even if the link changes later.
    article_supplier_id: Mapped[int | None] = mapped_column(
        ForeignKey("werkstatt_article_suppliers.id", ondelete="SET NULL"), index=True
    )

    quantity_ordered: Mapped[int] = mapped_column(Integer, nullable=False)
    quantity_received: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    unit_price_cents: Mapped[int | None] = mapped_column(Integer)
    currency: Mapped[str] = mapped_column(String(8), nullable=False, default="EUR")

    # pending | partial | complete | cancelled
    line_status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending", index=True)
    received_at: Mapped[datetime | None] = mapped_column(DateTime)

    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


# ──────────────────────────────────────────────────────────────────────────
# Datanorm import history
# ──────────────────────────────────────────────────────────────────────────


class WerkstattDatanormImport(Base):
    """Audit record of each Datanorm file import, one row per commit."""

    __tablename__ = "werkstatt_datanorm_imports"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    supplier_id: Mapped[int] = mapped_column(
        ForeignKey("werkstatt_suppliers.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    filename: Mapped[str] = mapped_column(String(500), nullable=False)
    # uploaded | previewed | importing | committed | failed | cancelled
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="uploaded", index=True)

    total_rows: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    rows_new: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    rows_updated: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    rows_failed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    started_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime)

    error_message: Mapped[str | None] = mapped_column(Text)

    created_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
