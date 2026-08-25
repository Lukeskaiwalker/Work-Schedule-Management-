"""Copy a test instrument's SD card into the station, and stage it for SMPL.

An electrician comes back from a DGUV V3 round with a Benning ST 760 or a
Metrel MI 3152 and an SD card full of test protocols. Today that card goes to
somebody's laptop, through a vendor Windows program, and eventually into SMPL
by hand. The station's job is to make step one automatic: card in, card
copied, card safe, and a queue entry waiting to go to SMPL.

The rule this module is built around
------------------------------------
**The bytes on the card are the evidence, and they are never modified,
never re-encoded, and never dropped because we failed to understand them.**

A test protocol is a legal document in a DGUV V3 audit. A parser that quietly
mangles one is far more damaging than no parser at all - a mangled record
looks like data and gets believed. So the pipeline is:

    1. copy every recognised file byte-for-byte into the staging directory
    2. hash each copy and record the hash in a manifest
    3. *then*, and only if the format is one we actually know, try to parse
    4. a failed or absent parse is a normal outcome: status "passthrough"

Every import therefore produces something useful even for an instrument we
have never seen, and the raw files stay available for whoever does understand
them. See :mod:`sd_formats` for exactly which formats are claimed and with
what confidence.

The card is opened read-only. Nothing here writes to, renames, or deletes
anything on removable media.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import agent_paths
import sd_formats
from sd_mounts import Mount, MountWatcher

__all__ = ["ImportStore", "SdImporter", "ImportResult", "MANIFEST_VERSION"]

MANIFEST_VERSION = 1

# Bounds. A card is untrusted input: it can be 128 GB of holiday photos, it can
# contain a directory loop, and it can be unplugged halfway through the copy.
MAX_FILES = 5000
MAX_TOTAL_BYTES = 512 * 1024 * 1024
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_DEPTH = 8
SNIFF_BYTES = 8192

DEFAULT_POLL_S = 2.0

IMPORT_SCHEMA = """
CREATE TABLE IF NOT EXISTS sd_imports (
    import_id      TEXT PRIMARY KEY,
    created_at     TEXT NOT NULL,
    mount_point    TEXT,
    volume_label   TEXT,
    vendor         TEXT,
    model_hint     TEXT,
    confidence     TEXT,
    file_count     INTEGER NOT NULL DEFAULT 0,
    byte_count     INTEGER NOT NULL DEFAULT 0,
    fingerprint    TEXT,
    parse_status   TEXT,
    upload_status  TEXT NOT NULL DEFAULT 'pending',
    upload_error   TEXT,
    uploaded_at    TEXT,
    directory      TEXT NOT NULL,
    simulated      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sd_imports_fingerprint ON sd_imports(fingerprint);
CREATE INDEX IF NOT EXISTS idx_sd_imports_upload ON sd_imports(upload_status, created_at);
"""


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _stamp_of(mtime: float) -> str:
    try:
        return datetime.fromtimestamp(mtime, timezone.utc).replace(
            microsecond=0).isoformat().replace("+00:00", "Z")
    except (OverflowError, OSError, ValueError):
        return ""


@dataclass
class StagedFile:
    relative_path: str
    bytes: int
    sha256: str
    modified_at: str
    format_id: str
    vendor: str
    confidence: str
    reason: str
    parsed: bool = False
    parse_note: str = ""
    records: int = 0

    def as_dict(self) -> Dict[str, Any]:
        return {
            "path": self.relative_path,
            "bytes": self.bytes,
            "sha256": self.sha256,
            "modified_at": self.modified_at,
            "format": self.format_id,
            "vendor": self.vendor or None,
            "confidence": self.confidence,
            "reason": self.reason,
            "parsed": self.parsed,
            "parse_note": self.parse_note or None,
            "records": self.records,
        }


@dataclass
class ImportResult:
    """What one card turned into."""

    import_id: str
    status: str  # staged | duplicate | empty | error
    directory: Optional[Path] = None
    files: List[StagedFile] = field(default_factory=list)
    vendor: str = ""
    model_hint: str = ""
    confidence: str = "none"
    parse_status: str = "passthrough"
    fingerprint: str = ""
    skipped: List[str] = field(default_factory=list)
    error: str = ""
    duplicate_of: str = ""

    @property
    def byte_count(self) -> int:
        return sum(f.bytes for f in self.files)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "import_id": self.import_id,
            "status": self.status,
            "directory": str(self.directory) if self.directory else None,
            "vendor": self.vendor or None,
            "model_hint": self.model_hint or None,
            "confidence": self.confidence,
            "parse_status": self.parse_status,
            "fingerprint": self.fingerprint,
            "file_count": len(self.files),
            "byte_count": self.byte_count,
            "skipped": self.skipped[:20],
            "error": self.error or None,
            "duplicate_of": self.duplicate_of or None,
        }


# --------------------------------------------------------------------------
# Persistence
# --------------------------------------------------------------------------


class ImportStore:
    """The imports table, in the same SQLite file as the counts.

    Same file on purpose: one thing to back up, one thing to copy off a dying
    Pi. WAL means the importer thread writing a manifest row cannot block a
    scan being counted.
    """

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._local = threading.local()
        with self._connect() as conn:
            conn.executescript(IMPORT_SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.path), timeout=10.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    @property
    def conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = self._connect()
            self._local.conn = conn
        return conn

    def find_by_fingerprint(self, fingerprint: str) -> Optional[str]:
        if not fingerprint:
            return None
        row = self.conn.execute(
            "SELECT import_id FROM sd_imports WHERE fingerprint = ? ORDER BY created_at LIMIT 1",
            (fingerprint,),
        ).fetchone()
        return row["import_id"] if row else None

    def record(self, result: ImportResult, mount: Mount) -> None:
        with self.conn as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO sd_imports
                    (import_id, created_at, mount_point, volume_label, vendor, model_hint,
                     confidence, file_count, byte_count, fingerprint, parse_status,
                     upload_status, upload_error, uploaded_at, directory, simulated)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                        COALESCE((SELECT upload_status FROM sd_imports WHERE import_id = ?), 'pending'),
                        NULL, NULL, ?, ?)
                """,
                (
                    result.import_id, _now_iso(), mount.mount_point, mount.label,
                    result.vendor, result.model_hint, result.confidence,
                    len(result.files), result.byte_count, result.fingerprint,
                    result.parse_status, result.import_id,
                    str(result.directory or ""), 1 if mount.simulated else 0,
                ),
            )

    def set_upload(self, import_id: str, status: str, error: str = "") -> None:
        with self.conn as conn:
            conn.execute(
                """
                UPDATE sd_imports
                   SET upload_status = ?, upload_error = ?,
                       uploaded_at = CASE WHEN ? = 'uploaded' THEN ? ELSE uploaded_at END
                 WHERE import_id = ?
                """,
                (status, error or None, status, _now_iso(), import_id),
            )

    def list(self, limit: int = 50) -> List[Dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM sd_imports ORDER BY created_at DESC LIMIT ?", (int(limit),)
        ).fetchall()
        return [dict(r) for r in rows]

    def get(self, import_id: str) -> Optional[Dict[str, Any]]:
        row = self.conn.execute(
            "SELECT * FROM sd_imports WHERE import_id = ?", (import_id,)
        ).fetchone()
        return dict(row) if row else None

    def pending(self, limit: int = 20) -> List[Dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM sd_imports WHERE upload_status IN ('pending', 'failed') "
            "ORDER BY created_at LIMIT ?",
            (int(limit),),
        ).fetchall()
        return [dict(r) for r in rows]


# --------------------------------------------------------------------------
# The importer
# --------------------------------------------------------------------------


class SdImporter:
    """Watches for cards and stages what it finds."""

    def __init__(self, store: ImportStore, *, staging_dir: Optional[Path] = None,
                 simulate_root: Optional[str] = None, poll_s: float = DEFAULT_POLL_S,
                 agent_version: str = "", uploader=None) -> None:
        self.store = store
        self.staging_dir = Path(staging_dir) if staging_dir else agent_paths.imports_dir()
        self.staging_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.simulate_root = simulate_root
        self.poll_s = max(0.5, float(poll_s))
        self.agent_version = agent_version
        self.uploader = uploader
        self.watcher = MountWatcher(simulate_root=simulate_root)
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self._last: Optional[ImportResult] = None
        self._last_error = ""
        self._imports_seen = 0

    # -- lifecycle --------------------------------------------------------

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="sd-import", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                for mount in self.watcher.poll():
                    self._handle(mount)
            except Exception as exc:  # noqa: BLE001 - the watcher must never die
                with self._lock:
                    self._last_error = "%s: %s" % (type(exc).__name__, exc)
            self._stop.wait(self.poll_s)

    def _handle(self, mount: Mount) -> None:
        result = self.ingest(mount)
        with self._lock:
            self._last = result
            self._imports_seen += 1
            self._last_error = result.error
        if result.status == "staged" and self.uploader is not None:
            try:
                self.uploader.submit(result.import_id)
            except Exception as exc:  # noqa: BLE001 - upload is best-effort
                self.store.set_upload(result.import_id, "failed",
                                      "%s: %s" % (type(exc).__name__, exc))

    # -- the actual work --------------------------------------------------

    def ingest(self, mount: Mount) -> ImportResult:
        """Copy, hash, manifest and (maybe) parse one card. Never raises."""
        import_id = self._new_id()
        try:
            return self._ingest(import_id, mount)
        except Exception as exc:  # noqa: BLE001 - a bad card is not a crash
            return ImportResult(
                import_id=import_id,
                status="error",
                error="%s: %s" % (type(exc).__name__, exc),
            )

    def _ingest(self, import_id: str, mount: Mount) -> ImportResult:
        found, skipped, top_dirs = self._walk(mount.path)
        if not found:
            return ImportResult(
                import_id=import_id, status="empty", skipped=skipped,
                error="no recognised files on %s" % mount.mount_point,
            )

        target = self.staging_dir / import_id
        files_dir = target / "files"
        files_dir.mkdir(parents=True, exist_ok=True)

        staged: List[StagedFile] = []
        for source, relative, match in found:
            copied = self._copy_one(source, files_dir / relative, relative, match, files_dir)
            if copied is None:
                skipped.append("%s (unreadable)" % relative)
                continue
            staged.append(copied)

        if not staged:
            shutil.rmtree(target, ignore_errors=True)
            return ImportResult(
                import_id=import_id, status="empty", skipped=skipped,
                error="every candidate file on %s failed to copy" % mount.mount_point,
            )

        fingerprint = _fingerprint(staged)
        existing = self.store.find_by_fingerprint(fingerprint)
        if existing and existing != import_id:
            # Same bytes as a card we already have. Keep the first copy and
            # throw this one away rather than growing a pile of identical
            # imports every time somebody leaves the card in the reader.
            shutil.rmtree(target, ignore_errors=True)
            return ImportResult(
                import_id=import_id, status="duplicate", fingerprint=fingerprint,
                duplicate_of=existing, files=staged, skipped=skipped,
            )

        volume = sd_formats.classify_volume(
            mount.label, [f.format_id for f in staged], top_dirs
        )
        parse_status = self._parse_all(files_dir, staged, target)

        result = ImportResult(
            import_id=import_id,
            status="staged",
            directory=target,
            files=staged,
            vendor=volume.vendor,
            model_hint=volume.model_hint,
            confidence=volume.confidence,
            parse_status=parse_status,
            fingerprint=fingerprint,
            skipped=skipped,
        )
        self._write_manifest(target, result, mount)
        self.store.record(result, mount)
        return result

    def _walk(self, root: Path):
        """Every candidate file on the card, bounded and symlink-safe.

        Also returns the card's top-level directory names, because those are
        the strongest instrument signal there is: Metrel's manuals name
        WORKSPACES / EXPORTS / __MOS__ explicitly, and a Benning ST card is a
        database at the root next to a Backups folder.
        """
        found = []
        skipped: List[str] = []
        top_dirs: List[str] = []
        total_bytes = 0
        root = Path(root)

        for dirpath, dirnames, filenames in os.walk(str(root), followlinks=False):
            relative_dir = os.path.relpath(dirpath, str(root))
            depth = 0 if relative_dir == "." else relative_dir.count(os.sep) + 1
            if depth >= MAX_DEPTH:
                dirnames[:] = []
            # Vendor programs and the OS both litter; none of it is evidence.
            dirnames[:] = [d for d in dirnames if not _is_noise_dir(d)]
            if relative_dir == ".":
                top_dirs = list(dirnames)
            for name in sorted(filenames):
                if _is_noise_file(name):
                    continue
                source = Path(dirpath) / name
                relative = os.path.relpath(str(source), str(root))
                if len(found) >= MAX_FILES:
                    skipped.append("%s (file limit %d reached)" % (relative, MAX_FILES))
                    continue
                try:
                    stat = source.lstat()
                except OSError:
                    skipped.append("%s (unreadable)" % relative)
                    continue
                if not os.path.isfile(str(source)) or os.path.islink(str(source)):
                    continue
                if stat.st_size > MAX_FILE_BYTES:
                    skipped.append("%s (%d bytes, over the %d limit)"
                                   % (relative, stat.st_size, MAX_FILE_BYTES))
                    continue
                match = sd_formats.classify(source, _sniff(source))
                if match.format_id == sd_formats.FORMAT_IGNORE:
                    continue
                if total_bytes + stat.st_size > MAX_TOTAL_BYTES:
                    skipped.append("%s (import would exceed %d bytes)"
                                   % (relative, MAX_TOTAL_BYTES))
                    continue
                total_bytes += stat.st_size
                found.append((source, relative, match))
        return found, skipped, top_dirs

    @staticmethod
    def _copy_one(source: Path, destination: Path, relative: str,
                  match: "sd_formats.FormatMatch", root: Path) -> Optional[StagedFile]:
        # A card's filenames are untrusted. os.walk plus relpath should never
        # produce a path that escapes, but "should never" is not a guarantee
        # worth betting the host filesystem on, so the resolved destination is
        # checked against the staging root before a single byte is written.
        try:
            resolved = destination.resolve()
            resolved.relative_to(Path(root).resolve())
        except (ValueError, OSError):
            return None
        destination.parent.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256()
        try:
            with open(str(source), "rb") as reader, open(str(destination), "wb") as writer:
                while True:
                    chunk = reader.read(256 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
                    writer.write(chunk)
            stat = source.stat()
        except OSError:
            try:
                destination.unlink()
            except OSError:
                pass
            return None
        # Keep the card's timestamps: on a test protocol the mtime is often the
        # only record of when the measurement was actually taken.
        try:
            os.utime(str(destination), (stat.st_atime, stat.st_mtime))
        except OSError:
            pass
        return StagedFile(
            relative_path=relative.replace(os.sep, "/"),
            bytes=stat.st_size,
            sha256=digest.hexdigest(),
            modified_at=_stamp_of(stat.st_mtime),
            format_id=match.format_id,
            vendor=match.vendor,
            confidence=match.confidence,
            reason=match.reason,
        )

    def _parse_all(self, files_dir: Path, staged: List[StagedFile], target: Path) -> str:
        """Try each parser. Copying already succeeded, so nothing here is fatal."""
        records: List[Dict[str, Any]] = []
        any_parsed = False
        any_failed = False
        for entry in staged:
            outcome = sd_formats.parse(entry.format_id, files_dir / entry.relative_path)
            if outcome is None:
                entry.parse_note = "no parser for %s - staged as raw evidence" % entry.format_id
                continue
            if outcome.ok:
                entry.parsed = True
                entry.records = len(outcome.records)
                entry.parse_note = outcome.note
                any_parsed = True
                for record in outcome.records:
                    enriched = dict(record)
                    enriched["_source_file"] = entry.relative_path
                    enriched["_format"] = entry.format_id
                    records.append(enriched)
            else:
                any_failed = True
                entry.parse_note = outcome.note or "parse failed"

        if records:
            _write_json(target / "parsed.json", {
                "manifest_version": MANIFEST_VERSION,
                "parsed_at": _now_iso(),
                "record_count": len(records),
                "records": records,
            })
        if any_parsed and not any_failed:
            return "parsed"
        if any_parsed:
            return "partial"
        return "passthrough"

    def _write_manifest(self, target: Path, result: ImportResult, mount: Mount) -> None:
        manifest = {
            "manifest_version": MANIFEST_VERSION,
            "import_id": result.import_id,
            "created_at": _now_iso(),
            "agent_version": self.agent_version,
            "device_id": agent_paths.device_id(),
            "source": mount.as_dict(),
            "instrument": {
                "vendor": result.vendor or None,
                "model_hint": result.model_hint or None,
                "confidence": result.confidence,
            },
            "totals": {
                "files": len(result.files),
                "bytes": result.byte_count,
                "skipped": len(result.skipped),
            },
            "fingerprint": result.fingerprint,
            "parse_status": result.parse_status,
            "files": [f.as_dict() for f in result.files],
            "skipped": result.skipped[:100],
            "notes": sd_formats.CONFIDENCE_NOTE,
        }
        _write_json(target / "manifest.json", manifest)

    @staticmethod
    def _new_id() -> str:
        return "%s-%s" % (
            datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
            uuid.uuid4().hex[:6],
        )

    # -- reporting --------------------------------------------------------

    def status(self) -> Dict[str, Any]:
        with self._lock:
            last = self._last.as_dict() if self._last else None
            error = self._last_error
            seen = self._imports_seen
        running = self._thread is not None and self._thread.is_alive()
        return {
            "running": running,
            "simulated": bool(self.simulate_root),
            "watch_root": self.simulate_root or "auto",
            "poll_seconds": self.poll_s,
            "staging_dir": str(self.staging_dir),
            "mounts_known": self.watcher.known(),
            "imports_this_session": seen,
            "last_import": last,
            "last_error": error or None,
        }

    def rescan(self) -> Dict[str, Any]:
        """Forget what we have seen so the next poll re-reads every card."""
        for point in list(self.watcher.known()):
            self.watcher.forget(point)
        return {"ok": True, "rescanning": True}

    def manifest_path(self, import_id: str) -> Optional[Path]:
        row = self.store.get(import_id)
        if not row or not row.get("directory"):
            return None
        candidate = Path(row["directory"]) / "manifest.json"
        return candidate if candidate.is_file() else None


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def _sniff(path: Path) -> bytes:
    try:
        with open(str(path), "rb") as handle:
            return handle.read(SNIFF_BYTES)
    except OSError:
        return b""


def _fingerprint(staged: List[StagedFile]) -> str:
    digest = hashlib.sha256()
    for entry in sorted(staged, key=lambda f: f.relative_path):
        digest.update(("%s:%s\n" % (entry.relative_path, entry.sha256)).encode("utf-8"))
    return "sha256:" + digest.hexdigest()


def _write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(str(tmp), str(path))


_NOISE_DIRS = frozenset(
    {".Spotlight-V100", ".Trashes", ".fseventsd", "System Volume Information",
     "$RECYCLE.BIN", ".TemporaryItems", "LOST.DIR", "found.000"}
)


def _is_noise_dir(name: str) -> bool:
    return name in _NOISE_DIRS or name.startswith("._")


def _is_noise_file(name: str) -> bool:
    return name.startswith("._") or name in (".DS_Store", "Thumbs.db", "desktop.ini")
