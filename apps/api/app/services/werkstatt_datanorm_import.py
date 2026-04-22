"""Supplier-scoped Datanorm import for Werkstatt.

Reuses `_iter_datanorm_rows` from `app.services.material_catalog` so we keep
one parser. The flow is:

1. FE uploads a Datanorm file + supplier_id → `create_preview(...)` parses
   bytes, computes preview stats, and stores the parsed rows in a short-lived
   in-process cache keyed by a random `import_token`. Preview tokens expire
   after `PREVIEW_TTL_SECONDS` (default: 15 min) to free memory.

2. FE calls `commit_preview(token)` → replaces all `material_catalog_items`
   rows for that supplier with the parsed rows inside one transaction, writes
   an audit row (`WerkstattDatanormImport`). On failure the audit row gets
   `status="failed"` + an error message.
"""

from __future__ import annotations

import hashlib
import secrets
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import (
    MaterialCatalogItem,
    WerkstattDatanormImport,
    WerkstattSupplier,
)
from app.services.material_catalog import (
    ParsedCatalogRow,
    _iter_datanorm_rows,
    _looks_like_datanorm_payload,
    _decode_payload,
    _search_text_for_row,
)

if TYPE_CHECKING:
    pass


PREVIEW_TTL_SECONDS = 15 * 60
SAMPLE_ROW_LIMIT = 8
EAN_CONFLICT_LIMIT = 20


@dataclass(slots=True)
class DatanormEanConflict:
    ean: str
    item_name: str
    existing_supplier_id: int
    existing_supplier_name: str
    existing_article_no: str | None


@dataclass(slots=True)
class DatanormPreview:
    token: str
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
    ean_conflicts: list[DatanormEanConflict]
    sample_rows: list[ParsedCatalogRow]
    uploaded_at: datetime
    expires_at: datetime
    # Internal: the full parsed row list, used at commit time.
    rows: list[ParsedCatalogRow] = field(default_factory=list)


_preview_cache: dict[str, DatanormPreview] = {}
_preview_lock = threading.Lock()


def _prune_expired_previews(now: datetime) -> None:
    expired = [token for token, preview in _preview_cache.items() if preview.expires_at <= now]
    for token in expired:
        _preview_cache.pop(token, None)


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
    digest.update((row.unit or "").strip().lower().encode("utf-8", errors="ignore"))
    digest.update(b"|")
    digest.update((row.manufacturer or "").strip().lower().encode("utf-8", errors="ignore"))
    digest.update(b"|")
    digest.update((row.ean or "").strip().lower().encode("utf-8", errors="ignore"))
    return digest.hexdigest()


def _detect_encoding(raw: bytes) -> str | None:
    for encoding in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            raw.decode(encoding)
            return encoding
        except UnicodeDecodeError:
            continue
    return None


def _detect_datanorm_version(text: str) -> str | None:
    # First V-record line carries the version stamp in Datanorm files.
    for line in text.splitlines()[:10]:
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("V"):
            return stripped[:64]
    return None


def create_preview(
    db: Session,
    *,
    supplier_id: int,
    filename: str,
    file_bytes: bytes,
) -> DatanormPreview:
    """Parse a Datanorm upload and build a preview. Does not write to the DB."""
    supplier = db.get(WerkstattSupplier, supplier_id)
    if supplier is None:
        raise ValueError("Supplier not found")
    if supplier.is_archived:
        raise ValueError("Supplier is archived")

    text = _decode_payload(file_bytes)
    if not text.strip():
        raise ValueError("Uploaded file is empty")
    if not _looks_like_datanorm_payload(text):
        raise ValueError("File does not look like a Datanorm payload")

    parsed_rows = list(_iter_datanorm_rows(text, filename))
    if not parsed_rows:
        raise ValueError("No rows could be parsed from the Datanorm file")

    # Classify against existing material_catalog_items for THIS supplier.
    existing_by_article: dict[str, MaterialCatalogItem] = {}
    existing_rows = db.scalars(
        select(MaterialCatalogItem).where(MaterialCatalogItem.supplier_id == supplier_id)
    ).all()
    for row in existing_rows:
        key = (row.article_no or "").strip().lower()
        if key:
            existing_by_article[key] = row

    rows_new = 0
    rows_updated = 0
    rows_unchanged = 0
    for parsed in parsed_rows:
        key = (parsed.article_no or "").strip().lower()
        existing = existing_by_article.get(key) if key else None
        if existing is None:
            rows_new += 1
            continue
        if _row_unchanged(existing, parsed):
            rows_unchanged += 1
        else:
            rows_updated += 1

    # EAN conflicts — same EAN owned by a different supplier.
    ean_conflicts = _detect_ean_conflicts(db, parsed_rows=parsed_rows, supplier_id=supplier_id)

    now = utcnow()
    token = secrets.token_urlsafe(32)
    preview = DatanormPreview(
        token=token,
        supplier_id=supplier_id,
        supplier_name=supplier.name,
        filename=filename,
        file_size_bytes=len(file_bytes),
        detected_version=_detect_datanorm_version(text),
        detected_encoding=_detect_encoding(file_bytes),
        total_rows=len(parsed_rows),
        rows_new=rows_new,
        rows_updated=rows_updated,
        rows_unchanged=rows_unchanged,
        ean_conflicts=ean_conflicts[:EAN_CONFLICT_LIMIT],
        sample_rows=parsed_rows[:SAMPLE_ROW_LIMIT],
        uploaded_at=now,
        expires_at=now + timedelta(seconds=PREVIEW_TTL_SECONDS),
        rows=parsed_rows,
    )

    with _preview_lock:
        _prune_expired_previews(now)
        _preview_cache[token] = preview

    return preview


def get_preview(token: str) -> DatanormPreview | None:
    now = utcnow()
    with _preview_lock:
        _prune_expired_previews(now)
        return _preview_cache.get(token)


def discard_preview(token: str) -> None:
    with _preview_lock:
        _preview_cache.pop(token, None)


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
    preview = get_preview(token)
    if preview is None:
        raise ValueError("Import token expired or unknown")

    supplier = db.get(WerkstattSupplier, preview.supplier_id)
    if supplier is None:
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
            db.execute(
                delete(MaterialCatalogItem).where(
                    MaterialCatalogItem.supplier_id == preview.supplier_id
                )
            )
        for row in preview.rows:
            existing_key = _external_key_for_supplier_row(preview.supplier_id, row)
            # Guard against same-file duplicates that survived the parser.
            existing_same_key = db.scalar(
                select(MaterialCatalogItem).where(MaterialCatalogItem.external_key == existing_key)
            )
            if existing_same_key is not None:
                continue
            item = MaterialCatalogItem(
                external_key=existing_key,
                source_file=row.source_file,
                source_line=row.source_line,
                article_no=row.article_no,
                item_name=row.item_name,
                unit=row.unit,
                manufacturer=row.manufacturer,
                ean=row.ean,
                price_text=row.price_text,
                supplier_id=preview.supplier_id,
                search_text=_search_text_for_row(row),
            )
            db.add(item)

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


def _row_unchanged(existing: MaterialCatalogItem, parsed: ParsedCatalogRow) -> bool:
    return (
        (existing.item_name or "") == (parsed.item_name or "")
        and (existing.unit or "") == (parsed.unit or "")
        and (existing.manufacturer or "") == (parsed.manufacturer or "")
        and (existing.ean or "") == (parsed.ean or "")
        and (existing.price_text or "") == (parsed.price_text or "")
    )


def _detect_ean_conflicts(
    db: Session,
    *,
    parsed_rows: list[ParsedCatalogRow],
    supplier_id: int,
) -> list[DatanormEanConflict]:
    ean_values = {row.ean.strip() for row in parsed_rows if row.ean and row.ean.strip()}
    if not ean_values:
        return []
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
            MaterialCatalogItem.ean.in_(ean_values),
            MaterialCatalogItem.supplier_id.is_not(None),
            MaterialCatalogItem.supplier_id != supplier_id,
        )
    ).all()
    conflicts: list[DatanormEanConflict] = []
    seen_eans: set[str] = set()
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
    return conflicts
