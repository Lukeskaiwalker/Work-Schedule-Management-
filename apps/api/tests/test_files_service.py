from __future__ import annotations

from pathlib import Path

from cryptography.fernet import Fernet

from app.core.config import get_settings
from app.services import files as files_service
from app.services.files import (
    encrypted_file_plain_size,
    iter_encrypted_file_bytes,
    read_encrypted_file,
    store_encrypted_file,
    validate_encrypted_file,
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


def test_validate_encrypted_file_accepts_legacy_fernet_payload() -> None:
    payload = b"legacy-payload"
    settings = get_settings()
    uploads_path = Path(settings.uploads_dir)
    uploads_path.mkdir(parents=True, exist_ok=True)
    legacy_path = uploads_path / "legacy-validate-fixture.bin"
    legacy_path.write_bytes(Fernet(settings.file_encryption_key).encrypt(payload))

    assert encrypted_file_plain_size(str(legacy_path)) is None
    assert validate_encrypted_file(str(legacy_path)) is None


def test_legacy_key_fallback_reads_legacy_fernet_payload() -> None:
    original_key = files_service.settings.file_encryption_key
    original_legacy_keys = files_service.settings.file_encryption_legacy_keys
    old_key = Fernet.generate_key().decode("utf-8")
    new_key = Fernet.generate_key().decode("utf-8")
    uploads_path = Path(files_service.settings.uploads_dir)
    uploads_path.mkdir(parents=True, exist_ok=True)
    legacy_path = uploads_path / "legacy-alt-key.bin"

    try:
        legacy_path.write_bytes(Fernet(old_key).encrypt(b"legacy-alt-key"))
        files_service.settings.file_encryption_key = new_key
        files_service.settings.file_encryption_legacy_keys = old_key

        assert encrypted_file_plain_size(str(legacy_path)) is None
        assert validate_encrypted_file(str(legacy_path)) is None
        assert b"".join(iter_encrypted_file_bytes(str(legacy_path))) == b"legacy-alt-key"
        assert read_encrypted_file(str(legacy_path)) == b"legacy-alt-key"
    finally:
        files_service.settings.file_encryption_key = original_key
        files_service.settings.file_encryption_legacy_keys = original_legacy_keys


def test_legacy_key_fallback_reads_chunked_payload() -> None:
    original_key = files_service.settings.file_encryption_key
    original_legacy_keys = files_service.settings.file_encryption_legacy_keys
    old_key = Fernet.generate_key().decode("utf-8")
    new_key = Fernet.generate_key().decode("utf-8")
    payload = (b"chunked-alt-key" * 100000) + b"tail"

    try:
        files_service.settings.file_encryption_key = old_key
        files_service.settings.file_encryption_legacy_keys = ""
        stored_path = Path(store_encrypted_file(payload, "bin"))

        files_service.settings.file_encryption_key = new_key
        files_service.settings.file_encryption_legacy_keys = old_key

        assert encrypted_file_plain_size(str(stored_path)) == len(payload)
        assert validate_encrypted_file(str(stored_path)) == len(payload)
        assert b"".join(iter_encrypted_file_bytes(str(stored_path))) == payload
        assert read_encrypted_file(str(stored_path)) == payload
    finally:
        files_service.settings.file_encryption_key = original_key
        files_service.settings.file_encryption_legacy_keys = original_legacy_keys
