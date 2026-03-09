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
