"""
test_events.py - Tests for the SSE live-update endpoint (/api/events).

The stream used to take the session JWT as ``?token=`` because EventSource
cannot send an Authorization header — and a query string is the one part of
a request every access log prints. It now authenticates, in this order:

  - ``?ticket=``  a single-use, 60-second ticket from POST /api/events/ticket
                  (the native shell, whose SameSite=Strict cookie never rides
                  along cross-origin)
  - the ``access_token`` session cookie (browsers; nothing in the URL at all)
  - ``?token=``   the old JWT parameter, accepted only while installed iOS
                  shells still carry the old bundle — see docs/LOG_HYGIENE.md

Covers each path, what each refuses, and that a ticket is spent on use.
"""
from __future__ import annotations

import json
from datetime import timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.core.time import utcnow
from app.models.entities import User, UserActionToken
from app.services.event_stream_tickets import EVENT_STREAM_TICKET_PURPOSE, TICKET_TTL_SECONDS
from tests.conftest import auth_headers


def _first_event(response) -> dict | None:
    for raw_line in response.iter_lines():
        line = raw_line.strip()
        if line.startswith("data:"):
            try:
                return json.loads(line[len("data:") :].strip())
            except json.JSONDecodeError:
                continue
    return None


def _mint_ticket(client: TestClient, token: str) -> str:
    response = client.post("/api/events/ticket", headers=auth_headers(token))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["expires_in"] == TICKET_TTL_SECONDS
    return body["ticket"]


# ── no credential / bad credential ──────────────────────────────────────────


def test_events_without_any_credential_returns_401(client: TestClient) -> None:
    client.cookies.clear()
    response = client.get("/api/events")
    assert response.status_code == 401


def test_a_session_token_in_the_url_is_no_way_in(client: TestClient, admin_token: str) -> None:
    # ?token= was removed (2026-10-11): the iOS shell that needed it is not
    # in use, and a long-lived JWT in a URL is exactly what access logs keep.
    # A valid one must not open the stream any more.
    client.cookies.clear()
    response = client.get("/api/events", params={"token": admin_token})
    assert response.status_code == 401


def test_events_garbage_session_cookie_returns_401(client: TestClient) -> None:
    client.cookies.clear()
    client.cookies.set("access_token", "this.is.not.a.valid.jwt")
    response = client.get("/api/events")
    assert response.status_code == 401


# ── the session cookie (browsers) ───────────────────────────────────────────


def test_events_authenticate_from_the_session_cookie(client: TestClient, admin_token: str) -> None:
    # Logging in (the admin_token fixture) left the httpOnly cookie in the
    # client's jar, exactly as in a browser; the URL carries no credential.
    assert client.cookies.get("access_token")
    with client.stream("GET", "/api/events") as response:
        assert response.status_code == 200
        assert "text/event-stream" in response.headers.get("content-type", "")
        assert _first_event(response) == {"type": "connected"}


def test_events_cookie_of_a_deactivated_user_is_refused(client: TestClient, admin_token: str) -> None:
    created = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={"email": "stream-off@example.com", "password": "Stream-Off-2026!", "full_name": "Stream Off", "role": "employee"},
    )
    assert created.status_code == 200, created.text
    login = client.post("/api/auth/login", json={"email": "stream-off@example.com", "password": "Stream-Off-2026!"})
    assert login.status_code == 200
    with SessionLocal() as db:
        db.get(User, created.json()["id"]).is_active = False
        db.commit()
    assert client.get("/api/events").status_code == 401


# ── stream tickets (the native shell) ───────────────────────────────────────


def test_stream_ticket_requires_authentication(client: TestClient) -> None:
    client.cookies.clear()
    assert client.post("/api/events/ticket").status_code == 401


def test_stream_ticket_opens_the_stream_exactly_once(client: TestClient, admin_token: str) -> None:
    ticket = _mint_ticket(client, admin_token)
    client.cookies.clear()  # the shell has no cookie; the ticket alone must do
    with client.stream("GET", "/api/events", params={"ticket": ticket}) as response:
        assert response.status_code == 200
        assert _first_event(response) == {"type": "connected"}
    assert client.get("/api/events", params={"ticket": ticket}).status_code == 401


def test_a_spent_ticket_does_not_fall_back_to_the_cookie(client: TestClient, admin_token: str) -> None:
    # A ticket on the URL is an explicit choice of credential. If it fails, the
    # request fails — otherwise "single use" would be untestable from any
    # client that also happens to hold a cookie.
    ticket = _mint_ticket(client, admin_token)
    assert client.cookies.get("access_token")
    with client.stream("GET", "/api/events", params={"ticket": ticket}) as response:
        assert response.status_code == 200
    assert client.get("/api/events", params={"ticket": ticket}).status_code == 401


def test_an_expired_stream_ticket_is_refused(client: TestClient, admin_token: str) -> None:
    ticket = _mint_ticket(client, admin_token)
    with SessionLocal() as db:
        row = db.scalars(select(UserActionToken).where(UserActionToken.purpose == EVENT_STREAM_TICKET_PURPOSE)).one()
        row.expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    client.cookies.clear()
    assert client.get("/api/events", params={"ticket": ticket}).status_code == 401


def test_an_unknown_stream_ticket_is_refused(client: TestClient) -> None:
    client.cookies.clear()
    assert client.get("/api/events", params={"ticket": "not-a-ticket"}).status_code == 401


def test_a_stream_ticket_is_not_a_session(client: TestClient, admin_token: str) -> None:
    ticket = _mint_ticket(client, admin_token)
    client.cookies.clear()
    assert client.get("/api/auth/me", headers=auth_headers(ticket)).status_code == 401


def test_minting_sweeps_spent_tickets_but_leaves_invites_alone(client: TestClient, admin_token: str) -> None:
    invited = client.post(
        "/api/admin/invites",
        headers=auth_headers(admin_token),
        json={"email": "invite-keeps@example.com", "full_name": "Invite Keeps", "role": "employee"},
    )
    assert invited.status_code == 200, invited.text
    first = _mint_ticket(client, admin_token)
    with client.stream("GET", "/api/events", params={"ticket": first}) as response:
        assert response.status_code == 200
    _mint_ticket(client, admin_token)
    with SessionLocal() as db:
        purposes = sorted(db.scalars(select(UserActionToken.purpose)).all())
    # The spent ticket is gone, the fresh one and the invite are not.
    assert purposes == sorted([EVENT_STREAM_TICKET_PURPOSE, "invite"])


# ── the transitional ?token= ────────────────────────────────────────────────


def test_a_tab_of_the_old_bundle_still_connects_through_its_cookie(client: TestClient, admin_token: str) -> None:
    # A tab opened before the deploy still sends ?token=, but EventSource
    # also sends the same-origin session cookie — that is what lets it in now.
    assert client.cookies.get("access_token")
    with client.stream("GET", "/api/events", params={"token": "ignored"}) as response:
        assert response.status_code == 200
        assert _first_event(response) == {"type": "connected"}


def test_the_sqlite_fallback_tells_the_browser_not_to_reconnect_at_once(
    client: TestClient, admin_token: str
) -> None:
    """Without PostgreSQL the stream says "connected" and ends. A browser's
    EventSource then reconnects after its default ~3 s, and every reconnect
    re-runs the client's full refresh of the open view: on a local SQLite run
    the Zeiterfassung re-fetched its /api/time/* set on every reconnect, on top
    of its poll (measured 2026-10-11, 8 reconnects in 25 s), which looked like a
    polling bug and tripped the rate limiter. SQLite never delivers an event
    anyway, so the fallback asks for a long reconnect delay instead."""
    assert client.cookies.get("access_token")
    with client.stream("GET", "/api/events") as response:
        assert response.status_code == 200
        retry_ms = [
            int(line.split(":", 1)[1])
            for line in (raw.strip() for raw in response.iter_lines())
            if line.startswith("retry:")
        ]
    assert retry_ms, "no retry: field in the fallback stream"
    assert retry_ms[0] >= 60_000
