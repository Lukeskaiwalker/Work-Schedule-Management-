from __future__ import annotations
import hashlib
import re
import secrets

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.db import get_db
from app.core.deps import get_current_user
from app.core.permissions import ALL_ROLES, ROLE_ADMIN
from app.core.security import create_access_token, get_password_hash, verify_password
from app.core.time import utcnow
from app.models.entities import User, UserActionToken
from app.schemas.api import (
    InviteAccept,
    LoginRequest,
    NicknameAvailabilityOut,
    PasswordResetConfirm,
    ProfileUpdate,
    UserOut,
)
from app.services.runtime_settings import mark_initial_admin_bootstrap_completed

router = APIRouter(prefix="/auth", tags=["auth"])
settings = get_settings()
NICKNAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$")


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


@router.post("/login", response_model=UserOut)
def login(payload: LoginRequest, response: Response, db: Session = Depends(get_db)):
    stmt = select(User).where(User.email == payload.email.strip().lower())
    user = db.scalars(stmt).first()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    if not user.is_active:
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
    return user


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie("access_token")
    response.delete_cookie("csrf_token")
    return {"ok": True}


@router.get("/me", response_model=UserOut)
def me(current_user: User = Depends(get_current_user)):
    return current_user


@router.get("/nickname-availability", response_model=NicknameAvailabilityOut)
def nickname_availability(
    nickname: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.role != ROLE_ADMIN:
        raise HTTPException(status_code=403, detail="Only admins can set nicknames")

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
        if current_user.role != ROLE_ADMIN:
            raise HTTPException(status_code=403, detail="Only admins can set nicknames")
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
    user.is_active = True
    db.add(user)
    db.commit()
    return {"ok": True, "user_id": user.id}


@router.get("/roles")
def roles(current_user: User = Depends(get_current_user)):
    return {"roles": ALL_ROLES}
