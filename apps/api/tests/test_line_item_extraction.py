"""Tests for the v2.4.0 LLM-assisted line-item extraction flow.

Two surfaces under test:

1. **Service layer** (``app/services/line_item_extraction.py``) — direct
   queue → claim → process unit tests using a fake OpenAI client. The
   real OpenAI SDK is never imported.

2. **REST surface** (``app/routers/workflow_line_items_extract.py``) —
   the enqueue / poll / list endpoints, including 400/403/404 paths.

The fake OpenAI client mirrors only what ``_call_openai_structured``
needs — a parsed pydantic instance and a usage object with token
counts. Anything beyond that is irrelevant to the contract we test.
"""
from __future__ import annotations

import io
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.core.db import SessionLocal
from app.models.entities import LineItemExtractionJob
from app.models.line_item_extraction_job import (
    DOC_TYPE_AUFTRAGSBESTAETIGUNG,
    DOC_TYPE_LIEFERSCHEIN,
    EXTRACTION_JOB_STATUS_COMPLETED,
    EXTRACTION_JOB_STATUS_FAILED,
    EXTRACTION_JOB_STATUS_PROCESSING,
    EXTRACTION_JOB_STATUS_QUEUED,
    SOURCE_KIND_EMAIL_TEXT,
    SOURCE_KIND_PDF,
)
from app.schemas.line_item_extraction import (
    ExtractedLineItem,
    ExtractedLineItemList,
)
from app.services import line_item_extraction


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _grant_user_with_projects_manage(client: TestClient, admin_token: str, email: str) -> str:
    """Mirror of the helper in test_project_line_items.py — a CEO user
    has projects:manage by default, so we use that role."""
    client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={
            "email": email,
            "password": "Password123!",
            "full_name": "Extract Test User",
            "role": "ceo",
        },
    )
    login = client.post("/api/auth/login", json={"email": email, "password": "Password123!"})
    return login.headers["X-Access-Token"]


def _create_project(client: TestClient, token: str, suffix: str = "X") -> int:
    response = client.post(
        "/api/projects",
        headers=auth_headers(token),
        json={
            "project_number": f"P-EXTRACT-{suffix}",
            "name": f"Extraction project {suffix}",
            "status": "active",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _save_openai_key_via_admin(client: TestClient, admin_token: str) -> None:
    """Persist a dummy OpenAI key so ``get_openai_client`` doesn't raise
    OpenAIClientNotConfigured before our monkeypatched call site runs."""
    response = client.patch(
        "/api/admin/settings/openai",
        headers=auth_headers(admin_token),
        json={"api_key": "sk-test-FAKE-KEY", "extraction_model": "gpt-4o-mini"},
    )
    assert response.status_code == 200, response.text


def _make_fake_completion(items: list[dict[str, Any]], *, prompt_tokens: int = 1000, completion_tokens: int = 200):
    """Build a fake OpenAI ``parse()`` return value with the minimum
    surface ``_call_openai_structured`` reads."""

    parsed = ExtractedLineItemList(items=[ExtractedLineItem(**item) for item in items])

    class _Usage:
        def __init__(self) -> None:
            self.prompt_tokens = prompt_tokens
            self.completion_tokens = completion_tokens

    class _Message:
        def __init__(self) -> None:
            self.parsed = parsed
            self.refusal = None

    class _Choice:
        def __init__(self) -> None:
            self.message = _Message()

    class _Completion:
        def __init__(self) -> None:
            self.choices = [_Choice()]
            self.usage = _Usage()

    return _Completion()


# ── service-level tests ─────────────────────────────────────────────────


def test_queue_and_claim_round_trip(client: TestClient, admin_token: str):
    """A queued job is claimed and marked processing exactly once; a
    second claim immediately after returns None (no other queued rows)."""
    user_token = _grant_user_with_projects_manage(
        client, admin_token, "extract-claim@example.com"
    )
    project_id = _create_project(client, user_token, "CLAIM")

    with SessionLocal() as db:
        job = line_item_extraction.queue_line_item_extraction_job(
            db,
            project_id=project_id,
            doc_type=DOC_TYPE_AUFTRAGSBESTAETIGUNG,
            source_kind=SOURCE_KIND_EMAIL_TEXT,
            source_filename=None,
            source_stored_path=None,
            source_text="Position 01.01 — Solarmodul, 26 Stk, EUR 245.00",
            created_by=None,
        )
        db.commit()
        assert job.status == EXTRACTION_JOB_STATUS_QUEUED
        assert job.attempt_count == 0

        claimed = line_item_extraction.claim_next_line_item_extraction_job(db)
        assert claimed is not None
        assert claimed.id == job.id
        assert claimed.status == EXTRACTION_JOB_STATUS_PROCESSING
        assert claimed.attempt_count == 1
        assert claimed.started_at is not None

        again = line_item_extraction.claim_next_line_item_extraction_job(db)
        assert again is None


def test_process_completes_and_persists_items(client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch):
    """Happy path: with a mocked OpenAI response, the job lands in
    ``completed`` with the parsed items written onto the row."""
    _save_openai_key_via_admin(client, admin_token)
    user_token = _grant_user_with_projects_manage(
        client, admin_token, "extract-happy@example.com"
    )
    project_id = _create_project(client, user_token, "HAPPY")

    fake_items = [
        {
            "type": "material",
            "section_title": "01 PV-Anlage",
            "position": "01.01",
            "description": "WINAICO WST-485BD/X54-B2 Solarmodul",
            "sku": "WST-485BD/X54-B2",
            "manufacturer": "WINAICO",
            "quantity_required": 26.0,
            "unit": "Stk",
            "unit_price_eur": 245.0,
            "total_price_eur": 6370.0,
            "confidence": 0.97,
        },
        {
            "type": "leistung",
            "section_title": None,
            "position": "02.01",
            "description": "DC-Verkabelung inkl. Kabelweg",
            "sku": None,
            "manufacturer": None,
            "quantity_required": 1.0,
            "unit": "pauschal",
            "unit_price_eur": 850.0,
            "total_price_eur": 850.0,
            "confidence": 0.88,
        },
    ]

    # Stub the OpenAI client construction (no real openai package) and the
    # one Structured-Outputs call. ``get_openai_client`` returns a
    # sentinel; ``_call_openai_structured`` ignores the client and returns
    # the fake parsed list.
    monkeypatch.setattr(
        line_item_extraction, "get_openai_client", lambda db: object()
    )
    monkeypatch.setattr(
        line_item_extraction, "get_extraction_model", lambda db: "gpt-4o-mini"
    )
    monkeypatch.setattr(
        line_item_extraction,
        "_call_openai_structured",
        lambda client, *, model, messages: (
            _make_fake_completion(fake_items).choices[0].message.parsed,
            1234,
            456,
        ),
    )

    with SessionLocal() as db:
        job = line_item_extraction.queue_line_item_extraction_job(
            db,
            project_id=project_id,
            doc_type=DOC_TYPE_AUFTRAGSBESTAETIGUNG,
            source_kind=SOURCE_KIND_EMAIL_TEXT,
            source_filename=None,
            source_stored_path=None,
            source_text="(synthetic AB body — content is irrelevant since the call is mocked)",
            created_by=None,
        )
        db.commit()
        job_id = job.id

    # Drain the queue exactly like the worker does.
    with SessionLocal() as db:
        claimed = line_item_extraction.claim_next_line_item_extraction_job(db)
        assert claimed is not None
        result = line_item_extraction.process_line_item_extraction_job(db, claimed.id)
        assert result is not None
        assert result.id == job_id
        assert result.status == EXTRACTION_JOB_STATUS_COMPLETED
        assert result.error_message is None
        assert result.completed_at is not None
        assert result.extracted_items_count == 2
        assert result.extracted_by_model == "gpt-4o-mini"
        assert result.input_tokens == 1234
        assert result.output_tokens == 456
        items = list(result.extracted_items_json)
        assert len(items) == 2
        assert items[0]["sku"] == "WST-485BD/X54-B2"
        assert items[0]["confidence"] == 0.97
        assert items[1]["type"] == "leistung"


def test_process_retries_then_fails_after_max_attempts(client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch):
    """When the LLM call always raises, the first failure re-queues the
    job (attempt 1 < max 2); the second failure marks it FAILED."""
    _save_openai_key_via_admin(client, admin_token)
    user_token = _grant_user_with_projects_manage(
        client, admin_token, "extract-retry@example.com"
    )
    project_id = _create_project(client, user_token, "RETRY")

    monkeypatch.setattr(line_item_extraction, "get_openai_client", lambda db: object())
    monkeypatch.setattr(line_item_extraction, "get_extraction_model", lambda db: "gpt-4o-mini")

    def _always_raise(client_obj, *, model, messages):
        raise RuntimeError("simulated upstream 500")

    monkeypatch.setattr(line_item_extraction, "_call_openai_structured", _always_raise)

    with SessionLocal() as db:
        job = line_item_extraction.queue_line_item_extraction_job(
            db,
            project_id=project_id,
            doc_type=DOC_TYPE_AUFTRAGSBESTAETIGUNG,
            source_kind=SOURCE_KIND_EMAIL_TEXT,
            source_filename=None,
            source_stored_path=None,
            source_text="(content irrelevant)",
            created_by=None,
            max_attempts=2,
        )
        db.commit()
        job_id = job.id

    # Attempt 1 — should re-queue.
    with SessionLocal() as db:
        claimed = line_item_extraction.claim_next_line_item_extraction_job(db)
        assert claimed is not None
        result = line_item_extraction.process_line_item_extraction_job(db, claimed.id)
        assert result is not None
        assert result.status == EXTRACTION_JOB_STATUS_QUEUED
        assert result.attempt_count == 1
        assert "simulated upstream" in (result.error_message or "")

    # Attempt 2 — should hard-fail.
    with SessionLocal() as db:
        claimed = line_item_extraction.claim_next_line_item_extraction_job(db)
        assert claimed is not None
        result = line_item_extraction.process_line_item_extraction_job(db, claimed.id)
        assert result is not None
        assert result.status == EXTRACTION_JOB_STATUS_FAILED
        assert result.attempt_count == 2
        assert result.completed_at is not None


def test_process_does_not_retry_when_no_api_key(client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch):
    """A missing API key is a config issue, not a transient failure —
    the job must hard-fail on attempt 1 regardless of max_attempts."""
    user_token = _grant_user_with_projects_manage(
        client, admin_token, "extract-noconfig@example.com"
    )
    project_id = _create_project(client, user_token, "NOCFG")

    # Don't save a key. ``get_openai_client`` should raise
    # OpenAIClientNotConfigured naturally — no monkeypatch needed.

    with SessionLocal() as db:
        job = line_item_extraction.queue_line_item_extraction_job(
            db,
            project_id=project_id,
            doc_type=DOC_TYPE_AUFTRAGSBESTAETIGUNG,
            source_kind=SOURCE_KIND_EMAIL_TEXT,
            source_filename=None,
            source_stored_path=None,
            source_text="(content irrelevant)",
            created_by=None,
            max_attempts=3,
        )
        db.commit()
        job_id = job.id

    with SessionLocal() as db:
        claimed = line_item_extraction.claim_next_line_item_extraction_job(db)
        result = line_item_extraction.process_line_item_extraction_job(db, claimed.id)
        assert result is not None
        assert result.status == EXTRACTION_JOB_STATUS_FAILED
        assert result.attempt_count == 1
        assert "API key" in (result.error_message or "")


# ── REST endpoint tests ─────────────────────────────────────────────────


def test_extract_endpoint_enqueues_email_text_job(client: TestClient, admin_token: str):
    """POST /projects/{id}/line-items/extract with email_text returns 202
    and a polling-ready job id."""
    user_token = _grant_user_with_projects_manage(
        client, admin_token, "extract-rest-email@example.com"
    )
    project_id = _create_project(client, user_token, "RESTE")

    response = client.post(
        f"/api/projects/{project_id}/line-items/extract",
        headers=auth_headers(user_token),
        data={
            "doc_type": DOC_TYPE_AUFTRAGSBESTAETIGUNG,
            "email_text": "Pos 01.01 Solarmodul 26 Stk EUR 245",
        },
    )
    assert response.status_code == 202, response.text
    job_id = response.json()["job_id"]
    assert response.json()["status"] == EXTRACTION_JOB_STATUS_QUEUED

    poll = client.get(
        f"/api/projects/{project_id}/line-items/extract/{job_id}",
        headers=auth_headers(user_token),
    )
    assert poll.status_code == 200
    assert poll.json()["source_kind"] == SOURCE_KIND_EMAIL_TEXT
    assert poll.json()["doc_type"] == DOC_TYPE_AUFTRAGSBESTAETIGUNG
    assert poll.json()["extracted_items_count"] == 0


def test_extract_endpoint_enqueues_pdf_upload(client: TestClient, admin_token: str):
    """Multipart PDF upload should land as a SOURCE_KIND_PDF job with
    a stored path and the original filename preserved."""
    user_token = _grant_user_with_projects_manage(
        client, admin_token, "extract-rest-pdf@example.com"
    )
    project_id = _create_project(client, user_token, "RESTP")

    fake_pdf = io.BytesIO(b"%PDF-1.4 -- fake bytes; the worker will fail to "
                          b"parse, but the enqueue path doesn't care")
    response = client.post(
        f"/api/projects/{project_id}/line-items/extract",
        headers=auth_headers(user_token),
        data={"doc_type": DOC_TYPE_LIEFERSCHEIN},
        files={"file": ("liefer.pdf", fake_pdf, "application/pdf")},
    )
    assert response.status_code == 202, response.text
    job_id = response.json()["job_id"]

    poll = client.get(
        f"/api/projects/{project_id}/line-items/extract/{job_id}",
        headers=auth_headers(user_token),
    )
    assert poll.status_code == 200
    assert poll.json()["source_kind"] == SOURCE_KIND_PDF
    assert poll.json()["source_filename"] == "liefer.pdf"


def test_extract_endpoint_rejects_bad_doc_type(client: TestClient, admin_token: str):
    user_token = _grant_user_with_projects_manage(
        client, admin_token, "extract-bad-doctype@example.com"
    )
    project_id = _create_project(client, user_token, "BADDT")

    response = client.post(
        f"/api/projects/{project_id}/line-items/extract",
        headers=auth_headers(user_token),
        data={"doc_type": "manuell", "email_text": "stuff"},
    )
    assert response.status_code == 400
    assert "doc_type" in response.json()["detail"]


def test_extract_endpoint_requires_exactly_one_input(client: TestClient, admin_token: str):
    user_token = _grant_user_with_projects_manage(
        client, admin_token, "extract-xor@example.com"
    )
    project_id = _create_project(client, user_token, "XOR")

    # Neither.
    neither = client.post(
        f"/api/projects/{project_id}/line-items/extract",
        headers=auth_headers(user_token),
        data={"doc_type": DOC_TYPE_AUFTRAGSBESTAETIGUNG},
    )
    assert neither.status_code == 400

    # Both.
    fake_pdf = io.BytesIO(b"%PDF-1.4 fake")
    both = client.post(
        f"/api/projects/{project_id}/line-items/extract",
        headers=auth_headers(user_token),
        data={"doc_type": DOC_TYPE_AUFTRAGSBESTAETIGUNG, "email_text": "body"},
        files={"file": ("x.pdf", fake_pdf, "application/pdf")},
    )
    assert both.status_code == 400


def test_extract_get_404_for_cross_project_job(client: TestClient, admin_token: str):
    """Polling a job_id from a different project must 404, not 200, to
    avoid leaking job existence across project boundaries."""
    user_token = _grant_user_with_projects_manage(
        client, admin_token, "extract-cross@example.com"
    )
    project_a = _create_project(client, user_token, "CROSSA")
    project_b = _create_project(client, user_token, "CROSSB")

    enqueue = client.post(
        f"/api/projects/{project_a}/line-items/extract",
        headers=auth_headers(user_token),
        data={"doc_type": DOC_TYPE_AUFTRAGSBESTAETIGUNG, "email_text": "x"},
    )
    assert enqueue.status_code == 202
    job_id = enqueue.json()["job_id"]

    cross = client.get(
        f"/api/projects/{project_b}/line-items/extract/{job_id}",
        headers=auth_headers(user_token),
    )
    assert cross.status_code == 404


def test_extract_list_returns_recent_jobs(client: TestClient, admin_token: str):
    user_token = _grant_user_with_projects_manage(
        client, admin_token, "extract-list@example.com"
    )
    project_id = _create_project(client, user_token, "LIST")

    for i in range(3):
        response = client.post(
            f"/api/projects/{project_id}/line-items/extract",
            headers=auth_headers(user_token),
            data={
                "doc_type": DOC_TYPE_AUFTRAGSBESTAETIGUNG,
                "email_text": f"Job {i}",
            },
        )
        assert response.status_code == 202

    listing = client.get(
        f"/api/projects/{project_id}/line-items/extract",
        headers=auth_headers(user_token),
    )
    assert listing.status_code == 200
    rows = listing.json()
    assert len(rows) == 3
    # Most recent first (id desc).
    assert rows[0]["id"] > rows[1]["id"] > rows[2]["id"]


def test_extract_endpoint_requires_projects_manage(client: TestClient, admin_token: str):
    """An employee without projects:manage cannot enqueue jobs."""
    # employee role does NOT inherit projects:manage by default.
    employee = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={
            "email": "extract-emp@example.com",
            "password": "Password123!",
            "full_name": "Employee Tester",
            "role": "employee",
        },
    )
    assert employee.status_code == 200
    project_id = _create_project(client, admin_token, "EMP")

    login = client.post(
        "/api/auth/login",
        json={"email": "extract-emp@example.com", "password": "Password123!"},
    )
    employee_token = login.headers["X-Access-Token"]
    client.cookies.clear()  # don't bleed admin cookie

    forbid = client.post(
        f"/api/projects/{project_id}/line-items/extract",
        headers=auth_headers(employee_token),
        data={"doc_type": DOC_TYPE_AUFTRAGSBESTAETIGUNG, "email_text": "body"},
    )
    assert forbid.status_code == 403
