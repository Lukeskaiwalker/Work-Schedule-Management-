"""A person's own station badge -- the DataMatrix they scan at the rack.

``/users/me/station-badge`` is for its owner: read it (minted the first time),
rotate it when it is lost. ``/admin/users/{id}/station-badge`` is the same for
whoever hands badges out, behind ``users:manage`` -- the person printing a
colleague's badge is not the person on it.

Every response carrying a code is ``Cache-Control: no-store``: the code is a
bearer identifier for the station, and a shared browser cache or a proxy
keeping a copy of it is how a badge leaks without anybody holding the card.

What the badge is FOR is in ``workflow_station_werkstatt.station_badge_scan``;
how it is made and recognised is ``services/station_badges``.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user, require_permission
from app.models.entities import StationBadge, User
from app.schemas.station import StationBadgeOut
from app.services import station_badges

router = APIRouter(tags=["station-badges"])


def _out(badge: StationBadge, user: User, response: Response) -> StationBadgeOut:
    response.headers["Cache-Control"] = "no-store"
    return StationBadgeOut(
        user_id=user.id,
        user_name=user.display_name,
        code=station_badges.badge_code(badge),
        created_at=badge.created_at,
        last_used_at=badge.last_used_at,
        use_count=int(badge.use_count or 0),
    )


def _user_or_404(db: Session, user_id: int) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@router.get("/users/me/station-badge", response_model=StationBadgeOut)
def my_station_badge(
    response: Response,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> StationBadgeOut:
    badge = station_badges.ensure_badge(db, current_user)
    db.commit()
    db.refresh(badge)
    return _out(badge, current_user, response)


@router.post("/users/me/station-badge/rotate", response_model=StationBadgeOut)
def rotate_my_station_badge(
    response: Response,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> StationBadgeOut:
    """A lost badge is retired by minting a new one: the old code stops at once."""
    badge = station_badges.rotate_badge(db, current_user)
    db.commit()
    db.refresh(badge)
    return _out(badge, current_user, response)


@router.get("/admin/users/{user_id}/station-badge", response_model=StationBadgeOut)
def user_station_badge(
    user_id: int,
    response: Response,
    _: User = Depends(require_permission("users:manage")),
    db: Session = Depends(get_db),
) -> StationBadgeOut:
    user = _user_or_404(db, user_id)
    badge = station_badges.ensure_badge(db, user)
    db.commit()
    db.refresh(badge)
    return _out(badge, user, response)


@router.post("/admin/users/{user_id}/station-badge/rotate", response_model=StationBadgeOut)
def rotate_user_station_badge(
    user_id: int,
    response: Response,
    _: User = Depends(require_permission("users:manage")),
    db: Session = Depends(get_db),
) -> StationBadgeOut:
    user = _user_or_404(db, user_id)
    badge = station_badges.rotate_badge(db, user)
    db.commit()
    db.refresh(badge)
    return _out(badge, user, response)
