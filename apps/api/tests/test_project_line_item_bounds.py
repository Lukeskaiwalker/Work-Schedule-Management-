"""Upper bounds on the numbers a project line item stores (2026-10-10).

Every quantity and price of a ``ProjectLineItem`` lands in a
``Numeric(12, 2)`` column (largest value 9,999,999,999.99). Before these
bounds a huge value reached ``db.flush()`` and PostgreSQL answered "numeric
field overflow" -- an unhandled 500. The request schemas now refuse it with a
422, the PATCH route refuses a combination that no longer fits with a 400,
and the LLM extraction drops a number it cannot store instead of failing the
job or the importer's poll.

The three write paths covered here:
  * POST  /api/projects/{id}/line-items              (manual create)
  * PATCH /api/projects/{id}/line-items/{item_id}    (grid edit)
  * POST  /api/projects/{id}/line-items/extract/{job_id}/confirm
and the worker that fills ``extracted_items_json`` for the importer.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.core.db import SessionLocal
from app.core.limits import INT32_MAX, MAX_STOCK_QUANTITY, NUMERIC_12_2_MAX
from app.models.entities import ProjectLineItem
from app.models.line_item_extraction_job import (
    DOC_TYPE_AUFTRAGSBESTAETIGUNG,
    EXTRACTION_JOB_STATUS_COMPLETED,
    SOURCE_KIND_EMAIL_TEXT,
)
from app.schemas.line_item_extraction import ExtractedLineItem, ExtractedLineItemList
from app.services import line_item_extraction

HUGE = "1E+20"
QUANTITY_FIELDS = (
    "quantity_required",
    "quantity_ordered",
    "quantity_delivered",
    "quantity_at_site",
    "quantity_reserved",
)
PRICE_FIELDS = ("unit_price_eur", "total_price_eur")
# Largest unit price whose product with MAX_STOCK_QUANTITY still fits the
# total column: 1,000,000 × 9,999.99 = 9,999,990,000.00.
LARGEST_PRICE_AT_MAX_QUANTITY = "9999.99"


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _project(client: TestClient, token: str, number: str = "P-BOUNDS-1") -> int:
    response = client.post(
        "/api/projects",
        headers=auth_headers(token),
        json={"project_number": number, "name": "Line-item bounds", "status": "active"},
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _item_payload(**overrides: Any) -> dict[str, Any]:
    return {
        "type": "material",
        "description": "Solarkabel 6 mm²",
        "quantity_required": "10.00",
        "unit": "m",
        **overrides,
    }


def _create_item(client: TestClient, token: str, project_id: int, **overrides: Any) -> dict:
    response = client.post(
        f"/api/projects/{project_id}/line-items",
        headers=auth_headers(token),
        json=_item_payload(**overrides),
    )
    assert response.status_code == 200, response.text
    return response.json()


def _stored_rows(project_id: int) -> list[ProjectLineItem]:
    with SessionLocal() as db:
        return list(
            db.query(ProjectLineItem).filter(ProjectLineItem.project_id == project_id).all()
        )


def _supplier(client: TestClient, token: str) -> int:
    response = client.post(
        "/api/werkstatt/suppliers", headers=auth_headers(token), json={"name": "Unielektro"}
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


# ── POST /line-items ────────────────────────────────────────────────────


@pytest.mark.parametrize("field", QUANTITY_FIELDS)
def test_create_refuses_a_huge_quantity(client: TestClient, admin_token: str, field: str):
    project_id = _project(client, admin_token)
    response = client.post(
        f"/api/projects/{project_id}/line-items",
        headers=auth_headers(admin_token),
        json=_item_payload(**{field: HUGE}),
    )
    assert response.status_code == 422, response.text
    assert _stored_rows(project_id) == []


def test_create_refuses_a_quantity_just_over_the_stock_bound(client: TestClient, admin_token: str):
    project_id = _project(client, admin_token)
    response = client.post(
        f"/api/projects/{project_id}/line-items",
        headers=auth_headers(admin_token),
        json=_item_payload(quantity_required=str(MAX_STOCK_QUANTITY + Decimal("0.01"))),
    )
    assert response.status_code == 422, response.text


@pytest.mark.parametrize("field", PRICE_FIELDS)
def test_create_refuses_a_huge_price(client: TestClient, admin_token: str, field: str):
    project_id = _project(client, admin_token)
    response = client.post(
        f"/api/projects/{project_id}/line-items",
        headers=auth_headers(admin_token),
        json=_item_payload(**{field: HUGE}),
    )
    assert response.status_code == 422, response.text
    assert _stored_rows(project_id) == []


@pytest.mark.parametrize("field", PRICE_FIELDS)
def test_create_refuses_a_price_just_over_the_column(client: TestClient, admin_token: str, field: str):
    project_id = _project(client, admin_token)
    response = client.post(
        f"/api/projects/{project_id}/line-items",
        headers=auth_headers(admin_token),
        json=_item_payload(quantity_required="0", **{field: str(NUMERIC_12_2_MAX + Decimal("0.01"))}),
    )
    assert response.status_code == 422, response.text


def test_create_refuses_a_line_total_over_the_column(client: TestClient, admin_token: str):
    """quantity × unit price is what the total column has to hold: both
    factors fit on their own, their product (10,000,000,000.00) does not."""
    project_id = _project(client, admin_token)
    response = client.post(
        f"/api/projects/{project_id}/line-items",
        headers=auth_headers(admin_token),
        json=_item_payload(quantity_required=str(MAX_STOCK_QUANTITY), unit_price_eur="10000.00"),
    )
    assert response.status_code == 422, response.text
    assert "largest storable total" in response.text
    assert _stored_rows(project_id) == []


def test_create_accepts_the_largest_allowed_values(client: TestClient, admin_token: str):
    project_id = _project(client, admin_token)
    largest_quantity = f"{MAX_STOCK_QUANTITY}.00"
    item = _create_item(
        client,
        admin_token,
        project_id,
        **{field: largest_quantity for field in QUANTITY_FIELDS},
        unit_price_eur=LARGEST_PRICE_AT_MAX_QUANTITY,
        total_price_eur=str(NUMERIC_12_2_MAX),
    )
    for field in QUANTITY_FIELDS:
        assert item[field] == largest_quantity
    assert item["unit_price_eur"] == LARGEST_PRICE_AT_MAX_QUANTITY
    assert item["total_price_eur"] == str(NUMERIC_12_2_MAX)


def test_create_rounds_to_cents_half_up(client: TestClient, admin_token: str):
    """The columns keep two decimals; PostgreSQL rounds half away from zero
    and the schema now does the same before the value is stored."""
    project_id = _project(client, admin_token)
    item = _create_item(
        client, admin_token, project_id, quantity_required="2.345", unit_price_eur="0.125"
    )
    assert item["quantity_required"] == "2.35"
    assert item["unit_price_eur"] == "0.13"


def test_create_rounds_a_tiny_exponent_to_zero(client: TestClient, admin_token: str):
    """PostgreSQL 16 refuses numeric input with an exponent below -16383
    ("value overflows numeric format", a DataError); the schema rounds it to
    the column's cents first."""
    project_id = _project(client, admin_token)
    item = _create_item(client, admin_token, project_id, quantity_ordered="1E-100000")
    assert item["quantity_ordered"] == "0.00"


@pytest.mark.parametrize("supplier_id", [INT32_MAX + 1, 2**63])
def test_create_refuses_a_huge_supplier_id(client: TestClient, admin_token: str, supplier_id: int):
    project_id = _project(client, admin_token)
    response = client.post(
        f"/api/projects/{project_id}/line-items",
        headers=auth_headers(admin_token),
        json=_item_payload(supplier_id=supplier_id),
    )
    assert response.status_code == 422, response.text
    assert _stored_rows(project_id) == []


def test_create_refuses_an_unknown_supplier(client: TestClient, admin_token: str):
    """The foreign key would fail at flush on PostgreSQL -- refuse it first."""
    project_id = _project(client, admin_token)
    response = client.post(
        f"/api/projects/{project_id}/line-items",
        headers=auth_headers(admin_token),
        json=_item_payload(supplier_id=987_654),
    )
    assert response.status_code == 400, response.text
    assert _stored_rows(project_id) == []


def test_create_accepts_an_existing_supplier(client: TestClient, admin_token: str):
    project_id = _project(client, admin_token)
    supplier_id = _supplier(client, admin_token)
    item = _create_item(client, admin_token, project_id, supplier_id=supplier_id)
    assert item["supplier_id"] == supplier_id


# ── PATCH /line-items/{id} ──────────────────────────────────────────────


def _patch(client: TestClient, token: str, project_id: int, item_id: int, body: dict):
    return client.patch(
        f"/api/projects/{project_id}/line-items/{item_id}",
        headers=auth_headers(token),
        json=body,
    )


@pytest.mark.parametrize("field", QUANTITY_FIELDS)
def test_patch_refuses_a_huge_quantity(client: TestClient, admin_token: str, field: str):
    project_id = _project(client, admin_token)
    item = _create_item(client, admin_token, project_id)
    response = _patch(client, admin_token, project_id, item["id"], {field: HUGE})
    assert response.status_code == 422, response.text
    (row,) = _stored_rows(project_id)
    assert getattr(row, field) == Decimal(item[field])


@pytest.mark.parametrize("field", PRICE_FIELDS)
def test_patch_refuses_a_huge_price(client: TestClient, admin_token: str, field: str):
    project_id = _project(client, admin_token)
    item = _create_item(client, admin_token, project_id)
    response = _patch(client, admin_token, project_id, item["id"], {field: HUGE})
    assert response.status_code == 422, response.text
    (row,) = _stored_rows(project_id)
    assert getattr(row, field) is None


def test_patch_refuses_a_huge_supplier_id(client: TestClient, admin_token: str):
    project_id = _project(client, admin_token)
    item = _create_item(client, admin_token, project_id)
    response = _patch(client, admin_token, project_id, item["id"], {"supplier_id": 2**63})
    assert response.status_code == 422, response.text


def test_patch_refuses_an_unknown_supplier(client: TestClient, admin_token: str):
    project_id = _project(client, admin_token)
    item = _create_item(client, admin_token, project_id)
    response = _patch(client, admin_token, project_id, item["id"], {"supplier_id": 987_654})
    assert response.status_code == 400, response.text
    assert response.json()["detail"] == "Supplier not found"
    (row,) = _stored_rows(project_id)
    assert row.supplier_id is None


def test_patch_refuses_a_price_whose_line_total_overflows(client: TestClient, admin_token: str):
    """The stored quantity times the new unit price no longer fits: 400, and
    the row keeps its old price."""
    project_id = _project(client, admin_token)
    item = _create_item(
        client, admin_token, project_id, quantity_required=str(MAX_STOCK_QUANTITY), unit_price_eur="1.00"
    )
    response = _patch(client, admin_token, project_id, item["id"], {"unit_price_eur": "10000.00"})
    assert response.status_code == 400, response.text
    assert "largest storable total" in response.json()["detail"]
    (row,) = _stored_rows(project_id)
    assert row.unit_price_eur == Decimal("1.00")


def test_patch_refuses_a_quantity_whose_line_total_overflows(client: TestClient, admin_token: str):
    project_id = _project(client, admin_token)
    item = _create_item(
        client, admin_token, project_id, quantity_required="1.00", unit_price_eur="10000.00"
    )
    response = _patch(
        client, admin_token, project_id, item["id"], {"quantity_required": str(MAX_STOCK_QUANTITY)}
    )
    assert response.status_code == 400, response.text
    (row,) = _stored_rows(project_id)
    assert row.quantity_required == Decimal("1.00")


def test_patch_of_another_field_leaves_an_oversized_legacy_row_editable(
    client: TestClient, admin_token: str
):
    """A row stored before the bound may already imply a line total over the
    column; editing its notes must still work -- only a change of quantity or
    unit price is checked against the total."""
    project_id = _project(client, admin_token)
    item = _create_item(client, admin_token, project_id, quantity_required="1.00", unit_price_eur="1.00")
    with SessionLocal() as db:
        row = db.get(ProjectLineItem, item["id"])
        row.quantity_required = Decimal("5000000.00")
        row.unit_price_eur = Decimal("5000.00")
        db.commit()
    response = _patch(client, admin_token, project_id, item["id"], {"notes": "geprüft"})
    assert response.status_code == 200, response.text
    assert response.json()["notes"] == "geprüft"


def test_patch_accepts_the_largest_allowed_values(client: TestClient, admin_token: str):
    project_id = _project(client, admin_token)
    item = _create_item(client, admin_token, project_id)
    largest_quantity = f"{MAX_STOCK_QUANTITY}.00"
    response = _patch(
        client,
        admin_token,
        project_id,
        item["id"],
        {
            **{field: largest_quantity for field in QUANTITY_FIELDS},
            "unit_price_eur": LARGEST_PRICE_AT_MAX_QUANTITY,
            "total_price_eur": str(NUMERIC_12_2_MAX),
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    for field in QUANTITY_FIELDS:
        assert body[field] == largest_quantity
    assert body["total_price_eur"] == str(NUMERIC_12_2_MAX)


@pytest.mark.parametrize(
    "field", ["type", "description", *QUANTITY_FIELDS, "is_active"]
)
def test_patch_refuses_null_for_a_required_column(client: TestClient, admin_token: str, field: str):
    """An explicit null for a NOT NULL column used to reach the flush as an
    IntegrityError (500). Absent means "leave alone"; null is refused."""
    project_id = _project(client, admin_token)
    item = _create_item(client, admin_token, project_id)
    response = _patch(client, admin_token, project_id, item["id"], {field: None})
    assert response.status_code == 422, response.text


# ── POST /extract/{job_id}/confirm ──────────────────────────────────────


def _completed_job(project_id: int) -> int:
    with SessionLocal() as db:
        job = line_item_extraction.queue_line_item_extraction_job(
            db,
            project_id=project_id,
            doc_type=DOC_TYPE_AUFTRAGSBESTAETIGUNG,
            source_kind=SOURCE_KIND_EMAIL_TEXT,
            source_filename=None,
            source_stored_path=None,
            source_text="(synthetic)",
            created_by=None,
        )
        job.status = EXTRACTION_JOB_STATUS_COMPLETED
        db.commit()
        return job.id


def _confirm(client: TestClient, token: str, project_id: int, job_id: int, **overrides: Any):
    item = {
        "type": "material",
        "description": "WINAICO Solarmodul",
        "quantity_required": "26.00",
        "unit": "Stk",
        "unit_price_eur": "245.00",
        "total_price_eur": "6370.00",
        "extraction_confidence": "0.97",
        **overrides,
    }
    return client.post(
        f"/api/projects/{project_id}/line-items/extract/{job_id}/confirm",
        headers=auth_headers(token),
        json={"items": [item]},
    )


@pytest.mark.parametrize("field", ["quantity_required", *PRICE_FIELDS])
def test_confirm_refuses_a_huge_number(client: TestClient, admin_token: str, field: str):
    project_id = _project(client, admin_token)
    job_id = _completed_job(project_id)
    response = _confirm(client, admin_token, project_id, job_id, **{field: HUGE})
    assert response.status_code == 422, response.text
    assert _stored_rows(project_id) == []


def test_confirm_refuses_a_line_total_over_the_column(client: TestClient, admin_token: str):
    project_id = _project(client, admin_token)
    job_id = _completed_job(project_id)
    response = _confirm(
        client,
        admin_token,
        project_id,
        job_id,
        quantity_required=str(MAX_STOCK_QUANTITY),
        unit_price_eur="10000.00",
        total_price_eur=None,
    )
    assert response.status_code == 422, response.text
    assert _stored_rows(project_id) == []


def test_confirm_accepts_the_largest_allowed_values(client: TestClient, admin_token: str):
    project_id = _project(client, admin_token)
    job_id = _completed_job(project_id)
    response = _confirm(
        client,
        admin_token,
        project_id,
        job_id,
        quantity_required=str(MAX_STOCK_QUANTITY),
        unit_price_eur=LARGEST_PRICE_AT_MAX_QUANTITY,
        total_price_eur=str(NUMERIC_12_2_MAX),
    )
    assert response.status_code == 200, response.text
    (row,) = _stored_rows(project_id)
    assert row.quantity_required == Decimal(MAX_STOCK_QUANTITY)
    assert row.total_price_eur == NUMERIC_12_2_MAX


# ── extraction worker: LLM numbers are external input ───────────────────


def _run_extraction(
    client: TestClient,
    admin_token: str,
    monkeypatch: pytest.MonkeyPatch,
    items: list[dict[str, Any]],
) -> tuple[int, int]:
    """Enqueue a job, let the (stubbed) model answer ``items``, process it.
    Returns (project_id, job_id)."""
    monkeypatch.setattr(line_item_extraction, "get_openai_client", lambda db: object())
    monkeypatch.setattr(line_item_extraction, "get_extraction_model", lambda db: "gpt-4o-mini")
    parsed = ExtractedLineItemList(items=[ExtractedLineItem(**item) for item in items])
    monkeypatch.setattr(
        line_item_extraction,
        "_call_openai_structured",
        lambda client_obj, *, model, messages: (parsed, 10, 5),
    )
    project_id = _project(client, admin_token)
    enqueue = client.post(
        f"/api/projects/{project_id}/line-items/extract",
        headers=auth_headers(admin_token),
        data={"doc_type": DOC_TYPE_AUFTRAGSBESTAETIGUNG, "email_text": "(synthetic)"},
    )
    assert enqueue.status_code == 202, enqueue.text
    job_id = enqueue.json()["job_id"]
    with SessionLocal() as db:
        claimed = line_item_extraction.claim_next_line_item_extraction_job(db)
        assert claimed is not None and claimed.id == job_id
        line_item_extraction.process_line_item_extraction_job(db, job_id)
    return project_id, job_id


def _llm_item(**overrides: Any) -> dict[str, Any]:
    return {
        "type": "material",
        "description": "Solarkabel 6 mm²",
        "quantity_required": 100.0,
        "unit": "m",
        "unit_price_eur": 1.25,
        "total_price_eur": 125.0,
        "confidence": 0.95,
        **overrides,
    }


def _poll(client: TestClient, token: str, project_id: int, job_id: int) -> dict:
    response = client.get(
        f"/api/projects/{project_id}/line-items/extract/{job_id}",
        headers=auth_headers(token),
    )
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize(
    "value", [float("inf"), float("nan"), 1e300, -5.0], ids=["inf", "nan", "1e300", "negative"]
)
@pytest.mark.parametrize("field", ["quantity_required", *PRICE_FIELDS])
def test_extraction_drops_a_number_it_cannot_store(
    client: TestClient,
    admin_token: str,
    monkeypatch: pytest.MonkeyPatch,
    field: str,
    value: float,
):
    """The job completes, the importer's poll answers, the unusable number
    is null (the operator fills it in) and the row is flagged for review
    with a confidence below the importer's 0.7 highlight threshold."""
    project_id, job_id = _run_extraction(
        client, admin_token, monkeypatch, [_llm_item(**{field: value})]
    )
    job = _poll(client, admin_token, project_id, job_id)
    assert job["status"] == EXTRACTION_JOB_STATUS_COMPLETED
    (item,) = job["extracted_items_json"]
    assert item[field] is None
    assert item["confidence"] < 0.7
    untouched = {"quantity_required", *PRICE_FIELDS} - {field}
    for other in untouched:
        assert item[other] == _llm_item()[other]


def test_extraction_keeps_the_largest_storable_numbers(
    client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch
):
    largest = _llm_item(
        quantity_required=float(MAX_STOCK_QUANTITY),
        unit_price_eur=float(LARGEST_PRICE_AT_MAX_QUANTITY),
        total_price_eur=float(NUMERIC_12_2_MAX),
    )
    project_id, job_id = _run_extraction(client, admin_token, monkeypatch, [largest])
    (item,) = _poll(client, admin_token, project_id, job_id)["extracted_items_json"]
    assert item["quantity_required"] == largest["quantity_required"]
    assert item["unit_price_eur"] == largest["unit_price_eur"]
    assert item["total_price_eur"] == largest["total_price_eur"]
    assert item["confidence"] == largest["confidence"]


def test_extraction_drops_a_unit_price_whose_line_total_overflows(
    client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch
):
    """Each factor fits, the product does not: the confirm would refuse it,
    so the review row arrives without the unit price and flagged."""
    project_id, job_id = _run_extraction(
        client,
        admin_token,
        monkeypatch,
        [_llm_item(quantity_required=float(MAX_STOCK_QUANTITY), unit_price_eur=10_000.0, total_price_eur=None)],
    )
    (item,) = _poll(client, admin_token, project_id, job_id)["extracted_items_json"]
    assert item["quantity_required"] == float(MAX_STOCK_QUANTITY)
    assert item["unit_price_eur"] is None
    assert item["confidence"] < 0.7
