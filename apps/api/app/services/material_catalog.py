from __future__ import annotations

from collections import deque
from collections.abc import Iterator
import csv
import hashlib
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from dataclasses import dataclass
from io import StringIO
from pathlib import Path

from sqlalchemy import and_, case, delete, func, insert, or_, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.time import utcnow
from app.models.entities import MaterialCatalogImportState, MaterialCatalogItem
from app.services.material_catalog_images import (
    cache_material_catalog_image,
    has_cached_material_catalog_image,
    is_unielektro_article_no,
    resolve_material_catalog_image_fallback,
    resolve_material_catalog_image_unielektro,
    resolve_material_catalog_image_unielektro_by_article_no,
)

HEADER_ARTICLE_HINTS = {
    "art",
    "article",
    "article_no",
    "article_number",
    "artikelnr",
    "artikelnummer",
    "artikel_nr",
    "artnr",
    "nr",
}
HEADER_ITEM_HINTS = {
    "item",
    "name",
    "bezeichnung",
    "beschreibung",
    "description",
    "langtext",
    "kurztext",
    "artikel",
    "produkt",
}
HEADER_UNIT_HINTS = {"unit", "einheit", "me", "mengeneinheit", "uom"}
HEADER_MANUFACTURER_HINTS = {"manufacturer", "hersteller", "brand", "marke", "fabrikat"}
HEADER_EAN_HINTS = {"ean", "gtin"}
HEADER_PRICE_HINTS = {"preis", "price", "vk", "netto", "brutto", "betrag"}
KNOWN_HEADER_WORDS = (
    HEADER_ARTICLE_HINTS
    | HEADER_ITEM_HINTS
    | HEADER_UNIT_HINTS
    | HEADER_MANUFACTURER_HINTS
    | HEADER_EAN_HINTS
    | HEADER_PRICE_HINTS
)

UNIT_HINTS = {
    "stk",
    "st",
    "stück",
    "m",
    "m2",
    "m3",
    "mm",
    "cm",
    "dm",
    "kg",
    "g",
    "l",
    "ml",
    "pa",
    "bar",
    "kw",
    "kwh",
    "w",
    "a",
    "v",
    "set",
    "pak",
    "pkt",
    "rolle",
    "karton",
    "box",
    "paar",
}
IGNORE_LINE_PREFIXES = {"#", "//", ";", "--"}
ARTICLE_TOKEN_RE = re.compile(r"^[A-Z0-9][A-Z0-9._/\-]{2,}$")
PRICE_TOKEN_RE = re.compile(r"^\d{1,9}(?:[.,]\d{1,4})?$")
EAN_TOKEN_RE = re.compile(r"^\d{8,14}$")
ALPHA_RE = re.compile(r"[A-Za-zÄÖÜäöüß]")
DATANORM_CURRENCY_RE = re.compile(r"(\d{2})([A-Z]{3})\s*$")
DATANORM_COMPARE_RE = re.compile(r"[^a-z0-9]+")
CATALOG_PARSER_SIGNATURE = "material-catalog-parser-v3-datanorm-images"
CATALOG_IMPORT_BATCH_SIZE = 1000
IMAGE_SOURCE_NOT_FOUND_UNIELEKTRO = "not_found_unielektro"
IMAGE_SOURCE_NOT_FOUND = "not_found"
IMAGE_LOOKUP_PHASE_FIRST_PASS = "unielektro_first_pass"
IMAGE_LOOKUP_PHASE_FALLBACK = "fallback"
IMAGE_LOOKUP_PHASE_IDLE = "idle"

# How long to cache the catalog-up-to-date check (avoids file-system stat() on
# every search request). Catalog imports happen manually via admin, so 60 s is
# plenty generous.
_CATALOG_UP_TO_DATE_CACHE_SECONDS = 60

# In-memory ring buffer of catalog item IDs that were recently returned by
# search_material_catalog().  The background image loop drains these first so
# that items the user is actively browsing get their images resolved as fast
# as possible.  maxlen=500 is intentionally small — we only care about the
# most recent searches.
_recently_searched_ids: deque[int] = deque(maxlen=500)
_recently_searched_lock = threading.Lock()

# Cache for catalog up-to-date check: (last_checked_ts, last_signature)
_catalog_check_cache: tuple[float, str] | None = None
_catalog_check_lock = threading.Lock()


def record_searched_item_ids(item_ids: list[int]) -> None:
    """Record IDs of catalog items returned by a search so the image loop can
    prioritise them.  Thread-safe, O(n) where n = len(item_ids)."""
    if not item_ids:
        return
    with _recently_searched_lock:
        _recently_searched_ids.extend(item_ids)


def _pop_recently_searched_ids() -> list[int]:
    """Drain the recently-searched deque and return a deduplicated list.
    Called exclusively by the background image loop."""
    with _recently_searched_lock:
        # dict.fromkeys preserves insertion order and deduplicates
        ids = list(dict.fromkeys(_recently_searched_ids))
        _recently_searched_ids.clear()
        return ids


@dataclass(slots=True)
class ParsedCatalogRow:
    source_file: str
    source_line: int
    article_no: str | None
    item_name: str
    unit: str | None
    manufacturer: str | None
    ean: str | None
    price_text: str | None


@dataclass(slots=True)
class DatanormArticleBuffer:
    source_line: int
    article_no: str
    short_text: str = ""
    long_text: str = ""
    unit: str | None = None
    price_raw: str | None = None
    match_code: str | None = None
    ean: str | None = None


@dataclass(slots=True)
class MaterialCatalogImageStatus:
    lookup_enabled: bool
    lookup_phase: str
    total_items: int
    items_with_image: int
    items_checked: int
    items_pending: int
    items_waiting_fallback: int
    items_waiting_retry: int
    items_not_found: int
    last_checked_at: datetime | None


def ensure_material_catalog_up_to_date(db: Session) -> None:
    global _catalog_check_cache
    source_dir = _resolve_material_catalog_dir()
    if source_dir is None:
        return

    files = _list_catalog_files(source_dir)
    signature = _catalog_signature(source_dir, files)

    # Fast path: if the signature hasn't changed since our last check within
    # the cache window, skip the DB round-trip entirely.
    import time as _time
    now_ts = _time.monotonic()
    with _catalog_check_lock:
        cached = _catalog_check_cache
        if cached is not None:
            last_ts, last_sig = cached
            if (now_ts - last_ts) < _CATALOG_UP_TO_DATE_CACHE_SECONDS and last_sig == signature:
                return
        # Update cache regardless — even if we re-import we still record the
        # new signature so the next call within the window is fast.
        _catalog_check_cache = (now_ts, signature)

    state = db.get(MaterialCatalogImportState, 1)
    if state and state.source_signature == signature:
        return

    preserved_images = _collect_preserved_images(db)
    db.execute(delete(MaterialCatalogItem))
    item_count, duplicates_skipped = _import_catalog_rows_in_batches(
        db,
        source_dir=source_dir,
        files=files,
        preserved_images=preserved_images,
    )
    if state is None:
        state = MaterialCatalogImportState(id=1, source_dir=str(source_dir), source_signature=signature)
    state.source_dir = str(source_dir)
    state.source_signature = signature
    state.file_count = len(files)
    state.item_count = item_count
    state.duplicates_skipped = duplicates_skipped
    state.imported_at = utcnow()
    db.add(state)
    db.commit()


def search_material_catalog(
    db: Session,
    *,
    query: str,
    limit: int,
) -> list[MaterialCatalogItem]:
    ensure_material_catalog_up_to_date(db)
    q = query.strip().lower()
    capped_limit = max(1, min(limit, 120))
    query_stmt = select(MaterialCatalogItem)
    if q:
        terms = [term for term in re.split(r"\s+", q) if term]
        for term in terms:
            escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            query_stmt = query_stmt.where(func.lower(MaterialCatalogItem.search_text).like(f"%{escaped}%", escape="\\"))
        rank = case(
            (func.lower(MaterialCatalogItem.article_no) == q, 0),
            (func.lower(MaterialCatalogItem.article_no).like(f"{q}%", escape="\\"), 1),
            (func.lower(MaterialCatalogItem.item_name).like(f"{q}%", escape="\\"), 2),
            else_=3,
        )
        query_stmt = query_stmt.order_by(rank.asc(), MaterialCatalogItem.item_name.asc(), MaterialCatalogItem.id.asc())
    else:
        query_stmt = query_stmt.order_by(MaterialCatalogItem.item_name.asc(), MaterialCatalogItem.id.asc())
    rows = list(db.scalars(query_stmt.limit(capped_limit)).all())
    # Tell the background image loop which items the user is actively browsing
    # so it can prioritise their image resolution.
    record_searched_item_ids([r.id for r in rows])
    return rows


def get_material_catalog_import_state(db: Session) -> MaterialCatalogImportState | None:
    ensure_material_catalog_up_to_date(db)
    return db.get(MaterialCatalogImportState, 1)


def ensure_material_catalog_images(db: Session, rows: list[MaterialCatalogItem]) -> None:
    if not rows or not _image_lookup_enabled():
        return
    max_items = _image_lookup_max_items_per_request()
    if max_items <= 0:
        return
    now = utcnow()
    lookup_phase = _image_lookup_phase(db)
    changed = False
    checked = 0
    for row in rows:
        if checked >= max_items:
            break
        if not _should_lookup_image(row, now=now, lookup_phase=lookup_phase):
            continue
        checked += 1
        if _refresh_catalog_item_image(row, checked_at=now, lookup_phase=lookup_phase):
            db.add(row)
            changed = True
    if changed:
        db.commit()


def ensure_material_catalog_item_image(db: Session, row: MaterialCatalogItem) -> None:
    if not _image_lookup_enabled():
        return
    now = utcnow()
    lookup_phase = _image_lookup_phase(db)
    if not _should_lookup_image(row, now=now, lookup_phase=lookup_phase):
        return
    if not _refresh_catalog_item_image(row, checked_at=now, lookup_phase=lookup_phase):
        return
    db.add(row)
    db.commit()
    db.refresh(row)


def sync_pending_material_catalog_images(db: Session, *, limit: int | None = None) -> int:
    if not _image_lookup_enabled():
        return 0
    configured_limit = _image_lookup_max_items_per_request()
    effective_limit = configured_limit if limit is None else int(limit)
    effective_limit = max(0, min(effective_limit, 50))
    if effective_limit <= 0:
        return 0

    now = utcnow()
    lookup_phase = _image_lookup_phase(db)
    retry_after = _image_lookup_retry_after()
    retry_cutoff = now - retry_after
    image_missing = or_(MaterialCatalogItem.image_url.is_(None), MaterialCatalogItem.image_url == "")
    image_hotlink = and_(MaterialCatalogItem.image_url.is_not(None), MaterialCatalogItem.image_url.like("http%"))
    has_ean = and_(MaterialCatalogItem.ean.is_not(None), MaterialCatalogItem.ean != "")
    has_unielektro_article_no = and_(
        MaterialCatalogItem.article_no.is_not(None),
        MaterialCatalogItem.article_no != "",
        func.length(MaterialCatalogItem.article_no) == 8,
    )
    has_searchable_id = or_(has_ean, has_unielektro_article_no)
    source_empty = or_(MaterialCatalogItem.image_source.is_(None), MaterialCatalogItem.image_source == "")
    hotlink_due = and_(
        has_searchable_id,
        image_hotlink,
        or_(MaterialCatalogItem.image_checked_at.is_(None), MaterialCatalogItem.image_checked_at <= retry_cutoff),
    )
    fallback_due = or_(
        MaterialCatalogItem.image_source == IMAGE_SOURCE_NOT_FOUND_UNIELEKTRO,
        and_(
            MaterialCatalogItem.image_source == IMAGE_SOURCE_NOT_FOUND,
            or_(MaterialCatalogItem.image_checked_at.is_(None), MaterialCatalogItem.image_checked_at <= retry_cutoff),
        ),
    )
    if lookup_phase == IMAGE_LOOKUP_PHASE_FIRST_PASS:
        pending = or_(and_(has_searchable_id, image_missing, source_empty), hotlink_due)
        row_order = [
            case((hotlink_due, 0), else_=1).asc(),
            case((MaterialCatalogItem.image_checked_at.is_(None), 0), else_=1).asc(),
            MaterialCatalogItem.image_checked_at.asc(),
            MaterialCatalogItem.id.asc(),
        ]
    else:
        pending = or_(and_(has_searchable_id, image_missing, fallback_due), hotlink_due)
        row_order = [
            case((hotlink_due, 0), else_=1).asc(),
            case((MaterialCatalogItem.image_source == IMAGE_SOURCE_NOT_FOUND_UNIELEKTRO, 0), else_=1).asc(),
            case((MaterialCatalogItem.image_checked_at.is_(None), 0), else_=1).asc(),
            MaterialCatalogItem.image_checked_at.asc(),
            MaterialCatalogItem.id.asc(),
        ]

    # ── Priority pass: process items the user recently searched for first ──
    # Drain the deque before the normal DB-ordered scan so that items
    # currently visible in the UI get their images resolved immediately.
    recently_searched = _pop_recently_searched_ids()
    priority_candidates: list[MaterialCatalogItem] = []
    if recently_searched:
        priority_rows = list(
            db.scalars(
                select(MaterialCatalogItem)
                .where(MaterialCatalogItem.id.in_(recently_searched), pending)
            ).all()
        )
        priority_candidates = [r for r in priority_rows if _should_lookup_image(r, now=now, lookup_phase=lookup_phase)]

    # Fill remaining slots from the normal ordered query, excluding IDs already
    # handled in the priority pass.
    remaining_slots = effective_limit - len(priority_candidates)
    normal_candidates: list[MaterialCatalogItem] = []
    if remaining_slots > 0:
        exclude_ids = {r.id for r in priority_candidates}
        normal_stmt = select(MaterialCatalogItem).where(pending)
        if exclude_ids:
            normal_stmt = normal_stmt.where(MaterialCatalogItem.id.notin_(exclude_ids))
        normal_stmt = normal_stmt.order_by(*row_order).limit(remaining_slots)
        normal_rows = list(db.scalars(normal_stmt).all())
        normal_candidates = [r for r in normal_rows if _should_lookup_image(r, now=now, lookup_phase=lookup_phase)]

    # Secondary filter already applied above via _should_lookup_image.
    eligible = priority_candidates + normal_candidates
    if not eligible:
        return 0

    changed_rows: list[MaterialCatalogItem] = []
    lock = threading.Lock()

    def _process(row: MaterialCatalogItem) -> None:
        did_change = _refresh_catalog_item_image(row, checked_at=now, lookup_phase=lookup_phase)
        if did_change:
            with lock:
                changed_rows.append(row)

    # Process up to 4 items concurrently. Each call is I/O-bound (HTTP fetches),
    # so threads don't compete for the GIL and genuine parallelism is achieved.
    n_workers = min(4, len(eligible))
    with ThreadPoolExecutor(max_workers=n_workers) as pool:
        list(pool.map(_process, eligible))

    if changed_rows:
        for row in changed_rows:
            db.add(row)
        db.commit()

    return len(eligible)


def get_material_catalog_image_status(db: Session) -> MaterialCatalogImageStatus:
    ensure_material_catalog_up_to_date(db)
    lookup_phase = _image_lookup_phase(db)
    total_items = int(db.scalar(select(func.count(MaterialCatalogItem.id))) or 0)
    if total_items <= 0:
        return MaterialCatalogImageStatus(
            lookup_enabled=_image_lookup_enabled(),
            lookup_phase=IMAGE_LOOKUP_PHASE_IDLE,
            total_items=0,
            items_with_image=0,
            items_checked=0,
            items_pending=0,
            items_waiting_fallback=0,
            items_waiting_retry=0,
            items_not_found=0,
            last_checked_at=None,
        )

    image_present = and_(MaterialCatalogItem.image_url.is_not(None), MaterialCatalogItem.image_url != "")
    image_hotlink = and_(MaterialCatalogItem.image_url.is_not(None), MaterialCatalogItem.image_url.like("http%"))
    image_missing = or_(MaterialCatalogItem.image_url.is_(None), MaterialCatalogItem.image_url == "")
    has_ean = and_(MaterialCatalogItem.ean.is_not(None), MaterialCatalogItem.ean != "")
    has_unielektro_article_no = and_(
        MaterialCatalogItem.article_no.is_not(None),
        MaterialCatalogItem.article_no != "",
        func.length(MaterialCatalogItem.article_no) == 8,
    )
    has_searchable_id = or_(has_ean, has_unielektro_article_no)
    source_empty = or_(MaterialCatalogItem.image_source.is_(None), MaterialCatalogItem.image_source == "")
    retry_cutoff = utcnow() - _image_lookup_retry_after()
    hotlink_due = and_(
        has_searchable_id,
        image_hotlink,
        or_(MaterialCatalogItem.image_checked_at.is_(None), MaterialCatalogItem.image_checked_at <= retry_cutoff),
    )
    fallback_due = or_(
        MaterialCatalogItem.image_source == IMAGE_SOURCE_NOT_FOUND_UNIELEKTRO,
        and_(
            MaterialCatalogItem.image_source == IMAGE_SOURCE_NOT_FOUND,
            or_(MaterialCatalogItem.image_checked_at.is_(None), MaterialCatalogItem.image_checked_at <= retry_cutoff),
        ),
    )

    items_with_image = int(db.scalar(select(func.count(MaterialCatalogItem.id)).where(image_present)) or 0)
    items_checked = int(
        db.scalar(select(func.count(MaterialCatalogItem.id)).where(MaterialCatalogItem.image_checked_at.is_not(None))) or 0
    )
    items_not_found = int(
        db.scalar(select(func.count(MaterialCatalogItem.id)).where(MaterialCatalogItem.image_source == IMAGE_SOURCE_NOT_FOUND))
        or 0
    )
    items_waiting_fallback = int(
        db.scalar(
            select(func.count(MaterialCatalogItem.id)).where(
                has_searchable_id,
                image_missing,
                MaterialCatalogItem.image_source == IMAGE_SOURCE_NOT_FOUND_UNIELEKTRO,
            )
        )
        or 0
    )
    if lookup_phase == IMAGE_LOOKUP_PHASE_FIRST_PASS:
        first_pass_pending = int(
            db.scalar(select(func.count(MaterialCatalogItem.id)).where(has_searchable_id, image_missing, source_empty)) or 0
        )
        hotlink_pending = int(db.scalar(select(func.count(MaterialCatalogItem.id)).where(hotlink_due)) or 0)
        items_pending = first_pass_pending + hotlink_pending
    else:
        fallback_pending = int(db.scalar(select(func.count(MaterialCatalogItem.id)).where(has_searchable_id, image_missing, fallback_due)) or 0)
        hotlink_pending = int(db.scalar(select(func.count(MaterialCatalogItem.id)).where(hotlink_due)) or 0)
        items_pending = fallback_pending + hotlink_pending
    items_waiting_retry = int(
        db.scalar(
            select(func.count(MaterialCatalogItem.id)).where(
                has_searchable_id,
                image_missing,
                MaterialCatalogItem.image_source == IMAGE_SOURCE_NOT_FOUND,
                MaterialCatalogItem.image_checked_at.is_not(None),
                MaterialCatalogItem.image_checked_at > retry_cutoff,
            )
        )
        or 0
    )
    last_checked_at = db.scalar(select(func.max(MaterialCatalogItem.image_checked_at)))
    return MaterialCatalogImageStatus(
        lookup_enabled=_image_lookup_enabled(),
        lookup_phase=lookup_phase,
        total_items=total_items,
        items_with_image=items_with_image,
        items_checked=items_checked,
        items_pending=items_pending,
        items_waiting_fallback=items_waiting_fallback,
        items_waiting_retry=items_waiting_retry,
        items_not_found=items_not_found,
        last_checked_at=last_checked_at,
    )


def _collect_preserved_images(
    db: Session,
) -> dict[str, tuple[str | None, str | None, datetime | None]]:
    rows = db.execute(
        select(
            MaterialCatalogItem.external_key,
            MaterialCatalogItem.image_url,
            MaterialCatalogItem.image_source,
            MaterialCatalogItem.image_checked_at,
        ).where(
            (MaterialCatalogItem.image_url.is_not(None))
            | (MaterialCatalogItem.image_checked_at.is_not(None))
            | (MaterialCatalogItem.image_source.is_not(None))
        )
    ).all()
    preserved: dict[str, tuple[str | None, str | None, datetime | None]] = {}
    for external_key, image_url, image_source, image_checked_at in rows:
        preserved[str(external_key)] = (
            str(image_url).strip() if image_url else None,
            str(image_source).strip() if image_source else None,
            image_checked_at,
        )
    return preserved


def _import_catalog_rows_in_batches(
    db: Session,
    *,
    source_dir: Path,
    files: list[Path],
    preserved_images: dict[str, tuple[str | None, str | None, datetime | None]],
) -> tuple[int, int]:
    article_dedupe_seen: set[str] = set()
    fallback_dedupe_seen: set[tuple[str, str, str, str, str]] = set()
    pending_rows: list[dict[str, object | None]] = []
    duplicates_skipped = 0
    item_count = 0
    for row in _iter_catalog_rows(source_dir, files):
        article_key = (row.article_no or "").strip().lower()
        if article_key:
            if article_key in article_dedupe_seen:
                duplicates_skipped += 1
                continue
            article_dedupe_seen.add(article_key)
        else:
            dedupe_key = (
                article_key,
                row.item_name.strip().lower(),
                (row.unit or "").strip().lower(),
                (row.manufacturer or "").strip().lower(),
                (row.ean or "").strip().lower(),
            )
            if dedupe_key in fallback_dedupe_seen:
                duplicates_skipped += 1
                continue
            fallback_dedupe_seen.add(dedupe_key)

        external_key = _external_key_for_row(row)
        preserved = preserved_images.get(external_key)
        pending_rows.append(
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
                "image_url": preserved[0] if preserved else None,
                "image_source": preserved[1] if preserved else None,
                "image_checked_at": preserved[2] if preserved else None,
                "search_text": _search_text_for_row(row),
            }
        )
        item_count += 1
        if len(pending_rows) >= CATALOG_IMPORT_BATCH_SIZE:
            _insert_catalog_batch(db, pending_rows)
            pending_rows.clear()

    if pending_rows:
        _insert_catalog_batch(db, pending_rows)

    return item_count, duplicates_skipped


def _insert_catalog_batch(db: Session, rows: list[dict[str, object | None]]) -> None:
    if not rows:
        return
    db.execute(insert(MaterialCatalogItem), rows)


def _should_lookup_image(row: MaterialCatalogItem, *, now, lookup_phase: str) -> bool:
    ean = (row.ean or "").strip()
    if not ean and not is_unielektro_article_no(row.article_no):
        return False
    image_url = (row.image_url or "").strip()
    if image_url:
        if _is_local_catalog_image_url(image_url):
            return not has_cached_material_catalog_image(
                external_key=row.external_key,
                uploads_dir=get_settings().uploads_dir,
            )
        return _image_retry_due(row.image_checked_at, now=now)
    source = (row.image_source or "").strip().lower()
    if lookup_phase == IMAGE_LOOKUP_PHASE_FIRST_PASS:
        return not source
    if source == IMAGE_SOURCE_NOT_FOUND_UNIELEKTRO:
        return True
    if source != IMAGE_SOURCE_NOT_FOUND:
        return False
    return _image_retry_due(row.image_checked_at, now=now)


def _refresh_catalog_item_image(row: MaterialCatalogItem, *, checked_at, lookup_phase: str) -> bool:
    previous = ((row.image_url or "").strip(), (row.image_source or "").strip(), row.image_checked_at)
    existing_image_url = (row.image_url or "").strip()
    if existing_image_url and not _is_local_catalog_image_url(existing_image_url):
        cached = cache_material_catalog_image(
            image_url=existing_image_url,
            external_key=row.external_key,
            uploads_dir=get_settings().uploads_dir,
        )
        row.image_checked_at = checked_at
        if cached is not None:
            row.image_url = cached.public_url[:1000]
        current = ((row.image_url or "").strip(), (row.image_source or "").strip(), row.image_checked_at)
        return current != previous

    if lookup_phase == IMAGE_LOOKUP_PHASE_FIRST_PASS:
        lookup = resolve_material_catalog_image_unielektro(
            ean=row.ean,
            manufacturer=row.manufacturer,
            item_name=row.item_name,
            article_no=row.article_no,
        )
        if lookup is None and not (row.ean or "").strip() and is_unielektro_article_no(row.article_no):
            lookup = resolve_material_catalog_image_unielektro_by_article_no(row.article_no)
    else:
        lookup = resolve_material_catalog_image_fallback(
            ean=row.ean,
            manufacturer=row.manufacturer,
            item_name=row.item_name,
            article_no=row.article_no,
        )
    row.image_checked_at = checked_at
    if lookup is not None:
        cached = cache_material_catalog_image(
            image_url=lookup.image_url,
            external_key=row.external_key,
            uploads_dir=get_settings().uploads_dir,
        )
        if cached is not None:
            row.image_url = cached.public_url[:1000]
        else:
            row.image_url = lookup.image_url[:1000]
        row.image_source = lookup.source[:64]
    elif lookup_phase == IMAGE_LOOKUP_PHASE_FIRST_PASS:
        row.image_source = IMAGE_SOURCE_NOT_FOUND_UNIELEKTRO
    elif not (row.image_url or "").strip():
        row.image_source = IMAGE_SOURCE_NOT_FOUND
    current = ((row.image_url or "").strip(), (row.image_source or "").strip(), row.image_checked_at)
    return current != previous


def _image_lookup_enabled() -> bool:
    return bool(get_settings().material_catalog_image_lookup_enabled)


def _image_lookup_max_items_per_request() -> int:
    settings = get_settings()
    return max(0, int(settings.material_catalog_image_lookup_max_per_request))


def _image_lookup_retry_after() -> timedelta:
    hours = max(1, int(get_settings().material_catalog_image_lookup_retry_hours))
    return timedelta(hours=hours)


def _image_retry_due(checked_at: datetime | None, *, now) -> bool:
    if checked_at is None:
        return True
    retry_after = _image_lookup_retry_after()
    if retry_after.total_seconds() <= 0:
        return True
    return checked_at <= now - retry_after


def _image_lookup_phase(db: Session) -> str:
    image_missing = or_(MaterialCatalogItem.image_url.is_(None), MaterialCatalogItem.image_url == "")
    has_ean = and_(MaterialCatalogItem.ean.is_not(None), MaterialCatalogItem.ean != "")
    has_unielektro_article_no = and_(
        MaterialCatalogItem.article_no.is_not(None),
        MaterialCatalogItem.article_no != "",
        func.length(MaterialCatalogItem.article_no) == 8,
    )
    has_searchable_id = or_(has_ean, has_unielektro_article_no)
    source_empty = or_(MaterialCatalogItem.image_source.is_(None), MaterialCatalogItem.image_source == "")
    first_pass_pending = int(
        db.scalar(select(func.count(MaterialCatalogItem.id)).where(has_searchable_id, image_missing, source_empty)) or 0
    )
    if first_pass_pending > 0:
        return IMAGE_LOOKUP_PHASE_FIRST_PASS
    return IMAGE_LOOKUP_PHASE_FALLBACK


def _is_local_catalog_image_url(value: str) -> bool:
    return value.startswith("/api/materials/catalog/images/")


def _resolve_material_catalog_dir() -> Path | None:
    settings = get_settings()
    configured = (os.environ.get("MATERIAL_CATALOG_DIR") or settings.material_catalog_dir or "").strip()
    candidates: list[Path] = []
    if configured:
        configured_path = Path(configured)
        if configured_path.is_absolute():
            candidates.append(configured_path)
        else:
            candidates.append(Path.cwd() / configured_path)
            candidates.append(Path("/app") / configured_path)
    candidates.extend(
        [
            Path("/data/Datanorm_Neuanlage"),
            Path("/app/Datanorm_Neuanlage"),
            Path.cwd() / "Datanorm_Neuanlage",
            Path.cwd() / "data" / "Datanorm_Neuanlage",
        ]
    )
    for path in candidates:
        if path.exists() and path.is_dir():
            return path
    return None


def _list_catalog_files(source_dir: Path) -> list[Path]:
    return sorted(
        [path for path in source_dir.rglob("*") if path.is_file() and not path.name.startswith(".")],
        key=lambda path: str(path.relative_to(source_dir)).lower(),
    )


def _catalog_signature(source_dir: Path, files: list[Path]) -> str:
    digest = hashlib.sha1()
    digest.update(CATALOG_PARSER_SIGNATURE.encode("utf-8", errors="ignore"))
    digest.update(str(source_dir).encode("utf-8", errors="ignore"))
    for file_path in files:
        stats = file_path.stat()
        digest.update(str(file_path.relative_to(source_dir)).encode("utf-8", errors="ignore"))
        digest.update(f"{stats.st_size}:{stats.st_mtime_ns}".encode("utf-8", errors="ignore"))
    return digest.hexdigest()


def _iter_catalog_rows(source_dir: Path, files: list[Path]) -> Iterator[ParsedCatalogRow]:
    for file_path in files:
        relative_name = str(file_path.relative_to(source_dir))
        yield from _iter_catalog_file_rows(file_path, relative_name)


def _iter_catalog_file_rows(path: Path, relative_name: str) -> Iterator[ParsedCatalogRow]:
    text = _decode_payload(path.read_bytes())
    if not text.strip():
        return
    if _looks_like_datanorm_payload(text):
        yield from _iter_datanorm_rows(text, relative_name)
        return
    saw_delimited = False
    for row in _iter_delimited_rows(text, relative_name):
        saw_delimited = True
        yield row
    if saw_delimited:
        return
    yield from _iter_linewise_rows(text, relative_name)


def _iter_text_lines(text: str) -> Iterator[str]:
    for raw_line in StringIO(text):
        yield raw_line.rstrip("\r\n")


def _decode_payload(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="ignore")


def _iter_datanorm_rows(text: str, relative_name: str) -> Iterator[ParsedCatalogRow]:
    currency = _parse_datanorm_currency(text)
    by_article_no: dict[str, DatanormArticleBuffer] = {}
    article_order: list[str] = []
    for line_number, raw_line in enumerate(_iter_text_lines(text), start=1):
        line = _clean_token(raw_line)
        if not line:
            continue
        parts = [_clean_token(token) for token in line.split(";")]
        if not parts:
            continue
        record_type = parts[0].upper()
        if record_type == "A":
            if len(parts) < 10:
                continue
            article_no = _clean_token(parts[2])
            if not article_no:
                continue
            row = by_article_no.get(article_no)
            if row is None:
                row = DatanormArticleBuffer(source_line=line_number, article_no=article_no)
                by_article_no[article_no] = row
                article_order.append(article_no)
            row.short_text = _clean_token(parts[4])
            row.long_text = _clean_token(parts[5])
            row.unit = _clean_token(parts[8]) or None
            row.price_raw = _clean_token(parts[9]) or None
        elif record_type == "B":
            if len(parts) < 10:
                continue
            article_no = _clean_token(parts[2])
            if not article_no:
                continue
            row = by_article_no.get(article_no)
            if row is None:
                row = DatanormArticleBuffer(source_line=line_number, article_no=article_no)
                by_article_no[article_no] = row
                article_order.append(article_no)
            row.match_code = _clean_token(parts[3]) or None
            row.ean = _clean_token(parts[9]) or None
    for article_no in article_order:
        source = by_article_no[article_no]
        item_name = _build_datanorm_item_name(
            source.short_text,
            source.long_text,
            match_code=source.match_code,
            article_no=source.article_no,
        )
        manufacturer = _derive_datanorm_manufacturer(source.short_text, match_code=source.match_code)
        yield ParsedCatalogRow(
            source_file=relative_name,
            source_line=source.source_line,
            article_no=source.article_no,
            item_name=item_name[:500],
            unit=source.unit,
            manufacturer=manufacturer,
            ean=source.ean,
            price_text=_format_datanorm_price(source.price_raw, currency=currency),
        )


def _looks_like_datanorm_payload(text: str) -> bool:
    saw_a = False
    saw_b = False
    inspected = 0
    for raw_line in _iter_text_lines(text):
        line = _clean_token(raw_line)
        if not line:
            continue
        inspected += 1
        if line.startswith("A;"):
            saw_a = True
        elif line.startswith("B;"):
            saw_b = True
        elif line.startswith("V "):
            continue
        elif inspected <= 5 and line.startswith("V;"):
            continue
        elif inspected >= 10 and not (saw_a or saw_b):
            return False
        if saw_a and saw_b:
            return True
        if inspected >= 80:
            break
    return saw_a


def _parse_datanorm_currency(text: str) -> str | None:
    for raw_line in _iter_text_lines(text):
        line = _clean_token(raw_line)
        if not line:
            continue
        if not line.startswith("V"):
            continue
        match = DATANORM_CURRENCY_RE.search(line)
        if match:
            return match.group(2)
        break
    return None


def _build_datanorm_item_name(short_text: str, long_text: str, *, match_code: str | None, article_no: str) -> str:
    short_clean = _clean_token(short_text)
    long_clean = _clean_token(long_text)
    if short_clean and long_clean:
        short_cmp = DATANORM_COMPARE_RE.sub("", short_clean.lower())
        long_cmp = DATANORM_COMPARE_RE.sub("", long_clean.lower())
        if short_cmp == long_cmp:
            return short_clean
        if long_cmp.startswith(short_cmp):
            return long_clean
        return f"{short_clean} - {long_clean}"
    if short_clean:
        return short_clean
    if long_clean:
        return long_clean
    if match_code:
        return match_code
    return article_no


def _derive_datanorm_manufacturer(short_text: str, *, match_code: str | None) -> str | None:
    short_clean = _clean_token(short_text)
    if not short_clean:
        return None
    if match_code:
        suffix_pattern = re.compile(rf"(?:\s|^){re.escape(match_code)}$", re.IGNORECASE)
        if suffix_pattern.search(short_clean):
            manufacturer = suffix_pattern.sub("", short_clean).strip(" -_/")
            if manufacturer and ALPHA_RE.search(manufacturer):
                return manufacturer[:255]
    parts = short_clean.split()
    if len(parts) >= 2 and any(char.isdigit() for char in parts[-1]):
        manufacturer = " ".join(parts[:-1]).strip(" -_/")
        if manufacturer and ALPHA_RE.search(manufacturer):
            return manufacturer[:255]
    return None


def _format_datanorm_price(raw_value: str | None, *, currency: str | None) -> str | None:
    value = _clean_token(raw_value)
    if not value:
        return None
    compact = value.replace(".", "").replace(",", "").replace(" ", "")
    if compact.isdigit():
        digits = compact.rjust(3, "0")
        major = str(int(digits[:-2])) if digits[:-2] else "0"
        decimal_value = f"{major}.{digits[-2:]}"
        return f"{decimal_value} {currency}" if currency else decimal_value
    if currency and currency.upper() not in value.upper():
        return f"{value} {currency}"
    return value


def _iter_delimited_rows(text: str, relative_name: str) -> Iterator[ParsedCatalogRow]:
    sample_lines = [line for line in _iter_text_lines(text) if line.strip()][:30]
    if len(sample_lines) < 2:
        return
    delimiter = _detect_delimiter(sample_lines)
    if not delimiter:
        return
    reader = csv.reader(StringIO(text), delimiter=delimiter)

    first_row: list[str] | None = None
    first_index = 0
    for index, row in enumerate(reader, start=1):
        cleaned = [_clean_token(cell) for cell in row]
        if any(cleaned):
            first_row = cleaned
            first_index = index
            break
    if first_row is None:
        return

    header_map = _header_map(first_row)
    if not header_map:
        parsed = _parse_tabular_row(first_row, relative_name, first_index, header_map=None)
        if parsed is not None:
            yield parsed

    for index, row in enumerate(reader, start=first_index + 1):
        cleaned = [_clean_token(cell) for cell in row]
        if not any(cleaned):
            continue
        parsed = _parse_tabular_row(cleaned, relative_name, index, header_map)
        if parsed is not None:
            yield parsed


def _detect_delimiter(lines: list[str]) -> str | None:
    best: tuple[str, int] | None = None
    for delimiter in (";", "\t", "|", ","):
        counts = [line.count(delimiter) for line in lines if line and not line.startswith(tuple(IGNORE_LINE_PREFIXES))]
        matching = [value for value in counts if value > 0]
        if len(matching) < 2:
            continue
        score = len(matching)
        if best is None or score > best[1]:
            best = (delimiter, score)
    return best[0] if best else None


def _header_map(header: list[str]) -> dict[str, int] | None:
    mapping: dict[str, int] = {}
    for index, raw in enumerate(header):
        normalized = _normalize_header(raw)
        if normalized in HEADER_ARTICLE_HINTS and "article" not in mapping:
            mapping["article"] = index
        if normalized in HEADER_ITEM_HINTS and "item" not in mapping:
            mapping["item"] = index
        if normalized in HEADER_UNIT_HINTS and "unit" not in mapping:
            mapping["unit"] = index
        if normalized in HEADER_MANUFACTURER_HINTS and "manufacturer" not in mapping:
            mapping["manufacturer"] = index
        if normalized in HEADER_EAN_HINTS and "ean" not in mapping:
            mapping["ean"] = index
        if normalized in HEADER_PRICE_HINTS and "price" not in mapping:
            mapping["price"] = index
    if "item" not in mapping:
        return None
    return mapping


def _parse_tabular_row(
    row: list[str],
    relative_name: str,
    line_number: int,
    header_map: dict[str, int] | None,
) -> ParsedCatalogRow | None:
    if not row:
        return None
    article_no = _column_value(row, header_map, "article")
    item_name = _column_value(row, header_map, "item")
    unit = _column_value(row, header_map, "unit")
    manufacturer = _column_value(row, header_map, "manufacturer")
    ean = _column_value(row, header_map, "ean")
    price_text = _column_value(row, header_map, "price")
    if not article_no:
        article_no = _extract_article_no(row)
    if not item_name:
        item_name = _extract_item_from_tokens(row, article_no=article_no, unit=unit, manufacturer=manufacturer)
    if not unit:
        unit = _extract_unit(row)
    if not ean:
        ean = _extract_ean(row)
    if not price_text:
        price_text = _extract_price(row)
    item_name = _clean_token(item_name)
    if len(item_name) < 2:
        return None
    return ParsedCatalogRow(
        source_file=relative_name,
        source_line=line_number,
        article_no=_clean_token(article_no) or None,
        item_name=item_name[:500],
        unit=_clean_token(unit) or None,
        manufacturer=_clean_token(manufacturer) or None,
        ean=_clean_token(ean) or None,
        price_text=_clean_token(price_text) or None,
    )


def _column_value(row: list[str], header_map: dict[str, int] | None, field: str) -> str:
    if not header_map:
        return ""
    index = header_map.get(field)
    if index is None:
        return ""
    if index < 0 or index >= len(row):
        return ""
    return _clean_token(row[index])


def _iter_linewise_rows(text: str, relative_name: str) -> Iterator[ParsedCatalogRow]:
    for line_number, raw_line in enumerate(_iter_text_lines(text), start=1):
        line = _clean_token(raw_line)
        if not line:
            continue
        if any(line.startswith(prefix) for prefix in IGNORE_LINE_PREFIXES):
            continue
        tokens = [_clean_token(token) for token in re.split(r"[;\t|]+|\s{2,}", line) if _clean_token(token)]
        if not tokens:
            continue
        if _looks_like_header(tokens):
            continue
        article_no = _extract_article_no(tokens)
        unit = _extract_unit(tokens)
        manufacturer = _extract_manufacturer(tokens)
        ean = _extract_ean(tokens)
        price_text = _extract_price(tokens)
        item_name = _extract_item_from_tokens(
            tokens,
            article_no=article_no,
            unit=unit,
            manufacturer=manufacturer,
            ean=ean,
            price_text=price_text,
        )
        if not item_name:
            item_name = _extract_item_from_line(line, article_no=article_no, unit=unit)
        item_name = _clean_token(item_name)
        if len(item_name) < 2:
            continue
        yield ParsedCatalogRow(
            source_file=relative_name,
            source_line=line_number,
            article_no=article_no,
            item_name=item_name[:500],
            unit=unit,
            manufacturer=manufacturer,
            ean=ean,
            price_text=price_text,
        )


def _looks_like_header(tokens: list[str]) -> bool:
    normalized = [_normalize_header(token) for token in tokens]
    if not normalized:
        return False
    known = sum(1 for token in normalized[:6] if token in KNOWN_HEADER_WORDS)
    return known >= 2


def _extract_article_no(tokens: list[str]) -> str | None:
    for token in tokens:
        compact = token.replace(" ", "")
        upper = compact.upper()
        if len(upper) > 64:
            continue
        if not ARTICLE_TOKEN_RE.match(upper):
            continue
        if not any(char.isdigit() for char in upper):
            continue
        return compact
    return None


def _extract_unit(tokens: list[str]) -> str | None:
    for token in tokens:
        lowered = token.lower().strip(".")
        if lowered in UNIT_HINTS:
            return token
    return None


def _extract_manufacturer(tokens: list[str]) -> str | None:
    for token in tokens:
        lowered = token.lower()
        if lowered in {"hersteller", "manufacturer", "brand", "marke"}:
            continue
        if not ALPHA_RE.search(token):
            continue
        if _looks_like_price(token) or _looks_like_article(token):
            continue
        if len(token) < 3 or len(token) > 40:
            continue
        if token.isupper() and len(token) <= 4:
            continue
        return token
    return None


def _extract_ean(tokens: list[str]) -> str | None:
    for token in tokens:
        compact = token.replace(" ", "")
        if EAN_TOKEN_RE.match(compact):
            return compact
    return None


def _extract_price(tokens: list[str]) -> str | None:
    for token in tokens:
        compact = token.replace(" ", "")
        if "€" in compact:
            return token
        if PRICE_TOKEN_RE.match(compact):
            return token
    return None


def _extract_item_from_tokens(
    tokens: list[str],
    *,
    article_no: str | None = None,
    unit: str | None = None,
    manufacturer: str | None = None,
    ean: str | None = None,
    price_text: str | None = None,
) -> str:
    excluded = {
        (article_no or "").strip().lower(),
        (unit or "").strip().lower(),
        (manufacturer or "").strip().lower(),
        (ean or "").strip().lower(),
        (price_text or "").strip().lower(),
    }
    candidates: list[str] = []
    for token in tokens:
        lowered = token.lower()
        if not token or lowered in excluded:
            continue
        if lowered in KNOWN_HEADER_WORDS:
            continue
        if _looks_like_article(token) or _looks_like_price(token):
            continue
        if lowered in UNIT_HINTS:
            continue
        if len(token) <= 1:
            continue
        if not ALPHA_RE.search(token):
            continue
        if re.fullmatch(r"[A-Z]\d?", token):
            continue
        candidates.append(token)
    if not candidates:
        return ""
    if len(candidates) == 1:
        return candidates[0]
    joined = " ".join(candidates)
    if len(joined) <= 500:
        return joined
    return max(candidates, key=len)


def _extract_item_from_line(line: str, *, article_no: str | None, unit: str | None) -> str:
    cleaned = line
    if article_no:
        cleaned = cleaned.replace(article_no, " ")
    if unit:
        cleaned = re.sub(rf"\b{re.escape(unit)}\b", " ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"[;\t|]+", " ", cleaned)
    cleaned = re.sub(r"\b\d+(?:[.,]\d+)?\b", " ", cleaned)
    cleaned = re.sub(r"\b[A-Z]\d?\b", " ", cleaned)
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
    return cleaned


def _looks_like_price(token: str) -> bool:
    compact = token.replace(" ", "")
    return bool("€" in compact or PRICE_TOKEN_RE.match(compact))


def _looks_like_article(token: str) -> bool:
    compact = token.replace(" ", "").upper()
    return bool(ARTICLE_TOKEN_RE.match(compact) and any(char.isdigit() for char in compact))


def _search_text_for_row(row: ParsedCatalogRow) -> str:
    return " ".join(
        part.strip().lower()
        for part in [
            row.article_no or "",
            row.item_name,
            row.unit or "",
            row.manufacturer or "",
            row.ean or "",
            row.price_text or "",
            row.source_file,
        ]
        if part and part.strip()
    )


def _external_key_for_row(row: ParsedCatalogRow) -> str:
    digest = hashlib.sha1()
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


def _clean_token(value: object) -> str:
    raw = str(value or "").replace("\x00", "")
    return re.sub(r"\s{2,}", " ", raw).strip()


def _normalize_header(value: str) -> str:
    lowered = value.strip().lower()
    lowered = lowered.replace("-", "_").replace(" ", "_")
    lowered = re.sub(r"[^a-z0-9_äöüß]", "", lowered)
    return lowered
