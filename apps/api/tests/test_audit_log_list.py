"""GET /admin/audit-logs: server-side filters and a keyset cursor.

Found in production on 2026-10-20: the endpoint answered the newest 300 rows,
always, and the Protokoll tab filtered those 300 in the browser. With 2864
rows in the table (1292 in the last 90 days) the newest 300 reached back only
to 2026-10-05, so "Letzte 90 Tage" and every older custom range silently
showed a fraction of what happened.

What must hold:
  - the date range, category and text filters are applied by the server, so a
    range older than the newest page still comes back whole;
  - paging with ``before_id`` returns every row of a range exactly once, in
    the display order (created_at DESC, id DESC) — also when timestamps and
    ids do not grow together;
  - the category list covers the whole table, not the loaded page;
  - only ``audit:view`` may read any of it, as before.

Rows are seeded through SessionLocal, like test_audit_retention.py: 350 rows
through real admin actions would make the file slow and the timestamps
uncontrollable.
"""
from __future__ import annotations

import random
from datetime import datetime, timedelta

from fastapi.testclient import TestClient

from app.core.db import SessionLocal
from app.models.entities import AuditLog, User


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


RANGE_START = datetime(2026, 9, 1, 8, 0, 0)
RANGE_END = datetime(2026, 9, 14, 18, 0, 0)


def _row(created_at: datetime, *, category: str = "projects", action: str = "project.update", actor_user_id=None):
    return AuditLog(
        actor_user_id=actor_user_id,
        category=category,
        action=action,
        target_type="project",
        target_id="2026-0001",
        details={},
        created_at=created_at,
    )


def _seed(rows: list[AuditLog]) -> None:
    with SessionLocal() as db:
        db.add_all(rows)
        db.commit()


def _ordered_ids(*, start: datetime, end: datetime) -> list[int]:
    """Every id in [start, end], in the order the Protokoll shows them."""
    with SessionLocal() as db:
        rows = db.query(AuditLog.id, AuditLog.created_at).filter(
            AuditLog.created_at >= start, AuditLog.created_at <= end
        )
        return [row.id for row in sorted(rows, key=lambda r: (r.created_at, r.id), reverse=True)]


def _employee_token(client: TestClient, admin_token: str) -> str:
    created = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={
            "email": "audit-reader@example.com",
            "password": "Password123!",
            "full_name": "Audit Reader",
            "role": "employee",
        },
    )
    assert created.status_code == 200
    login = client.post("/api/auth/login", json={"email": "audit-reader@example.com", "password": "Password123!"})
    assert login.status_code == 200
    return login.headers["X-Access-Token"]


def test_350_rows_in_a_range_come_back_across_pages_in_order_without_gaps(client: TestClient, admin_token: str):
    # 350 timestamps inside the range, inserted in SHUFFLED order: ids no
    # longer grow with time, so a cursor of "id < before_id" would skip rows
    # and repeat others. 35 timestamps are shared by two rows each, to pin
    # the id tie-break.
    stamps = [RANGE_START + timedelta(minutes=50 * i) for i in range(315)]
    stamps += stamps[::9][:35]
    assert len(stamps) == 350 and max(stamps) <= RANGE_END
    random.Random(20261020).shuffle(stamps)
    outside = [RANGE_START - timedelta(days=3), RANGE_END + timedelta(days=3), RANGE_END + timedelta(seconds=1)]
    _seed([_row(at) for at in stamps] + [_row(at) for at in outside])

    expected = _ordered_ids(start=RANGE_START, end=RANGE_END)
    assert len(expected) == 350

    seen: list[int] = []
    before_id = None
    for _ in range(10):
        params = {"from": RANGE_START.isoformat(), "to": RANGE_END.isoformat(), "limit": 120}
        if before_id is not None:
            params["before_id"] = before_id
        page = client.get("/api/admin/audit-logs", headers=auth_headers(admin_token), params=params)
        assert page.status_code == 200, page.text
        ids = [row["id"] for row in page.json()]
        seen.extend(ids)
        if len(ids) < 120:
            break
        before_id = ids[-1]

    assert seen == expected
    assert len(set(seen)) == 350


def test_the_date_range_is_applied_by_the_server_not_to_the_newest_page(client: TestClient, admin_token: str):
    # 400 newer rows push the old range out of any newest-300 page.
    newest = datetime(2026, 10, 15, 9, 0, 0)
    _seed([_row(newest + timedelta(minutes=i)) for i in range(400)])
    old = [RANGE_START, RANGE_START + timedelta(days=2), RANGE_END]
    _seed([_row(at, action="project.archived") for at in old])

    response = client.get(
        "/api/admin/audit-logs",
        headers=auth_headers(admin_token),
        params={"from": RANGE_START.isoformat(), "to": RANGE_END.isoformat()},
    )
    assert response.status_code == 200
    rows = response.json()
    # Both bounds are inclusive, and nothing outside them comes back.
    assert [row["action"] for row in rows] == ["project.archived"] * 3
    assert [row["created_at"] for row in rows] == [at.isoformat() for at in sorted(old, reverse=True)]


def test_a_bound_with_an_offset_is_compared_in_utc(client: TestClient, admin_token: str):
    # created_at is naive UTC. The web sends Date.toISOString() ("…Z"), and a
    # German midnight is 22:00 UTC the evening before.
    late_evening_utc = datetime(2026, 9, 30, 22, 30, 0)
    _seed([_row(late_evening_utc, action="project.late")])

    def actions(bound: str) -> list[str]:
        response = client.get(
            "/api/admin/audit-logs",
            headers=auth_headers(admin_token),
            params={"from": bound, "to": "2026-10-01T23:59:59Z", "q": "project.late"},
        )
        assert response.status_code == 200, response.text
        return [row["action"] for row in response.json()]

    assert actions("2026-10-01T00:00:00+02:00") == ["project.late"]
    assert actions("2026-09-30T22:00:00.000Z") == ["project.late"]
    assert actions("2026-10-01T00:00:00Z") == []


def test_category_and_text_filters_are_applied_by_the_server(client: TestClient, admin_token: str):
    with SessionLocal() as db:
        fitter = User(email="fitter@example.com", password_hash="x", full_name="Jana Kowalski", nickname="Jana K")
        db.add(fitter)
        db.commit()
        fitter_id = fitter.id

    at = RANGE_START
    _seed(
        [_row(at + timedelta(minutes=i), category="tasks", action="task.update") for i in range(320)]
        + [
            _row(at - timedelta(days=1), category="users", action="user.create"),
            _row(at - timedelta(days=2), category="wiki", action="wiki.page_edit", actor_user_id=fitter_id),
            _row(at - timedelta(days=3), category="system", action="backup.created"),
            _row(at - timedelta(days=4), category="system", action="100%_done"),
        ]
    )
    window = {"from": (at - timedelta(days=10)).isoformat(), "to": RANGE_END.isoformat()}

    def actions(**params) -> list[str]:
        response = client.get(
            "/api/admin/audit-logs", headers=auth_headers(admin_token), params={**window, **params}
        )
        assert response.status_code == 200, response.text
        return [row["action"] for row in response.json()]

    assert actions(category="users") == ["user.create"]
    assert actions(category=["users", "wiki"]) == ["user.create", "wiki.page_edit"]
    # The action, case-insensitive — found below 320 newer rows.
    assert actions(q="PAGE_EDIT") == ["wiki.page_edit"]
    # The actor, by the name the tab shows (nickname) or the full name.
    assert actions(q="jana k") == ["wiki.page_edit"]
    assert actions(q="kowalski") == ["wiki.page_edit"]
    # The tab calls a row without an actor "System".
    assert "backup.created" in actions(q="Syst", category="system")
    # LIKE wildcards in the box are text, not patterns.
    assert actions(q="%_") == ["100%_done"]
    # Filters combine.
    assert actions(q="task", category="users") == []


def test_limit_defaults_to_300_and_is_bounded(client: TestClient, admin_token: str):
    _seed([_row(RANGE_START + timedelta(minutes=i)) for i in range(305)])
    headers = auth_headers(admin_token)

    assert len(client.get("/api/admin/audit-logs", headers=headers).json()) == 300
    assert len(client.get("/api/admin/audit-logs", headers=headers, params={"limit": 301}).json()) == 301
    assert client.get("/api/admin/audit-logs", headers=headers, params={"limit": 2000}).status_code == 200
    assert client.get("/api/admin/audit-logs", headers=headers, params={"limit": 2001}).status_code == 422
    assert client.get("/api/admin/audit-logs", headers=headers, params={"limit": 0}).status_code == 422
    assert client.get("/api/admin/audit-logs", headers=headers, params={"before_id": 0}).status_code == 422
    assert client.get("/api/admin/audit-logs", headers=headers, params={"q": "x" * 201}).status_code == 422
    bad_date = client.get("/api/admin/audit-logs", headers=headers, params={"from": "gestern"})
    assert bad_date.status_code == 400


def test_a_cursor_whose_row_was_pruned_still_pages_on(client: TestClient, admin_token: str):
    _seed([_row(RANGE_START + timedelta(minutes=i)) for i in range(10)])
    ids = _ordered_ids(start=RANGE_START, end=RANGE_END)
    anchor = ids[4]
    with SessionLocal() as db:
        db.delete(db.get(AuditLog, anchor))
        db.commit()

    response = client.get(
        "/api/admin/audit-logs",
        headers=auth_headers(admin_token),
        params={"before_id": anchor, "to": RANGE_END.isoformat()},
    )
    assert response.status_code == 200
    assert [row["id"] for row in response.json()] == ids[5:]


def test_categories_cover_the_whole_table_not_the_newest_page(client: TestClient, admin_token: str):
    _seed([_row(RANGE_START - timedelta(days=200), category="wiki", action="wiki.page_edit")])
    _seed([_row(RANGE_START + timedelta(minutes=i), category="tasks") for i in range(320)])

    response = client.get("/api/admin/audit-logs/categories", headers=auth_headers(admin_token))
    assert response.status_code == 200
    categories = response.json()
    assert "wiki" in categories and "tasks" in categories
    assert categories == sorted(set(categories))


def test_the_csv_export_honours_the_text_filter_too(client: TestClient, admin_token: str):
    _seed(
        [
            _row(RANGE_START, action="wiki.page_edit", category="wiki"),
            _row(RANGE_START + timedelta(hours=1), action="task.update", category="tasks"),
        ]
    )
    response = client.get(
        "/api/admin/audit-logs/export.csv",
        headers=auth_headers(admin_token),
        params={"q": "page_edit", "from": RANGE_START.isoformat(), "to": RANGE_END.isoformat()},
    )
    assert response.status_code == 200
    lines = response.text.strip().splitlines()
    assert len(lines) == 2 and ",wiki.page_edit," in lines[1]


def test_the_audit_log_stays_behind_audit_view(client: TestClient, admin_token: str):
    employee = _employee_token(client, admin_token)
    for path, params in [
        ("/api/admin/audit-logs", {}),
        ("/api/admin/audit-logs", {"from": RANGE_START.isoformat(), "category": "users", "q": "x", "limit": 10}),
        ("/api/admin/audit-logs", {"before_id": 1, "limit": 2000}),
        ("/api/admin/audit-logs/categories", {}),
        ("/api/admin/audit-logs/export.csv", {"q": "x"}),
    ]:
        response = client.get(path, headers=auth_headers(employee), params=params)
        assert response.status_code == 403, (path, params, response.status_code)
    # Without a token the new endpoint refuses exactly like the list always has.
    anonymous_list = client.get("/api/admin/audit-logs")
    anonymous_categories = client.get("/api/admin/audit-logs/categories")
    assert anonymous_list.status_code in (401, 403)
    assert anonymous_categories.status_code == anonymous_list.status_code
