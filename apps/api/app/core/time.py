from __future__ import annotations

from datetime import datetime, timezone


def utcnow() -> datetime:
    """Return naive UTC datetime without using deprecated utcnow()."""
    return datetime.now(timezone.utc).replace(tzinfo=None)
