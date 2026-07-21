from __future__ import annotations

import pyotp
from fastapi.testclient import TestClient

from app.main import app

ADMIN_EMAIL = "admin@example.com"
ADMIN_PASSWORD = "ChangeMe123!"


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _enroll_and_enable(client: TestClient, token: str) -> tuple[str, list[str]]:
    """Enroll + verify MFA for the admin caller. Returns (secret, recovery_codes)."""
    enroll = client.post(
        "/api/auth/me/mfa/enroll", headers=_auth(token), json={"current_password": ADMIN_PASSWORD}
    )
    assert enroll.status_code == 200, enroll.text
    body = enroll.json()
    secret = body["secret"]
    assert body["otpauth_uri"].startswith("otpauth://totp/")
    assert body["qr_data_uri"].startswith("data:image/svg+xml;base64,")

    code = pyotp.TOTP(secret).now()
    verify = client.post("/api/auth/me/mfa/verify", headers=_auth(token), json={"code": code})
    assert verify.status_code == 200, verify.text
    recovery = verify.json()["recovery_codes"]
    assert verify.json()["mfa_enabled"] is True
    assert len(recovery) == 10
    return secret, recovery


def test_enroll_requires_password(client: TestClient, admin_token: str):
    # A session alone cannot start enrollment — the password is re-checked.
    wrong = client.post(
        "/api/auth/me/mfa/enroll", headers=_auth(admin_token), json={"current_password": "nope"}
    )
    assert wrong.status_code == 403
    me = client.get("/api/auth/me", headers=_auth(admin_token))
    assert me.json()["mfa_enabled"] is False


def test_enroll_requires_valid_code(client: TestClient, admin_token: str):
    enroll = client.post(
        "/api/auth/me/mfa/enroll", headers=_auth(admin_token), json={"current_password": ADMIN_PASSWORD}
    )
    assert enroll.status_code == 200
    # Wrong code does not enable MFA.
    bad = client.post("/api/auth/me/mfa/verify", headers=_auth(admin_token), json={"code": "000000"})
    assert bad.status_code == 400
    me = client.get("/api/auth/me", headers=_auth(admin_token))
    assert me.json()["mfa_enabled"] is False


def test_me_reports_mfa_enabled_after_verify(client: TestClient, admin_token: str):
    _enroll_and_enable(client, admin_token)
    me = client.get("/api/auth/me", headers=_auth(admin_token))
    assert me.status_code == 200
    assert me.json()["mfa_enabled"] is True


def test_login_becomes_two_step_when_mfa_enabled(client: TestClient, admin_token: str):
    secret, _ = _enroll_and_enable(client, admin_token)

    # Fresh client (no cookies) drives the interactive login flow.
    with TestClient(app) as c:
        step1 = c.post("/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
        assert step1.status_code == 200, step1.text
        assert step1.json() == {"mfa_required": True}
        # No session was issued yet.
        assert step1.headers.get("X-Access-Token") is None
        # The half-authenticated challenge cookie must not grant access.
        assert c.get("/api/auth/me").status_code == 401

        # Wrong code is rejected.
        bad = c.post("/api/auth/login/mfa", json={"code": "000000"})
        assert bad.status_code == 401

        # Correct code completes login and issues a session.
        code = pyotp.TOTP(secret).now()
        step2 = c.post("/api/auth/login/mfa", json={"code": code})
        assert step2.status_code == 200, step2.text
        assert step2.headers.get("X-Access-Token")
        assert step2.json()["email"] == ADMIN_EMAIL
        # Session now works.
        assert c.get("/api/auth/me").status_code == 200


def test_login_mfa_without_challenge_is_rejected(client: TestClient, admin_token: str):
    _enroll_and_enable(client, admin_token)
    with TestClient(app) as c:
        # No step-1, so no challenge cookie.
        resp = c.post("/api/auth/login/mfa", json={"code": "123456"})
        assert resp.status_code == 401


def test_recovery_code_logs_in_and_is_single_use(client: TestClient, admin_token: str):
    _secret, recovery = _enroll_and_enable(client, admin_token)
    one_code = recovery[0]

    with TestClient(app) as c:
        assert c.post("/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}).json() == {
            "mfa_required": True
        }
        ok = c.post("/api/auth/login/mfa", json={"code": one_code})
        assert ok.status_code == 200, ok.text
        assert ok.headers.get("X-Access-Token")

    # The same recovery code cannot be reused.
    with TestClient(app) as c2:
        c2.post("/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
        reused = c2.post("/api/auth/login/mfa", json={"code": one_code})
        assert reused.status_code == 401


def test_disable_requires_password_and_code(client: TestClient, admin_token: str):
    secret, _ = _enroll_and_enable(client, admin_token)

    # Wrong password → 403, MFA stays on.
    bad_pw = client.post(
        "/api/auth/me/mfa/disable",
        headers=_auth(admin_token),
        json={"current_password": "wrong-password", "code": pyotp.TOTP(secret).now()},
    )
    assert bad_pw.status_code == 403

    # Correct password + code → disabled.
    ok = client.post(
        "/api/auth/me/mfa/disable",
        headers=_auth(admin_token),
        json={"current_password": ADMIN_PASSWORD, "code": pyotp.TOTP(secret).now()},
    )
    assert ok.status_code == 200
    assert ok.json()["mfa_enabled"] is False
    # Login is single-step again.
    with TestClient(app) as c:
        direct = c.post("/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
        assert direct.headers.get("X-Access-Token")


def test_admin_reset_mfa_clears_second_factor(client: TestClient, admin_token: str):
    _enroll_and_enable(client, admin_token)
    me_id = client.get("/api/auth/me", headers=_auth(admin_token)).json()["id"]

    reset = client.post(f"/api/admin/users/{me_id}/reset-mfa", headers=_auth(admin_token))
    assert reset.status_code == 200, reset.text
    assert client.get("/api/auth/me", headers=_auth(admin_token)).json()["mfa_enabled"] is False
