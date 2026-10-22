"""The cabinet's own plan endpoint: the "Aufbau" PDF (docs/PANEL_ENCLOSURE.md §7, §13).

Reading follows the plan's visibility like every plan route
(``_assert_readable``); the sheet carries nothing the plan detail does not.
The catalogue endpoints live in ``workflow_schaltplan_catalog``; the cabinet
findings ride on the plan detail itself.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user
from app.models.entities import User
from app.routers.workflow_helpers import _content_disposition
from app.routers.workflow_schaltplan import _assert_readable, _get_plan_or_404
from app.services import panel_enclosure_service

router = APIRouter(prefix="/schaltplan", tags=["schaltplan"])


@router.get("/panels/{plan_id}/aufbau/pdf")
def panel_aufbau_pdf(
    plan_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    """The cabinet front at 1:n with its modules and hints, then the Materialliste.
    409 for a board without a cabinet."""
    plan = _get_plan_or_404(db, plan_id)
    _assert_readable(db, current_user, plan)
    pdf = panel_enclosure_service.aufbau_pdf(db, plan)
    file_name = f"Aufbau_{plan.panel_number}_{datetime.now():%Y-%m-%d}.pdf".replace(" ", "_")
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": _content_disposition(file_name, inline=True)},
    )
