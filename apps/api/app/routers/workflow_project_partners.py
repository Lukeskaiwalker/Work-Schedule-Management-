"""Projects handed to partners as a whole.

Included from ``workflow.py`` under ``/api``:

  GET    /projects/{id}/partners                 who sees the project: handed over
                                                  (with notes) or through its tasks
  PUT    /projects/{id}/partners/{partner_id}     hand it over / edit the note
  DELETE /projects/{id}/partners/{partner_id}     take it back

Reading follows the project (anyone who may open it sees which partners are
on it). Changing it needs ``projects:manage`` AND manage access to this
project — the same bar as changing the project's members, because this is
what decides which outside company can read the job.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import assert_project_access, get_current_user, require_permission
from app.core.time import utcnow
from app.models.entities import Partner, Project, ProjectPartner, Task, TaskPartner, User
from app.routers.workflow_helpers import _record_project_activity, _register_project_folder
from app.schemas.portal import ProjectPartnerOut, ProjectPartnerSummary, ProjectPartnerUpsert
from app.services.audit import log_admin_action
from app.services.partner_hours import totals_by_partner
from app.services.partner_portal import PARTNER_FOLDER, portal_user_counts

router = APIRouter(prefix="", tags=["project-partners"])


def _project_or_404(db: Session, project_id: int) -> Project:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


def _project_partner_rows(
    db: Session, project_id: int, *, only_partner_id: int | None = None
) -> list[ProjectPartnerOut]:
    """Everybody who sees the project in the portal.

    First the partners it was handed to (in hand-over order, with their note),
    then those who reach it only through a task on it (by name) — the office
    must see every company that reads the project's ``Partnerportal`` folder,
    not only the ones it assigned on purpose.
    """
    explicit_query = select(ProjectPartner).where(ProjectPartner.project_id == project_id)
    if only_partner_id is not None:
        explicit_query = explicit_query.where(ProjectPartner.partner_id == only_partner_id)
    explicit = list(
        db.scalars(explicit_query.order_by(ProjectPartner.created_at.asc(), ProjectPartner.id.asc())).all()
    )
    task_counts = {
        int(partner_id): int(count)
        for partner_id, count in db.execute(
            select(TaskPartner.partner_id, func.count(Task.id))
            .join(Task, Task.id == TaskPartner.task_id)
            .where(Task.project_id == project_id)
            .group_by(TaskPartner.partner_id)
        ).all()
    }
    explicit_ids = [row.partner_id for row in explicit]
    implicit_ids = (
        [] if only_partner_id is not None else [pid for pid in task_counts if pid not in set(explicit_ids)]
    )
    ids = explicit_ids + implicit_ids
    partners = {p.id: p for p in db.scalars(select(Partner).where(Partner.id.in_(ids))).all()} if ids else {}
    logins = portal_user_counts(db, ids)
    hours = totals_by_partner(db, project_id)

    def row_out(partner: Partner, link: ProjectPartner | None) -> ProjectPartnerOut:
        return ProjectPartnerOut(
            project_id=project_id,
            partner_id=partner.id,
            partner=ProjectPartnerSummary(
                id=partner.id, name=partner.name, trade=partner.trade, archived_at=partner.archived_at
            ),
            assigned=link is not None,
            note=link.note if link is not None else None,
            portal_user_count=int(logins.get(partner.id, 0)),
            task_count=int(task_counts.get(partner.id, 0)),
            hours_total=float(hours.get(partner.id, 0)),
            created_at=link.created_at if link is not None else None,
            updated_at=link.updated_at if link is not None else None,
        )

    out = [row_out(partners[link.partner_id], link) for link in explicit if link.partner_id in partners]
    implicit = sorted(
        (partners[pid] for pid in implicit_ids if pid in partners), key=lambda p: (p.name.lower(), p.id)
    )
    out.extend(row_out(partner, None) for partner in implicit)
    return out


@router.get("/projects/{project_id}/partners", response_model=list[ProjectPartnerOut])
def list_project_partners(
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ProjectPartnerOut]:
    assert_project_access(db, current_user, project_id)
    _project_or_404(db, project_id)
    return _project_partner_rows(db, project_id)


@router.put("/projects/{project_id}/partners/{partner_id}", response_model=ProjectPartnerOut)
def upsert_project_partner(
    project_id: int,
    partner_id: int,
    payload: ProjectPartnerUpsert,
    current_user: User = Depends(require_permission("projects:manage")),
    db: Session = Depends(get_db),
) -> ProjectPartnerOut:
    assert_project_access(db, current_user, project_id, manage_required=True)
    project = _project_or_404(db, project_id)
    partner = db.get(Partner, partner_id)
    if partner is None:
        raise HTTPException(status_code=404, detail="Partner not found")
    note = (payload.note or "").strip() or None
    row = db.scalars(
        select(ProjectPartner).where(
            ProjectPartner.project_id == project_id, ProjectPartner.partner_id == partner_id
        )
    ).first()
    if row is None:
        if partner.archived_at is not None:
            raise HTTPException(status_code=409, detail="Partner is archived")
        row = ProjectPartner(project_id=project.id, partner_id=partner.id, note=note, created_by=current_user.id)
        db.add(row)
        _record_project_activity(
            db,
            project_id=project.id,
            actor_user_id=current_user.id,
            event_type="project.partner_assigned",
            message=f"Partner zugewiesen: {partner.name}",
            details={"partner_id": partner.id},
        )
    else:
        row.note = note
        row.updated_at = utcnow()
        db.add(row)
    # The folder whose files this partner may read; created up front so the
    # office finds it in the project's files instead of having to know its name.
    _register_project_folder(db, project_id=project.id, folder_path=PARTNER_FOLDER, created_by=current_user.id)
    db.commit()
    db.refresh(row)
    log_admin_action(
        db,
        current_user,
        "project.partner_upsert",
        "project",
        str(project.id),
        {"partner_id": partner.id, "has_note": note is not None},
    )
    return _project_partner_rows(db, project.id, only_partner_id=partner.id)[0]


@router.delete("/projects/{project_id}/partners/{partner_id}", status_code=204)
def remove_project_partner(
    project_id: int,
    partner_id: int,
    current_user: User = Depends(require_permission("projects:manage")),
    db: Session = Depends(get_db),
):
    assert_project_access(db, current_user, project_id, manage_required=True)
    project = _project_or_404(db, project_id)
    row = db.scalars(
        select(ProjectPartner).where(
            ProjectPartner.project_id == project_id, ProjectPartner.partner_id == partner_id
        )
    ).first()
    if row is not None:
        partner = db.get(Partner, partner_id)
        db.delete(row)
        _record_project_activity(
            db,
            project_id=project.id,
            actor_user_id=current_user.id,
            event_type="project.partner_removed",
            message=f"Partner entfernt: {partner.name if partner else partner_id}",
            details={"partner_id": partner_id},
        )
        db.commit()
        log_admin_action(db, current_user, "project.partner_remove", "project", str(project.id), {"partner_id": partner_id})
    return Response(status_code=204)
