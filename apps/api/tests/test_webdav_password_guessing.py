"""WebDAV is not a cheaper place to guess a password than the login.

A mounted drive authenticates every request with the account's main password
(HTTP Basic). Until 2026-10-11 that made it a password oracle the login's
controls never saw:

  * the rate limiter waved every OPTIONS request through (it meant to spare
    CORS preflights), and every DAV route checked the password before it
    looked at the method -- so ``OPTIONS /api/dav/projects`` with Basic
    credentials answered 401 for a wrong password and 204 for the right one,
    at whatever rate the server could serve;
  * a wrong DAV password wrote no ``auth.login_failed`` row, so the per-account
    lockout -- ten failures in fifteen minutes, which the login enforces --
    never counted it and never stopped it.

What holds now, and what these tests pin:

  * OPTIONS on a DAV path is answered before anything looks at credentials:
    the same 204 for no password, a wrong one and the right one;
  * only a real CORS preflight (``Origin`` and ``Access-Control-Request-Method``)
    skips the rate limiter; any other OPTIONS is counted like any request;
  * a wrong DAV password is a failed login: an ``auth.login_failed`` row
    against the account, counted by the same lockout, which then refuses the
    right password too, on WebDAV and on the login alike.
"""

from __future__ import annotations

import re
from collections.abc import Generator
from datetime import datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

import app.main as main
from app.core.config import get_settings
from app.core.db import SessionLocal
from app.models.entities import AuditLog
from tests.test_partner_portal_security import _api_routes

ADMIN_EMAIL = "admin@example.com"
ADMIN_PASSWORD = "ChangeMe123!"
LOCKOUT_THRESHOLD = 3
CEILING = 3
FROZEN_NOW = datetime(2026, 10, 11, 9, 0, 0)
LIMITED = "Too many requests"
PATH_PARAM = re.compile(r"\{[^}]+\}")


def _propfind(client: TestClient, auth: tuple[str, str] | None, path: str = "/api/dav/projects/"):
    return client.request("PROPFIND", path, auth=auth, headers={"Depth": "1"})


def _login(client: TestClient, email: str, password: str):
    return client.post("/api/auth/login", json={"email": email, "password": password})


def _failed_login_rows(email: str) -> list[AuditLog]:
    with SessionLocal() as db:
        return list(
            db.scalars(
                select(AuditLog).where(AuditLog.action == "auth.login_failed", AuditLog.target_id == email)
            ).all()
        )


def _all_failed_login_rows() -> int:
    with SessionLocal() as db:
        return len(db.scalars(select(AuditLog).where(AuditLog.action == "auth.login_failed")).all())


@pytest.fixture
def lockout_after_three(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = get_settings()
    monkeypatch.setattr(settings, "login_lockout_enabled", True)
    monkeypatch.setattr(settings, "login_lockout_threshold", LOCKOUT_THRESHOLD)


@pytest.fixture
def small_ceilings(monkeypatch: pytest.MonkeyPatch) -> Generator[None, None, None]:
    """Every scope's ceiling at CEILING, the clock frozen, the buckets empty."""
    original = main._rate_scope
    monkeypatch.setattr(main, "_rate_scope", lambda path, auth: (original(path, auth)[0], CEILING))
    monkeypatch.setattr(main, "utcnow", lambda: FROZEN_NOW)
    main._rate_bucket.clear()
    yield
    main._rate_bucket.clear()


def _dav_options_paths() -> list[str]:
    paths = []
    for full_path, route, _ in _api_routes(main.app):
        if full_path.startswith("/api/dav/") and "OPTIONS" in route.methods:
            paths.append(PATH_PARAM.sub("1", full_path))
    return paths


def test_options_on_dav_paths_does_not_look_at_the_password(client: TestClient) -> None:
    paths = _dav_options_paths()
    # The enumeration really ran over both trees and their roots.
    assert len(paths) >= 15, paths
    assert "/api/dav/projects" in paths and "/api/dav/customers/1/1" in paths

    for path in paths:
        for auth in (None, (ADMIN_EMAIL, "wrong-password"), ("nobody@example.com", "x"), (ADMIN_EMAIL, ADMIN_PASSWORD)):
            response = client.options(path, auth=auth)
            label = f"OPTIONS {path} as {auth[0] if auth else 'nobody'}"
            assert response.status_code == 204, label
            assert response.headers.get("DAV") == "1, 2", label
            assert "PROPFIND" in response.headers.get("Allow", ""), label
            assert "WWW-Authenticate" not in response.headers, label
    # Nothing was tried, so nothing was recorded as a failure.
    assert _all_failed_login_rows() == 0


def test_only_a_real_cors_preflight_skips_the_rate_limiter(client: TestClient, small_ceilings: None) -> None:
    preflight = {"Origin": "capacitor://localhost", "Access-Control-Request-Method": "GET"}
    for _ in range(CEILING + 2):
        response = client.options("/api/auth/me", headers=preflight)
        assert response.status_code == 200, response.text
        assert response.headers.get("access-control-allow-origin") == "capacitor://localhost"

    # Anything else that says OPTIONS is a request like the rest: an Origin
    # alone is not a preflight, and neither is no header at all.
    for headers in ({}, {"Origin": "capacitor://localhost"}, {}):
        assert client.options("/api/dav/projects", headers=headers).status_code == 204
    limited = client.options("/api/dav/projects")
    assert limited.status_code == 429 and limited.json().get("detail") == LIMITED


def test_a_wrong_dav_password_is_a_failed_login(client: TestClient) -> None:
    response = _propfind(client, (ADMIN_EMAIL, "wrong-password"))
    assert response.status_code == 401
    assert response.headers.get("WWW-Authenticate", "").startswith("Basic ")

    rows = _failed_login_rows(ADMIN_EMAIL)
    assert len(rows) == 1
    assert rows[0].details.get("email") == ADMIN_EMAIL
    assert rows[0].details.get("reason") == "invalid_credentials"
    assert rows[0].details.get("channel") == "webdav"

    # No credentials at all is how every client opens: a challenge, not a guess.
    assert _propfind(client, None).status_code == 401
    # The right password is not a failure.
    assert _propfind(client, (ADMIN_EMAIL, ADMIN_PASSWORD)).status_code == 207
    assert len(_failed_login_rows(ADMIN_EMAIL)) == 1


def test_wrong_dav_passwords_lock_the_account_on_webdav_and_the_login(
    client: TestClient, lockout_after_three: None
) -> None:
    for attempt in range(LOCKOUT_THRESHOLD):
        assert _propfind(client, (ADMIN_EMAIL, f"wrong-{attempt}")).status_code == 401, attempt

    # Locked: the right password no longer tells a guesser anything...
    locked = _propfind(client, (ADMIN_EMAIL, ADMIN_PASSWORD))
    assert locked.status_code == 429
    assert locked.headers.get("Retry-After") == str(get_settings().login_lockout_window_seconds)
    # ...and the login, which shares the count, is closed to it as well.
    login = _login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    assert login.status_code == 429
    assert login.json().get("detail") == "Too many failed attempts. Please try again later."


def test_failed_logins_lock_webdav_too(client: TestClient, lockout_after_three: None) -> None:
    for attempt in range(LOCKOUT_THRESHOLD):
        assert _login(client, ADMIN_EMAIL, f"wrong-{attempt}").status_code == 401, attempt
    assert _propfind(client, (ADMIN_EMAIL, ADMIN_PASSWORD)).status_code == 429


def test_a_domain_prefix_does_not_buy_a_fresh_count(client: TestClient, lockout_after_three: None) -> None:
    """Windows sends ``DOMAIN\\user``, other clients ``realm/user``; the lookup
    strips either. The count must follow the account, not the spelling, or
    every new prefix would be ten more guesses."""
    spellings = [f"SMPL\\{ADMIN_EMAIL}", f"other/{ADMIN_EMAIL}", ADMIN_EMAIL.upper()]
    for spelling in spellings:
        assert _propfind(client, (spelling, "wrong-password")).status_code == 401, spelling
    assert len(_failed_login_rows(ADMIN_EMAIL)) == LOCKOUT_THRESHOLD
    assert _propfind(client, (f"NEW\\{ADMIN_EMAIL}", ADMIN_PASSWORD)).status_code == 429


def test_an_unknown_account_locks_like_a_real_one(client: TestClient, lockout_after_three: None) -> None:
    """Otherwise the lockout itself would tell which addresses have accounts."""
    for spelling in ("ghost@example.com", "SMPL\\ghost@example.com", "x/GHOST@example.com"):
        assert _propfind(client, (spelling, "wrong-password")).status_code == 401, spelling
    assert len(_failed_login_rows("ghost@example.com")) == LOCKOUT_THRESHOLD
    assert _propfind(client, ("ghost@example.com", "anything")).status_code == 429
