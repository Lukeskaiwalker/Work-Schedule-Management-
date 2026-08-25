#!/usr/bin/env python3
"""SMPL local print + inventory agent.

A single-process, stdlib-only HTTP server that sits next to the hardware:
a Brother PT-P710BT over USB and an HID barcode scanner that types into the
browser. It turns "scan -> identify -> count -> print" into four local calls
that together must stay under five seconds.

Design rules that the rest of this file exists to serve:

* **No framework.** ``http.server`` starts in milliseconds and cannot fail on
  a missing dependency. The only third-party code is pyusb + Pillow, and both
  are reached through sibling modules, not through this one.
* **The USB device is opened once** and held for the life of the process.
  Re-enumerating per label costs hundreds of milliseconds we do not have.
* **Printing is serialised, everything else is not.** ``/resolve`` and
  ``/count`` never wait behind a label that is physically feeding.
* **Counting never depends on the printer or the network.** Both are optional
  peripherals; the SQLite file is the product.

The same process is meant to be dropped onto a Raspberry Pi later as a LAN
print bridge, so nothing here is macOS-specific.
"""

from __future__ import annotations

import argparse
import csv
import importlib
import io
import json
import os
import re
import sqlite3
import sys
import queue
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "1.0.0"

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
DEFAULT_DB = Path.home() / ".smpl-label-agent" / "inventory.db"
DEFAULT_TAPE_MM = 12
DEFAULT_SESSION = "default"

# /resolve must answer inside the operator's patience, not the network's.
UPSTREAM_TIMEOUT_S = float(os.environ.get("SMPL_TIMEOUT", "1.5"))
# A cached article older than this is still served instantly, but revalidated
# in the background so the catalog does not drift forever.
CACHE_REVALIDATE_S = 3600.0
MAX_BODY_BYTES = 64 * 1024
PRINT_BUDGET_MS = 5000

SESSION_NAME_RE = re.compile(r"^[A-Za-z0-9._ -]{1,64}$")

if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))


# --------------------------------------------------------------------------
# Sibling modules (owned by other agents; imported, never edited)
# --------------------------------------------------------------------------

_MODULE_CACHE: dict[str, object] = {}
_MODULE_ERRORS: dict[str, str] = {}
_MODULE_LOCK = threading.Lock()


def module(name: str):
    """Import a sibling module lazily, retrying while it is still missing.

    The renderer and the raster driver live beside this file. Importing them
    at module scope would mean a half-written sibling takes the whole agent
    down, so the import is deferred and retried instead.
    """
    with _MODULE_LOCK:
        cached = _MODULE_CACHE.get(name)
        if cached is not None:
            return cached
        try:
            mod = importlib.import_module(name)
        except Exception as exc:  # noqa: BLE001 - any import failure degrades the same way
            _MODULE_ERRORS[name] = f"{type(exc).__name__}: {exc}"
            return None
        _MODULE_CACHE[name] = mod
        _MODULE_ERRORS.pop(name, None)
        return mod


def module_error(name: str) -> str:
    return _MODULE_ERRORS.get(name, f"module '{name}' is not available")


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------


def now_iso() -> str:
    """UTC, second precision, Z-suffixed - the shape SMPL's importer expects."""
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def ms_since(start: float) -> float:
    return round((time.perf_counter() - start) * 1000.0, 1)


class ApiError(Exception):
    """A request the client got wrong; carries the status code to answer with."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def require_str(payload: dict, key: str, *, max_len: int = 256, required: bool = True) -> str:
    value = payload.get(key)
    if value is None and not required:
        return ""
    if not isinstance(value, str):
        raise ApiError(400, f"'{key}' must be a string")
    value = value.strip()
    if required and not value:
        raise ApiError(400, f"'{key}' must not be empty")
    if len(value) > max_len:
        raise ApiError(400, f"'{key}' is longer than {max_len} characters")
    return value


def require_int(payload: dict, key: str, default: int, low: int, high: int) -> int:
    value = payload.get(key, default)
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ApiError(400, f"'{key}' must be a number")
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise ApiError(400, f"'{key}' must be a whole number") from None
    if parsed < low or parsed > high:
        raise ApiError(400, f"'{key}' must be between {low} and {high}")
    return parsed


def valid_session_name(name: str) -> str:
    name = name.strip()
    if not SESSION_NAME_RE.match(name):
        raise ApiError(400, "session name must be 1-64 chars of letters, digits, space, . _ -")
    return name


# --------------------------------------------------------------------------
# SQLite store
# --------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    name        TEXT PRIMARY KEY,
    started_at  TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS counts (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    session           TEXT NOT NULL,
    code              TEXT NOT NULL,
    item_name         TEXT,
    counted_qty       INTEGER NOT NULL DEFAULT 0,
    scan_count        INTEGER NOT NULL DEFAULT 0,
    first_counted_at  TEXT NOT NULL,
    last_counted_at   TEXT NOT NULL,
    UNIQUE(session, code)
);

CREATE INDEX IF NOT EXISTS idx_counts_session ON counts(session, last_counted_at DESC);

CREATE TABLE IF NOT EXISTS article_cache (
    code         TEXT PRIMARY KEY,
    item_name    TEXT NOT NULL,
    subtitle     TEXT,
    kind         TEXT,
    payload      TEXT,
    resolved_at  TEXT NOT NULL
);
"""

COUNT_COLUMNS = (
    "code",
    "item_name",
    "counted_qty",
    "scan_count",
    "first_counted_at",
    "last_counted_at",
)


class Store:
    """Thread-local SQLite connections over one WAL database file.

    The column names in ``counts`` are deliberately identical to SMPL's own
    ``werkstatt_inventory_counts`` so an export drops straight in.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._local = threading.local()
        with self._connect() as conn:
            conn.executescript(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.path), timeout=10.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    @property
    def conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = self._connect()
            self._local.conn = conn
        return conn

    # -- sessions ---------------------------------------------------------

    def ensure_session(self, name: str) -> None:
        with self.conn as conn:
            conn.execute(
                "INSERT OR IGNORE INTO sessions (name, started_at, status) VALUES (?, ?, 'open')",
                (name, now_iso()),
            )

    def session_meta(self, name: str) -> dict | None:
        row = self.conn.execute(
            "SELECT name, started_at, status FROM sessions WHERE name = ?", (name,)
        ).fetchone()
        return dict(row) if row else None

    def sessions(self) -> list[dict]:
        rows = self.conn.execute(
            "SELECT name, started_at, status FROM sessions ORDER BY started_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]

    # -- counts -----------------------------------------------------------

    def record_count(self, session: str, code: str, item_name: str, qty: int) -> dict:
        """Upsert one scan. A repeat code increments; it never inserts twice."""
        self.ensure_session(session)
        stamp = now_iso()
        with self.conn as conn:
            conn.execute(
                """
                INSERT INTO counts (session, code, item_name, counted_qty, scan_count,
                                    first_counted_at, last_counted_at)
                VALUES (?, ?, ?, ?, 1, ?, ?)
                ON CONFLICT(session, code) DO UPDATE SET
                    counted_qty     = counts.counted_qty + excluded.counted_qty,
                    scan_count      = counts.scan_count + 1,
                    item_name       = COALESCE(NULLIF(excluded.item_name, ''), counts.item_name),
                    last_counted_at = excluded.last_counted_at
                """,
                (session, code, item_name, qty, stamp, stamp),
            )
        row = self.conn.execute(
            "SELECT * FROM counts WHERE session = ? AND code = ?", (session, code)
        ).fetchone()
        return self._count_row(row)

    def counts(self, session: str) -> list[dict]:
        rows = self.conn.execute(
            "SELECT * FROM counts WHERE session = ? ORDER BY last_counted_at DESC, code ASC",
            (session,),
        ).fetchall()
        return [self._count_row(r) for r in rows]

    @staticmethod
    def _count_row(row: sqlite3.Row) -> dict:
        return {
            "code": row["code"],
            "item_name": row["item_name"] or "",
            "counted_qty": int(row["counted_qty"]),
            "scan_count": int(row["scan_count"]),
            "first_counted_at": row["first_counted_at"],
            "last_counted_at": row["last_counted_at"],
        }

    # -- article cache ----------------------------------------------------

    def cache_get(self, code: str) -> dict | None:
        row = self.conn.execute("SELECT * FROM article_cache WHERE code = ?", (code,)).fetchone()
        if row is None:
            return None
        return {
            "code": row["code"],
            "item_name": row["item_name"],
            "subtitle": row["subtitle"] or "",
            "kind": row["kind"] or "cached",
            "resolved_at": row["resolved_at"],
        }

    def cache_put(self, code: str, item_name: str, subtitle: str, kind: str, payload: dict) -> None:
        with self.conn as conn:
            conn.execute(
                """
                INSERT INTO article_cache (code, item_name, subtitle, kind, payload, resolved_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(code) DO UPDATE SET
                    item_name   = excluded.item_name,
                    subtitle    = excluded.subtitle,
                    kind        = excluded.kind,
                    payload     = excluded.payload,
                    resolved_at = excluded.resolved_at
                """,
                (code, item_name, subtitle, kind, json.dumps(payload)[:8000], now_iso()),
            )

    def cache_age_s(self, resolved_at: str) -> float:
        try:
            stamp = datetime.fromisoformat(resolved_at.replace("Z", "+00:00"))
        except ValueError:
            return float("inf")
        return (datetime.now(timezone.utc) - stamp).total_seconds()


# --------------------------------------------------------------------------
# SMPL upstream (entirely optional)
# --------------------------------------------------------------------------


class Upstream:
    """Thin client for SMPL's Datanorm-backed scan resolver.

    Every call is bounded by a short timeout and every failure is swallowed
    into ``None`` - the agent is required to work with no network at all.
    """

    def __init__(self, base_url: str, token: str, timeout: float = UPSTREAM_TIMEOUT_S) -> None:
        self.base_url = (base_url or "").rstrip("/")
        self.token = token or ""
        self.timeout = timeout
        self._last_ok: bool | None = None
        self._last_error = ""
        self._lock = threading.Lock()

    @property
    def configured(self) -> bool:
        return bool(self.base_url)

    @property
    def last_ok(self) -> bool | None:
        return self._last_ok

    @property
    def last_error(self) -> str:
        return self._last_error

    def _note(self, ok: bool, error: str = "") -> None:
        with self._lock:
            self._last_ok = ok
            self._last_error = error

    def _get(self, path: str, params: dict | None = None) -> dict:
        url = self.base_url + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        request = urllib.request.Request(url, method="GET")
        request.add_header("Accept", "application/json")
        request.add_header("User-Agent", f"smpl-label-agent/{VERSION}")
        if self.token:
            request.add_header("Authorization", f"Bearer {self.token}")
        with urllib.request.urlopen(request, timeout=self.timeout) as response:  # noqa: S310
            raw = response.read(512 * 1024)
        return json.loads(raw.decode("utf-8"))

    def resolve(self, code: str) -> dict | None:
        """Return the parsed upstream answer, or None on any failure."""
        if not self.configured:
            return None
        try:
            payload = self._get("/api/werkstatt/scan/resolve", {"code": code})
        except urllib.error.HTTPError as exc:
            # 404 is a real answer ("unknown code"), not an outage.
            self._note(exc.code < 500, f"HTTP {exc.code}")
            return None
        except Exception as exc:  # noqa: BLE001 - timeouts, DNS, TLS, bad JSON
            self._note(False, f"{type(exc).__name__}: {exc}")
            return None
        self._note(True)
        if not isinstance(payload, dict):
            return None
        return payload

    def probe(self) -> bool | None:
        """Cheap reachability check used by /health; never raises."""
        if not self.configured:
            return None
        try:
            self._get("/api/health")
        except urllib.error.HTTPError as exc:
            ok = exc.code not in (401, 403) and exc.code < 500
            self._note(ok, "" if ok else f"HTTP {exc.code}")
            return ok
        except Exception as exc:  # noqa: BLE001
            self._note(False, f"{type(exc).__name__}: {exc}")
            return False
        self._note(True)
        return True


def parse_resolution(payload: dict) -> tuple[str, str, str]:
    """Flatten SMPL's ScanResolveResult union into (item_name, subtitle, kind).

    The union is documented in ``apps/api/app/schemas/werkstatt.py``; every
    member that names something carries the name in ``item_name``.
    """
    kind = str(payload.get("kind") or "unknown")
    if kind == "werkstatt_article":
        article = payload.get("article") or {}
        return (
            str(article.get("item_name") or ""),
            str(article.get("article_number") or article.get("manufacturer") or ""),
            kind,
        )
    if kind == "catalog_match":
        items = payload.get("catalog_items") or []
        first = items[0] if items and isinstance(items[0], dict) else {}
        return (
            str(first.get("item_name") or ""),
            str(first.get("article_no") or first.get("manufacturer") or ""),
            kind,
        )
    if kind == "machine":
        machine = payload.get("machine") or {}
        article = machine.get("article") or {}
        name = str(article.get("item_name") or machine.get("item_name") or "")
        return name, str(machine.get("machine_number") or machine.get("serial_number") or ""), kind
    if kind == "not_found":
        return "", "", kind
    # Unknown shape: take any item_name we can see rather than failing.
    return str(payload.get("item_name") or payload.get("name") or ""), "", kind


# --------------------------------------------------------------------------
# Printer
# --------------------------------------------------------------------------


class Printer:
    """Owns the one USB handle and the one lock that serialises printing.

    Opened once, held open. ``status()`` refuses to block behind an in-flight
    label so ``/health`` stays instant while a label is feeding, and any USB
    failure drops the handle so the next call transparently reconnects.
    """

    STATUS_TTL_S = 2.0

    def __init__(self, *, enabled: bool = True, default_tape_mm: int = DEFAULT_TAPE_MM) -> None:
        self.enabled = enabled
        self.default_tape_mm = default_tape_mm
        self._lock = threading.Lock()
        self._device = None
        self._error = "" if enabled else "printing disabled (--no-printer)"
        self._status: dict = {
            "printer_connected": False,
            "media_width_mm": default_tape_mm if not enabled else None,
            "media_type": None,
            "error": self._error,
            "simulated": not enabled,
        }
        self._status_at = 0.0

    # -- connection -------------------------------------------------------

    def _open_locked(self) -> bool:
        """Open the device if it is not already open. Caller holds the lock."""
        if self._device is not None:
            return True
        mod = module("brother_raster")
        if mod is None:
            self._error = module_error("brother_raster")
            return False
        try:
            if hasattr(mod, "find_printer") and not mod.find_printer():
                self._error = "printer not found on USB (PT-P710BT unplugged or powered off?)"
                return False
            device = mod.BrotherPTouch()
            device.__enter__()
        except Exception as exc:  # noqa: BLE001 - PrinterError, USBError, permissions
            self._device = None
            self._error = f"{type(exc).__name__}: {exc}"
            return False
        self._device = device
        self._error = ""
        return True

    def _drop_locked(self, error: str) -> None:
        device, self._device = self._device, None
        self._error = error
        if device is not None:
            try:
                device.__exit__(None, None, None)
            except Exception:  # noqa: BLE001 - the handle is already gone
                pass

    def close(self) -> None:
        with self._lock:
            self._drop_locked("closed")

    # -- status -----------------------------------------------------------

    def status(self, *, force: bool = False) -> dict:
        """Cached status. Never waits on the print lock - health must be instant."""
        if not self.enabled:
            return dict(self._status)
        fresh = (time.perf_counter() - self._status_at) < self.STATUS_TTL_S
        if fresh and not force:
            return dict(self._status)
        if not self._lock.acquire(timeout=0.4):
            stale = dict(self._status)
            stale["busy"] = True
            return stale
        try:
            self._status = self._read_status_locked()
            self._status_at = time.perf_counter()
            return dict(self._status)
        finally:
            self._lock.release()

    def _read_status_locked(self) -> dict:
        if not self._open_locked():
            return {
                "printer_connected": False,
                "media_width_mm": None,
                "media_type": None,
                "error": self._error,
                "simulated": False,
            }
        try:
            status = self._device.status()
        except Exception as exc:  # noqa: BLE001 - unplugged mid-session lands here
            self._drop_locked(f"{type(exc).__name__}: {exc}")
            return {
                "printer_connected": False,
                "media_width_mm": None,
                "media_type": None,
                "error": self._error,
                "simulated": False,
            }
        return {
            "printer_connected": True,
            "media_width_mm": getattr(status, "media_width_mm", None),
            "media_type": getattr(status, "media_type", None),
            "error": getattr(status, "error", None),
            "simulated": False,
        }

    def _init_queue(self) -> None:
        # Created lazily so this works regardless of where __init__ lives.
        if not hasattr(self, "_queue"):
            self._queue = queue.Queue()
            self._worker = None
            self._worker_lock = threading.Lock()
            self._last_print_error = None

    def queue_depth(self) -> int:
        self._init_queue()
        return self._queue.qsize()

    def tape_mm(self) -> int:
        width = self.status().get("media_width_mm")
        return int(width) if isinstance(width, int) and width > 0 else self.default_tape_mm

    # -- printing ---------------------------------------------------------

    def submit_lines(self, lines: list) -> dict:
        """Queue a label and return immediately.

        Measured on the real PT-P710BT, one 40 mm label takes ~7.9 s wall:
        ~6 ms to render, ~5 ms to push over USB, and the rest is tape feed and
        the cutter. That is physics, not overhead -- and the spec forbids
        sending anything at all between the print data and the completion
        report, so it cannot be pipelined on the device either.

        But the operator's budget is scan -> ready-for-the-next-scan, not
        scan -> tape-emerges. Making them stand and watch the cutter is a
        self-inflicted 8-second stall on work that is already repetitive.
        So the job is queued and the caller returns in milliseconds while a
        single worker drains the queue in order. Labels are the minority case
        anyway -- anything with a printed EAN never needs one.
        """

        self._init_queue()
        if not self.enabled:
            return {"ok": True, "simulated": True, "queued": True, "queue_depth": 0}
        self._ensure_worker()
        self._queue.put(lines)
        return {
            "ok": True,
            "simulated": False,
            "queued": True,
            "raster_lines": len(lines),
            "queue_depth": self._queue.qsize(),
        }

    def _ensure_worker(self) -> None:
        self._init_queue()
        with self._worker_lock:
            if self._worker is not None and self._worker.is_alive():
                return
            self._worker = threading.Thread(
                target=self._drain_queue, name="label-print-worker", daemon=True
            )
            self._worker.start()

    def _drain_queue(self) -> None:
        while True:
            lines = self._queue.get()
            try:
                self.print_lines(lines)
            except Exception as exc:  # noqa: BLE001 - a bad job must not kill the worker
                self._last_print_error = f"{type(exc).__name__}: {exc}"
            finally:
                self._queue.task_done()

    def print_lines(self, lines: list) -> dict:
        """Serialised print, blocking until the printer confirms completion."""
        if not self.enabled:
            time.sleep(0.01)  # stand in for the feed so timings stay realistic
            return {"ok": True, "simulated": True, "raster_lines": len(lines), "ms_print": 10.0}
        started = time.perf_counter()
        with self._lock:
            if not self._open_locked():
                raise ApiError(503, self._error or "printer unavailable")
            try:
                self._device.print_raster(lines)
            except Exception as exc:  # noqa: BLE001
                message = f"{type(exc).__name__}: {exc}"
                self._drop_locked(message)
                raise ApiError(503, f"print failed: {message}") from exc
            self._status_at = 0.0  # media may have changed while we held the lock
        return {
            "ok": True,
            "simulated": False,
            "raster_lines": len(lines),
            "ms_print": ms_since(started),
        }


# --------------------------------------------------------------------------
# Application
# --------------------------------------------------------------------------


class Agent:
    """Everything the request handlers need, assembled once at startup."""

    def __init__(self, store: Store, printer: Printer, upstream: Upstream) -> None:
        self.store = store
        self.printer = printer
        self.upstream = upstream
        self._stop = threading.Event()
        self._probe_thread: threading.Thread | None = None

    def start_background(self) -> None:
        if not self.upstream.configured:
            return
        self._probe_thread = threading.Thread(
            target=self._probe_loop, name="upstream-probe", daemon=True
        )
        self._probe_thread.start()

    def _probe_loop(self) -> None:
        while not self._stop.is_set():
            self.upstream.probe()
            self._stop.wait(30.0)

    def shutdown(self) -> None:
        self._stop.set()
        self.printer.close()

    # -- endpoints --------------------------------------------------------

    def health(self) -> dict:
        status = self.printer.status()
        return {
            "ok": True,
            "version": VERSION,
            "printer_connected": bool(status.get("printer_connected")),
            "media_width_mm": status.get("media_width_mm"),
            "error": status.get("error") or None,
            "upstream_ok": self.upstream.last_ok if self.upstream.configured else None,
            "upstream_configured": self.upstream.configured,
            "upstream_error": self.upstream.last_error or None,
            "simulated": bool(status.get("simulated")),
            "db": str(self.store.path),
            "modules": {
                "brother_raster": module("brother_raster") is not None,
                "label_render": module("label_render") is not None,
            },
        }

    def resolve(self, code: str) -> dict:
        """Identify a scanned code in well under two seconds, network or not.

        A cached code answers from SQLite immediately (that is the whole point
        of the cache) and is revalidated in the background when stale. An
        uncached code tries SMPL once, briefly, then gives up gracefully.
        """
        started = time.perf_counter()
        cached = self.store.cache_get(code)
        if cached is not None:
            if self.upstream.configured and self.store.cache_age_s(cached["resolved_at"]) > CACHE_REVALIDATE_S:
                threading.Thread(
                    target=self._refresh_cache, args=(code,), daemon=True
                ).start()
            return self._resolution(code, cached["item_name"], cached["subtitle"], cached["kind"],
                                    source="cache", started=started)
        payload = self.upstream.resolve(code) if self.upstream.configured else None
        if payload is not None:
            item_name, subtitle, kind = parse_resolution(payload)
            if item_name:
                self.store.cache_put(code, item_name, subtitle, kind, payload)
                return self._resolution(code, item_name, subtitle, kind,
                                        source="smpl", started=started)
            return self._resolution(code, "", "", kind, source="smpl", started=started)
        source = "offline" if self.upstream.configured else "local"
        return self._resolution(code, "", "", "not_found", source=source, started=started)

    def _refresh_cache(self, code: str) -> None:
        payload = self.upstream.resolve(code)
        if payload is None:
            return
        item_name, subtitle, kind = parse_resolution(payload)
        if item_name:
            self.store.cache_put(code, item_name, subtitle, kind, payload)

    @staticmethod
    def _resolution(code: str, item_name: str, subtitle: str, kind: str, *,
                    source: str, started: float) -> dict:
        return {
            "code": code,
            "found": bool(item_name),
            "item_name": item_name,
            "article_name": item_name,  # alias: /count speaks 'article_name'
            "title": item_name or code,
            "subtitle": subtitle or ("" if item_name else "unbekannter Code"),
            "kind": kind,
            "source": source,
            "ms": ms_since(started),
        }

    def count(self, session: str, code: str, article_name: str, qty: int) -> dict:
        started = time.perf_counter()
        if not article_name:
            cached = self.store.cache_get(code)
            article_name = cached["item_name"] if cached else ""
        row = self.store.record_count(session, code, article_name, qty)
        row["session"] = session
        row["ms"] = ms_since(started)
        return row

    def print_label(self, code: str, title: str, subtitle: str) -> dict:
        started = time.perf_counter()
        render = module("label_render")
        if render is None:
            raise ApiError(503, module_error("label_render"))
        spec = render.LabelSpec(
            code=code, title=title or code, subtitle=subtitle or None,
            tape_mm=self.printer.tape_mm(),
        )
        render_started = time.perf_counter()
        try:
            lines = render.render_raster(spec)
        except Exception as exc:  # noqa: BLE001 - a bad spec must not kill the server
            raise ApiError(500, f"render failed: {type(exc).__name__}: {exc}") from exc
        ms_render = ms_since(render_started)
        result = self.printer.submit_lines(lines)
        ms_total = ms_since(started)
        return {
            "ok": True,
            "code": code,
            "title": spec.title,
            "subtitle": spec.subtitle,
            "tape_mm": spec.tape_mm,
            "simulated": result.get("simulated", False),
            "raster_lines": result.get("raster_lines", 0),
            "ms_render": ms_render,
            "queued": result.get("queued", False),
            "queue_depth": result.get("queue_depth", 0),
            "ms_print": result.get("ms_print", 0.0),
            "ms_total": ms_total,
            "budget_ms": PRINT_BUDGET_MS,
            "within_budget": ms_total <= PRINT_BUDGET_MS,
        }

    def preview_png(self, code: str, title: str, subtitle: str, tape_mm: int) -> bytes:
        render = module("label_render")
        if render is None:
            raise ApiError(503, module_error("label_render"))
        spec = render.LabelSpec(
            code=code, title=title or code, subtitle=subtitle or None, tape_mm=tape_mm,
        )
        try:
            return render.render_png(spec)
        except Exception as exc:  # noqa: BLE001
            raise ApiError(500, f"preview failed: {type(exc).__name__}: {exc}") from exc

    def session_view(self, name: str) -> dict:
        rows = self.store.counts(name)
        meta = self.store.session_meta(name) or {"name": name, "started_at": None, "status": "new"}
        return {
            "session": name,
            "started_at": meta.get("started_at"),
            "status": meta.get("status"),
            "articles": len(rows),
            "total_qty": sum(r["counted_qty"] for r in rows),
            "total_scans": sum(r["scan_count"] for r in rows),
            "counts": rows,
        }

    def export_json(self, name: str) -> bytes:
        view = self.session_view(name)
        document = {
            "source": "smpl-label-agent",
            "version": VERSION,
            "session": name,
            "started_at": view["started_at"],
            "status": view["status"],
            "exported_at": now_iso(),
            "counts": view["counts"],
        }
        return json.dumps(document, ensure_ascii=False, indent=2).encode("utf-8")

    def export_csv(self, name: str) -> bytes:
        buffer = io.StringIO()
        writer = csv.DictWriter(buffer, fieldnames=list(COUNT_COLUMNS), extrasaction="ignore")
        writer.writeheader()
        for row in self.store.counts(name):
            writer.writerow(row)
        return buffer.getvalue().encode("utf-8-sig")  # BOM so Excel reads UTF-8


# --------------------------------------------------------------------------
# HTTP layer
# --------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    server_version = f"SMPLLabelAgent/{VERSION}"
    protocol_version = "HTTP/1.1"

    @property
    def agent(self) -> Agent:
        return self.server.agent  # type: ignore[attr-defined]

    # -- plumbing ---------------------------------------------------------

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003 - base class name
        sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def _send(self, status: int, ctype: str, body: bytes, headers: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(status, "application/json; charset=utf-8", body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY_BYTES:
            raise ApiError(413, "request body too large")
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError(400, f"invalid JSON body: {exc}") from exc
        if not isinstance(payload, dict):
            raise ApiError(400, "request body must be a JSON object")
        return payload

    def _dispatch(self, table: dict, path: str, query: dict) -> None:
        handler = table.get(path)
        if handler is not None:
            handler(query)
            return
        if self.command in ("GET", "HEAD") and self._dispatch_dynamic(path):
            return
        self._json(404, {"ok": False, "error": f"no route for {self.command} {path}"})

    def handle_one_request(self) -> None:  # noqa: D102 - wraps the base for error safety
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _guard(self, fn) -> None:
        try:
            fn()
        except ApiError as exc:
            self._json(exc.status, {"ok": False, "error": exc.message})
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception as exc:  # noqa: BLE001 - one bad request must not kill the agent
            self.log_message("unhandled error: %s: %s", type(exc).__name__, exc)
            try:
                self._json(500, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})
            except Exception:  # noqa: BLE001
                self.close_connection = True

    # -- verbs ------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 - base class name
        parsed = urllib.parse.urlparse(self.path)
        query = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
        table = {
            "/": self._get_index,
            "/index.html": self._get_index,
            "/health": lambda q: self._json(200, self.agent.health()),
            "/preview.png": self._get_preview,
            "/sessions": lambda q: self._json(200, {"sessions": self.agent.store.sessions()}),
        }
        self._guard(lambda: self._dispatch(table, parsed.path, query))

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        table = {
            "/resolve": lambda q: self._post_resolve(),
            "/count": lambda q: self._post_count(),
            "/print": lambda q: self._post_print(),
        }
        self._guard(lambda: self._dispatch(table, parsed.path, {}))

    # -- GET handlers -----------------------------------------------------

    def _get_index(self, _query: dict) -> None:
        page = STATIC_DIR / "station.html"
        if not page.is_file():
            self._send(
                503,
                "text/plain; charset=utf-8",
                (
                    "static/station.html is missing.\n"
                    "The API is up - try /health, /resolve, /count, /print.\n"
                ).encode("utf-8"),
            )
            return
        self._send(200, "text/html; charset=utf-8", page.read_bytes())

    def _get_preview(self, query: dict) -> None:
        code = (query.get("code") or "").strip()
        if not code:
            raise ApiError(400, "'code' query parameter is required")
        tape = query.get("tape") or query.get("tape_mm") or ""
        try:
            tape_mm = int(tape) if tape else self.agent.printer.tape_mm()
        except ValueError:
            raise ApiError(400, "'tape' must be a number") from None
        png = self.agent.preview_png(
            code, (query.get("title") or "").strip(), (query.get("subtitle") or "").strip(), tape_mm
        )
        self._send(200, "image/png", png)

    def _dispatch_dynamic(self, path: str) -> bool:
        """Routes with a name embedded in the path: /session/x, /export/x.csv."""
        if path.startswith("/session/"):
            name = valid_session_name(urllib.parse.unquote(path[len("/session/"):]))
            self._json(200, self.agent.session_view(name))
            return True
        if path.startswith("/export/"):
            tail = urllib.parse.unquote(path[len("/export/"):])
            for suffix, ctype, render in (
                (".json", "application/json; charset=utf-8", self.agent.export_json),
                (".csv", "text/csv; charset=utf-8", self.agent.export_csv),
            ):
                if tail.endswith(suffix):
                    name = valid_session_name(tail[: -len(suffix)])
                    filename = f"inventur-{name.replace(' ', '_')}{suffix}"
                    self._send(200, ctype, render(name),
                               {"Content-Disposition": f'attachment; filename="{filename}"'})
                    return True
            raise ApiError(400, "export must end in .json or .csv")
        if path.startswith("/static/"):
            return self._serve_static(path[len("/static/"):])
        return False

    def _serve_static(self, relative: str) -> bool:
        target = (STATIC_DIR / urllib.parse.unquote(relative)).resolve()
        try:
            target.relative_to(STATIC_DIR.resolve())
        except ValueError:
            raise ApiError(403, "path outside static directory") from None
        if not target.is_file():
            return False
        types = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
                 ".js": "text/javascript; charset=utf-8", ".png": "image/png",
                 ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8"}
        self._send(200, types.get(target.suffix, "application/octet-stream"), target.read_bytes())
        return True

    # -- POST handlers ----------------------------------------------------

    def _post_resolve(self) -> None:
        payload = self._read_json()
        code = require_str(payload, "code", max_len=128)
        self._json(200, self.agent.resolve(code))

    def _post_count(self) -> None:
        payload = self._read_json()
        session = valid_session_name(
            require_str(payload, "session", max_len=64, required=False) or DEFAULT_SESSION
        )
        code = require_str(payload, "code", max_len=128)
        article_name = require_str(payload, "article_name", max_len=256, required=False)
        qty = require_int(payload, "qty", 1, -10000, 10000)
        self._json(200, self.agent.count(session, code, article_name, qty))

    def _post_print(self) -> None:
        payload = self._read_json()
        code = require_str(payload, "code", max_len=128)
        title = require_str(payload, "title", max_len=256, required=False)
        subtitle = require_str(payload, "subtitle", max_len=256, required=False)
        self._json(200, self.agent.print_label(code, title, subtitle))


class Server(ThreadingHTTPServer):
    """Threaded so a feeding label never blocks the next scan lookup."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, agent: Agent) -> None:
        self.agent = agent
        super().__init__(address, handler)


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="smpl-label-agent",
        description="Local print + inventory agent for the Brother PT-P710BT.",
    )
    parser.add_argument("--host", default=os.environ.get("AGENT_HOST", DEFAULT_HOST),
                        help="bind address (use 0.0.0.0 to serve a LAN, e.g. on a Pi)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("AGENT_PORT", DEFAULT_PORT)))
    parser.add_argument("--db", default=os.environ.get("AGENT_DB", str(DEFAULT_DB)),
                        help=f"SQLite file (default {DEFAULT_DB})")
    parser.add_argument("--tape", type=int, default=int(os.environ.get("LABEL_TAPE_MM", DEFAULT_TAPE_MM)),
                        help="fallback tape width in mm when the printer cannot be asked")
    parser.add_argument("--no-printer", action="store_true",
                        help="run without hardware: prints are simulated, everything else is real")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    store = Store(Path(args.db).expanduser())
    printer = Printer(enabled=not args.no_printer, default_tape_mm=args.tape)
    upstream = Upstream(os.environ.get("SMPL_API_URL", ""), os.environ.get("SMPL_API_TOKEN", ""))
    agent = Agent(store, printer, upstream)
    agent.start_background()

    if not args.no_printer:
        # Warm the USB handle at startup so the first label is not the one
        # that pays for enumeration.
        threading.Thread(target=printer.status, kwargs={"force": True}, daemon=True).start()

    server = Server((args.host, args.port), Handler, agent)
    shown_host = "127.0.0.1" if args.host in ("0.0.0.0", "::") else args.host
    url = f"http://{shown_host}:{args.port}/"
    print(f"smpl-label-agent {VERSION}")
    print(f"  station : {url}")
    print(f"  database: {store.path}")
    print(f"  printer : {'simulated (--no-printer)' if args.no_printer else 'USB PT-P710BT'}")
    print(f"  upstream: {upstream.base_url or 'not configured (offline mode)'}")
    sys.stdout.flush()
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        print("\nstopping...")
    finally:
        server.shutdown()
        server.server_close()
        agent.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
