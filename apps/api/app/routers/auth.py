from __future__ import annotations
import hashlib
import re
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.db import get_db
from app.core.deps import get_current_user
from app.core.permissions import ALL_ROLES, get_user_effective_permissions, has_permission_for_user
from app.core.security import create_access_token, get_password_hash, verify_password
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
from app.schemas.user import UserMeOut
from app.services.audit import log_admin_action
from app.services.runtime_settings import mark_initial_admin_bootstrap_completed

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


@router.post("/login", response_model=UserOut)
def login(
    payload: LoginRequest,
    response: Response,
    request: Request,
    db: Session = Depends(get_db),
):
    email_normalized = payload.email.strip().lower()
    client_ip = _client_ip(request)
    user_agent = request.headers.get("user-agent", "")[:255] if request else ""

    stmt = select(User).where(User.email == email_normalized)
    user = db.scalars(stmt).first()
    if not user or not verify_password(payload.password, user.password_hash):
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
                "reason": "invalid_credentials",
                "ip": client_ip,
                "user_agent": user_agent,
            },
            category="auth",
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    if not user.is_active:
        log_admin_action(
            db,
            None,
            "auth.login_blocked",
            "user",
            str(user.id),
            details={
                "email": email_normalized,
                "reason": "inactive",
                "ip": client_ip,
                "user_agent": user_agent,
            },
            category="auth",
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Inactive user")

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
    return user


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
    if user.invite_sent_at is not None and user.invite_accepted_at is None:
        user.invite_accepted_at = utcnow()
    user.is_active = True
    db.add(user)
    db.commit()
    return {"ok": True, "user_id": user.id}


@router.get("/roles")
def roles(current_user: User = Depends(get_current_user)):
    return {"roles": ALL_ROLES}
