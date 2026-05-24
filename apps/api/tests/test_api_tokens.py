"""v2.5.23 — Personal Access Token (PAT) flow tests.

Covers the full lifecycle:

* gate enforcement (mint requires api_access_enabled = true)
* mint returns a raw token exactly once; subsequent reads omit it
* the PAT successfully authenticates on a normal protected endpoint
  via the same ``get_current_user`` path the JWT uses
* PATs bypass CSRF (the whole point — agents have no cookie store)
* revoke is immediate and idempotent
* admin disabling api_access_enabled invalidates every PAT the user
  holds *without* having to delete the rows (re-enable restores access)
* expired tokens are rejected with the specific 401 reason
* malformed PATs and PATs not in the DB look the same (no probing)
* one user cannot revoke another user's token — 404, not 403, so we
  don't leak existence of someone else's token IDs
"""
from __future__ import annotations
from datetime import timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.core.time import utcnow
from app.models.entities import ApiToken, User


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_user(client: TestClient, admin_token: str, email: str = "agent@example.com") -> dict:
    response = client.post(
        "/api/admin/users",
        headers=_auth(admin_token),
        json={
            "email": email,
            "password": "Password123!",
            "full_name": "Agent User",
            "role": "employee",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def _login(client: TestClient, email: str = "agent@example.com") -> str:
    response = client.post("/api/auth/login", json={"email": email, "password": "Password123!"})
    assert response.status_code == 200, response.text
    return response.headers["X-Access-Token"]


def _enable_api_access(client: TestClient, admin_token: str, user_id: int) -> None:
    response = client.patch(
        f"/api/admin/users/{user_id}",
        headers=_auth(admin_token),
        json={"api_access_enabled": True},
    )
    assert response.status_code == 200, response.text
    assert response.json()["api_access_enabled"] is True


# ──────────────────── Gate enforcement ────────────────────


def test_mint_denied_when_api_access_disabled(client: TestClient, admin_token: str):
    _create_user(client, admin_token)
    jwt = _login(client)

    response = client.post(
        "/api/auth/api-tokens",
        headers=_auth(jwt),
        json={"name": "Planning agent"},
    )
    assert response.status_code == 403
    assert "API access" in response.json()["detail"]


def test_list_denied_when_api_access_disabled(client: TestClient, admin_token: str):
    _create_user(client, admin_token)
    jwt = _login(client)

    response = client.get("/api/auth/api-tokens", headers=_auth(jwt))
    assert response.status_code == 403


def test_admin_can_toggle_api_access(client: TestClient, admin_token: str):
    user = _create_user(client, admin_token)
    # Default is off.
    assert user["api_access_enabled"] is False

    _enable_api_access(client, admin_token, user["id"])

    # And can be turned off again.
    response = client.patch(
        f"/api/admin/users/{user['id']}",
        headers=_auth(admin_token),
        json={"api_access_enabled": False},
    )
    assert response.status_code == 200
    assert response.json()["api_access_enabled"] is False


# ──────────────────── Mint / list / revoke ────────────────────


def test_mint_returns_raw_token_once_then_hidden(client: TestClient, admin_token: str):
    user = _create_user(client, admin_token)
    _enable_api_access(client, admin_token, user["id"])
    jwt = _login(client)

    create = client.post(
        "/api/auth/api-tokens",
        headers=_auth(jwt),
        json={"name": "Planning agent"},
    )
    assert create.status_code == 201, create.text
    body = create.json()
    raw = body["token"]
    assert raw.startswith("smpl_pat_")
    assert len(raw) > 30
    assert body["name"] == "Planning agent"
    assert body["prefix"] == raw[:12]
    assert body["revoked_at"] is None

    # List view never includes the raw token.
    listing = client.get("/api/auth/api-tokens", headers=_auth(jwt))
    assert listing.status_code == 200
    rows = listing.json()
    assert len(rows) == 1
    assert "token" not in rows[0]
    assert rows[0]["prefix"] == body["prefix"]


def test_pat_authenticates_on_protected_endpoint(client: TestClient, admin_token: str):
    user = _create_user(client, admin_token)
    _enable_api_access(client, admin_token, user["id"])
    jwt = _login(client)

    create = client.post(
        "/api/auth/api-tokens",
        headers=_auth(jwt),
        json={"name": "Planning agent"},
    )
    raw_token = create.json()["token"]

    # The PAT should work on every endpoint that previously needed a JWT —
    # /api/auth/me is the canonical "who am I" check.
    me = client.get("/api/auth/me", headers=_auth(raw_token))
    assert me.status_code == 200
    assert me.json()["email"] == "agent@example.com"


def test_pat_bypasses_csrf_on_mutating_request(client: TestClient, admin_token: str):
    """The whole point of PATs is agents don't have a cookie/CSRF store."""
    user = _create_user(client, admin_token)
    _enable_api_access(client, admin_token, user["id"])
    jwt = _login(client)
    create = client.post(
        "/api/auth/api-tokens",
        headers=_auth(jwt),
        json={"name": "Planning agent"},
    )
    raw_token = create.json()["token"]

    # PATCH /me with PAT — no CSRF header/cookie. Must succeed.
    response = client.patch(
        "/api/auth/me",
        headers=_auth(raw_token),
        json={"full_name": "Renamed Agent"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["full_name"] == "Renamed Agent"


def test_revoke_is_immediate_and_idempotent(client: TestClient, admin_token: str):
    user = _create_user(client, admin_token)
    _enable_api_access(client, admin_token, user["id"])
    jwt = _login(client)

    create = client.post(
        "/api/auth/api-tokens",
        headers=_auth(jwt),
        json={"name": "Planning agent"},
    )
    raw_token = create.json()["token"]
    token_id = create.json()["id"]

    # Confirm it works before revoke.
    assert client.get("/api/auth/me", headers=_auth(raw_token)).status_code == 200

    # Revoke.
    revoke = client.delete(f"/api/auth/api-tokens/{token_id}", headers=_auth(jwt))
    assert revoke.status_code == 204

    # And immediately fails.
    blocked = client.get("/api/auth/me", headers=_auth(raw_token))
    assert blocked.status_code == 401

    # Idempotent — second revoke is still 204.
    revoke_again = client.delete(f"/api/auth/api-tokens/{token_id}", headers=_auth(jwt))
    assert revoke_again.status_code == 204


def test_admin_disabling_api_access_invalidates_existing_tokens(
    client: TestClient, admin_token: str
):
    """Critical security invariant: revoking access at the admin level
    must work even for tokens minted before the change. We don't delete
    the rows — re-enabling should restore them."""
    user = _create_user(client, admin_token)
    _enable_api_access(client, admin_token, user["id"])
    jwt = _login(client)

    raw_token = client.post(
        "/api/auth/api-tokens",
        headers=_auth(jwt),
        json={"name": "Planning agent"},
    ).json()["token"]

    # Works.
    assert client.get("/api/auth/me", headers=_auth(raw_token)).status_code == 200

    # Admin disables.
    client.patch(
        f"/api/admin/users/{user['id']}",
        headers=_auth(admin_token),
        json={"api_access_enabled": False},
    )

    # Token is now rejected with a clear 403 (not 401) — the legitimate
    # user needs to know to ask their admin, not assume their token is
    # corrupted.
    blocked = client.get("/api/auth/me", headers=_auth(raw_token))
    assert blocked.status_code == 403
    assert "API access" in blocked.json()["detail"]

    # Re-enable — the same token works again, without re-mint.
    client.patch(
        f"/api/admin/users/{user['id']}",
        headers=_auth(admin_token),
        json={"api_access_enabled": True},
    )
    assert client.get("/api/auth/me", headers=_auth(raw_token)).status_code == 200


# ──────────────────── Expiry & error handling ────────────────────


def test_expired_token_is_rejected_with_explicit_reason(client: TestClient, admin_token: str):
    user = _create_user(client, admin_token)
    _enable_api_access(client, admin_token, user["id"])
    jwt = _login(client)

    raw_token = client.post(
        "/api/auth/api-tokens",
        headers=_auth(jwt),
        json={"name": "Planning agent", "expires_in_days": 1},
    ).json()["token"]

    # Force expiry by reaching into the DB and back-dating the row. In
    # production this is just a clock advance; tests use a direct
    # update so we don't have to mock time.
    with SessionLocal() as db:
        token_row = db.scalars(select(ApiToken).where(ApiToken.user_id == user["id"])).first()
        assert token_row is not None
        token_row.expires_at = utcnow() - timedelta(minutes=1)
        db.add(token_row)
        db.commit()

    response = client.get("/api/auth/me", headers=_auth(raw_token))
    assert response.status_code == 401
    assert "expired" in response.json()["detail"].lower()


def test_unknown_token_indistinguishable_from_revoked(client: TestClient, admin_token: str):
    """No oracle for probing: every "not active" cause looks the same."""
    user = _create_user(client, admin_token)
    _enable_api_access(client, admin_token, user["id"])
    jwt = _login(client)

    raw_token = client.post(
        "/api/auth/api-tokens",
        headers=_auth(jwt),
        json={"name": "Planning agent"},
    ).json()["token"]
    token_id = client.get("/api/auth/api-tokens", headers=_auth(jwt)).json()[0]["id"]
    client.delete(f"/api/auth/api-tokens/{token_id}", headers=_auth(jwt))

    # Garbage token and revoked token both return the same generic 401.
    revoked_resp = client.get("/api/auth/me", headers=_auth(raw_token))
    garbage_resp = client.get(
        "/api/auth/me",
        headers=_auth("smpl_pat_garbage_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    )
    assert revoked_resp.status_code == 401
    assert garbage_resp.status_code == 401
    assert revoked_resp.json()["detail"] == garbage_resp.json()["detail"]


def test_cannot_revoke_another_users_token(client: TestClient, admin_token: str):
    """Cross-user revoke must look like the token doesn't exist — 404,
    not 403, so token-ID enumeration leaks nothing."""
    alice = _create_user(client, admin_token, email="alice@example.com")
    bob = _create_user(client, admin_token, email="bob@example.com")
    _enable_api_access(client, admin_token, alice["id"])
    _enable_api_access(client, admin_token, bob["id"])

    alice_jwt = _login(client, "alice@example.com")
    bob_jwt = _login(client, "bob@example.com")

    bob_token_id = client.post(
        "/api/auth/api-tokens",
        headers=_auth(bob_jwt),
        json={"name": "Bob's agent"},
    ).json()["id"]

    # Alice tries to revoke Bob's token.
    response = client.delete(f"/api/auth/api-tokens/{bob_token_id}", headers=_auth(alice_jwt))
    assert response.status_code == 404


def test_me_endpoint_exposes_api_access_enabled_flag(client: TestClient, admin_token: str):
    """The frontend uses the /me payload to decide whether to render the
    "API tokens" tab in settings."""
    user = _create_user(client, admin_token)
    jwt = _login(client)

    me = client.get("/api/auth/me", headers=_auth(jwt)).json()
    assert me["api_access_enabled"] is False

    _enable_api_access(client, admin_token, user["id"])
    me_after = client.get("/api/auth/me", headers=_auth(jwt)).json()
    assert me_after["api_access_enabled"] is True


def test_inactive_user_cannot_use_pat(client: TestClient, admin_token: str):
    """is_active=False is the broader account-disable. A PAT issued
    before deactivation must stop working immediately."""
    user = _create_user(client, admin_token)
    _enable_api_access(client, admin_token, user["id"])
    jwt = _login(client)
    raw_token = client.post(
        "/api/auth/api-tokens",
        headers=_auth(jwt),
        json={"name": "Planning agent"},
    ).json()["token"]

    # Deactivate via admin.
    client.patch(
        f"/api/admin/users/{user['id']}",
        headers=_auth(admin_token),
        json={"is_active": False},
    )

    # PAT no longer works.
    assert client.get("/api/auth/me", headers=_auth(raw_token)).status_code == 401
