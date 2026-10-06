"""Personal station badges: mint, rotate, resolve.

A badge is the DataMatrix a person carries for the scan station
(``models/station.StationBadge``). This module is the only place a badge code
is made or recognised. It mirrors the Kalender-Abo token
(``services/calendar_feed``) on purpose -- hashed for the lookup, encrypted for
re-display, rotation as the way to retire a lost one -- because both are the
same kind of thing: a bearer string that has to be shown to its owner again.

The code is ``SMPL-P-`` plus ten characters. Two properties of that shape are
load-bearing for the station:

* **The hyphen after ``SMPL-``.** An article's internal code is ``SMPL-`` and
  six characters with no hyphen, and every station command is ``SMPL-CMD-...``,
  so the scan router can tell a badge from an article or a command by its
  prefix alone, before anything goes over the network
  (``tools/label_agent/scan_router.py``).
* **No I, O, Y or Z.** I and O read back as 1 and 0 off a small label, which is
  why the article alphabet already drops them. Y and Z are dropped as well:
  the office scanner sends German scancodes, the Y/Z swap is the half of that
  keycode table that was inferred rather than measured, and article lookups
  paper over it by retrying with the two letters swapped. A badge that cannot
  contain either letter cannot be bitten by that at all. 32 symbols over ten
  places is 2^50 codes, and a guess has to arrive through a station endpoint
  that already requires a paired station's token.
"""

from __future__ import annotations

import hashlib
import re
import secrets

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import StationBadge, User
from app.services.secret_box import decrypt_secret, encrypt_secret

CODE_PREFIX = "SMPL-P-"
CODE_ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVWX"
CODE_RANDOM_LENGTH = 10
_CODE_RE = re.compile(r"^SMPL-P-[%s]{%d}$" % (CODE_ALPHABET, CODE_RANDOM_LENGTH))
#: Longest string worth hashing. Anything longer is not a badge.
MAX_CODE_LENGTH = 64


def mint_code() -> str:
    return CODE_PREFIX + "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_RANDOM_LENGTH))


def normalize_code(raw: str | None) -> str | None:
    """The canonical spelling of a scanned badge, or None if it is not one.

    Upper-cased because a scanner wedge with caps lock on still means the same
    badge; nothing else is forgiven, since a badge is matched by hash and a
    near miss is somebody else's code or nobody's.
    """
    text = (raw or "").strip().upper()
    if not text or len(text) > MAX_CODE_LENGTH:
        return None
    return text if _CODE_RE.match(text) else None


def hash_code(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


def get_badge(db: Session, user_id: int) -> StationBadge | None:
    return db.scalars(select(StationBadge).where(StationBadge.user_id == user_id)).first()


def _set_code(badge: StationBadge) -> str:
    code = mint_code()
    badge.code_hash = hash_code(code)
    badge.code_encrypted = encrypt_secret(code)
    return code


def ensure_badge(db: Session, user: User) -> StationBadge:
    """The person's badge, minted the first time anybody asks. Flushes only.

    Lazily rather than in a migration: every user has one the moment they
    open it, and nobody gets a code they never looked at.

    Two first reads can race -- the profile page asks on mount, React's
    StrictMode asks twice in development, two tabs ask at once -- and both see
    "no badge yet". The unique index on user_id lets one insert win; the loser
    rolls back only its savepoint and returns the winner's badge, so the
    request succeeds and the person still has exactly one code.
    """
    badge = get_badge(db, user.id)
    if badge is not None:
        return badge
    minted = StationBadge(user_id=user.id, code_hash="", code_encrypted="")
    _set_code(minted)
    try:
        with db.begin_nested():
            db.add(minted)
            db.flush()
    except IntegrityError:
        winner = get_badge(db, user.id)
        if winner is None:  # not the race: a genuine constraint failure
            raise
        return winner
    return minted


def rotate_badge(db: Session, user: User) -> StationBadge:
    """A fresh code; the old badge stops working on its next scan. Flushes only."""
    badge = get_badge(db, user.id)
    if badge is None:
        return ensure_badge(db, user)
    _set_code(badge)
    badge.created_at = utcnow()
    badge.last_used_at = None
    badge.use_count = 0
    db.add(badge)
    db.flush()
    return badge


def badge_code(badge: StationBadge) -> str:
    return decrypt_secret(badge.code_encrypted)


def resolve_badge(db: Session, raw: str | None) -> tuple[StationBadge, User] | None:
    """The badge and its owner a scan names, or None.

    An unknown code, a rotated one and a deactivated owner all come back the
    same: None. The station is told "not a badge we know", never which of the
    three it was.
    """
    code = normalize_code(raw)
    if code is None:
        return None
    badge = db.scalars(select(StationBadge).where(StationBadge.code_hash == hash_code(code))).first()
    if badge is None:
        return None
    user = db.get(User, badge.user_id)
    if user is None or not user.is_active:
        return None
    return badge, user


def note_use(db: Session, badge: StationBadge) -> None:
    badge.last_used_at = utcnow()
    badge.use_count = int(badge.use_count or 0) + 1
    db.add(badge)
