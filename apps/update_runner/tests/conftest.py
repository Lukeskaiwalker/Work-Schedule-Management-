"""Test fixtures for the update_runner package.

The runner reads paths (REPO_ROOT, JOB_LOG_DIR) at import time, so the only
clean way to test it is to redirect those paths into a tmpdir *before* the
``backups`` / ``jobs`` modules touch the filesystem. Each test function gets
its own isolated repo root so tests cannot pollute each other.
"""
from __future__ import annotations

import importlib
import os
from pathlib import Path
from typing import Iterator

import pytest


@pytest.fixture
def runner_tmp_repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """Reload runner modules pointing at a fresh repo root under tmp_path.

    Yields the tmpdir (which contains a ``backups/`` subdir created by the
    runner module on import). Tests use this path as the "host repo root"
    when arranging files.
    """
    repo_root = tmp_path / "repo"
    log_dir = tmp_path / "logs"
    repo_root.mkdir()
    log_dir.mkdir()

    monkeypatch.setenv("UPDATE_RUNNER_REPO_ROOT", str(repo_root))
    monkeypatch.setenv("UPDATE_RUNNER_LOG_DIR", str(log_dir))
    monkeypatch.setenv("UPDATE_RUNNER_TOKEN", "")
    # Token-empty mode: no auth required, mirroring the dev stack.

    # Force re-import so the patched env vars are picked up.
    import app.config  # type: ignore  # noqa: F401  (loaded for side effect)
    import app.backups
    import app.jobs

    importlib.reload(app.config)
    importlib.reload(app.backups)
    importlib.reload(app.jobs)

    yield repo_root

    # Module-level mutable state would otherwise leak between tests.
    importlib.reload(app.jobs)
    importlib.reload(app.backups)
    importlib.reload(app.config)


@pytest.fixture
def runner_test_client(runner_tmp_repo: Path) -> Iterator:
    """A FastAPI TestClient bound to the freshly-reloaded runner app."""
    from fastapi.testclient import TestClient

    import app.main as runner_main
    import importlib

    importlib.reload(runner_main)
    with TestClient(runner_main.app) as client:
        yield client
