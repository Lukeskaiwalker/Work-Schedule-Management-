"""The Kalender-Abo: a user's subscription link and the feed behind it.

``/api/calendar/feed`` (signed in) manages the one subscription a user
has; ``/api/calendar/{token}/feed.ics`` is what the phone fetches, with
the token as its only credential — a calendar app cannot log in. The
token route therefore answers 404 to everything it does not recognise,
without saying why (unknown, rotated, deleted, user deactivated), and
never touches the session cookie or the CSRF rule: it is a GET with no
side effect beyond remembering the fetch.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.db import get_db
from app.core.deps import get_current_user
from app.models.entities import User
from app.schemas.calendar import CalendarFeedOut
from app.services import calendar_feed as feeds

router = APIRouter(prefix="/calendar", tags=["calendar"])


def _request_base_url(request: Request | None) -> str | None:
    if request is None:
        return None
    forwarded_host = (request.headers.get("x-forwarded-host") or "").split(",", 1)[0].strip()
    forwarded_proto = (request.headers.get("x-forwarded-proto") or "").split(",", 1)[0].strip()
    host = forwarded_host or request.headers.get("host") or request.url.hostname or ""
    if not host:
        return None
    scheme = forwarded_proto or request.url.scheme or "https"
    root_path = str(request.scope.get("root_path") or "").rstrip("/")
    return f"{scheme}://{host}{root_path}"


def public_base_url(request: Request | None) -> str:
    """The configured public URL, unless it is a localhost placeholder —
    then the address the request came in on (same rule as invite links)."""
    configured = (get_settings().app_public_url or "").strip().rstrip("/")
    local = not configured or "localhost" in configured.lower() or "127.0.0.1" in configured.lower()
    if configured and not local:
        return configured
    from_request = _request_base_url(request)
    if from_request:
        return from_request.rstrip("/")
    return configured or "https://localhost"


def uid_domain(base_url: str) -> str:
    host = base_url.split("://", 1)[-1].split("/", 1)[0].split(":", 1)[0]
    return host or "smpl.local"


@router.get("/feed", response_model=CalendarFeedOut | None)
def get_my_feed(
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CalendarFeedOut | None:
    feed = feeds.get_feed(db, current_user.id)
    if feed is None:
        return None
    return feeds.feed_out(feed, public_base_url(request))


@router.post("/feed", response_model=CalendarFeedOut)
def create_or_rotate_my_feed(
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CalendarFeedOut:
    """First call creates the subscription; every later call rotates the
    token, so the link pasted into a lost phone stops working."""
    feed = feeds.create_or_rotate_feed(db, current_user)
    db.commit()
    db.refresh(feed)
    return feeds.feed_out(feed, public_base_url(request))


@router.delete("/feed", status_code=204)
def delete_my_feed(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    feeds.delete_feed(db, current_user.id)
    db.commit()


@router.get("/{token}/feed.ics")
def fetch_feed(
    token: str,
    request: Request,
    db: Session = Depends(get_db),
) -> Response:
    resolved = feeds.resolve_feed(db, token)
    if resolved is None:
        raise HTTPException(status_code=404, detail="Not found")
    feed, user = resolved
    base = public_base_url(request)
    body = feeds.build_user_calendar(db, user, uid_domain=uid_domain(base))
    feeds.touch_fetch(db, feed, request.headers.get("user-agent"))
    return Response(
        content=body,
        media_type="text/calendar; charset=utf-8",
        headers={
            "Content-Disposition": 'inline; filename="smpl-kalender.ics"',
            "Cache-Control": "private, max-age=300",
        },
    )
