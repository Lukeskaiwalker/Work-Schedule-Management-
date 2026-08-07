from __future__ import annotations
import hashlib
import re
import secrets

from fastapi import APIRouter, Cookie, Depends, Header, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.db import get_db
from app.core.deps import get_current_user
from app.core.permissions import ALL_ROLES, get_user_effective_permissions, has_permission_for_user
from app.core.security import (
    MFA_CHALLENGE_PURPOSE,
    create_access_token,
    create_mfa_challenge_token,
    decode_token,
    get_password_hash,
    verify_password,
)
from app.core.time import utcnow
from app.models.entities import EmployeeGroup, EmployeeGroupMember, User, UserActionToken
from app.schemas.api import (
    InviteAccept,
    LoginRequest,
    NicknameAvailabilityOut,
    PasswordResetConfirm,
    ProfileUpdate,
    UserOut,
)
from app.schemas.user import (
    MfaCodeIn,
    MfaDisableIn,
    MfaEnrollIn,
    MfaEnrollOut,
    MfaLoginIn,
    MfaVerifyOut,
    UserMeOut,
)
from app.services import mfa
from app.services.audit import log_admin_action
from app.services.runtime_settings import mark_initial_admin_bootstrap_completed

# httpOnly cookie carrying the short-lived MFA challenge token between the two
# login steps. Never JS-readable; cleared once the session is issued.
_MFA_COOKIE = "mfa_challenge"
# Header carrying the same challenge, for clients whose origin makes the
# SameSite=Strict cookie unusable (the native iOS shell). Named in one place so
# the issuing side, the accepting side and CORS expose_headers cannot drift.
_MFA_CHALLENGE_HEADER = "X-Mfa-Challenge"

router = APIRouter(prefix="/auth", tags=["auth"])
settings = get_settings()
NICKNAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$")


def _can_update_recent_own_time_entries(db: Session, user_id: int) -> bool:
    return db.scalars(
        select(EmployeeGroup.id)
        .join(EmployeeGroupMember, EmployeeGroupMember.group_id == EmployeeGroup.id)
        .where(
            EmployeeGroupMember.user_id == user_id,
            EmployeeGroup.can_update_recent_own_time_entries.is_(True),
        )
        .limit(1)
    ).first() is not None


def _normalize_nickname(value: str | None) -> str:
    return (value or "").strip()


def _validate_nickname(value: str) -> str:
    nickname = _normalize_nickname(value)
    if not nickname:
        raise HTTPException(status_code=400, detail="Nickname is required")
    if not NICKNAME_PATTERN.fullmatch(nickname):
        raise HTTPException(
            status_code=400,
            detail="Nickname must be 3-32 characters and use letters, numbers, dot, underscore, or hyphen",
        )
    return nickname


def _nickname_normalized(value: str) -> str:
    return value.strip().lower()


def _client_ip(request: Request | None) -> str | None:
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


# A fixed bcrypt hash used to equalize login response timing: even when the
# submitted email doesn't exist we run one verification against this so an
# attacker can't distinguish "no such account" from "wrong password" by latency.
_DUMMY_PASSWORD_HASH = get_password_hash("smpl-login-timing-equalization-not-a-real-password")


def _login_locked_out(db: Session, email_normalized: str) -> bool:
    """True when this email has accumulated too many recent failed logins.

    Keyed on the target account so IP rotation can't bypass it. Reuses the
    ``auth.login_failed`` audit rows already written on every failure.
    """
    if not settings.login_lockout_enabled or not email_normalized:
        return False
    from app.services.auth_alerts import _recent_failed_login_count_for_email

    count = _recent_failed_login_count_for_email(
        db, email=email_normalized, window_seconds=settings.login_lockout_window_seconds
    )
    return count >= settings.login_lockout_threshold


def _issue_session(
    response: Response,
    db: Session,
    user: User,
    *,
    client_ip: str | None,
    user_agent: str,
) -> None:
    """Set the session + CSRF cookies (and the X-Access-Token header) and audit
    the login. Shared by the direct login path and the post-MFA login step."""
    token = create_access_token(str(user.id), extra={"role": user.role})
    response.set_cookie(
        "access_token",
        token,
        httponly=True,
        secure=settings.secure_cookies,
        samesite="strict",
        max_age=settings.access_token_expire_minutes * 60,
    )
    response.set_cookie(
        "csrf_token",
        secrets.token_urlsafe(24),
        httponly=False,
        secure=settings.secure_cookies,
        samesite="strict",
        max_age=settings.access_token_expire_minutes * 60,
    )
    response.headers["X-Access-Token"] = token
    # Drop any lingering MFA challenge cookie now that a real session exists.
    response.delete_cookie(_MFA_COOKIE)
    # Successful login — captured last so a commit failure earlier never
    # leaves a dangling "logged in" row with no actual session.
    log_admin_action(
        db,
        user,
        "auth.login",
        "user",
        str(user.id),
        details={
            "email": user.email,
            "role": user.role,
            "ip": client_ip,
            "user_agent": user_agent,
        },
        category="auth",
    )


@router.post("/login")
def login(
    payload: LoginRequest,
    response: Response,
    request: Request,
    db: Session = Depends(get_db),
):
    email_normalized = payload.email.strip().lower()
    client_ip = _client_ip(request)
    user_agent = request.headers.get("user-agent", "")[:255] if request else ""

    # Account lockout: block sustained password guessing against a single email
    # once too many recent failures have accumulated.
    if _login_locked_out(db, email_normalized):
        log_admin_action(
            db,
            None,
            "auth.login_locked",
            "user",
            email_normalized or "(unknown)",
            details={"email": email_normalized, "ip": client_ip, "user_agent": user_agent},
            category="auth",
        )
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many failed attempts. Please try again later.",
            headers={"Retry-After": str(settings.login_lockout_window_seconds)},
        )

    stmt = select(User).where(User.email == email_normalized)
    user = db.scalars(stmt).first()

    # Always run one bcrypt verification (a dummy hash when the email is unknown)
    # so response timing does not reveal whether the account exists.
    if user is not None:
        password_ok = verify_password(payload.password, user.password_hash)
    else:
        verify_password(payload.password, _DUMMY_PASSWORD_HASH)
        password_ok = False

    if user is None or not password_ok or not user.is_active:
        # Distinguish the reason for the audit trail only; the client always sees
        # an identical generic 401 so login can't be used to enumerate accounts.
        reason = "inactive" if (user is not None and password_ok and not user.is_active) else "invalid_credentials"
        # Record the attempt without an actor — email is preserved in details
        # so admins can correlate brute-force patterns without exposing
        # actor_user_id to a user that might not exist.
        log_admin_action(
            db,
            None,
            "auth.login_failed",
            "user",
            email_normalized or "(unknown)",
            details={
                "email": email_normalized,
                "reason": reason,
                "ip": client_ip,
                "user_agent": user_agent,
            },
            category="auth",
        )
        # Run brute-force evaluation AFTER the audit row commits so the new
        # failure is included in the threshold count. The service is
        # feature-flagged off by default; when enabled it dispatches Telegram
        # / email alerts with audit-log-anchored dedup. Wrapped in a try/except
        # so the alert path can never block a legitimate login response with
        # a 500 — the worst case is a missed alert, not a broken login.
        try:
            from app.services.auth_alerts import evaluate_after_failed_login

            evaluate_after_failed_login(db, email=email_normalized, ip=client_ip)
        except Exception:  # noqa: BLE001 — diagnostic only, never crash login
            import logging
            logging.getLogger("smpl.auth_alerts").exception(
                "brute-force evaluator raised; ignored to keep login responsive"
            )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    if user.mfa_enabled:
        # Password verified, but a second factor is required. Issue a short-lived
        # httpOnly challenge cookie (not a session) and stop; the client must
        # complete POST /auth/login/mfa with a valid code.
        challenge = create_mfa_challenge_token(str(user.id))
        response.set_cookie(
            _MFA_COOKIE,
            challenge,
            httponly=True,
            secure=settings.secure_cookies,
            samesite="strict",
            max_age=5 * 60,
        )
        # Mirror the challenge into a response header, exactly as _issue_session
        # does with X-Access-Token, so a client that cannot use the cookie can
        # still complete step two.
        #
        # The cookie is SameSite=Strict, so it is never attached to a request
        # from the native iOS shell, whose document origin (capacitor://localhost)
        # is cross-site to the server. Without this header the cookie is the only
        # link between the two login requests, and every account with MFA enabled
        # is simply unable to sign in on the phone — step one succeeds, the code
        # field appears, and a correct code returns "MFA challenge expired".
        #
        # Handing it back is no weaker than the cookie: same 5-minute lifetime,
        # same single purpose, and worthless without the TOTP code it gates.
        response.headers[_MFA_CHALLENGE_HEADER] = challenge
        log_admin_action(
            db,
            user,
            "auth.mfa_challenge",
            "user",
            str(user.id),
            details={"email": user.email, "ip": client_ip, "user_agent": user_agent},
            category="auth",
        )
        return {"mfa_required": True}

    _issue_session(response, db, user, client_ip=client_ip, user_agent=user_agent)
    return UserOut.model_validate(user)


@router.post("/login/mfa")
def login_mfa(
    payload: MfaLoginIn,
    response: Response,
    request: Request,
    db: Session = Depends(get_db),
    mfa_challenge: str | None = Cookie(default=None),
    x_mfa_challenge: str | None = Header(default=None),
):
    """Second login step: exchange the MFA challenge + a valid TOTP (or
    recovery) code for a real session.

    The challenge arrives either as the httpOnly cookie (browsers, same-site) or
    as the X-Mfa-Challenge header (the native shell, where a SameSite=Strict
    cookie is never sent). Cookie wins when both are present.
    """
    client_ip = _client_ip(request)
    user_agent = request.headers.get("user-agent", "")[:255] if request else ""

    token_payload = decode_token(mfa_challenge or x_mfa_challenge or "")
    if not token_payload or token_payload.get("purpose") != MFA_CHALLENGE_PURPOSE:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="MFA challenge expired")
    try:
        user_id = int(token_payload.get("sub"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="MFA challenge expired")

    user = db.get(User, user_id)
    if not user or not user.is_active or not user.mfa_enabled:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="MFA challenge expired")

    # Reuse the per-account lockout so the (small) 6-digit code space can't be
    # brute-forced under the cover of a valid challenge cookie.
    if _login_locked_out(db, user.email):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many failed attempts. Please try again later.",
            headers={"Retry-After": str(settings.login_lockout_window_seconds)},
        )

    secret = mfa.decrypt_secret(user.mfa_secret)
    code_ok = bool(secret) and mfa.verify_totp(secret, payload.code)
    recovery_remaining: list[str] | None = None
    if not code_ok:
        recovery_remaining = mfa.consume_recovery_code(user.mfa_recovery_codes, payload.code)
        code_ok = recovery_remaining is not None

    if not code_ok:
        log_admin_action(
            db,
            None,
            "auth.login_failed",
            "user",
            user.email,
            details={"email": user.email, "reason": "mfa_invalid", "ip": client_ip, "user_agent": user_agent},
            category="auth",
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid code")

    if recovery_remaining is not None:
        # A recovery code was spent — persist the shortened list.
        user.mfa_recovery_codes = recovery_remaining
        db.add(user)

    _issue_session(response, db, user, client_ip=client_ip, user_agent=user_agent)
    return UserOut.model_validate(user)


@router.post("/logout")
def logout(
    response: Response,
    request: Request,
    db: Session = Depends(get_db),
):
    """Clear cookies and, when the caller was authenticated, record the
    logout event. Keep this endpoint anonymous-safe — a browser with a
    stale/expired cookie calling /logout should still clear cleanly, so
    we can't hard-depend on get_current_user (which raises 401)."""
    # Try to resolve the caller so we can audit the event. Never raise
    # from this path — logout should always clear cookies.
    current_user: User | None = None
    try:
        from app.core.deps import get_current_user_from_token
        token = (
            request.cookies.get("access_token")
            or (request.headers.get("authorization") or "").removeprefix("Bearer ").strip()
        )
        if token:
            current_user = get_current_user_from_token(token, db)
    except Exception:  # pragma: no cover — best-effort audit only
        current_user = None

    response.delete_cookie("access_token")
    response.delete_cookie("csrf_token")
    if current_user is not None:
        log_admin_action(
            db,
            current_user,
            "auth.logout",
            "user",
            str(current_user.id),
            details={
                "email": current_user.email,
                "ip": _client_ip(request),
            },
            category="auth",
        )
    return {"ok": True}


@router.get("/me", response_model=UserMeOut)
def me(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    from app.routers.time_tracking import _vacation_balance_out

    out = UserMeOut.model_validate(current_user)
    vacation_balance = _vacation_balance_out(db, current_user)
    out.vacation_days_available = vacation_balance.vacation_days_available
    out.vacation_days_carryover = vacation_balance.vacation_days_carryover
    out.vacation_days_total_remaining = vacation_balance.vacation_days_total_remaining
    out.effective_permissions = get_user_effective_permissions(current_user.id, current_user.role)
    out.can_update_recent_own_time_entries = _can_update_recent_own_time_entries(db, current_user.id)
    return out


@router.get("/nickname-availability", response_model=NicknameAvailabilityOut)
def nickname_availability(
    nickname: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not has_permission_for_user(current_user.id, current_user.role, "users:manage"):
        raise HTTPException(status_code=403, detail="Nickname management denied")

    nickname_value = _validate_nickname(nickname)
    nickname_normalized = _nickname_normalized(nickname_value)

    exists = db.scalars(
        select(User.id).where(
            User.nickname_normalized == nickname_normalized,
            User.id != current_user.id,
        )
    ).first()
    return NicknameAvailabilityOut(
        nickname=nickname_value,
        available=exists is None,
        locked=False,
        reason=None if exists is None else "nickname_taken",
    )


def _token_hash(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def _consume_action_token(db: Session, *, raw_token: str, purpose: str) -> tuple[User, UserActionToken]:
    token_value = (raw_token or "").strip()
    if not token_value:
        raise HTTPException(status_code=400, detail="Token is required")
    now = utcnow()
    token_row = db.scalars(
        select(UserActionToken).where(
            UserActionToken.purpose == purpose,
            UserActionToken.token_hash == _token_hash(token_value),
        )
    ).first()
    if not token_row or token_row.used_at is not None:
        raise HTTPException(status_code=400, detail="Token is invalid or already used")
    if token_row.expires_at < now:
        raise HTTPException(status_code=400, detail="Token expired")

    user = db.get(User, token_row.user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    token_row.used_at = now
    db.add(token_row)
    return user, token_row


@router.patch("/me", response_model=UserOut)
def update_profile(
    payload: ProfileUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    original_email = current_user.email
    initial_admin_email = settings.initial_admin_email.strip().lower()
    incoming_name = payload.full_name.strip() if payload.full_name is not None else None
    incoming_email = payload.email.strip().lower() if payload.email is not None else None
    incoming_nickname = _normalize_nickname(payload.nickname) if payload.nickname is not None else None
    requires_password_check = incoming_email is not None or payload.new_password is not None
    if requires_password_check:
        if not payload.current_password or not verify_password(payload.current_password, current_user.password_hash):
            raise HTTPException(status_code=403, detail="Current password is required")

    if incoming_name is not None:
        if not incoming_name:
            raise HTTPException(status_code=400, detail="Full name is required")
        current_user.full_name = incoming_name

    if incoming_email is not None and incoming_email != current_user.email:
        exists = db.scalars(select(User).where(User.email == incoming_email, User.id != current_user.id)).first()
        if exists:
            raise HTTPException(status_code=409, detail="Email exists")
        current_user.email = incoming_email

    if incoming_nickname is not None:
        if not has_permission_for_user(current_user.id, current_user.role, "users:manage"):
            raise HTTPException(status_code=403, detail="Nickname management denied")
        if not incoming_nickname:
            current_user.nickname = None
            current_user.nickname_normalized = None
            current_user.nickname_set_at = None
        else:
            nickname_value = _validate_nickname(incoming_nickname)
            nickname_normalized = _nickname_normalized(nickname_value)
            exists = db.scalars(
                select(User.id).where(
                    User.nickname_normalized == nickname_normalized,
                    User.id != current_user.id,
                )
            ).first()
            if exists is not None:
                raise HTTPException(status_code=409, detail="Nickname not available")
            current_user.nickname = nickname_value
            current_user.nickname_normalized = nickname_normalized
            current_user.nickname_set_at = utcnow()

    if payload.new_password is not None:
        current_user.password_hash = get_password_hash(payload.new_password)

    changed_initial_admin_credentials = (
        original_email == initial_admin_email
        and (
            payload.new_password is not None
            or (incoming_email is not None and incoming_email != original_email)
        )
    )
    if changed_initial_admin_credentials:
        mark_initial_admin_bootstrap_completed(db)

    db.add(current_user)
    db.commit()
    db.refresh(current_user)
    return current_user


# Allowed preference keys and their valid values (None means any string is accepted)
_ALLOWED_PREFERENCES: dict[str, set[str] | None] = {
    "planning_mobile_view": {"single", "list", "scroll"},
}

# Preferences that accept a list of strings, each one from a closed set.
# Unknown entries in the list are dropped silently so older clients don't
# break when we add new filter types.
_ALLOWED_LIST_PREFERENCES: dict[str, set[str]] = {
    # Blacklist of map pin types the user has hidden. Empty list == all
    # visible (the default), so an empty/omitted value needs no migration
    # when new pin types are added later.
    "map_pin_filter_hidden": {"critical", "active", "planning", "on_hold", "completed", "archived"},
}


@router.patch("/me/preferences", response_model=UserOut)
def update_preferences(
    payload: dict,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Merge-patch the current user's UI preferences.

    Only known keys are accepted; unknown keys are silently ignored.
    Each key may also have a restricted set of valid values.
    """
    current: dict = dict(current_user.preferences or {})
    for key, value in payload.items():
        if key in _ALLOWED_LIST_PREFERENCES:
            if value is None:
                # Null clears the preference back to default ("all visible")
                current.pop(key, None)
                continue
            if not isinstance(value, list):
                raise HTTPException(
                    status_code=400,
                    detail=f"Preference '{key}' must be a list",
                )
            allowed = _ALLOWED_LIST_PREFERENCES[key]
            # Drop unknown entries (forwards compatibility) and dedupe
            # while preserving order.
            seen: set[str] = set()
            cleaned: list[str] = []
            for item in value:
                if not isinstance(item, str):
                    continue
                if item in allowed and item not in seen:
                    cleaned.append(item)
                    seen.add(item)
            current[key] = cleaned
            continue
        if key not in _ALLOWED_PREFERENCES:
            continue
        allowed_values = _ALLOWED_PREFERENCES[key]
        if allowed_values is not None and value not in allowed_values:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid value {value!r} for preference '{key}'",
            )
        current[key] = value

    current_user.preferences = current
    db.add(current_user)
    db.commit()
    db.refresh(current_user)
    return current_user


@router.post("/invites/accept", response_model=UserOut)
def accept_invite(payload: InviteAccept, db: Session = Depends(get_db)):
    user, _ = _consume_action_token(db, raw_token=payload.token, purpose="invite")

    if payload.email is not None:
        next_email = payload.email.strip().lower()
        if next_email != user.email:
            exists = db.scalars(select(User).where(User.email == next_email, User.id != user.id)).first()
            if exists:
                raise HTTPException(status_code=409, detail="Email exists")
            user.email = next_email

    if payload.full_name is not None:
        name = payload.full_name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Full name is required")
        user.full_name = name

    user.password_hash = get_password_hash(payload.new_password)
    user.invite_accepted_at = utcnow()
    user.is_active = True
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.post("/password-reset/confirm")
def confirm_password_reset(payload: PasswordResetConfirm, db: Session = Depends(get_db)):
    user, _ = _consume_action_token(db, raw_token=payload.token, purpose="password_reset")
    user.password_hash = get_password_hash(payload.new_password)
    # A password reset must reset the password, not silently reactivate a
    # deliberately deactivated account. Only flip is_active for a genuinely
    # pending-invite user (invite sent but never accepted) — that is the invite
    # flow reusing the reset endpoint. Otherwise leave the account status alone.
    is_pending_invite = user.invite_sent_at is not None and user.invite_accepted_at is None
    if is_pending_invite:
        user.invite_accepted_at = utcnow()
        user.is_active = True
    db.add(user)
    db.commit()
    return {"ok": True, "user_id": user.id}


# ── Two-factor authentication management (self-service) ───────────────────────


@router.post("/me/mfa/enroll", response_model=MfaEnrollOut)
def mfa_enroll(
    payload: MfaEnrollIn,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Begin TOTP enrollment: mint a fresh secret (pending until a code is
    verified) and return the provisioning URI + QR."""
    # Re-check the password: enrolling a factor is credential-sensitive, so a
    # session alone (e.g. a stolen cookie) must not be able to plant an
    # attacker-controlled second factor on an account that has none yet.
    if not verify_password(payload.current_password, current_user.password_hash):
        raise HTTPException(status_code=403, detail="Current password is required")
    # Never overwrite an active secret — that would silently break the user's
    # working authenticator. Rotating requires an explicit disable (password +
    # code) first, so a hijacked session can't quietly swap the second factor.
    if current_user.mfa_enabled:
        raise HTTPException(status_code=400, detail="Disable two-factor authentication before re-enrolling")
    secret = mfa.generate_secret()
    current_user.mfa_secret = mfa.encrypt_secret(secret)
    current_user.mfa_enabled = False  # stays off until proven via /verify
    current_user.mfa_enrolled_at = None
    current_user.mfa_recovery_codes = None
    db.add(current_user)
    db.commit()
    uri = mfa.provisioning_uri(current_user.email, secret)
    return MfaEnrollOut(secret=secret, otpauth_uri=uri, qr_data_uri=mfa.qr_data_uri(uri))


@router.post("/me/mfa/verify", response_model=MfaVerifyOut)
def mfa_verify(
    payload: MfaCodeIn,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Confirm enrollment by proving a valid code; enables MFA and returns the
    one-time recovery codes (shown to the user exactly once)."""
    secret = mfa.decrypt_secret(current_user.mfa_secret)
    if not secret:
        raise HTTPException(status_code=400, detail="Start enrollment first")
    if not mfa.verify_totp(secret, payload.code):
        raise HTTPException(status_code=400, detail="Invalid code")
    plaintext, hashed = mfa.generate_recovery_codes()
    current_user.mfa_enabled = True
    current_user.mfa_enrolled_at = utcnow()
    current_user.mfa_recovery_codes = hashed
    db.add(current_user)
    db.commit()
    log_admin_action(
        db, current_user, "auth.mfa_enabled", "user", str(current_user.id),
        details={"email": current_user.email}, category="auth",
    )
    return MfaVerifyOut(ok=True, mfa_enabled=True, recovery_codes=plaintext)


@router.post("/me/mfa/disable", response_model=UserOut)
def mfa_disable(
    payload: MfaDisableIn,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Turn MFA off. Requires the current password AND a valid TOTP/recovery code
    so a hijacked session alone can't strip the second factor. A user who has
    lost their device uses the admin MFA-reset instead."""
    if not verify_password(payload.current_password, current_user.password_hash):
        raise HTTPException(status_code=403, detail="Current password is required")
    if not current_user.mfa_enabled:
        raise HTTPException(status_code=400, detail="MFA is not enabled")
    secret = mfa.decrypt_secret(current_user.mfa_secret)
    code_ok = bool(secret) and mfa.verify_totp(secret, payload.code)
    if not code_ok:
        code_ok = mfa.consume_recovery_code(current_user.mfa_recovery_codes, payload.code) is not None
    if not code_ok:
        raise HTTPException(status_code=400, detail="Invalid code")
    current_user.mfa_enabled = False
    current_user.mfa_secret = None
    current_user.mfa_enrolled_at = None
    current_user.mfa_recovery_codes = None
    db.add(current_user)
    db.commit()
    db.refresh(current_user)
    log_admin_action(
        db, current_user, "auth.mfa_disabled", "user", str(current_user.id),
        details={"email": current_user.email}, category="auth",
    )
    return UserOut.model_validate(current_user)


@router.get("/roles")
def roles(current_user: User = Depends(get_current_user)):
    return {"roles": ALL_ROLES}
