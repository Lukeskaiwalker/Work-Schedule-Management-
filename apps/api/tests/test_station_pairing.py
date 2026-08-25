"""Scan-station pairing — the OAuth 2.0 device authorization grant (RFC 8628).

The office Raspberry Pi has no keyboard worth typing a password on, so it is
granted a credential rather than given one: it shows a short code, an
administrator approves that code in the web UI, and the device collects a
long-lived token by polling. Everything pinned here is a property that, if it
broke, would turn an unauthenticated entry point into a real one:

  * an unapproved device gets *nothing* — no token, no data, no station row it
    can use;
  * the token is issued exactly once and never exists in the database in
    plaintext, so neither a second poll nor a database dump yields a working
    credential;
  * a revoke bites on the device's very next request, with no cache to wait
    for and no window in which the old token still works;
  * codes expire, are single-use, and polling one that is still pending is
    throttled.
"""

from __future__ import annotations

import hashlib
import re
from datetime import timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.core.time import utcnow
from app.models.entities import Station, StationPairing


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def _start(client: TestClient, **payload) -> dict:
    resp = client.post("/api/station/pair/start", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _approve(client: TestClient, admin_token: str, code: str, name: str = "Werkstatt Pi", **extra) -> dict:
    body: dict = {"user_code": code, "name": name, **extra}
    resp = client.post("/api/station/pair/approve", headers=auth_headers(admin_token), json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _poll(client: TestClient, device_token: str) -> tuple[int, dict]:
    resp = client.post("/api/station/pair/poll", json={"device_token": device_token})
    return resp.status_code, resp.json()


def _paired_station(client: TestClient, admin_token: str, name: str = "Werkstatt Pi") -> tuple[str, dict]:
    """Run the whole grant and return (raw station token, station payload)."""
    started = _start(client, device_hint="scanpi-01", agent_version="1.0.0")
    _approve(client, admin_token, started["user_code"], name=name)
    status, body = _poll(client, started["device_token"])
    assert status == 200, body
    assert body["status"] == "approved", body
    return body["token"], body["station"]


def _employee_token(client: TestClient, admin_token: str, email: str = "monteur@example.com") -> str:
    created = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={"email": email, "password": "Password123!", "full_name": "Monteur", "role": "employee"},
    )
    assert created.status_code == 200, created.text
    login = client.post("/api/auth/login", json={"email": email, "password": "Password123!"})
    assert login.status_code == 200, login.text
    return login.headers["X-Access-Token"]


def _expire_pairing(user_code: str) -> None:
    with SessionLocal() as db:
        row = db.scalars(select(StationPairing).where(StationPairing.user_code == user_code)).first()
        assert row is not None
        row.expires_at = utcnow() - timedelta(seconds=1)
        db.add(row)
        db.commit()


# --------------------------------------------------------------------------
# the happy path, end to end
# --------------------------------------------------------------------------


def test_pair_approve_poll_then_authenticated_call(client: TestClient, admin_token: str) -> None:
    """The whole grant: the device asks, a human approves, the device collects
    a token and uses it — and at no point does anything on the device handle a
    password."""

    started = _start(client, device_hint="scanpi-01", agent_version="1.0.0")

    # A short code a human can read off a screen, from an alphabet with no
    # 0/O, 1/I/L or U in it.
    assert re.fullmatch(r"[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}", started["user_code"]), started
    assert started["device_token"].startswith("smpl_pair_")
    assert started["expires_in"] == 600
    assert started["poll_interval"] == 5

    # The admin sees it waiting.
    pending = client.get("/api/station/pair/pending", headers=auth_headers(admin_token))
    assert pending.status_code == 200, pending.text
    codes = [row["user_code"] for row in pending.json()]
    assert started["user_code"] in codes
    row = next(r for r in pending.json() if r["user_code"] == started["user_code"])
    assert row["device_hint"] == "scanpi-01"
    assert row["status"] == "pending"
    assert 0 < row["expires_in"] <= 600

    # Approval — the step that replaces typing a password on the Pi. Note the
    # approving admin is NOT handed the token: only the device can collect it.
    approved = _approve(client, admin_token, started["user_code"], name="Werkstatt Pi")
    assert approved["status"] == "approved"
    assert "token" not in approved
    assert approved["station"]["name"] == "Werkstatt Pi"
    # Approved but not yet collected: the row exists, and cannot authenticate.
    assert approved["station"]["active"] is False

    status, body = _poll(client, started["device_token"])
    assert status == 200, body
    assert body["status"] == "approved"
    raw_token = body["token"]
    assert raw_token.startswith("smpl_station_")
    assert len(raw_token) > 40
    assert body["station"]["active"] is True
    assert body["station"]["prefix"] == raw_token[:20]

    # The code is gone from the approval list once handled.
    pending_after = client.get("/api/station/pair/pending", headers=auth_headers(admin_token))
    assert started["user_code"] not in [r["user_code"] for r in pending_after.json()]

    # And the token actually works.
    me = client.get("/api/station/me", headers=auth_headers(raw_token))
    assert me.status_code == 200, me.text
    assert me.json()["name"] == "Werkstatt Pi"
    assert me.json()["id"] == approved["station"]["id"]

    beat = client.post(
        "/api/station/heartbeat",
        headers=auth_headers(raw_token),
        json={
            "agent_version": "1.0.1",
            "printer_connected": True,
            "media_width_mm": 12,
            "status": {"scanner": "ok"},
        },
    )
    assert beat.status_code == 200, beat.text
    station = beat.json()["station"]
    assert station["agent_version"] == "1.0.1"
    assert station["hardware_status"]["printer_connected"] is True
    assert station["hardware_status"]["scanner"] == "ok"
    assert station["last_seen_at"] is not None

    listed = client.get("/api/station/stations", headers=auth_headers(admin_token))
    assert listed.status_code == 200, listed.text
    assert [s["id"] for s in listed.json()] == [approved["station"]["id"]]
    assert listed.json()[0]["last_seen_at"] is not None


def test_the_rfc_8628_spellings_are_accepted_on_both_ends(
    client: TestClient, admin_token: str
) -> None:
    """The device end of this handshake is a small stdlib client that had to be
    written against a guess. Emitting (and accepting) the standard's own field
    names — ``device_code``, ``interval`` — costs nothing and means a client
    coded to RFC 8628 works unmodified."""

    resp = client.post(
        "/api/station/pair/start",
        json={"device_name": "scanpi-01", "agent_version": "1.0.0", "client_id": "ignored"},
    )
    assert resp.status_code == 201, resp.text
    started = resp.json()
    assert started["device_code"] == started["device_token"]
    assert started["interval"] == started["poll_interval"] == 5

    # The unauthenticated hint survived under its alias, so the approving
    # admin sees which box is asking.
    pending = client.get("/api/station/pair/pending", headers=auth_headers(admin_token)).json()
    assert pending[0]["device_hint"] == "scanpi-01"
    assert pending[0]["agent_version"] == "1.0.0"

    _approve(client, admin_token, started["user_code"], name="RFC Pi")

    # And a client that polls with device_code gets its token.
    polled = client.post(
        "/api/station/pair/poll", json={"device_code": started["device_code"]}
    )
    assert polled.status_code == 200, polled.text
    assert polled.json()["status"] == "approved"
    assert polled.json()["token"].startswith("smpl_station_")


def test_the_admin_may_type_the_code_however_it_reads(client: TestClient, admin_token: str) -> None:
    """Codes are read off a screen and typed by hand. Lowercase, no dash and
    stray spaces all have to land on the same row, or the feature fails in the
    exact moment it is being used."""

    started = _start(client)
    typed = " " + started["user_code"].lower().replace("-", "") + " "
    approved = _approve(client, admin_token, typed, name="Büro Pi")
    assert approved["user_code"] == started["user_code"]


# --------------------------------------------------------------------------
# an unapproved device gets nothing
# --------------------------------------------------------------------------


def test_polling_before_approval_yields_only_pending(client: TestClient, admin_token: str) -> None:
    started = _start(client)

    status, body = _poll(client, started["device_token"])
    assert status == 200, body
    assert body["status"] == "pending"
    assert body["token"] is None
    assert body["station"] is None

    # Nothing has been created that could be used.
    stations = client.get("/api/station/stations", headers=auth_headers(admin_token))
    assert stations.json() == []


def test_polling_faster_than_the_interval_is_throttled(client: TestClient) -> None:
    """RFC 8628 ``slow_down``. Waiting is the one state a device can sit in
    indefinitely, so it is the state worth rate-limiting — an *approved*
    verdict is always delivered immediately (see the happy-path test, which
    polls twice inside a second)."""

    started = _start(client)
    first, _ = _poll(client, started["device_token"])
    assert first == 200

    resp = client.post("/api/station/pair/poll", json={"device_token": started["device_token"]})
    assert resp.status_code == 429, resp.text
    assert resp.json()["detail"] == "slow_down"
    assert resp.headers["Retry-After"] == "5"


def test_an_unknown_device_token_looks_exactly_like_an_expired_one(client: TestClient) -> None:
    """No oracle: a handle that never existed, one that was pruned and one that
    timed out all get the same answer, and the only sensible action for all
    three is the same — start over."""

    status, body = _poll(client, "smpl_pair_" + "x" * 43)
    assert status == 200, body
    assert body["status"] == "expired"
    assert body["token"] is None


def test_a_denied_pairing_tells_the_device_to_stop(client: TestClient, admin_token: str) -> None:
    started = _start(client)
    denied = client.post(
        "/api/station/pair/deny",
        headers=auth_headers(admin_token),
        json={"user_code": started["user_code"]},
    )
    assert denied.status_code == 200, denied.text

    status, body = _poll(client, started["device_token"])
    assert status == 200, body
    assert body["status"] == "denied"
    assert body["token"] is None
    assert client.get("/api/station/stations", headers=auth_headers(admin_token)).json() == []


# --------------------------------------------------------------------------
# expiry
# --------------------------------------------------------------------------


def test_an_expired_code_cannot_be_polled_or_approved(client: TestClient, admin_token: str) -> None:
    """Ten minutes, then the code is dead — including for an administrator who
    walks up to the screen an hour later and finds the code still displayed."""

    started = _start(client)
    _expire_pairing(started["user_code"])

    listed = client.get("/api/station/pair/pending", headers=auth_headers(admin_token))
    assert started["user_code"] not in [r["user_code"] for r in listed.json()]

    late = client.post(
        "/api/station/pair/approve",
        headers=auth_headers(admin_token),
        json={"user_code": started["user_code"], "name": "Too late"},
    )
    assert late.status_code == 410, late.text

    status, body = _poll(client, started["device_token"])
    assert status == 200, body
    assert body["status"] == "expired"
    assert body["token"] is None
    assert client.get("/api/station/stations", headers=auth_headers(admin_token)).json() == []


def test_an_approval_never_collected_leaves_nothing_usable(client: TestClient, admin_token: str) -> None:
    """Approval opens a second window. If the device never comes back for its
    token, the station row it would have owned must not sit there waiting to
    be claimed by whoever finds the device token later."""

    started = _start(client)
    approved = _approve(client, admin_token, started["user_code"])
    _expire_pairing(started["user_code"])

    status, body = _poll(client, started["device_token"])
    assert status == 200, body
    assert body["status"] == "expired"
    assert body["token"] is None

    stations = client.get("/api/station/stations", headers=auth_headers(admin_token)).json()
    assert [s["id"] for s in stations] == [approved["station"]["id"]]
    assert stations[0]["active"] is False
    assert stations[0]["revoked_at"] is not None


# --------------------------------------------------------------------------
# the token itself
# --------------------------------------------------------------------------


def test_the_token_is_issued_once_and_never_reissued(client: TestClient, admin_token: str) -> None:
    raw_token, _ = _paired_station(client, admin_token)

    # The device token that produced the credential is now spent.
    started = _start(client)
    _approve(client, admin_token, started["user_code"], name="Second Pi")
    first_status, first_body = _poll(client, started["device_token"])
    assert first_status == 200 and first_body["status"] == "approved"
    second_status, second_body = _poll(client, started["device_token"])
    assert second_status == 200, second_body
    assert second_body["status"] == "claimed"
    assert second_body["token"] is None
    assert raw_token != first_body["token"]


def test_the_token_is_stored_hashed_and_never_returned_again(
    client: TestClient, admin_token: str
) -> None:
    """A database dump must not be replayable against the API, and no later
    read of the station may reconstruct the credential."""

    raw_token, station = _paired_station(client, admin_token)
    expected_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()

    with SessionLocal() as db:
        row = db.get(Station, station["id"])
        assert row is not None
        assert row.token_hash == expected_hash
        assert raw_token not in row.token_hash
        # Only a display stub is kept, and it is a strict prefix of the token.
        assert row.prefix == raw_token[:20]
        assert len(row.prefix) < len(raw_token)
        # Nothing else on the row carries it either.
        assert all(
            raw_token not in str(value)
            for key, value in vars(row).items()
            if key != "_sa_instance_state"
        )
        pairing = db.scalars(select(StationPairing)).first()
        assert pairing is not None
        assert raw_token not in pairing.device_token_hash

    for path in ("/api/station/stations", "/api/station/pair/pending"):
        resp = client.get(path, headers=auth_headers(admin_token))
        assert raw_token not in resp.text

    me = client.get("/api/station/me", headers=auth_headers(raw_token))
    assert raw_token not in me.text
    assert me.json()["prefix"] == raw_token[:20]


def test_a_revoked_station_stops_working_on_its_very_next_call(
    client: TestClient, admin_token: str
) -> None:
    raw_token, station = _paired_station(client, admin_token)
    assert client.get("/api/station/me", headers=auth_headers(raw_token)).status_code == 200

    revoked = client.post(
        f"/api/station/stations/{station['id']}/revoke", headers=auth_headers(admin_token)
    )
    assert revoked.status_code == 200, revoked.text
    assert revoked.json()["revoked_at"] is not None
    assert revoked.json()["active"] is False

    assert client.get("/api/station/me", headers=auth_headers(raw_token)).status_code == 401
    beat = client.post(
        "/api/station/heartbeat", headers=auth_headers(raw_token), json={"printer_connected": True}
    )
    assert beat.status_code == 401, beat.text

    # Revoking is idempotent and keeps the row — it is the audit trail for
    # "when did we retire that Pi?", not a delete.
    again = client.delete(
        f"/api/station/stations/{station['id']}", headers=auth_headers(admin_token)
    )
    assert again.status_code == 204
    still_listed = client.get("/api/station/stations", headers=auth_headers(admin_token)).json()
    assert [s["id"] for s in still_listed] == [station["id"]]
    assert still_listed[0]["revoked_at"] == revoked.json()["revoked_at"]


def test_an_expired_station_token_says_so(client: TestClient, admin_token: str) -> None:
    """The legitimate device needs to learn it must be re-paired, which is why
    expiry is the one failure mode that does not hide behind 'invalid'."""

    raw_token, station = _paired_station(client, admin_token)
    with SessionLocal() as db:
        row = db.get(Station, station["id"])
        row.expires_at = utcnow() - timedelta(seconds=1)
        db.add(row)
        db.commit()

    resp = client.get("/api/station/me", headers=auth_headers(raw_token))
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Station token expired"


def test_the_default_station_token_lifetime_is_a_year_and_is_overridable(
    client: TestClient, admin_token: str
) -> None:
    started = _start(client)
    approved = _approve(client, admin_token, started["user_code"])
    with SessionLocal() as db:
        row = db.get(Station, approved["station"]["id"])
        assert row.expires_at is not None
        days = (row.expires_at - utcnow()).days
        assert 363 <= days <= 365

    other = _start(client)
    never = _approve(client, admin_token, other["user_code"], name="Forever Pi", expires_in_days=None)
    assert never["station"]["expires_at"] is None


# --------------------------------------------------------------------------
# station endpoints are not open, and are not user endpoints
# --------------------------------------------------------------------------


def test_station_endpoints_refuse_unauthenticated_callers(client: TestClient) -> None:
    assert client.get("/api/station/me").status_code == 401
    assert client.post("/api/station/heartbeat", json={}).status_code == 401
    # The administrative half is closed to anonymous callers too — only
    # /pair/start and /pair/poll are open, and neither reads anything.
    assert client.get("/api/station/pair/pending").status_code == 401
    assert client.get("/api/station/stations").status_code == 401
    assert (
        client.post(
            "/api/station/pair/approve", json={"user_code": "AAAA-2222", "name": "Ghost"}
        ).status_code
        == 401
    )
    assert client.get("/api/station/me", headers=auth_headers("nonsense")).status_code == 401
    bogus = client.get("/api/station/me", headers=auth_headers("smpl_station_" + "a" * 43))
    assert bogus.status_code == 401
    assert bogus.json()["detail"] == "Invalid station token"


def test_a_user_session_is_not_a_station_and_a_station_is_not_a_user(
    client: TestClient, admin_token: str
) -> None:
    """The two credential types are disjoint on purpose: a station is a
    device, and it must not inherit anybody's access to the rest of the API."""

    raw_token, _ = _paired_station(client, admin_token)

    # An admin's session cannot pose as a station …
    assert client.get("/api/station/me", headers=auth_headers(admin_token)).status_code == 401
    # … and the station token opens nothing outside /api/station.
    assert client.get("/api/auth/me", headers=auth_headers(raw_token)).status_code == 401
    assert (
        client.get("/api/station/stations", headers=auth_headers(raw_token)).status_code == 401
    )


def test_managing_stations_requires_system_manage(client: TestClient, admin_token: str) -> None:
    employee = _employee_token(client, admin_token)

    assert client.get("/api/station/pair/pending", headers=auth_headers(employee)).status_code == 403

    started = _start(client)
    denied = client.post(
        "/api/station/pair/approve",
        headers=auth_headers(employee),
        json={"user_code": started["user_code"], "name": "Sneaky Pi"},
    )
    assert denied.status_code == 403, denied.text

    assert client.get("/api/station/stations", headers=auth_headers(employee)).status_code == 403
    assert (
        client.post(
            "/api/station/stations/1/revoke", headers=auth_headers(employee)
        ).status_code
        == 403
    )

    # And the device still has nothing.
    status, body = _poll(client, started["device_token"])
    assert body["status"] == "pending"


# --------------------------------------------------------------------------
# approval is single-use and well-formed
# --------------------------------------------------------------------------


def test_a_code_can_only_be_approved_once(client: TestClient, admin_token: str) -> None:
    started = _start(client)
    _approve(client, admin_token, started["user_code"])

    twice = client.post(
        "/api/station/pair/approve",
        headers=auth_headers(admin_token),
        json={"user_code": started["user_code"], "name": "Duplicate"},
    )
    assert twice.status_code == 409, twice.text

    denied = client.post(
        "/api/station/pair/deny",
        headers=auth_headers(admin_token),
        json={"user_code": started["user_code"]},
    )
    assert denied.status_code == 409, denied.text


def test_approving_needs_a_real_code_and_a_name(client: TestClient, admin_token: str) -> None:
    unknown = client.post(
        "/api/station/pair/approve",
        headers=auth_headers(admin_token),
        json={"user_code": "AAAA-2222", "name": "Ghost"},
    )
    assert unknown.status_code == 404, unknown.text

    started = _start(client)
    nameless = client.post(
        "/api/station/pair/approve",
        headers=auth_headers(admin_token),
        json={"user_code": started["user_code"], "name": "   "},
    )
    assert nameless.status_code == 400, nameless.text

    no_identifier = client.post(
        "/api/station/pair/approve", headers=auth_headers(admin_token), json={"name": "Nameless"}
    )
    assert no_identifier.status_code == 400, no_identifier.text


def test_a_pairing_can_also_be_approved_by_id(client: TestClient, admin_token: str) -> None:
    """The pending list gives the admin a row to click, not a code to retype."""

    started = _start(client)
    pending = client.get("/api/station/pair/pending", headers=auth_headers(admin_token)).json()
    pairing_id = next(r["id"] for r in pending if r["user_code"] == started["user_code"])

    approved = client.post(
        "/api/station/pair/approve",
        headers=auth_headers(admin_token),
        json={"pairing_id": pairing_id, "name": "Clicked Pi"},
    )
    assert approved.status_code == 200, approved.text
    assert approved.json()["user_code"] == started["user_code"]


# --------------------------------------------------------------------------
# flood control on the unauthenticated entry point
# --------------------------------------------------------------------------


def test_one_source_cannot_fill_the_approval_list(client: TestClient, admin_token: str) -> None:
    """The pending list is a human's attention surface. A device that reboots
    repeatedly must keep working — so the oldest request from a source gives
    way to the newest rather than the newest being refused."""

    starts = [_start(client) for _ in range(6)]

    pending = client.get("/api/station/pair/pending", headers=auth_headers(admin_token)).json()
    assert len(pending) == 5
    live = {row["user_code"] for row in pending}
    assert starts[0]["user_code"] not in live
    assert {s["user_code"] for s in starts[1:]} == live

    # The evicted device is told to start over, not left polling forever.
    status, body = _poll(client, starts[0]["device_token"])
    assert status == 200 and body["status"] == "expired"

    # And the newest one still pairs normally.
    _approve(client, admin_token, starts[-1]["user_code"], name="Rebooted Pi")
    ok, body = _poll(client, starts[-1]["device_token"])
    assert ok == 200 and body["status"] == "approved"


def test_a_device_cannot_dump_arbitrary_data_into_its_status(
    client: TestClient, admin_token: str
) -> None:
    raw_token, _ = _paired_station(client, admin_token)
    huge = client.post(
        "/api/station/heartbeat",
        headers=auth_headers(raw_token),
        json={"status": {"blob": "x" * 5000}},
    )
    assert huge.status_code == 413, huge.text
