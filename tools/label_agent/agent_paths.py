"""Where the agent keeps its state, and how it writes the secret parts.

One tiny module rather than three copies of ``Path.home() / ".smpl-label-agent"``,
because the Pi install has to be able to say *one* directory to back up, to
`chown`, and to wipe when a station is decommissioned.

Everything the agent owns lives under ``AGENT_STATE_DIR`` (default
``~/.smpl-label-agent``):

    inventory.db          the counts - the product
    device-id             a stable identity for this station, created once
    station-token.json    the paired SMPL token, mode 0600
    imports/              staged SD-card imports, one directory per import

The directory itself is created 0700. On a Pi the agent runs as its own
service user, so "0700 owned by smpl-station" is the whole access control
story and it needs to hold without anybody remembering to set it.
"""

from __future__ import annotations

import os
import stat
import uuid
from pathlib import Path

__all__ = [
    "state_dir",
    "imports_dir",
    "token_file",
    "device_id",
    "write_private",
    "is_private",
]

_DEFAULT_STATE_DIR = "~/.smpl-label-agent"


def state_dir() -> Path:
    """The agent's state directory, created 0700 if it does not exist."""
    path = Path(os.environ.get("AGENT_STATE_DIR", _DEFAULT_STATE_DIR)).expanduser()
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def imports_dir() -> Path:
    """Where staged SD-card imports land."""
    path = state_dir() / "imports"
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def token_file() -> Path:
    return state_dir() / "station-token.json"


def device_id() -> str:
    """A stable, opaque identity for this physical station.

    Written once and reused forever. It is not a secret - it is what the
    pairing screen shows an admin so they can tell "the office station" from
    "the one on the van" - so it is deliberately readable (0644) and survives
    re-pairing. Losing it is harmless; the station simply looks new.
    """
    path = state_dir() / "device-id"
    try:
        existing = path.read_text(encoding="utf-8").strip()
        if existing:
            return existing
    except (OSError, UnicodeDecodeError):
        pass
    fresh = f"station-{uuid.uuid4().hex[:12]}"
    try:
        path.write_text(fresh + "\n", encoding="utf-8")
    except OSError:
        # A read-only state dir must not stop the agent booting; the id then
        # simply changes per process, which only costs a re-pair.
        pass
    return fresh


def write_private(path: Path, data: str) -> None:
    """Write a secret so it is never briefly world-readable.

    The file is created with 0600 *before* anything is written to it (via
    ``os.open`` with the mode, not ``chmod`` afterwards) because the window
    between "file exists with default umask" and "chmod ran" is exactly when
    another local user gets to read a station token. Then the content is
    written to a temporary file and renamed, so a crash mid-write leaves the
    previous token intact rather than a truncated one.
    """
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(path.name + ".tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(str(tmp), flags, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        try:
            os.unlink(str(tmp))
        except OSError:
            pass
        raise
    os.chmod(str(tmp), 0o600)
    os.replace(str(tmp), str(path))


def is_private(path: Path) -> bool:
    """True if *path* is readable only by its owner. Used by /health."""
    try:
        mode = path.stat().st_mode
    except OSError:
        return False
    return not mode & (stat.S_IRWXG | stat.S_IRWXO)
