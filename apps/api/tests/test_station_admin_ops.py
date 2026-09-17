"""The Scan-Station page's buttons, end to end against a scripted Pi.

Every control on that page used to end in "Schnittstelle noch nicht
verfügbar". What is pinned here is that each one now does what its label
says, and — because the api is calling *out* to an unauthenticated LAN
device — that the boundary holds:

  * the api only ever calls the address the Pi reported or the admin typed,
    and neither can be anything but a private address;
  * the one dangerous route carries the proof header, and nothing else does;
  * a Pi that is off, a printer that is unplugged and a station that was
    never updated are three different answers, none of them a 500.

The Pi is ``httpx.MockTransport`` behind the client's one seam
(``_open_client``): a real request object, a scripted reply, and a record of
what the api actually sent.
"""

from __future__ import annotations

import hashlib
import re
from datetime import timedelta

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.core.time import utcnow
from app.models.entities import Station, WerkstattInventorySession
from app.services import station_agent_client
from app.services.station_agent_client import (
    AGENT_URL_HOST_DETAIL,
    MAX_RESPONSE_BYTES,
    PROOF_HEADER,
    UNCONFIGURED_DETAIL,
    UNREACHABLE_DETAIL,
    validate_agent_url,
)
from app.routers.workflow_station_admin import TEST_PRINT_QUEUED_DETAIL, TEST_PRINT_SIMULATED_DETAIL
from app.services.station_sessions import (
    MAX_IMPORT_ROWS,
    SESSION_FINALIZED_DETAIL,
    SESSION_TOO_LARGE_DETAIL,
    STATION_INACTIVE_DETAIL,
    TOO_MANY_ROWS_DETAIL,
)

PI_URL = "http://192.168.2.235:8765"

HEALTH_OK = {
    "ok": True,
    "version": "1.1.0",
    "printer_connected": True,
    "media_width_mm": 12,
    "error": None,
    "simulated": False,
    "uptime_seconds": 4242,
    "session_count": 3,
    "hardware": {
        "printer_model": "Brother PT-P710BT",
        "scanner_present": True,
        "scanner_name": "/dev/input/event3",
        "simulated": False,
    },
}

REGAL_COUNTS = {
    "session": "regal",
    "started_at": "2026-09-10T08:00:00Z",
    "status": "open",
    "articles": 3,
    "total_qty": 5,
    "total_scans": 5,
    "counts": [
        {"code": "4011923456789", "item_name": "Schraube M6x40", "counted_qty": 3, "scan_count": 3},
        {"code": "SMPL-000123", "item_name": "Kabelbinder", "counted_qty": 2, "scan_count": 2},
        {"code": "UNDONE-1", "item_name": "weg", "counted_qty": 0, "scan_count": 1},
    ],
}


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# --------------------------------------------------------------------------
# the scripted Pi
# --------------------------------------------------------------------------


class FakeAgent:
    """Answers from a ``(method, path) -> (status, body) | callable`` table and
    keeps every request the api made, so a test can look at what went out."""

    def __init__(self) -> None:
        self.routes: dict[tuple[str, str], object] = {}
        self.requests: list[httpx.Request] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        route = self.routes.get((request.method, request.url.path))
        if route is None:
            return httpx.Response(404, json={"ok": False, "error": f"no route for {request.url.path}"})
        if callable(route):
            return route(request)
        status, body = route
        return httpx.Response(status, json=body)

    def paths(self) -> list[str]:
        return [r.url.path for r in self.requests]


@pytest.fixture
def pi(monkeypatch: pytest.MonkeyPatch) -> FakeAgent:
    agent = FakeAgent()
    monkeypatch.setattr(
        station_agent_client,
        "_open_client",
        lambda timeout: httpx.Client(transport=httpx.MockTransport(agent.handle), timeout=timeout),
    )
    return agent


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def _paired_station(client: TestClient, admin_token: str, name: str = "Werkstatt Pi") -> tuple[str, dict]:
    started = client.post(
        "/api/station/pair/start", json={"device_hint": "scanpi-01", "agent_version": "1.1.0"}
    )
    assert started.status_code == 201, started.text
    approved = client.post(
        "/api/station/pair/approve",
        headers=auth_headers(admin_token),
        json={"user_code": started.json()["user_code"], "name": name},
    )
    assert approved.status_code == 200, approved.text
    polled = client.post("/api/station/pair/poll", json={"device_token": started.json()["device_token"]})
    assert polled.status_code == 200 and polled.json()["status"] == "approved", polled.text
    return polled.json()["token"], polled.json()["station"]


def _beat(client: TestClient, raw_token: str, **payload) -> dict:
    resp = client.post("/api/station/heartbeat", headers=auth_headers(raw_token), json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()["station"]


def _addressed_station(client: TestClient, admin_token: str) -> tuple[str, dict]:
    """A paired station whose agent has reported the office Pi's address."""
    raw_token, station = _paired_station(client, admin_token)
    _beat(client, raw_token, host="192.168.2.235", port=8765, session_count=1)
    return raw_token, station


def _listed(client: TestClient, admin_token: str, station_id: int) -> dict:
    rows = client.get("/api/station/stations", headers=auth_headers(admin_token)).json()
    return next(row for row in rows if row["id"] == station_id)


def _employee_token(client: TestClient, admin_token: str) -> str:
    created = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={"email": "monteur@example.com", "password": "Password123!", "full_name": "Monteur", "role": "employee"},
    )
    assert created.status_code == 200, created.text
    login = client.post("/api/auth/login", json={"email": "monteur@example.com", "password": "Password123!"})
    assert login.status_code == 200, login.text
    return login.headers["X-Access-Token"]


def _set_last_seen(station_id: int, delta: timedelta | None) -> None:
    with SessionLocal() as db:
        row = db.get(Station, station_id)
        row.last_seen_at = None if delta is None else utcnow() - delta
        db.add(row)
        db.commit()


# --------------------------------------------------------------------------
# heartbeat → what the page renders
# --------------------------------------------------------------------------


def test_the_heartbeat_reports_address_uptime_and_hardware(client: TestClient, admin_token: str) -> None:
    raw_token, station = _paired_station(client, admin_token)
    _beat(
        client,
        raw_token,
        agent_version="1.1.0",
        printer_connected=True,
        media_width_mm=12,
        host="192.168.2.235",
        port=8765,
        uptime_seconds=600,
        session_count=2,
        hardware={"printer_model": "Brother PT-P710BT", "scanner_present": True,
                  "scanner_name": "/dev/input/event3", "simulated": False},
        status={"simulated": False},
    )
    row = _listed(client, admin_token, station["id"])
    assert row["status"] == "online"
    assert row["host"] == "192.168.2.235"
    assert row["port"] == 8765
    assert row["uptime_seconds"] == 600
    assert row["session_count"] == 2
    assert row["pending_count"] == 2  # nothing imported yet
    assert row["paired_at"] == row["created_at"]
    assert row["paired_by_name"]  # the approving admin's full name
    hardware = row["hardware"]
    assert hardware["printer_connected"] is True
    assert hardware["printer_model"] == "Brother PT-P710BT"
    assert hardware["media_width_mm"] == 12
    assert hardware["scanner_present"] is True
    assert hardware["scanner_name"] == "/dev/input/event3"
    assert hardware["simulated"] is False
    assert row["agent_error"] is None


def test_an_unplugged_printer_is_a_hardware_row_not_an_agent_error(
    client: TestClient, admin_token: str
) -> None:
    raw_token, station = _paired_station(client, admin_token)
    _beat(client, raw_token, printer_connected=False, error="printer not found on USB (04f9:20af)")
    row = _listed(client, admin_token, station["id"])
    assert row["hardware"]["printer_connected"] is False
    assert "printer not found" in row["hardware"]["printer_error"]
    assert row["agent_error"] is None


@pytest.mark.parametrize("host", ["8.8.8.8", "127.0.0.1", "169.254.169.254", "::1", "not-an-ip"])
def test_a_reported_host_that_is_not_private_is_never_stored(
    client: TestClient, admin_token: str, host: str
) -> None:
    """A station token must not be able to point the api anywhere but the
    LAN — not at the internet, not at itself, not at a metadata address."""
    raw_token, station = _paired_station(client, admin_token)
    row = _beat(client, raw_token, host=host, port=8765)
    assert row["host"] is None and row["port"] is None
    assert row["last_seen_at"] is not None  # the heartbeat itself still counts


def test_an_older_agent_leaves_a_stored_address_alone_but_a_bad_report_clears_it(
    client: TestClient, admin_token: str
) -> None:
    raw_token, _ = _paired_station(client, admin_token)
    assert _beat(client, raw_token, host="10.0.0.5", port=8765)["host"] == "10.0.0.5"
    # No host key at all: an agent from before the field existed.
    assert _beat(client, raw_token, printer_connected=True)["host"] == "10.0.0.5"
    # A newer agent reporting something unusable: the address must not outlive it.
    assert _beat(client, raw_token, host="1.2.3.4", port=8765)["host"] is None


def test_status_is_judged_by_the_server_clock(client: TestClient, admin_token: str) -> None:
    raw_token, station = _paired_station(client, admin_token)
    _beat(client, raw_token)
    assert _listed(client, admin_token, station["id"])["status"] == "online"
    _set_last_seen(station["id"], timedelta(minutes=5))
    assert _listed(client, admin_token, station["id"])["status"] == "stale"
    _set_last_seen(station["id"], timedelta(minutes=20))
    assert _listed(client, admin_token, station["id"])["status"] == "offline"
    _set_last_seen(station["id"], None)
    assert _listed(client, admin_token, station["id"])["status"] == "unknown"


def test_an_approved_but_uncollected_station_is_still_listed(client: TestClient, admin_token: str) -> None:
    """Hiding retired rows must not hide the one the admin just approved."""
    started = client.post("/api/station/pair/start", json={"device_hint": "new-pi"}).json()
    approved = client.post(
        "/api/station/pair/approve",
        headers=auth_headers(admin_token),
        json={"user_code": started["user_code"], "name": "Fresh Pi"},
    ).json()
    rows = client.get("/api/station/stations", headers=auth_headers(admin_token)).json()
    assert [r["id"] for r in rows] == [approved["station"]["id"]]
    assert rows[0]["active"] is False


# --------------------------------------------------------------------------
# no address yet — the honest 409
# --------------------------------------------------------------------------


def test_actions_without_an_address_say_what_to_do(client: TestClient, admin_token: str, pi: FakeAgent) -> None:
    _, station = _paired_station(client, admin_token)
    sid = station["id"]
    headers = auth_headers(admin_token)
    for method, path, body in (
        ("post", f"/api/station/stations/{sid}/refresh", None),
        ("post", f"/api/station/stations/{sid}/test-print", {}),
        ("post", f"/api/station/stations/{sid}/restart", {"confirm": True}),
        ("post", f"/api/station/stations/{sid}/sessions/regal/import", {}),
    ):
        resp = getattr(client, method)(path, headers=headers, json=body)
        assert resp.status_code == 409, (path, resp.text)
        assert resp.json()["detail"] == UNCONFIGURED_DETAIL
    sessions = client.get(f"/api/station/stations/{sid}/sessions", headers=headers)
    assert sessions.status_code == 200
    assert sessions.json() == {"sessions": [], "ok": False, "error": UNCONFIGURED_DETAIL}
    assert pi.requests == []  # nothing left the api


# --------------------------------------------------------------------------
# PATCH — name, location, override
# --------------------------------------------------------------------------


def test_patch_edits_name_location_and_the_agent_override(client: TestClient, admin_token: str) -> None:
    _, station = _paired_station(client, admin_token)
    headers = auth_headers(admin_token)
    resp = client.patch(
        f"/api/station/stations/{station['id']}",
        headers=headers,
        json={"name": "  Büro Pi ", "location": "Werkstatt, Regalwand", "agent_url": "http://smpl-station.local:8765/"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["name"] == "Büro Pi"
    assert body["location"] == "Werkstatt, Regalwand"
    assert body["agent_url_override"] == "http://smpl-station.local:8765"

    cleared = client.patch(
        f"/api/station/stations/{station['id']}", headers=headers, json={"agent_url": None, "location": ""}
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["agent_url_override"] is None
    assert cleared.json()["location"] is None
    assert cleared.json()["name"] == "Büro Pi"  # untouched: the field was not sent

    assert client.patch(f"/api/station/stations/{station['id']}", headers=headers, json={"name": "  "}).status_code == 400
    assert client.patch(f"/api/station/stations/{station['id']}", headers=headers, json={}).status_code == 400


@pytest.mark.parametrize(
    "url",
    [
        "http://8.8.8.8:8765",  # public
        "http://169.254.169.254:80",  # link-local / metadata
        "http://127.0.0.1:8765",  # the api itself
        "http://192.168.2.235",  # no port
        "http://192.168.2.235:8765/health",  # a path
        "ftp://192.168.2.235:21",
        "http://user:pw@192.168.2.235:8765",
        "http://example.com:8765",
    ],
)
def test_the_override_refuses_anything_that_is_not_a_private_lan_address(
    client: TestClient, admin_token: str, url: str
) -> None:
    _, station = _paired_station(client, admin_token)
    resp = client.patch(
        f"/api/station/stations/{station['id']}", headers=auth_headers(admin_token), json={"agent_url": url}
    )
    assert resp.status_code == 400, (url, resp.text)
    assert resp.json()["detail"]


def test_validate_agent_url_normalises_the_accepted_shapes() -> None:
    assert validate_agent_url("http://192.168.2.235:8765") == "http://192.168.2.235:8765"
    assert validate_agent_url("HTTP://Smpl-Station.LOCAL:8765/") == "http://smpl-station.local:8765"
    assert validate_agent_url("http://[fd12::1]:8765") == "http://[fd12::1]:8765"
    with pytest.raises(ValueError, match=re.escape(AGENT_URL_HOST_DETAIL)):
        validate_agent_url("http://smpl-station.example:8765")


# --------------------------------------------------------------------------
# refresh — synchronous /health
# --------------------------------------------------------------------------


def test_refresh_reads_health_and_fills_the_hardware_rows(client: TestClient, admin_token: str, pi: FakeAgent) -> None:
    _, station = _addressed_station(client, admin_token)
    pi.routes[("GET", "/health")] = (200, HEALTH_OK)
    resp = client.post(f"/api/station/stations/{station['id']}/refresh", headers=auth_headers(admin_token))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert pi.paths() == ["/health"]
    assert str(pi.requests[0].url).startswith(PI_URL)
    assert body["status"] == "online"
    assert body["agent_version"] == "1.1.0"
    assert body["uptime_seconds"] == 4242
    assert body["session_count"] == 3
    assert body["hardware"]["printer_connected"] is True
    assert body["hardware"]["printer_model"] == "Brother PT-P710BT"
    assert body["hardware"]["scanner_present"] is True
    # The reply must not be able to move the address the api just called.
    assert body["host"] == "192.168.2.235" and body["port"] == 8765


def test_refresh_against_a_dead_pi_is_a_502_with_a_reason_that_sticks(
    client: TestClient, admin_token: str, pi: FakeAgent
) -> None:
    raw_token, station = _addressed_station(client, admin_token)

    def refuse(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    pi.routes[("GET", "/health")] = refuse
    resp = client.post(f"/api/station/stations/{station['id']}/refresh", headers=auth_headers(admin_token))
    assert resp.status_code == 502, resp.text
    assert resp.json()["detail"] == UNREACHABLE_DETAIL
    assert _listed(client, admin_token, station["id"])["agent_error"] == UNREACHABLE_DETAIL
    # The next heartbeat is the Pi saying "I am fine" — the reason goes away.
    _beat(client, raw_token, host="192.168.2.235", port=8765)
    assert _listed(client, admin_token, station["id"])["agent_error"] is None


def test_the_admin_override_wins_over_the_reported_address(client: TestClient, admin_token: str, pi: FakeAgent) -> None:
    _, station = _addressed_station(client, admin_token)
    client.patch(
        f"/api/station/stations/{station['id']}",
        headers=auth_headers(admin_token),
        json={"agent_url": "http://10.9.8.7:9000"},
    )
    pi.routes[("GET", "/health")] = (200, HEALTH_OK)
    client.post(f"/api/station/stations/{station['id']}/refresh", headers=auth_headers(admin_token))
    assert str(pi.requests[-1].url) == "http://10.9.8.7:9000/health"


@pytest.mark.parametrize(
    "reply",
    [
        lambda _r: httpx.Response(200, content=b"<html>not json</html>"),
        lambda _r: httpx.Response(200, json=["a", "list"]),
        lambda _r: httpx.Response(200, content=b"{" + b" " * (MAX_RESPONSE_BYTES + 1) + b"}"),
    ],
)
def test_a_reply_the_api_cannot_trust_is_a_502_not_a_500(
    client: TestClient, admin_token: str, pi: FakeAgent, reply
) -> None:
    _, station = _addressed_station(client, admin_token)
    pi.routes[("GET", "/health")] = reply
    resp = client.post(f"/api/station/stations/{station['id']}/refresh", headers=auth_headers(admin_token))
    assert resp.status_code == 502, resp.text


# --------------------------------------------------------------------------
# test print — on the Pi's own Brother
# --------------------------------------------------------------------------


def test_test_print_sends_the_label_and_reports_the_time(client: TestClient, admin_token: str, pi: FakeAgent) -> None:
    _, station = _addressed_station(client, admin_token)
    pi.routes[("POST", "/print")] = (200, {"ok": True, "ms_total": 2100, "simulated": False, "queued": False})
    resp = client.post(
        f"/api/station/stations/{station['id']}/test-print",
        headers=auth_headers(admin_token),
        json={"text": "Hallo Werkstatt"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True, "detail": "Testetikett gedruckt (2,1 s).", "ms": 2100}
    sent = pi.requests[-1]
    assert sent.url.path == "/print"
    assert PROOF_HEADER not in sent.headers  # the proof travels with /restart only
    body = httpx.Response(200, content=sent.content).json()
    assert body["code"] == "SMPL-TEST"
    assert body["title"] == "Hallo Werkstatt"
    assert body["subtitle"].startswith("Werkstatt Pi · ")


def test_test_print_defaults_its_text(client: TestClient, admin_token: str, pi: FakeAgent) -> None:
    _, station = _addressed_station(client, admin_token)
    # What a --no-printer agent really answers: simulated AND queued — the
    # simulated printer queues like the real one, in ~10 ms.
    pi.routes[("POST", "/print")] = (200, {"ok": True, "ms_total": 11, "simulated": True, "queued": True})
    resp = client.post(f"/api/station/stations/{station['id']}/test-print", headers=auth_headers(admin_token), json={})
    assert resp.status_code == 200, resp.text
    assert resp.json()["ok"] is True
    assert resp.json()["detail"] == TEST_PRINT_SIMULATED_DETAIL
    assert "eingereiht" not in resp.json()["detail"]
    assert httpx.Response(200, content=pi.requests[-1].content).json()["title"] == "SMPL Testetikett"


def test_test_print_on_a_connected_printer_is_queued_and_says_so(
    client: TestClient, admin_token: str, pi: FakeAgent
) -> None:
    """The real agent queues and answers in milliseconds; the label feeds a
    few seconds later. "Eingereiht" is the truthful sentence, not "gedruckt"."""
    _, station = _addressed_station(client, admin_token)
    pi.routes[("POST", "/print")] = (
        200, {"ok": True, "ms_total": 14, "simulated": False, "queued": True, "queue_depth": 1},
    )
    resp = client.post(f"/api/station/stations/{station['id']}/test-print", headers=auth_headers(admin_token), json={})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True, "detail": TEST_PRINT_QUEUED_DETAIL, "ms": 14}


# The sentence the agent's /print answers 503 with while the Brother is
# unplugged — ``PRINTER_NOT_FOUND_ERROR`` in tools/label_agent/server.py,
# refused before anything is queued. Kept verbatim so this test scripts what
# the agent actually sends, not a reply it never does.
AGENT_PRINTER_NOT_FOUND = "printer not found on USB (PT-P710BT unplugged or powered off?)"


def test_test_print_with_the_printer_unplugged_is_truthful_not_an_outage(
    client: TestClient, admin_token: str, pi: FakeAgent
) -> None:
    _, station = _addressed_station(client, admin_token)
    pi.routes[("POST", "/print")] = (503, {"ok": False, "error": AGENT_PRINTER_NOT_FOUND})
    resp = client.post(f"/api/station/stations/{station['id']}/test-print", headers=auth_headers(admin_token), json={})
    assert resp.status_code == 200, resp.text
    assert resp.json()["ok"] is False
    assert resp.json()["detail"] == AGENT_PRINTER_NOT_FOUND


# --------------------------------------------------------------------------
# restart — confirm + proof
# --------------------------------------------------------------------------


def test_restart_needs_confirm_and_carries_the_proof(client: TestClient, admin_token: str, pi: FakeAgent) -> None:
    raw_token, station = _addressed_station(client, admin_token)
    headers = auth_headers(admin_token)
    refused = client.post(f"/api/station/stations/{station['id']}/restart", headers=headers, json={"confirm": False})
    assert refused.status_code == 400
    assert refused.json()["detail"] == "Neustart nur mit confirm=true."
    assert pi.requests == []

    pi.routes[("POST", "/restart")] = (200, {"ok": True, "detail": "restarting"})
    resp = client.post(f"/api/station/stations/{station['id']}/restart", headers=headers, json={"confirm": True})
    assert resp.status_code == 200, resp.text
    assert resp.json()["ok"] is True
    assert resp.json()["detail"].startswith("Neustart ausgelöst")
    sent = pi.requests[-1]
    assert sent.url.path == "/restart"
    # sha256 of the token the Pi holds — exactly what the api stored, never the token.
    assert sent.headers[PROOF_HEADER] == hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    assert raw_token not in sent.headers[PROOF_HEADER]


def test_a_restart_the_agent_refuses_comes_back_as_its_own_words(
    client: TestClient, admin_token: str, pi: FakeAgent
) -> None:
    _, station = _addressed_station(client, admin_token)
    pi.routes[("POST", "/restart")] = (403, {"ok": False, "error": "restart proof missing or wrong"})
    resp = client.post(
        f"/api/station/stations/{station['id']}/restart", headers=auth_headers(admin_token), json={"confirm": True}
    )
    assert resp.status_code == 502
    assert resp.json()["detail"] == "restart proof missing or wrong"


# --------------------------------------------------------------------------
# sessions — list and import
# --------------------------------------------------------------------------


def _script_regal(pi: FakeAgent) -> None:
    pi.routes[("GET", "/sessions")] = (
        200,
        {"sessions": [{"name": "regal", "started_at": "2026-09-10T08:00:00Z", "status": "open",
                       "articles": 3, "total_qty": 5, "total_scans": 5,
                       "last_counted_at": "2026-09-10T08:12:00Z"}]},
    )
    pi.routes[("GET", "/session/regal")] = (200, REGAL_COUNTS)


def test_sessions_are_listed_imported_and_reimported_idempotently(
    client: TestClient, admin_token: str, pi: FakeAgent
) -> None:
    _, station = _addressed_station(client, admin_token)
    headers = auth_headers(admin_token)
    _script_regal(pi)
    sid = station["id"]

    listed = client.get(f"/api/station/stations/{sid}/sessions", headers=headers)
    assert listed.status_code == 200, listed.text
    assert listed.json()["ok"] is True
    (row,) = listed.json()["sessions"]
    assert row["name"] == "regal" and row["articles"] == 3 and row["total_qty"] == 5
    assert row["imported_at"] is None and row["imported_session_id"] is None
    assert _listed(client, admin_token, sid)["pending_count"] == 1

    imported = client.post(f"/api/station/stations/{sid}/sessions/regal/import", headers=headers, json={})
    assert imported.status_code == 200, imported.text
    result = imported.json()
    assert result["ok"] is True
    assert result["session_name"] == "Scan-Station Werkstatt Pi – regal"
    assert (result["imported"], result["updated"], result["skipped"]) == (2, 0, 1)
    assert result["unmatched"] == ["SMPL-000123"]
    assert result["detail"].startswith("2 Artikel übernommen, 0 aktualisiert → Inventur „Scan-Station Werkstatt Pi – regal“")
    assert "2 neu angelegt" in result["detail"]
    assert "1 mit Menge 0 übersprungen" in result["detail"]

    with SessionLocal() as db:
        inventory = db.get(WerkstattInventorySession, result["session_id"])
        assert inventory.status == "open"
        assert inventory.source_station_id == sid
        assert inventory.source_session_name == "regal"
        assert inventory.source_imported_at is not None

    (row,) = client.get(f"/api/station/stations/{sid}/sessions", headers=headers).json()["sessions"]
    assert row["imported_session_id"] == result["session_id"]
    assert row["imported_at"] is not None
    assert _listed(client, admin_token, sid)["pending_count"] == 0

    # Same export again: SET semantics, same inventory, nothing duplicated.
    again = client.post(f"/api/station/stations/{sid}/sessions/regal/import", headers=headers, json={}).json()
    assert again["session_id"] == result["session_id"]
    assert (again["imported"], again["updated"]) == (0, 2)
    detail = client.get(f"/api/werkstatt/inventory/sessions/{result['session_id']}", headers=headers).json()
    assert detail["counted_articles"] == 2
    assert detail["total_units"] == 5


def test_an_explicit_target_must_be_open_and_a_finalized_one_is_never_reused(
    client: TestClient, admin_token: str, pi: FakeAgent
) -> None:
    _, station = _addressed_station(client, admin_token)
    headers = auth_headers(admin_token)
    _script_regal(pi)
    sid = station["id"]

    target = client.post("/api/werkstatt/inventory/sessions", headers=headers, json={"name": "Inventur Q3"}).json()
    into = client.post(
        f"/api/station/stations/{sid}/sessions/regal/import", headers=headers, json={"target_session_id": target["id"]}
    )
    assert into.status_code == 200, into.text
    assert into.json()["session_id"] == target["id"]
    assert into.json()["session_name"] == "Inventur Q3"

    finalized = client.post(f"/api/werkstatt/inventory/sessions/{target['id']}/finalize", headers=headers)
    assert finalized.status_code == 200, finalized.text
    closed = client.post(
        f"/api/station/stations/{sid}/sessions/regal/import", headers=headers, json={"target_session_id": target["id"]}
    )
    assert closed.status_code == 409
    assert closed.json()["detail"] == SESSION_FINALIZED_DETAIL

    # Without a target, the finalized inventory is not reopened: a new one is.
    fresh = client.post(
        f"/api/station/stations/{sid}/sessions/regal/import", headers=headers, json={"create_session_name": "Nachzählung"}
    )
    assert fresh.status_code == 200, fresh.text
    assert fresh.json()["session_id"] != target["id"]
    assert fresh.json()["session_name"] == "Nachzählung"
    unknown = client.post(
        f"/api/station/stations/{sid}/sessions/regal/import", headers=headers, json={"target_session_id": 999_999}
    )
    assert unknown.status_code == 404


def test_a_reimport_lands_where_the_card_says_the_session_went(
    client: TestClient, admin_token: str, pi: FakeAgent
) -> None:
    """Tuesday: 'regal' imported with no target → inventory A. Wednesday: the
    admin picks the *older* open inventory B explicitly. Thursday: 'Erneut
    übernehmen' with the select on the default — the card says B, so the
    counts must go to B, not to A because A was *started* later."""
    _, station = _addressed_station(client, admin_token)
    headers = auth_headers(admin_token)
    _script_regal(pi)
    sid = station["id"]

    older = client.post("/api/werkstatt/inventory/sessions", headers=headers, json={"name": "Inventur alt"}).json()
    first = client.post(f"/api/station/stations/{sid}/sessions/regal/import", headers=headers, json={}).json()
    assert first["session_id"] != older["id"]
    into_older = client.post(
        f"/api/station/stations/{sid}/sessions/regal/import", headers=headers,
        json={"target_session_id": older["id"]},
    ).json()
    assert into_older["session_id"] == older["id"]

    now = utcnow()
    with SessionLocal() as db:
        a = db.get(WerkstattInventorySession, first["session_id"])
        b = db.get(WerkstattInventorySession, older["id"])
        # A was started after B but imported before it: the two sort keys disagree.
        a.started_at, a.source_imported_at = now - timedelta(hours=1), now - timedelta(hours=2)
        b.started_at, b.source_imported_at = now - timedelta(hours=3), now - timedelta(hours=1)
        # The shape a failed import leaves behind: linked to 'regal', open,
        # newest of all by started_at, never stamped. It must sort last.
        db.add(WerkstattInventorySession(
            name="abgebrochen", status="open", started_at=now,
            source_station_id=sid, source_session_name="regal", source_imported_at=None,
        ))
        db.add_all([a, b])
        db.commit()

    (row,) = client.get(f"/api/station/stations/{sid}/sessions", headers=headers).json()["sessions"]
    assert row["imported_session_id"] == older["id"]

    again = client.post(f"/api/station/stations/{sid}/sessions/regal/import", headers=headers, json={}).json()
    assert again["session_id"] == older["id"], "the re-import must land where the tag said it went"
    assert (again["imported"], again["updated"]) == (0, 2)
    (row,) = client.get(f"/api/station/stations/{sid}/sessions", headers=headers).json()["sessions"]
    assert row["imported_session_id"] == older["id"]


def test_a_session_past_the_row_cap_is_refused_out_loud_not_trimmed(
    client: TestClient, admin_token: str, pi: FakeAgent
) -> None:
    _, station = _addressed_station(client, admin_token)
    headers = auth_headers(admin_token)
    sid = station["id"]
    rows = [
        {"code": f"4011923{i:06d}", "item_name": f"Teil {i}", "counted_qty": 1, "scan_count": 1}
        for i in range(MAX_IMPORT_ROWS + 1)
    ]
    pi.routes[("GET", "/session/riesig")] = (200, {"session": "riesig", "status": "open", "counts": rows})
    resp = client.post(f"/api/station/stations/{sid}/sessions/riesig/import", headers=headers, json={})
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"] == TOO_MANY_ROWS_DETAIL
    assert "5000" in TOO_MANY_ROWS_DETAIL and "aufteilen" in TOO_MANY_ROWS_DETAIL
    with SessionLocal() as db:
        assert db.scalars(select(WerkstattInventorySession)).all() == [], "nothing may be half-imported"


def test_a_session_the_api_stops_reading_is_the_same_refusal_not_an_outage(
    client: TestClient, admin_token: str, pi: FakeAgent
) -> None:
    """A real row is ~160 bytes, so the client's byte cap is the same fact as
    the row cap in different units — and gets the same remedy, as a 409, not
    as a 502 that reads like the Pi being off."""
    _, station = _addressed_station(client, admin_token)
    headers = auth_headers(admin_token)
    sid = station["id"]
    row = b'{"code": "4011923456789", "item_name": "Schraube M6x40", "counted_qty": 3, "scan_count": 3}'
    rows_needed = MAX_RESPONSE_BYTES // len(row) + 2
    body = b'{"session": "riesig", "status": "open", "counts": [' + b",".join([row] * rows_needed) + b"]}"
    pi.routes[("GET", "/session/riesig")] = lambda _r: httpx.Response(200, content=body)
    resp = client.post(f"/api/station/stations/{sid}/sessions/riesig/import", headers=headers, json={})
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"] == SESSION_TOO_LARGE_DETAIL
    # The cap must hold MAX_IMPORT_ROWS realistic rows, or the row cap is decoration.
    assert MAX_RESPONSE_BYTES >= MAX_IMPORT_ROWS * 2 * len(row)
    with SessionLocal() as db:
        assert db.scalars(select(WerkstattInventorySession)).all() == []


def test_an_unknown_or_empty_pi_session_cannot_create_an_inventory(
    client: TestClient, admin_token: str, pi: FakeAgent
) -> None:
    _, station = _addressed_station(client, admin_token)
    headers = auth_headers(admin_token)
    sid = station["id"]
    pi.routes[("GET", "/session/ghost")] = (200, {"session": "ghost", "status": "new", "started_at": None, "counts": []})
    assert client.post(f"/api/station/stations/{sid}/sessions/ghost/import", headers=headers, json={}).status_code == 404
    pi.routes[("GET", "/session/leer")] = (200, {"session": "leer", "status": "open", "counts": []})
    empty = client.post(f"/api/station/stations/{sid}/sessions/leer/import", headers=headers, json={})
    assert empty.status_code == 409
    with SessionLocal() as db:
        assert db.scalars(select(WerkstattInventorySession)).all() == []


def test_session_names_are_validated_and_url_encoded(client: TestClient, admin_token: str, pi: FakeAgent) -> None:
    _, station = _addressed_station(client, admin_token)
    headers = auth_headers(admin_token)
    sid = station["id"]
    pi.routes[("GET", "/session/Regal links")] = (
        200, {"session": "Regal links", "status": "open", "counts": [{"code": "A1", "item_name": "Ding", "counted_qty": 1}]},
    )
    resp = client.post(f"/api/station/stations/{sid}/sessions/Regal%20links/import", headers=headers, json={})
    assert resp.status_code == 200, resp.text
    assert pi.requests[-1].url.raw_path == b"/session/Regal%20links"
    # A character outside the agent's own rule never reaches the wire.
    bad = client.post(f"/api/station/stations/{sid}/sessions/regal%3Bdrop/import", headers=headers, json={})
    assert bad.status_code == 400
    assert "Sitzungsname" in bad.json()["detail"]
    assert all(r.url.path != "/session/regal;drop" for r in pi.requests)


def test_a_dead_pi_makes_the_session_list_a_statement_not_a_5xx(
    client: TestClient, admin_token: str, pi: FakeAgent
) -> None:
    _, station = _addressed_station(client, admin_token)

    def refuse(_request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("no answer")

    pi.routes[("GET", "/sessions")] = refuse
    resp = client.get(f"/api/station/stations/{station['id']}/sessions", headers=auth_headers(admin_token))
    assert resp.status_code == 200
    assert resp.json() == {"sessions": [], "ok": False, "error": UNREACHABLE_DETAIL}


# --------------------------------------------------------------------------
# revoked, setup, permissions
# --------------------------------------------------------------------------


def test_a_revoked_station_answers_entkoppelt_everywhere(client: TestClient, admin_token: str, pi: FakeAgent) -> None:
    _, station = _addressed_station(client, admin_token)
    headers = auth_headers(admin_token)
    sid = station["id"]
    assert client.post(f"/api/station/stations/{sid}/revoke", headers=headers).status_code == 200
    for path, body in (
        (f"/api/station/stations/{sid}/refresh", None),
        (f"/api/station/stations/{sid}/test-print", {}),
        (f"/api/station/stations/{sid}/restart", {"confirm": True}),
        (f"/api/station/stations/{sid}/sessions/regal/import", {}),
    ):
        resp = client.post(path, headers=headers, json=body)
        assert resp.status_code == 409, (path, resp.text)
        assert resp.json()["detail"] == STATION_INACTIVE_DETAIL
    sessions = client.get(f"/api/station/stations/{sid}/sessions", headers=headers).json()
    assert sessions == {"sessions": [], "ok": False, "error": STATION_INACTIVE_DETAIL}
    assert pi.requests == []


def test_the_setup_script_is_the_documented_install_path(client: TestClient, admin_token: str) -> None:
    resp = client.get("/api/station/setup", headers=auth_headers(admin_token))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["base_url"]
    assert f"install-pi.sh --smpl-url {body['base_url']}" in body["script"]
    assert "server.py --pair" in body["script"]
    assert "git clone" in body["script"]
    assert "run.sh" not in body["script"]  # the stale path is gone


def test_admin_ops_refuse_anonymous_callers(client: TestClient) -> None:
    """No ``admin_token`` fixture on purpose: that login leaves a session
    cookie in the shared test client, after which "no headers" is the admin."""
    assert client.get("/api/station/setup").status_code == 401
    assert client.get("/api/station/stations/1/sessions").status_code == 401
    assert client.patch("/api/station/stations/1", json={"name": "x"}).status_code == 401
    assert client.post("/api/station/stations/1/restart", json={"confirm": True}).status_code == 401


def test_admin_ops_require_system_manage(client: TestClient, admin_token: str) -> None:
    _, station = _addressed_station(client, admin_token)
    sid = station["id"]
    employee = auth_headers(_employee_token(client, admin_token))
    assert client.get("/api/station/setup", headers=employee).status_code == 403
    assert client.patch(f"/api/station/stations/{sid}", headers=employee, json={"name": "x"}).status_code == 403
    assert client.post(f"/api/station/stations/{sid}/refresh", headers=employee).status_code == 403
    assert client.post(f"/api/station/stations/{sid}/test-print", headers=employee, json={}).status_code == 403
    assert client.post(f"/api/station/stations/{sid}/restart", headers=employee, json={"confirm": True}).status_code == 403
    assert client.get(f"/api/station/stations/{sid}/sessions", headers=employee).status_code == 403
    assert client.post(f"/api/station/stations/{sid}/sessions/regal/import", headers=employee, json={}).status_code == 403
