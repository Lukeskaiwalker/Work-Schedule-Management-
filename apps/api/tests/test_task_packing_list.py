"""Packliste PDF for a task (GET /api/tasks/{id}/packing-list.pdf).

Covers the access rule (manager, assigned employee, unrelated employee), the
two data sources (box-imported material rows, free-text fallback) and the
"nothing to pack" refusal. The renderer itself is exercised directly for the
parts a single API call cannot show: pagination and the reported-usage note.
"""
from __future__ import annotations

import base64
import re
import zlib
from datetime import date, datetime, time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.services.task_packing_list import (
    PackingLine,
    lines_from_free_text,
    render_packing_list,
)
from tests.test_tasks_construction_box import (
    _box,
    _create_task,
    _customer,
    _pack,
    auth_headers,
)

_EMPLOYEE_PASSWORD = "Password123!"


# ── Helpers ──────────────────────────────────────────────────────────────────


def _employee_token(client: TestClient, admin_token: str, email: str) -> str:
    created = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={
            "email": email,
            "password": _EMPLOYEE_PASSWORD,
            "full_name": "Monteur",
            "role": "employee",
        },
    )
    assert created.status_code == 200, created.text
    login = client.post("/api/auth/login", json={"email": email, "password": _EMPLOYEE_PASSWORD})
    assert login.status_code == 200, login.text
    return login.headers["X-Access-Token"]


def _employee_id(client: TestClient, admin_token: str, email: str) -> int:
    users = client.get("/api/admin/users", headers=auth_headers(admin_token))
    assert users.status_code == 200, users.text
    return next(row["id"] for row in users.json() if row["email"] == email)


def _pdf_text(pdf: bytes) -> bytes:
    """Join the string operands of every ``Tj`` in the page streams.

    Same approach as tests/test_training_reports.py: ReportLab splits a
    paragraph into many ``(…) Tj`` runs, so a literal must be searched in
    the concatenation, not expected as one contiguous operand.
    """
    streams = b""
    for match in re.finditer(rb"stream\r?\n", pdf):
        chunk = pdf[match.end() : pdf.find(b"endstream", match.end())].strip()
        try:
            data = base64.a85decode(chunk, adobe=True) if chunk.endswith(b"~>") else chunk
            streams += zlib.decompress(data)
        except Exception:
            continue
    joined = b"".join(re.findall(rb"\(((?:[^()\\]|\\.)*)\)\s*Tj", streams))
    # PDF string literals escape parentheses and backslashes; undo that so
    # assertions can read like the text on the page.
    return re.sub(rb"\\([()\\])", rb"\1", joined)


def _page_count(pdf: bytes) -> int:
    return len(re.findall(rb"/Type\s*/Page[^s]", pdf))


def _packing_list(client: TestClient, token: str, task_id: int):
    return client.get(f"/api/tasks/{task_id}/packing-list.pdf", headers=auth_headers(token))


def _boxed_task(client: TestClient, admin_token: str, **extra) -> tuple[int, dict]:
    """A customer task linked to a box holding two named items."""
    customer_id = _customer(client, admin_token, "Packlisten Kunde")
    box = _box(client, admin_token, "Kiste Packliste")
    _pack(client, admin_token, box["id"], "Wago 285-1185", 12)
    _pack(client, admin_token, box["id"], "Hager K96DB", 3)
    created = _create_task(
        client,
        admin_token,
        title="Verteiler tauschen",
        customer_id=customer_id,
        construction_box_id=box["id"],
        due_date="2026-09-10",
        **extra,
    )
    assert created.status_code == 200, created.text
    return created.json()["id"], box


# ── API ──────────────────────────────────────────────────────────────────────


def test_manager_gets_the_packing_list_as_inline_pdf(client: TestClient, admin_token: str):
    task_id, box = _boxed_task(client, admin_token)

    resp = _packing_list(client, admin_token, task_id)

    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "application/pdf"
    assert resp.headers["content-disposition"].startswith(
        f'inline; filename="Packliste-Aufgabe-{task_id}.pdf"'
    )
    assert resp.content[:4] == b"%PDF"
    text = _pdf_text(resp.content)
    assert b"Packliste" in text
    assert b"Verteiler tauschen" in text
    assert b"Wago 285-1185" in text
    assert b"Hager K96DB" in text
    assert b"Packlisten Kunde" in text
    assert box["box_number"].encode() in text
    assert b"10.09.2026" in text


def test_assigned_employee_gets_the_packing_list(client: TestClient, admin_token: str):
    email = "monteur@example.com"
    token = _employee_token(client, admin_token, email)
    task_id, _ = _boxed_task(
        client, admin_token, assignee_ids=[_employee_id(client, admin_token, email)]
    )

    resp = _packing_list(client, token, task_id)

    assert resp.status_code == 200, resp.text
    assert resp.content[:4] == b"%PDF"


def test_unrelated_employee_is_told_the_task_does_not_exist(
    client: TestClient, admin_token: str
):
    assigned = "monteur-a@example.com"
    _employee_token(client, admin_token, assigned)
    stranger_token = _employee_token(client, admin_token, "monteur-b@example.com")
    task_id, _ = _boxed_task(
        client, admin_token, assignee_ids=[_employee_id(client, admin_token, assigned)]
    )

    resp = _packing_list(client, stranger_token, task_id)

    # Same answer as for a missing id: the response must not leak existence.
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"] == "Task not found"


def test_missing_task_is_404(client: TestClient, admin_token: str):
    resp = _packing_list(client, admin_token, 999_999)
    assert resp.status_code == 404, resp.text


def test_free_text_materials_fall_back_to_one_row_per_line(
    client: TestClient, admin_token: str
):
    customer_id = _customer(client, admin_token, "Freitext Kunde")
    created = _create_task(
        client,
        admin_token,
        customer_id=customer_id,
        materials_required="3x Wago 221\n\n- Kabelbinder schwarz\n  Leerrohr M25 ",
    )
    assert created.status_code == 200, created.text

    resp = _packing_list(client, admin_token, created.json()["id"])

    assert resp.status_code == 200, resp.text
    text = _pdf_text(resp.content)
    assert b"3x Wago 221" in text
    assert b"Kabelbinder schwarz" in text
    assert b"Leerrohr M25" in text


def test_task_without_any_material_is_refused(client: TestClient, admin_token: str):
    customer_id = _customer(client, admin_token, "Leer Kunde")
    created = _create_task(client, admin_token, customer_id=customer_id)
    assert created.status_code == 200, created.text

    resp = _packing_list(client, admin_token, created.json()["id"])

    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"] == "Keine Packliste: der Aufgabe ist kein Material zugeordnet."


# ── Renderer ─────────────────────────────────────────────────────────────────


def _task_stub(**overrides) -> SimpleNamespace:
    base = dict(
        title="Zählerschrank tauschen",
        due_date=date(2026, 9, 10),
        start_time=time(8, 0),
        estimated_hours=4.5,
        week_start=None,
    )
    return SimpleNamespace(**{**base, **overrides})


def _render(lines: list[PackingLine], **overrides) -> bytes:
    return render_packing_list(
        task=_task_stub(),
        materials=lines,
        customer_name=overrides.get("customer_name", "Müller GmbH"),
        project_label=overrides.get("project_label"),
        box_label=overrides.get("box_label"),
        generated_at=datetime(2026, 9, 8, 14, 30),
    )


def test_long_lists_paginate_and_repeat_the_header():
    lines = [
        PackingLine(item_name=f"Artikel {i}", quantity=i, unit="Stk", article_no=f"A-{i:03d}")
        for i in range(1, 80)
    ]

    pdf = _render(lines)

    assert _page_count(pdf) >= 2
    text = _pdf_text(pdf)
    assert text.count(b"Art.-Nr.") == _page_count(pdf)
    assert b"Seite 1 von " in text
    assert b"Erstellt am 08.09.2026 14:30" in text


def test_reported_usage_is_appended_to_the_note():
    lines = [
        PackingLine(item_name="Wago 221", quantity=10, notes="Reserve", quantity_used=4),
        PackingLine(item_name="Hager K96DB", quantity=2, quantity_used=None),
    ]

    text = _pdf_text(_render(lines))

    assert b"Reserve (gemeldet: 4)" in text
    assert text.count(b"gemeldet") == 1


def test_renderer_refuses_an_empty_list():
    with pytest.raises(ValueError):
        _render([])


def test_free_text_lines_drop_blanks_and_bullets():
    lines = lines_from_free_text(" - 3x Wago\n\n• Kabelbinder \n*Leerrohr")

    assert [line.item_name for line in lines] == ["3x Wago", "Kabelbinder", "Leerrohr"]
    assert all(line.quantity is None for line in lines)
    assert lines_from_free_text(None) == []
    assert lines_from_free_text("  \n ") == []
