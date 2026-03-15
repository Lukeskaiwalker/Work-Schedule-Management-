from __future__ import annotations
from collections.abc import Generator
from typing import Callable

from fastapi import Cookie, Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.permissions import ROLE_ADMIN, has_global_project_access, has_permission_for_user  # noqa: F401 – also used by re-exports
from app.core.security import decode_token
from app.models.entities import ProjectMember, User


def _extract_bearer(authorization: str | None) -> str | None:
    if not authorization:
        return None
    if not authorization.lower().startswith("bearer "):
        return None
    return authorization.split(" ", 1)[1].strip()


def get_current_user(
    request: Request,
    db: Session = Depends(get_db),
    authorization: str | None = Header(default=None),
    x_csrf_token: str | None = Header(default=None),
    access_token: str | None = Cookie(default=None),
    csrf_token: str | None = Cookie(default=None),
) -> User:
    bearer_token = _extract_bearer(authorization)
    token = bearer_token or access_token
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    # CSRF check for cookie-authenticated mutating requests.
    if (
        bearer_token is None
        and access_token
        and request.method in {"POST", "PUT", "PATCH", "DELETE"}
        and (not csrf_token or not x_csrf_token or csrf_token != x_csrf_token)
    ):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="CSRF validation failed")

    payload = decode_token(token)
    if not payload or "sub" not in payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    user = db.get(User, int(payload["sub"]))
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Inactive user")
    return user


def require_permission(permission: str) -> Callable[[User], User]:
    def _checker(current_user: User = Depends(get_current_user)) -> User:
        if not has_permission_for_user(current_user.id, current_user.role, permission):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission denied")
        return current_user

    return _checker


def require_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role != ROLE_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required")
    return current_user


def assert_project_access(db: Session, user: User, project_id: int, manage_required: bool = False) -> None:
    # Use the live permission map so admin-UI role/user-level edits take effect immediately.
    if has_global_project_access(user.id, user.role, manage_required=manage_required):
        return

    # No broad project permission — check direct ProjectMember entry.
    stmt = select(ProjectMember).where(ProjectMember.project_id == project_id, ProjectMember.user_id == user.id)
    membership = db.scalars(stmt).first()
    if not membership:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Project access denied")
    if manage_required and not membership.can_manage:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Project manage access denied")


def db_session() -> Generator[Session, None, None]:
    yield from get_db()


def get_current_user_from_token(token: str, db: Session) -> User:
    """
    Validate a raw JWT string and return the active User.

    Used by the SSE endpoint where the token arrives via query parameter
    (EventSource does not support custom authorization headers).
    """
    payload = decode_token(token)
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid authentication token")

    raw_sub = payload.get("sub")
    try:
        user_id = int(raw_sub)
    except (TypeError, ValueError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid authentication token")

    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or inactive")
    return user
