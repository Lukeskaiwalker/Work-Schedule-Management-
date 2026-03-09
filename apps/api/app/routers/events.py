"""
events.py router - Server-Sent Events endpoint for live updates.

Clients connect with:
  new EventSource(`/api/events?token=${encodeURIComponent(token)}`)
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request
from sqlalchemy import select
from sse_starlette.sse import EventSourceResponse

from app.core.config import get_settings
from app.core.db import SessionLocal
from app.core.deps import get_current_user_from_token
from app.core.events import listen_for_events
from app.models.entities import ChatThread, Project, ProjectMember
from app.routers.workflow_helpers import _thread_visible_to_user

router = APIRouter()


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

    if not settings.database_url.startswith("postgres"):
        raise HTTPException(status_code=503, detail="Event stream requires PostgreSQL")

    db = SessionLocal()
    try:
        user = get_current_user_from_token(token, db)
        user_id = int(user.id)
        is_admin = user.role in {"admin", "ceo"}

        # Project visibility scope.
        project_ids: set[int] = set()
        if not is_admin:
            if user.role in {"planning"}:
                project_ids = set(db.execute(select(Project.id)).scalars().all())
            else:
                project_ids = set(
                    db.execute(
                        select(ProjectMember.project_id).where(ProjectMember.user_id == user_id)
                    )
                    .scalars()
                    .all()
                )

        # Thread visibility scope.
        thread_ids: set[int] = set()
        if not is_admin:
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

    return EventSourceResponse(
        event_generator(),
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
