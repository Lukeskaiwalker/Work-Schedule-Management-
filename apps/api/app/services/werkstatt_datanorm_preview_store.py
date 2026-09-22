"""Where a Datanorm preview waits between "Vorschau analysieren" and "Import
starten": on disk, not in the worker's memory.

The API runs several uvicorn workers, and the commit request lands on
whichever one is free — a preview kept in a module-level dict is found only
by the worker that made it, so half the commits would answer "token
unknown". The directory is inside the container, shared by all its
workers, and holds two files per token:

* ``<token>.json``       — what the preview shows (stats, samples, conflicts)
* ``<token>.rows.jsonl`` — every parsed row, one JSON array per line, so the
  commit streams them in batches and never holds the catalog in memory.

A preview expires after ``PREVIEW_TTL_SECONDS``; expiry is the file's age,
so a crashed worker leaves nothing behind that the next upload does not
sweep. Committing claims the token by renaming its meta file, so a second
click on "Import starten" finds nothing to commit.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import time
from collections.abc import Iterable, Iterator
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path

from app.core.config import get_settings
from app.services.material_catalog import ParsedCatalogRow

PREVIEW_TTL_SECONDS = 15 * 60

# ``secrets.token_urlsafe`` alphabet. A token names files, so anything else
# — a slash, a dot — is refused before it reaches the filesystem.
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{8,256}$")

_META_SUFFIX = ".json"
_ROWS_SUFFIX = ".rows.jsonl"
_CLAIMED_SUFFIX = ".committing.json"
_UPLOAD_SUFFIX = ".upload"

# The order of a row's fields on a JSONL line — positional, to keep the file
# a third smaller than dicts would.
_ROW_FIELDS = ("source_file", "source_line", "article_no", "item_name", "unit", "manufacturer", "ean", "price_text")


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


class PreviewStoreError(RuntimeError):
    """The directory cannot be used — surfaced as a 500 with a clear message
    rather than a stack trace from deep inside a file write."""


def preview_dir() -> Path:
    """The configured directory, or a folder in the system temp dir. Created
    on first use; every worker of one container resolves the same path."""
    configured = (os.environ.get("DATANORM_PREVIEW_DIR") or get_settings().datanorm_preview_dir or "").strip()
    path = Path(configured) if configured else Path(tempfile.gettempdir()) / "smpl-datanorm-previews"
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise PreviewStoreError(f"Datanorm preview directory is not writable: {path}") from exc
    return path


def is_valid_token(token: str) -> bool:
    return bool(_TOKEN_RE.match(token or ""))


def _path(token: str, suffix: str) -> Path:
    if not is_valid_token(token):
        raise ValueError("Import token expired or unknown")
    return preview_dir() / f"{token}{suffix}"


def upload_path(token: str) -> Path:
    """Where the raw upload is streamed to while it is analysed."""
    return _path(token, _UPLOAD_SUFFIX)


# ── Writing ──────────────────────────────────────────────────────────────────


class PreviewRowWriter:
    """Streams parsed rows to the JSONL file while the preview is computed,
    so the rows never have to exist as one list."""

    def __init__(self, token: str) -> None:
        self._path = _path(token, _ROWS_SUFFIX)
        self._handle = self._path.open("w", encoding="utf-8")
        self.count = 0

    def write(self, row: ParsedCatalogRow) -> None:
        self._handle.write(json.dumps([getattr(row, name) for name in _ROW_FIELDS], ensure_ascii=False))
        self._handle.write("\n")
        self.count += 1

    def close(self) -> None:
        self._handle.close()

    def abandon(self) -> None:
        self.close()
        self._path.unlink(missing_ok=True)


def save_preview_meta(preview: DatanormPreview) -> None:
    payload = asdict(preview)
    payload["uploaded_at"] = preview.uploaded_at.isoformat()
    payload["expires_at"] = preview.expires_at.isoformat()
    target = _path(preview.token, _META_SUFFIX)
    # Written beside and renamed into place: a reader never sees half a file.
    tmp = target.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, target)


# ── Reading ──────────────────────────────────────────────────────────────────


def _meta_from_payload(payload: dict) -> DatanormPreview:
    return DatanormPreview(
        token=payload["token"],
        supplier_id=int(payload["supplier_id"]),
        supplier_name=str(payload["supplier_name"]),
        filename=str(payload["filename"]),
        file_size_bytes=int(payload["file_size_bytes"]),
        detected_version=payload.get("detected_version"),
        detected_encoding=payload.get("detected_encoding"),
        total_rows=int(payload["total_rows"]),
        rows_new=int(payload["rows_new"]),
        rows_updated=int(payload["rows_updated"]),
        rows_unchanged=int(payload["rows_unchanged"]),
        ean_conflicts=[DatanormEanConflict(**item) for item in payload.get("ean_conflicts", [])],
        sample_rows=[ParsedCatalogRow(**item) for item in payload.get("sample_rows", [])],
        uploaded_at=datetime.fromisoformat(payload["uploaded_at"]),
        expires_at=datetime.fromisoformat(payload["expires_at"]),
    )


def _read_meta(path: Path, *, now: datetime) -> DatanormPreview | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    try:
        preview = _meta_from_payload(payload)
    except (KeyError, TypeError, ValueError):
        return None
    if preview.expires_at <= now:
        return None
    return preview


def load_preview(token: str, *, now: datetime) -> DatanormPreview | None:
    """The preview as the page shows it, or None when unknown or expired."""
    if not is_valid_token(token):
        return None
    prune_expired()
    preview = _read_meta(_path(token, _META_SUFFIX), now=now)
    if preview is None:
        discard_preview(token)
    return preview


def claim_preview(token: str, *, now: datetime) -> DatanormPreview | None:
    """Take the preview for committing: the meta file is renamed, so a
    second commit of the same token finds nothing. None when unknown,
    expired, or already claimed."""
    if not is_valid_token(token):
        return None
    prune_expired()
    meta = _path(token, _META_SUFFIX)
    claimed = _path(token, _CLAIMED_SUFFIX)
    try:
        os.rename(meta, claimed)
    except FileNotFoundError:
        return None
    preview = _read_meta(claimed, now=now)
    if preview is None:
        discard_preview(token)
    return preview


def iter_preview_rows(token: str) -> Iterator[ParsedCatalogRow]:
    """The parsed rows, streamed from the JSONL file in the order they were
    written — never all at once."""
    path = _path(token, _ROWS_SUFFIX)
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            values = json.loads(line)
            yield ParsedCatalogRow(**dict(zip(_ROW_FIELDS, values)))


def discard_preview(token: str) -> None:
    if not is_valid_token(token):
        return
    for suffix in (_META_SUFFIX, _CLAIMED_SUFFIX, _ROWS_SUFFIX, _UPLOAD_SUFFIX, ".json.tmp"):
        _path(token, suffix).unlink(missing_ok=True)


def prune_expired(*, max_age_seconds: int = PREVIEW_TTL_SECONDS) -> int:
    """Remove every file older than the TTL — by age, so an upload a crashed
    worker never finished is swept like a preview nobody committed."""
    cutoff = time.time() - max_age_seconds
    removed = 0
    try:
        entries: Iterable[Path] = list(preview_dir().iterdir())
    except OSError:
        return 0
    for entry in entries:
        try:
            if entry.is_file() and entry.stat().st_mtime < cutoff:
                entry.unlink(missing_ok=True)
                removed += 1
        except OSError:
            continue
    return removed
