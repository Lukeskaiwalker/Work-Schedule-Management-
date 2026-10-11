"""Tokens of bookings SMPL never answered, held for the re-scan.

A rack booking carries a ``request_id`` so SMPL can replay instead of booking
twice. The client retries a dead connection once under the same token -- but
after two timeouts the wall says *„Nicht gebucht · SMPL ist nicht
erreichbar"*, and the first try may have landed all the same (SMPL was slow,
not gone). The operator reads that and scans the same thing again. Minting a
new token for that scan books the parts a second time; handing back the old
one lets SMPL replay the booking that landed, or book it once if none did.

So the token outlives the attempt, keyed by what makes two bookings "the same
thing" (for a consumption: article, quantity, person, project). Any answer
from SMPL -- booked, replayed or refused -- frees it. Much later the same
scan is a new booking, so a token is only held for :data:`KEEP_REQUEST_ID_S`.

Pure functions over an immutable tuple: ``scan_router`` keeps the tuple in its
frozen state, under its lock, and this module never touches either.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional, Tuple

#: How long a token is kept for a re-scan of the same thing, from the last
#: failed try. Long enough for somebody who reads "nicht erreichbar" to try
#: again, short enough that the same scan an hour later is a booking of its own.
KEEP_REQUEST_ID_S = 600.0

#: At most this many are held -- an outage at a busy rack, not a list that
#: grows for as long as the agent runs.
MAX_KEPT_REQUEST_IDS = 16


@dataclass(frozen=True)
class KeptRequestId:
    """One booking's token. ``key`` is only ever compared; ``at`` is the last
    failed try."""

    key: Tuple[Any, ...]
    request_id: str
    at: float


Held = Tuple[KeptRequestId, ...]


def live(held: Held, now: float) -> Held:
    """The tokens still young enough to be handed back."""
    return tuple(kept for kept in held if now - kept.at <= KEEP_REQUEST_ID_S)


def kept(held: Held, key: Tuple[Any, ...], now: float) -> Optional[str]:
    """The token held for exactly this booking, or None."""
    for item in live(held, now):
        if item.key == key:
            return item.request_id
    return None


def keep(held: Held, key: Tuple[Any, ...], request_id: str, now: float) -> Held:
    """A new tuple holding ``request_id`` for ``key`` from ``now``.

    An empty token holds nothing. Another failed try of the same booking holds
    it again from now; the oldest go first once there are too many.
    """
    token = str(request_id or "").strip()
    if not token:
        return held
    others = tuple(item for item in live(held, now) if item.key != key)
    return (others + (KeptRequestId(key=key, request_id=token, at=now),))[-MAX_KEPT_REQUEST_IDS:]


def drop(held: Held, key: Tuple[Any, ...]) -> Held:
    """A new tuple without ``key``'s token: SMPL answered that booking."""
    return tuple(item for item in held if item.key != key)
