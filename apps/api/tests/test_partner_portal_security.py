"""The partner portal's fence — a partner login reaches the portal and nothing else.

What must hold:

* the ``external`` role holds no permission at all, and a per-user override
  cannot hand it one;
* every authenticated API route outside ``/api/portal/`` answers a partner
  session with 403 — enumerated from the live route table, so a route added
  next year is covered without anyone remembering this file;
* the event stream and WebDAV, which authenticate on their own, refuse it too;
* a partner login never becomes a project member, an assignee, a chat
  participant, a row in the admin user list, or a target the generic admin
  user endpoints may edit — partner logins are managed on the partner.
"""

from __future__ import annotations

import re

from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.core.deps import PORTAL_ONLY_DETAIL, get_current_user
from app.core.permissions import (
    ROLE_EXTERNAL,
    get_all_user_overrides,
    get_user_effective_permissions,
    has_global_project_access,
    has_permission_for_user,
    set_user_permissions_override,
)
from app.models.entities import ProjectMember, User
from tests.conftest import auth_headers
from tests.partner_portal_helpers import PORTAL_PASSWORD, create_project, portal_login

PATH_PARAM = re.compile(r"\{[^}]+\}")


def _depends_on_current_user(dependant) -> bool:
    for sub in dependant.dependencies:
        if sub.call is get_current_user or _depends_on_current_user(sub):
            return True
    return False


def _api_routes(app):
    """(full path, route, dependant) for every API route, however FastAPI nests them.

    FastAPI >= 0.140 keeps included routers as branches instead of copying
    their routes into ``app.routes``; ``_iter_routes_with_context`` is its own
    walk over that tree. Older versions list the copies flat.
    """
    try:
        from fastapi.routing import _iter_routes_with_context
    except ImportError:  # pragma: no cover - older FastAPI
        for route in app.routes:
            if isinstance(route, APIRoute):
                yield route.path, route, route.dependant
        return
    for route, context in _iter_routes_with_context(app.routes):
        if not isinstance(route, APIRoute):
            continue
        if context is not None:
            yield context.path, route, (context.dependant or route.dependant)
        else:
            yield route.path, route, route.dependant


def test_the_external_role_holds_no_permission_even_with_an_override() -> None:
    saved = get_all_user_overrides()
    try:
        set_user_permissions_override({4242: {"extra": ["projects:view", "tasks:view_all", "users:manage"], "denied": []}})
        for permission in ("projects:view", "tasks:view_all", "users:manage", "files:view"):
            assert has_permission_for_user(4242, ROLE_EXTERNAL, permission) is False
        assert get_user_effective_permissions(4242, ROLE_EXTERNAL) == []
        assert has_global_project_access(4242, ROLE_EXTERNAL) is False
    finally:
        set_user_permissions_override(saved)


def test_a_partner_session_is_refused_on_every_route_outside_the_portal(client: TestClient, admin_token: str) -> None:
    from app.main import _rate_bucket, app

    _, _, token = portal_login(client, admin_token)
    headers = auth_headers(token)
    checked = 0
    leaks: list[str] = []
    portal_routes = 0
    for full_path, route, dependant in _api_routes(app):
        if not _depends_on_current_user(dependant):
            continue
        if full_path.startswith("/api/portal/"):
            portal_routes += 1
            continue
        path = PATH_PARAM.sub("1", full_path)
        for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
            _rate_bucket.clear()
            response = client.request(method, path, headers=headers)
            checked += 1
            detail = response.json().get("detail") if response.headers.get("content-type", "").startswith("application/json") else None
            if response.status_code != 403 or detail != PORTAL_ONLY_DETAIL:
                leaks.append(f"{method} {full_path} -> {response.status_code} {detail!r}")
    assert checked > 300, checked  # the enumeration really ran over the app
    assert portal_routes >= 12, portal_routes  # incl. documents and hours
    assert leaks == []


def test_the_portal_itself_is_reachable_and_internal_staff_are_kept_out_of_it(client: TestClient, admin_token: str) -> None:
    _, _, token = portal_login(client, admin_token)
    assert client.get("/api/portal/me", headers=auth_headers(token)).status_code == 200
    staff = client.get("/api/portal/me", headers=auth_headers(admin_token))
    assert staff.status_code == 403


def test_the_event_stream_and_webdav_refuse_a_partner_login(client: TestClient, admin_token: str) -> None:
    _, user, token = portal_login(client, admin_token)
    stream = client.get("/api/events", params={"token": token})
    assert stream.status_code == 403
    dav = TestClient(client.app).request("PROPFIND", "/api/dav/projects", auth=(user["email"], PORTAL_PASSWORD))
    assert dav.status_code == 401


def test_a_partner_login_never_joins_a_project_by_default(client: TestClient, admin_token: str) -> None:
    before = create_project(client, admin_token, "2026-901", "Vorher angelegt")
    _, user, _ = portal_login(client, admin_token)
    after = create_project(client, admin_token, "2026-902", "Nachher angelegt")
    with SessionLocal() as db:
        rows = db.scalars(select(ProjectMember).where(ProjectMember.user_id == user["id"])).all()
        assert rows == []
        assert db.get(User, user["id"]).role == ROLE_EXTERNAL
    refused = client.post(
        f"/api/projects/{after['id']}/members",
        headers=auth_headers(admin_token),
        json={"user_id": user["id"], "can_manage": False},
    )
    assert refused.status_code == 400
    assert before["id"] != after["id"]


def test_a_partner_login_is_no_assignee_no_chat_participant_and_not_listed(client: TestClient, admin_token: str) -> None:
    _, user, _ = portal_login(client, admin_token)
    project = create_project(client, admin_token, "2026-903", "Zuweisung")
    head = auth_headers(admin_token)

    assignable = client.get("/api/users/assignable", headers=head)
    assert assignable.status_code == 200 and user["id"] not in [row["id"] for row in assignable.json()]

    task = client.post("/api/tasks", headers=head, json={"project_id": project["id"], "title": "Rinne", "assignee_ids": [user["id"]]})
    assert task.status_code == 400

    thread = client.post("/api/threads", headers=head, json={"name": "Baustelle", "participant_user_ids": [user["id"]]})
    assert thread.status_code == 400

    listed = client.get("/api/admin/users", headers=head)
    assert listed.status_code == 200 and user["id"] not in [row["id"] for row in listed.json()]


def test_the_generic_admin_user_endpoints_leave_partner_logins_alone(client: TestClient, admin_token: str) -> None:
    _, user, _ = portal_login(client, admin_token)
    head = auth_headers(admin_token)
    uid = user["id"]
    refused = [
        client.patch(f"/api/admin/users/{uid}", headers=head, json={"role": "employee"}),
        client.patch(f"/api/admin/users/{uid}", headers=head, json={"full_name": "Umbenannt"}),
        client.post(f"/api/admin/users/{uid}/send-invite", headers=head),
        client.post(f"/api/admin/users/{uid}/send-password-reset", headers=head),
        client.post(f"/api/admin/users/{uid}/apply-template", headers=head),
        client.put(f"/api/admin/user-permissions/{uid}", headers=head, json={"extra": ["projects:view"], "denied": []}),
        client.post(f"/api/admin/users/{uid}/station-badge/rotate", headers=head),
        client.post("/api/admin/invites", headers=head, json={"email": user["email"], "full_name": "Kollege", "role": "employee"}),
    ]
    assert [r.status_code for r in refused] == [409] * len(refused), [r.text for r in refused]
    with SessionLocal() as db:
        row = db.get(User, uid)
        assert row.role == ROLE_EXTERNAL and row.full_name == "Andreas Hoffmann"


def test_a_partner_token_cannot_be_used_as_a_session_after_deactivation(client: TestClient, admin_token: str) -> None:
    partner, user, token = portal_login(client, admin_token)
    off = client.post(f"/api/partners/{partner['id']}/portal-users/{user['id']}/deactivate", headers=auth_headers(admin_token))
    assert off.status_code == 200 and off.json()["status"] == "disabled"
    assert client.get("/api/portal/me", headers=auth_headers(token)).status_code == 401
    login = client.post("/api/auth/login", json={"email": user["email"], "password": PORTAL_PASSWORD})
    assert login.status_code == 401
