from __future__ import annotations

from fastapi import APIRouter

from app.routers.workflow_helpers import *  # noqa: F401,F403

router = APIRouter(prefix="", tags=["system"])


@router.get("/projects-overview")
def projects_overview(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project_stmt = select(Project)
    can_view_all = has_permission_for_user(current_user.id, current_user.role, "projects:view") or \
                   has_permission_for_user(current_user.id, current_user.role, "projects:manage")
    if not can_view_all:
        project_ids = db.scalars(select(ProjectMember.project_id).where(ProjectMember.user_id == current_user.id)).all()
        if not project_ids:
            return []
        project_stmt = project_stmt.where(Project.id.in_(project_ids))

    projects = db.scalars(project_stmt.order_by(Project.id.desc())).all()
    output = []
    for project in projects:
        total_open = db.scalar(
            select(func.count(Task.id)).where(Task.project_id == project.id, Task.status != "done")
        )
        total_sites = db.scalar(select(func.count(Site.id)).where(Site.project_id == project.id))
        output.append(
            {
                "project_id": project.id,
                "project_number": project.project_number,
                "name": project.name,
                "status": project.status,
                "last_updated_at": project.last_updated_at,
                "open_tasks": total_open or 0,
                "sites": total_sites or 0,
            }
        )
    return output

@router.get("/healthz")
def healthz(db: Session = Depends(get_db)):
    db.execute(select(1))
    return {"ok": True, "timestamp": utcnow().isoformat()}
