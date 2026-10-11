"""GET /api/station/werkstatt/crew-projects — "for which project is this?".

Owner, 2026-10-10: "When we do the item dispense and have to select a user we
can then also select one of the current and recent projects for that week of
that user to book it to that project."

The rack taps a name and must show that person's projects at once — a tap
never fetches (the agent validates against cached lists) — so the station
reads ONE bulk answer for the whole crew and caches it beside the crew list.

What is pinned here:

  * ``people`` is exactly the crew (``GET /crew``), in the same order, and a
    person with nothing planned is there with an empty list;
  * the hints: ``heute`` (a task window containing today), ``woche`` (a window
    touching this Monday–Sunday, or pinned to this week), ``zuletzt`` (last
    week's tasks, or a report / a stock movement naming the person / a
    Verteiler session in the last 14 days);
  * a task counts through the many-assignee join AND the older single
    ``tasks.assignee_id`` column; any status counts (material is fetched for
    the job finished yesterday); office tasks and archived projects never do;
  * "today" and the weeks are Berlin's, never the UTC date;
  * the wall is unauthenticated, so the projection is exactly
    ``id, project_number, name, hint`` — no customer, address or task title.
"""

from __future__ import annotations

from datetime import date, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.models.entities import (
    ConstructionReport,
    Customer,
    Project,
    Station,
    Task,
    TaskAssignment,
    User,
    WerkstattMovement,
)
from app.models.schaltplan import PanelPlan, PanelWorkSession
from app.services import station_projects
from tests.test_station_werkstatt import BASE, _article, _make_user, _pair, auth_headers

# Wednesday 2026-10-07, 12:00 in Berlin. This week is Mon 05.10.–Sun 11.10.,
# last week Mon 28.09.–Sun 04.10.
WEDNESDAY_NOON_UTC = datetime(2026, 10, 7, 10, 0, 0)
TODAY = "2026-10-07"


@pytest.fixture
def station_token(client: TestClient, admin_token: str) -> str:
    token, _ = _pair(client, admin_token)
    return token


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch):
    """Pin the service's clock (naive UTC, like ``app.core.time.utcnow``)."""

    def _set(moment: datetime) -> None:
        monkeypatch.setattr(station_projects, "utcnow", lambda: moment)

    _set(WEDNESDAY_NOON_UTC)
    return _set


# --------------------------------------------------------------------------
# rows, written straight to the database: these tests are about which rows
# count, not about the endpoints that create them
# --------------------------------------------------------------------------


def _project(number: str, *, name: str | None = None, status: str = "in_durchfuehrung") -> int:
    with SessionLocal() as db:
        row = Project(project_number=number, name=name or f"Projekt {number}", status=status)
        db.add(row)
        db.commit()
        return row.id


def _task(
    project_id: int | None,
    *,
    users: tuple[int, ...] = (),
    legacy_assignee: int | None = None,
    due: str | None = None,
    end: str | None = None,
    week: str | None = None,
    task_type: str = "construction",
    status: str = "open",
    customer_id: int | None = None,
) -> int:
    with SessionLocal() as db:
        task = Task(
            project_id=project_id,
            customer_id=customer_id,
            title="Montage — darf nie an der Wand stehen",
            task_type=task_type,
            status=status,
            due_date=date.fromisoformat(due) if due else None,
            end_date=date.fromisoformat(end) if end else None,
            week_start=date.fromisoformat(week) if week else None,
            assignee_id=legacy_assignee,
        )
        db.add(task)
        db.flush()
        for user_id in users:
            db.add(TaskAssignment(task_id=task.id, user_id=user_id))
        db.commit()
        return task.id


def _report(user_id: int, project_id: int, day: str) -> None:
    with SessionLocal() as db:
        db.add(
            ConstructionReport(
                project_id=project_id, user_id=user_id, report_date=date.fromisoformat(day), payload={}
            )
        )
        db.commit()


def _movement(
    article_id: int,
    *,
    project_id: int,
    at: datetime,
    user_id: int,
    assignee_user_id: int | None,
    station_id: int | None = None,
) -> None:
    with SessionLocal() as db:
        db.add(
            WerkstattMovement(
                article_id=article_id,
                movement_type="consumption",
                quantity=1,
                project_id=project_id,
                user_id=user_id,
                assignee_user_id=assignee_user_id,
                station_id=station_id,
                created_at=at,
            )
        )
        db.commit()


def _panel_session(user_id: int, project_id: int | None, *, number: str, started: datetime, ended: datetime | None) -> None:
    with SessionLocal() as db:
        customer = Customer(name=f"Kunde {number}")
        db.add(customer)
        db.flush()
        plan = PanelPlan(
            panel_number=number,
            customer_id=customer.id,
            project_id=project_id,
            name="Unterverteiler",
            designation="UV1",
        )
        db.add(plan)
        db.flush()
        db.add(PanelWorkSession(panel_id=plan.id, user_id=user_id, started_at=started, ended_at=ended))
        db.commit()


def _admin_id() -> int:
    with SessionLocal() as db:
        return db.scalars(select(User.id).where(User.email == "admin@example.com")).one()


def _crew_projects(client: TestClient, token: str) -> dict:
    resp = client.get(f"{BASE}/crew-projects", headers=auth_headers(token))
    assert resp.status_code == 200, resp.text
    return resp.json()


def _numbers_for(body: dict, user_id: int) -> list[tuple[str, str]]:
    (person,) = [row for row in body["people"] if row["user_id"] == user_id]
    return [(row["project_number"], row["hint"]) for row in person["projects"]]


# --------------------------------------------------------------------------
# shape and the people
# --------------------------------------------------------------------------


def test_a_task_today_is_offered_as_heute_with_nothing_but_number_and_name(
    client: TestClient, admin_token: str, station_token: str, clock
) -> None:
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    project = _project("381", name="Neubau Schulze")
    _task(project, users=(max_["id"],), due=TODAY)

    body = _crew_projects(client, station_token)

    assert set(body) == {"week_start", "people"}
    assert body["week_start"] == "2026-10-05"
    (person,) = [row for row in body["people"] if row["user_id"] == max_["id"]]
    assert set(person) == {"user_id", "projects"}
    # The exact projection: no customer, no address, no task title.
    assert person["projects"] == [
        {"id": project, "project_number": "381", "name": "Neubau Schulze", "hint": "heute"}
    ]


def test_the_people_are_exactly_the_crew_in_the_crew_s_order(
    client: TestClient, admin_token: str, station_token: str, clock
) -> None:
    _make_user(client, admin_token, "zora@example.com", "employee")
    _make_user(client, admin_token, "anna@example.com", "planning")
    gone = _make_user(client, admin_token, "weg@example.com", "employee")
    assert client.delete(f"/api/admin/users/{gone['id']}", headers=auth_headers(admin_token)).status_code == 200
    partner = _make_user(client, admin_token, "partner@example.com", "employee")
    with SessionLocal() as db:
        db.get(User, partner["id"]).role = "external"
        db.commit()

    crew = client.get(f"{BASE}/crew", headers=auth_headers(station_token))
    assert crew.status_code == 200, crew.text
    body = _crew_projects(client, station_token)

    assert [row["user_id"] for row in body["people"]] == [row["id"] for row in crew.json()]
    assert gone["id"] not in {row["user_id"] for row in body["people"]}
    assert partner["id"] not in {row["user_id"] for row in body["people"]}
    # Nobody planned anything: everybody is there, with nothing to offer.
    assert all(row["projects"] == [] for row in body["people"])


# --------------------------------------------------------------------------
# the task arm
# --------------------------------------------------------------------------


def test_an_older_single_assignee_task_counts(
    client: TestClient, admin_token: str, station_token: str, clock
) -> None:
    """Older rows carry the person only in ``tasks.assignee_id``; matching the
    join table alone would silently hide them."""
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    project = _project("390")
    _task(project, legacy_assignee=max_["id"], due=TODAY)

    assert _numbers_for(_crew_projects(client, station_token), max_["id"]) == [("390", "heute")]


def test_a_multi_day_window_counts_by_the_days_it_covers(
    client: TestClient, admin_token: str, station_token: str, clock
) -> None:
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    me = (max_["id"],)
    # Thu last week → Tue this week: touches this week, not today.
    _task(_project("401"), users=me, due="2026-10-01", end="2026-10-06")
    # Fri last week → Thu this week: covers today.
    _task(_project("402"), users=me, due="2026-10-02", end="2026-10-08")
    # Thu two weeks ago → Tue last week: last week.
    _task(_project("403"), users=me, due="2026-09-24", end="2026-09-29")
    # Two weeks ago, entirely: too old.
    _task(_project("404"), users=me, due="2026-09-14", end="2026-09-20")
    # Next week: not yet.
    _task(_project("405"), users=me, due="2026-10-12", end="2026-10-14")

    assert _numbers_for(_crew_projects(client, station_token), max_["id"]) == [
        ("402", "heute"),
        ("401", "woche"),
        ("403", "zuletzt"),
    ]


def test_a_task_pinned_to_a_week_without_a_date_counts(
    client: TestClient, admin_token: str, station_token: str, clock
) -> None:
    """The Wochenplanung can pin a task to a week with no day yet — a query on
    ``due_date`` alone would miss it."""
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    me = (max_["id"],)
    _task(_project("411"), users=me, week="2026-10-05")
    _task(_project("412"), users=me, week="2026-09-28")
    _task(_project("413"), users=me, week="2026-09-21")

    assert _numbers_for(_crew_projects(client, station_token), max_["id"]) == [
        ("411", "woche"),
        ("412", "zuletzt"),
    ]


def test_a_done_task_still_counts(client: TestClient, admin_token: str, station_token: str, clock) -> None:
    """Material is fetched for the job finished this morning, too."""
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    _task(_project("391"), users=(max_["id"],), due=TODAY, status="done")

    assert _numbers_for(_crew_projects(client, station_token), max_["id"]) == [("391", "heute")]


def test_office_tasks_archived_projects_and_other_people_s_tasks_are_left_out(
    client: TestClient, admin_token: str, station_token: str, clock
) -> None:
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    anna = _make_user(client, admin_token, "anna@example.com", "employee")
    _task(_project("392"), users=(max_["id"],), due=TODAY, task_type="office")
    _task(_project("393", status="archived"), users=(max_["id"],), due=TODAY)
    _task(_project("394"), users=(anna["id"],), due=TODAY)
    with SessionLocal() as db:
        customer = Customer(name="Nur Kunde")
        db.add(customer)
        db.commit()
        customer_id = customer.id
    # A customer-only service call has no project to book to.
    _task(None, customer_id=customer_id, users=(max_["id"],), due=TODAY)

    body = _crew_projects(client, station_token)
    assert _numbers_for(body, max_["id"]) == []
    assert _numbers_for(body, anna["id"]) == [("394", "heute")]


# --------------------------------------------------------------------------
# the evidence arm: what the person did in the last 14 days
# --------------------------------------------------------------------------


def test_reports_movements_and_verteiler_sessions_make_a_project_recent(
    client: TestClient, admin_token: str, station_token: str, clock
) -> None:
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    anna = _make_user(client, admin_token, "anna@example.com", "employee")
    admin_id = _admin_id()
    article = _article(client, admin_token, "Kabelbinder 200 mm")

    _report(max_["id"], _project("421"), "2026-09-30")  # 7 days ago
    _report(max_["id"], _project("422"), "2026-09-20")  # 17 days ago: too old
    _report(anna["id"], _project("423"), TODAY)  # somebody else's report

    _movement(
        article["id"], project_id=_project("424"), at=datetime(2026, 10, 4, 10, 0),
        user_id=admin_id, assignee_user_id=max_["id"],
    )
    _movement(
        article["id"], project_id=_project("425"), at=datetime(2026, 9, 17, 10, 0),
        user_id=admin_id, assignee_user_id=max_["id"],
    )

    _panel_session(
        max_["id"], _project("426"), number="VT-0426",
        started=datetime(2026, 10, 5, 7, 0), ended=datetime(2026, 10, 5, 15, 0),
    )
    # A board without a project offers nothing to book to.
    _panel_session(
        max_["id"], None, number="VT-0427", started=datetime(2026, 10, 6, 7, 0), ended=datetime(2026, 10, 6, 9, 0)
    )

    body = _crew_projects(client, station_token)
    # Most recent first: the session on Monday, the movement on Sunday, the
    # report a week ago.
    assert _numbers_for(body, max_["id"]) == [("426", "zuletzt"), ("424", "zuletzt"), ("421", "zuletzt")]
    assert _numbers_for(body, anna["id"]) == [("423", "zuletzt")]


def test_a_nameless_station_row_does_not_credit_the_station_owner(
    client: TestClient, admin_token: str, station_token: str, clock
) -> None:
    """A station books under its owner's name; a row nobody was tapped for is
    not the owner's project history."""
    admin_id = _admin_id()
    article = _article(client, admin_token, "Wago 2273-203")
    with SessionLocal() as db:
        station_id = db.scalars(select(Station.id)).one()
    _movement(
        article["id"], project_id=_project("431"), at=datetime(2026, 10, 6, 8, 0),
        user_id=admin_id, assignee_user_id=None, station_id=station_id,
    )

    assert _numbers_for(_crew_projects(client, station_token), admin_id) == []


# --------------------------------------------------------------------------
# order, de-duplication, the cap
# --------------------------------------------------------------------------


def test_heute_then_woche_then_zuletzt_nearest_first_each_project_once(
    client: TestClient, admin_token: str, station_token: str, clock
) -> None:
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    me = (max_["id"],)
    p501 = _project("501")
    _task(_project("502"), users=me, due=TODAY)
    _task(p501, users=me, due=TODAY)
    _report(max_["id"], p501, "2026-10-06")  # also recent — still listed once, as heute
    _task(_project("503"), users=me, due="2026-10-09")  # Fri: 2 days away
    _task(_project("504"), users=me, due="2026-10-08")  # Thu: 1 day away
    _task(_project("505"), users=me, due="2026-10-05")  # Mon: 2 days ago — ties with 503
    _report(max_["id"], _project("507"), "2026-10-03")
    _report(max_["id"], _project("506"), "2026-10-06")

    assert _numbers_for(_crew_projects(client, station_token), max_["id"]) == [
        ("501", "heute"),
        ("502", "heute"),
        ("504", "woche"),
        ("503", "woche"),
        ("505", "woche"),
        ("506", "zuletzt"),
        ("507", "zuletzt"),
    ]


def test_at_most_eight_projects_per_person(
    client: TestClient, admin_token: str, station_token: str, clock
) -> None:
    """The rack grid has room for eight tiles and must not scroll."""
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    for number in range(601, 611):
        _task(_project(str(number)), users=(max_["id"],), due=TODAY)

    numbers = [number for number, _ in _numbers_for(_crew_projects(client, station_token), max_["id"])]
    assert numbers == [str(number) for number in range(601, 609)]


# --------------------------------------------------------------------------
# the clock
# --------------------------------------------------------------------------


def test_today_is_berlin_s_today_not_the_utc_date(
    client: TestClient, admin_token: str, station_token: str, clock
) -> None:
    """Monday 00:30 in Berlin is still Sunday in UTC. Taking the UTC date would
    put the whole of Monday's first hours into last week."""
    clock(datetime(2026, 10, 4, 22, 30, 0))  # = Mon 2026-10-05 00:30 CEST
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    _task(_project("701"), users=(max_["id"],), due="2026-10-05")
    _task(_project("702"), users=(max_["id"],), due="2026-10-04")

    body = _crew_projects(client, station_token)
    assert body["week_start"] == "2026-10-05"
    assert _numbers_for(body, max_["id"]) == [("701", "heute"), ("702", "zuletzt")]


# --------------------------------------------------------------------------
# the boundary
# --------------------------------------------------------------------------


def test_the_crew_projects_need_a_station_token(client: TestClient, admin_token: str) -> None:
    assert client.get(f"{BASE}/crew-projects", headers=auth_headers(admin_token)).status_code == 401
    assert client.get(f"{BASE}/crew-projects").status_code == 401
