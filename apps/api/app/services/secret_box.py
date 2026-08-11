"""Symmetric encryption for short secrets stored in the database.

`services/files.py` already encrypts *file bodies* with the same key material,
but its helpers are stream- and path-oriented. This module is the same idea for
a single string: a wholesaler password, an API secret, anything that has to
round-trip but must not be readable in a database dump or a backup.

Key material is `FILE_ENCRYPTION_KEY`, and legacy keys from
`FILE_ENCRYPTION_LEGACY_KEYS` are accepted on read. That mirrors the file
pipeline on purpose — one key to rotate, not two — and means a rotation that
already works for uploads works for these secrets too.

## Why not just store the plaintext

The SMTP password in `runtime_settings` is stored in the clear today, so this
module is not the house style. It is a deliberate step up for a narrower case:
a webshop ordering credential lets whoever holds it place a legally binding
order in the company's name. Encryption at rest does not stop an attacker who
already has the app's key, but it does stop the far more likely accident — a
credential read out of a backup file, a support export, or a `SELECT *` on a
shared screen.
"""

from __future__ import annotations

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import get_settings


def _keys() -> list[str]:
    """Current key first, then legacy keys — the order Fernet tries them in."""

    settings = get_settings()
    current = (settings.file_encryption_key or "").strip()
    if not current:
        raise RuntimeError("FILE_ENCRYPTION_KEY is required to store secrets")
    keys = [current]
    seen = {current}
    for candidate in (settings.file_encryption_legacy_keys or "").split(","):
        key = candidate.strip()
        if key and key not in seen:
            keys.append(key)
            seen.add(key)
    return keys


def encrypt_secret(plaintext: str) -> str:
    """Encrypt with the CURRENT key. Empty input encrypts to empty output.

    Returning ``""`` for ``""`` keeps "no password set" distinguishable from
    "password set to the empty string" without a second nullable column.
    """

    if not plaintext:
        return ""
    return Fernet(_keys()[0]).encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt_secret(ciphertext: str | None) -> str:
    """Decrypt, trying the current key then each legacy key.

    Returns ``""`` for missing input. Raises ``ValueError`` when no key can
    open the token, which is a real failure — silently returning empty here
    would surface as a mystifying wholesaler login error instead of a clear
    "this secret predates your key rotation".
    """

    if not ciphertext:
        return ""
    token = ciphertext.encode("ascii", errors="ignore")
    for key in _keys():
        try:
            return Fernet(key).decrypt(token).decode("utf-8")
        except (InvalidToken, ValueError):
            continue
    raise ValueError("Stored secret cannot be decrypted with any configured key")


def mask_secret(plaintext: str | None) -> str:
    """Render a secret for a settings screen: fixed-width dots, or empty.

    Fixed width rather than proportional to the real length — a mask that
    leaks "the password is 6 characters" is a worse mask.
    """

    return "••••••••" if plaintext else ""
