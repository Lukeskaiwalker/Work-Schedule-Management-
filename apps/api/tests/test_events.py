"""
test_events.py - Tests for the SSE live-update endpoint (/api/events).

Covers:
  - Missing token -> 422
  - Invalid/garbage token -> 401
  - Valid token -> 200, Content-Type: text/event-stream
  - Valid token -> first streamed event is {"type": "connected"}
"""
from __future__ import annotations

import json

from fastapi.testclient import TestClient


def test_events_missing_token_returns_422(client: TestClient) -> None:
    """GET /api/events without a token should return 422 (missing required query param)."""
    response = client.get("/api/events")
    assert response.status_code == 422


def test_events_invalid_token_returns_401(client: TestClient) -> None:
    """GET /api/events with a garbage string should return 401."""
    response = client.get("/api/events?token=this.is.not.a.valid.jwt")
    assert response.status_code == 401


def test_events_valid_token_returns_200_stream(
    client: TestClient, admin_token: str
) -> None:
    """
    GET /api/events with a valid admin token should return:
      - HTTP 200
      - Content-Type: text/event-stream
    """
    with client.stream("GET", f"/api/events?token={admin_token}") as response:
        assert response.status_code == 200
        content_type = response.headers.get("content-type", "")
        assert "text/event-stream" in content_type


def test_events_streams_connected_event_first(
    client: TestClient, admin_token: str
) -> None:
    """
    The very first data frame after connecting must be {"type": "connected"}.
    We read lines until we see a data line, then break immediately.
    """
    with client.stream("GET", f"/api/events?token={admin_token}") as response:
        assert response.status_code == 200

        first_event: dict | None = None
        for raw_line in response.iter_lines():
            line = raw_line.strip()
            if not line:
                continue
            if line.startswith("data:"):
                payload = line[len("data:") :].strip()
                try:
                    first_event = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                break  # Stop after the first data event

        assert first_event is not None, (
            "No data: event was received from the SSE stream"
        )
        assert first_event.get("type") == "connected", (
            f"Expected type='connected', got: {first_event}"
        )


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
    with client.stream("GET", f"/api/events?token={admin_token}") as response:
        assert response.status_code == 200
        retry_ms = [
            int(line.split(":", 1)[1])
            for line in (raw.strip() for raw in response.iter_lines())
            if line.startswith("retry:")
        ]
    assert retry_ms, "no retry: field in the fallback stream"
    assert retry_ms[0] >= 60_000
