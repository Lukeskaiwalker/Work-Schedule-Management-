from __future__ import annotations
import os
import tempfile
from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient

# Force test-safe settings even when running inside Docker where DATABASE_URL is preset.
os.environ["DATABASE_URL"] = "sqlite:///./test.db"
os.environ["SECRET_KEY"] = "test-secret"
os.environ["SECURE_COOKIES"] = "false"
os.environ["INITIAL_ADMIN_EMAIL"] = "admin@example.com"
os.environ["INITIAL_ADMIN_PASSWORD"] = "ChangeMe123!"
os.environ["FILE_ENCRYPTION_KEY"] = "fdoXG7LEODVDx2wB8M-oTofEUHw1cjyM8s0q0JfPWPQ="

uploads_tmp = tempfile.mkdtemp(prefix="smpl-test-uploads-")
os.environ["UPLOADS_DIR"] = uploads_tmp
wiki_tmp = tempfile.mkdtemp(prefix="smpl-test-wiki-")
os.environ["WIKI_ROOT_DIR"] = wiki_tmp

from app.core.db import Base, engine  # noqa: E402
from app.main import _initialize_runtime_data, app  # noqa: E402


@pytest.fixture(autouse=True)
def reset_db() -> Generator[None, None, None]:
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
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
