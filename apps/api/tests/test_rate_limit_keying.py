"""Rate-limit buckets: one per signed-in person, not one per office.

Production reaches the api through Caddy, and the office reaches Caddy through
hairpin NAT, so every desk arrives from the router's address (the office Pi's
heartbeats are recorded from 192.168.2.1). A purely per-address bucket made the
whole office one client: everybody with the Zeiterfassung open spent one shared
allowance, and whoever came next got "Too many requests". These tests pin the
keying that replaced it:

  * a request carrying a VALID session token -- the Bearer header or the
    access_token cookie -- is counted against its user, so two people behind
    one address have separate buckets, and a second tab or a fresh login
    shares the first one's;
  * a token that does not verify (garbage, a foreign key, alg "none", expired,
    the half-login MFA token) is counted against the address, so nobody can
    mint fresh buckets by inventing tokens;
  * PATs, the login endpoint and the station-pairing endpoints keep their own
    scopes and stay per address, exactly as before;
  * an address header counts only when it holds an IP address, and whatever it
    holds can never reach a person's bucket (``X-Real-Ip: user:1`` once did).

The clock is frozen and every ceiling is shrunk to CEILING, so nothing here
depends on how fast the suite runs.
"""

from __future__ import annotations

from collections.abc import Callable, Generator
from datetime import datetime, timedelta

import jwt
import pytest
from fastapi.testclient import TestClient

import app.main as main
from app.core.security import create_access_token, create_mfa_challenge_token, decode_token

CEILING = 3
FROZEN_NOW = datetime(2026, 10, 11, 9, 0, 0)
LIMITED = "Too many requests"


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_user(client: TestClient, admin_token: str, email: str) -> dict:
    response = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={"email": email, "password": "Password123!", "full_name": "Rate Limit", "role": "employee"},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _login(client: TestClient, email: str, password: str) -> str:
    response = client.post("/api/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    return response.headers["X-Access-Token"]


def _is_limited(response) -> bool:
    """The middleware's own 429, not a route's (the login lockout and the
    pairing ``slow_down`` also answer 429, with their own detail)."""
    return response.status_code == 429 and response.json().get("detail") == LIMITED


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> dict[str, datetime]:
    state = {"now": FROZEN_NOW}
    monkeypatch.setattr(main, "utcnow", lambda: state["now"])
    return state


@pytest.fixture
def people(client: TestClient, admin_token: str) -> dict[str, str]:
    """Two people in the same office: one address, two sessions."""
    _create_user(client, admin_token, "kollegin@example.com")
    employee_token = _login(client, "kollegin@example.com", "Password123!")
    # The logins above left the last session's cookie in the client's jar;
    # every test says explicitly which credential a request carries.
    client.cookies.clear()
    return {"admin": admin_token, "employee": employee_token}


@pytest.fixture
def small_ceilings(
    monkeypatch: pytest.MonkeyPatch, clock: dict[str, datetime], people: dict[str, str]
) -> Generator[None, None, None]:
    """Shrink every scope's ceiling to CEILING and start from empty buckets.

    Depends on ``people`` so the setup requests (user creation, logins) are
    spent before the buckets are emptied, not counted against the test.
    """
    original = main._rate_scope
    monkeypatch.setattr(main, "_rate_scope", lambda path, auth: (original(path, auth)[0], CEILING))
    main._rate_bucket.clear()
    yield
    main._rate_bucket.clear()


def _spend(send: Callable[[], object], times: int = CEILING) -> None:
    for attempt in range(times):
        response = send()
        assert not _is_limited(response), f"limited early, on request {attempt + 1}"


@pytest.mark.parametrize("path", ["/api/auth/me", "/api/time/current"])
def test_two_people_behind_one_address_do_not_share_a_bucket(
    client: TestClient, people: dict[str, str], small_ceilings: None, path: str
) -> None:
    _spend(lambda: client.get(path, headers=auth_headers(people["admin"])))
    assert _is_limited(client.get(path, headers=auth_headers(people["admin"])))

    # Same address, another person: a full allowance of her own.
    response = client.get(path, headers=auth_headers(people["employee"]))
    assert response.status_code == 200, response.text
    # And the address's own bucket (requests without a session) is untouched.
    assert client.get("/api").status_code == 200


def test_the_session_cookie_counts_like_the_header(
    client: TestClient, people: dict[str, str], small_ceilings: None
) -> None:
    client.cookies.set("access_token", people["admin"])
    _spend(lambda: client.get("/api/auth/me"))
    assert _is_limited(client.get("/api/auth/me"))
    # The header form of the same session is the same person, so the same bucket...
    assert _is_limited(client.get("/api/auth/me", headers=auth_headers(people["admin"])))
    # ...while a request whose header names someone else is hers, as it is for
    # get_current_user, which also prefers the header over the cookie.
    response = client.get("/api/auth/me", headers=auth_headers(people["employee"]))
    assert response.status_code == 200, response.text


def test_a_second_login_shares_the_first_logins_bucket(
    client: TestClient, people: dict[str, str], small_ceilings: None
) -> None:
    """A second tab, a second device or a re-login is the same person; a new
    token must not be a new allowance."""
    me = client.get("/api/auth/me", headers=auth_headers(people["admin"]))
    assert me.status_code == 200, me.text
    # Minted rather than logged in, so it cannot come out byte-identical to the
    # first token (two logins inside one second would) and pass by accident.
    second_session = create_access_token(subject=str(me.json()["id"]), extra={"iat": 1})
    assert second_session != people["admin"]
    _spend(lambda: client.get("/api/auth/me", headers=auth_headers(people["admin"])), CEILING - 1)
    assert _is_limited(client.get("/api/auth/me", headers=auth_headers(second_session)))


def test_tokens_that_do_not_verify_count_against_the_address(
    client: TestClient, people: dict[str, str], small_ceilings: None
) -> None:
    future = int((datetime.now() + timedelta(hours=1)).timestamp())
    forged = [
        "not-a-jwt-at-all",
        jwt.encode({"sub": "1", "exp": future}, "x" * 64, algorithm="HS256"),
        jwt.encode({"sub": "2", "exp": future}, None, algorithm="none"),
        create_access_token(subject="3", extra={"exp": 1}),
        create_mfa_challenge_token("1"),
        jwt.encode({"sub": "4", "exp": future}, "y" * 64, algorithm="HS256"),
    ]
    # Every forged token is a different "user" -- and all of them land in the
    # one bucket the address has.
    for index, token in enumerate(forged):
        limited = _is_limited(client.get("/api/auth/me", headers=auth_headers(token)))
        assert limited is (index >= CEILING), f"forged token {index}"
    # A garbage cookie is no different from a garbage header.
    client.cookies.set("access_token", "garbage")
    assert _is_limited(client.get("/api/auth/me"))
    client.cookies.clear()
    assert _is_limited(client.get("/api"))
    # A real session from the same address is unaffected.
    response = client.get("/api/auth/me", headers=auth_headers(people["employee"]))
    assert response.status_code == 200, response.text


@pytest.mark.parametrize("header", ["X-Real-Ip", "X-Forwarded-For"])
def test_an_address_header_cannot_spend_a_persons_bucket(
    client: TestClient, people: dict[str, str], small_ceilings: None, header: str
) -> None:
    """The address comes from a header the client can send itself whenever
    nothing in front of the api overwrites it (no Caddy, a site block that does
    not set it, the api reached directly). Whatever it holds must land in the
    address key space, never in a person's: "user:<id>" sent as an address
    would otherwise keep that person at 429 without any credentials."""
    admin_id = decode_token(people["admin"])["sub"]
    _spend(lambda: client.get("/api", headers={header: f"user:{admin_id}"}))
    response = client.get("/api/auth/me", headers=auth_headers(people["admin"]))
    assert response.status_code == 200, response.text


def test_address_headers_that_are_not_addresses_fall_back_to_the_peer(
    client: TestClient, people: dict[str, str], small_ceilings: None
) -> None:
    # Real addresses, as Caddy sets them, are separate clients...
    _spend(lambda: client.get("/api", headers={"X-Real-Ip": "203.0.113.7"}))
    assert _is_limited(client.get("/api", headers={"X-Real-Ip": "203.0.113.7"}))
    assert client.get("/api", headers={"X-Real-Ip": "203.0.113.8"}).status_code == 200
    # ...the same address spelt another way is the same client...
    _spend(lambda: client.get("/api", headers={"X-Real-Ip": "2001:db8::1"}))
    assert _is_limited(client.get("/api", headers={"X-Real-Ip": "2001:db8:0:0:0:0:0:1"}))
    # ...and anything that is not an address is not a client of its own: every
    # invented value is the peer, so inventing a new one buys nothing.
    for index, junk in enumerate(["nobody", "user:1", "", "999.1.1.1", "1.2.3.4:80"]):
        limited = _is_limited(client.get("/api", headers={"X-Real-Ip": junk, "X-Forwarded-For": junk}))
        assert limited is (index >= CEILING), f"junk address {junk!r}"
    assert _is_limited(client.get("/api"))


def test_one_person_hammering_is_still_limited_until_the_window_moves_on(
    client: TestClient, people: dict[str, str], small_ceilings: None, clock: dict[str, datetime]
) -> None:
    _spend(lambda: client.get("/api/auth/me", headers=auth_headers(people["employee"])))
    limited = client.get("/api/auth/me", headers=auth_headers(people["employee"]))
    assert _is_limited(limited)
    assert limited.headers.get("Retry-After") == "60"

    clock["now"] = FROZEN_NOW + timedelta(seconds=59)
    assert _is_limited(client.get("/api/auth/me", headers=auth_headers(people["employee"])))
    clock["now"] = FROZEN_NOW + timedelta(seconds=61)
    response = client.get("/api/auth/me", headers=auth_headers(people["employee"]))
    assert response.status_code == 200, response.text


def test_pats_keep_their_own_scope_per_address(
    client: TestClient, people: dict[str, str], small_ceilings: None
) -> None:
    """The limiter runs before auth and cannot afford a database lookup, so a
    PAT is recognised by its prefix alone and keeps the per-address PAT
    bucket it always had -- any two PAT strings from one address share it."""
    first_pat = "smpl_pat_" + "a" * 40
    second_pat = "smpl_pat_" + "b" * 40
    _spend(lambda: client.get("/api/auth/me", headers=auth_headers(first_pat)))
    assert _is_limited(client.get("/api/auth/me", headers=auth_headers(second_pat)))
    # Separate from the address's browser bucket and from every person's.
    assert client.get("/api").status_code == 200
    response = client.get("/api/auth/me", headers=auth_headers(people["admin"]))
    assert response.status_code == 200, response.text


def test_login_stays_per_address_even_when_a_session_is_presented(
    client: TestClient, people: dict[str, str], small_ceilings: None
) -> None:
    """The login ceiling is the credential-stuffing backstop: many accounts,
    a few tries each, from one source. A stolen or freshly issued session must
    not buy a stuffing run its own bucket."""

    def attempt(index: int, token: str):
        return client.post(
            "/api/auth/login",
            headers=auth_headers(token),
            json={"email": f"nobody-{index}@example.com", "password": "wrong-password"},
        )

    for index in range(CEILING):
        response = attempt(index, people["admin"])
        assert response.status_code == 401, response.text
    assert _is_limited(attempt(CEILING, people["employee"]))
    # The sessions themselves were never charged for it.
    response = client.get("/api/auth/me", headers=auth_headers(people["admin"]))
    assert response.status_code == 200, response.text


def test_station_pairing_stays_per_address_even_when_a_session_is_presented(
    client: TestClient, people: dict[str, str], small_ceilings: None
) -> None:
    def start(token: str):
        return client.post(
            "/api/station/pair/start",
            headers=auth_headers(token),
            json={"device_hint": "scanpi-01", "agent_version": "1.0.0"},
        )

    _spend(lambda: start(people["admin"]))
    assert _is_limited(start(people["employee"]))
