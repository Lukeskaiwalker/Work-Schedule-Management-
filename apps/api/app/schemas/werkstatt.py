"""Werkstatt Pydantic schemas — shells authored by the orchestrator.

Agents extend these by appending named sections (do NOT edit existing
classes). Each schema MUST stay in lock-step with
`apps/web/src/types/werkstatt.ts`.

Sections:
  §1  Primitives & enums
  §2  Taxonomy  (Desktop BE)
  §3  Suppliers (Desktop BE)
  §4  Articles  (Desktop BE)
  §5  Movements (Mobile BE writes; all personas read)
  §6  Orders    (Tablet BE)
  §7  Reorder   (Tablet BE)
  §8  Inspections (Tablet BE)
  §9  Scan      (Mobile BE)
  §10 Datanorm  (Desktop BE)
  §11 Dashboard aggregate (Desktop BE)
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

# Machines live in their own schema module (this file is already the shared
# article/stock contract). The scan cascade can return one, so the union below
# needs the type — the dependency only goes this way, never back.
from app.schemas.werkstatt_machines import MachineOut


# ──────────────────────────────────────────────────────────────────────────
# §1  Primitives & enums
# ──────────────────────────────────────────────────────────────────────────

WerkstattStockStatus = Literal["available", "low", "empty", "out", "unavailable"]

WerkstattMovementType = Literal[
    "checkout", "return", "intake", "correction", "repair_out", "repair_back"
]

WerkstattOrderStatus = Literal[
    "draft", "sent", "confirmed", "partially_delivered", "delivered", "cancelled"
]

WerkstattOrderLineStatus = Literal["pending", "partial", "complete", "cancelled"]

WerkstattImageSource = Literal["unielektro", "manual", "catalog"]

WerkstattLocationType = Literal["hall", "shelf", "vehicle", "external"]
WerkstattLocationStatus = Literal["open", "closed", "on_route", "in_workshop"]

ScanMatchedBy = Literal["sp", "ean", "supplier_no", "catalog_ean", "catalog_article_no"]

WerkstattInspectionUrgency = Literal["ok", "due_soon", "overdue"]

DatanormImportStatus = Literal[
    "uploaded", "previewed", "importing", "committed", "failed", "cancelled"
]


class _OrmBase(BaseModel):
    """Base for ORM-backed response models. `from_attributes` enables
    SQLAlchemy row → Pydantic conversion."""

    model_config = ConfigDict(from_attributes=True)


# ──────────────────────────────────────────────────────────────────────────
# §2  Taxonomy — Desktop BE
# ──────────────────────────────────────────────────────────────────────────


class WerkstattCategoryOut(_OrmBase):
    id: int
    name: str
    parent_id: int | None
    display_order: int
    icon_key: str | None
    notes: str | None
    is_archived: bool
    article_count: int = 0
    created_at: datetime
    updated_at: datetime


class WerkstattLocationOut(_OrmBase):
    id: int
    name: str
    location_type: WerkstattLocationType
    parent_id: int | None
    address: str | None
    # open | closed (hall / external), in_workshop | on_route (vehicle),
    # null for a shelf, which inherits its hall's.
    status: WerkstattLocationStatus | None = None
    display_order: int
    notes: str | None
    is_archived: bool
    article_count: int = 0
    created_at: datetime
    updated_at: datetime


# Desktop BE: append WerkstattCategoryCreate / Update, WerkstattLocationCreate /
# Update here. Keep response models ending in `Out`, payload models in `Create`
# / `Update`.


class WerkstattCategoryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    parent_id: int | None = None
    display_order: int = 0
    icon_key: str | None = Field(default=None, max_length=64)
    notes: str | None = None


class WerkstattCategoryUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    parent_id: int | None = None
    display_order: int | None = None
    icon_key: str | None = Field(default=None, max_length=64)
    notes: str | None = None
    is_archived: bool | None = None


class WerkstattLocationCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    location_type: WerkstattLocationType = "hall"
    parent_id: int | None = None
    address: str | None = Field(default=None, max_length=500)
    status: WerkstattLocationStatus | None = None
    display_order: int = 0
    notes: str | None = None


class WerkstattLocationUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    location_type: WerkstattLocationType | None = None
    parent_id: int | None = None
    address: str | None = Field(default=None, max_length=500)
    status: WerkstattLocationStatus | None = None
    display_order: int | None = None
    notes: str | None = None
    is_archived: bool | None = None


# ──────────────────────────────────────────────────────────────────────────
# §3  Suppliers — Desktop BE
# ──────────────────────────────────────────────────────────────────────────


class WerkstattSupplierOut(_OrmBase):
    id: int
    name: str
    short_name: str | None
    email: str | None
    order_email: str | None
    phone: str | None
    contact_person: str | None
    address_street: str | None
    address_zip: str | None
    address_city: str | None
    address_country: str | None
    default_lead_time_days: int | None
    notes: str | None
    is_archived: bool
    article_count: int = 0
    last_order_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


# Desktop BE: append WerkstattSupplierCreate / Update here.


class WerkstattSupplierCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    short_name: str | None = Field(default=None, max_length=64)
    email: str | None = Field(default=None, max_length=255)
    order_email: str | None = Field(default=None, max_length=255)
    phone: str | None = Field(default=None, max_length=64)
    contact_person: str | None = Field(default=None, max_length=255)
    address_street: str | None = Field(default=None, max_length=255)
    address_zip: str | None = Field(default=None, max_length=32)
    address_city: str | None = Field(default=None, max_length=255)
    address_country: str | None = Field(default=None, max_length=64)
    default_lead_time_days: int | None = Field(default=None, ge=0, le=365)
    notes: str | None = None


class WerkstattSupplierUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    short_name: str | None = Field(default=None, max_length=64)
    email: str | None = Field(default=None, max_length=255)
    order_email: str | None = Field(default=None, max_length=255)
    phone: str | None = Field(default=None, max_length=64)
    contact_person: str | None = Field(default=None, max_length=255)
    address_street: str | None = Field(default=None, max_length=255)
    address_zip: str | None = Field(default=None, max_length=32)
    address_city: str | None = Field(default=None, max_length=255)
    address_country: str | None = Field(default=None, max_length=64)
    default_lead_time_days: int | None = Field(default=None, ge=0, le=365)
    notes: str | None = None
    is_archived: bool | None = None


# ──────────────────────────────────────────────────────────────────────────
# §4  Articles — Desktop BE
# ──────────────────────────────────────────────────────────────────────────


class WerkstattArticleSupplierOut(_OrmBase):
    id: int
    article_id: int
    supplier_id: int
    supplier_name: str
    supplier_article_no: str | None
    typical_price_cents: int | None
    currency: str
    typical_lead_time_days: int | None
    effective_lead_time_days: int | None
    minimum_order_quantity: int
    is_preferred: bool
    source_catalog_item_id: int | None
    last_ordered_at: datetime | None
    last_confirmed_lead_time_days: int | None
    notes: str | None
    created_at: datetime
    updated_at: datetime


class WerkstattArticleOut(_OrmBase):
    id: int
    article_number: str
    ean: str | None
    item_name: str
    manufacturer: str | None
    category_id: int | None
    category_name: str | None
    location_id: int | None
    location_name: str | None
    unit: str | None

    image_url: str | None
    image_source: WerkstattImageSource | None
    image_checked_at: datetime | None

    source_catalog_item_id: int | None

    stock_total: int
    stock_available: int
    stock_out: int
    stock_repair: int
    stock_min: int
    stock_status: WerkstattStockStatus

    is_serialized: bool
    bg_inspection_required: bool
    bg_inspection_interval_days: int | None
    last_bg_inspected_at: datetime | None
    next_bg_due_at: datetime | None

    purchase_price_cents: int | None
    currency: str
    notes: str | None
    is_archived: bool

    suppliers: list[WerkstattArticleSupplierOut] = Field(default_factory=list)
    next_expected_delivery_at: datetime | None = None

    created_at: datetime
    updated_at: datetime


class WerkstattArticleLiteOut(_OrmBase):
    id: int
    article_number: str
    ean: str | None
    item_name: str
    manufacturer: str | None
    category_name: str | None
    location_name: str | None
    stock_available: int
    stock_total: int
    stock_status: WerkstattStockStatus
    image_url: str | None
    next_expected_delivery_at: datetime | None = None


# Desktop BE: append WerkstattArticleCreate / Update / ArticleSupplierCreate here.


class WerkstattArticleSupplierCreate(BaseModel):
    supplier_id: int
    supplier_article_no: str | None = Field(default=None, max_length=160)
    typical_price_cents: int | None = Field(default=None, ge=0)
    currency: str = Field(default="EUR", min_length=1, max_length=8)
    typical_lead_time_days: int | None = Field(default=None, ge=0, le=365)
    minimum_order_quantity: int = Field(default=1, ge=1)
    is_preferred: bool = False
    source_catalog_item_id: int | None = None
    notes: str | None = None


class WerkstattArticleSupplierUpdate(BaseModel):
    supplier_article_no: str | None = Field(default=None, max_length=160)
    typical_price_cents: int | None = Field(default=None, ge=0)
    currency: str | None = Field(default=None, min_length=1, max_length=8)
    typical_lead_time_days: int | None = Field(default=None, ge=0, le=365)
    minimum_order_quantity: int | None = Field(default=None, ge=1)
    is_preferred: bool | None = None
    source_catalog_item_id: int | None = None
    notes: str | None = None


class WerkstattArticleCreate(BaseModel):
    ean: str | None = Field(default=None, max_length=64)
    item_name: str = Field(min_length=1, max_length=500)
    manufacturer: str | None = Field(default=None, max_length=255)
    category_id: int | None = None
    location_id: int | None = None
    unit: str | None = Field(default=None, max_length=64)
    image_url: str | None = Field(default=None, max_length=1000)
    image_source: WerkstattImageSource | None = None
    source_catalog_item_id: int | None = None
    stock_total: int = Field(default=0, ge=0)
    stock_min: int = Field(default=0, ge=0)
    is_serialized: bool = False
    bg_inspection_required: bool = False
    bg_inspection_interval_days: int | None = Field(default=None, ge=1, le=3650)
    purchase_price_cents: int | None = Field(default=None, ge=0)
    currency: str = Field(default="EUR", min_length=1, max_length=8)
    notes: str | None = None
    supplier_links: list[WerkstattArticleSupplierCreate] = Field(default_factory=list)


class WerkstattArticleUpdate(BaseModel):
    ean: str | None = Field(default=None, max_length=64)
    item_name: str | None = Field(default=None, min_length=1, max_length=500)
    manufacturer: str | None = Field(default=None, max_length=255)
    category_id: int | None = None
    location_id: int | None = None
    unit: str | None = Field(default=None, max_length=64)
    image_url: str | None = Field(default=None, max_length=1000)
    image_source: WerkstattImageSource | None = None
    stock_min: int | None = Field(default=None, ge=0)
    is_serialized: bool | None = None
    bg_inspection_required: bool | None = None
    bg_inspection_interval_days: int | None = Field(default=None, ge=1, le=3650)
    purchase_price_cents: int | None = Field(default=None, ge=0)
    currency: str | None = Field(default=None, min_length=1, max_length=8)
    notes: str | None = None
    is_archived: bool | None = None


class WerkstattArticleLinkCatalog(BaseModel):
    catalog_item_id: int


class WerkstattArticleFromCatalogCreate(BaseModel):
    catalog_item_id: int
    category_id: int | None = None
    location_id: int | None = None
    stock_total: int = Field(default=0, ge=0)
    stock_min: int = Field(default=0, ge=0)
    notes: str | None = None
    supplier_links: list[WerkstattArticleSupplierCreate] = Field(default_factory=list)


# ──────────────────────────────────────────────────────────────────────────
# §5  Movements — shared
# ──────────────────────────────────────────────────────────────────────────


class WerkstattMovementOut(_OrmBase):
    id: int
    article_id: int
    article_number: str
    article_name: str
    movement_type: WerkstattMovementType
    quantity: int
    from_location_name: str | None
    to_location_name: str | None
    project_id: int | None
    project_number: str | None
    project_name: str | None
    user_id: int
    user_display_name: str
    assignee_user_id: int | None
    assignee_display_name: str | None
    expected_return_at: datetime | None
    notes: str | None
    created_at: datetime


# ── Mobile BE: quick-ops payloads + my-checkouts row ─────────────────────


class CheckoutPayload(BaseModel):
    """Request body for `POST /api/werkstatt/mobile/checkout`.

    Issued by the field-tech Mobile persona. `quantity` must be positive;
    the service layer rejects checkouts that exceed ``stock_available``.
    """

    article_id: int = Field(..., gt=0)
    quantity: int = Field(..., gt=0)
    project_id: int | None = None
    assignee_user_id: int | None = None
    expected_return_at: datetime | None = None
    notes: str | None = None


class ReturnPayload(BaseModel):
    """Request body for `POST /api/werkstatt/mobile/return`.

    ``condition`` drives the movement_type written to the ledger:

      - ``ok``     → ``return``       (item goes back into ``stock_available``)
      - ``repair`` → ``repair_out``   (item leaves ``stock_out``, enters ``stock_repair``)
      - ``lost``   → ``correction``   (shrinks ``stock_total``, removes from ``stock_out``)
    """

    article_id: int = Field(..., gt=0)
    quantity: int = Field(..., gt=0)
    condition: Literal["ok", "repair", "lost"]
    notes: str | None = None


class MyCheckoutOut(BaseModel):
    """Row for the mobile "My checkouts" screen — one per distinct article
    with an outstanding (unreturned) checkout quantity for the caller."""

    article_id: int
    article_number: str
    article_name: str
    image_url: str | None
    unit: str | None
    quantity_out: int
    earliest_checkout_at: datetime
    latest_expected_return_at: datetime | None
    project_id: int | None
    project_number: str | None
    project_name: str | None


# ──────────────────────────────────────────────────────────────────────────
# §6  Orders — Tablet BE
# ──────────────────────────────────────────────────────────────────────────


class WerkstattOrderLineOut(_OrmBase):
    id: int
    order_id: int
    # Null on a "free" line — one we are buying but do not stock. See the
    # column comment on WerkstattOrderLine.article_id.
    article_id: int | None
    article_number: str | None
    # Always populated: the stocked article's name when there is one, else the
    # snapshot description the supplier sent. The UI never has to decide.
    article_name: str
    article_supplier_id: int | None
    supplier_article_no: str | None
    # Snapshot of what the supplier called it at order time.
    description: str | None = None
    manufacturer: str | None = None
    ean: str | None = None
    unit: str | None = None
    source_import_id: int | None = None
    # False when article_id is null — lets the UI mark lines that will not
    # move stock on delivery, and offer to link them to an article.
    is_stocked: bool = False
    quantity_ordered: int
    quantity_received: int
    unit_price_cents: int | None
    currency: str
    line_status: WerkstattOrderLineStatus
    received_at: datetime | None
    notes: str | None
    created_at: datetime
    updated_at: datetime


class WerkstattOrderOut(_OrmBase):
    id: int
    order_number: str
    supplier_id: int
    supplier_name: str
    status: WerkstattOrderStatus
    total_amount_cents: int | None
    currency: str
    ordered_at: datetime | None
    expected_delivery_at: datetime | None
    delivered_at: datetime | None
    delivery_reference: str | None
    notes: str | None
    created_by: int
    created_by_name: str | None
    line_count: int
    lines: list[WerkstattOrderLineOut] = Field(default_factory=list)
    # ── Procurement ─────────────────────────────────────────────────────
    title: str | None = None
    is_template: bool = False
    template_name: str | None = None
    task_id: int | None = None
    task_title: str | None = None
    project_id: int | None = None
    project_name: str | None = None
    source: str = "manual"
    external_reference: str | None = None
    merged_into_order_id: int | None = None
    merged_at: datetime | None = None
    submitted_at: datetime | None = None
    # True when the supplier has an enabled punchout connection, so the UI
    # knows whether to offer "im Shop bestellen" at all.
    supplier_has_shop: bool = False
    created_at: datetime
    updated_at: datetime


class WerkstattOrderSummaryOut(_OrmBase):
    id: int
    order_number: str
    # Carried alongside the name so the UI can enforce "one order, one
    # supplier" before it asks the server — a template picker that offers a
    # choice the merge/apply endpoint will reject is a worse picker.
    supplier_id: int
    supplier_name: str
    status: WerkstattOrderStatus
    total_amount_cents: int | None
    currency: str
    ordered_at: datetime | None
    expected_delivery_at: datetime | None
    delivered_at: datetime | None
    line_count: int
    days_overdue: int | None = None
    title: str | None = None
    is_template: bool = False
    template_name: str | None = None
    task_id: int | None = None
    task_title: str | None = None
    project_id: int | None = None
    source: str = "manual"
    merged_into_order_id: int | None = None


# Tablet BE: append SubmitOrderPayload / UpdateOrderStatusPayload here.


class WerkstattOrderLineCreatePayload(BaseModel):
    """One line of a draft-order creation payload."""

    article_id: int
    quantity_ordered: int = Field(ge=1)
    article_supplier_id: int | None = None
    unit_price_cents: int | None = Field(default=None, ge=0)
    currency: str | None = Field(default=None, min_length=1, max_length=8)
    notes: str | None = None


class WerkstattOrderCreatePayload(BaseModel):
    """Direct draft-order creation (not via the reorder-suggestion flow).

    `lines` here only covers stocked articles. Free (catalog-less) positions
    go through ``POST /werkstatt/orders/{id}/lines`` — see
    `routers/workflow_werkstatt_order_composition.py`.
    """

    supplier_id: int
    notes: str | None = None
    delivery_reference: str | None = Field(default=None, max_length=128)
    title: str | None = Field(default=None, max_length=255)
    task_id: int | None = None
    project_id: int | None = None
    lines: list[WerkstattOrderLineCreatePayload] = Field(default_factory=list)


class WerkstattOrderUpdatePayload(BaseModel):
    """Mutable fields on an existing order.

    `None` values are ignored (no change). Status transitions are NOT done
    via this payload — use the dedicated mark-sent / mark-delivered /
    cancel endpoints so the state machine is enforced centrally.
    """

    notes: str | None = None
    delivery_reference: str | None = Field(default=None, max_length=128)


# ──────────────────────────────────────────────────────────────────────────
# §7  Reorder — Tablet BE
# ──────────────────────────────────────────────────────────────────────────


class ReorderSuggestionLineOut(BaseModel):
    article_id: int
    article_number: str
    article_name: str
    image_url: str | None
    stock_available: int
    stock_min: int
    suggested_quantity: int
    unit: str | None
    unit_price_cents: int | None
    line_total_cents: int | None


class ReorderSuggestionGroupOut(BaseModel):
    supplier_id: int
    supplier_name: str
    supplier_short_name: str | None
    default_lead_time_days: int | None
    subtotal_cents: int | None
    currency: str
    lines: list[ReorderSuggestionLineOut]


class ReorderSubmitLinePayload(BaseModel):
    """One line of a reorder submission. Matches a suggested line, but the
    user may edit quantity / unit price before confirming."""

    article_id: int
    quantity: int = Field(ge=1)
    unit_price_cents: int | None = Field(default=None, ge=0)


class ReorderSubmitPayload(BaseModel):
    """POST /api/werkstatt/reorder/submit body.

    The endpoint creates a draft order, immediately transitions it to `sent`
    (stamping `ordered_at` + `expected_delivery_at`) and returns the full
    order representation.
    """

    supplier_id: int
    lines: list[ReorderSubmitLinePayload] = Field(min_length=1)
    notes: str | None = None


# ──────────────────────────────────────────────────────────────────────────
# §8  Inspections — Tablet BE
# ──────────────────────────────────────────────────────────────────────────


class WerkstattInspectionDueOut(BaseModel):
    article_id: int
    article_number: str
    article_name: str
    category_name: str | None
    location_name: str | None
    last_bg_inspected_at: datetime | None
    next_bg_due_at: datetime | None
    days_until_due: int | None
    urgency: WerkstattInspectionUrgency


class WerkstattInspectionRecordPayload(BaseModel):
    """POST /api/werkstatt/inspections/{article_id} body.

    `inspected_at` defaults to "now" on the server side if omitted. A
    record is always created regardless of `passed` — failed inspections
    still stamp the article so the next interval is tracked (technician
    schedules a follow-up after repair)."""

    passed: bool
    inspected_at: datetime | None = None
    notes: str | None = None


# ──────────────────────────────────────────────────────────────────────────
# §9  Scan — Mobile BE
# ──────────────────────────────────────────────────────────────────────────


class MaterialCatalogItemLiteOut(BaseModel):
    id: int
    external_key: str
    supplier_id: int | None
    supplier_name: str | None
    article_no: str | None
    item_name: str
    ean: str | None
    manufacturer: str | None
    unit: str | None
    price_text: str | None
    image_url: str | None


class ScanResolveMachine(BaseModel):
    """A label stuck on one physical machine (M-0001), or its nameplate serial.

    Distinct from `werkstatt_article` because the answer is different in kind:
    an article scan says "this is what that item is", a machine scan says
    "this is THAT drill, here is who has it, take it or bring it back".
    """

    kind: Literal["machine"] = "machine"
    machine: MachineOut
    matched_by: Literal["machine_number", "serial_number"]


class ScanResolveWerkstatt(BaseModel):
    kind: Literal["werkstatt_article"] = "werkstatt_article"
    article: WerkstattArticleOut
    matched_by: Literal["sp", "ean", "supplier_no"]


class ScanResolveCatalog(BaseModel):
    kind: Literal["catalog_match"] = "catalog_match"
    catalog_items: list[MaterialCatalogItemLiteOut]
    matched_by: Literal["catalog_ean", "catalog_article_no"]


class ScanResolveNotFound(BaseModel):
    kind: Literal["not_found"] = "not_found"
    code: str


# The FE imports this union via `ScanResolveResult` in types/werkstatt.ts.
ScanResolveResult = (
    ScanResolveMachine | ScanResolveWerkstatt | ScanResolveCatalog | ScanResolveNotFound
)


# Mobile BE: append CheckoutPayload / ReturnPayload here.


# Desktop BE: catalog search result grouping — rows with the same EAN across
# suppliers collapse into one hero + supplier sub-list.
class WerkstattCatalogGroupOut(BaseModel):
    ean: str | None
    hero: MaterialCatalogItemLiteOut
    suppliers: list[MaterialCatalogItemLiteOut]


# ──────────────────────────────────────────────────────────────────────────
# §10 Datanorm — Desktop BE
# ──────────────────────────────────────────────────────────────────────────


class DatanormSampleRowOut(BaseModel):
    article_no: str
    item_name: str
    ean: str | None
    manufacturer: str | None
    price_text: str | None


class DatanormEanConflictOut(BaseModel):
    ean: str
    item_name: str
    existing_supplier_id: int
    existing_supplier_name: str
    existing_article_no: str | None


class DatanormImportPreviewOut(BaseModel):
    import_token: str
    supplier_id: int
    supplier_name: str
    filename: str
    file_size_bytes: int
    detected_version: str | None
    detected_encoding: str | None
    total_rows: int
    rows_new: int
    rows_updated: int
    rows_unchanged: int
    ean_conflicts: list[DatanormEanConflictOut]
    sample_rows: list[DatanormSampleRowOut]
    uploaded_at: datetime
    expires_at: datetime


class DatanormImportRecordOut(_OrmBase):
    id: int
    supplier_id: int
    supplier_name: str
    filename: str
    status: DatanormImportStatus
    total_rows: int
    rows_new: int
    rows_updated: int
    rows_failed: int
    started_at: datetime
    finished_at: datetime | None
    error_message: str | None
    created_by: int | None
    created_by_name: str | None


# ──────────────────────────────────────────────────────────────────────────
# §11 Dashboard aggregate — Desktop BE
# ──────────────────────────────────────────────────────────────────────────


class WerkstattDashboardKpisOut(BaseModel):
    total_articles: int
    total_categories: int
    below_min_count: int
    on_site_count: int
    on_site_project_count: int
    unavailable_count: int
    in_repair_count: int


class WerkstattCheckoutGroupItemOut(BaseModel):
    article_id: int
    article_number: str
    article_name: str
    quantity: int
    assignee_display_name: str | None
    expected_return_at: datetime | None
    is_overdue: bool


class WerkstattCheckoutGroupPreviewOut(BaseModel):
    project_id: int
    project_number: str
    project_title: str
    item_count: int
    items: list[WerkstattCheckoutGroupItemOut]


class WerkstattDashboardOut(BaseModel):
    kpis: WerkstattDashboardKpisOut
    reorder_preview: list[ReorderSuggestionLineOut]
    recent_movements: list[WerkstattMovementOut]
    on_site_groups: list[WerkstattCheckoutGroupPreviewOut]
    maintenance_entries: list[WerkstattInspectionDueOut]


# ──────────────────────────────────────────────────────────────────────────
# Deduplication — folding multi-Datanorm duplicates into one article
# ──────────────────────────────────────────────────────────────────────────


class WerkstattSupplierLinkAddedOut(BaseModel):
    """A supplier link created by folding same-EAN catalog rows together."""

    supplier_id: int
    supplier_name: str | None
    supplier_article_no: str | None


class WerkstattCatalogFoldOut(BaseModel):
    article_id: int
    ean: str | None
    linked: list[WerkstattSupplierLinkAddedOut]
    already_linked: int


class WerkstattDuplicateCandidateOut(BaseModel):
    """A pair a human should confirm before merging."""

    article_id: int
    article_name: str
    article_number: str
    duplicate_id: int
    duplicate_name: str
    duplicate_number: str
    score: float
    reason: str


class WerkstattArticleMergePayload(BaseModel):
    survivor_id: int
    duplicate_id: int


class WerkstattArticleMergeOut(BaseModel):
    survivor_id: int
    merged_id: int
    supplier_links_moved: int
    supplier_links_skipped: int
    movements_moved: int
    order_lines_moved: int
    box_items_moved: int
    fields_filled: list[str]


class WerkstattSimilarArticleOut(BaseModel):
    """A comparable article, ordered by what we actually have on the shelf."""

    article_id: int
    article_number: str
    item_name: str
    ean: str | None
    unit: str | None
    stock_available: int
    stock_total: int
    similarity: float
    supplier_names: list[str]
