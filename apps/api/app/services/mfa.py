"""TOTP two-factor authentication helpers.

Keeps all the crypto/OTP concerns in one place so the router stays thin:

  * TOTP secret generation, provisioning URI, and code verification (pyotp).
  * Encryption of the secret at rest — the DB stores a Fernet ciphertext, never
    the raw base32 seed, so a database dump cannot be replayed as a second
    factor. The key is derived from ``FILE_ENCRYPTION_KEY`` (already required in
    production) so no new secret needs provisioning.
  * Server-side QR rendering as an SVG data URI, so the frontend needs no QR
    library and no raw-HTML injection (it just sets an <img src>).
  * Single-use recovery codes — generated once, stored only as sha256 hashes.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
from io import BytesIO

import pyotp
import qrcode
import qrcode.image.svg
from cryptography.fernet import Fernet, InvalidToken

from app.core.config import get_settings

_ISSUER = "SMPL"
_TOTP_VALID_WINDOW = 1  # accept the adjacent 30s step each side for clock drift
_RECOVERY_CODE_COUNT = 10


def _fernet() -> Fernet:
    """Fernet built from a key deterministically derived from FILE_ENCRYPTION_KEY.

    Deriving via sha256 means we don't require FILE_ENCRYPTION_KEY to itself be a
    valid Fernet key, and rotating the file key (which already invalidates file
    decryption) simply forces MFA re-enrollment — an acceptable, explicit
    coupling rather than a second secret to manage.
    """
    material = (get_settings().file_encryption_key or "").encode("utf-8")
    key = base64.urlsafe_b64encode(hashlib.sha256(b"smpl-mfa-v1:" + material).digest())
    return Fernet(key)


def generate_secret() -> str:
    """A fresh random base32 TOTP seed."""
    return pyotp.random_base32()


def provisioning_uri(email: str, secret: str) -> str:
    """The ``otpauth://`` URI an authenticator app imports."""
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name=_ISSUER)


def verify_totp(secret: str, code: str) -> bool:
    """True when ``code`` is a currently-valid TOTP for ``secret``."""
    normalized = (code or "").strip().replace(" ", "")
    if not normalized.isdigit():
        return False
    try:
        return bool(pyotp.TOTP(secret).verify(normalized, valid_window=_TOTP_VALID_WINDOW))
    except Exception:  # noqa: BLE001 — malformed secret/code must never 500
        return False


def qr_data_uri(uri: str) -> str:
    """Render ``uri`` as an SVG QR code and return it as a data: URI."""
    img = qrcode.make(uri, image_factory=qrcode.image.svg.SvgPathImage)
    buffer = BytesIO()
    img.save(buffer)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/svg+xml;base64,{encoded}"


def encrypt_secret(secret: str) -> str:
    return _fernet().encrypt(secret.encode("utf-8")).decode("ascii")


def decrypt_secret(token: str | None) -> str | None:
    if not token:
        return None
    try:
        return _fernet().decrypt(token.encode("utf-8")).decode("utf-8")
    except (InvalidToken, ValueError):
        return None


# ── Recovery codes ────────────────────────────────────────────────────────────


def _hash_recovery_code(code: str) -> str:
    return hashlib.sha256(code.strip().lower().encode("utf-8")).hexdigest()


def generate_recovery_codes(count: int = _RECOVERY_CODE_COUNT) -> tuple[list[str], list[str]]:
    """Return ``(plaintext_codes, hashed_codes)``.

    Plaintext is shown to the user exactly once; only the hashes are persisted.
    """
    plaintext: list[str] = []
    for _ in range(count):
        raw = secrets.token_hex(4) + "-" + secrets.token_hex(4)  # e.g. "a1b2c3d4-e5f6a7b8"
        plaintext.append(raw)
    hashed = [_hash_recovery_code(code) for code in plaintext]
    return plaintext, hashed


def consume_recovery_code(stored_hashes: list[str] | None, code: str) -> list[str] | None:
    """If ``code`` matches a stored hash, return the remaining hashes (with the
    matched one removed); otherwise return None. Constant-time per candidate.
    """
    if not stored_hashes:
        return None
    candidate = _hash_recovery_code(code)
    matched_index = None
    for index, stored in enumerate(stored_hashes):
        if hmac.compare_digest(stored, candidate):
            matched_index = index
            break
    if matched_index is None:
        return None
    return [h for i, h in enumerate(stored_hashes) if i != matched_index]
