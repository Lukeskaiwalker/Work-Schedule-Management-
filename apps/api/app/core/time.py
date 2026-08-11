from __future__ import annotations

from datetime import datetime, timezone


def utcnow() -> datetime:
    """Return naive UTC datetime without using deprecated utcnow()."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def to_naive_utc(value: datetime | None) -> datetime | None:
    """Coerce an incoming datetime to the naive-UTC form the models store.

    Every timestamp column in this app is naive UTC, and every comparison in
    the services is made against `utcnow()`, which is also naive. A tz-aware
    value reaching that code raises "can't compare offset-naive and
    offset-aware datetimes" — a 500, not a validation error.

    Clients legitimately send aware timestamps: a browser `datetime-local`
    input converted with `toISOString()` carries a `Z`, which is the correct
    thing for a client to send. Normalising here means the boundary absorbs
    that instead of every service having to remember to.
    """
    if value is None:
        return None
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)
