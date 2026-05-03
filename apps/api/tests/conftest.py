from __future__ import annotations
import os
import tempfile
from collections.abc import Generator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import MetaData, text

# Force test-safe settings even when running inside Docker where DATABASE_URL is preset.
os.environ["DATABASE_URL"] = "sqlite:///./test.db"
os.environ["SECRET_KEY"] = "test-secret"
os.environ["SECURE_COOKIES"] = "false"
os.environ["INITIAL_ADMIN_EMAIL"] = "admin@example.com"
os.environ["INITIAL_ADMIN_PASSWORD"] = "ChangeMe123!"
os.environ["FILE_ENCRYPTION_KEY"] = "fdoXG7LEODVDx2wB8M-oTofEUHw1cjyM8s0q0JfPWPQ="
os.environ["REPORT_PROCESSING_MODE"] = "inline"

uploads_tmp = tempfile.mkdtemp(prefix="smpl-test-uploads-")
os.environ["UPLOADS_DIR"] = uploads_tmp
wiki_tmp = tempfile.mkdtemp(prefix="smpl-test-wiki-")
os.environ["WIKI_ROOT_DIR"] = wiki_tmp
material_catalog_tmp = tempfile.mkdtemp(prefix="smpl-test-material-catalog-")
os.environ["MATERIAL_CATALOG_DIR"] = material_catalog_tmp
os.environ["MATERIAL_CATALOG_IMAGE_LOOKUP_ENABLED"] = "false"

from app.core.db import Base, engine  # noqa: E402
from app.main import _initialize_runtime_data, app  # noqa: E402


def _alembic_config() -> Config:
    api_root = Path(__file__).resolve().parents[1]
    config = Config(str(api_root / "alembic.ini"))
    config.set_main_option("script_location", str(api_root / "alembic"))
    config.set_main_option("sqlalchemy.url", os.environ["DATABASE_URL"])
    return config


def _reset_database_rows() -> None:
    metadata = MetaData()
    with engine.begin() as connection:
        if engine.dialect.name == "sqlite":
            connection.execute(text("PRAGMA foreign_keys=OFF"))
        metadata.reflect(bind=connection)
        for table in reversed(metadata.sorted_tables):
            if table.name == "alembic_version":
                continue
            connection.execute(table.delete())
        if engine.dialect.name == "sqlite":
            connection.execute(text("PRAGMA foreign_keys=ON"))


@pytest.fixture(scope="session", autouse=True)
def migrate_schema() -> Generator[None, None, None]:
    db_url = os.environ["DATABASE_URL"]
    if engine.dialect.name == "sqlite":
        if db_url.startswith("sqlite:///"):
            sqlite_path = db_url.replace("sqlite:///", "", 1)
            sqlite_file = Path(sqlite_path)
            if sqlite_file.exists():
                sqlite_file.unlink()
        # SQLite test DBs do not support every historical migration operation.
        # Use model metadata once, then reset rows between tests.
        Base.metadata.create_all(bind=engine)
    else:
        command.upgrade(_alembic_config(), "head")
    yield


@pytest.fixture(autouse=True)
def reset_db() -> Generator[None, None, None]:
    _reset_database_rows()
    _initialize_runtime_data()
    yield


@pytest.fixture(autouse=True)
def _reset_rate_limit_bucket() -> None:
    """Clear the per-IP rate-limit bucket before every test.

    The rate-limit middleware in ``app.main`` keeps a module-level
    ``_rate_bucket`` dict that counts requests per ``(ip, scope)`` over a
    rolling 1-minute window. TestClient always reports the same client IP
    (``testclient``), so once the suite hits 480 default-scope requests
    inside a minute *every subsequent test* gets 429s — including the
    project-line-items boundary check. Clearing the bucket between tests
    keeps each test isolated; the explicit rate-limiter test in
    ``test_system.py`` re-clears at its start anyway, so this fixture is
    a no-op for it.
    """
    from app.main import _rate_bucket

    _rate_bucket.clear()


@pytest.fixture(autouse=True)
def _isolate_release_env_file_reader(monkeypatch: pytest.MonkeyPatch) -> None:
    """Short-circuit the on-disk ``.release.env`` reader during tests.

    The admin update endpoints prefer fresh on-disk values over the ``Settings``
    cache so a regenerated ``apps/api/.release.env`` becomes visible without
    requiring an api container restart. Tests pin the release version via
    ``monkeypatch.setattr(settings, ...)``, which would silently lose to a
    leftover ``.release.env`` in the working tree. This fixture neutralizes
    the file reader by default; tests that exercise the disk-precedence path
    re-monkeypatch it themselves.
    """
    from app.routers import admin as admin_router
    monkeypatch.setattr(admin_router, "_read_release_env_file", lambda: (None, None))


@pytest.fixture(autouse=True)
def _isolate_update_runner_client(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make the update_runner client look unreachable by default.

    The api may run inside a docker compose stack where the runner sidecar is
    actually reachable on the network — without isolation, every test that
    exercises the install endpoint would dispatch a *real* update job to that
    sidecar. This fixture forces the "runner unreachable" code path so the
    legacy in-process logic executes, which is what the existing tests assert.
    Tests for the runner-mediated path opt in by re-monkeypatching the
    individual functions on the client module.
    """
    from app.services import update_runner_client

    def _unreachable(*args, **kwargs):
        raise update_runner_client.UpdateRunnerUnreachable("runner disabled in tests")

    monkeypatch.setattr(update_runner_client, "is_runner_reachable", lambda: False)
    monkeypatch.setattr(update_runner_client, "queue_update_job", _unreachable)
    monkeypatch.setattr(update_runner_client, "get_job_status", _unreachable)
    # Backup helpers added in v2.3.0 — same isolation rationale: the runner is
    # not part of the api unit-test surface, so default every call to the
    # "unreachable" branch and let opt-in tests stub each helper.
    monkeypatch.setattr(update_runner_client, "list_backups", _unreachable)
    monkeypatch.setattr(update_runner_client, "queue_backup_job", _unreachable)
    monkeypatch.setattr(update_runner_client, "queue_restore_job", _unreachable)
    monkeypatch.setattr(update_runner_client, "delete_backup", _unreachable)
    monkeypatch.setattr(update_runner_client, "stream_backup_download", _unreachable)
    monkeypatch.setattr(update_runner_client, "upload_backup", _unreachable)


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    with TestClient(app) as c:
        yield c


@pytest.fixture
def admin_token(client: TestClient) -> str:
    response = client.post("/api/auth/login", json={"email": "admin@example.com", "password": "ChangeMe123!"})
    assert response.status_code == 200
    token = response.headers.get("X-Access-Token")
    assert token
    return token


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}
