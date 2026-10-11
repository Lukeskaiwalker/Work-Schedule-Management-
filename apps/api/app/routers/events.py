"""
events.py router - Server-Sent Events endpoint for live updates.

Clients connect with one of:
  new EventSource("/api/events")                     browsers: session cookie
  new EventSource(`/api/events?ticket=${ticket}`)    native shell: a ticket from
                                                     POST /api/events/ticket

Why not the JWT in the URL, as before: EventSource cannot send an
Authorization header, so ``?token=<session JWT>`` was the obvious way in —
and the query string is exactly what the proxy's and uvicorn's access logs
print. A dump of the production proxy log held 19 JWTs. The cookie puts
nothing in the URL; a ticket puts in something that is spent by the time
anyone could read it. docs/LOG_HYGIENE.md has the whole picture.

``?token=`` itself is gone (2026-10-11): it was kept only for the iOS shell,
which the owner confirmed is not in use. If the shell is ever rebuilt, its
bundle asks for tickets.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Cookie, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse

from app.core.config import get_settings
from app.core.db import SessionLocal, get_db
from app.core.deps import get_active_user_by_id, get_current_user, get_current_user_from_token
from app.core.permissions import has_global_project_access
from app.core.events import listen_for_events
from app.models.entities import ChatThread, Project, ProjectMember, User
from app.routers.workflow_helpers import _thread_visible_to_user
from app.schemas.events import EventStreamTicketOut
from app.services.event_stream_tickets import TICKET_TTL_SECONDS, issue_ticket, redeem_ticket

router = APIRouter()

# How long a browser waits before reconnecting to the non-PostgreSQL fallback
# stream, which ends right after its handshake. See the fallback below.
_FALLBACK_RECONNECT_MS = 5 * 60 * 1000


@router.post("/events/ticket", response_model=EventStreamTicketOut)
def create_event_stream_ticket(
    response: Response,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> EventStreamTicketOut:
    """A single-use ticket for one connection to /api/events, for a client
    that has no session cookie to open the stream with.

    Authenticated like any other call, so the partner-portal fence and the
    CSRF rule apply as usual; a partner login is refused here before it could
    ever reach the stream.
    """
    response.headers["Cache-Control"] = "no-store"
    return EventStreamTicketOut(ticket=issue_ticket(db, current_user), expires_in=TICKET_TTL_SECONDS)


def _resolve_stream_user(db: Session, *, ticket: str | None, cookie: str | None) -> User:
    """Who is opening the stream, from the first credential the request names.

    A ticket wins and does not fall back: a client that sends one chose it,
    and a spent ticket must fail even when the same browser also holds a
    cookie, or "single use" would mean nothing. Otherwise the session cookie.
    A ``?token=`` is not read at all (removed 2026-10-11, see the module
    docstring): a tab of an older bundle still sends one, and gets in through
    the cookie EventSource sends alongside it.
    """
    if ticket is not None:
        user_id = redeem_ticket(db, ticket)
        if user_id is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired stream ticket")
        return get_active_user_by_id(user_id, db)
    if not cookie:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return get_current_user_from_token(cookie, db)


@router.get("/events")
async def sse_events(
    request: Request,
    ticket: str | None = Query(default=None, description="Single-use ticket from POST /api/events/ticket"),
    access_token: str | None = Cookie(default=None),
) -> EventSourceResponse:
    """
    SSE stream endpoint.

    One long-lived HTTP connection per browser tab.
    """
    settings = get_settings()
    use_postgres_stream = settings.database_url.startswith("postgres")

    db = SessionLocal()
    try:
        user = _resolve_stream_user(db, ticket=ticket, cookie=access_token)
        user_id = int(user.id)
        is_admin = user.role in {"admin", "ceo"}

        project_ids: set[int] = set()
        thread_ids: set[int] = set()
        if use_postgres_stream and not is_admin:
            # Project visibility scope.
            if has_global_project_access(user.id, user.role):
                project_ids = set(db.execute(select(Project.id)).scalars().all())
            else:
                # v2.5.35 — membership UNION task-assigned projects so an
                # employee receives live events for projects they have a
                # task in, consistent with what they can open + see listed.
                from app.core.deps import task_assigned_project_ids

                project_ids = set(
                    db.execute(
                        select(ProjectMember.project_id).where(ProjectMember.user_id == user_id)
                    )
                    .scalars()
                    .all()
                )
                project_ids |= task_assigned_project_ids(db, user_id)

            # Thread visibility scope.
            threads = db.execute(select(ChatThread)).scalars().all()
            thread_ids = {thread.id for thread in threads if _thread_visible_to_user(db, user, thread)}

    except HTTPException:
        db.close()
        raise
    except Exception:
        db.close()
        raise HTTPException(status_code=500, detail="Failed to initialise event stream")
    else:
        db.close()

    async def event_generator():
        if use_postgres_stream:
            async for chunk in listen_for_events(
                database_url=settings.database_url,
                user_id=user_id,
                project_ids=project_ids,
                thread_ids=thread_ids,
                is_admin=is_admin,
            ):
                if await request.is_disconnected():
                    break
                yield chunk
            return

        # Test/local fallback for non-PostgreSQL environments.
        # Emit the handshake event and end the stream so TestClient requests
        # complete deterministically in SQLite-based test runs.
        #
        # The long `retry` is for a browser on such a run: an ended stream is
        # reconnected after the EventSource default of ~3 s, and every reconnect
        # makes the client refresh the whole open view (onReconnect). Nothing
        # is ever delivered here (notify is a no-op off PostgreSQL), so those
        # refreshes were pure load — on the Zeiterfassung they read as a
        # polling storm and tripped the rate limiter (2026-10-11).
        yield {"data": json.dumps({"type": "connected"}), "retry": _FALLBACK_RECONNECT_MS}

    return EventSourceResponse(
        event_generator(),
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
