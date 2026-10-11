"""A report writes reported usage only onto a crate it speaks for.

A row prefilled from a task carries the task line's id, and the report's
``qty`` becomes that line's ``quantity_used`` — the number the task's
completion books against the shelf. The line used to be found from the ids in
the request body alone, so a report filed on project B could name a line of a
task in project A, which its author could not even open: a "0" row zeroed the
line, every other line of that task was zeroed as "not mentioned", and the
completion then booked the whole crate back to the shelf.

The rule pinned here: a report speaks for the task it is anchored to.

  * A project report writes only onto a task of that same project (whose
    access the report route has already checked).
  * A report without a project writes only onto a customer-only task, and
    only one its author could complete themselves (``tasks:manage``, or
    assigned to it) — and, when the report names a customer, only that
    customer's task. Customer-only tasks carry crates too, and the web files
    their reports without a project, so this path must keep working.

A row that names a line the report does not speak for is ignored like a
hand-typed one; the report itself is still filed.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import auth_headers
from tests.test_task_material_settlement import (
    _article,
    _box,
    _customer,
    _hand_over,
    _materials,
    _movements,
    _pack_article,
    _project,
    _set_status,
    _Site,
    _task,
)

_REPORT_DATE = "2026-09-08"


def _employee(client: TestClient, admin_token: str, email: str) -> tuple[int, str]:
    created = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={
            "email": email,
            "password": "Password123!",
            "full_name": email.split("@")[0],
            "role": "employee",
        },
    )
    assert created.status_code == 200, created.text
    login = client.post("/api/auth/login", json={"email": email, "password": "Password123!"})
    assert login.status_code == 200, login.text
    return created.json()["id"], login.headers["X-Access-Token"]


def _post_report(client: TestClient, token: str, url: str, body: dict) -> None:
    resp = client.post(url, headers=auth_headers(token), json=body)
    # The report is the fitter's day: it is filed whatever its rows name.
    assert resp.status_code == 200, resp.text


def _project_report(
    client: TestClient, token: str, project_id: int, rows: list[dict], **payload
) -> None:
    _post_report(
        client,
        token,
        f"/api/projects/{project_id}/construction-reports",
        {
            "report_date": _REPORT_DATE,
            "payload": {"workers": [{"name": "Monteur"}], "materials_consumed": rows, **payload},
        },
    )


def _projectless_report(
    client: TestClient, token: str, rows: list[dict], *, customer_id: int | None = None
) -> None:
    body: dict = {
        "report_date": _REPORT_DATE,
        "payload": {"workers": [{"name": "Monteur"}], "materials_consumed": rows},
    }
    if customer_id is not None:
        body["customer_id"] = customer_id
    _post_report(client, token, "/api/construction-reports", body)


def _row(line_id: int, qty: str) -> dict:
    return {"item": "Wago 221-415", "qty": qty, "unit": "Stk", "task_material_id": line_id}


class _CustomerTask:
    """A handed-over crate on a customer-only task (no project at all)."""

    def __init__(self, client: TestClient, admin_token: str, *, assignee_ids: list[int]):
        self.customer_id = _customer(client, admin_token, "Kunde Ohne Projekt")
        self.article_id = _article(client, admin_token, "Wago 221-415", 20)
        self.box = _box(client, admin_token, "Kiste Ohne Projekt")
        _pack_article(client, admin_token, self.box["id"], self.article_id, 10)
        _hand_over(client, admin_token, self.box["id"], self.customer_id)
        self.task = _task(
            client,
            admin_token,
            customer_id=self.customer_id,
            construction_box_id=self.box["id"],
            assignee_ids=assignee_ids,
        )
        assert self.task["project_id"] is None
        self.line = _materials(client, admin_token, self.task["id"])[0]


# ── Project reports ──────────────────────────────────────────────────────────


def test_a_report_on_another_project_cannot_write_a_crate_its_author_cannot_open(
    client: TestClient, admin_token: str
):
    """The reviewer's reproduction, step for step."""
    victim = _Site(client, admin_token)
    other_project = _project(client, admin_token, "Baustelle B", victim.customer_id)
    employee_id, employee_token = _employee(client, admin_token, "fremd@example.com")
    removed = client.delete(
        f"/api/projects/{victim.project_id}/members/{employee_id}",
        headers=auth_headers(admin_token),
    )
    assert removed.status_code == 204, removed.text
    shut_out = client.get(
        f"/api/projects/{victim.project_id}/overview", headers=auth_headers(employee_token)
    )
    assert shut_out.status_code == 403, shut_out.text

    _project_report(client, employee_token, other_project, [_row(victim.line["id"], "0")])

    assert _materials(client, admin_token, victim.task["id"])[0]["quantity_used"] is None
    # And so the completion settles the crate as fully fitted, as if no
    # report had come in — not as all ten back on the shelf.
    _set_status(client, admin_token, victim.task["id"], "done")
    assert _movements(victim.article_id)[2:] == [("correction", 10, victim.box["id"])]


def test_a_report_on_another_project_cannot_write_a_crate_even_for_an_admin(
    client: TestClient, admin_token: str
):
    """Not a permission question only: a report on B does not speak for A's crate."""
    victim = _Site(client, admin_token)
    other_project = _project(client, admin_token, "Baustelle B Admin", victim.customer_id)

    _project_report(client, admin_token, other_project, [_row(victim.line["id"], "3")])

    assert _materials(client, admin_token, victim.task["id"])[0]["quantity_used"] is None


def test_a_project_report_without_source_task_still_writes_its_own_projects_crate(
    client: TestClient, admin_token: str
):
    """Re-picking the project in the form clears the task link but keeps the
    prefilled rows; they still describe this project's crate."""
    site = _Site(client, admin_token)

    _project_report(client, admin_token, site.project_id, [_row(site.line["id"], "6")])

    assert _materials(client, admin_token, site.task["id"])[0]["quantity_used"] == 6


def test_a_project_report_cannot_write_a_customer_only_crate(
    client: TestClient, admin_token: str
):
    customer_task = _CustomerTask(client, admin_token, assignee_ids=[])
    site = _Site(client, admin_token)

    _project_report(client, admin_token, site.project_id, [_row(customer_task.line["id"], "0")])

    assert _materials(client, admin_token, customer_task.task["id"])[0]["quantity_used"] is None


# ── Reports without a project ────────────────────────────────────────────────


def test_a_projectless_report_writes_the_customer_only_crate_of_its_assignee(
    client: TestClient, admin_token: str
):
    """The web's own flow for a customer-only task: no project, no source task."""
    employee_id, employee_token = _employee(client, admin_token, "monteur@example.com")
    customer_task = _CustomerTask(client, admin_token, assignee_ids=[employee_id])

    _projectless_report(client, employee_token, [_row(customer_task.line["id"], "6")])

    assert _materials(client, admin_token, customer_task.task["id"])[0]["quantity_used"] == 6


def test_a_projectless_report_by_the_office_writes_a_customer_only_crate(
    client: TestClient, admin_token: str
):
    customer_task = _CustomerTask(client, admin_token, assignee_ids=[])

    _projectless_report(
        client,
        admin_token,
        [_row(customer_task.line["id"], "4")],
        customer_id=customer_task.customer_id,
    )

    assert _materials(client, admin_token, customer_task.task["id"])[0]["quantity_used"] == 4


def test_a_projectless_report_cannot_write_a_customer_only_crate_of_someone_elses_task(
    client: TestClient, admin_token: str
):
    assignee_id, _ = _employee(client, admin_token, "zugewiesen@example.com")
    _, stranger_token = _employee(client, admin_token, "fremder@example.com")
    customer_task = _CustomerTask(client, admin_token, assignee_ids=[assignee_id])

    _projectless_report(client, stranger_token, [_row(customer_task.line["id"], "0")])

    assert _materials(client, admin_token, customer_task.task["id"])[0]["quantity_used"] is None


def test_a_projectless_report_for_another_customer_cannot_write_the_crate(
    client: TestClient, admin_token: str
):
    customer_task = _CustomerTask(client, admin_token, assignee_ids=[])
    other_customer = _customer(client, admin_token, "Anderer Kunde")

    _projectless_report(
        client, admin_token, [_row(customer_task.line["id"], "0")], customer_id=other_customer
    )

    assert _materials(client, admin_token, customer_task.task["id"])[0]["quantity_used"] is None


def test_a_projectless_report_cannot_write_a_project_crate(
    client: TestClient, admin_token: str
):
    site = _Site(client, admin_token)

    _projectless_report(client, admin_token, [_row(site.line["id"], "0")])

    assert _materials(client, admin_token, site.task["id"])[0]["quantity_used"] is None
