from __future__ import annotations
from datetime import date, datetime, time
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field

class MaterialCatalogItemOut(BaseModel):
    id: int
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
    status: str
    created_by: int | None = None
    updated_by: int | None = None
    created_at: datetime
    updated_at: datetime


class ProjectMaterialNeedUpdate(BaseModel):
    status: str = Field(min_length=1, max_length=32)


class ProjectMaterialNeedCreate(BaseModel):
    project_id: int
    item: str | None = Field(default=None, min_length=1, max_length=500)
    material_catalog_item_id: int | None = None
    article_no: str | None = Field(default=None, max_length=160)
    unit: str | None = Field(default=None, max_length=64)
    quantity: str | None = Field(default=None, max_length=64)
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
