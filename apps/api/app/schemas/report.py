from __future__ import annotations
from datetime import date, datetime, time
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field

class ConstructionReportWorker(BaseModel):
    name: str
    start_time: str | None = None
    end_time: str | None = None


class ConstructionReportMaterial(BaseModel):
    """One row in the 'Verbrauchtes Material' table.

    Visible columns on the main PDF: ``item`` / ``qty`` / ``unit`` (three
    columns to match the mockup's section 5 layout).

    The remaining fields are rendered only on the standalone Materialschein
    that gets generated when the consumed list overflows the inline
    threshold (see ``MATERIAL_OVERFLOW_THRESHOLD``):

      - ``article_no`` → "Beschreibung / Größe" column. Carries the SKU /
        article-number / size designation. Pre-v2.5.13 schema field kept
        for backward compatibility.
      - ``usage`` → "Verwendet für / Einsatzort" column (v2.5.14). What
        the material was used for or where it was installed. Optional.
      - ``note`` → "Bemerkung" column (v2.5.14). Additional remarks
        distinct from the usage / location. Optional.
    """

    item: str
    qty: str | None = None
    unit: str | None = None
    article_no: str | None = None
    usage: str | None = None
    note: str | None = None


class ConstructionReportMaterialNeeded(BaseModel):
    """One row in the 'Materialbedarf' table. Four visible columns
    (Material / Menge / Einheit / Bemerkung). v2.5.13: replaces the
    free-text ``office_material_need`` field with structured rows so the
    operations team can act on them directly (e.g. each row becomes a
    candidate purchase-order line item)."""

    item: str
    qty: str | None = None
    unit: str | None = None
    note: str | None = None


class ConstructionReportExtra(BaseModel):
    """Legacy 'Zusatzarbeiten' rows. v2.5.13 PDF folds these into the new
    'Offene Arbeiten / Weitere Maßnahmen' bullet list alongside the parsed
    text from ``office_rework`` + ``office_next_steps``. Kept here so old
    reports continue to round-trip through the schema unchanged."""

    description: str
    reason: str | None = None


class ConstructionReportStatus(BaseModel):
    """The five checkboxes from section 8 of the redesigned Baustellenbericht.

    v2.5.13: all five booleans default to False so legacy reports (no status
    block in payload) render with empty checkboxes — same as if the operator
    submitted without checking anything. ``note`` is the optional free-text
    'Bemerkung' field next to the checkboxes.
    """

    arrival_completed: bool = False
    """An- und Abfahrt erfolgt."""
    work_finished: bool = False
    """Arbeiten abgeschlossen."""
    handed_over_clean: bool = False
    """Anlage störungsfrei dem Kunden übergeben."""
    further_work_needed: bool = False
    """Weitere Arbeiten notwendig."""
    extra_material_used: bool = False
    """Mehrverbrauch an Material lt. beiliegendem Materialschein."""
    note: str | None = None


class ConstructionReportDistance(BaseModel):
    """Section 8's 'Kilometer (gesamt)' field. v2.5.13: pre-filled from
    company-address ↔ site-address driving distance (round-trip estimate
    via the OpenWeather geocode + haversine helper) when ``source='auto'``;
    operator-supplied number when ``source='manual'``. The PDF renders the
    same way either way; the source flag is purely for the audit trail."""

    kilometers: int | None = None
    source: Literal["auto", "manual", "unset"] = "unset"


class ConstructionReportSignature(BaseModel):
    """A handwritten signature captured client-side via react-signature-canvas.

    Stored inline in the report payload as a base64-encoded PNG (typically
    10-30 KB per signature). v2.5.13 design choice: keep signatures in the
    same JSON blob as the rest of the form data so encryption + backup +
    versioning are one story, not two. The PDF renderer base64-decodes and
    embeds via ReportLab's Image at render time.

    ``name`` is the printed name shown below the signature line; ``signed_at``
    is an ISO timestamp captured at the moment the pad's stroke ends.
    """

    name: str | None = None
    signed_at: datetime | None = None
    image_base64: str | None = None
    """Data URL or raw base64 of a PNG. Renderer accepts both shapes."""


class ConstructionReportPayload(BaseModel):
    customer: str | None = None
    customer_address: str | None = None
    customer_contact: str | None = None
    customer_email: str | None = None
    customer_phone: str | None = None
    project_name: str | None = None
    project_number: str | None = None
    workers: list[ConstructionReportWorker] = Field(default_factory=list)
    # v2.5.13: materials split into two structurally-distinct lists.
    # ``materials`` (legacy) is still accepted on incoming payloads and
    # treated as a synonym for ``materials_consumed`` at render time, so
    # old form submissions and old DB rows still produce the new PDF.
    materials: list[ConstructionReportMaterial] = Field(default_factory=list)
    materials_consumed: list[ConstructionReportMaterial] = Field(default_factory=list)
    materials_needed: list[ConstructionReportMaterialNeeded] = Field(default_factory=list)
    extras: list[ConstructionReportExtra] = Field(default_factory=list)
    work_done: str | None = None
    incidents: str | None = None
    office_material_need: str | None = None
    office_rework: str | None = None
    office_next_steps: str | None = None
    source_task_id: int | None = None
    completed_subtasks: list[str] = Field(default_factory=list)

    # v2.5.13: structured status, distance and signatures. All optional so
    # legacy reports continue to validate; the PDF renders empty
    # placeholders when these are unset.
    status: ConstructionReportStatus = Field(default_factory=ConstructionReportStatus)
    distance: ConstructionReportDistance = Field(default_factory=ConstructionReportDistance)
    signature_smpl: ConstructionReportSignature = Field(
        default_factory=ConstructionReportSignature
    )
    signature_customer: ConstructionReportSignature = Field(
        default_factory=ConstructionReportSignature
    )


class ConstructionReportCreate(BaseModel):
    project_id: int | None = None
    report_date: date
    payload: ConstructionReportPayload
    send_telegram: bool = False


class RecentConstructionReportOut(BaseModel):
    id: int
    project_id: int | None = None
    report_number: int | None = None
    user_id: int | None = None
    user_display_name: str | None = None
    project_number: str | None = None
    project_name: str | None = None
    report_date: date
    created_at: datetime
    processing_status: str
    attachment_file_name: str | None = None
    attachment_id: int | None = None
