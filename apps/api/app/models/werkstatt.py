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
    # Availability of the place itself, as distinct from what is stored in it:
    # open | closed for a hall or an external site, in_workshop | on_route for a
    # vehicle. Nullable because a shelf has no status of its own — it inherits
    # whatever its parent hall is doing.
    status: Mapped[str | None] = mapped_column(String(32))
    # Set on `external` locations that are a specific customer's site, so
    # "which machines are still at Müller" is a query rather than a guess based
    # on how someone typed the location name.
    customer_id: Mapped[int | None] = mapped_column(
        ForeignKey("customers.id", ondelete="SET NULL"), index=True
    )
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
    # The barcode WE printed, for stock that reached the shelf without a
    # manufacturer one — the stock-take station mints "SMPL-XXXXXX" and puts it
    # on a label. It gets its own column rather than borrowing `ean` on purpose:
    # an EAN means "the manufacturer says this is the product", and a code we
    # invented does not. Conflating them makes an in-house sticker look like a
    # GTIN to catalog matching, supplier lookups and any future price import.
    # Nullable because catalog-sourced articles never need one.
    internal_code: Mapped[str | None] = mapped_column(String(64), index=True)
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
    # Links a checkout/return movement back to the construction box that caused
    # it, so a box handover is auditable from the ledger side too.
    construction_box_id: Mapped[int | None] = mapped_column(
        ForeignKey("werkstatt_construction_boxes.id", ondelete="SET NULL"), index=True
    )
    # Set when the movement concerns one individually tracked machine rather
    # than a quantity of a fungible article. Deliberately the same ledger: "who
    # had this drill last, and did it come back" is the same question as "where
    # did the stock go", and a second table would mean two half-answers and two
    # places to forget to write to. `quantity` is always 1 for these rows.
    unit_id: Mapped[int | None] = mapped_column(
        ForeignKey("werkstatt_article_units.id", ondelete="SET NULL"), index=True
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

    # ── Procurement extension ───────────────────────────────────────────
    # See models/werkstatt_procurement.py for the wholesaler-punchout side.

    # Human label. "BST-2026-0042" is unambiguous and tells a fitter nothing;
    # a cart pulled from a wholesaler has no name of its own, and a template
    # is unusable without one.
    title: Mapped[str | None] = mapped_column(String(255))

    # A template is an order that is never ordered — a saved shopping list for
    # a recurring job ("Zählerschrank-Standardbestückung"). It lives in this
    # table rather than a parallel one because a template IS an order in every
    # respect except that it stays put: same lines, same supplier, same editing
    # screen. A separate table would have duplicated all of that and then
    # drifted from it.
    #
    # The cost of that choice is that every query over real orders must exclude
    # templates. `list_orders` does, and the reorder/delivery paths cannot
    # reach one because a template never leaves `draft`.
    is_template: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, index=True
    )
    template_name: Mapped[str | None] = mapped_column(String(255))

    # What the order is FOR. Both nullable and both allowed together: an order
    # can belong to a job that itself belongs to a project, while a plain
    # stock-replenishment order belongs to neither.
    task_id: Mapped[int | None] = mapped_column(
        ForeignKey("tasks.id", ondelete="SET NULL"), index=True
    )
    project_id: Mapped[int | None] = mapped_column(
        ForeignKey("projects.id", ondelete="SET NULL"), index=True
    )

    # manual | ids | template | merge | reorder
    source: Mapped[str] = mapped_column(
        String(32), nullable=False, default="manual", index=True
    )
    # The wholesaler's own handle for this cart, when they send one back.
    external_reference: Mapped[str | None] = mapped_column(String(128))

    # Set when this order was folded into another. The row is kept rather than
    # deleted so "where did my order go?" has an answer and the audit trail
    # survives the merge.
    merged_into_order_id: Mapped[int | None] = mapped_column(
        ForeignKey("werkstatt_orders.id", ondelete="SET NULL"), index=True
    )
    merged_at: Mapped[datetime | None] = mapped_column(DateTime)

    # When the cart was last handed over to the shop. Distinct from
    # `ordered_at`: handing a basket to the wholesaler's checkout is not the
    # same as the order being placed, and the user may do it more than once.
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime)

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
    # Nullable since the procurement extension. A line is one of two things:
    #
    #   resolved  — article_id points at a stocked article. Delivery moves
    #               stock, exactly as before.
    #   free      — article_id is NULL and the snapshot columns below carry
    #               everything we know. Delivery records the receipt but moves
    #               no stock, because there is no stock to move.
    #
    # The second kind is the whole reason a wholesaler cart can land here at
    # all. Most of what comes back from a shop is job material — 40 m of cable,
    # a box of terminals, one specific relay for one specific fault — that is
    # bought, fitted and gone. Forcing a `werkstatt_articles` row for each would
    # fill the inventory with thousands of things nobody will ever count on a
    # shelf, and would make the stock figures for the things we DO count
    # meaningless.
    #
    # A free line can be promoted later: point `article_id` at an article and
    # it starts behaving like a resolved one. That is a one-way door on purpose
    # — nothing demotes a resolved line back.
    article_id: Mapped[int | None] = mapped_column(
        ForeignKey("werkstatt_articles.id", ondelete="RESTRICT"), index=True
    )
    # Snapshot of the article-supplier link at the time of ordering, so the
    # article_no + unit price we used are preserved even if the link changes later.
    article_supplier_id: Mapped[int | None] = mapped_column(
        ForeignKey("werkstatt_article_suppliers.id", ondelete="SET NULL"), index=True
    )

    # ── Snapshot of what the supplier called it ─────────────────────────
    # Always written, for resolved lines too. The supplier renames things, the
    # article-supplier link can be edited or deleted, and a delivery note has
    # to still match the order a year later. These columns are what we ordered;
    # the joins are only what we currently believe.
    supplier_article_no: Mapped[str | None] = mapped_column(String(160), index=True)
    description: Mapped[str | None] = mapped_column(String(500))
    manufacturer: Mapped[str | None] = mapped_column(String(255))
    ean: Mapped[str | None] = mapped_column(String(64), index=True)
    unit: Mapped[str | None] = mapped_column(String(64))

    # Which inbound cart produced this line. Survives a merge, so a line in a
    # combined order can still be traced to the shopping trip it came from.
    source_import_id: Mapped[int | None] = mapped_column(
        ForeignKey("werkstatt_order_imports.id", ondelete="SET NULL"), index=True
    )

    # Whole units only, deliberately unchanged. The movement ledger and every
    # stock counter downstream are integers, and widening this one column would
    # push decimals through all of them. A cart line that arrives as "2,5" is
    # rounded UP at import and flagged in the preview, so the operator sees it
    # and can correct it — see services/ids_cart_parser.py.
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


# ──────────────────────────────────────────────────────────────────────────
# Construction boxes (Baustellenkisten)
# ──────────────────────────────────────────────────────────────────────────
#
# A construction box is a physical crate packed in the workshop and handed to
# a customer / taken to a site. Lifecycle:
#
#   offen  →  gepackt  →  zugewiesen  →  zurueck
#   (packing)  (sealed)   (with customer)  (back in the workshop)
#
# STOCK SEMANTICS (deliberate): packing does NOT move stock — a half-packed box
# is a picking list, and per-item ledger writes during packing would be pure
# churn. Stock moves once, at ASSIGNMENT (`checkout` movements for the contents)
# and unwinds on RETURN (`return` movements). That keeps stock_available and the
# "auf Baustelle" KPIs honest without a noisy ledger.


class WerkstattConstructionBox(Base):
    __tablename__ = "werkstatt_construction_boxes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # "BK-2026-0001" — auto-generated, counter resets per year (mirrors orders).
    box_number: Mapped[str] = mapped_column(String(32), nullable=False, unique=True, index=True)
    label: Mapped[str] = mapped_column(String(160), nullable=False)

    # Rack position 1..8 for the fixed boxes that physically live in the
    # workshop and are re-used job after job (see STANDARD_BOX_SLOTS in
    # services/werkstatt_boxes.py). NULL = an ad-hoc box created for one job.
    # Standard boxes are seeded on demand and cannot be deleted, only emptied.
    slot: Mapped[int | None] = mapped_column(Integer, unique=True, index=True)

    # offen | gepackt | zugewiesen | zurueck
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="offen", index=True)

    # Ownership mirrors ConstructionReport: customer-first, project optional.
    # Both SET NULL — deleting a project must never destroy the box record.
    customer_id: Mapped[int | None] = mapped_column(
        ForeignKey("customers.id", ondelete="SET NULL"), index=True
    )
    project_id: Mapped[int | None] = mapped_column(
        ForeignKey("projects.id", ondelete="SET NULL"), index=True
    )

    packed_at: Mapped[datetime | None] = mapped_column(DateTime)
    assigned_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)
    returned_at: Mapped[datetime | None] = mapped_column(DateTime)

    notes: Mapped[str | None] = mapped_column(Text)
    # Nullable because the standard rack boxes are seeded by the system rather
    # than created by a person — there is no honest user to attribute them to.
    created_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


class WerkstattConstructionBoxItem(Base):
    """One packed line in a construction box.

    An item can originate from three places, hence the nullable links:

      * ``article``  — a stocked WerkstattArticle (``article_id`` set). Only
        these can move stock on assignment.
      * ``catalog``  — a Datanorm catalog row that is orderable but not stocked.
        We store ``catalog_external_key`` rather than a catalog FK **because
        material_catalog_items.id is not stable across Datanorm re-imports** —
        a re-import deletes and recreates rows, which would silently repoint or
        orphan an id-based link.
      * ``manual``   — typed on site, no system record at all.

    In every case the identity fields (name / article_no / ean / unit) are
    SNAPSHOTTED at pack time, so a box always shows what was actually packed
    even after a catalog re-import or an article rename.
    """

    __tablename__ = "werkstatt_construction_box_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    box_id: Mapped[int] = mapped_column(
        ForeignKey("werkstatt_construction_boxes.id", ondelete="CASCADE"), nullable=False, index=True
    )

    # article | catalog | manual
    source: Mapped[str] = mapped_column(String(16), nullable=False, default="manual", index=True)
    article_id: Mapped[int | None] = mapped_column(
        ForeignKey("werkstatt_articles.id", ondelete="SET NULL"), index=True
    )
    catalog_external_key: Mapped[str | None] = mapped_column(String(64), index=True)

    # Snapshotted identity — always populated regardless of source.
    item_name: Mapped[str] = mapped_column(String(255), nullable=False)
    article_no: Mapped[str | None] = mapped_column(String(64))
    ean: Mapped[str | None] = mapped_column(String(32), index=True)
    unit: Mapped[str | None] = mapped_column(String(32))

    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    notes: Mapped[str | None] = mapped_column(Text)
    added_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


# ──────────────────────────────────────────────────────────────────────────
# Machines: individually tracked units of a catalogue article
# ──────────────────────────────────────────────────────────────────────────


class WerkstattArticleUnit(Base):
    """One physically individual machine, tool or accessory.

    The catalogue (`werkstatt_articles`) describes a *type* — "Bosch GSR 18V" —
    and carries a fungible quantity. That is right for screws and wrong for
    machines: you cannot send "3 of the drill" to a site and later ask which one
    is overdue for its DGUV3 inspection, who had it last, or whether its battery
    came back with it. A unit is the answer to "which one".

    An article opts in via `werkstatt_articles.is_serialized`. Rows here exist
    only for serialized articles, so the two stock models never overlap: a
    serialized article's quantity is the count of its live units, and everything
    else keeps using the movement-derived counters.

    Sub-components (a charger belonging to a drill) are units whose
    `parent_unit_id` points at the machine they travel with. That is deliberately
    the same table rather than a separate one: a battery is itself a machine that
    can be lent out alone, needs its own inspection date, and can be swapped
    between drills — all of which a plain "accessory" row could not express.
    """

    __tablename__ = "werkstatt_article_units"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    # "M-0001" — generated, printed on the label stuck to the machine, and what
    # the scanner reads. Unique across the whole workshop, which is what makes
    # a scan unambiguous without the user picking from a list.
    unit_number: Mapped[str] = mapped_column(String(32), nullable=False, unique=True, index=True)

    article_id: Mapped[int] = mapped_column(
        ForeignKey("werkstatt_articles.id", ondelete="RESTRICT"), nullable=False, index=True
    )

    # Self-reference for sub-components. SET NULL, not CASCADE: detaching a
    # charger from a scrapped drill must leave the charger in the inventory.
    parent_unit_id: Mapped[int | None] = mapped_column(
        ForeignKey("werkstatt_article_units.id", ondelete="SET NULL"), index=True
    )

    # The manufacturer's own number, when it is legible. Kept alongside our
    # generated one so a machine can still be identified after the label peels
    # off, and so warranty claims have something to quote.
    serial_number: Mapped[str | None] = mapped_column(String(120), index=True)

    # verfuegbar | ausgegeben | wartung | defekt | ausgemustert
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="verfuegbar", index=True
    )

    # Where the machine physically is. werkstatt_locations already models the
    # three places the crew cares about via location_type: the workshop
    # (hall/shelf), a van (vehicle) and a customer site (external).
    current_location_id: Mapped[int | None] = mapped_column(
        ForeignKey("werkstatt_locations.id", ondelete="SET NULL"), index=True
    )

    # Who currently has it. Distinct from location on purpose — a machine booked
    # to a person still sits in a van, and both facts matter when it goes
    # missing.
    holder_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )

    # Booking window. `booked_until` NULL means "until returned"; the scanner's
    # default of "for today" writes an end-of-day timestamp so an unreturned
    # machine shows up as overdue tomorrow rather than never.
    booked_from: Mapped[datetime | None] = mapped_column(DateTime)
    booked_until: Mapped[datetime | None] = mapped_column(DateTime, index=True)

    # DGUV3 / BG-Prüfung, per unit rather than per type. The article-level fields
    # of the same name stay as the DEFAULT for new units; once a machine exists
    # its own dates are authoritative, because two identical drills bought a year
    # apart are not due on the same day.
    inspection_required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    inspection_interval_days: Mapped[int | None] = mapped_column(Integer)
    last_inspected_at: Mapped[datetime | None] = mapped_column(DateTime)
    next_inspection_due_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)

    purchased_at: Mapped[datetime | None] = mapped_column(DateTime)
    notes: Mapped[str | None] = mapped_column(Text)

    is_archived: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, index=True
    )
    created_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, onupdate=utcnow, nullable=False
    )
