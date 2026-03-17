from __future__ import annotations
import base64
import os
import struct
import uuid
from collections.abc import Iterator
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import get_settings

settings = get_settings()
CHUNKED_MAGIC = b"SMPLENC2"
CHUNKED_SIZE_STRUCT = struct.Struct(">Q")
CHUNKED_RECORD_LEN_STRUCT = struct.Struct(">I")
CHUNKED_NONCE_SIZE = 12
CHUNKED_DATA_BYTES = 1024 * 1024


def _get_fernet() -> Fernet:
    key = settings.file_encryption_key
    if not key:
        raise RuntimeError("FILE_ENCRYPTION_KEY is required")
    return Fernet(key)


def _get_aesgcm() -> AESGCM:
    key = settings.file_encryption_key
    if not key:
        raise RuntimeError("FILE_ENCRYPTION_KEY is required")
    try:
        decoded = base64.urlsafe_b64decode(key.encode("utf-8"))
    except Exception as exc:
        raise RuntimeError("FILE_ENCRYPTION_KEY is invalid") from exc
    if len(decoded) != 32:
        raise RuntimeError("FILE_ENCRYPTION_KEY is invalid")
    return AESGCM(decoded)


def _read_chunked_header(handle) -> int | None:
    marker = handle.read(len(CHUNKED_MAGIC))
    if len(marker) < len(CHUNKED_MAGIC):
        return None
    if marker != CHUNKED_MAGIC:
        return None
    size_raw = handle.read(CHUNKED_SIZE_STRUCT.size)
    if len(size_raw) != CHUNKED_SIZE_STRUCT.size:
        raise RuntimeError("Stored file payload is incomplete")
    return int(CHUNKED_SIZE_STRUCT.unpack(size_raw)[0])


def _iter_chunked_decrypted(handle, plain_size: int) -> Iterator[bytes]:
    cipher = _get_aesgcm()
    emitted = 0
    chunk_index = 0
    while True:
        length_raw = handle.read(CHUNKED_RECORD_LEN_STRUCT.size)
        if not length_raw:
            break
        if len(length_raw) != CHUNKED_RECORD_LEN_STRUCT.size:
            raise RuntimeError("Stored file payload is incomplete")
        encrypted_len = int(CHUNKED_RECORD_LEN_STRUCT.unpack(length_raw)[0])
        if encrypted_len <= 0:
            raise RuntimeError("Stored file payload is corrupted")
        nonce = handle.read(CHUNKED_NONCE_SIZE)
        if len(nonce) != CHUNKED_NONCE_SIZE:
            raise RuntimeError("Stored file payload is incomplete")
        encrypted_chunk = handle.read(encrypted_len)
        if len(encrypted_chunk) != encrypted_len:
            raise RuntimeError("Stored file payload is incomplete")
        try:
            chunk = cipher.decrypt(nonce, encrypted_chunk, chunk_index.to_bytes(8, "big"))
        except InvalidTag as exc:
            raise RuntimeError("Unable to decrypt file") from exc
        chunk_index += 1
        emitted += len(chunk)
        if emitted > plain_size:
            raise RuntimeError("Stored file payload is corrupted")
        if chunk:
            yield chunk
    if emitted != plain_size:
        raise RuntimeError("Stored file payload is corrupted")


def encrypted_file_plain_size(stored_path: str) -> int | None:
    with open(stored_path, "rb") as handle:
        return _read_chunked_header(handle)


def validate_encrypted_file(stored_path: str) -> int | None:
    with open(stored_path, "rb") as handle:
        plain_size = _read_chunked_header(handle)
        if plain_size is not None:
            for _chunk in _iter_chunked_decrypted(handle, plain_size):
                pass
            return plain_size
        encrypted = handle.read()
    try:
        _get_fernet().decrypt(encrypted)
    except InvalidToken as exc:
        raise RuntimeError("Unable to decrypt file") from exc
    return None


def store_encrypted_file(raw_bytes: bytes, file_extension: str = "bin") -> str:
    uploads_path = Path(settings.uploads_dir)
    uploads_path.mkdir(parents=True, exist_ok=True)
    file_name = f"{uuid.uuid4()}.{file_extension}"
    file_path = uploads_path / file_name

    with open(file_path, "wb") as handle:
        handle.write(CHUNKED_MAGIC)
        handle.write(CHUNKED_SIZE_STRUCT.pack(len(raw_bytes)))
        cipher = _get_aesgcm()
        payload = memoryview(raw_bytes)
        chunk_index = 0
        for offset in range(0, len(payload), CHUNKED_DATA_BYTES):
            chunk = bytes(payload[offset : offset + CHUNKED_DATA_BYTES])
            nonce = os.urandom(CHUNKED_NONCE_SIZE)
            encrypted = cipher.encrypt(nonce, chunk, chunk_index.to_bytes(8, "big"))
            handle.write(CHUNKED_RECORD_LEN_STRUCT.pack(len(encrypted)))
            handle.write(nonce)
            handle.write(encrypted)
            chunk_index += 1
    return os.fspath(file_path)


def iter_encrypted_file_bytes(stored_path: str) -> Iterator[bytes]:
    with open(stored_path, "rb") as handle:
        plain_size = _read_chunked_header(handle)
        if plain_size is not None:
            yield from _iter_chunked_decrypted(handle, plain_size)
            return
        handle.seek(0)
        encrypted = handle.read()
    try:
        yield _get_fernet().decrypt(encrypted)
    except InvalidToken as exc:
        raise RuntimeError("Unable to decrypt file") from exc


def read_encrypted_file(stored_path: str) -> bytes:
    return b"".join(iter_encrypted_file_bytes(stored_path))
