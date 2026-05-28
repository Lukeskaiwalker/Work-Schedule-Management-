from __future__ import annotations
import hashlib
from collections.abc import Generator
from typing import Callable

from fastapi import Cookie, Depends, Header, HTTPException, Request, status
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.permissions import ROLE_ADMIN, has_global_project_access, has_permission_for_user  # noqa: F401 – also used by re-exports
from app.core.security import decode_token
from app.core.time import utcnow
from app.models.entities import ApiToken, ProjectMember, Task, TaskAssignment, User

# Personal Access Tokens are emitted with this prefix so we can route
# the auth path cheaply (skip JWT decode, do DB lookup instead) without
# having to attempt-then-fall-back. Anything starting with this string
# is treated as a PAT.
API_TOKEN_PREFIX = "smpl_pat_"


def _extract_bearer(authorization: str | None) -> str | None:
    if not authorization:
        return None
    if not authorization.lower().startswith("bearer "):
        return None
    return authorization.split(" ", 1)[1].strip()


def _hash_api_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _resolve_api_token_user(db: Session, raw_token: str) -> User:
    """Look up the user behind a ``smpl_pat_*`` bearer token.

    Raises HTTPException with appropriate status codes; the caller (the
    main auth dependency) just propagates them. We deliberately return
    the same "Invalid token" message for every failure mode that doesn't
    leak information — a probing client should not be able to tell
    "token not in DB" apart from "token revoked" apart from "user
    suspended". Two exceptions where leaking is fine and useful:
      • 401 + "API token expired" — the legitimate owner needs to know
        to mint a new one
      • 403 + "API access disabled" — same, so they can ask the admin
    """
    token_row = db.scalars(
        select(ApiToken).where(ApiToken.token_hash == _hash_api_token(raw_token))
    ).first()
    if token_row is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    if token_row.revoked_at is not None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    now = utcnow()
    if token_row.expires_at is not None and token_row.expires_at <= now:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="API token expired")

    user = db.get(User, token_row.user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Inactive user")
    # Defence in depth: even if the token is otherwise valid, the
    # per-user API-access gate must still be ON. This is what makes
    # admin disablement immediate — no need to mass-revoke tokens.
    if not user.api_access_enabled:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="API access disabled for this user")

    # Best-effort last_used_at update. Done as a single UPDATE so we
    # don't load the row twice, and only when the timestamp would
    # actually change (>=1 minute since last update) — agents can burst
    # hundreds of requests per second and we don't want each one
    # writing back. Wrapped in a try/except so a hot row lock can never
    # break a legitimate request.
    try:
        if token_row.last_used_at is None or (now - token_row.last_used_at).total_seconds() >= 60:
            db.execute(
                update(ApiToken)
                .where(ApiToken.id == token_row.id)
                .values(last_used_at=now)
            )
            db.commit()
    except Exception:  # pragma: no cover — diagnostic only, never block auth
        db.rollback()

    return user


def get_current_user(
    request: Request,
    db: Session = Depends(get_db),
    authorization: str | None = Header(default=None),
    x_csrf_token: str | None = Header(default=None),
    access_token: str | None = Cookie(default=None),
    csrf_token: str | None = Cookie(default=None),
) -> User:
    bearer_token = _extract_bearer(authorization)

    # PAT path — recognised by prefix, validated against the api_tokens
    # table. PATs are bearer-only (Authorization header), never sent as
    # cookies, so CSRF protection doesn't apply — there's no
    # cross-origin browser context that could be tricked into using
    # them. Mark the request so middlewares (e.g. rate-limit scope) can
    # differentiate.
    if bearer_token and bearer_token.startswith(API_TOKEN_PREFIX):
        user = _resolve_api_token_user(db, bearer_token)
        request.state.auth_type = "api_token"
        return user

    token = bearer_token or access_token
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    # CSRF check for cookie-authenticated mutating requests. (Bearer
    # JWTs and PATs both bypass this — a browser can't attach a
    # third-party Authorization header to a victim's request, but it
    # CAN forward the victim's cookie.)
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
    request.state.auth_type = "session"
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
    if membership:
        if manage_required and not membership.can_manage:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Project manage access denied")
        return

    # v2.5.34 — task-assignment fallback for READ access.
    #
    # An employee assigned a task in a project must be able to open that
    # project, even without an explicit ProjectMember row. Before this,
    # the two notions of "connected to a project" were unlinked:
    # ProjectMember drove access control while TaskAssignment only drove
    # the My-Tasks list. The result was employees handed work they
    # literally could not open the project to do (observed on project
    # #155 / id 113: 5 employees with task assignments, zero members).
    #
    # This grants READ access only. Manage access still requires an
    # explicit membership with can_manage, so "doing work" never implies
    # "administering the project". Scoped to the read path; a
    # manage_required call with no membership still denies.
    if not manage_required and _user_has_task_in_project(db, user.id, project_id):
        return

    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Project access denied")


def _user_has_task_in_project(db: Session, user_id: int, project_id: int) -> bool:
    """True when the user is assigned at least one task in the project.

    Checks both assignment models the codebase carries:
      * ``task_assignments`` — the modern multi-assignee join table
      * ``tasks.assignee_id`` — the legacy single-assignee column, still
        populated on older rows and some import paths

    Each query is LIMIT 1 against an indexed column, so the fallback
    only costs a cheap existence check and only runs for users who
    failed both the global-permission and membership checks (i.e.
    employees).
    """
    assigned_via_join = db.scalars(
        select(TaskAssignment.id)
        .join(Task, Task.id == TaskAssignment.task_id)
        .where(Task.project_id == project_id, TaskAssignment.user_id == user_id)
        .limit(1)
    ).first()
    if assigned_via_join is not None:
        return True

    assigned_via_legacy = db.scalars(
        select(Task.id)
        .where(Task.project_id == project_id, Task.assignee_id == user_id)
        .limit(1)
    ).first()
    return assigned_via_legacy is not None


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
