"""Retrying a construction-report upload must never file the report twice.

A phone on a construction site can lose the response to a successful create.
The client then retries with the same ``Idempotency-Key`` header, and the API
has to answer with the original report while creating nothing at all: no row,
no images, no job, no follow-up task, no activity.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.core.config import get_settings
from app.core.db import SessionLocal
from app.models.entities import (
    Attachment,
    ConstructionReport,
    ConstructionReportJob,
    ProjectActivity,
    Task,
    User,
)
from app.routers import workflow_helpers

IDEMPOTENCY_HEADER = "Idempotency-Key"
IMAGE_FOLDER = "Bilder"
PNG_BYTES = b"\x89PNG\r\n\x1a\nfake-site-photo"
SECOND_USER_EMAIL = "zweiter@example.com"
SECOND_USER_PASSWORD = "Password123!"


def auth_headers(token: str, *, key: str | None = None) -> dict[str, str]:
    headers = {"Authorization": f"Bearer {token}"}
    if key is not None:
        return {**headers, IDEMPOTENCY_HEADER: key}
    return headers


def _make_customer(client: TestClient, admin_token: str, name: str) -> int:
    resp = client.post(
        "/api/customers",
        headers=auth_headers(admin_token),
        json={"name": name, "address": "Hauptstr. 1, 12345 Musterstadt"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _make_project(client: TestClient, admin_token: str, number: str) -> int:
    resp = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": number, "name": f"Project {number}", "status": "active"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _second_user_token(client: TestClient, admin_token: str) -> str:
    created = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={
            "email": SECOND_USER_EMAIL,
            "password": SECOND_USER_PASSWORD,
            "full_name": "Zweiter Nutzer",
            "role": "admin",
        },
    )
    assert created.status_code == 200, created.text
    login = client.post(
        "/api/auth/login", json={"email": SECOND_USER_EMAIL, "password": SECOND_USER_PASSWORD}
    )
    assert login.status_code == 200, login.text
    return login.headers["X-Access-Token"]


def _user_id(email: str) -> int:
    with SessionLocal() as db:
        user_id = db.scalar(select(User.id).where(User.email == email))
    assert user_id is not None
    return int(user_id)


def _report_payload(**overrides: object) -> dict:
    payload: dict = {
        "customer": "Baustelle GmbH",
        "workers": [{"name": "Worker"}],
        "work_done": "Kabel gezogen",
    }
    return {**payload, **overrides}


def _post_multipart_report(
    client: TestClient,
    token: str,
    project_id: int,
    *,
    key: str | None = None,
    form: dict | None = None,
):
    data = form if form is not None else {
        "report_date": "2026-09-17",
        "payload": json.dumps(_report_payload()),
    }
    return client.post(
        f"/api/projects/{project_id}/construction-reports",
        headers=auth_headers(token, key=key),
        data=data,
        files=[("images", ("site.png", PNG_BYTES, "image/png"))],
    )


def _post_json_report(
    client: TestClient,
    token: str,
    *,
    key: str | None = None,
    project_id: int | None = None,
    customer_id: int | None = None,
    payload: dict | None = None,
):
    body: dict = {"report_date": "2026-09-17", "payload": payload or _report_payload()}
    url = "/api/construction-reports"
    if project_id is not None:
        url = f"/api/projects/{project_id}/construction-reports"
    if customer_id is not None:
        body["customer_id"] = customer_id
    return client.post(url, headers=auth_headers(token, key=key), json=body)


def _count(model, *criteria) -> int:
    with SessionLocal() as db:
        stmt = select(func.count()).select_from(model)
        for criterion in criteria:
            stmt = stmt.where(criterion)
        return int(db.scalar(stmt) or 0)


def _uploaded_file_count() -> int:
    uploads = Path(get_settings().uploads_dir)
    if not uploads.exists():
        return 0
    return sum(1 for entry in uploads.iterdir() if entry.is_file())


def _snapshot() -> dict[str, int]:
    """Everything a report create writes, so a replay can be shown to write nothing."""
    return {
        "reports": _count(ConstructionReport),
        "image_rows": _count(Attachment, Attachment.folder_path == IMAGE_FOLDER),
        "attachments": _count(Attachment),
        "jobs": _count(ConstructionReportJob),
        "activities": _count(ProjectActivity),
        "tasks": _count(Task),
        "files_on_disk": _uploaded_file_count(),
    }


def test_same_user_same_key_multipart_replays_without_creating_anything(
    client: TestClient, admin_token: str
):
    project_id = _make_project(client, admin_token, "2026-IDEM-1")
    key = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
    before = _snapshot()

    first = _post_multipart_report(client, admin_token, project_id, key=key)
    assert first.status_code == 200, first.text
    after_first = _snapshot()
    assert after_first["reports"] == before["reports"] + 1
    assert after_first["image_rows"] == before["image_rows"] + 1
    assert after_first["jobs"] == before["jobs"] + 1
    assert after_first["files_on_disk"] > before["files_on_disk"]
    assert [row["file_name"] for row in first.json()["report_images"]] == ["report-0001-photo-001.png"]

    second = _post_multipart_report(client, admin_token, project_id, key=key)
    assert second.status_code == 200, second.text
    assert second.json() == first.json()
    assert second.json()["id"] == first.json()["id"]
    assert second.json()["report_number"] == first.json()["report_number"] == 1
    assert _snapshot() == after_first


def test_same_key_different_users_create_independent_reports(client: TestClient, admin_token: str):
    project_id = _make_project(client, admin_token, "2026-IDEM-2")
    other_token = _second_user_token(client, admin_token)
    key = "shared-key-between-users"
    before = _snapshot()

    mine = _post_json_report(client, admin_token, key=key, project_id=project_id)
    theirs = _post_json_report(client, other_token, key=key, project_id=project_id)
    assert mine.status_code == 200, mine.text
    assert theirs.status_code == 200, theirs.text
    assert mine.json()["id"] != theirs.json()["id"]
    assert {mine.json()["report_number"], theirs.json()["report_number"]} == {1, 2}
    assert _count(ConstructionReport) == before["reports"] + 2


def test_without_header_every_post_creates_a_report(client: TestClient, admin_token: str):
    project_id = _make_project(client, admin_token, "2026-IDEM-3")
    before = _snapshot()

    first = _post_multipart_report(client, admin_token, project_id)
    second = _post_multipart_report(client, admin_token, project_id)
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["id"] != second.json()["id"]
    after = _snapshot()
    assert after["reports"] == before["reports"] + 2
    assert after["image_rows"] == before["image_rows"] + 2


@pytest.mark.parametrize(
    "bad_key",
    [
        "a" * 65,
        "has space",
        "slash/in/key",
        "",
        "dotted.key",
        "percent%20encoded",
    ],
    ids=["too-long", "space", "slash", "empty", "dot", "percent"],
)
def test_invalid_idempotency_key_is_rejected_before_anything_happens(
    client: TestClient, admin_token: str, bad_key: str
):
    project_id = _make_project(client, admin_token, "2026-IDEM-4")
    before = _snapshot()

    response = _post_multipart_report(client, admin_token, project_id, key=bad_key)
    assert response.status_code == 400, response.text
    assert "Idempotency-Key" in response.json()["detail"]
    assert _snapshot() == before


def test_json_body_replays_on_the_global_endpoint(client: TestClient, admin_token: str):
    customer_id = _make_customer(client, admin_token, "Direkt AG")
    key = "json-retry-0001"
    before = _snapshot()

    first = _post_json_report(client, admin_token, key=key, customer_id=customer_id)
    assert first.status_code == 200, first.text
    assert first.json()["customer_id"] == customer_id
    assert first.json()["project_id"] is None
    after_first = _snapshot()
    assert after_first["reports"] == before["reports"] + 1

    second = _post_json_report(client, admin_token, key=key, customer_id=customer_id)
    assert second.status_code == 200, second.text
    assert second.json() == first.json()
    assert _snapshot() == after_first


def test_replay_from_pre_existing_row_never_reads_the_body(client: TestClient, admin_token: str):
    project_id = _make_project(client, admin_token, "2026-IDEM-5")
    key = "pre-seeded-key"
    with SessionLocal() as db:
        seeded = ConstructionReport(
            project_id=project_id,
            report_number=1,
            user_id=_user_id("admin@example.com"),
            report_date=date(2026, 9, 1),
            payload=_report_payload(),
            telegram_mode="stub",
            processing_status="completed",
            pdf_file_name="seeded.pdf",
            idempotency_key=key,
        )
        db.add(seeded)
        db.commit()
        seeded_id = seeded.id
    before = _snapshot()

    # This body would be a 400 if it were ever parsed; the replay must win
    # before the request body is read at all.
    response = _post_multipart_report(
        client,
        admin_token,
        project_id,
        key=key,
        form={"report_date": "not-a-date", "payload": "{not json"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["id"] == seeded_id
    assert body["project_id"] == project_id
    assert body["report_number"] == 1
    assert body["attachment_file_name"] == "seeded.pdf"
    assert body["processing_status"] == "completed"
    assert body["report_images"] == []
    assert body["follow_up_task_id"] is None
    assert body["follow_up_subtask_count"] == 0
    assert _snapshot() == before


def test_lost_select_race_is_caught_by_the_unique_index(
    client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch
):
    project_id = _make_project(client, admin_token, "2026-IDEM-6")
    key = "race-key-0042"

    first = _post_multipart_report(client, admin_token, project_id, key=key)
    assert first.status_code == 200, first.text
    after_first = _snapshot()

    real_lookup = workflow_helpers._find_idempotent_report
    lookups: list[str] = []

    def lookup_that_misses_once(db, *, user_id: int, idempotency_key: str):
        lookups.append(idempotency_key)
        if len(lookups) == 1:
            # The retry's pre-flight SELECT ran before the first request had
            # committed: it sees nothing and the INSERT must collide instead.
            return None
        return real_lookup(db, user_id=user_id, idempotency_key=idempotency_key)

    monkeypatch.setattr(workflow_helpers, "_find_idempotent_report", lookup_that_misses_once)

    second = _post_multipart_report(client, admin_token, project_id, key=key)
    assert second.status_code == 200, second.text
    assert second.json() == first.json()
    assert lookups == [key, key]
    assert _snapshot() == after_first


def test_unrelated_integrity_error_is_not_swallowed(
    client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch
):
    project_id = _make_project(client, admin_token, "2026-IDEM-7")
    first = _post_json_report(client, admin_token, project_id=project_id)
    assert first.status_code == 200, first.text
    key = "fresh-key-no-collision"

    # Force the per-project report number onto the one already issued, so the
    # flush fails on uq_construction_report_project_number, not on the key.
    monkeypatch.setattr(workflow_helpers, "_next_project_report_number", lambda db, project_id: 1)

    try:
        response = _post_json_report(client, admin_token, key=key, project_id=project_id)
    except IntegrityError:
        response = None
    assert response is None or response.status_code >= 500
    assert _count(ConstructionReport, ConstructionReport.idempotency_key == key) == 0
    assert _count(ConstructionReport) == 1


def test_replay_returns_the_recorded_follow_up_task(client: TestClient, admin_token: str):
    project_id = _make_project(client, admin_token, "2026-IDEM-8")
    task = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_id,
            "title": "Zählerschrank setzen",
            "subtasks": ["Rahmen montieren", "Wechselrichter anschließen", "Ausgang prüfen"],
            "status": "open",
        },
    )
    assert task.status_code == 200, task.text
    payload = _report_payload(
        source_task_id=task.json()["id"],
        completed_subtasks=["Rahmen montieren", "Ausgang prüfen"],
    )
    key = "follow-up-key"

    first = _post_json_report(client, admin_token, key=key, project_id=project_id, payload=payload)
    assert first.status_code == 200, first.text
    assert first.json()["follow_up_task_id"] is not None
    assert first.json()["follow_up_subtask_count"] == 1
    after_first = _snapshot()
    assert after_first["tasks"] == 2

    second = _post_json_report(client, admin_token, key=key, project_id=project_id, payload=payload)
    assert second.status_code == 200, second.text
    assert second.json() == first.json()
    assert _snapshot() == after_first
