"""Who is calling the portal — shared by every ``/api/portal`` router.

``get_portal_context`` is the identity every portal endpoint starts from: a
partner login whose partner exists and is not archived. Office staff are
turned away (they have the office app, and the portal's 404-for-everything-
else rule would only confuse them). The fence in ``app.core.deps`` keeps
partner logins out of everything else; this keeps everyone else out of here.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user
from app.core.permissions import is_external_role
from app.models.entities import Partner, User
from app.services.partner_portal import partner_is_open


@dataclass(frozen=True)
class PortalContext:
    user: User
    partner: Partner


def get_portal_context(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PortalContext:
    if not is_external_role(current_user.role):
        raise HTTPException(status_code=403, detail="The partner portal is for partner logins")
    partner = db.get(Partner, current_user.partner_id) if current_user.partner_id else None
    if not partner_is_open(partner):
        # Archived partner (or none at all): the logins stay, the door closes.
        raise HTTPException(status_code=403, detail="Partner access is closed")
    return PortalContext(user=current_user, partner=partner)
