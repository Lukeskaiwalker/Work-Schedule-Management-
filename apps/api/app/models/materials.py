from __future__ import annotations
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.core.time import utcnow


class MaterialCatalogItem(Base):
    __tablename__ = "material_catalog_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    external_key: Mapped[str] = mapped_column(String(128), nullable=False, unique=True, index=True)
    source_file: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    source_line: Mapped[int] = mapped_column(Integer, nullable=False)
    article_no: Mapped[str | None] = mapped_column(String(160), index=True)
    item_name: Mapped[str] = mapped_column(String(500), nullable=False, index=True)
    unit: Mapped[str | None] = mapped_column(String(64))
    manufacturer: Mapped[str | None] = mapped_column(String(255))
    ean: Mapped[str | None] = mapped_column(String(64), index=True)
    price_text: Mapped[str | None] = mapped_column(String(120))
    image_url: Mapped[str | None] = mapped_column(String(1000))
    image_source: Mapped[str | None] = mapped_column(String(64))
    image_checked_at: Mapped[datetime | None] = mapped_column(DateTime)
    search_text: Mapped[str] = mapped_column(Text, nullable=False)
    # Which Werkstatt-supplier's Datanorm this row came from. Nullable for
    # legacy rows that predate the per-supplier Datanorm model (backfilled
    # as NULL in migration 20260425_0047). Future Datanorm imports always
    # set this column.
    supplier_id: Mapped[int | None] = mapped_column(
        ForeignKey("werkstatt_suppliers.id", ondelete="SET NULL"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


class MaterialCatalogImportState(Base):
    __tablename__ = "material_catalog_import_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source_dir: Mapped[str] = mapped_column(String(500), nullable=False)
    source_signature: Mapped[str] = mapped_column(String(128), nullable=False)
    file_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    item_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    duplicates_skipped: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    imported_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class ProjectMaterialNeed(Base):
    __tablename__ = "project_material_needs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True, nullable=False)
    construction_report_id: Mapped[int | None] = mapped_column(
        ForeignKey("construction_reports.id", ondelete="SET NULL"), index=True
    )
    item: Mapped[str] = mapped_column(String(500), nullable=False)
    material_catalog_item_id: Mapped[int | None] = mapped_column(
        ForeignKey("material_catalog_items.id", ondelete="SET NULL"),
        index=True,
    )
    article_no: Mapped[str | None] = mapped_column(String(160))
    unit: Mapped[str | None] = mapped_column(String(64))
    quantity: Mapped[str | None] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(32), default="order", nullable=False, index=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)
