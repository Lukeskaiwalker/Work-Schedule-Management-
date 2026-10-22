"""``GET /api/dashboard/absent-today`` — who is not there today, minimised.

What must hold (docs/DASHBOARD.md §4.3, §13):

* only the planning board's audience (planning:manage, time:view_all,
  time:manage) reads it; everyone else gets 403 before anything is read;
* today means the app timezone's date, and a range that ended yesterday is
  not today;
* the reason is a generic label from a server map — health, accident and
  free-text titles never leave the server;
* one row per user, the first kind in table order winning; rows by name.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app.core.db import SessionLocal
from app.models.entities import SchoolAbsence, VacationRequest
from app.services import dashboard_absences
from tests.conftest import auth_headers

PASSWORD = "Password123!"
TODAY = date(2026, 10, 21)
YESTERDAY = TODAY - timedelta(days=1)


@pytest.fixture(autouse=True)
def _fixed_today(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dashboard_absences, "app_today", lambda: TODAY)


def _user(client: TestClient, admin_token: str, email: str, role: str, name: str) -> tuple[int, str]:
    created = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={"email": email, "password": PASSWORD, "full_name": name, "role": role},
    )
    assert created.status_code == 200, created.text
    login = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert login.status_code == 200, login.text
    return created.json()["id"], login.headers["X-Access-Token"]


def _vacation(user_id: int, start: date, end: date, status: str = "approved") -> None:
    with SessionLocal() as db:
        db.add(VacationRequest(user_id=user_id, start_date=start, end_date=end, status=status))
        db.commit()


def _school(user_id: int, absence_type: str, title: str, start: date = TODAY, end: date = TODAY) -> None:
    with SessionLocal() as db:
        db.add(
            SchoolAbsence(
                user_id=user_id,
                title=title,
                start_date=start,
                end_date=end,
                absence_type=absence_type,
                status="approved",
            )
        )
        db.commit()


def test_only_the_planning_audience_may_ask(client: TestClient, admin_token: str) -> None:
    _, employee = _user(client, admin_token, "fitter@example.com", "employee", "Fritz Beispiel")
    refused = client.get("/api/dashboard/absent-today", headers=auth_headers(employee))
    assert refused.status_code == 403
    _, accountant = _user(client, admin_token, "books@example.com", "accountant", "Anke Beispiel")
    assert client.get("/api/dashboard/absent-today", headers=auth_headers(accountant)).status_code == 200
    # The logins above left a session cookie in the client's jar.
    client.cookies.clear()
    assert client.get("/api/dashboard/absent-today").status_code == 401


def test_a_planner_sees_todays_vacation_but_not_yesterdays(client: TestClient, admin_token: str) -> None:
    _, planner = _user(client, admin_token, "planner@example.com", "planning", "Pia Beispiel")
    away_id, _ = _user(client, admin_token, "away@example.com", "employee", "Mara Beispiel")
    back_id, _ = _user(client, admin_token, "back@example.com", "employee", "Bodo Beispiel")
    asked_id, _ = _user(client, admin_token, "asked@example.com", "employee", "Anton Beispiel")
    _vacation(away_id, YESTERDAY, TODAY + timedelta(days=3))
    _vacation(back_id, TODAY - timedelta(days=5), YESTERDAY)
    _vacation(asked_id, TODAY, TODAY, status="pending")

    response = client.get("/api/dashboard/absent-today", headers=auth_headers(planner))
    assert response.status_code == 200, response.text
    assert response.json() == {
        "date": "2026-10-21",
        "absences": [{"user_id": away_id, "user_name": "Mara Beispiel", "type": "vacation", "label": "Urlaub"}],
    }


def test_a_sensitive_reason_leaves_as_a_generic_label(client: TestClient, admin_token: str) -> None:
    _, planner = _user(client, admin_token, "planner@example.com", "planning", "Pia Beispiel")
    sick_id, _ = _user(client, admin_token, "sick@example.com", "employee", "Simon Beispiel")
    _school(sick_id, "sick", "Arzttermin Beispiel")

    response = client.get("/api/dashboard/absent-today", headers=auth_headers(planner))
    assert response.status_code == 200, response.text
    assert response.json()["absences"] == [
        {"user_id": sick_id, "user_name": "Simon Beispiel", "type": "absent", "label": "Abwesend"}
    ]
    assert "Arzttermin" not in response.text
    assert "sick" not in response.text


def test_one_row_per_user_and_the_first_kind_wins(client: TestClient, admin_token: str) -> None:
    _, planner = _user(client, admin_token, "planner@example.com", "planning", "Pia Beispiel")
    both_id, _ = _user(client, admin_token, "both@example.com", "employee", "Bea Beispiel")
    _school(both_id, "school", "Berufsschule")
    _vacation(both_id, TODAY, TODAY)

    absences = client.get("/api/dashboard/absent-today", headers=auth_headers(planner)).json()["absences"]
    assert absences == [{"user_id": both_id, "user_name": "Bea Beispiel", "type": "vacation", "label": "Urlaub"}]


def test_every_stored_type_maps_to_its_label_and_rows_sort_by_name(client: TestClient, admin_token: str) -> None:
    _, planner = _user(client, admin_token, "planner@example.com", "planning", "Pia Beispiel")
    cases = [
        ("Zora Beispiel", "vacation", "vacation", "Urlaub"),
        ("Yann Beispiel", "school", "school", "Berufsschule"),
        ("Xaver Beispiel", "training", "training", "Fortbildung"),
        ("Wanda Beispiel", "company_event", "company_event", "Betriebsveranstaltung"),
        ("Viktor Beispiel", "holiday", "holiday", "Feiertag"),
        ("Ute Beispiel", "work_accident", "absent", "Abwesend"),
        ("Theo Beispiel", "parental_leave", "absent", "Abwesend"),
        ("Sina Beispiel", "something-new", "absent", "Abwesend"),
    ]
    expected = []
    for index, (name, stored, kind, label) in enumerate(cases):
        user_id, _ = _user(client, admin_token, f"case{index}@example.com", "employee", name)
        _school(user_id, stored, f"Freitext {index}")
        expected.append({"user_id": user_id, "user_name": name, "type": kind, "label": label})

    response = client.get("/api/dashboard/absent-today", headers=auth_headers(planner))
    assert response.status_code == 200, response.text
    assert response.json()["absences"] == sorted(expected, key=lambda row: row["user_name"])
    assert "Freitext" not in response.text
