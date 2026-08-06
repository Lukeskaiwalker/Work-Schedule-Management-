"""Filling in a working day that was never clocked.

Two audiences with different rules: a manager may write any day for any user, an
employee may only fill a gap inside the window their group already lets them
edit. The interesting tests are the boundaries of that window and the places a
naive implementation would let an employee write history.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import sqlalchemy as sa
from fastapi.testclient import TestClient


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_user(client: TestClient, admin_token: str, email: str, role: str = "employee") -> dict:
    response = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={"email": email, "password": "Password123!", "full_name": "Test User", "role": role},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _login(client: TestClient, email: str) -> str:
    response = client.post("/api/auth/login", json={"email": email, "password": "Password123!"})
    assert response.status_code == 200, response.text
    return response.headers["X-Access-Token"]


def _grant_self_backfill(user_id: int, *, allowed: bool = True) -> None:
    """Put the user in an employee group carrying the recent-own-entries flag."""
    from app.core.db import SessionLocal
    from app.models.entities import EmployeeGroup, EmployeeGroupMember

    with SessionLocal() as db:
        group = EmployeeGroup(name=f"grp-{user_id}-{allowed}")
        group.can_update_recent_own_time_entries = allowed
        db.add(group)
        db.flush()
        db.add(EmployeeGroupMember(group_id=group.id, user_id=user_id))
        db.commit()


def _seed_entry(user_id: int, *, days_ago: int) -> int:
    """Insert a clocked entry N days back so a backfill window can derive from it."""
    from app.core.db import SessionLocal
    from app.models.entities import ClockEntry

    start = datetime.utcnow().replace(hour=8, minute=0, second=0, microsecond=0) - timedelta(days=days_ago)
    with SessionLocal() as db:
        entry = ClockEntry(user_id=user_id, clock_in=start, clock_out=start + timedelta(hours=8))
        db.add(entry)
        db.commit()
        return entry.id


def _day_at(days_ago: int, hour: int = 8) -> datetime:
    return (datetime.utcnow() - timedelta(days=days_ago)).replace(
        hour=hour, minute=0, second=0, microsecond=0
    )


def _post_entry(client: TestClient, token: str, *, clock_in: datetime, hours: int = 8, **extra):
    return client.post(
        "/api/time/entries",
        headers=auth_headers(token),
        json={
            "clock_in": clock_in.isoformat(),
            "clock_out": (clock_in + timedelta(hours=hours)).isoformat(),
            "break_minutes": 30,
            **extra,
        },
    )


# ── The reported case: an employee forgot to clock a day ──────────────────


def test_employee_can_fill_a_forgotten_day_inside_the_window(
    client: TestClient, admin_token: str
):
    worker = _create_user(client, admin_token, "backfill-ok@example.com")
    _grant_self_backfill(worker["id"])
    token = _login(client, "backfill-ok@example.com")

    response = _post_entry(client, token, clock_in=_day_at(1))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["can_edit"] is True

    listed = client.get("/api/time/entries?period=weekly", headers=auth_headers(token)).json()
    assert len(listed) == 1


def test_employee_without_the_group_flag_is_refused(client: TestClient, admin_token: str):
    """The feature reuses the existing per-group permission, not a new one."""
    _create_user(client, admin_token, "backfill-nogroup@example.com")
    token = _login(client, "backfill-nogroup@example.com")

    response = _post_entry(client, token, clock_in=_day_at(1))
    assert response.status_code == 403
    assert "group" in response.json()["detail"].lower()


def test_employee_in_a_group_with_the_flag_off_is_refused(client: TestClient, admin_token: str):
    worker = _create_user(client, admin_token, "backfill-flagoff@example.com")
    _grant_self_backfill(worker["id"], allowed=False)
    token = _login(client, "backfill-flagoff@example.com")

    assert _post_entry(client, token, clock_in=_day_at(1)).status_code == 403


# ── Window boundaries ─────────────────────────────────────────────────────


def test_employee_cannot_write_far_into_the_past(client: TestClient, admin_token: str):
    """Without this bound an employee could author working-time records months later."""
    worker = _create_user(client, admin_token, "backfill-old@example.com")
    _grant_self_backfill(worker["id"])
    token = _login(client, "backfill-old@example.com")

    response = _post_entry(client, token, clock_in=_day_at(90))
    assert response.status_code == 403
    assert "only add entries between" in response.json()["detail"]


def test_employee_cannot_write_the_future(client: TestClient, admin_token: str):
    """Today is the last day anyone can have worked."""
    worker = _create_user(client, admin_token, "backfill-future@example.com")
    _grant_self_backfill(worker["id"])
    token = _login(client, "backfill-future@example.com")

    assert _post_entry(client, token, clock_in=_day_at(-3)).status_code == 403


def test_window_stretches_back_to_the_oldest_recent_entry(client: TestClient, admin_token: str):
    """The window is the span the edit rule already exposes, not a flat 3 days.

    An employee whose three most recent entries reach back 10 days can edit
    those entries today, so they must also be able to fill the gap between them.
    """
    worker = _create_user(client, admin_token, "backfill-span@example.com")
    _grant_self_backfill(worker["id"])
    _seed_entry(worker["id"], days_ago=10)
    token = _login(client, "backfill-span@example.com")

    window = client.get(
        "/api/time/entries/backfill-window", headers=auth_headers(token)
    ).json()
    assert window["can_backfill_self"] is True
    assert window["can_backfill_any_day"] is False

    # 8 days back sits inside the 10-day span and would fall outside a flat
    # 3-day window — this is the distinction the test exists for.
    assert _post_entry(client, token, clock_in=_day_at(8)).status_code == 200


def test_minimum_window_applies_when_there_are_no_entries(
    client: TestClient, admin_token: str
):
    """A new hire with no history still gets a usable window rather than none."""
    worker = _create_user(client, admin_token, "backfill-new@example.com")
    _grant_self_backfill(worker["id"])
    token = _login(client, "backfill-new@example.com")

    window = client.get(
        "/api/time/entries/backfill-window", headers=auth_headers(token)
    ).json()
    assert window["earliest_self_day"] is not None
    assert _post_entry(client, token, clock_in=_day_at(2)).status_code == 200


# ── Managers ──────────────────────────────────────────────────────────────


def test_manager_can_fill_any_day_for_any_user(client: TestClient, admin_token: str):
    worker = _create_user(client, admin_token, "backfill-target@example.com")

    response = _post_entry(
        client, admin_token, clock_in=_day_at(200), user_id=worker["id"]
    )
    assert response.status_code == 200, response.text
    assert response.json()["user_id"] == worker["id"]

    window = client.get(
        "/api/time/entries/backfill-window", headers=auth_headers(admin_token)
    ).json()
    assert window["can_backfill_any_day"] is True


def test_employee_cannot_create_an_entry_for_someone_else(
    client: TestClient, admin_token: str
):
    worker = _create_user(client, admin_token, "backfill-self@example.com")
    _grant_self_backfill(worker["id"])
    victim = _create_user(client, admin_token, "backfill-victim@example.com")
    token = _login(client, "backfill-self@example.com")

    response = _post_entry(client, token, clock_in=_day_at(1), user_id=victim["id"])
    assert response.status_code == 403


# ── Validation ────────────────────────────────────────────────────────────


def test_overlapping_entry_is_rejected(client: TestClient, admin_token: str):
    """Two overlapping entries would double-count the same hours on the timesheet."""
    worker = _create_user(client, admin_token, "backfill-overlap@example.com")
    start = _day_at(1, hour=8)

    first = _post_entry(client, admin_token, clock_in=start, user_id=worker["id"])
    assert first.status_code == 200, first.text

    clash = _post_entry(
        client, admin_token, clock_in=start + timedelta(hours=2), user_id=worker["id"]
    )
    assert clash.status_code == 400
    assert "overlap" in clash.json()["detail"].lower()

    # A non-overlapping second shift on the same day is fine.
    later = _post_entry(
        client, admin_token, clock_in=start + timedelta(hours=10), hours=2, user_id=worker["id"]
    )
    assert later.status_code == 200, later.text


def test_clock_out_before_clock_in_is_rejected(client: TestClient, admin_token: str):
    start = _day_at(1)
    response = client.post(
        "/api/time/entries",
        headers=auth_headers(admin_token),
        json={
            "clock_in": start.isoformat(),
            "clock_out": (start - timedelta(hours=1)).isoformat(),
            "break_minutes": 0,
        },
    )
    assert response.status_code == 400


def test_break_longer_than_the_shift_is_rejected(client: TestClient, admin_token: str):
    start = _day_at(1)
    response = client.post(
        "/api/time/entries",
        headers=auth_headers(admin_token),
        json={
            "clock_in": start.isoformat(),
            "clock_out": (start + timedelta(hours=1)).isoformat(),
            "break_minutes": 120,
        },
    )
    assert response.status_code == 400


def test_creation_is_written_to_the_audit_log(client: TestClient, admin_token: str):
    """A working-time record written after the fact must be traceable."""
    from app.core.db import SessionLocal
    from app.models.entities import AuditLog

    worker = _create_user(client, admin_token, "backfill-audit@example.com")
    assert _post_entry(
        client, admin_token, clock_in=_day_at(5), user_id=worker["id"]
    ).status_code == 200

    with SessionLocal() as db:
        actions = db.scalars(
            sa.select(AuditLog.action).where(AuditLog.action.like("time_entry.%_create"))
        ).all()
    assert "time_entry.manage_create" in actions
