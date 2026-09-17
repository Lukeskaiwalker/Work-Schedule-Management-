"""A task can span days: ``end_date`` (Bis) next to ``due_date`` (Von).

Every reader that used to treat due_date as THE day now reads a window, and
each of those readers is pinned here because they were changed one by one and
could drift apart again just as easily:

  * the range rule — an end needs a start and may not lie before it; an end
    equal to the start is stored as NULL (the one canonical single-day form)
  * overdue counts from the LAST day, so day two of three is not red
  * the overlap check intersects windows: a daily 08:00 slot on Mon–Wed does
    collide with a Tuesday 09:00 job for the same person
  * the planning week shows the task on every day it covers, on both sides of
    a week boundary
  * moving only "Bis" voids the customer's yes exactly like moving "Von"
  * ``view=my_all`` lists my done tasks too, but only the recent ones
  * the public confirmation page and the packing list read the window
"""

from __future__ import annotations

from datetime import date, time, timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.core.time import utcnow
from app.routers.workflow_helpers import (
    _find_task_overlaps,
    _task_days_in_window,
    _task_is_overdue,
    _validate_task_date_range,
)
from app.schemas.task import TASK_DATE_RANGE_DETAIL, TASK_END_WITHOUT_START_DETAIL
from app.services.customer_confirmation_email import render_customer_confirmation_email
from app.services.task_packing_list import _task_schedule


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _project(client: TestClient, admin_token: str, number: str) -> int:
    resp = client.post(
        "/api/projects",
        headers=_auth(admin_token),
        json={"project_number": number, "name": f"Projekt {number}", "status": "active"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _employee(client: TestClient, admin_token: str, email: str) -> dict:
    resp = client.post(
        "/api/admin/users",
        headers=_auth(admin_token),
        json={"email": email, "password": "Password123!", "full_name": email.split("@")[0], "role": "employee"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _me(client: TestClient, token: str) -> dict:
    resp = client.get("/api/auth/me", headers=_auth(token))
    assert resp.status_code == 200, resp.text
    return resp.json()


def _create(client: TestClient, admin_token: str, **fields) -> dict:
    resp = client.post("/api/tasks", headers=_auth(admin_token), json=fields)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _patch(client: TestClient, admin_token: str, task_id: int, **fields):
    return client.patch(f"/api/tasks/{task_id}", headers=_auth(admin_token), json=fields)


# ── Pure helpers ─────────────────────────────────────────────────────────────


def test_days_in_window_clips_to_the_period_and_walks_every_day() -> None:
    task = SimpleNamespace(due_date=date(2026, 3, 4), end_date=date(2026, 3, 10))
    assert _task_days_in_window(task, date(2026, 3, 2), date(2026, 3, 8)) == [
        date(2026, 3, 4),
        date(2026, 3, 5),
        date(2026, 3, 6),
        date(2026, 3, 7),
        date(2026, 3, 8),
    ]
    # Next week picks up the tail.
    assert _task_days_in_window(task, date(2026, 3, 9), date(2026, 3, 15)) == [date(2026, 3, 9), date(2026, 3, 10)]
    # A single-day task (end NULL) is one day; an undated one is none.
    assert _task_days_in_window(SimpleNamespace(due_date=date(2026, 3, 4), end_date=None), date(2026, 3, 2), date(2026, 3, 8)) == [date(2026, 3, 4)]
    assert _task_days_in_window(SimpleNamespace(due_date=None, end_date=None), date(2026, 3, 2), date(2026, 3, 8)) == []
    # Outside the period entirely.
    assert _task_days_in_window(task, date(2026, 4, 1), date(2026, 4, 7)) == []


def test_range_rule_folds_same_day_onto_null_and_refuses_a_backwards_window() -> None:
    same = SimpleNamespace(due_date=date(2026, 3, 4), end_date=date(2026, 3, 4))
    _validate_task_date_range(same)
    assert same.end_date is None

    undated = SimpleNamespace(due_date=None, end_date=date(2026, 3, 4))
    _validate_task_date_range(undated)
    assert undated.end_date is None, "clearing Von takes Bis with it"

    backwards = SimpleNamespace(due_date=date(2026, 3, 4), end_date=date(2026, 3, 3))
    with pytest.raises(HTTPException) as exc:
        _validate_task_date_range(backwards)
    assert exc.value.status_code == 400
    assert exc.value.detail == "Das Enddatum darf nicht vor dem Startdatum liegen"
    assert exc.value.detail == TASK_DATE_RANGE_DETAIL, "PATCH and create share the one text"


def test_overdue_is_decided_by_the_last_day() -> None:
    today = date(2026, 3, 5)
    inside = SimpleNamespace(status="open", due_date=date(2026, 3, 4), end_date=date(2026, 3, 6))
    assert _task_is_overdue(inside, today=today) is False
    ended = SimpleNamespace(status="open", due_date=date(2026, 3, 2), end_date=date(2026, 3, 4))
    assert _task_is_overdue(ended, today=today) is True
    single = SimpleNamespace(status="open", due_date=date(2026, 3, 4), end_date=None)
    assert _task_is_overdue(single, today=today) is True


def test_packing_list_schedule_prints_the_window() -> None:
    task = SimpleNamespace(
        due_date=date(2026, 10, 1), end_date=date(2026, 10, 3), start_time=time(8, 0), estimated_hours=8.0, week_start=None
    )
    assert _task_schedule(task) == "01.10.2026 – 03.10.2026, 08:00 Uhr (ca. 8 h)"
    single = SimpleNamespace(due_date=date(2026, 10, 1), end_date=None, start_time=None, estimated_hours=None, week_start=None)
    assert _task_schedule(single) == "01.10.2026"


def test_confirmation_email_reads_vom_bis_for_a_window() -> None:
    common = dict(
        customer_name="Müller",
        task_title="Zählerschrank",
        task_description=None,
        due_date=date(2026, 10, 1),
        end_date=date(2026, 10, 3),
        start_time=time(8, 0),
        estimated_hours=8.0,
        worker_display_names=["Luca"],
        confirmation_token="abc",
        company_name="SMPL",
    )
    subject, body = render_customer_confirmation_email(language="de", **common)
    assert subject == "Terminbestätigung 01.10.2026 – 03.10.2026"
    assert "wir möchten Ihren Termin vom 01.10.2026 bis 03.10.2026, täglich ab 08:00 Uhr bestätigen." in body

    subject_en, body_en = render_customer_confirmation_email(language="en", **common)
    assert subject_en == "Appointment confirmation 2026-10-01 – 2026-10-03"
    assert "We would like to confirm your appointment from 2026-10-01 to 2026-10-03, daily from 08:00." in body_en

    # A single day keeps the wording every existing snapshot pins.
    subject_one, body_one = render_customer_confirmation_email(language="de", **{**common, "end_date": None})
    assert subject_one == "Terminbestätigung am 01.10.2026"
    assert "wir möchten Ihren Termin am 01.10.2026 08:00 bestätigen." in body_one


# ── API: create / update ─────────────────────────────────────────────────────


def test_create_stores_the_window_and_refuses_a_bad_one(client: TestClient, admin_token: str) -> None:
    project_id = _project(client, admin_token, "END-1")

    created = _create(client, admin_token, project_id=project_id, title="Drei Tage", due_date="2026-10-01", end_date="2026-10-03")
    assert created["due_date"] == "2026-10-01"
    assert created["end_date"] == "2026-10-03"

    backwards = client.post(
        "/api/tasks",
        headers=_auth(admin_token),
        json={"project_id": project_id, "title": "Rückwärts", "due_date": "2026-10-03", "end_date": "2026-10-01"},
    )
    assert backwards.status_code == 422, backwards.text
    # Create and PATCH speak the same German: an api client or the planning
    # bulk assign must not get an English 422 where the modal shows a German 400.
    assert TASK_DATE_RANGE_DETAIL in backwards.text
    assert "on or after" not in backwards.text

    no_start = client.post(
        "/api/tasks",
        headers=_auth(admin_token),
        json={"project_id": project_id, "title": "Ohne Von", "end_date": "2026-10-01"},
    )
    assert no_start.status_code == 422, no_start.text
    assert TASK_END_WITHOUT_START_DETAIL in no_start.text

    same_day = _create(client, admin_token, project_id=project_id, title="Ein Tag", due_date="2026-10-01", end_date="2026-10-01")
    assert same_day["end_date"] is None, "Bis == Von is the single-day form and stores as NULL"


def test_patch_moves_clears_and_validates_the_window(client: TestClient, admin_token: str) -> None:
    project_id = _project(client, admin_token, "END-2")
    task = _create(client, admin_token, project_id=project_id, title="Fenster", due_date="2026-10-01")
    assert task["end_date"] is None

    moved = _patch(client, admin_token, task["id"], end_date="2026-10-04")
    assert moved.status_code == 200, moved.text
    assert moved.json()["end_date"] == "2026-10-04"

    backwards = _patch(client, admin_token, task["id"], end_date="2026-09-30")
    assert backwards.status_code == 400, backwards.text
    assert backwards.json()["detail"] == "Das Enddatum darf nicht vor dem Startdatum liegen"

    # Moving Von past Bis in the same PATCH is judged on the resolved pair.
    both = _patch(client, admin_token, task["id"], due_date="2026-10-03", end_date="2026-10-02")
    assert both.status_code == 400, both.text

    untouched = _patch(client, admin_token, task["id"], title="Nur Titel")
    assert untouched.status_code == 200, untouched.text
    assert untouched.json()["end_date"] == "2026-10-04", "a PATCH without end_date leaves it alone"

    cleared = _patch(client, admin_token, task["id"], end_date=None)
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["end_date"] is None

    windowed = _patch(client, admin_token, task["id"], end_date="2026-10-05")
    assert windowed.status_code == 200
    undated = _patch(client, admin_token, task["id"], due_date=None)
    assert undated.status_code == 200, undated.text
    assert undated.json()["due_date"] is None
    assert undated.json()["end_date"] is None, "clearing Von clears Bis"


def test_is_overdue_waits_for_the_last_day(client: TestClient, admin_token: str) -> None:
    project_id = _project(client, admin_token, "END-3")
    today = date.today()
    running = _create(
        client,
        admin_token,
        project_id=project_id,
        title="Läuft noch",
        due_date=(today - timedelta(days=1)).isoformat(),
        end_date=(today + timedelta(days=1)).isoformat(),
    )
    assert running["is_overdue"] is False
    ended = _create(
        client,
        admin_token,
        project_id=project_id,
        title="Vorbei",
        due_date=(today - timedelta(days=3)).isoformat(),
        end_date=(today - timedelta(days=1)).isoformat(),
    )
    assert ended["is_overdue"] is True


# ── API: overlap ─────────────────────────────────────────────────────────────


def test_daily_slot_of_a_multi_day_task_collides_with_a_job_inside_the_window(
    client: TestClient, admin_token: str
) -> None:
    worker = _employee(client, admin_token, "window-worker@example.com")
    project_id = _project(client, admin_token, "END-4")
    _create(
        client,
        admin_token,
        project_id=project_id,
        title="Mo–Mi Installation",
        due_date="2026-03-16",
        end_date="2026-03-18",
        start_time="08:00",
        estimated_hours=4.0,
        assignee_ids=[worker["id"]],
    )

    tuesday = client.post(
        "/api/tasks",
        headers=_auth(admin_token),
        json={
            "project_id": project_id,
            "title": "Dienstag dazwischen",
            "due_date": "2026-03-17",
            "start_time": "09:00",
            "estimated_hours": 1.0,
            "assignee_ids": [worker["id"]],
        },
    )
    assert tuesday.status_code == 409, tuesday.text
    overlap = tuesday.json()["detail"]["overlaps"][0]
    assert overlap["title"] == "Mo–Mi Installation"
    assert overlap["due_date"] == "2026-03-16"
    assert overlap["end_date"] == "2026-03-18"

    thursday = client.post(
        "/api/tasks",
        headers=_auth(admin_token),
        json={
            "project_id": project_id,
            "title": "Donnerstag danach",
            "due_date": "2026-03-19",
            "start_time": "09:00",
            "estimated_hours": 1.0,
            "assignee_ids": [worker["id"]],
        },
    )
    assert thursday.status_code == 200, "the day after the window is free"

    # And the other direction: a new multi-day task over an existing single day.
    with_window = client.post(
        "/api/tasks",
        headers=_auth(admin_token),
        json={
            "project_id": project_id,
            "title": "Mi–Fr",
            "due_date": "2026-03-18",
            "end_date": "2026-03-20",
            "start_time": "08:30",
            "estimated_hours": 2.0,
            "assignee_ids": [worker["id"]],
        },
    )
    assert with_window.status_code == 409, with_window.text
    titles = {row["title"] for row in with_window.json()["detail"]["overlaps"]}
    assert {"Mo–Mi Installation", "Donnerstag danach"} <= titles


def test_overlap_helper_ignores_a_window_that_only_touches_by_date(client: TestClient, admin_token: str) -> None:
    """Same window, different hours: date intersection alone is not a clash."""
    from app.core.db import SessionLocal

    worker = _employee(client, admin_token, "window-hours@example.com")
    project_id = _project(client, admin_token, "END-5")
    _create(
        client,
        admin_token,
        project_id=project_id,
        title="Vormittags",
        due_date="2026-03-16",
        end_date="2026-03-18",
        start_time="08:00",
        estimated_hours=2.0,
        assignee_ids=[worker["id"]],
    )
    with SessionLocal() as db:
        overlaps = _find_task_overlaps(
            db,
            project_id=project_id,
            due_date=date(2026, 3, 17),
            end_date=date(2026, 3, 19),
            start_time=time(14, 0),
            estimated_hours=2.0,
            assignee_ids=[worker["id"]],
        )
    assert overlaps == []


# ── API: planning week ───────────────────────────────────────────────────────


def test_planning_week_places_the_task_on_every_covered_day_and_across_the_boundary(
    client: TestClient, admin_token: str
) -> None:
    project_id = _project(client, admin_token, "END-6")
    _create(client, admin_token, project_id=project_id, title="Mi–Fr", due_date="2026-03-04", end_date="2026-03-06", week_start="2026-03-02")
    _create(client, admin_token, project_id=project_id, title="Sa–Mo", due_date="2026-03-07", end_date="2026-03-09", week_start="2026-03-02")
    _create(client, admin_token, project_id=project_id, title="Nur Di", due_date="2026-03-03", week_start="2026-03-02")

    week = client.get(f"/api/planning/week/2026-03-02?project_id={project_id}", headers=_auth(admin_token))
    assert week.status_code == 200, week.text
    by_date = {day["date"]: [t["title"] for t in day["tasks"]] for day in week.json()["days"]}
    assert by_date["2026-03-03"] == ["Nur Di"]
    assert by_date["2026-03-04"] == ["Mi–Fr"]
    assert by_date["2026-03-05"] == ["Mi–Fr"]
    assert by_date["2026-03-06"] == ["Mi–Fr"]
    assert by_date["2026-03-07"] == ["Sa–Mo"]
    assert by_date["2026-03-08"] == ["Sa–Mo"]
    assert "Mi–Fr" not in by_date["2026-03-02"]

    next_week = client.get(f"/api/planning/week/2026-03-09?project_id={project_id}", headers=_auth(admin_token))
    assert next_week.status_code == 200, next_week.text
    next_by_date = {day["date"]: [t["title"] for t in day["tasks"]] for day in next_week.json()["days"]}
    assert next_by_date["2026-03-09"] == ["Sa–Mo"], "the tail of a boundary-spanning task shows in the next week"
    assert all("Mi–Fr" not in titles for titles in next_by_date.values())


def test_planning_assign_week_carries_end_date_and_checks_the_range(client: TestClient, admin_token: str) -> None:
    project_id = _project(client, admin_token, "END-7")
    assigned = client.post(
        "/api/planning/week/2026-03-02",
        headers=_auth(admin_token),
        json=[{"project_id": project_id, "title": "Zwei Tage", "due_date": "2026-03-03", "end_date": "2026-03-04"}],
    )
    assert assigned.status_code == 200, assigned.text
    task_id = assigned.json()["created_task_ids"][0]
    listed = client.get(f"/api/tasks?view=all_open&project_id={project_id}", headers=_auth(admin_token))
    assert listed.status_code == 200
    row = next(t for t in listed.json() if t["id"] == task_id)
    assert row["end_date"] == "2026-03-04"

    # No due_date means the Monday fallback — but an end without a start is
    # refused by the schema before the fallback is ever applied.
    bad = client.post(
        "/api/planning/week/2026-03-02",
        headers=_auth(admin_token),
        json=[{"project_id": project_id, "title": "Kaputt", "end_date": "2026-03-01"}],
    )
    assert bad.status_code == 422, bad.text
    assert TASK_END_WITHOUT_START_DETAIL in bad.text, "the bulk assign 422 is German too"


# ── API: confirmation reset ──────────────────────────────────────────────────


def _project_with_customer(client: TestClient, admin_token: str, number: str) -> int:
    cust = client.post(
        "/api/customers",
        headers=_auth(admin_token),
        json={"name": "Fenster Kunde", "email": "fenster@example.com", "language": "de"},
    )
    assert cust.status_code == 200, cust.text
    proj = client.post(
        "/api/projects",
        headers=_auth(admin_token),
        json={"project_number": number, "name": "Fensterprojekt", "status": "Auftrag angenommen", "customer_id": cust.json()["id"]},
    )
    assert proj.status_code == 200, proj.text
    return proj.json()["id"]


def test_moving_only_bis_voids_the_customers_yes(client: TestClient, admin_token: str) -> None:
    project_id = _project_with_customer(client, admin_token, "END-8")
    start = date.today() + timedelta(days=10)
    task = _create(
        client,
        admin_token,
        project_id=project_id,
        title="Kundentermin",
        task_type="construction",
        due_date=start.isoformat(),
        end_date=(start + timedelta(days=2)).isoformat(),
        request_customer_confirmation=True,
    )
    assert task["customer_confirmation_status"] == "pending"
    confirmed = client.post(
        f"/api/tasks/{task['id']}/customer-confirmation/manual",
        headers=_auth(admin_token),
        json={"action": "confirm", "method": "phone"},
    )
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["customer_confirmation_status"] == "confirmed"

    # Re-sending the same window is not a move.
    same = _patch(client, admin_token, task["id"], end_date=(start + timedelta(days=2)).isoformat())
    assert same.status_code == 200, same.text
    assert same.json()["customer_confirmation_status"] == "confirmed"

    longer = _patch(client, admin_token, task["id"], end_date=(start + timedelta(days=4)).isoformat())
    assert longer.status_code == 200, longer.text
    assert longer.json()["customer_confirmation_status"] == "pending", "a yes for 3 days is not a yes for 5"


def test_spelling_the_single_day_as_an_explicit_end_is_not_a_move(client: TestClient, admin_token: str) -> None:
    project_id = _project_with_customer(client, admin_token, "END-9")
    start = date.today() + timedelta(days=10)
    task = _create(
        client,
        admin_token,
        project_id=project_id,
        title="Ein Tag",
        due_date=start.isoformat(),
        request_customer_confirmation=True,
    )
    confirmed = client.post(
        f"/api/tasks/{task['id']}/customer-confirmation/manual",
        headers=_auth(admin_token),
        json={"action": "confirm", "method": "phone"},
    )
    assert confirmed.status_code == 200, confirmed.text
    explicit = _patch(client, admin_token, task["id"], end_date=start.isoformat())
    assert explicit.status_code == 200, explicit.text
    assert explicit.json()["end_date"] is None
    assert explicit.json()["customer_confirmation_status"] == "confirmed"


# ── API: my_all ──────────────────────────────────────────────────────────────


def test_my_all_lists_recent_done_tasks_but_not_old_ones(client: TestClient, admin_token: str) -> None:
    from app.core.db import SessionLocal
    from app.models.entities import Task

    me = _me(client, admin_token)
    project_id = _project(client, admin_token, "END-10")
    open_task = _create(client, admin_token, project_id=project_id, title="Offen", assignee_ids=[me["id"]])
    fresh_done = _create(client, admin_token, project_id=project_id, title="Frisch erledigt", status="done", assignee_ids=[me["id"]])
    old_done = _create(client, admin_token, project_id=project_id, title="Alt erledigt", status="done", assignee_ids=[me["id"]])
    not_mine = _create(client, admin_token, project_id=project_id, title="Fremd", status="done")
    with SessionLocal() as db:
        row = db.get(Task, old_done["id"])
        assert row is not None
        row.updated_at = utcnow() - timedelta(days=60)
        db.commit()

    my_all = client.get("/api/tasks?view=my_all", headers=_auth(admin_token))
    assert my_all.status_code == 200, my_all.text
    ids = {t["id"] for t in my_all.json()}
    assert open_task["id"] in ids
    assert fresh_done["id"] in ids
    assert old_done["id"] not in ids, "done rows older than done_since_days stay out"
    assert not_mine["id"] not in ids

    wider = client.get("/api/tasks?view=my_all&done_since_days=90", headers=_auth(admin_token))
    assert wider.status_code == 200
    assert old_done["id"] in {t["id"] for t in wider.json()}

    plain_my = client.get("/api/tasks?view=my", headers=_auth(admin_token))
    assert fresh_done["id"] not in {t["id"] for t in plain_my.json()}, "view=my is unchanged"


# ── API: public view ─────────────────────────────────────────────────────────


def test_public_confirmation_view_carries_the_window(client: TestClient, admin_token: str) -> None:
    from app.core.db import SessionLocal
    from app.models.entities import Task

    project_id = _project_with_customer(client, admin_token, "END-11")
    start = date.today() + timedelta(days=10)
    task = _create(
        client,
        admin_token,
        project_id=project_id,
        title="Fensterjob",
        due_date=start.isoformat(),
        end_date=(start + timedelta(days=1)).isoformat(),
        request_customer_confirmation=True,
    )
    with SessionLocal() as db:
        token = db.get(Task, task["id"]).customer_confirmation_token
    assert token
    public = client.get(f"/api/public/customer-confirmations/{token}")
    assert public.status_code == 200, public.text
    assert public.json()["due_date"] == start.isoformat()
    assert public.json()["end_date"] == (start + timedelta(days=1)).isoformat()
