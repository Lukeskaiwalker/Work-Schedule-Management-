from __future__ import annotations
import os
import uuid
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import get_settings

settings = get_settings()


def _get_fernet() -> Fernet:
    key = settings.file_encryption_key
    if not key:
        raise RuntimeError("FILE_ENCRYPTION_KEY is required")
    return Fernet(key)


def store_encrypted_file(raw_bytes: bytes, file_extension: str = "bin") -> str:
    uploads_path = Path(settings.uploads_dir)
    uploads_path.mkdir(parents=True, exist_ok=True)
    file_name = f"{uuid.uuid4()}.{file_extension}"
    file_path = uploads_path / file_name

    cipher = _get_fernet()
    encrypted = cipher.encrypt(raw_bytes)
    with open(file_path, "wb") as handle:
        handle.write(encrypted)
    return os.fspath(file_path)


def read_encrypted_file(stored_path: str) -> bytes:
    with open(stored_path, "rb") as handle:
        encrypted = handle.read()
    try:
        return _get_fernet().decrypt(encrypted)
    except InvalidToken as exc:
        raise RuntimeError("Unable to decrypt file") from exc
