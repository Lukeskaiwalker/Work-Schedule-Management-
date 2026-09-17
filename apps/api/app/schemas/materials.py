from __future__ import annotations
from datetime import date, datetime, time
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field

class MaterialCatalogItemOut(BaseModel):
    id: int
    external_key: str | None = None
    article_no: str | None = None
    item_name: str
    unit: str | None = None
    manufacturer: str | None = None
    ean: str | None = None
    price_text: str | None = None
    image_url: str | None = None
    image_source: str | None = None
    image_checked_at: datetime | None = None
    source_file: str
    source_line: int


class MaterialCatalogImportStateOut(BaseModel):
    file_count: int = 0
    item_count: int = 0
    duplicates_skipped: int = 0
    imported_at: datetime | None = None
    image_lookup_enabled: bool = False
    image_lookup_phase: str | None = None
    image_last_run_processed: int = 0
    image_total_items: int = 0
    image_items_with_image: int = 0
    image_items_checked: int = 0
    image_items_pending: int = 0
    image_items_waiting_fallback: int = 0
    image_items_waiting_retry: int = 0
    image_items_not_found: int = 0
    image_last_checked_at: datetime | None = None


class ProjectMaterialNeedOut(BaseModel):
    id: int
    project_id: int
    project_number: str
    project_name: str
    customer_name: str | None = None
    construction_report_id: int | None = None
    report_date: date | None = None
    item: str
    material_catalog_item_id: int | None = None
    article_no: str | None = None
    unit: str | None = None
    quantity: str | None = None
    image_url: str | None = None
    image_source: str | None = None
    notes: str | None = None
    status: str
    # Who touched the row and when. Older clients read these (and the web type
    # declares them non-null), so they stay on the response even though the
    # Bedarfe screen does not render them.
    created_by: int | None = None
    updated_by: int | None = None
    created_at: datetime
    updated_at: datetime
    # ── Catalogue context ───────────────────────────────────────────────
    # Snapshotted from the linked MaterialCatalogItem on every read rather
    # than copied onto the row: a Datanorm re-import changes the supplier's
    # name and number, and a stale copy would order the wrong thing.
    supplier_id: int | None = None
    supplier_name: str | None = None
    catalog_item_name: str | None = None
    manufacturer: str | None = None
    ean: str | None = None
    # True when this row can become an order line: it has a catalogue match
    # AND that match names a supplier to address. Nothing to do with whether
    # that supplier has a webshop — a CSV/e-mail supplier is orderable too.
    orderable: bool = False
    # "report" when a Bautagesbericht created it, "manual" otherwise.
    source: str = "manual"
    # ── Order hand-off ──────────────────────────────────────────────────
    werkstatt_order_id: int | None = None
    werkstatt_order_number: str | None = None
    werkstatt_order_line_id: int | None = None
    ordered_at: datetime | None = None


class ProjectMaterialNeedUpdate(BaseModel):
    """Patch one need. Unset fields are left alone.

    Explicit-null semantics matter for ``material_catalog_item_id`` and
    ``notes``: sending ``null`` unlinks the catalogue row (the recovery path
    after a Datanorm re-import nulls it) or clears the note, while omitting
    the key keeps what is stored. The router reads ``model_fields_set`` to
    tell the two apart.
    """

    status: str | None = Field(default=None, min_length=1, max_length=32)
    notes: str | None = None
    item: str | None = Field(default=None, min_length=1, max_length=500)
    quantity: str | None = Field(default=None, max_length=64)
    unit: str | None = Field(default=None, max_length=64)
    article_no: str | None = Field(default=None, max_length=160)
    material_catalog_item_id: int | None = None


class ProjectMaterialNeedCreate(BaseModel):
    project_id: int
    item: str | None = Field(default=None, min_length=1, max_length=500)
    material_catalog_item_id: int | None = None
    article_no: str | None = Field(default=None, max_length=160)
    unit: str | None = Field(default=None, max_length=64)
    quantity: str | None = Field(default=None, max_length=64)
    # Why this is needed ("Rest vom Freitag reicht nicht"). Writable at
    # creation because the reason is known when the row is written — asking
    # for it in a second PATCH is how it ends up never being recorded.
    notes: str | None = None
    status: str = Field(default="order", min_length=1, max_length=32)


class ProjectTrackedMaterialOut(BaseModel):
    item: str
    unit: str | None = None
    article_no: str | None = None
    quantity_total: float | None = None
    quantity_notes: list[str] = Field(default_factory=list)
    occurrence_count: int = 0
    report_count: int = 0
    last_report_date: date | None = None
