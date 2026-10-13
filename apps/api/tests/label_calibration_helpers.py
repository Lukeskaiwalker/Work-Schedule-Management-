"""Shared steps of the label-printer calibration tests (not a test module)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import auth_headers

W = "/api/werkstatt/label-printer"
A = "/api/admin/settings/label-printer"


def employee_with(permissions: list[str], email: str, name: str = "Max Monteur") -> tuple[int, str]:
    """An employee carrying exactly ``permissions`` as a user-level grant."""
    from app.core.db import SessionLocal
    from app.core.permissions import get_all_user_overrides, set_user_permissions_override
    from app.core.security import create_access_token, get_password_hash
    from app.models.entities import User

    with SessionLocal() as db:
        user = User(email=email, full_name=name, password_hash=get_password_hash("x"), role="employee")
        db.add(user)
        db.commit()
        user_id = user.id
    overrides = get_all_user_overrides()
    overrides[user_id] = {"extra": permissions, "denied": []}
    set_user_permissions_override(overrides)
    return user_id, create_access_token(str(user_id), {"role": "employee"})


def settings(client: TestClient, token: str) -> dict:
    response = client.get(A, headers=auth_headers(token))
    assert response.status_code == 200, response.text
    return response.json()


def enable_staff(client: TestClient, admin_token: str) -> None:
    revision = settings(client, admin_token)["revision"]
    response = client.put(
        f"{A}/printer", headers=auth_headers(admin_token),
        json={"revision": revision, "label_calibration_staff_enabled": True},
    )
    assert response.status_code == 200, response.text


def start(client: TestClient, token: str, material_id: str = "wago-210-804", mode: str = "quick", **extra) -> dict:
    response = client.post(f"{W}/session", headers=auth_headers(token), json={"mode": mode, "material_id": material_id, **extra})
    assert response.status_code == 200, response.text
    return response.json()


def step(client: TestClient, token: str, sid: str, name: str, body: dict | None = None, expect: int = 200) -> dict:
    response = client.post(f"{W}/session/{sid}/{name}", headers=auth_headers(token), json=body)
    assert response.status_code == expect, response.text
    return response.json()


def to_sensed(client: TestClient, token: str, material_id: str = "wago-210-804", mode: str = "quick", polls: int = 10) -> tuple[str, dict]:
    """start → activate → apply → autosense → poll until final; returns (sid, last poll)."""
    session = start(client, token, material_id, mode)
    sid = session["session_id"]
    step(client, token, sid, "activate", {"material_id": material_id})
    step(client, token, sid, "apply")
    step(client, token, sid, "autosense", {"confirm_feed": True})
    poll: dict = {}
    for _ in range(polls):
        poll = step(client, token, sid, "poll")
        if poll["phase"] != "sensing":
            break
    return sid, poll
