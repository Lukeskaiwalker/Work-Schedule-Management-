"""Supplier-scoped Datanorm import for Werkstatt.

Reuses `_iter_datanorm_rows` from `app.services.material_catalog` so we keep
one parser. The flow is:

1. The router streams the upload to a file and calls `create_preview(...)`,
   which parses it ONCE, streaming: every parsed row goes to the preview's
   JSONL file (services/werkstatt_datanorm_preview_store), and only the
   counters, the first sample rows and the EAN set stay in memory. The
   preview is on disk, so any worker can commit it.

2. `commit_preview(token)` claims the preview, replaces (or merges into) the
   supplier's `material_catalog_items` inside one transaction — rows
   streamed from the JSONL file and inserted in batches, the way the legacy
   file-system import loaded a million rows — and writes an audit row
   (`WerkstattDatanormImport`). On failure the audit row gets
   `status="failed"` + an error message.

A supplier's catalog is a few hundred thousand rows (Brisch: 291k, 68 MB);
nothing here may hold it as a list or touch the database once per row.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable
from datetime import datetime, timedelta
from pathlib import Path
from typing import Iterator

from sqlalchemy import delete, insert, select
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import (
    MaterialCatalogItem,
    WerkstattDatanormImport,
    WerkstattSupplier,
)
from app.services.material_catalog import (
    CATALOG_IMPORT_BATCH_SIZE,
    ParsedCatalogRow,
    _decode_payload,
    _iter_datanorm_rows,
    _looks_like_datanorm_payload,
    _search_text_for_row,
)
from app.services.werkstatt_datanorm_preview_store import (
    PREVIEW_TTL_SECONDS,
    DatanormEanConflict,
    DatanormPreview,
    PreviewRowWriter,
    claim_preview,
    discard_preview,
    iter_preview_rows,
    load_preview,
    save_preview_meta,
)

__all__ = [
    "DatanormEanConflict",
    "DatanormPreview",
    "PREVIEW_TTL_SECONDS",
    "commit_preview",
    "create_preview",
    "discard_preview",
    "get_preview",
]

SAMPLE_ROW_LIMIT = 8
EAN_CONFLICT_LIMIT = 20
# EANs per conflict query. A catalog has hundreds of thousands; one IN list
# that long is a multi-megabyte statement, so the check goes in slices.
EAN_QUERY_CHUNK = 5000
# Existing rows are read with a server-side cursor in slices of this many.
EXISTING_ROWS_YIELD = 5000


# ── Keys and fingerprints ────────────────────────────────────────────────────


def _external_key_for_supplier_row(supplier_id: int, row: ParsedCatalogRow) -> str:
    """Build a scoped external_key so each supplier's Datanorm has its own
    key space — two suppliers can ship the same EAN + article_no without
    clashing on the UNIQUE(external_key) constraint."""
    digest = hashlib.sha1()
    digest.update(f"supplier={supplier_id}|".encode("utf-8", errors="ignore"))
    digest.update((row.article_no or "").strip().lower().encode("utf-8", errors="ignore"))
    digest.update(b"|")
    digest.update(row.item_name.strip().lower().encode("utf-8", errors="ignore"))
    digest.update(b"|")
    digest.update((row.ean or "").strip().lower().encode("utf-8", errors="ignore"))
    return digest.hexdigest()


def _fingerprint(item_name: str | None, unit: str | None, manufacturer: str | None, ean: str | None, price_text: str | None) -> bytes:
    """What "unchanged" compares: the five fields a Datanorm update can
    change, blank and NULL alike. The same function fingerprints the
    existing row (from a slim query) and the parsed one, so the two can
    never disagree on normalisation."""
    digest = hashlib.sha1()
    for value in (item_name, unit, manufacturer, ean, price_text):
        digest.update((value or "").encode("utf-8", errors="ignore"))
        digest.update(b"\x1f")
    return digest.digest()


def _existing_fingerprints(db: Session, supplier_id: int) -> dict[str, bytes]:
    """article_no (lower) → fingerprint of the supplier's current rows.
    Columns, not ORM objects, streamed: a million-row supplier costs tens
    of megabytes here, not a gigabyte."""
    stmt = (
        select(
            MaterialCatalogItem.article_no,
            MaterialCatalogItem.item_name,
            MaterialCatalogItem.unit,
            MaterialCatalogItem.manufacturer,
            MaterialCatalogItem.ean,
            MaterialCatalogItem.price_text,
        )
        .where(MaterialCatalogItem.supplier_id == supplier_id)
        .execution_options(yield_per=EXISTING_ROWS_YIELD)
    )
    fingerprints: dict[str, bytes] = {}
    for article_no, item_name, unit, manufacturer, ean, price_text in db.execute(stmt):
        key = (article_no or "").strip().lower()
        if key:
            fingerprints[key] = _fingerprint(item_name, unit, manufacturer, ean, price_text)
    return fingerprints


def _existing_external_keys(db: Session, supplier_id: int) -> set[str]:
    stmt = (
        select(MaterialCatalogItem.external_key)
        .where(MaterialCatalogItem.supplier_id == supplier_id)
        .execution_options(yield_per=EXISTING_ROWS_YIELD)
    )
    return {str(key) for (key,) in db.execute(stmt)}


def _preserved_images(db: Session, supplier_id: int) -> dict[str, tuple[str | None, str | None, datetime | None]]:
    """The images already looked up for this supplier's rows, by external
    key — a replace re-import would otherwise throw away every lookup and
    start the slow image search from zero."""
    stmt = (
        select(
            MaterialCatalogItem.external_key,
            MaterialCatalogItem.image_url,
            MaterialCatalogItem.image_source,
            MaterialCatalogItem.image_checked_at,
        )
        .where(
            MaterialCatalogItem.supplier_id == supplier_id,
            (MaterialCatalogItem.image_url.is_not(None))
            | (MaterialCatalogItem.image_checked_at.is_not(None))
            | (MaterialCatalogItem.image_source.is_not(None)),
        )
        .execution_options(yield_per=EXISTING_ROWS_YIELD)
    )
    preserved: dict[str, tuple[str | None, str | None, datetime | None]] = {}
    for external_key, image_url, image_source, image_checked_at in db.execute(stmt):
        preserved[str(external_key)] = (
            str(image_url).strip() if image_url else None,
            str(image_source).strip() if image_source else None,
            image_checked_at,
        )
    return preserved


# ── Preview ──────────────────────────────────────────────────────────────────


def _detect_encoding(raw: bytes) -> str | None:
    for encoding in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            raw.decode(encoding)
            return encoding
        except UnicodeDecodeError:
            continue
    return None


def _detect_datanorm_version(text: str) -> str | None:
    for line in text.splitlines()[:5]:
        stripped = line.strip()
        if stripped.startswith("V"):
            # Datanorm v4 header ends with "...04EUR"; v5 with "...05EUR".
            tail = stripped[-5:]
            if tail.startswith("0"):
                return tail[:2]
    return None


def create_preview(
    db: Session,
    *,
    supplier_id: int,
    filename: str,
    source_path: Path,
    token: str,
) -> DatanormPreview:
    """Parse the uploaded file at ``source_path`` once and leave the preview
    on disk under ``token``. Does not write to the DB."""
    supplier = db.get(WerkstattSupplier, supplier_id)
    if supplier is None:
        raise ValueError("Supplier not found")
    if supplier.is_archived:
        raise ValueError("Supplier is archived")

    raw = source_path.read_bytes()
    file_size_bytes = len(raw)
    detected_encoding = _detect_encoding(raw)
    text = _decode_payload(raw)
    del raw  # the decoded text is all the parser needs; drop the bytes now
    if not text.strip():
        raise ValueError("Uploaded file is empty")
    if not _looks_like_datanorm_payload(text):
        raise ValueError("File does not look like a Datanorm payload")
    detected_version = _detect_datanorm_version(text)

    existing = _existing_fingerprints(db, supplier_id)
    rows_new = rows_updated = rows_unchanged = 0
    sample_rows: list[ParsedCatalogRow] = []
    ean_values: set[str] = set()

    writer = PreviewRowWriter(token)
    try:
        for parsed in _iter_datanorm_rows(text, filename):
            writer.write(parsed)
            if len(sample_rows) < SAMPLE_ROW_LIMIT:
                sample_rows.append(parsed)
            if parsed.ean and parsed.ean.strip():
                ean_values.add(parsed.ean.strip())
            key = (parsed.article_no or "").strip().lower()
            current = existing.get(key) if key else None
            if current is None:
                rows_new += 1
            elif current == _fingerprint(parsed.item_name, parsed.unit, parsed.manufacturer, parsed.ean, parsed.price_text):
                rows_unchanged += 1
            else:
                rows_updated += 1
    except Exception:
        writer.abandon()
        raise
    writer.close()
    del text, existing

    if writer.count == 0:
        discard_preview(token)
        raise ValueError("No rows could be parsed from the Datanorm file")

    now = utcnow()
    preview = DatanormPreview(
        token=token,
        supplier_id=supplier_id,
        supplier_name=supplier.name,
        filename=filename,
        file_size_bytes=file_size_bytes,
        detected_version=detected_version,
        detected_encoding=detected_encoding,
        total_rows=writer.count,
        rows_new=rows_new,
        rows_updated=rows_updated,
        rows_unchanged=rows_unchanged,
        ean_conflicts=_detect_ean_conflicts(db, ean_values=ean_values, supplier_id=supplier_id),
        sample_rows=sample_rows,
        uploaded_at=now,
        expires_at=now + timedelta(seconds=PREVIEW_TTL_SECONDS),
    )
    save_preview_meta(preview)
    return preview


def get_preview(token: str) -> DatanormPreview | None:
    return load_preview(token, now=utcnow())


def _chunks(values: Iterable[str], size: int) -> Iterator[list[str]]:
    batch: list[str] = []
    for value in values:
        batch.append(value)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch


def _detect_ean_conflicts(
    db: Session,
    *,
    ean_values: set[str],
    supplier_id: int,
) -> list[DatanormEanConflict]:
    """Same EAN owned by a different supplier — the first
    ``EAN_CONFLICT_LIMIT`` of them, queried in slices."""
    if not ean_values:
        return []
    conflicts: list[DatanormEanConflict] = []
    seen_eans: set[str] = set()
    for chunk in _chunks(sorted(ean_values), EAN_QUERY_CHUNK):
        clashes = db.execute(
            select(
                MaterialCatalogItem.ean,
                MaterialCatalogItem.item_name,
                MaterialCatalogItem.article_no,
                MaterialCatalogItem.supplier_id,
                WerkstattSupplier.name,
            )
            .join(WerkstattSupplier, WerkstattSupplier.id == MaterialCatalogItem.supplier_id)
            .where(
                MaterialCatalogItem.ean.in_(chunk),
                MaterialCatalogItem.supplier_id.is_not(None),
                MaterialCatalogItem.supplier_id != supplier_id,
            )
        ).all()
        for ean, item_name, article_no, other_supplier_id, other_supplier_name in clashes:
            if ean in seen_eans:
                continue
            seen_eans.add(ean)
            conflicts.append(
                DatanormEanConflict(
                    ean=ean,
                    item_name=item_name,
                    existing_supplier_id=other_supplier_id,
                    existing_supplier_name=other_supplier_name,
                    existing_article_no=article_no,
                )
            )
            if len(conflicts) >= EAN_CONFLICT_LIMIT:
                return conflicts
    return conflicts


# ── Commit ───────────────────────────────────────────────────────────────────


def _insert_rows_in_batches(
    db: Session,
    *,
    token: str,
    supplier_id: int,
    skip_keys: set[str],
    preserved_images: dict[str, tuple[str | None, str | None, datetime | None]],
) -> tuple[int, int]:
    """Stream the preview's rows into the table, ``CATALOG_IMPORT_BATCH_SIZE``
    per INSERT. ``skip_keys`` starts as the keys already in the table (merge
    mode) and grows with every row written, so a duplicate inside the file
    is skipped the way the old per-row SELECT skipped it — without the
    SELECT. Returns (inserted, skipped)."""
    pending: list[dict[str, object | None]] = []
    inserted = skipped = 0
    for row in iter_preview_rows(token):
        external_key = _external_key_for_supplier_row(supplier_id, row)
        if external_key in skip_keys:
            skipped += 1
            continue
        skip_keys.add(external_key)
        preserved = preserved_images.get(external_key)
        pending.append(
            {
                "external_key": external_key,
                "source_file": row.source_file,
                "source_line": row.source_line,
                "article_no": row.article_no,
                "item_name": row.item_name,
                "unit": row.unit,
                "manufacturer": row.manufacturer,
                "ean": row.ean,
                "price_text": row.price_text,
                "supplier_id": supplier_id,
                "image_url": preserved[0] if preserved else None,
                "image_source": preserved[1] if preserved else None,
                "image_checked_at": preserved[2] if preserved else None,
                "search_text": _search_text_for_row(row),
            }
        )
        inserted += 1
        if len(pending) >= CATALOG_IMPORT_BATCH_SIZE:
            db.execute(insert(MaterialCatalogItem), pending)
            pending = []
    if pending:
        db.execute(insert(MaterialCatalogItem), pending)
    return inserted, skipped


def commit_preview(
    db: Session,
    *,
    token: str,
    replace_mode: bool,
    actor_user_id: int | None,
) -> WerkstattDatanormImport:
    """Apply a previously-generated preview to the catalog for its supplier.

    If `replace_mode` is True (the default in this round), first DELETE all
    `material_catalog_items` rows with the same `supplier_id`, then INSERT the
    parsed rows. Writes an audit row whether the commit succeeds or fails.
    """
    preview = claim_preview(token, now=utcnow())
    if preview is None:
        raise ValueError("Import token expired or unknown")

    supplier = db.get(WerkstattSupplier, preview.supplier_id)
    if supplier is None:
        discard_preview(token)
        raise ValueError("Supplier no longer exists")

    audit = WerkstattDatanormImport(
        supplier_id=preview.supplier_id,
        filename=preview.filename,
        status="importing",
        total_rows=preview.total_rows,
        rows_new=preview.rows_new,
        rows_updated=preview.rows_updated,
        rows_failed=0,
        started_at=utcnow(),
        created_by=actor_user_id,
    )
    db.add(audit)
    db.flush()  # get an id for the audit row

    try:
        if replace_mode:
            preserved_images = _preserved_images(db, preview.supplier_id)
            db.execute(delete(MaterialCatalogItem).where(MaterialCatalogItem.supplier_id == preview.supplier_id))
            skip_keys: set[str] = set()
        else:
            preserved_images = {}
            skip_keys = _existing_external_keys(db, preview.supplier_id)
        _insert_rows_in_batches(
            db,
            token=token,
            supplier_id=preview.supplier_id,
            skip_keys=skip_keys,
            preserved_images=preserved_images,
        )
        audit.status = "committed"
        audit.finished_at = utcnow()
        db.add(audit)
        db.commit()
    except Exception as exc:  # pragma: no cover - defensive path
        db.rollback()
        # Re-record the audit row as failed in a fresh transaction so we
        # preserve the trail even though the data changes rolled back.
        audit_fail = WerkstattDatanormImport(
            supplier_id=preview.supplier_id,
            filename=preview.filename,
            status="failed",
            total_rows=preview.total_rows,
            rows_new=preview.rows_new,
            rows_updated=preview.rows_updated,
            rows_failed=preview.total_rows,
            started_at=audit.started_at or utcnow(),
            finished_at=utcnow(),
            error_message=str(exc)[:2000],
            created_by=actor_user_id,
        )
        db.add(audit_fail)
        db.commit()
        db.refresh(audit_fail)
        discard_preview(token)
        return audit_fail

    discard_preview(token)
    db.refresh(audit)
    return audit
