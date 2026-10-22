"""``/api/dashboard`` — the signed-in user's own start page (docs/DASHBOARD.md §4, §6).

What must hold:

* a fresh user gets the built-in default of their role on every device,
  filtered to the widgets they may see, plus ``default_sizes`` for all 20;
* each device keeps its own layout; saving one never loses another;
* a write is refused only for what cannot be stored, with an object detail;
* an id the caller may not see is stored but never shown, and a widget that
  is hidden while the user saves comes back at its place with the permission;
* broken stored preferences fall back instead of failing;
* a role change flags the customised device until the user decides.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.core.permissions import get_all_user_overrides, set_user_permissions_override
from app.models.entities import User
from app.services.dashboard_defaults import builtin_widgets
from tests.conftest import auth_headers

PASSWORD = "Password123!"
DEVICES = ("mobile", "tablet", "desktop")
OFFICE_ONLY = {"clocked_in", "vacation_approvals", "absent_today"}


@pytest.fixture(autouse=True)
def _restore_user_overrides() -> Iterator[None]:
    saved = get_all_user_overrides()
    yield
    set_user_permissions_override(saved)


def _user(client: TestClient, admin_token: str, email: str, role: str, name: str) -> tuple[int, str]:
    created = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={"email": email, "password": PASSWORD, "full_name": name, "role": role},
    )
    assert created.status_code == 200, created.text
    return created.json()["id"], _login(client, email)


def _login(client: TestClient, email: str) -> str:
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    return response.headers["X-Access-Token"]


def _ids(layout: dict) -> list[str]:
    return [item["id"] for item in layout["widgets"]]


def _stored_layouts(user_id: int) -> object:
    with SessionLocal() as db:
        prefs = db.get(User, user_id).preferences
    return prefs.get("dashboard_layouts") if isinstance(prefs, dict) else None


def _admin_id() -> int:
    with SessionLocal() as db:
        return db.scalars(select(User.id).where(User.email == "admin@example.com")).one()


def test_the_dashboard_needs_a_login(client: TestClient) -> None:
    assert client.get("/api/dashboard").status_code == 401
    assert client.put("/api/dashboard/layouts/desktop", json={"version": 1, "widgets": []}).status_code == 401


def test_a_fresh_admin_gets_three_builtin_layouts_and_every_default_size(client: TestClient, admin_token: str) -> None:
    response = client.get("/api/dashboard", headers=auth_headers(admin_token))
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body["layouts"]) == set(DEVICES)
    for device in DEVICES:
        layout = body["layouts"][device]
        assert layout["device"] == device
        assert layout["version"] == 1
        assert layout["source"] == "builtin"
        assert layout["updated_at"] is None
        assert layout["role_changed"] is False
        assert layout["widgets"] == builtin_widgets("admin", device)
    assert len(body["available_widgets"]) == 20
    assert set(body["default_sizes"]) == set(body["available_widgets"])
    assert body["default_sizes"]["shortcuts"] == "large"


def test_an_employee_never_sees_the_office_widgets(client: TestClient, admin_token: str) -> None:
    _, token = _user(client, admin_token, "fitter@example.com", "employee", "Fritz Beispiel")
    body = client.get("/api/dashboard", headers=auth_headers(token)).json()
    assert not OFFICE_ONLY & set(body["available_widgets"])
    assert len(body["available_widgets"]) == 17
    assert len(body["default_sizes"]) == 20
    for device in DEVICES:
        assert not OFFICE_ONLY & set(_ids(body["layouts"][device]))
    mobile = body["layouts"]["mobile"]["widgets"]
    assert mobile[1] == {"id": "shortcuts", "size": "medium", "settings": {"views": ["construction", "planning", "messages", "wiki"]}}
    # Only the shortcuts carry settings; nobody else gets a `settings` key.
    assert all("settings" not in item for item in mobile if item["id"] != "shortcuts")


def test_each_device_keeps_its_own_layout(client: TestClient, admin_token: str) -> None:
    user_id, token = _user(client, admin_token, "multi@example.com", "employee", "Mia Beispiel")
    headers = auth_headers(token)
    tablet = {"version": 1, "widgets": [{"id": "my_status", "size": "medium"}]}
    desktop = {
        "version": 1,
        "widgets": [
            {"id": "my_tasks", "size": "large"},
            {"id": "shortcuts", "size": "small", "settings": {"views": ["time", "wiki"]}},
        ],
    }
    saved_tablet = client.put("/api/dashboard/layouts/tablet", headers=headers, json=tablet)
    assert saved_tablet.status_code == 200, saved_tablet.text
    assert saved_tablet.json()["source"] == "user"
    assert saved_tablet.json()["device"] == "tablet"
    assert saved_tablet.json()["updated_at"]
    saved_desktop = client.put("/api/dashboard/layouts/desktop", headers=headers, json=desktop)
    assert saved_desktop.status_code == 200, saved_desktop.text

    stored = _stored_layouts(user_id)
    assert set(stored) == {"tablet", "desktop"}
    assert stored["desktop"]["role"] == "employee"
    assert isinstance(stored["desktop"]["updated_at"], str) and stored["desktop"]["updated_at"].endswith("Z")

    fresh = auth_headers(_login(client, "multi@example.com"))
    layouts = client.get("/api/dashboard", headers=fresh).json()["layouts"]
    assert layouts["tablet"]["source"] == "user" and layouts["tablet"]["widgets"] == tablet["widgets"]
    assert layouts["desktop"]["source"] == "user" and layouts["desktop"]["widgets"] == desktop["widgets"]
    assert layouts["mobile"]["source"] == "builtin"

    reset = client.delete("/api/dashboard/layouts/tablet", headers=fresh)
    assert reset.status_code == 200, reset.text
    assert reset.json()["source"] == "builtin"
    assert reset.json()["widgets"] == builtin_widgets("employee", "tablet")
    after = client.get("/api/dashboard", headers=fresh).json()["layouts"]
    assert after["tablet"]["source"] == "builtin"
    assert after["desktop"]["source"] == "user" and after["desktop"]["widgets"] == desktop["widgets"]
    assert set(_stored_layouts(user_id)) == {"desktop"}


def test_an_empty_layout_is_stored_as_empty(client: TestClient, admin_token: str) -> None:
    _, token = _user(client, admin_token, "empty@example.com", "employee", "Emil Beispiel")
    headers = auth_headers(token)
    saved = client.put("/api/dashboard/layouts/mobile", headers=headers, json={"version": 1, "widgets": []})
    assert saved.status_code == 200, saved.text
    assert saved.json()["widgets"] == []
    mobile = client.get("/api/dashboard", headers=headers).json()["layouts"]["mobile"]
    assert mobile["source"] == "user" and mobile["widgets"] == []


@pytest.mark.parametrize(
    ("widgets", "code", "ids"),
    [
        ([{"id": "weather", "size": "small"}], "unknown_widget", ["weather"]),
        ([{"id": "my_tasks", "size": "small"}, {"id": "my_tasks", "size": "large"}], "duplicate_widget", ["my_tasks"]),
        ([{"id": "my_tasks", "size": "small", "settings": {"views": ["time"]}}], "settings_not_allowed", ["my_tasks"]),
        ([{"id": "shortcuts", "size": "small", "settings": {"views": ["materials"]}}], "unknown_view", ["materials"]),
        ([{"id": "shortcuts", "size": "small", "settings": {"views": ["time", "time"]}}], "duplicate_view", ["time"]),
    ],
)
def test_a_layout_that_cannot_be_stored_is_refused_with_an_object_detail(
    client: TestClient, admin_token: str, widgets: list[dict], code: str, ids: list[str]
) -> None:
    response = client.put("/api/dashboard/layouts/desktop", headers=auth_headers(admin_token), json={"version": 1, "widgets": widgets})
    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert detail["code"] == code
    assert detail["ids"] == ids
    assert isinstance(detail["message"], str) and detail["message"]
    assert _stored_layouts(_admin_id()) in (None, {})


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("/api/dashboard/layouts/watch", {"version": 1, "widgets": []}),
        ("/api/dashboard/layouts/desktop", {"version": 2, "widgets": []}),
        ("/api/dashboard/layouts/desktop", {"version": 1, "widgets": [{"id": "my_tasks", "size": "huge"}]}),
        ("/api/dashboard/layouts/desktop", {"version": 1, "widgets": [], "colour": "red"}),
        ("/api/dashboard/layouts/desktop", {"version": 1, "widgets": [{"id": "my_tasks", "size": "small", "pinned": True}]}),
        ("/api/dashboard/layouts/desktop", {"version": 1, "widgets": [{"id": "shortcuts", "size": "small", "settings": {"views": []}}]}),
        ("/api/dashboard/layouts/desktop", {"version": 1, "widgets": [{"id": "shortcuts", "size": "small", "settings": {"views": ["time"] * 13}}]}),
        ("/api/dashboard/layouts/desktop", {"version": 1, "widgets": [{"id": "my_tasks", "size": "small"}] * 21}),
    ],
)
def test_a_malformed_request_keeps_fastapis_list_detail(client: TestClient, admin_token: str, path: str, body: dict) -> None:
    response = client.put(path, headers=auth_headers(admin_token), json=body)
    assert response.status_code == 422, response.text
    assert isinstance(response.json()["detail"], list)


def test_a_widget_the_caller_may_not_see_is_stored_but_never_shown(client: TestClient, admin_token: str) -> None:
    user_id, token = _user(client, admin_token, "stale@example.com", "employee", "Stefan Beispiel")
    headers = auth_headers(token)
    body = {"version": 1, "widgets": [{"id": "my_tasks", "size": "medium"}, {"id": "clocked_in", "size": "small"}]}
    saved = client.put("/api/dashboard/layouts/desktop", headers=headers, json=body)
    assert saved.status_code == 200, saved.text
    assert _ids(saved.json()) == ["my_tasks"]
    assert _ids(client.get("/api/dashboard", headers=headers).json()["layouts"]["desktop"]) == ["my_tasks"]
    assert [item["id"] for item in _stored_layouts(user_id)["desktop"]["widgets"]] == ["my_tasks", "clocked_in"]


def test_a_hidden_widget_survives_a_save_and_returns_with_the_permission(client: TestClient, admin_token: str) -> None:
    user_id, token = _user(client, admin_token, "denied@example.com", "employee", "Dana Beispiel")
    headers = auth_headers(token)
    builtin_ids = [item["id"] for item in builtin_widgets("employee", "desktop")]
    old_position = builtin_ids.index("my_status")

    set_user_permissions_override({user_id: {"extra": [], "denied": ["time:clock"]}})
    shown = client.get("/api/dashboard", headers=headers).json()["layouts"]["desktop"]
    assert "my_status" not in _ids(shown)
    rearranged = [item for item in shown["widgets"] if item["id"] != "notifications"]
    saved = client.put("/api/dashboard/layouts/desktop", headers=headers, json={"version": 1, "widgets": rearranged})
    assert saved.status_code == 200, saved.text
    assert "my_status" not in _ids(saved.json())

    set_user_permissions_override({})
    desktop = client.get("/api/dashboard", headers=headers).json()["layouts"]["desktop"]
    assert desktop["source"] == "user"
    assert _ids(desktop).index("my_status") == old_position
    assert "notifications" not in _ids(desktop)


@pytest.mark.parametrize("broken", [None, ["dashboard_layouts"], "garbage", {"dashboard_layouts": "x"}, {"dashboard_layouts": {"desktop": {"version": 9, "widgets": []}, "mobile": [1, 2]}}])
def test_broken_preferences_fall_back_instead_of_failing(client: TestClient, admin_token: str, broken: object) -> None:
    user_id, token = _user(client, admin_token, "broken@example.com", "employee", "Bruno Beispiel")
    with SessionLocal() as db:
        db.get(User, user_id).preferences = broken
        db.commit()
    response = client.get("/api/dashboard", headers=auth_headers(token))
    assert response.status_code == 200, response.text
    for device in DEVICES:
        assert response.json()["layouts"][device]["source"] == "builtin"
    saved = client.put("/api/dashboard/layouts/tablet", headers=auth_headers(token), json={"version": 1, "widgets": [{"id": "my_tasks", "size": "small"}]})
    assert saved.status_code == 200, saved.text
    assert _stored_layouts(user_id)["tablet"]["widgets"] == [{"id": "my_tasks", "size": "small"}]


def test_a_role_change_flags_the_customised_device_until_the_user_decides(client: TestClient, admin_token: str) -> None:
    user_id, token = _user(client, admin_token, "promoted@example.com", "employee", "Paula Beispiel")
    headers = auth_headers(token)
    layout = {"version": 1, "widgets": [{"id": "my_tasks", "size": "large"}]}
    assert client.put("/api/dashboard/layouts/desktop", headers=headers, json=layout).status_code == 200
    assert client.get("/api/dashboard", headers=headers).json()["layouts"]["desktop"]["role_changed"] is False

    changed = client.patch(f"/api/admin/users/{user_id}", headers=auth_headers(admin_token), json={"role": "planning"})
    assert changed.status_code == 200, changed.text

    layouts = client.get("/api/dashboard", headers=headers).json()["layouts"]
    assert layouts["desktop"]["role_changed"] is True
    assert layouts["desktop"]["widgets"] == layout["widgets"]
    assert layouts["tablet"]["role_changed"] is False
    assert layouts["tablet"]["widgets"] == builtin_widgets("planning", "tablet")

    kept = client.put("/api/dashboard/layouts/desktop", headers=headers, json=layout)
    assert kept.status_code == 200 and kept.json()["role_changed"] is False
    assert client.get("/api/dashboard", headers=headers).json()["layouts"]["desktop"]["role_changed"] is False
    assert _stored_layouts(user_id)["desktop"]["role"] == "planning"


def test_delete_gives_back_the_role_default_when_one_is_set(client: TestClient, admin_token: str) -> None:
    _, token = _user(client, admin_token, "reset@example.com", "employee", "Rita Beispiel")
    headers = auth_headers(token)
    role_default = {"version": 1, "widgets": [{"id": "my_tasks", "size": "large"}, {"id": "clocked_in", "size": "small"}]}
    set_default = client.put("/api/dashboard/role-defaults/employee/mobile", headers=auth_headers(admin_token), json=role_default)
    assert set_default.status_code == 200, set_default.text
    assert client.put("/api/dashboard/layouts/mobile", headers=headers, json={"version": 1, "widgets": []}).status_code == 200

    reset = client.delete("/api/dashboard/layouts/mobile", headers=headers)
    assert reset.status_code == 200, reset.text
    assert reset.json()["source"] == "role"
    assert reset.json()["updated_at"]
    assert reset.json()["widgets"] == [{"id": "my_tasks", "size": "large"}]
    # Deleting a device that was never customised is harmless.
    again = client.delete("/api/dashboard/layouts/desktop", headers=headers)
    assert again.status_code == 200 and again.json()["source"] == "builtin"
