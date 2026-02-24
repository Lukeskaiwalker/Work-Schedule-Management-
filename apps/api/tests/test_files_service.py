from __future__ import annotations

from pathlib import Path

from cryptography.fernet import Fernet

from app.core.config import get_settings
from app.services.files import (
    encrypted_file_plain_size,
    iter_encrypted_file_bytes,
    read_encrypted_file,
    store_encrypted_file,
)


def test_chunked_encrypted_storage_round_trip() -> None:
    payload = (b"abc123XYZ" * 200000) + b"end"
    stored_path = Path(store_encrypted_file(payload, "bin"))

    assert stored_path.exists()
    assert encrypted_file_plain_size(str(stored_path)) == len(payload)
    assert b"".join(iter_encrypted_file_bytes(str(stored_path))) == payload
    assert read_encrypted_file(str(stored_path)) == payload


def test_legacy_fernet_payload_still_reads() -> None:
    payload = b"legacy-payload"
    settings = get_settings()
    uploads_path = Path(settings.uploads_dir)
    uploads_path.mkdir(parents=True, exist_ok=True)
    legacy_path = uploads_path / "legacy-fixture.bin"
    legacy_path.write_bytes(Fernet(settings.file_encryption_key).encrypt(payload))

    assert encrypted_file_plain_size(str(legacy_path)) is None
    assert b"".join(iter_encrypted_file_bytes(str(legacy_path))) == payload
    assert read_encrypted_file(str(legacy_path)) == payload
