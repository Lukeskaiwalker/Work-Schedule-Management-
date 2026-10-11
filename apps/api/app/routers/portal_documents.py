"""Partner portal: opening a file from a project's ``Partnerportal`` folder.

The list of these files comes with the project and the task details
(``routers/portal.py``); this is the one route that serves their bytes.

A file is served only when all of these hold, and every other case is the
same 404 — a partner never learns that a file id exists:

* it is a project file (not a task's own file — those have their own route
  on the task),
* it sits in the project's ``Partnerportal`` folder or below,
* the partner sees that project (handed over, or one of their tasks is in it).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import register_portal_routes
from app.models.entities import Attachment
from app.routers.portal_common import PortalContext, get_portal_context
from app.routers.workflow_helpers import _attachment_http_response
from app.services.partner_portal import is_partner_folder, visible_project_ids

router = APIRouter(prefix="/portal", tags=["partner-portal"])


@router.get("/documents/{file_id}")
def portal_document(
    file_id: int,
    download: bool = Query(False),
    ctx: PortalContext = Depends(get_portal_context),
    db: Session = Depends(get_db),
):
    attachment = db.get(Attachment, file_id)
    if (
        attachment is None
        or attachment.project_id is None
        or attachment.task_id is not None
        or not is_partner_folder(attachment.folder_path)
        or attachment.project_id not in visible_project_ids(db, ctx.partner.id)
    ):
        raise HTTPException(status_code=404, detail="File not found")
    return _attachment_http_response(attachment, inline=not download)


# Last: these routes, and only these, open to partner logins (app.core.deps).
register_portal_routes(router.routes)
