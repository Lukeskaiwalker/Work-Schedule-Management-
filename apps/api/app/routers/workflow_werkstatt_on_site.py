"""Werkstatt — the full "Auf Baustelle" listing.

One endpoint, deliberately in its own file rather than appended to the desktop
composite: it is the uncapped counterpart to that router's
``/werkstatt/dashboard`` preview block, and keeping it separate means the
preview's limits stay where they belong (a dashboard card) instead of leaking
into a screen that must show everything.

Read access matches ``/werkstatt/dashboard``: any authenticated user. The same
project numbers and titles are already on the dashboard for every signed-in
user, and a narrower gate here would make the page silently disagree with the
``on_site_count`` KPI printed beside it.

That gate is also why the response carries no customer name and no site
address. Every other project read path scopes on membership
(``_projects_visible_to_user`` / ``require_project_access``), and membership is
broad by default precisely so that an admin can still remove one person from
one sensitive job and have it stick. Serving the customer and the street here
would walk around that on a screen that has no need for either.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user
from app.models.entities import User
from app.schemas.werkstatt_on_site import WerkstattOnSiteGroupOut
from app.services.werkstatt_on_site import list_on_site_groups

router = APIRouter(prefix="/werkstatt", tags=["werkstatt-desktop"])


@router.get("/on-site", response_model=list[WerkstattOnSiteGroupOut])
def list_on_site(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[WerkstattOnSiteGroupOut]:
    """Everything still checked out, grouped by building site.

    No limit and no pagination: the list is bounded by how much stock is out of
    the workshop at once (tens of rows in practice), and a page whose purpose is
    "is anything missing?" cannot answer it from a first page.
    """

    return list_on_site_groups(db)
