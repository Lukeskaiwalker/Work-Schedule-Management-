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
    if not has_global_project_access(current_user.id, current_user.role):
        # v2.5.35 — membership UNION task-assigned projects, so an
        # employee assigned a task in a non-member project (e.g. an
        # imported one) still sees it in the overview list. Keeps this
        # list consistent with assert_project_access.
        from app.core.deps import task_assigned_project_ids

        project_ids = set(
            db.scalars(
                select(ProjectMember.project_id).where(ProjectMember.user_id == current_user.id)
            ).all()
        )
        project_ids |= task_assigned_project_ids(db, current_user.id)
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
