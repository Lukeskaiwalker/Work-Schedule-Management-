"""Partners report their working hours on a task or on a project.

What must hold:

* a partner reports a day, how many people and how many hours each, on one
  of their tasks or projects; the entry shows there for them and for the
  office, and leaves a line in the activity log;
* the numbers are checked: 1–50 people, quarter hours up to 24 per person,
  no date in the future and none more than a year back;
* the anchor must be something the partner sees — a task of theirs or a
  project they see — and a miss is a 404 like everywhere in the portal;
* another partner's entries on the same task are never shown to them;
* a partner removes their own company's entry for a week, never later and
  never another company's; the office removes any with ``projects:manage``.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.core.time import utcnow
from app.models.entities import PartnerTimeEntry, ProjectActivity
from tests.conftest import auth_headers
from tests.partner_portal_helpers import (
    accept_and_login,
    create_employee,
    create_task,
    invite_portal_user,
    portal_world,
)


def _report(client: TestClient, token: str, **fields):
    payload = {"work_date": str(date.today()), "workers": 1, "hours": 8, **fields}
    return client.post("/api/portal/hours", headers=auth_headers(token), json=payload)


def test_a_partner_reports_hours_on_a_task_and_both_sides_see_them(client: TestClient, admin_token: str) -> None:
    w = portal_world(client, admin_token)
    reported = _report(client, w["token"], task_id=w["mine"]["id"], workers=2, hours=7.5, note="Rinne gesetzt, Fallrohre montiert")
    assert reported.status_code == 201, reported.text
    entry = reported.json()
    assert entry["total_hours"] == 15
    assert entry["workers"] == 2 and entry["hours"] == 7.5
    assert entry["task"] == {"id": w["mine"]["id"], "title": "Dachrinne und Fallrohre erneuern"}
    assert entry["reported_by"] == "Andreas Hoffmann"
    assert entry["can_delete"] is True

    head = auth_headers(w["token"])
    task = client.get(f"/api/portal/tasks/{w['mine']['id']}", headers=head).json()
    assert [row["id"] for row in task["hours"]] == [entry["id"]]
    assert task["hours_total"] == 15
    project = client.get(f"/api/portal/projects/{w['project']['id']}", headers=head).json()
    assert [row["id"] for row in project["hours"]] == [entry["id"]]
    assert project["hours_total"] == 15

    office = auth_headers(admin_token)
    on_task = client.get(f"/api/tasks/{w['mine']['id']}/partner-hours", headers=office)
    assert on_task.status_code == 200, on_task.text
    row = on_task.json()[0]
    assert row["partner"]["name"] == "Bedachungen Hoffmann KG"
    assert row["total_hours"] == 15 and row["note"] == "Rinne gesetzt, Fallrohre montiert"
    on_project = client.get(f"/api/projects/{w['project']['id']}/partner-hours", headers=office).json()
    assert [r["id"] for r in on_project] == [entry["id"]]

    partners = client.get(f"/api/projects/{w['project']['id']}/partners", headers=office).json()
    by_name = {r["partner"]["name"]: r for r in partners}
    assert by_name["Bedachungen Hoffmann KG"]["hours_total"] == 15
    assert by_name["Bedachungen Hoffmann KG"]["assigned"] is False  # on the project through its tasks only

    with SessionLocal() as db:
        events = db.scalars(
            select(ProjectActivity.event_type).where(ProjectActivity.project_id == w["project"]["id"])
        ).all()
    assert "partner.hours_reported" in events


def test_hours_on_a_project_without_a_task(client: TestClient, admin_token: str) -> None:
    w = portal_world(client, admin_token)
    reported = _report(client, w["token"], project_id=w["braun"]["id"], workers=3, hours=4, note="Gerüst gestellt")
    assert reported.status_code == 201, reported.text
    assert reported.json()["task"] is None
    head = auth_headers(w["token"])
    project = client.get(f"/api/portal/projects/{w['braun']['id']}", headers=head).json()
    assert project["hours_total"] == 12
    overdue_task = client.get(f"/api/portal/tasks/{w['overdue']['id']}", headers=head).json()
    assert overdue_task["hours"] == [] and overdue_task["hours_total"] == 0

    # A task given together with its own project is fine; with another one it is not.
    same = _report(client, w["token"], task_id=w["overdue"]["id"], project_id=w["braun"]["id"])
    assert same.status_code == 201, same.text
    mismatch = _report(client, w["token"], task_id=w["overdue"]["id"], project_id=w["project"]["id"])
    assert mismatch.status_code == 400, mismatch.text


def test_hours_on_a_customer_task_have_no_project(client: TestClient, admin_token: str) -> None:
    w = portal_world(client, admin_token)
    reported = _report(client, w["token"], task_id=w["customer_only"]["id"], hours=3)
    assert reported.status_code == 201, reported.text
    office = client.get(f"/api/tasks/{w['customer_only']['id']}/partner-hours", headers=auth_headers(admin_token)).json()
    assert len(office) == 1 and office[0]["project_id"] is None


@pytest.mark.parametrize(
    "fields",
    [
        {"workers": 0},
        {"workers": 51},
        {"hours": 0},
        {"hours": 24.25},
        {"hours": 1.3},
        {"hours": -2},
        {"note": "x" * 2001},
        {"work_date": str(date.today() + timedelta(days=2))},
        {"work_date": str(date.today() - timedelta(days=400))},
    ],
)
def test_hours_are_checked(client: TestClient, admin_token: str, fields: dict) -> None:
    w = portal_world(client, admin_token)
    response = _report(client, w["token"], task_id=w["mine"]["id"], **fields)
    assert response.status_code in (400, 422), (fields, response.text)


def test_hours_need_a_task_or_project_the_partner_sees(client: TestClient, admin_token: str) -> None:
    w = portal_world(client, admin_token)
    assert _report(client, w["token"]).status_code == 422
    assert _report(client, w["token"], task_id=w["theirs"]["id"]).status_code == 404
    assert _report(client, w["token"], task_id=w["internal"]["id"]).status_code == 404
    assert _report(client, w["token"], project_id=w["hidden"]["id"]).status_code == 404
    assert _report(client, w["token"], task_id=999_999).status_code == 404
    # Staff report their time in the office app, not here.
    staff = client.post(
        "/api/portal/hours",
        headers=auth_headers(admin_token),
        json={"task_id": w["mine"]["id"], "work_date": str(date.today()), "workers": 1, "hours": 1},
    )
    assert staff.status_code == 403


def _second_login(client: TestClient, admin_token: str, partner_id: int) -> str:
    invite = invite_portal_user(client, admin_token, partner_id, email="s.wagner@wagner-sanitaer.de", full_name="Stefan Wagner")
    return accept_and_login(client, invite)


def test_another_partners_hours_on_the_same_task_stay_hidden(client: TestClient, admin_token: str) -> None:
    w = portal_world(client, admin_token)
    shared = create_task(
        client,
        admin_token,
        project_id=w["project"]["id"],
        title="Dachdurchführung Lüftung",
        partner_ids=[w["partner"]["id"], w["other"]["id"]],
    )
    wagner = _second_login(client, admin_token, w["other"]["id"])
    theirs = _report(client, wagner, task_id=shared["id"], workers=1, hours=2, note="Lüftungsrohr gesetzt")
    assert theirs.status_code == 201, theirs.text
    mine = _report(client, w["token"], task_id=shared["id"], workers=2, hours=3)
    assert mine.status_code == 201, mine.text

    task = client.get(f"/api/portal/tasks/{shared['id']}", headers=auth_headers(w["token"]))
    assert [row["id"] for row in task.json()["hours"]] == [mine.json()["id"]]
    assert task.json()["hours_total"] == 6
    assert "Lüftungsrohr" not in task.text and "Stefan Wagner" not in task.text

    office = client.get(f"/api/tasks/{shared['id']}/partner-hours", headers=auth_headers(admin_token)).json()
    assert {row["partner"]["name"] for row in office} == {"Bedachungen Hoffmann KG", "Wagner Sanitär e.K."}


def test_removing_hours(client: TestClient, admin_token: str) -> None:
    w = portal_world(client, admin_token)
    head = auth_headers(w["token"])
    fresh = _report(client, w["token"], task_id=w["mine"]["id"]).json()
    removed = client.delete(f"/api/portal/hours/{fresh['id']}", headers=head)
    assert removed.status_code == 204, removed.text
    assert client.get(f"/api/portal/tasks/{w['mine']['id']}", headers=head).json()["hours"] == []

    old = _report(client, w["token"], task_id=w["mine"]["id"], work_date=str(date.today() - timedelta(days=9))).json()
    with SessionLocal() as db:
        row = db.get(PartnerTimeEntry, old["id"])
        row.created_at = utcnow() - timedelta(days=8)
        db.commit()
    listed = client.get(f"/api/portal/tasks/{w['mine']['id']}", headers=head).json()["hours"]
    assert listed[0]["can_delete"] is False
    assert client.delete(f"/api/portal/hours/{old['id']}", headers=head).status_code == 409

    wagner = _second_login(client, admin_token, w["other"]["id"])
    theirs = _report(client, wagner, task_id=w["theirs"]["id"]).json()
    assert client.delete(f"/api/portal/hours/{theirs['id']}", headers=head).status_code == 404
    assert client.delete("/api/portal/hours/999999", headers=head).status_code == 404

    create_employee(client, admin_token, "fitter@example.com", "Fritz Fitter")
    login = client.post("/api/auth/login", json={"email": "fitter@example.com", "password": "Password123!"})
    fitter = auth_headers(login.headers["X-Access-Token"])
    assert client.delete(f"/api/partner-hours/{old['id']}", headers=fitter).status_code == 403
    office = client.delete(f"/api/partner-hours/{old['id']}", headers=auth_headers(admin_token))
    assert office.status_code == 204, office.text
    assert client.delete(f"/api/partner-hours/{old['id']}", headers=auth_headers(admin_token)).status_code == 404
    assert client.get(f"/api/tasks/{w['mine']['id']}/partner-hours", headers=auth_headers(admin_token)).json() == []
    with SessionLocal() as db:
        # Removed, not erased: the row stays as the record of what was reported.
        kept = db.get(PartnerTimeEntry, old["id"])
        assert kept is not None and kept.deleted_at is not None and kept.deleted_by is not None
        events = db.scalars(
            select(ProjectActivity.event_type).where(ProjectActivity.project_id == w["project"]["id"])
        ).all()
    assert events.count("partner.hours_deleted") == 2


def test_a_flood_of_reports_is_stopped(client: TestClient, admin_token: str) -> None:
    """A partner login is internet-facing: a stolen one must not be able to
    bury the office in rows. A company gets MAX_REPORTS_PER_DAY a day."""
    from app.services.partner_hours import MAX_REPORTS_PER_DAY

    w = portal_world(client, admin_token)
    with SessionLocal() as db:
        db.add_all(
            PartnerTimeEntry(
                partner_id=w["partner"]["id"],
                project_id=w["project"]["id"],
                task_id=w["mine"]["id"],
                work_date=date.today(),
                workers=1,
                hours=1,
                created_at=utcnow(),
            )
            for _ in range(MAX_REPORTS_PER_DAY)
        )
        db.commit()
    blocked = _report(client, w["token"], task_id=w["mine"]["id"])
    assert blocked.status_code == 429, blocked.text
    # Another company is not affected by this one's count.
    wagner = _second_login(client, admin_token, w["other"]["id"])
    assert _report(client, wagner, task_id=w["theirs"]["id"]).status_code == 201


def test_taking_reports_back_does_not_reset_the_daily_cap(client: TestClient, admin_token: str) -> None:
    from app.services.partner_hours import MAX_REPORTS_PER_DAY

    w = portal_world(client, admin_token)
    with SessionLocal() as db:
        db.add_all(
            PartnerTimeEntry(
                partner_id=w["partner"]["id"],
                project_id=w["project"]["id"],
                task_id=w["mine"]["id"],
                work_date=date.today(),
                workers=1,
                hours=1,
                created_at=utcnow(),
                deleted_at=utcnow(),
            )
            for _ in range(MAX_REPORTS_PER_DAY)
        )
        db.commit()
    assert _report(client, w["token"], task_id=w["mine"]["id"]).status_code == 429


def test_a_partner_takes_back_their_report_after_leaving_the_task(client: TestClient, admin_token: str) -> None:
    w = portal_world(client, admin_token)
    entry = _report(client, w["token"], task_id=w["undated"]["id"], hours=2).json()
    unassigned = client.patch(f"/api/tasks/{w['undated']['id']}", headers=auth_headers(admin_token), json={"partner_ids": []})
    assert unassigned.status_code == 200, unassigned.text
    head = auth_headers(w["token"])
    project = client.get(f"/api/portal/projects/{w['project']['id']}", headers=head).json()  # still theirs via another task
    listed = {row["id"]: row for row in project["hours"]}
    assert listed[entry["id"]]["can_delete"] is True
    assert client.delete(f"/api/portal/hours/{entry['id']}", headers=head).status_code == 204


def test_a_customer_task_with_partner_hours_is_not_deleted_from_under_them(client: TestClient, admin_token: str) -> None:
    w = portal_world(client, admin_token)
    office = auth_headers(admin_token)
    entry = _report(client, w["token"], task_id=w["customer_only"]["id"], hours=3).json()
    refused = client.delete(f"/api/tasks/{w['customer_only']['id']}", headers=office)
    assert refused.status_code == 409, refused.text
    assert client.delete(f"/api/partner-hours/{entry['id']}", headers=office).status_code == 204
    assert client.delete(f"/api/tasks/{w['customer_only']['id']}", headers=office).status_code == 200

    # A project task may go: its hours stay on the project.
    on_project = _report(client, w["token"], task_id=w["undated"]["id"], hours=2).json()
    assert client.delete(f"/api/tasks/{w['undated']['id']}", headers=office).status_code == 200
    rows = client.get(f"/api/projects/{w['project']['id']}/partner-hours", headers=office).json()
    kept = [row for row in rows if row["id"] == on_project["id"]]
    assert len(kept) == 1 and kept[0]["task"] is None

