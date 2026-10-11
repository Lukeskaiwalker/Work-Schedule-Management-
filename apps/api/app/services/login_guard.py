"""The per-account login lockout, shared by every door that takes a password.

The login and WebDAV both check an account's main password; the MFA step
checks its second factor. A wrong guess through any of them is a failed login:
an ``auth.login_failed`` audit row against the account. Once enough of those
pile up inside the window, every door refuses the account, the right password
included, until the window has moved on. The count is keyed on the account,
not the address, so rotating addresses does not help, and it lives in the
database, so every api worker sees the same count.

WebDAV came to this late (2026-10-11): it checked the password on its own, so
its guesses were never counted and the lockout never stopped them.
"""

from __future__ import annotations

import logging

from fastapi import HTTPException, Request, status
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.security import get_password_hash
from app.services.audit import log_admin_action
from app.services.auth_alerts import _recent_failed_login_count_for_email

logger = logging.getLogger("smpl.auth_alerts")

LOCKED_OUT_DETAIL = "Too many failed attempts. Please try again later."

# audit_logs.target_id is VARCHAR(128). An identifier longer than that would
# make PostgreSQL refuse the failure row, and with it the lockout.
_TARGET_ID_MAX = 128

# A fixed bcrypt hash used to equalize response timing: even when the submitted
# account doesn't exist we run one verification against this, so an attacker
# can't distinguish "no such account" from "wrong password" by latency.
DUMMY_PASSWORD_HASH = get_password_hash("smpl-login-timing-equalization-not-a-real-password")


def audit_client_ip(request: Request | None) -> str | None:
    """Best-effort client IP for audit rows.
    Prefers X-Forwarded-For / X-Real-IP (set by the reverse proxy) over the
    direct peer — the Docker stack sits behind Caddy so the direct peer is
    usually the proxy container."""
    if request is None:
        return None
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",", 1)[0].strip()
    real_ip = request.headers.get("x-real-ip")
    if real_ip:
        return real_ip.strip()
    return request.client.host if request.client else None


def account_key(identifier: str) -> str:
    """The form an account is counted under: the e-mail, trimmed and lower-cased."""
    return (identifier or "").strip().lower()[:_TARGET_ID_MAX]


def login_locked_out(db: Session, account: str) -> bool:
    """True when this account has accumulated too many recent failed logins."""
    settings = get_settings()
    if not settings.login_lockout_enabled or not account:
        return False
    count = _recent_failed_login_count_for_email(
        db, email=account, window_seconds=settings.login_lockout_window_seconds
    )
    return count >= settings.login_lockout_threshold


def locked_out_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail=LOCKED_OUT_DETAIL,
        headers={"Retry-After": str(get_settings().login_lockout_window_seconds)},
    )


def record_failed_login(
    db: Session,
    *,
    account: str,
    reason: str,
    client_ip: str | None,
    user_agent: str,
    channel: str | None = None,
) -> None:
    """Write the ``auth.login_failed`` row the lockout counts, then let the
    brute-force alerting look at it.

    The row has no actor — the e-mail is preserved in details so admins can
    correlate brute-force patterns without naming a user that might not exist.
    ``channel`` names the door when it is not the login form.
    """
    details = {"email": account, "reason": reason, "ip": client_ip, "user_agent": user_agent}
    if channel:
        details["channel"] = channel
    log_admin_action(
        db,
        None,
        "auth.login_failed",
        "user",
        account or "(unknown)",
        details=details,
        category="auth",
    )
    # Run brute-force evaluation AFTER the audit row commits so the new
    # failure is included in the threshold count. The service is
    # feature-flagged off by default; when enabled it dispatches Telegram
    # / email alerts with audit-log-anchored dedup. Wrapped in a try/except
    # so the alert path can never turn a refused password into a 500 — the
    # worst case is a missed alert, not a broken login.
    try:
        from app.services.auth_alerts import evaluate_after_failed_login

        evaluate_after_failed_login(db, email=account, ip=client_ip or "")
    except Exception:  # noqa: BLE001 — diagnostic only, never crash login
        logger.exception("brute-force evaluator raised; ignored to keep login responsive")
