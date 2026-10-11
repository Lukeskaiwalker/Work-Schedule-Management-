"""
events.py router - Server-Sent Events endpoint for live updates.

Clients connect with:
  new EventSource(`/api/events?token=${encodeURIComponent(token)}`)
"""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Query, Request
from sqlalchemy import select
from sse_starlette.sse import EventSourceResponse

from app.core.config import get_settings
from app.core.db import SessionLocal
from app.core.deps import get_current_user_from_token
from app.core.permissions import has_global_project_access
from app.core.events import listen_for_events
from app.models.entities import ChatThread, Project, ProjectMember
from app.routers.workflow_helpers import _thread_visible_to_user

router = APIRouter()

# How long a browser waits before reconnecting to the non-PostgreSQL fallback
# stream, which ends right after its handshake. See the fallback below.
_FALLBACK_RECONNECT_MS = 5 * 60 * 1000


@router.get("/events")
async def sse_events(
    request: Request,
    token: str = Query(..., description="JWT access token"),
) -> EventSourceResponse:
    """
    SSE stream endpoint.

    One long-lived HTTP connection per browser tab.
    """
    settings = get_settings()
    use_postgres_stream = settings.database_url.startswith("postgres")

    db = SessionLocal()
    try:
        user = get_current_user_from_token(token, db)
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
