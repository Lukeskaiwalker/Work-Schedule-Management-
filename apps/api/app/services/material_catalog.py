from __future__ import annotations

from collections.abc import Iterator
import csv
import hashlib
import os
import re
from datetime import datetime, timedelta
from dataclasses import dataclass
from io import StringIO
from pathlib import Path

from sqlalchemy import and_, case, delete, func, insert, or_, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.time import utcnow
from app.models.entities import MaterialCatalogImportState, MaterialCatalogItem
from app.services.material_catalog_images import resolve_material_catalog_image

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
    total_items: int
    items_with_image: int
    items_checked: int
    items_pending: int
    items_waiting_retry: int
    items_not_found: int
    last_checked_at: datetime | None


def ensure_material_catalog_up_to_date(db: Session) -> None:
    source_dir = _resolve_material_catalog_dir()
    if source_dir is None:
        return
    files = _list_catalog_files(source_dir)
    signature = _catalog_signature(source_dir, files)
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
    ensure_material_catalog_images(db, rows)
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
    changed = False
    checked = 0
    for row in rows:
        if checked >= max_items:
            break
        if not _should_lookup_image(row, now=now):
            continue
        checked += 1
        if _refresh_catalog_item_image(row, checked_at=now):
            db.add(row)
            changed = True
    if changed:
        db.commit()


def ensure_material_catalog_item_image(db: Session, row: MaterialCatalogItem) -> None:
    if not _image_lookup_enabled():
        return
    now = utcnow()
    if not _should_lookup_image(row, now=now):
        return
    if not _refresh_catalog_item_image(row, checked_at=now):
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
    retry_after = _image_lookup_retry_after()
    retry_cutoff = now - retry_after
    image_missing = or_(MaterialCatalogItem.image_url.is_(None), MaterialCatalogItem.image_url == "")
    has_ean = and_(MaterialCatalogItem.ean.is_not(None), MaterialCatalogItem.ean != "")
    eligible_for_retry = or_(
        MaterialCatalogItem.image_checked_at.is_(None),
        MaterialCatalogItem.image_checked_at <= retry_cutoff,
    )
    rows = list(
        db.scalars(
            select(MaterialCatalogItem)
            .where(has_ean, image_missing, eligible_for_retry)
            .order_by(
                case((MaterialCatalogItem.image_checked_at.is_(None), 0), else_=1).asc(),
                MaterialCatalogItem.image_checked_at.asc(),
                MaterialCatalogItem.id.asc(),
            )
            .limit(effective_limit)
        ).all()
    )

    changed = False
    processed = 0
    for row in rows:
        if processed >= effective_limit:
            break
        if not _should_lookup_image(row, now=now):
            continue
        processed += 1
        if _refresh_catalog_item_image(row, checked_at=now):
            db.add(row)
            changed = True
    if changed:
        db.commit()
    return processed


def get_material_catalog_image_status(db: Session) -> MaterialCatalogImageStatus:
    ensure_material_catalog_up_to_date(db)
    total_items = int(db.scalar(select(func.count(MaterialCatalogItem.id))) or 0)
    if total_items <= 0:
        return MaterialCatalogImageStatus(
            lookup_enabled=_image_lookup_enabled(),
            total_items=0,
            items_with_image=0,
            items_checked=0,
            items_pending=0,
            items_waiting_retry=0,
            items_not_found=0,
            last_checked_at=None,
        )

    image_present = and_(MaterialCatalogItem.image_url.is_not(None), MaterialCatalogItem.image_url != "")
    image_missing = or_(MaterialCatalogItem.image_url.is_(None), MaterialCatalogItem.image_url == "")
    has_ean = and_(MaterialCatalogItem.ean.is_not(None), MaterialCatalogItem.ean != "")
    retry_cutoff = utcnow() - _image_lookup_retry_after()
    due_now = or_(
        MaterialCatalogItem.image_checked_at.is_(None),
        MaterialCatalogItem.image_checked_at <= retry_cutoff,
    )

    items_with_image = int(db.scalar(select(func.count(MaterialCatalogItem.id)).where(image_present)) or 0)
    items_checked = int(
        db.scalar(select(func.count(MaterialCatalogItem.id)).where(MaterialCatalogItem.image_checked_at.is_not(None))) or 0
    )
    items_not_found = int(
        db.scalar(select(func.count(MaterialCatalogItem.id)).where(MaterialCatalogItem.image_source == "not_found")) or 0
    )
    items_pending = int(db.scalar(select(func.count(MaterialCatalogItem.id)).where(has_ean, image_missing, due_now)) or 0)
    items_waiting_retry = int(
        db.scalar(
            select(func.count(MaterialCatalogItem.id)).where(
                has_ean,
                image_missing,
                MaterialCatalogItem.image_checked_at.is_not(None),
                MaterialCatalogItem.image_checked_at > retry_cutoff,
            )
        )
        or 0
    )
    last_checked_at = db.scalar(select(func.max(MaterialCatalogItem.image_checked_at)))
    return MaterialCatalogImageStatus(
        lookup_enabled=_image_lookup_enabled(),
        total_items=total_items,
        items_with_image=items_with_image,
        items_checked=items_checked,
        items_pending=items_pending,
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


def _should_lookup_image(row: MaterialCatalogItem, *, now) -> bool:
    ean = (row.ean or "").strip()
    if not ean:
        return False
    if (row.image_url or "").strip():
        return False
    if row.image_checked_at is None:
        return True
    retry_after = _image_lookup_retry_after()
    if retry_after.total_seconds() <= 0:
        return True
    return row.image_checked_at <= now - retry_after


def _refresh_catalog_item_image(row: MaterialCatalogItem, *, checked_at) -> bool:
    previous = ((row.image_url or "").strip(), (row.image_source or "").strip(), row.image_checked_at)
    lookup = resolve_material_catalog_image(
        ean=row.ean,
        manufacturer=row.manufacturer,
        item_name=row.item_name,
        article_no=row.article_no,
    )
    row.image_checked_at = checked_at
    if lookup is not None:
        row.image_url = lookup.image_url[:1000]
        row.image_source = lookup.source[:64]
    elif not (row.image_url or "").strip():
        row.image_source = "not_found"
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
