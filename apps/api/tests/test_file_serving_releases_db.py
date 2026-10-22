"""Serving a file must not hold a database connection while the bytes move.

FastAPI closes a request's ``get_db`` session only after the response has been
sent in full. A preview is decrypted, possibly transcoded or rendered, and then
streamed — none of it touches the database, yet the session's connection stayed
checked out for all of it. A page that opens a gallery of previews held one
connection per photo for as long as the slowest phone took to download it,
which is how a burst of previews reached Postgres's max_connections on
2026-10-16. The connection has to be back in the pool before the slow work
starts.

Each test swaps the slow step for a probe that records how many pool
connections are checked out at the moment it runs.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core.db import engine


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _project(client: TestClient, token: str, number: str) -> int:
    resp = client.post(
        "/api/projects",
        headers=auth_headers(token),
        json={"project_number": number, "name": f"P {number}", "status": "active"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _upload(client: TestClient, token: str, project_id: int, name: str, body: bytes, content_type: str) -> int:
    resp = client.post(
        f"/api/projects/{project_id}/files",
        headers=auth_headers(token),
        files={"file": (name, body, content_type)},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()[0]["id"]


@pytest.mark.parametrize("route", ["preview", "download"])
def test_a_streamed_file_holds_no_connection_while_it_streams(
    client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch, route: str
) -> None:
    from app.routers import workflow_helpers

    real_iter = workflow_helpers.iter_encrypted_file_bytes
    checked_out: list[int] = []

    def probe(stored_path: str):
        checked_out.append(engine.pool.checkedout())
        yield from real_iter(stored_path)

    monkeypatch.setattr(workflow_helpers, "iter_encrypted_file_bytes", probe)
    project_id = _project(client, admin_token, f"2026-DBREL-{route}")
    file_id = _upload(client, admin_token, project_id, "plan.pdf", b"%PDF-1.4 body", "application/pdf")

    resp = client.get(f"/api/files/{file_id}/{route}", headers=auth_headers(admin_token))

    assert resp.status_code == 200, resp.text
    assert resp.content == b"%PDF-1.4 body"
    assert checked_out == [0], "the request's connection was still checked out while streaming"


def test_a_heic_preview_holds_no_connection_while_it_transcodes(
    client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.routers import workflow_helpers

    checked_out: list[int] = []

    def probe(source: bytes) -> bytes:
        checked_out.append(engine.pool.checkedout())
        return b"\xff\xd8 transcoded"

    monkeypatch.setattr(workflow_helpers, "transcode_to_jpeg", probe)
    project_id = _project(client, admin_token, "2026-DBREL-HEIC")
    file_id = _upload(client, admin_token, project_id, "foto.heic", b"heic bytes", "image/heic")

    resp = client.get(f"/api/files/{file_id}/preview", headers=auth_headers(admin_token))

    assert resp.status_code == 200, resp.text
    assert resp.content == b"\xff\xd8 transcoded"
    assert checked_out == [0], "the request's connection was still checked out while transcoding"


def test_pdf_page_previews_hold_no_connection_while_poppler_works(
    client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.services import pdf_preview

    checked_out: list[tuple[str, int]] = []

    def count_probe(data: bytes) -> int:
        checked_out.append(("count", engine.pool.checkedout()))
        return 3

    def render_probe(data: bytes, page: int) -> bytes:
        checked_out.append(("render", engine.pool.checkedout()))
        return b"\x89PNG page"

    monkeypatch.setattr(pdf_preview, "pdf_page_count", count_probe)
    monkeypatch.setattr(pdf_preview, "render_pdf_page", render_probe)
    project_id = _project(client, admin_token, "2026-DBREL-PAGES")
    file_id = _upload(client, admin_token, project_id, "plan.pdf", b"%PDF-1.4 body", "application/pdf")

    count = client.get(f"/api/files/{file_id}/preview-pages", headers=auth_headers(admin_token))
    page = client.get(f"/api/files/{file_id}/preview-pages/2", headers=auth_headers(admin_token))

    assert count.status_code == 200, count.text
    assert count.json() == {"page_count": 3}
    assert page.status_code == 200, page.text
    assert page.content == b"\x89PNG page"
    assert checked_out == [("count", 0), ("render", 0)]


def test_access_is_still_checked_before_the_connection_is_released(
    client: TestClient, admin_token: str
) -> None:
    """Releasing early must not mean answering before the access check."""

    project_id = _project(client, admin_token, "2026-DBREL-ACL")
    file_id = _upload(client, admin_token, project_id, "plan.pdf", b"%PDF-1.4 body", "application/pdf")

    assert client.get(f"/api/files/{file_id + 999}/preview", headers=auth_headers(admin_token)).status_code == 404
    # The login above left a session cookie in the client; drop it.
    client.cookies.clear()
    assert client.get(f"/api/files/{file_id}/preview").status_code == 401
