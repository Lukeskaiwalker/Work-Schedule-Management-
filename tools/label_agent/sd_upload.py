"""Hand a staged SD-card import to SMPL, or keep it safe until SMPL exists.

The station's promise about test protocols is that they are *never lost*. That
promise is kept by :mod:`sd_import` - the files are copied, hashed and
manifested before this module is ever called. Uploading is the optimistic
second half, and it is allowed to fail forever without anybody losing data.

So the states an import can be in are, in order of happiness:

    uploaded     SMPL has it
    pending      staged here, not yet sent
    failed       staged here, the send was tried and did not work (retried)
    unavailable  staged here, and this SMPL server has no import endpoint yet

``unavailable`` is not an error condition. At the time of writing the SMPL
side is being built in parallel, so it is the *expected* state, and the
operator instruction is the same in all three unhappy cases: the files are in
the staging directory, copy them off if you need them today.

Because the receiving contract does not exist yet, this sends the least
presumptuous thing that could work: a multipart POST carrying ``manifest.json``
plus the raw files under their manifest paths. If SMPL later wants a different
shape, one function changes.
"""

from __future__ import annotations

import json
import mimetypes
import queue
import threading
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

__all__ = ["ImportUploader", "UPLOAD_PATHS"]

UPLOAD_PATHS = (
    "/api/station/imports",
    "/api/station/import",
    "/api/station/sd-imports",
    "/api/werkstatt/inspections/imports",
)

REQUEST_TIMEOUT_S = 60.0
MAX_UPLOAD_BYTES = 64 * 1024 * 1024
MAX_ATTEMPTS = 5
BACKOFF_BASE_S = 30.0
MAX_BACKOFF_S = 900.0


@dataclass
class UploadOutcome:
    status: str  # uploaded | failed | unavailable | skipped
    detail: str = ""


class ImportUploader:
    """A single background worker that drains staged imports to SMPL.

    One worker, not a pool: uploads are large, the link is a small office
    connection, and nothing about a test protocol is urgent to the second.
    Serialising them also means a retry storm cannot starve the scan path.
    """

    def __init__(self, store, *, base_url: str = "", token_provider=None,
                 user_agent: str = "smpl-label-agent") -> None:
        self.store = store
        self.base_url = (base_url or "").rstrip("/")
        self._token_provider = token_provider
        self.user_agent = user_agent
        self._queue: "queue.Queue[str]" = queue.Queue()
        self._worker: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._attempts: Dict[str, int] = {}
        self._path = ""
        self._last: Dict[str, Any] = {}

    @property
    def configured(self) -> bool:
        return bool(self.base_url)

    def _token(self) -> str:
        if self._token_provider is None:
            return ""
        try:
            return self._token_provider() or ""
        except Exception:  # noqa: BLE001 - a broken provider must not stop staging
            return ""

    # -- queue ------------------------------------------------------------

    def submit(self, import_id: str) -> None:
        if not self.configured:
            self.store.set_upload(import_id, "unavailable", "SMPL_API_URL is not configured")
            return
        self._ensure_worker()
        self._queue.put(import_id)

    def submit_pending(self) -> int:
        """Re-queue everything that has not made it to SMPL yet."""
        if not self.configured:
            return 0
        rows = self.store.pending(limit=50)
        for row in rows:
            self.submit(row["import_id"])
        return len(rows)

    def stop(self) -> None:
        self._stop.set()

    def _ensure_worker(self) -> None:
        with self._lock:
            if self._worker is not None and self._worker.is_alive():
                return
            self._stop.clear()
            self._worker = threading.Thread(
                target=self._drain, name="sd-upload", daemon=True
            )
            self._worker.start()

    def _drain(self) -> None:
        while not self._stop.is_set():
            try:
                import_id = self._queue.get(timeout=1.0)
            except queue.Empty:
                continue
            try:
                outcome = self.upload(import_id)
                self.store.set_upload(import_id, outcome.status, outcome.detail)
                with self._lock:
                    self._last = {"import_id": import_id, "status": outcome.status,
                                  "detail": outcome.detail}
                if outcome.status == "failed":
                    self._retry_later(import_id)
            except Exception as exc:  # noqa: BLE001 - the worker must survive anything
                self.store.set_upload(import_id, "failed", "%s: %s" % (type(exc).__name__, exc))
            finally:
                self._queue.task_done()

    def _retry_later(self, import_id: str) -> None:
        attempts = self._attempts.get(import_id, 0) + 1
        self._attempts[import_id] = attempts
        if attempts >= MAX_ATTEMPTS:
            self.store.set_upload(
                import_id, "failed",
                "gave up after %d attempts; the files are still staged locally" % attempts,
            )
            return
        delay = min(MAX_BACKOFF_S, BACKOFF_BASE_S * (2 ** (attempts - 1)))
        timer = threading.Timer(delay, lambda: self._queue.put(import_id))
        timer.daemon = True
        timer.start()

    # -- the send ---------------------------------------------------------

    def upload(self, import_id: str) -> UploadOutcome:
        row = self.store.get(import_id)
        if row is None:
            return UploadOutcome("failed", "no such import")
        directory = Path(row.get("directory") or "")
        manifest_path = directory / "manifest.json"
        if not manifest_path.is_file():
            return UploadOutcome("failed", "manifest.json is missing from %s" % directory)

        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            return UploadOutcome("failed", "unreadable manifest: %s" % exc)

        parts, total = self._collect(directory, manifest)
        if total > MAX_UPLOAD_BYTES:
            return UploadOutcome(
                "failed",
                "import is %d bytes, over the %d upload limit; copy it off by hand"
                % (total, MAX_UPLOAD_BYTES),
            )

        body, content_type = _multipart(parts)
        candidates = [self._path] if self._path else list(UPLOAD_PATHS)
        transport_errors: List[str] = []

        for path in candidates:
            status, detail = self._post(path, body, content_type)
            if status == 0:
                transport_errors.append("%s: %s" % (path, detail))
                continue
            if status in (404, 405, 501):
                continue
            if 200 <= status < 300:
                self._path = path
                return UploadOutcome("uploaded", detail[:400])
            if status in (401, 403):
                return UploadOutcome(
                    "failed",
                    "SMPL rejected the station's credentials (HTTP %d) - re-pair the station"
                    % status,
                )
            if status == 409:
                # SMPL already has this import; that is success, not failure.
                self._path = path
                return UploadOutcome("uploaded", "already present in SMPL")
            return UploadOutcome("failed", "HTTP %d: %s" % (status, detail[:300]))

        if transport_errors:
            return UploadOutcome("failed", "; ".join(transport_errors[:3]))
        return UploadOutcome(
            "unavailable",
            "this SMPL server has no station import endpoint yet; the files stay staged in %s"
            % directory,
        )

    @staticmethod
    def _collect(directory: Path, manifest: Dict[str, Any]) -> Tuple[List[Tuple], int]:
        """manifest.json, parsed.json if there is one, and every staged file."""
        parts: List[Tuple] = [
            ("manifest", "manifest.json", "application/json",
             json.dumps(manifest, ensure_ascii=False).encode("utf-8")),
        ]
        total = len(parts[0][3])

        parsed = directory / "parsed.json"
        if parsed.is_file():
            data = parsed.read_bytes()
            parts.append(("parsed", "parsed.json", "application/json", data))
            total += len(data)

        files_dir = directory / "files"
        for entry in manifest.get("files") or []:
            relative = str(entry.get("path") or "")
            if not relative:
                continue
            source = files_dir / relative
            if not source.is_file():
                continue
            data = source.read_bytes()
            guessed = mimetypes.guess_type(relative)[0] or "application/octet-stream"
            parts.append(("files", relative, guessed, data))
            total += len(data)
        return parts, total

    def _post(self, path: str, body: bytes, content_type: str) -> Tuple[int, str]:
        request = urllib.request.Request(self.base_url + path, data=body, method="POST")
        request.add_header("Content-Type", content_type)
        request.add_header("Accept", "application/json")
        request.add_header("User-Agent", self.user_agent)
        token = self._token()
        if token:
            request.add_header("Authorization", "Bearer %s" % token)
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_S) as handle:  # noqa: S310
                return handle.status, handle.read(64 * 1024).decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            try:
                detail = exc.read(64 * 1024).decode("utf-8", "replace")
            except Exception:  # noqa: BLE001
                detail = ""
            return exc.code, detail
        except Exception as exc:  # noqa: BLE001
            return 0, "%s: %s" % (type(exc).__name__, exc)

    # -- reporting --------------------------------------------------------

    def status(self) -> Dict[str, Any]:
        with self._lock:
            last = dict(self._last)
        return {
            "configured": self.configured,
            "base_url": self.base_url or None,
            "endpoint": self._path or None,
            "queued": self._queue.qsize(),
            "authenticated": bool(self._token()),
            "last": last or None,
        }


def _multipart(parts: List[Tuple]) -> Tuple[bytes, str]:
    """Encode multipart/form-data by hand - stdlib has no encoder.

    Field names and filenames are quoted with backslash escaping so a card
    whose filename contains a quote or a newline cannot inject extra headers
    into the request.
    """
    boundary = "----smpl-station-%s" % uuid.uuid4().hex
    buffer = bytearray()
    for field, filename, content_type, data in parts:
        buffer += b"--" + boundary.encode("ascii") + b"\r\n"
        buffer += (
            'Content-Disposition: form-data; name="%s"; filename="%s"\r\n'
            % (_quote(field), _quote(filename))
        ).encode("utf-8")
        buffer += ("Content-Type: %s\r\n\r\n" % _quote(content_type)).encode("utf-8")
        buffer += data
        buffer += b"\r\n"
    buffer += b"--" + boundary.encode("ascii") + b"--\r\n"
    return bytes(buffer), "multipart/form-data; boundary=%s" % boundary


def _quote(value: str) -> str:
    return (
        str(value)
        .replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\r", "")
        .replace("\n", "")
    )
