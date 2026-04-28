"""Filesystem-side backup management for the runner sidecar.

The runner is the only component with a bind mount to the host's repo, so
listing, reading, writing and deleting files in ``backups/`` happens here.
The api proxies to these helpers via HTTP so it never touches the host
filesystem directly.

Two safety properties this module is responsible for:

1. **Path containment.** Every operation resolves the target path and verifies
   it stays inside ``REPO_ROOT/backups``. A caller passing ``../etc/passwd``
   gets ``InvalidBackupName`` instead of escaping the directory.
2. **Filename whitelisting.** Only files matching the encrypted-archive shape
   (``backup-YYYYMMDD-HHMMSS.tar.enc`` plus a small allowance for operator
   uploads) are visible or addressable. Stray files in the directory — log
   tails, lockfiles, half-decrypted scratch files — never leak through the
   API surface.
"""
from __future__ import annotations

import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from .config import REPO_ROOT


# The directory the scripts/backup.sh script writes into. Resolved once at
# import time; ``ensure_backup_dir`` makes it concrete on first use.
BACKUP_DIR: Path = REPO_ROOT / "backups"


# Permitted filename shapes. The first matches what scripts/backup.sh produces;
# the second is a relaxed form for operator uploads (still .tar.enc, still no
# directory separators or dotted parents). Anything else is rejected outright.
# The user-upload regex requires a non-dot first character so hidden filenames
# like `.hidden.tar.enc` and `.DS_Store.tar.enc` cannot sneak in — they would
# otherwise pass the simple charset class because `.` is a legal subsequent
# character but should never start a filename here.
_FILENAME_GENERATED = re.compile(r"^backup-\d{8}-\d{6}\.tar\.enc$")
_FILENAME_USER_UPLOAD = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}\.tar\.enc$")


class InvalidBackupName(ValueError):
    """Raised when a caller-supplied filename fails the safety checks."""


@dataclass(frozen=True)
class BackupFileInfo:
    filename: str
    size_bytes: int
    created_at: str  # ISO-8601 from the file's mtime
    is_generated: bool  # True for backup-<ts>.tar.enc, False for uploaded files


def ensure_backup_dir() -> Path:
    """Create the backups dir if it does not yet exist and return its Path."""
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    return BACKUP_DIR


def is_valid_filename(name: str) -> bool:
    """Return True iff ``name`` matches one of the permitted filename shapes.

    Validates the *string* only — no filesystem touch. Used for upload preflight
    where the file does not yet exist.
    """
    if not name or "/" in name or "\\" in name or ".." in name:
        return False
    if _FILENAME_GENERATED.match(name):
        return True
    if _FILENAME_USER_UPLOAD.match(name):
        return True
    return False


def safe_resolve(filename: str) -> Path:
    """Return the absolute Path for a backup filename, or raise.

    Defense in depth: even after the regex check, we resolve the path and
    confirm it lives under BACKUP_DIR. If the bind mount ever changes, this
    catches accidental escapes (symlinks pointing out, future regex bugs).
    """
    if not is_valid_filename(filename):
        raise InvalidBackupName(f"Rejected backup filename: {filename!r}")
    candidate = (BACKUP_DIR / filename).resolve()
    backup_dir_resolved = BACKUP_DIR.resolve()
    try:
        candidate.relative_to(backup_dir_resolved)
    except ValueError as exc:
        raise InvalidBackupName(
            f"Filename {filename!r} resolves outside the backups directory"
        ) from exc
    return candidate


def list_backups() -> list[BackupFileInfo]:
    """Return metadata for every recognised backup file, newest first.

    Files that don't match a permitted filename shape are silently skipped —
    we don't want a stray editor swap-file or a half-written upload to break
    the listing. The mtime, not ctime, is reported as ``created_at`` because
    upload-then-rename flows reset ctime on macOS docker-desktop volumes.
    """
    ensure_backup_dir()
    out: list[BackupFileInfo] = []
    for entry in BACKUP_DIR.iterdir():
        if not entry.is_file():
            continue
        if not is_valid_filename(entry.name):
            continue
        stat = entry.stat()
        from datetime import datetime, timezone
        created_at = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()
        out.append(
            BackupFileInfo(
                filename=entry.name,
                size_bytes=int(stat.st_size),
                created_at=created_at,
                is_generated=bool(_FILENAME_GENERATED.match(entry.name)),
            )
        )
    out.sort(key=lambda item: item.created_at, reverse=True)
    return out


def open_for_read(filename: str) -> tuple[Path, int]:
    """Resolve ``filename`` and return (path, size_bytes). Raises on missing."""
    path = safe_resolve(filename)
    if not path.is_file():
        raise FileNotFoundError(filename)
    return path, int(path.stat().st_size)


def write_uploaded_chunks(filename: str, chunks: Iterable[bytes]) -> int:
    """Stream ``chunks`` into the backups directory under ``filename``.

    Writes via a ``.tmp`` sidecar file then renames atomically so a crashed
    upload never leaves a half-written file masquerading as a real backup.
    Returns the total byte count.
    """
    path = safe_resolve(filename)
    ensure_backup_dir()
    tmp_path = path.with_name(path.name + ".tmp")
    total = 0
    try:
        with tmp_path.open("wb") as handle:
            for chunk in chunks:
                if not chunk:
                    continue
                handle.write(chunk)
                total += len(chunk)
        tmp_path.replace(path)
    except Exception:
        # Best-effort cleanup so a failed upload doesn't litter the directory
        # with half-written .tmp files. The ``replace`` succeeds atomically or
        # not at all, so once we've passed it the rename is committed.
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except OSError:
            pass
        raise
    return total


def delete_backup(filename: str) -> bool:
    """Remove the named backup. Returns True if a file was deleted."""
    path = safe_resolve(filename)
    if not path.is_file():
        return False
    path.unlink()
    return True


def disk_usage() -> tuple[int, int]:
    """Return (total_bytes, free_bytes) for the backups directory's filesystem.

    Surfaced via the runner's status response so the admin UI can warn before
    the operator triggers a backup that would exhaust the partition.
    """
    ensure_backup_dir()
    usage = shutil.disk_usage(BACKUP_DIR)
    return int(usage.total), int(usage.free)
