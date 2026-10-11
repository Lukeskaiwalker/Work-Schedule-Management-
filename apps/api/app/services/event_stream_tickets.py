"""Single-use tickets that open the live-update stream.

Why they exist: EventSource cannot send an Authorization header, so a client
that has no session cookie to fall back on has to put its credential in the
URL — and the URL is what every access log prints. Until now that credential
was the session JWT itself, valid for eight hours. The native iOS shell is
such a client (its SameSite=Strict cookie never travels cross-origin from
``capacitor://localhost``), and a browser whose cookie is missing becomes one.

A ticket is what goes in the URL instead. It is minted by an ordinary
authenticated POST, is good for one connection within a minute, and is
nothing else — not a session, not a JWT. By the time a log line holding one
could be read, the ticket has been spent.

Stored in ``user_action_tokens`` (hashed, like the invite and reset tokens
beside it) rather than in process memory: the API runs several uvicorn
workers, and the POST that mints a ticket and the GET that spends it can land
on different ones. The table also gives "single use" for free — the spend is
one conditional UPDATE, which exactly one request can win — and deactivating
a user already burns every unused token of theirs, tickets included.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import timedelta

from sqlalchemy import delete, or_, select, update
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import User, UserActionToken

EVENT_STREAM_TICKET_PURPOSE = "event_stream"
TICKET_TTL_SECONDS = 60
_TICKET_RANDOM_BYTES = 32


def _ticket_hash(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def issue_ticket(db: Session, user: User) -> str:
    """Mint a ticket for ``user`` and return it. The raw value is never stored.

    Sweeps spent and expired tickets on the way, so the table holds at most
    the last minute's worth of them instead of one row per reconnect forever.
    The sweep is scoped to this purpose: invite and reset tokens keep their
    history.
    """
    now = utcnow()
    db.execute(
        delete(UserActionToken).where(
            UserActionToken.purpose == EVENT_STREAM_TICKET_PURPOSE,
            or_(UserActionToken.used_at.is_not(None), UserActionToken.expires_at <= now),
        )
    )
    raw = secrets.token_urlsafe(_TICKET_RANDOM_BYTES)
    db.add(
        UserActionToken(
            user_id=user.id,
            purpose=EVENT_STREAM_TICKET_PURPOSE,
            token_hash=_ticket_hash(raw),
            expires_at=now + timedelta(seconds=TICKET_TTL_SECONDS),
            created_by=user.id,
        )
    )
    db.commit()
    return raw


def redeem_ticket(db: Session, raw: str) -> int | None:
    """Spend ``raw`` and return its user id, or None if it cannot be spent.

    Unknown, expired and already-spent tickets are all just None: the caller
    answers 401 either way, and a prober learns nothing from the difference.
    """
    if not raw:
        return None
    now = utcnow()
    row = db.execute(
        select(UserActionToken.id, UserActionToken.user_id).where(
            UserActionToken.purpose == EVENT_STREAM_TICKET_PURPOSE,
            UserActionToken.token_hash == _ticket_hash(raw),
            UserActionToken.used_at.is_(None),
            UserActionToken.expires_at > now,
        )
    ).first()
    if row is None:
        return None
    # The read above only finds the ticket; this conditional write is what
    # spends it. Two requests racing with the same ticket (another worker, a
    # replay from a log) both pass the read, and exactly one of them gets a
    # row count of 1 here.
    spent = db.execute(
        update(UserActionToken)
        .where(UserActionToken.id == row.id, UserActionToken.used_at.is_(None))
        .values(used_at=now)
    )
    db.commit()
    return row.user_id if spent.rowcount == 1 else None
