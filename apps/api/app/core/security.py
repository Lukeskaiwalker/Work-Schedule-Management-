from __future__ import annotations
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
from passlib.context import CryptContext

from app.core.config import get_settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
settings = get_settings()
ALGORITHM = "HS256"

# Marks a short-lived token that only authorises completing the MFA step of
# login — never a full session. get_current_user rejects any token carrying it.
MFA_CHALLENGE_PURPOSE = "mfa_challenge"


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)


def create_access_token(subject: str, extra: dict[str, Any] | None = None) -> str:
    now = datetime.now(timezone.utc)
    expire = now + timedelta(minutes=settings.access_token_expire_minutes)
    to_encode: dict[str, Any] = {"sub": subject, "iat": int(now.timestamp()), "exp": int(expire.timestamp())}
    if extra:
        to_encode.update(extra)
    return jwt.encode(to_encode, settings.secret_key, algorithm=ALGORITHM)


def create_mfa_challenge_token(subject: str, expires_minutes: int = 5) -> str:
    """A short-lived token proving step-1 (password) succeeded, exchanged at the
    login/mfa step for a real session. Explicitly NOT a session token."""
    now = datetime.now(timezone.utc)
    expire = now + timedelta(minutes=expires_minutes)
    to_encode: dict[str, Any] = {
        "sub": subject,
        "purpose": MFA_CHALLENGE_PURPOSE,
        "iat": int(now.timestamp()),
        "exp": int(expire.timestamp()),
    }
    return jwt.encode(to_encode, settings.secret_key, algorithm=ALGORITHM)


def decode_token(token: str) -> dict[str, Any] | None:
    """The claims of a valid session or MFA token, or None -- never an exception.

    ``algorithms`` is pinned to HS256 and the key is our symmetric secret, so a
    token claiming any other algorithm (``none``, HS512, RS256...) is refused
    before its signature is even considered. PyJWT also checks ``exp``,
    ``nbf`` and ``iat``. Pinned by tests/test_jwt_tokens.py, including a token
    python-jose issued, so the library switch logged nobody out.
    """
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
    except jwt.PyJWTError:
        return None
