"""Werkstatt Projekt-Bedarfe read-through.

Re-exposes the existing `/api/materials` endpoint under `/api/werkstatt/bedarfe`
so the FE can consistently use the Werkstatt namespace. No data duplication —
the underlying `ProjectMaterialNeed` rows remain the source of truth. The
legacy `/api/materials` route continues to serve the same data for now.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import case, select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user
from app.models.entities import (
    ConstructionReport,
    MaterialCatalogItem,
    ProjectMaterialNeed,
    User,
)
from app.routers.workflow_helpers import (
    _active_projects_visible_to_user,
    _project_material_need_out,
)
from app.schemas.materials import ProjectMaterialNeedOut

router = APIRouter(prefix="", tags=["werkstatt-desktop"])


@router.get("/bedarfe", response_model=list[ProjectMaterialNeedOut])
def list_werkstatt_bedarfe(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ProjectMaterialNeedOut]:
    """Return all active (non-completed) project material needs the caller can see."""
    visible_projects = _active_projects_visible_to_user(db, current_user)
    if not visible_projects:
        return []
    visible_project_ids = [project.id for project in visible_projects]
    projects_by_id = {project.id: project for project in visible_projects}
    status_rank = case(
        (ProjectMaterialNeed.status == "order", 0),
        (ProjectMaterialNeed.status == "on_the_way", 1),
        (ProjectMaterialNeed.status == "available", 2),
        (ProjectMaterialNeed.status == "completed", 3),
        else_=4,
    )
    rows = db.execute(
        select(ProjectMaterialNeed, ConstructionReport, MaterialCatalogItem)
        .outerjoin(
            ConstructionReport,
            ConstructionReport.id == ProjectMaterialNeed.construction_report_id,
        )
        .outerjoin(
            MaterialCatalogItem,
            MaterialCatalogItem.id == ProjectMaterialNeed.material_catalog_item_id,
        )
        .where(
            ProjectMaterialNeed.project_id.in_(visible_project_ids),
            ProjectMaterialNeed.status != "completed",
        )
        .order_by(
            status_rank.asc(),
            ProjectMaterialNeed.created_at.desc(),
            ProjectMaterialNeed.id.desc(),
        )
    ).all()
    result: list[ProjectMaterialNeedOut] = []
    for material_need, report, catalog_item in rows:
        project = projects_by_id.get(material_need.project_id)
        if project is None:
            continue
        result.append(
            _project_material_need_out(
                material_need,
                project=project,
                report=report,
                catalog_item=catalog_item,
            )
        )
    return result
