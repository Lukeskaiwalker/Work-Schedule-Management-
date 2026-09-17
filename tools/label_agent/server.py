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
import hashlib
import hmac
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
# Everything the agent owns lives in one directory so a Pi install has a single
# thing to back up, chown and wipe. See agent_paths for the rest of it.
DEFAULT_STATE_DIR = Path(os.environ.get("AGENT_STATE_DIR", "~/.smpl-label-agent")).expanduser()
DEFAULT_DB = DEFAULT_STATE_DIR / "inventory.db"
DEFAULT_TAPE_MM = 12
DEFAULT_SESSION = "default"

# /resolve must answer inside the operator's patience, not the network's.
UPSTREAM_TIMEOUT_S = float(os.environ.get("SMPL_TIMEOUT", "1.5"))
# The two upstream paths this module speaks, spelled once. Both are the
# *station* side of the API: this agent carries a station bearer, and the user
# routes answer one with 403.
RESOLVE_PATH = "/api/station/werkstatt/resolve"
# The API's only health route. There is no /api/health.
HEALTH_PATH = "/api/healthz"
# A cached article older than this is still served instantly, but revalidated
# in the background so the catalog does not drift forever.
CACHE_REVALIDATE_S = 3600.0
MAX_BODY_BYTES = 64 * 1024
PRINT_BUDGET_MS = 5000

# What the Pi's own printer is, for SMPL's hardware row. One model, one
# constant: the raster protocol has no "what are you" command to ask.
PRINTER_MODEL = "Brother PT-P710BT"
# SMPL's proof on POST /restart: the sha256 of the station token, which SMPL
# stores as the token's hash and only this Pi can compute from the token it
# holds. See Handler._post_restart.
RESTART_PROOF_HEADER = "X-SMPL-Station-Proof"
RESTART_DELAY_S = 0.5

SCREEN_RACK = "regal"
SCREEN_BOXES = "kisten"
SCREENS = (SCREEN_RACK, SCREEN_BOXES)

# Which screen each /screen/action belongs to. "dismiss" and "qty" are absent
# because they genuinely belong to both: dismiss clears the calling screen's
# own flash, and a quantity is shown on both. Everything else is one screen's
# buttons, and a request from the other one is a bug in a page, not a tap.
ACTION_SCREEN = {
    "direction": SCREEN_RACK,
    "assignee": SCREEN_RACK,
    "mode": SCREEN_BOXES,
    "close_session": SCREEN_BOXES,
}

# The screens render state; they never accumulate events. So every poll
# answers with a whole snapshot and a sequence number, and a screen that was
# unplugged for an hour is correct one request after it comes back.
SCREEN_POLL_MAX_S = 25.0
KIOSK_TICK_S = 1.0
BOX_REFRESH_S = 10.0

# /barcode.svg, the box screen's only input device.
#
# That screen has no mouse and no keyboard - the keyboard is bolted to the
# rack screen on the other wall - so the way back to the overview is a Code
# 128 of SMPL-CMD-FERTIG drawn on the glass, which the worker scans off the
# screen with the handheld. The codes never change, so the answer is cacheable
# for a day; 48 characters is well past the longest thing the vocabulary or a
# crate id will ever hold, and short enough that no request can ask the agent
# to draw a metre of bars.
BARCODE_MAX_CHARS = 48
BARCODE_DEFAULT_H = 120
# Under 40px tall a handheld struggles to find the symbol at arm's length;
# over 400 it is taller than the panel and only wastes bytes.
BARCODE_MIN_H = 40
BARCODE_MAX_H = 400
#: Width of one barcode module ("X dimension") in CSS pixels. The page asks
#: for this: a code is only scannable if its narrowest bar is wide enough on
#: the glass, and only fits on the wall if it is not wider than it needs to
#: be. On the 4K box panel one CSS pixel is two device pixels, about 0.32 mm,
#: so m=2 gives a 0.65 mm bar - comfortable for the imager on the bench and
#: still narrow enough for three codes side by side.
BARCODE_DEFAULT_M = 3
BARCODE_MIN_M = 1
BARCODE_MAX_M = 6
BARCODE_MAX_AGE_S = 86400
# The crew changes when somebody is hired, not while a crate is packed.
CREW_REFRESH_S = 60.0
SESSION_IDLE_S = float(os.environ.get("STATION_SESSION_IDLE_S", "600"))
# Which keyboard layout the barcode scanner is configured for. The office
# scanner sends German scancodes — measured off /dev/input, see the module
# docstring of input_reader — so "de" is the default and "us" is available for
# a replacement device. A typo here is the default, never a dead scanner.
SCANNER_LAYOUT = os.environ.get("SCANNER_LAYOUT", "de")
# The safety net under that setting. Which of Y and Z a German keycode table
# produces is the one half of it that was *inferred* from the layout files
# rather than measured off the wire, and it is the expensive half: the code
# alphabet (apps/api/.../werkstatt_internal_codes.py) contains both letters,
# so a wrong table turns a real article into "SMPL does not know this code"
# with nothing on any screen that says why.
_YZ_SWAP = str.maketrans("YZyz", "ZYzy")

# The kiosk is loopback-only, in both directions and under every verb.
#
# The two screens are Chromium windows running ON this Pi, so nothing here
# ever needs to cross the LAN. Reads are in the set as well as writes: /kisten
# and /screen/state hand out the whole crate list — customer, project, every
# packed item — and /screen/state is a 25-second long poll on a threaded
# server, which is a thread-exhaustion lever against the two screens as much
# as it is a leak. Pairing is in the set because /pair/forget deletes the
# station credential from disk, and a route that unpairs a Pi from the far
# side of the workshop LAN is not a route, it is a prank.
#
# What deliberately stays LAN-reachable, and why: /health (monitoring),
# /static/ and /setup (the setup page a phone opens), and the phone-driven
# /print and /count the README documents --host 0.0.0.0 for. Quietly breaking
# those would be a worse surprise than the lock is a win.
LOOPBACK_ONLY = frozenset((
    # writes
    "/scan/route", "/box/session", "/box/item", "/box/item/remove",
    "/rack/movement", "/screen/action",
    "/pair/start", "/pair/cancel", "/pair/forget",
    # kiosk reads
    "/regal", "/kisten", "/screen/state", "/boxes/state",
    "/now-playing", "/now-playing/cover.jpg",
    # /barcode.svg is drawn *for* the crate screen and embedded by it, so it
    # belongs on the same footing as the page that embeds it. Nothing outside
    # this Pi has a reason to ask the agent to draw a command code, and a
    # command barcode reachable from the LAN is a command barcode somebody can
    # print out and carry to the wrong screen.
    "/barcode.svg",
))

# One word per direction, everywhere: the screens, the flashes and
# docs/PI_STATION.md all say Ausgabe. "Entnahme" is the crate's take-back-out
# mode (SMPL-CMD-ENTNAHME) and nothing else — a rack booking that takes stock
# out is an Ausgabe, and a direction called two things is a direction somebody
# gets wrong reading a log next to a wall.
DIRECTION_LABEL = {"aus": "Ausgabe", "ein": "Rückgabe", "wareneingang": "Wareneingang"}

# What a machine scan at the rack is, in the screen's own words: kiosk_rack.html
# shows "Nicht gebucht — Maschine nur nachgeschlagen" beside the tool whenever
# the state carries no movement, and the flash must not contradict it.
MSG_MACHINE_LOOKUP_ONLY = "Maschine nur nachgeschlagen"
MSG_MACHINE_NOT_BOOKED = (
    "Nichts gebucht — Ausgabe und Rückgabe dieser Maschine werden in SMPL gebucht."
)


def is_loopback(address: str) -> bool:
    """True for this machine talking to itself, in every spelling of it."""
    text = (address or "").strip()
    if text.startswith("::ffff:"):
        text = text[len("::ffff:"):]
    if text in ("::1", "localhost"):
        return True
    parts = text.split(".")
    if len(parts) != 4:
        return False
    try:
        octets = [int(part) for part in parts]
    except ValueError:
        return False
    return octets[0] == 127 and all(0 <= octet <= 255 for octet in octets)

SESSION_NAME_RE = re.compile(r"^[A-Za-z0-9._ -]{1,64}$")
# Import ids are minted by the agent as "<UTC timestamp>-<6 hex>"; constraining
# the route to that shape keeps a path component from ever reaching the disk.
IMPORT_ID_RE = re.compile(r"^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$")

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


def _exit_for_restart() -> None:
    """``os._exit``, not ``sys.exit``: nothing on a request thread may catch
    it, and systemd — not this process — is what brings the agent back."""
    os._exit(0)


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
        """Every session with its totals, in one query.

        SMPL's Scan-Station page lists these to decide what to import, and a
        row that is only a name cannot say whether a session is worth
        importing. LEFT JOIN so a session that was opened and never counted
        into still appears — with zeros, which is the truthful figure.
        """
        rows = self.conn.execute(
            "SELECT s.name, s.started_at, s.status, "
            "COUNT(c.id) AS articles, "
            "COALESCE(SUM(c.counted_qty), 0) AS total_qty, "
            "COALESCE(SUM(c.scan_count), 0) AS total_scans, "
            "MAX(c.last_counted_at) AS last_counted_at "
            "FROM sessions s LEFT JOIN counts c ON c.session = s.name "
            "GROUP BY s.name, s.started_at, s.status "
            "ORDER BY s.started_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]

    def session_count(self) -> int:
        row = self.conn.execute("SELECT COUNT(*) FROM sessions").fetchone()
        return int(row[0]) if row else 0

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
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session, code) DO UPDATE SET
                    counted_qty     = counts.counted_qty + excluded.counted_qty,
                    -- Only a real scan advances scan_count. An undo (qty < 0)
                    -- and a name backfill (qty == 0) both come through here,
                    -- and counting them would make undoing a scan RAISE the
                    -- scan count. counted_qty is the quantity; scan_count is
                    -- the evidence of how it was arrived at, and the two must
                    -- not drift or "scanned 47 times or typed 47?" stops being
                    -- answerable — which is the whole reason both are stored.
                    scan_count      = counts.scan_count + (CASE WHEN excluded.counted_qty > 0 THEN 1 ELSE 0 END),
                    item_name       = COALESCE(NULLIF(excluded.item_name, ''), counts.item_name),
                    last_counted_at = excluded.last_counted_at
                """,
                (session, code, item_name, qty, 1 if qty > 0 else 0, stamp, stamp),
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

    def __init__(self, base_url: str, token: str = "", timeout: float = UPSTREAM_TIMEOUT_S,
                 token_provider=None) -> None:
        self.base_url = (base_url or "").rstrip("/")
        self.token = token or ""
        # A paired station's token can be revoked centrally and re-issued
        # without restarting the agent, so the token is asked for per request
        # rather than captured once at construction.
        self._token_provider = token_provider
        self.timeout = timeout
        self._last_ok: bool | None = None
        self._last_error = ""
        self._lock = threading.Lock()

    @property
    def configured(self) -> bool:
        return bool(self.base_url)

    def bearer(self) -> str:
        if self._token_provider is not None:
            try:
                token = self._token_provider()
            except Exception:  # noqa: BLE001 - a broken provider must not stop a scan
                token = ""
            if token:
                return token
        return self.token

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
        if ok:
            station = getattr(self, "station", None)
            if station is not None:
                station.note_success()

    def _note_auth(self, status: int) -> None:
        """Tell the station that its credentials were refused, or accepted.

        A 401 from SMPL is the one upstream failure a person can actually fix,
        and the fix ("re-pair the station") is not guessable from "HTTP 401",
        so it is worth carrying all the way to /health.

        A **403 is not that failure**. It means the token is genuine and the
        route is not for it — a user-only endpoint, a scope this station does
        not have — and telling the operator to re-pair a perfectly valid
        station sends them to the Pi with a phone for nothing.
        """
        station = getattr(self, "station", None)
        if station is None:
            return
        if status == 401:
            station.note_rejection(status)
        elif status < 400:
            station.note_success()

    def _get(self, path: str, params: dict | None = None) -> dict:
        url = self.base_url + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        request = urllib.request.Request(url, method="GET")
        request.add_header("Accept", "application/json")
        request.add_header("User-Agent", f"smpl-label-agent/{VERSION}")
        bearer = self.bearer()
        if bearer:
            request.add_header("Authorization", f"Bearer {bearer}")
        with urllib.request.urlopen(request, timeout=self.timeout) as response:  # noqa: S310
            raw = response.read(512 * 1024)
        return json.loads(raw.decode("utf-8"))

    def resolve(self, code: str) -> dict | None:
        """Return the parsed upstream answer, or None on any failure.

        The *station* resolver, not the user one: this agent carries a station
        bearer, and ``/api/werkstatt/scan/resolve`` answers a station token
        with 403 — which used to be reported as "re-pair me".
        """
        if not self.configured:
            return None
        try:
            payload = self._get(RESOLVE_PATH, {"code": code})
        except urllib.error.HTTPError as exc:
            # 404 is a real answer ("unknown code"), not an outage.
            self._note(exc.code < 500, f"HTTP {exc.code}")
            self._note_auth(exc.code)
            return None
        except Exception as exc:  # noqa: BLE001 - timeouts, DNS, TLS, bad JSON
            self._note(False, f"{type(exc).__name__}: {exc}")
            return None
        self._note(True)
        if not isinstance(payload, dict):
            return None
        return payload

    def probe(self) -> bool | None:
        """Cheap reachability check used by /health; never raises.

        ``/api/healthz`` is the only health route the API has (see
        ``apps/api/app/routers/workflow_system.py``), and a **404 counts as
        down**: on the health path it means the base URL is wrong, which is
        exactly the outage this probe exists to catch. Scoring it green is how
        a station points at nothing at all and says so in green.
        """
        if not self.configured:
            return None
        try:
            self._get(HEALTH_PATH)
        except urllib.error.HTTPError as exc:
            ok = exc.code not in (401, 403, 404) and exc.code < 500
            self._note(ok, "" if ok else f"HTTP {exc.code}")
            self._note_auth(exc.code)
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


# The sentence a real printer reports while the Brother is unplugged or off.
# SMPL's Scan-Station page shows it verbatim under "Testetikett drucken", so
# it is one constant rather than a string in two places.
PRINTER_NOT_FOUND_ERROR = "printer not found on USB (PT-P710BT unplugged or powered off?)"


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
                self._error = PRINTER_NOT_FOUND_ERROR
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
        # Invalidate the cached status too: the bus just told us the handle is
        # gone, and a cache that survives that reports a printer which is no
        # longer there for up to STATUS_TTL_S. That window is exactly when the
        # station's refusal() check runs after a cable is pulled mid-feed, so a
        # test print would be accepted and then silently dropped.
        self._status_at = 0.0
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

    def refusal(self) -> str | None:
        """Why a label must not be queued right now — or None when it may.

        ``submit_lines`` answers in milliseconds by design and a failure in
        the worker lands only in ``_last_print_error``, where nobody at the
        bench (or at SMPL's "Testetikett drucken") is listening. So the one
        thing that can be said up front is said up front: a real printer
        that is not connected refuses the label with its reason instead of
        queueing it into a worker that loses the reason.

        A simulated printer is always ready. A status read that could not get
        the lock (``busy``) means a label is feeding right now, and a feeding
        printer is a connected one — refusing there would turn every second
        label of a burst into a false "unplugged".
        """
        status = self.status()
        if status.get("simulated") or status.get("busy"):
            return None
        if status.get("printer_connected"):
            return None
        return str(status.get("error") or "printer unavailable")

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

    def __init__(self, store: Store, printer: Printer, upstream: Upstream,
                 station=None, *, scanner_enabled: bool = False,
                 now_playing_enabled: bool = False,
                 scanner_layout: str = SCANNER_LAYOUT,
                 session_idle_s: float = SESSION_IDLE_S, clock=time.time) -> None:
        self.store = store
        self.printer = printer
        self.upstream = upstream
        # Optional on purpose: pairing and SD import are Pi features, and the
        # agent has to keep booting on a machine where neither is wanted or
        # where the modules failed to import at all.
        self.station = station
        if station is not None:
            self.upstream.station = station
        self._stop = threading.Event()
        self._probe_thread: threading.Thread | None = None
        # Monotonic, not the injectable kiosk clock: uptime is a fact about
        # this process, and SMPL shows it to answer "did the restart happen?".
        self.started_monotonic = time.monotonic()

        # The kiosk is the same kind of optional as the station: four sibling
        # modules, all stdlib, none of which may stop the agent booting.
        # Hardware and D-Bus are opt-in, because a bench Mac has neither.
        self.scanner_enabled = bool(scanner_enabled)
        self.now_playing_enabled = bool(now_playing_enabled)
        # Which keycode table the scanner is read through. The office scanner
        # sends German scancodes (measured — see input_reader); a replacement
        # may not, so it is a setting rather than a constant.
        self.scanner_layout = scanner_layout
        # The Y/Z warning is latched: see _warn_layout_swapped.
        self._layout_warned = False
        # One time base for the whole kiosk. A snapshot that mixes two of them
        # counts down from a deadline it did not set.
        self._clock = clock
        self.kiosk_error = ""
        self._sr = None
        self._sw = None
        self.router = None
        self.werkstatt = None
        self.now_playing = None
        self.scanner = None
        self.kiosk = None
        self._boxes_at = 0.0
        self._crew_at = 0.0
        self._tick_thread: threading.Thread | None = None
        self._build_kiosk(session_idle_s, clock)

    def _build_kiosk(self, session_idle_s: float, clock) -> None:
        modules = {name: module(name) for name in
                   ("scan_router", "smpl_werkstatt", "now_playing", "input_reader")}
        missing = [name for name, mod in modules.items() if mod is None]
        if missing:
            self.kiosk_error = "; ".join(module_error(name) for name in missing)
            return
        self._sr = modules["scan_router"]
        self._sw = modules["smpl_werkstatt"]
        try:
            self.router = self._sr.ScanRouter(
                clock=clock, idle_timeout_s=session_idle_s,
                # Three threads reach the router: this agent's tick, the
                # scanner's dispatch thread and every HTTP handler. The module
                # imports no threading on purpose (its rules stay testable in
                # microseconds), so the lock is handed to it from here. It has
                # to be re-entrant: a public read may call another one.
                lock=threading.RLock(),
            )
            self.werkstatt = self._sw.WerkstattClient(
                self.upstream.base_url,
                token_provider=self.station.token if self.station is not None else None,
                on_auth=self._note_station_auth,
                user_agent=f"smpl-label-agent/{VERSION}",
                clock=clock,
            )
            self.now_playing = modules["now_playing"].NowPlaying(log=self._log)
            self.scanner = modules["input_reader"].ScannerReader(
                self._on_scanned, log=self._log,
                layout=modules["input_reader"].resolve_layout(self.scanner_layout),
            )
            self.kiosk = Kiosk(
                self.router, idle_timeout_s=session_idle_s,
                scanner_status=self.scanner.status,
                # The chip on the wall says whether the screens can talk to
                # SMPL, so it has to be the client the screens actually use.
                # Wiring it to the label agent's own Upstream meant revoking
                # the station token left both screens green while every crate
                # request came back 401.
                upstream_status=self._werkstatt_chip,
                clock=clock,
            )
        except Exception as exc:  # noqa: BLE001 - a broken kiosk is not a broken agent
            self.kiosk_error = f"{type(exc).__name__}: {exc}"
            self.kiosk = None

    def _note_station_auth(self, status: int) -> None:
        """A 401 means re-pair. A 403 means this route is not for a station."""
        if self.station is None:
            return
        if status == 401:
            self.station.note_rejection(status)
        elif status < 400:
            self.station.note_success()

    def _werkstatt_chip(self) -> dict:
        """The screens' own upstream health, for the chip on the wall."""
        status = self.werkstatt.status()
        return {"ok": status.get("last_ok"), "error": status.get("last_error")}

    @staticmethod
    def _log(message: str) -> None:
        sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), message))

    def start_background(self) -> None:
        if self.station is not None:
            self.station.start()
        if self.kiosk is not None:
            if self.scanner_enabled:
                self.scanner.start()
            if self.now_playing_enabled:
                self.now_playing.start()
            self._tick_thread = threading.Thread(
                target=self._tick_loop, name="kiosk-tick", daemon=True
            )
            self._tick_thread.start()
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

    def _tick_loop(self) -> None:
        """Expire idle sessions and keep the box list warm. Never raises."""
        while not self._stop.is_set():
            try:
                self.tick_once()
            except Exception as exc:  # noqa: BLE001
                self._log(f"kiosk tick failed: {type(exc).__name__}: {exc}")
            self._stop.wait(KIOSK_TICK_S)

    def tick_once(self) -> None:
        """One pass of the kiosk clock. Separate from the loop so it can be
        driven by hand: "the name clears itself after two minutes" is a rule
        nobody exercises in the workshop and everything downstream trusts.
        """
        if self.router.tick():
            self.kiosk.flash(SCREEN_BOXES, "warn", "Kiste automatisch geschlossen",
                             "Zu lange nichts gescannt.")
        if self.router.expire_assignee():
            # Whoever tapped their name has walked away; the next
            # Ausgabe asks again rather than booking onto them.
            self.kiosk.flash(SCREEN_RACK, "warn", "Name zurückgesetzt",
                             "Bitte vor der Ausgabe wieder antippen.")
        if time.monotonic() - self._boxes_at >= BOX_REFRESH_S:
            self._refresh_boxes()
        if time.monotonic() - self._crew_at >= CREW_REFRESH_S:
            self._refresh_crew()

    def shutdown(self) -> None:
        self._stop.set()
        if self.scanner is not None:
            self.scanner.stop()
        if self.now_playing is not None:
            self.now_playing.stop()
        if self.kiosk is not None:
            self.kiosk.close()
        if self.station is not None:
            self.station.shutdown()
        self.printer.close()

    # -- endpoints --------------------------------------------------------

    def uptime_seconds(self) -> int:
        return int(time.monotonic() - self.started_monotonic)

    def hardware_summary(self, printer_status: dict | None = None) -> dict:
        """The fixed keys SMPL's Scan-Station page renders — the same four
        whether they travel by heartbeat or by a synchronous ``/health``.
        Kept in step with ``StationHardwareOut`` (apps/api/app/schemas/station.py).
        """
        status = printer_status if printer_status is not None else self.printer.status()
        scanner = self.scanner.status() if self.scanner is not None else {}
        device = scanner.get("device")
        return {
            "printer_model": PRINTER_MODEL,
            "scanner_present": bool(device),
            "scanner_name": device if isinstance(device, str) else None,
            "simulated": bool(status.get("simulated")),
        }

    def health(self) -> dict:
        status = self.printer.status()
        payload = {
            "ok": True,
            "version": VERSION,
            "printer_connected": bool(status.get("printer_connected")),
            "media_width_mm": status.get("media_width_mm"),
            "error": status.get("error") or None,
            "upstream_ok": self.upstream.last_ok if self.upstream.configured else None,
            "upstream_configured": self.upstream.configured,
            "upstream_error": self.upstream.last_error or None,
            "simulated": bool(status.get("simulated")),
            "uptime_seconds": self.uptime_seconds(),
            "session_count": self.store.session_count(),
            "hardware": self.hardware_summary(status),
            "db": str(self.store.path),
            "modules": {
                "brother_raster": module("brother_raster") is not None,
                "label_render": module("label_render") is not None,
            },
        }
        if self.station is not None:
            payload.update(self.station.health())
        else:
            payload["identity"] = {"paired": False, "disabled": True}
        payload.update(self._kiosk_health())
        return payload

    def _kiosk_health(self) -> dict:
        """What the screens, the scanner and the AirPlay widget are doing.

        Reported even when the kiosk failed to build, because "why is the
        scanner dead" is exactly the question /health exists to answer.
        """
        if self.kiosk is None:
            reason = self.kiosk_error or "kiosk not built"
            return {
                "scan_router": {"available": False, "error": reason},
                "scanner": {"active": False, "device": None, "error": reason},
                "now_playing": {"running": False, "playing": False, "error": reason},
            }
        return {
            "scan_router": dict(self.router.snapshot(),
                                available=True,
                                commands=list(self._sr.COMMAND_CODES)),
            "scanner": dict(self.scanner.status(), enabled=self.scanner_enabled),
            "now_playing": dict(self.now_playing.status(), enabled=self.now_playing_enabled),
            "werkstatt": self.werkstatt.status(),
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
        # Before rendering, not after queueing: a 200 here means "the label
        # will feed", and that is only true of a printer that is there. The
        # 503 carries the printer's own sentence, which SMPL shows verbatim.
        refusal = self.printer.refusal()
        if refusal is not None:
            raise ApiError(503, refusal)
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

    # -- the kiosk screens ------------------------------------------------

    def movement_types(self):
        """The movement vocabulary SMPL accepts, for validating a request."""
        return self._sw.MOVEMENT_TYPES if self._sw is not None else frozenset()

    def require_kiosk(self):
        """The kiosk, or a 503 that says which module is missing."""
        if self.kiosk is None:
            raise ApiError(503, "the kiosk screens are unavailable: "
                                + (self.kiosk_error or "not built"))
        return self.kiosk

    def boxes_state(self) -> dict:
        """The crate list in the shape the contract promises, never an error."""
        self.require_kiosk()
        snapshot = self.werkstatt.boxes()
        self.kiosk.set_boxes(snapshot)
        self._boxes_at = time.monotonic()
        return snapshot

    def _refresh_boxes(self, *, force: bool = False) -> None:
        if self.kiosk is None:
            return
        snapshot = self.werkstatt.boxes(force=force)
        self.kiosk.set_boxes(snapshot)
        self._boxes_at = time.monotonic()

    def _refresh_crew(self, *, force: bool = False) -> None:
        """Keep the name buttons warm, off the request path.

        The snapshot does no I/O — a screen holding a 25-second poll must
        never be the reason a network call is in flight — so the crew is
        fetched here and handed to the kiosk, exactly like the box list.
        """
        if self.kiosk is None:
            return
        self.kiosk.set_crew(self.werkstatt.crew(force=force))
        self._crew_at = time.monotonic()

    # -- a scan -----------------------------------------------------------

    def _on_scanned(self, code: str) -> None:
        """The scanner thread's entry point. Swallows everything."""
        try:
            self.route_scan(code, source="evdev")
        except Exception as exc:  # noqa: BLE001 - the reader must not learn about HTTP
            self._log(f"scan routing failed: {type(exc).__name__}: {exc}")

    def route_scan(self, code: str, source: str = "wedge") -> dict:
        """Decide which screen owns this scan, then do what it means.

        The arrival time is taken **first** and threaded all the way into the
        router. Two readers deliver the same trigger pull about 20 ms apart,
        and the de-dupe window is 150 ms — but resolving an unknown code
        against SMPL is allowed four seconds. Judging the echo after that call
        measured the network instead of the scanner, and one pull of the
        trigger booked stock twice.
        """
        self.require_kiosk()
        text = (code or "").strip()
        if not text:
            raise ApiError(400, "'code' must not be empty")
        arrived = self._clock()
        resolved = None
        # An echo is dropped before it costs a round trip, not after.
        if not self.router.is_duplicate(text, arrived) and self.router.needs_resolution(text):
            text, resolved = self._resolve_scan(text)
        decision = self.router.route(text, source=source,
                                     kind=self._sw.kind_of(resolved), at=arrived)
        try:
            self._apply(decision, resolved)
        except Exception as exc:  # noqa: BLE001 - a screen update is not worth a 500
            self._log(f"applying a scan failed: {type(exc).__name__}: {exc}")
            self.kiosk.flash(decision.screen or SCREEN_RACK, "error",
                             "Unerwarteter Fehler", str(exc)[:200], code=text)
        return {
            "ok": decision.ok,
            "routed_to": decision.screen,
            "action": decision.action,
            "duplicate": decision.duplicate,
            "code": decision.code,
            "qty": decision.qty,
            "error": decision.error,
        }

    def _resolve_scan(self, text: str):
        """Ask SMPL what a code is, with one Y/Z retry behind the answer.

        Returns ``(code, resolved)`` — the code that actually resolved, so a
        swapped hit books and displays the article on the label rather than
        the one the keycode table guessed.

        The retry exists because the German table's Y/Z swap is inferred from
        the XKB layout files rather than measured (neither captured scan
        contains either letter), and a wrong guess is invisible: the article
        simply "does not exist". It fires at most once, only for a code that
        contains a Y or a Z, and only when SMPL actually answered — during an
        outage every miss is a miss, and doubling the timeout on the one path
        that has to stay under five seconds would buy nothing.

        Routing the *swapped* spelling is deliberate: two readers deliver the
        same trigger pull, both take this same deterministic path, and the
        router's own de-dupe window then sees two identical codes. Routing the
        raw one instead would leave the echo looking like a different scan.
        """
        resolved = self.werkstatt.resolve(text)
        if not self._is_a_miss(resolved):
            return text, resolved
        swapped = text.translate(_YZ_SWAP)
        if swapped == text or not self.werkstatt.status().get("last_ok"):
            return text, resolved
        second = self.werkstatt.resolve(swapped)
        if self._is_a_miss(second):
            return text, resolved
        self._warn_layout_swapped(text, swapped)
        return swapped, second

    def _is_a_miss(self, resolved) -> bool:
        """True when SMPL has nothing for this code (or said nothing at all)."""
        if resolved is None:
            return True
        return self._sw.kind_of(resolved) in (None, "not_found")

    def _warn_layout_swapped(self, text: str, swapped: str) -> None:
        """One line, once per process — the same rule the reader logs by.

        Once per process rather than once per scan: with a wrong layout every
        second article scan would hit this, and a message repeated a hundred
        times an hour is a message nobody reads.
        """
        if self._layout_warned:
            return
        self._layout_warned = True
        self._log(
            "scanner layout: %r was unknown but %r resolved — Y and Z are swapped, "
            "so the scanner is no longer sending %s scancodes. Check "
            "--scanner-layout / SCANNER_LAYOUT (logged once per start)."
            % (text, swapped, self.scanner_layout)
        )

    def _apply(self, decision, resolved) -> None:
        handler = _APPLY.get(decision.action)
        if handler is not None:
            handler(self, decision, resolved)

    # -- what each decision costs -----------------------------------------

    def _applied_session(self, decision, _resolved) -> None:
        detail = {"open_session": "Kiste offen",
                  "switch_session": "Kiste gewechselt",
                  "keep_session": "Kiste bleibt offen"}[decision.action]
        self.kiosk.flash(SCREEN_BOXES, "ok", "Kiste %s" % (decision.box_number or "?"), detail,
                         code=decision.code)
        self._refresh_boxes(force=True)

    def _applied_close(self, decision, _resolved) -> None:
        self.kiosk.flash(SCREEN_BOXES, "ok", "Kiste geschlossen",
                         decision.previous_code or "", code=decision.code)

    def _applied_qty(self, decision, _resolved) -> None:
        # The pending quantity shows on both screens, so both must be woken.
        other = SCREEN_BOXES if decision.screen == SCREEN_RACK else SCREEN_RACK
        self.kiosk.flash(decision.screen or SCREEN_RACK, "ok", "Menge %d" % decision.qty,
                         "gilt für den nächsten Scan", code=decision.code)
        self.kiosk.bump(other)

    def _applied_direction(self, decision, _resolved) -> None:
        self.kiosk.flash(SCREEN_RACK, "ok",
                         DIRECTION_LABEL.get(self.router.direction, self.router.direction),
                         "Richtung geändert", code=decision.code)

    def _applied_mode(self, decision, _resolved) -> None:
        label = "Entnahme aus der Kiste" if self.router.mode == "remove" else "Einpacken"
        self.kiosk.flash(SCREEN_BOXES, "ok", label, "Modus geändert", code=decision.code)

    def _applied_note(self, decision, _resolved) -> None:
        titles = {"clear_pending": "Verworfen",
                  "nothing_to_undo": "Nichts zum Rückgängigmachen",
                  "cannot_undo": "Abbruch nicht möglich"}
        level = "ok" if decision.ok else "warn"
        self.kiosk.flash(decision.screen or SCREEN_RACK, level,
                         titles.get(decision.action, decision.action),
                         decision.error or "", code=decision.code)

    def _applied_needs_assignee(self, decision, _resolved) -> None:
        """Refused before anything was written, in the operator's own words.

        The ledger has to be able to answer "who has the drill", so an Ausgabe
        with nobody tapped is not booked anonymously and not queued — it is
        refused, the quantity survives, and the screen says what to do.
        """
        self.kiosk.flash(SCREEN_RACK, "error", decision.error or "Bitte zuerst Namen antippen",
                         "Ausgabe nur mit Namen — nichts gebucht.", code=decision.code)

    def _applied_machine(self, decision, resolved) -> None:
        """Show the tool, say that showing it is all that happened.

        A machine has a unit number, a state and a holder; it has no stock
        counters at all. Projecting it into ``last.article`` showed a dash for
        the name and 0/0/0 for the counters of a drill somebody was holding.
        ``article`` is null on purpose, so the counters are *absent* rather
        than zero and the page renders the machine card instead.
        """
        self.kiosk.set_last({"article": None,
                             "machine": self._sw.machine_of(resolved),
                             # Null, and it has to stay null: the rack screen
                             # shows its "Nicht gebucht" note exactly when the
                             # state carries no movement, and nothing here
                             # writes a ledger row for a tool.
                             "movement": None})
        if decision.ok:
            # Not "ok". Scanning a tool at the rack books *nothing* — machine
            # ausgabe and rückgabe live in SMPL — and a green tick under a
            # drill's name is read across a workshop as "it is booked out to
            # me". A worker walked off with a tool the ledger never saw.
            self.kiosk.flash(SCREEN_RACK, "warn", MSG_MACHINE_LOOKUP_ONLY,
                             MSG_MACHINE_NOT_BOOKED, code=decision.code)
            return
        # Refused during a crate session: the message belongs on the screen the
        # operator is standing at, the scan itself belongs on the rack.
        self.kiosk.flash(SCREEN_BOXES, "error", "Maschine gehört nicht in die Kiste",
                         decision.error or "", code=decision.code)
        self.kiosk.flash(SCREEN_RACK, "warn", "Maschine gescannt",
                         "vom Kisten-Bildschirm umgeleitet", code=decision.code)

    def _applied_add(self, decision, resolved) -> None:
        box_id = self._session_box_id()
        if box_id is None:
            self.kiosk.flash(SCREEN_BOXES, "error", "Kiste unbekannt",
                             "SMPL kennt die Kiste %s nicht." % (decision.box_number or "?"),
                             code=decision.code)
            return
        article_id = self._sw.article_id_of(resolved)
        result = self.werkstatt.add_item(
            box_id, code="" if article_id else decision.code,
            article_id=article_id, quantity=decision.qty,
        )
        if not result.ok:
            self.router.note_pending(self._article_from(resolved, decision.code), decision.qty)
            self.kiosk.flash(SCREEN_BOXES, "error", "Nicht eingebucht", result.error or "",
                             code=decision.code)
            return
        line = result.data if isinstance(result.data, dict) else {}
        self.router.note_commit(screen=SCREEN_BOXES, action="add_item", box_id=box_id,
                                item_id=line.get("id"), article_id=article_id, qty=decision.qty)
        self.kiosk.flash(SCREEN_BOXES, "ok",
                         line.get("item_name") or decision.code,
                         "+%d in Kiste %s" % (decision.qty, decision.box_number or "?"),
                         code=decision.code)
        self._refresh_boxes(force=True)

    def _applied_remove(self, decision, resolved) -> None:
        box_id = self._session_box_id()
        box = self.kiosk.find_box(box_id=box_id) if box_id is not None else None
        if box is None:
            self.kiosk.flash(SCREEN_BOXES, "error", "Kiste unbekannt",
                             "SMPL kennt die Kiste %s nicht." % (decision.box_number or "?"),
                             code=decision.code)
            return
        line = _match_line(box, self._sw.article_id_of(resolved), decision.code)
        if line is None:
            self.kiosk.flash(SCREEN_BOXES, "warn", "Nicht in der Kiste",
                             "%s liegt nicht in Kiste %s." % (decision.code,
                                                              decision.box_number or "?"),
                             code=decision.code)
            return
        result = self.werkstatt.remove_item(box_id, line.get("id"), decision.qty)
        if not result.ok:
            self.kiosk.flash(SCREEN_BOXES, "error", "Nicht ausgebucht", result.error or "",
                             code=decision.code)
            return
        self.router.note_commit(screen=SCREEN_BOXES, action="remove_item", box_id=box_id,
                                item_id=line.get("id"),
                                article_id=line.get("article_id"), qty=decision.qty)
        self.kiosk.flash(SCREEN_BOXES, "ok", line.get("item_name") or decision.code,
                         "-%d aus Kiste %s" % (decision.qty, decision.box_number or "?"),
                         code=decision.code)
        self._refresh_boxes(force=True)

    def _applied_movement(self, decision, resolved) -> None:
        article_id = self._sw.article_id_of(resolved)
        if article_id is None:
            self._unstocked(decision, resolved)
            return
        result = self.werkstatt.movement(article_id, decision.movement_type, decision.qty,
                                         assignee_user_id=decision.assignee_user_id)
        if not result.ok:
            self.router.note_pending(self._article_from(resolved, decision.code), decision.qty)
            self.kiosk.flash(SCREEN_RACK, "error", "Nicht gebucht", result.error or "",
                             code=decision.code)
            return
        self._record_movement(decision, resolved, article_id, result, decision.movement_type)

    def _unstocked(self, decision, resolved) -> None:
        """A scan SMPL answered, for something the workshop does not stock.

        This used to be one line — "Code nicht zugeordnet. SMPL ist nicht
        erreichbar." — chosen on nothing but whether an upstream was
        *configured*, never on whether it had answered. It had: the catalogue
        match comes back in under 200 ms. So the screen reported an outage
        while the server was healthy, and people went to check the network.

        Three genuinely different situations, told apart and said plainly:

        **No upstream.** This station has never been paired, or the token is
        gone. The only case where "not connected" is the truth.

        **A catalogue hit at Wareneingang.** The wholesaler's Datanorm row
        matched, which means SMPL knows exactly what is in the operator's
        hand and simply has no article for it — and a delivery is the one
        moment where that is fixable on the spot, by somebody holding the
        item. Create it and book the delivery in one call.

        **A catalogue hit in any other direction.** Ausgabe and Rückgabe move
        stock that must already exist; conjuring an article to hand out is a
        different and much less defensible act than recording an arrival. Name
        the product so the operator can see SMPL recognised it, and say what
        is missing.
        """
        self.router.note_pending(self._article_from(resolved, decision.code), decision.qty)

        if not self.werkstatt.configured:
            self.kiosk.flash(SCREEN_RACK, "error", "Code nicht zugeordnet",
                             "Diese Station ist nicht mit SMPL verbunden.",
                             code=decision.code)
            return

        catalog_id = self._catalog_item_id(resolved)
        if catalog_id is None:
            self.kiosk.flash(SCREEN_RACK, "error", "Code nicht zugeordnet",
                             "SMPL kennt diesen Code nicht.", code=decision.code)
            return

        name, hint, _kind = parse_resolution(resolved)
        label = name or decision.code
        if self.router.direction != "wareneingang":
            detail = "%s — noch kein Artikel im Bestand. Bitte im Wareneingang einbuchen." % (
                hint or "Im Lieferantenkatalog gefunden")
            self.kiosk.flash(SCREEN_RACK, "error", label, detail, code=decision.code)
            return

        result = self.werkstatt.stock_from_catalog(catalog_id, decision.qty)
        if not result.ok:
            self.kiosk.flash(SCREEN_RACK, "error", "Nicht angelegt", result.error or "",
                             code=decision.code)
            return

        data = result.data if isinstance(result.data, dict) else {}
        article = data.get("article") if isinstance(data.get("article"), dict) else None
        article_id = self._sw.article_id_of(data) or (article or {}).get("id")
        self.router.note_commit(screen=SCREEN_RACK, action="movement", article_id=article_id,
                                movement_type="intake", qty=decision.qty,
                                assignee_user_id=None)
        self.kiosk.set_last({
            "article": article or self._article_from(resolved, decision.code),
            "machine": None,
            "movement": {"movement_type": "intake", "qty": decision.qty,
                         "movement_id": data.get("movement_id"), "at": self._clock()},
        })
        created = bool(data.get("created"))
        self.kiosk.flash(
            SCREEN_RACK, "ok", (article or {}).get("item_name") or label,
            ("Artikel angelegt, Wareneingang %d" if created else "Wareneingang %d")
            % decision.qty,
            code=decision.code)

    @staticmethod
    def _catalog_item_id(resolved) -> "int | None":
        """The first catalogue row's own id, or None if this is not one.

        ``article_id_of`` deliberately looks for an ``article_id`` *inside* a
        catalogue row and finds none — that is the whole condition this path
        handles. What the row does carry is its own ``id``, which is what the
        station sends back so the server can copy the product's identity from
        it rather than trust anything this box says about it.

        Reads ``kind`` straight off the payload rather than through
        ``smpl_werkstatt.kind_of``: that module is loaded dynamically onto
        ``self._sw`` and may legitimately be absent, and a helper this small
        should not be the reason an import turns into an AttributeError.
        """
        if not isinstance(resolved, dict) or resolved.get("kind") != "catalog_match":
            return None
        items = resolved.get("catalog_items")
        if not isinstance(items, list):
            return None
        for item in items:
            if isinstance(item, dict) and isinstance(item.get("id"), int):
                return item["id"]
        return None

    def _record_movement(self, decision, resolved, article_id, result, movement_type) -> None:
        data = result.data if isinstance(result.data, dict) else {}
        article = data.get("article") if isinstance(data.get("article"), dict) else None
        self.router.note_commit(screen=SCREEN_RACK, action="movement", article_id=article_id,
                                movement_type=movement_type, qty=decision.qty,
                                assignee_user_id=decision.assignee_user_id)
        self.kiosk.set_last({
            "article": article or self._article_from(resolved, decision.code),
            "machine": None,
            "movement": {"movement_type": movement_type, "qty": decision.qty,
                         "movement_id": data.get("movement_id"), "at": self._clock()},
        })
        name = (article or {}).get("item_name") or decision.code
        self.kiosk.flash(SCREEN_RACK, "ok", name,
                         "%s %d" % (DIRECTION_LABEL.get(self.router.direction, movement_type),
                                    decision.qty),
                         code=decision.code)

    # -- undo -------------------------------------------------------------

    def _applied_undo_item(self, decision, _resolved) -> None:
        undo = decision.undo or {}
        result = self.werkstatt.remove_item(undo.get("box_id"), undo.get("item_id"),
                                            undo.get("qty", 1))
        self._flash_undo(SCREEN_BOXES, result, decision, "Position zurückgenommen")

    def _applied_undo_remove(self, decision, _resolved) -> None:
        undo = decision.undo or {}
        result = self.werkstatt.add_item(undo.get("box_id"), article_id=undo.get("article_id"),
                                         quantity=undo.get("qty", 1))
        self._flash_undo(SCREEN_BOXES, result, decision, "Entnahme zurückgenommen")

    def _applied_undo_movement(self, decision, _resolved) -> None:
        undo = decision.undo or {}
        result = self.werkstatt.movement(undo.get("article_id"), undo.get("movement_type", ""),
                                         undo.get("qty", 1),
                                         assignee_user_id=undo.get("assignee_user_id"))
        self._flash_undo(SCREEN_RACK, result, decision, "Buchung zurückgenommen")

    def _flash_undo(self, screen: str, result, decision, title: str) -> None:
        """Only a *landed* inverse forgets what it undid.

        The router describes the inverse and keeps the record; it is cleared
        here, once SMPL accepted it. One ABBRUCH during a network blip must
        not cost the operator the ability to undo at all — the blip is
        precisely why the screen looks wrong.
        """
        if result.ok:
            self.router.confirm_undo(screen)
            self.kiosk.flash(screen, "ok", title, "", code=decision.code)
            self._refresh_boxes(force=True)
        else:
            self.kiosk.flash(screen, "error", "Abbruch fehlgeschlagen", result.error or "",
                             code=decision.code)

    # -- helpers ----------------------------------------------------------

    def _session_box_id(self):
        session = self.router.session
        if session is None:
            return None
        box = self.kiosk.find_box(code=session.code, box_number=session.box_number)
        return box.get("id") if box else None

    @staticmethod
    def _article_from(resolved, code: str) -> dict:
        if isinstance(resolved, dict):
            article = resolved.get("article")
            if isinstance(article, dict):
                return article
            items = resolved.get("catalog_items")
            if isinstance(items, list) and items and isinstance(items[0], dict):
                return items[0]
        return {"code": code, "item_name": None}

    # -- routes the screens call directly ---------------------------------

    def open_box_session(self, box_id: int) -> dict:
        self.require_kiosk()
        self._refresh_boxes()
        box = self.kiosk.find_box(box_id=box_id)
        if box is None:
            return {"ok": False, "error": "SMPL kennt keine Kiste mit der Nummer %d." % box_id}
        code = str(box.get("code") or "").strip() or "KISTE-%s" % (box.get("box_number") or "")
        self.router.open_session(code)
        self.kiosk.flash(SCREEN_BOXES, "ok", "Kiste %s" % (box.get("box_number") or box_id),
                         "Kiste offen", code=code)
        return {"ok": True, "box_id": box_id, "code": code}

    def close_box_session(self) -> dict:
        self.require_kiosk()
        self.router.close_session()
        self.kiosk.flash(SCREEN_BOXES, "ok", "Kiste geschlossen", "")
        return {"ok": True}

    def add_box_item(self, box_id: int, code: str, article_id, qty: int) -> dict:
        self.require_kiosk()
        result = self.werkstatt.add_item(box_id, code=code, article_id=article_id, quantity=qty)
        if result.ok:
            line = result.data if isinstance(result.data, dict) else {}
            self.router.note_commit(screen=SCREEN_BOXES, action="add_item", box_id=box_id,
                                    item_id=line.get("id"), article_id=article_id, qty=qty)
            self.kiosk.flash(SCREEN_BOXES, "ok", line.get("item_name") or code or "Position",
                             "+%d" % qty, code=code)
            self._refresh_boxes(force=True)
        else:
            self.kiosk.flash(SCREEN_BOXES, "error", "Nicht eingebucht", result.error or "",
                             code=code)
        return {"ok": result.ok, "item": result.data if result.ok else None,
                "error": result.error}

    def remove_box_item(self, box_id: int, item_id: int, qty: int) -> dict:
        self.require_kiosk()
        result = self.werkstatt.remove_item(box_id, item_id, qty)
        if result.ok:
            self.router.note_commit(screen=SCREEN_BOXES, action="remove_item", box_id=box_id,
                                    item_id=item_id, qty=qty)
            self.kiosk.flash(SCREEN_BOXES, "ok", "Position entfernt", "-%d" % qty)
            self._refresh_boxes(force=True)
        else:
            self.kiosk.flash(SCREEN_BOXES, "error", "Nicht ausgebucht", result.error or "")
        return {"ok": result.ok, "removed": result.data if result.ok else None,
                "error": result.error}

    def rack_movement(self, article_id: int, movement_type: str, qty: int,
                      assignee_user_id=None) -> dict:
        """Book one movement from the rack screen's own buttons.

        The rule about names lives here rather than in the HTTP handler
        because this is the *second* door onto the ledger: a scan is refused
        by the router before it ever gets this far, and an anonymous checkout
        posted through this one would leave a tool out with nobody on it — the
        one question the ledger exists to answer.
        """
        self.require_kiosk()
        if self._sr.movement_needs_assignee(movement_type, assignee_user_id):
            self.kiosk.flash(SCREEN_RACK, "error", self._sr.MSG_NEEDS_ASSIGNEE,
                             "Ausgabe nur mit Namen — nichts gebucht.")
            raise ApiError(400, self._sr.MSG_NEEDS_ASSIGNEE)
        result = self.werkstatt.movement(article_id, movement_type, qty,
                                         assignee_user_id=assignee_user_id)
        if not result.ok:
            self.kiosk.flash(SCREEN_RACK, "error", "Nicht gebucht", result.error or "")
            return {"ok": False, "article": None, "error": result.error}
        data = result.data if isinstance(result.data, dict) else {}
        article = data.get("article") if isinstance(data.get("article"), dict) else None
        self.router.note_commit(screen=SCREEN_RACK, action="movement", article_id=article_id,
                                movement_type=movement_type, qty=qty,
                                assignee_user_id=assignee_user_id)
        self.kiosk.set_last({"article": article, "machine": None,
                             "movement": {"movement_type": movement_type, "qty": qty,
                                          "movement_id": data.get("movement_id"),
                                          "at": self._clock()}})
        self.kiosk.flash(SCREEN_RACK, "ok", (article or {}).get("item_name") or "Gebucht",
                         "%s %d" % (movement_type, qty))
        return {"ok": True, "article": article, "error": None}

    def screen_action(self, screen: str, action: str, value) -> dict:
        """One tap from one screen. The screen it claims has to be its own.

        ``screen`` used to be validated (it is one of the two) and then
        ignored, so the box screen could set the rack's direction or tap a
        name onto an Ausgabe nobody at the rack had asked for. Each action
        belongs to the screen whose buttons produce it; the two that belong to
        both say so in :data:`ACTION_SCREEN`.
        """
        self.require_kiosk()
        allowed = ACTION_SCREEN.get(action)
        if allowed is not None and screen != allowed:
            raise ApiError(400, "'%s' is an action of the %s screen, not %s"
                                % (action, allowed, screen))
        if action == "direction":
            if value not in self._sr.DIRECTIONS:
                raise ApiError(400, "'value' must be one of %s"
                                    % ", ".join(self._sr.DIRECTIONS))
            self.router.set_direction(value)
            self.kiosk.bump(SCREEN_RACK)
        elif action == "assignee":
            self._set_assignee(value)
        elif action == "mode":
            if value not in ("add", "remove"):
                raise ApiError(400, "'value' must be 'add' or 'remove'")
            self.router.set_mode(value)
            self.kiosk.bump(SCREEN_BOXES)
        elif action == "dismiss":
            self.kiosk.clear_flash(screen)
        elif action == "close_session":
            self.router.close_session()
            self.kiosk.bump(SCREEN_BOXES)
        elif action == "qty":
            self.router.set_qty(require_int({"qty": value}, "qty", 1, 1, 9999))
            self.kiosk.bump(*SCREENS)
        else:
            raise ApiError(400, "unknown screen action '%s'" % action)
        return {"ok": True, "action": action}

    def _set_assignee(self, value) -> None:
        """Tap a name, or clear it with a null.

        The id has to be somebody in the cached crew, because the buttons the
        operator pressed were built from that very list. Accepting an id from
        outside it published ``{"id": 7, "name": null}`` — which breaks the
        screen contract's ``name: string``, shows a nameless chip on the wall,
        and books a tool out to a person the station cannot name.

        The cached list and never a fetch: a tap has to land instantly, and
        the tick keeps the list warm off the request path.
        """
        if value in (None, ""):
            self.router.set_assignee(None)
            self.kiosk.bump(SCREEN_RACK)
            return
        user_id = require_int({"assignee": value}, "assignee", 0, 1, 2 ** 31 - 1)
        person = next((row for row in self.kiosk.crew() if row.get("id") == user_id), None)
        if person is None:
            raise ApiError(400, "no crew member with id %d — the name buttons are "
                                "built from the crew list, so this id is not one "
                                "of them" % user_id)
        self.router.set_assignee({"id": user_id, "name": person.get("name")})
        self.kiosk.bump(SCREEN_RACK)


# What each routing decision costs, in one table rather than one long chain.
_APPLY = {
    "open_session": Agent._applied_session,
    "switch_session": Agent._applied_session,
    "keep_session": Agent._applied_session,
    "close_session": Agent._applied_close,
    "qty": Agent._applied_qty,
    "direction": Agent._applied_direction,
    "mode": Agent._applied_mode,
    "clear_pending": Agent._applied_note,
    "nothing_to_undo": Agent._applied_note,
    "cannot_undo": Agent._applied_note,
    "needs_assignee": Agent._applied_needs_assignee,
    "machine": Agent._applied_machine,
    "refused": Agent._applied_machine,
    "add_item": Agent._applied_add,
    "remove_item": Agent._applied_remove,
    "movement": Agent._applied_movement,
    "undo_item": Agent._applied_undo_item,
    "undo_remove": Agent._applied_undo_remove,
    "undo_movement": Agent._applied_undo_movement,
}


def _match_line(box: dict, article_id, code: str):
    """The line in a crate that a scanned code refers to, or None.

    Matching on the article id first matters: two lines can carry the same
    printed code if one was added from the catalogue and one from stock, and
    the id is the only thing that is unambiguous.
    """
    wanted = (code or "").strip().upper()
    for line in (box.get("items") or []):
        if not isinstance(line, dict):
            continue
        if article_id is not None and line.get("article_id") == article_id:
            return line
    for line in (box.get("items") or []):
        if not isinstance(line, dict):
            continue
        for key in ("article_no", "code", "internal_code"):
            if wanted and str(line.get(key) or "").strip().upper() == wanted:
                return line
    return None


# --------------------------------------------------------------------------
# The kiosk screens
# --------------------------------------------------------------------------

class Kiosk:
    """The two screens' shared view, and the long poll that feeds them.

    Everything a screen needs is assembled here from three sources that are
    each allowed to be absent: the routing state machine, the last box list
    SMPL gave us, and the hardware status. Nothing in :meth:`snapshot` does
    I/O — a screen holding a 25-second poll open must never be the reason a
    network call is in flight, and a network call must never be the reason a
    screen waits.
    """

    def __init__(self, router, *, idle_timeout_s: float = SESSION_IDLE_S,
                 scanner_status=None, upstream_status=None,
                 clock=time.time) -> None:
        self._router = router
        self._idle_timeout_s = float(idle_timeout_s)
        self._scanner_status = scanner_status or (lambda: {})
        self._upstream_status = upstream_status or (lambda: {})
        self._clock = clock
        self._cond = threading.Condition()
        self._seq = {screen: 1 for screen in SCREENS}
        self._flash = {screen: None for screen in SCREENS}
        self._last = None
        self._boxes = {"boxes": [], "fetched_at": None, "stale": True, "error": None}
        self._crew: list = []
        self._closed = False

    # -- writes -----------------------------------------------------------

    def bump(self, *screens: str) -> None:
        with self._cond:
            for screen in (screens or SCREENS):
                if screen in self._seq:
                    self._seq[screen] += 1
            self._cond.notify_all()

    def flash(self, screen: str, level: str, title: str, detail: str = "",
              code: str = "") -> None:
        """One line of feedback, which the screen shows and then forgets."""
        with self._cond:
            self._flash[screen] = {
                "level": level, "title": title, "detail": detail,
                "code": code, "at": self._clock(),
            }
            self._seq[screen] += 1
            self._cond.notify_all()

    def clear_flash(self, screen: str) -> None:
        with self._cond:
            self._flash[screen] = None
            self._seq[screen] += 1
            self._cond.notify_all()

    def set_last(self, payload) -> None:
        """The last thing that happened, which both screens now render.

        Both, because a machine scanned at a crate is refused there and
        mirrored to the rack: the box screen has to be able to show what it
        just turned away.
        """
        with self._cond:
            self._last = payload
            for screen in SCREENS:
                self._seq[screen] += 1
            self._cond.notify_all()

    def set_crew(self, people) -> None:
        """The name buttons. Only wakes the rack screen when they changed."""
        rows = [dict(person) for person in (people or []) if isinstance(person, dict)]
        with self._cond:
            if rows == self._crew:
                return
            self._crew = rows
            self._seq[SCREEN_RACK] += 1
            self._cond.notify_all()

    def crew(self) -> list:
        with self._cond:
            return [dict(person) for person in self._crew]

    def set_boxes(self, snapshot: dict) -> None:
        """Store the box list; wake the box screen only if it actually moved."""
        with self._cond:
            changed = _fingerprint(snapshot) != _fingerprint(self._boxes)
            self._boxes = snapshot
            if changed:
                self._seq[SCREEN_BOXES] += 1
                self._cond.notify_all()

    def boxes(self) -> dict:
        with self._cond:
            return self._boxes

    def close(self) -> None:
        """Wake every waiting poll so shutdown does not take 25 seconds."""
        with self._cond:
            self._closed = True
            self._cond.notify_all()

    # -- reads ------------------------------------------------------------

    def wait(self, screen: str, since, timeout: float) -> dict:
        """Block until this screen's sequence moves, or the timeout expires."""
        deadline = time.monotonic() + max(0.0, float(timeout))
        with self._cond:
            while not self._closed and since is not None and self._seq[screen] == since:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._cond.wait(remaining)
            return self._snapshot_locked(screen)

    def snapshot(self, screen: str) -> dict:
        with self._cond:
            return self._snapshot_locked(screen)

    def _snapshot_locked(self, screen: str) -> dict:
        scanner = self._scanner_status() or {}
        upstream = self._upstream_status() or {}
        payload = {
            "seq": self._seq[screen],
            "screen": screen,
            "scanner": {
                "active": bool(scanner.get("active")),
                "device": scanner.get("device"),
                "error": scanner.get("error"),
            },
            "upstream": {"ok": upstream.get("ok"), "error": upstream.get("error")},
            "flash": self._flash[screen],
            "session": self._session_payload(),
            "pending": self._router.pending() if self._router else None,
        }
        payload["last"] = self._last
        if screen == SCREEN_BOXES:
            payload["boxes"] = list(self._boxes.get("boxes") or [])
            # Whether the list is trustworthy is part of the list. Without
            # these three the crate screen cannot tell "no crates are open"
            # from "nobody could be asked", and shows the first while meaning
            # the second.
            payload["boxes_stale"] = bool(self._boxes.get("stale"))
            payload["boxes_error"] = self._boxes.get("error")
            payload["boxes_fetched_at"] = self._boxes.get("fetched_at")
        else:
            payload["direction"] = self._router.direction if self._router else "aus"
            payload["crew"] = [dict(person) for person in self._crew]
            payload["assignee"] = self._router.assignee if self._router else None
        return payload

    def _session_payload(self):
        session = self._router.session if self._router else None
        if session is None:
            return None
        box = self.find_box(code=session.code, box_number=session.box_number) or {}
        return {
            "box_id": box.get("id"),
            "box_number": session.box_number,
            "code": session.code,
            "label": box.get("label"),
            "customer": box.get("customer"),
            "project": box.get("project"),
            "status": box.get("status"),
            "opened_at": session.opened_at,
            "expires_at": session.last_at + self._idle_timeout_s,
            "mode": self._router.mode,
        }

    def find_box(self, *, box_id=None, code: str = "", box_number: str = ""):
        """One box out of the last snapshot, by id, code or number."""
        wanted_code = (code or "").strip().upper()
        wanted_number = (box_number or "").strip().upper()
        for box in (self._boxes.get("boxes") or []):
            if not isinstance(box, dict):
                continue
            if box_id is not None and box.get("id") == box_id:
                return box
            if wanted_code and str(box.get("code") or "").strip().upper() == wanted_code:
                return box
            if wanted_number and str(box.get("box_number") or "").strip().upper() == wanted_number:
                return box
        return None


def _fingerprint(snapshot) -> str:
    try:
        return json.dumps(snapshot, sort_keys=True, default=str)
    except (TypeError, ValueError):
        return repr(snapshot)


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
            "/setup": self._get_setup,
            "/setup.html": self._get_setup,
            "/preview.png": self._get_preview,
            "/sessions": lambda q: self._json(200, {"sessions": self.agent.store.sessions()}),
            "/pair/status": lambda q: self._json(200, self._station().pair_status()),
            "/imports": lambda q: self._json(200, self._station().imports(
                require_int(q, "limit", 50, 1, 500))),
            "/regal": lambda q: self._get_screen_page("kiosk_rack.html"),
            "/kisten": lambda q: self._get_screen_page("kiosk_boxes.html"),
            "/screen/state": self._get_screen_state,
            "/boxes/state": lambda q: self._json(200, self.agent.boxes_state()),
            "/now-playing": self._get_now_playing,
            "/now-playing/cover.jpg": self._get_cover,
            "/barcode.svg": self._get_barcode,
        }

        def run() -> None:
            self._require_local_if_needed(parsed.path)
            self._dispatch(table, parsed.path, query)

        self._guard(run)

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        table = {
            "/resolve": lambda q: self._post_resolve(),
            "/count": lambda q: self._post_count(),
            "/print": lambda q: self._post_print(),
            "/restart": lambda q: self._post_restart(),
            "/pair/start": lambda q: self._post_pair_start(),
            "/pair/cancel": lambda q: self._json(200, self._station().pair_cancel()),
            "/pair/forget": lambda q: self._json(200, self._station().unpair()),
            "/imports/rescan": lambda q: self._json(200, self._station().rescan()),
            "/imports/retry": lambda q: self._json(200, self._station().retry_uploads()),
            "/scan/route": lambda q: self._post_scan_route(),
            "/box/session": lambda q: self._post_box_session(),
            "/box/item": lambda q: self._post_box_item(),
            "/box/item/remove": lambda q: self._post_box_item_remove(),
            "/rack/movement": lambda q: self._post_rack_movement(),
            "/screen/action": lambda q: self._post_screen_action(),
        }

        def run() -> None:
            self._require_local_if_needed(parsed.path)
            self._dispatch(table, parsed.path, {})

        self._guard(run)

    def _require_local_if_needed(self, path: str) -> None:
        if path in LOOPBACK_ONLY:
            self._require_local()

    def _require_local(self) -> None:
        """The kiosk is two browsers on this very machine, reads included.

        The agent binds 0.0.0.0 on the Pi so a phone can open the station
        page, which means "reachable" and "trusted" stopped being the same
        thing the moment these routes could move stock — or hand out every
        customer, project and packed item on the crate screen, which a plain
        GET used to do to anybody on the workshop LAN.
        """
        address = self.client_address[0] if self.client_address else ""
        if not is_loopback(address):
            raise ApiError(403, "this route is local-only; %s is not this machine"
                                % (address or "the caller"))

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

    def _get_setup(self, _query: dict) -> None:
        """The one-time setup page: pairing, identity, imports.

        Deliberately a separate page from the station. station.html swallows
        every keystroke so a HID scanner can never type into the void, and a
        text field or a link fighting that logic is a good way to break the
        thing the station exists for.
        """
        page = STATIC_DIR / "setup.html"
        if not page.is_file():
            self._send(503, "text/plain; charset=utf-8",
                       b"static/setup.html is missing. Pair from the terminal instead:\n"
                       b"  python3 server.py --pair\n")
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

    # -- kiosk GET handlers -----------------------------------------------

    def _get_screen_page(self, filename: str) -> None:
        """Serve one of the two kiosk pages, or say which file is missing.

        The pages are another agent's files and may not exist yet. A 404 that
        names the file is more use than a blank screen on a wall.
        """
        page = STATIC_DIR / filename
        if not page.is_file():
            self._send(
                404, "text/plain; charset=utf-8",
                ("static/%s does not exist yet.\n"
                 "The kiosk API is up: try /screen/state?screen=regal, /boxes/state,\n"
                 "/now-playing and /health.\n" % filename).encode("utf-8"),
            )
            return
        self._send(200, "text/html; charset=utf-8", page.read_bytes())

    def _get_screen_state(self, query: dict) -> None:
        """The long poll. Answers at once on a changed sequence, else waits.

        The server is a ``ThreadingHTTPServer``, so a waiting screen occupies
        one thread and blocks nothing else - the wait is real, not a
        short-poll pretending. ``wait`` shortens the timeout (tests, and a
        screen that would rather poll quickly); it can never lengthen it.
        """
        screen = (query.get("screen") or "").strip()
        if screen not in SCREENS:
            raise ApiError(400, "'screen' must be one of %s" % ", ".join(SCREENS))
        since = query.get("since")
        parsed_since = None
        if since not in (None, ""):
            try:
                parsed_since = int(since)
            except (TypeError, ValueError):
                raise ApiError(400, "'since' must be a whole number") from None
        wait = query.get("wait")
        timeout = SCREEN_POLL_MAX_S
        if wait not in (None, ""):
            try:
                timeout = max(0.0, min(SCREEN_POLL_MAX_S, float(wait)))
            except (TypeError, ValueError):
                raise ApiError(400, "'wait' must be a number of seconds") from None
        self._json(200, self.agent.require_kiosk().wait(screen, parsed_since, timeout))

    def _get_now_playing(self, _query: dict) -> None:
        self.agent.require_kiosk()
        self._json(200, self.agent.now_playing.snapshot())

    def _get_cover(self, _query: dict) -> None:
        self.agent.require_kiosk()
        blob, art_hash = self.agent.now_playing.cover()
        if not blob or not art_hash:
            self._send(404, "text/plain; charset=utf-8",
                       b"no cover art for the current track\n")
            return
        etag = '"%s"' % art_hash
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        # Not `no-store` like the rest of the API: the whole point of the hash
        # is that a screen can keep the bytes until the track changes.
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(blob)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("ETag", etag)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(blob)

    def _get_barcode(self, query: dict) -> None:
        """Draw a Code 128 for the crate screen to be scanned off.

        The screen facing the construction boxes has no keyboard and no mouse,
        so the page embeds these as plain ``<img>`` tags and the worker points
        the handheld at the glass to get back to the overview or take back the
        last item.

        The errors are plain text on purpose. This route is only ever an image
        source, and a JSON body in an ``<img src>`` is invisible - whereas a
        developer who opens the URL to find out why the barcode is a broken
        image gets a sentence saying which character the agent refused.
        """
        barcode = module("barcode128")
        if barcode is None:
            self._plain(503, "barcode128 is unavailable: %s" % module_error("barcode128"))
            return

        text = (query.get("text") or "").strip()
        if not text:
            self._plain(400, "'text' query parameter is required")
            return
        if len(text) > BARCODE_MAX_CHARS:
            self._plain(400, "'text' is %d characters; the limit is %d"
                             % (len(text), BARCODE_MAX_CHARS))
            return

        # A quantity is clamped, but a character the symbology cannot carry is
        # refused: silently dropping it would draw a barcode that scans as a
        # code nothing in scan_router recognises, which is a worse afternoon
        # than a broken image.
        try:
            body = barcode.svg(
                text,
                height_px=self._barcode_height(query),
                module_px=self._barcode_module(query),
            ).encode("utf-8")
        except ValueError as exc:
            self._plain(400, str(exc))
            return

        # Deliberately not the API's ``no-store``: these six codes are fixed
        # for the life of the vocabulary, and a wall screen that redraws them
        # on every reload is asking the Pi for work that never changes.
        self.send_response(200)
        self.send_header("Content-Type", "image/svg+xml")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=%d" % BARCODE_MAX_AGE_S)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    @staticmethod
    def _barcode_height(query: dict) -> int:
        """``h`` in pixels: clamped, never refused.

        A height out of range is a page asking for a size, not a code the
        agent cannot draw, so it gets the nearest one it can. Only the text
        can turn this route into a 400.
        """
        raw = (query.get("h") or "").strip()
        height = BARCODE_DEFAULT_H
        if raw:
            try:
                height = int(float(raw))
            except ValueError:
                height = BARCODE_DEFAULT_H
        return max(BARCODE_MIN_H, min(BARCODE_MAX_H, height))

    @staticmethod
    def _barcode_module(query: dict) -> int:
        """``m``, the module width in pixels: clamped, never refused.

        Same rule as ``h`` - a size out of range is a page asking for
        something, not a code that cannot be drawn. It matters more than it
        looks: leaving this at the default drew every command code three
        times wider than the crate page had laid out for, and three of the
        five cards were clipped off the bottom of the wall screen.
        """
        raw = (query.get("m") or "").strip()
        module = BARCODE_DEFAULT_M
        if raw:
            try:
                module = int(float(raw))
            except ValueError:
                module = BARCODE_DEFAULT_M
        return max(BARCODE_MIN_M, min(BARCODE_MAX_M, module))

    def _plain(self, status: int, reason: str) -> None:
        self._send(status, "text/plain; charset=utf-8", (reason + "\n").encode("utf-8"))

    # -- kiosk POST handlers ----------------------------------------------

    def _post_scan_route(self) -> None:
        payload = self._read_json()
        code = require_str(payload, "code", max_len=256)
        source = require_str(payload, "source", max_len=32, required=False) or "wedge"
        self._json(200, self.agent.route_scan(code, source))

    def _post_box_session(self) -> None:
        payload = self._read_json()
        if payload.get("box_id") in (None, ""):
            self._json(200, self.agent.close_box_session())
            return
        box_id = require_int(payload, "box_id", 0, 1, 2 ** 31 - 1)
        self._json(200, self.agent.open_box_session(box_id))

    def _post_box_item(self) -> None:
        payload = self._read_json()
        box_id = require_int(payload, "box_id", 0, 1, 2 ** 31 - 1)
        code = require_str(payload, "code", max_len=256, required=False)
        article_id = None
        if payload.get("article_id") not in (None, ""):
            article_id = require_int(payload, "article_id", 0, 1, 2 ** 31 - 1)
        if not code and article_id is None:
            raise ApiError(400, "one of 'code' or 'article_id' is required")
        qty = require_int(payload, "qty", 1, 1, 9999)
        self._json(200, self.agent.add_box_item(box_id, code, article_id, qty))

    def _post_box_item_remove(self) -> None:
        payload = self._read_json()
        box_id = require_int(payload, "box_id", 0, 1, 2 ** 31 - 1)
        item_id = require_int(payload, "item_id", 0, 1, 2 ** 31 - 1)
        qty = require_int(payload, "qty", 1, 1, 9999)
        self._json(200, self.agent.remove_box_item(box_id, item_id, qty))

    def _post_rack_movement(self) -> None:
        payload = self._read_json()
        if payload.get("article_id") in (None, ""):
            raise ApiError(400, "'article_id' is required")
        article_id = require_int(payload, "article_id", 0, 1, 2 ** 31 - 1)
        movement_type = require_str(payload, "movement_type", max_len=32)
        self.agent.require_kiosk()
        allowed = self.agent.movement_types()
        if movement_type not in allowed:
            raise ApiError(400, "'movement_type' must be one of %s"
                                % ", ".join(sorted(allowed)))
        qty = require_int(payload, "qty", 1, 1, 9999)
        assignee = None
        if payload.get("assignee_user_id") not in (None, ""):
            assignee = require_int(payload, "assignee_user_id", 0, 1, 2 ** 31 - 1)
        self._json(200, self.agent.rack_movement(article_id, movement_type, qty, assignee))

    def _post_screen_action(self) -> None:
        payload = self._read_json()
        screen = require_str(payload, "screen", max_len=16)
        if screen not in SCREENS:
            raise ApiError(400, "'screen' must be one of %s" % ", ".join(SCREENS))
        action = require_str(payload, "action", max_len=32)
        self._json(200, self.agent.screen_action(screen, action, payload.get("value")))

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
        if path.startswith("/imports/"):
            import_id = urllib.parse.unquote(path[len("/imports/"):]).strip("/")
            if not IMPORT_ID_RE.match(import_id):
                raise ApiError(400, "malformed import id")
            detail = self._station().import_detail(import_id)
            if detail is None:
                raise ApiError(404, f"no import {import_id}")
            self._json(200, detail)
            return True
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

    def _station(self):
        station = self.agent.station
        if station is None:
            raise ApiError(
                503,
                "station services are not available: pairing and SD import were "
                "disabled or failed to load. Scanning, counting and printing are "
                "unaffected.",
            )
        return station

    def _post_pair_start(self) -> None:
        payload = self._read_json()
        name = require_str(payload, "device_name", max_len=120, required=False)
        self._json(200, self._station().pair_start(name))

    def _post_print(self) -> None:
        payload = self._read_json()
        code = require_str(payload, "code", max_len=128)
        title = require_str(payload, "title", max_len=256, required=False)
        subtitle = require_str(payload, "subtitle", max_len=256, required=False)
        self._json(200, self.agent.print_label(code, title, subtitle))

    def _post_restart(self) -> None:
        """Exit, and let systemd's ``Restart=always`` bring the agent back.

        LAN-reachable on purpose — SMPL's api calls it from the Scan-Station
        page, and SMPL is not this machine — which is exactly why it needs
        proof that the caller is SMPL and not a stray curl on the workshop
        LAN: the sha256 of the station token, which SMPL stores as the
        token's hash and only this Pi can compute from the token it holds.
        Constant-time compare, no oracle. Unpaired there is nothing to prove
        against, and a restart nobody can authorise is a restart nobody gets.
        Run by hand instead of under systemd the agent simply exits — the
        README says so.
        """
        self._read_json()  # consume the body; nothing in it is consulted
        token = self._station().token()
        if not token:
            raise ApiError(503, "not paired: there is no station token to prove a restart against")
        expected = hashlib.sha256(token.encode("utf-8")).hexdigest()
        offered = (self.headers.get(RESTART_PROOF_HEADER) or "").strip().lower()
        if not offered or not hmac.compare_digest(offered, expected):
            raise ApiError(403, "restart proof missing or wrong")
        self._json(200, {"ok": True, "detail": "restarting"})
        # The response is on the wire; a timer thread does the exiting.
        threading.Timer(RESTART_DELAY_S, _exit_for_restart).start()


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
    parser.add_argument("--device-name", default=os.environ.get("STATION_NAME", ""),
                        help="what this station calls itself when an admin approves it")
    parser.add_argument("--pair", action="store_true",
                        help="pair with SMPL from the terminal and exit (no server started)")
    parser.add_argument("--no-sd", action="store_true",
                        help="do not watch for SD cards from test instruments")
    parser.add_argument("--sd-simulate", metavar="DIR", default=os.environ.get("SD_SIMULATE", ""),
                        help="treat each subdirectory of DIR as an inserted card "
                             "(rehearse the whole import path with no hardware)")
    parser.add_argument("--sd-poll", type=float, default=float(os.environ.get("SD_POLL_S", "2.0")),
                        help="seconds between checks of the mount table")
    parser.add_argument("--make-fixtures", metavar="DIR",
                        help="write sample instrument cards into DIR and exit, for --sd-simulate")
    parser.add_argument("--no-scanner", action="store_true",
                        help="do not read the USB barcode scanner from /dev/input "
                             "(the browser wedge and POST /scan/route still work)")
    parser.add_argument("--scanner-device", default=os.environ.get("SCANNER_DEVICE", ""),
                        help="an explicit /dev/input node, instead of finding "
                             f"USB {input_reader_ids()} by itself")
    parser.add_argument("--scanner-layout", default=SCANNER_LAYOUT,
                        choices=("de", "us"),
                        help="the keyboard layout the scanner is configured for "
                             "(default de: the office scanner sends German scancodes, "
                             "so evdev 53 is a hyphen and Y/Z are swapped)")
    parser.add_argument("--no-now-playing", action="store_true",
                        help="do not read the AirPlay receiver's MPRIS properties over D-Bus")
    parser.add_argument("--session-idle", type=float,
                        default=float(os.environ.get("STATION_SESSION_IDLE_S", "600")),
                        help="seconds a box-filling session stays open with no scan "
                             "(default 600)")
    return parser


def input_reader_ids() -> str:
    """The scanner's USB ids, for --help, without importing at module scope."""
    mod = module("input_reader")
    if mod is None:
        return "1a86:5456"
    return "%s:%s" % (mod.VENDOR_ID, mod.PRODUCT_ID)


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    # One lazy import boundary for the whole station feature: pairing, SD
    # import and their CLI. If any of it is broken or absent, `helpers` is
    # None and the agent runs exactly as it did before the feature existed.
    helpers = module("station_cli")

    if args.make_fixtures:
        if helpers is None:
            print(f"cannot build fixtures: {module_error('station_cli')}")
            return 1
        return helpers.write_fixtures(args.make_fixtures, BASE_DIR)

    db_path = Path(args.db).expanduser()
    base_url = os.environ.get("SMPL_API_URL", "")
    env_token = os.environ.get("SMPL_API_TOKEN", "")

    # The heartbeat reports the printer's state to SMPL, but the station is
    # built before the printer exists (pairing must work with no hardware at
    # all). A late-bound holder keeps the construction order simple and means
    # a heartbeat that fires before the printer is warm reports "unknown"
    # rather than crashing.
    holder: dict = {}

    def station_status() -> dict:
        printer = holder.get("printer")
        if printer is None:
            return {}
        status = printer.status()
        body = {
            "printer_connected": bool(status.get("printer_connected")),
            "media_width_mm": status.get("media_width_mm"),
            "error": status.get("error"),
            "status": {
                "simulated": bool(status.get("simulated")),
                "queue_depth": printer.queue_depth(),
                "db": str(db_path),
            },
            # Where SMPL can call back. The port is ours to know; the host is
            # the address of the NIC that reaches SMPL — the request IP SMPL
            # sees is the office router, hairpinned, and useless for this.
            "port": args.port,
        }
        heartbeat_mod = module("station_heartbeat")
        if heartbeat_mod is not None:
            body["host"] = heartbeat_mod.detect_lan_ip(base_url)
        agent = holder.get("agent")
        if agent is not None:
            body["uptime_seconds"] = agent.uptime_seconds()
            body["session_count"] = agent.store.session_count()
            body["hardware"] = agent.hardware_summary(status)
        return body

    station = None
    if helpers is None:
        print(f"  station : unavailable ({module_error('station_cli')})")
    else:
        station = helpers.build_station(args, db_path, base_url, env_token, VERSION,
                                        status_provider=station_status)
    if args.pair:
        if helpers is None:
            print("station services are unavailable, so there is nothing to pair.")
            return 1
        return helpers.run_pairing_cli(station)

    store = Store(db_path)
    printer = Printer(enabled=not args.no_printer, default_tape_mm=args.tape)
    holder["printer"] = printer
    upstream = Upstream(
        base_url, env_token,
        token_provider=station.token if station is not None else None,
    )
    agent = Agent(
        store, printer, upstream, station=station,
        scanner_enabled=not args.no_scanner,
        now_playing_enabled=not args.no_now_playing,
        scanner_layout=args.scanner_layout,
        session_idle_s=args.session_idle,
    )
    holder["agent"] = agent
    if agent.scanner is not None and args.scanner_device:
        agent.scanner.set_device(args.scanner_device)
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
    if station is not None:
        identity = station.health()["identity"]
        source = identity["token_source"]
        print(f"  identity: {identity['device_name']} ({identity['device_id']}) - "
              f"{'paired' if identity['paired'] else 'not paired'}"
              f"{'' if source in ('paired', 'none') else f', using the {source} token'}")
        sd_status = station.health()["sd_import"]
        if sd_status.get("disabled"):
            print("  sd card : disabled (--no-sd)")
        else:
            print(f"  sd card : watching {sd_status['watch_root']}"
                  f"{' (simulated)' if sd_status['simulated'] else ''}")
        if not identity["token_file_secure"]:
            print("  !! the station token file is readable by other users; "
                  "fix with chmod 600")
    if agent.kiosk is None:
        print(f"  screens : unavailable ({agent.kiosk_error})")
    else:
        print(f"  screens : {url}regal and {url}kisten")
        scanner = agent.scanner.status()
        if not args.no_scanner:
            print("  scanner : %s (%s layout)"
                  % (scanner.get("device") or
                     "searching for USB %s" % input_reader_ids(),
                     scanner.get("layout") or args.scanner_layout))
        else:
            print("  scanner : disabled (--no-scanner); the browser wedge still types")
        print("  airplay : %s" % ("off (--no-now-playing)" if args.no_now_playing
                                  else "reading MPRIS over the system bus"))
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print(f"  !! bound to {args.host}: the agent has no authentication of its "
              "own, so anything that can reach this port can print and count.")
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
