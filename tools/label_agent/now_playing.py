"""What the office AirPlay receiver is playing, for the corner of a screen.

The Pi that runs the Werkstatt station is also the office AirPlay speaker:
shairport-sync 3.3.8, running as its own user, publishing MPRIS on the
**system** bus as ``org.mpris.MediaPlayer2.ShairportSync``. Two screens are
about to be on the wall all day, so showing the current track costs one
property read and buys a small amount of goodwill.

There is no Python D-Bus binding on the box and there is not going to be one —
``requirements.txt`` is two lines long on purpose. So this shells out to
``busctl --system --json=short get-property`` and parses the JSON, in a
polling thread, with a short timeout, never with a shell.

Verified on the Pi as the ``pi`` user, which is not shairport-sync, so a
non-owning user is allowed to read these properties:

    {"type":"s","data":"Stopped"}
    {"type":"a{sv}","data":{"mpris:artUrl":{"type":"s","data":
      "file:///tmp/shairport-sync/.cache/coverart/cover-<md5>.jpg"}, …}}

**The cover lives under /tmp, and ``smpl-station.service`` sets
``PrivateTmp=yes``.** Inside that unit's mount namespace the file simply does
not exist, so the artwork degrades to "no artwork" and the track title still
shows. Fixing it is a systemd drop-in, not a code change; see the README of
this change set. Nothing here assumes it was fixed.

Everything is non-fatal. No ``busctl``, a D-Bus policy denial, a cover file
that cannot be read, shairport not running at all: every one of them is
``{"playing": false}`` and a line in ``/health``.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import threading
import time
import urllib.parse
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple

__all__ = ["NowPlaying", "BUS_NAME", "OBJECT_PATH", "PLAYER_INTERFACE"]

BUS_NAME = "org.mpris.MediaPlayer2.ShairportSync"
OBJECT_PATH = "/org/mpris/MediaPlayer2"
PLAYER_INTERFACE = "org.mpris.MediaPlayer2.Player"

DEFAULT_COVER_ROOT = "/tmp/shairport-sync"
DEFAULT_POLL_PLAYING_S = 2.0
DEFAULT_POLL_IDLE_S = 10.0
DEFAULT_TIMEOUT_S = 2.0
MAX_COVER_BYTES = 2 * 1024 * 1024

IDLE = {
    "playing": False,
    "title": None,
    "artist": None,
    "album": None,
    "art_hash": None,
    "since": None,
}


def _run_busctl(argv, timeout: float) -> Tuple[int, str, str]:
    """The default runner: a list of arguments, no shell, a hard timeout."""
    completed = subprocess.run(  # noqa: S603 - fixed argv, no shell
        argv, capture_output=True, text=True, timeout=timeout, check=False,
    )
    return completed.returncode, completed.stdout, completed.stderr


def _variant(payload: Any) -> Any:
    """Unwrap busctl's ``{"type": …, "data": …}`` envelope."""
    if isinstance(payload, dict) and "data" in payload:
        return payload["data"]
    return None


def _text(value: Any) -> Optional[str]:
    """One display string out of a D-Bus string or array-of-strings."""
    inner = _variant(value)
    if isinstance(inner, str):
        return inner.strip() or None
    if isinstance(inner, list):
        parts = [str(item).strip() for item in inner if isinstance(item, str) and item.strip()]
        return ", ".join(parts) or None
    return None


class NowPlaying:
    """A polling reader for shairport-sync's MPRIS properties."""

    def __init__(self, *, runner: Optional[Callable[[Any, float], Tuple[int, str, str]]] = None,
                 clock: Callable[[], float] = time.time,
                 cover_root: str = DEFAULT_COVER_ROOT,
                 poll_playing_s: float = DEFAULT_POLL_PLAYING_S,
                 poll_idle_s: float = DEFAULT_POLL_IDLE_S,
                 timeout_s: float = DEFAULT_TIMEOUT_S,
                 max_cover_bytes: int = MAX_COVER_BYTES,
                 log: Optional[Callable[[str], None]] = None) -> None:
        self._runner = runner or _run_busctl
        self._clock = clock
        self.cover_root = Path(cover_root)
        self.poll_playing_s = float(poll_playing_s)
        self.poll_idle_s = float(poll_idle_s)
        self.timeout_s = float(timeout_s)
        self.max_cover_bytes = int(max_cover_bytes)
        self._log = log

        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._state: Dict[str, Any] = dict(IDLE)
        self._track_key = ""
        self._cover: Optional[bytes] = None
        self._cover_path = ""
        self._cover_error: Optional[str] = None
        self._error: Optional[str] = None
        self._logged: Optional[str] = None
        self._polls = 0

    # -- lifecycle --------------------------------------------------------

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="now-playing", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def join(self, timeout: Optional[float] = None) -> None:
        thread = self._thread
        if thread is not None:
            thread.join(timeout)

    def is_alive(self) -> bool:
        thread = self._thread
        return bool(thread is not None and thread.is_alive())

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.poll_once()
            except Exception as exc:  # noqa: BLE001 - a widget may never crash the agent
                self._fail("%s: %s" % (type(exc).__name__, exc))
            if self._stop.wait(self.interval()):
                return

    def interval(self) -> float:
        with self._lock:
            return self.poll_playing_s if self._state["playing"] else self.poll_idle_s

    # -- reading ----------------------------------------------------------

    def poll_once(self) -> None:
        """One pass over the bus. Never raises."""
        with self._lock:
            self._polls += 1
        status = self._property("PlaybackStatus")
        if status is None:
            self._go_idle()
            return
        playing = _variant(status) == "Playing"
        if not playing:
            self._succeed()
            self._go_idle()
            return

        metadata = _variant(self._property("Metadata"))
        fields = metadata if isinstance(metadata, dict) else {}
        self._succeed()
        self._apply(fields)

    def _property(self, name: str) -> Optional[Dict[str, Any]]:
        argv = ["busctl", "--system", "--json=short", "get-property",
                BUS_NAME, OBJECT_PATH, PLAYER_INTERFACE, name]
        try:
            code, out, err = self._runner(argv, self.timeout_s)
        except FileNotFoundError:
            self._fail("busctl is not installed on this machine")
            return None
        except subprocess.TimeoutExpired:
            self._fail("busctl timed out reading %s" % name)
            return None
        except Exception as exc:  # noqa: BLE001 - permissions, OSError, anything
            self._fail("%s: %s" % (type(exc).__name__, exc))
            return None
        if code != 0:
            self._fail((err or out or "busctl exited %d" % code).strip()[:300])
            return None
        try:
            payload = json.loads(out)
        except ValueError:
            self._fail("busctl did not answer with JSON")
            return None
        if not isinstance(payload, dict) or "data" not in payload:
            self._fail("busctl answered an unexpected shape")
            return None
        return payload

    # -- state ------------------------------------------------------------

    def _apply(self, fields: Dict[str, Any]) -> None:
        title = _text(fields.get("xesam:title"))
        artist = _text(fields.get("xesam:artist"))
        album = _text(fields.get("xesam:album"))
        track_id = _text(fields.get("mpris:trackid")) or ""
        art_url = _text(fields.get("mpris:artUrl"))

        key = "%s|%s|%s" % (track_id, title or "", artist or "")
        with self._lock:
            started = self._state["since"] if key == self._track_key else self._clock()
            self._track_key = key

        blob, art_hash, cover_error = self._load_cover(art_url)
        with self._lock:
            self._state = {
                "playing": True,
                "title": title,
                "artist": artist,
                "album": album,
                "art_hash": art_hash,
                "since": started if started is not None else self._clock(),
            }
            self._cover = blob
            self._cover_error = cover_error

    def _go_idle(self) -> None:
        with self._lock:
            self._state = dict(IDLE)
            self._track_key = ""
            self._cover = None
            self._cover_path = ""

    # -- the cover --------------------------------------------------------

    def cover(self) -> Tuple[Optional[bytes], Optional[str]]:
        """The artwork bytes and their ETag, or ``(None, None)``."""
        with self._lock:
            return self._cover, self._state["art_hash"]

    def _load_cover(self, art_url: Optional[str]) -> Tuple[Optional[bytes], Optional[str], Optional[str]]:
        if not art_url:
            return None, None, None
        parsed = urllib.parse.urlparse(art_url)
        if parsed.scheme != "file":
            return None, None, "Cover-URL ist keine Datei (%s)." % (parsed.scheme or "?")
        raw_path = urllib.parse.unquote(parsed.path)
        try:
            target = Path(raw_path).resolve()
            root = self.cover_root.resolve()
        except OSError as exc:
            return None, None, "Cover-Pfad nicht lesbar: %s" % exc

        # shairport-sync writes covers under one directory. Anything claiming
        # to be somewhere else is either a bug or an attempt to have the agent
        # read a file for a stranger, and both answers are "no".
        try:
            target.relative_to(root)
        except ValueError:
            return None, None, "Cover liegt ausserhalb von %s." % root

        try:
            size = target.stat().st_size
        except OSError as exc:
            # The overwhelmingly likely cause on the Pi: PrivateTmp=yes, so
            # /tmp/shairport-sync does not exist inside this unit at all.
            return None, None, "Cover nicht lesbar (%s)." % (exc.strerror or "Fehler")
        if size > self.max_cover_bytes:
            return None, None, "Cover ist zu groß (%d Bytes)." % size
        try:
            blob = target.read_bytes()
        except OSError as exc:
            return None, None, "Cover nicht lesbar (%s)." % (exc.strerror or "Fehler")
        if len(blob) > self.max_cover_bytes:
            return None, None, "Cover ist zu groß (%d Bytes)." % len(blob)
        return blob, hashlib.sha256(blob).hexdigest()[:12], None

    # -- reporting --------------------------------------------------------

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return dict(self._state)

    def status(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "running": self.is_alive(),
                "polls": self._polls,
                "error": self._error,
                "cover_error": self._cover_error,
                "cover_root": str(self.cover_root),
                "playing": self._state["playing"],
            }

    def _fail(self, message: str) -> None:
        with self._lock:
            self._error = message
            changed = self._logged != message
            if changed:
                self._logged = message
        if changed:
            self._note("now-playing unavailable: %s" % message)

    def _succeed(self) -> None:
        with self._lock:
            self._error = None
            self._logged = None

    def _note(self, message: str) -> None:
        if self._log is not None:
            try:
                self._log(message)
            except Exception:  # noqa: BLE001
                pass
