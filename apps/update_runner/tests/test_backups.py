"""Filesystem-side tests for the runner's backup management module.

The high-leverage assertions here are the path-safety ones: a single regression
in ``is_valid_filename`` would let a caller dictate arbitrary file paths under
the host's repo bind-mount. Test those exhaustively, then sanity-check the
write/read/delete round-trip.
"""
from __future__ import annotations

from pathlib import Path

import pytest


def test_valid_generated_filename_is_accepted(runner_tmp_repo: Path):
    from app.backups import is_valid_filename

    assert is_valid_filename("backup-20260427-103000.tar.enc")


def test_valid_user_uploaded_name_is_accepted(runner_tmp_repo: Path):
    from app.backups import is_valid_filename

    assert is_valid_filename("offsite-copy.tar.enc")
    assert is_valid_filename("a.tar.enc")


@pytest.mark.parametrize(
    "bad_name",
    [
        "../etc/passwd",
        "../../escape.tar.enc",
        "subdir/file.tar.enc",
        r"win\\path.tar.enc",
        ".hidden.tar.enc",
        "no-extension",
        "file.txt",
        "double..dot.tar.enc",  # contains '..' substring
        "",
        "a" * 250 + ".tar.enc",  # over the user-upload length cap
    ],
)
def test_invalid_filenames_are_rejected(runner_tmp_repo: Path, bad_name: str):
    from app.backups import is_valid_filename

    assert not is_valid_filename(bad_name), f"expected to reject: {bad_name!r}"


def test_safe_resolve_raises_on_traversal(runner_tmp_repo: Path):
    from app.backups import InvalidBackupName, safe_resolve

    with pytest.raises(InvalidBackupName):
        safe_resolve("../etc/passwd")


def test_safe_resolve_returns_path_inside_backup_dir(runner_tmp_repo: Path):
    from app.backups import BACKUP_DIR, safe_resolve

    path = safe_resolve("backup-20260427-103000.tar.enc")
    assert path.is_relative_to(BACKUP_DIR.resolve())


def test_write_then_read_roundtrip(runner_tmp_repo: Path):
    from app.backups import list_backups, open_for_read, write_uploaded_chunks

    payload = b"encrypted-blob-pretend"
    written = write_uploaded_chunks("backup-20260427-103000.tar.enc", iter([payload]))
    assert written == len(payload)

    path, size = open_for_read("backup-20260427-103000.tar.enc")
    assert path.is_file()
    assert size == len(payload)
    assert path.read_bytes() == payload

    listing = list_backups()
    assert any(item.filename == "backup-20260427-103000.tar.enc" for item in listing)


def test_delete_backup_removes_file(runner_tmp_repo: Path):
    from app.backups import delete_backup, write_uploaded_chunks

    write_uploaded_chunks("backup-20260427-103000.tar.enc", iter([b"data"]))
    assert delete_backup("backup-20260427-103000.tar.enc") is True
    # Second delete returns False (already gone) — no exception.
    assert delete_backup("backup-20260427-103000.tar.enc") is False


def test_list_backups_skips_unrecognised_files(runner_tmp_repo: Path):
    from app.backups import BACKUP_DIR, ensure_backup_dir, list_backups

    ensure_backup_dir()
    # A stray editor swap-file should not appear in the listing — we rely on
    # this filtering to keep the api surface clean.
    (BACKUP_DIR / ".swp").write_bytes(b"swap")
    (BACKUP_DIR / "README.md").write_bytes(b"docs")
    (BACKUP_DIR / "valid.tar.enc").write_bytes(b"ok")

    names = {item.filename for item in list_backups()}
    assert "valid.tar.enc" in names
    assert ".swp" not in names
    assert "README.md" not in names
