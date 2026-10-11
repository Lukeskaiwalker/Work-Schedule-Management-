"""What a partner can see — the one place that decides it.

A partner (subcontractor company) sees:

* **tasks** linked to it through ``task_partners`` — the office's existing
  "Partner" field on a task;
* **projects** linked to it through ``project_partners``, plus every project
  one of those tasks belongs to — the same "a task in it makes the project
  visible" rule employees have had since v2.5.34, so "shows up in my list"
  and "I can open it" can never disagree.

Every portal read goes through these functions, and every miss is a 404:
the portal never says that something exists but is not yours.
"""

from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.permissions import ROLE_EXTERNAL
from app.models.entities import Attachment, Partner, Project, ProjectPartner, Task, TaskPartner, User
from app.services.project_status import (
    PROJECT_STATUS_ABGESCHLOSSEN,
    PROJECT_STATUS_RECHNUNG,
    normalize_project_status,
)

# Statuses a partner reads as "finished". Invoicing is the office's business,
# so "Rechnung verschickt" folds into finished rather than being shown; the
# archive markers sit outside the funnel and count as finished too.
_FINISHED_STATUSES = frozenset(
    {PROJECT_STATUS_RECHNUNG, PROJECT_STATUS_ABGESCHLOSSEN, "archived", "archiviert"}
)


#: The project folder whose files every partner on the project may read.
#: Matched on the first path segment, case-insensitively — the same way the
#: protected ``Verwaltung`` rule matches — so ``partnerportal/Pläne`` counts
#: and ``Partnerportal-Archiv`` does not.
PARTNER_FOLDER = "Partnerportal"
_PARTNER_FOLDER_KEY = PARTNER_FOLDER.lower()


def _segments(folder_path: str | None) -> list[str]:
    raw = (folder_path or "").replace("\\", "/")
    return [part.strip() for part in raw.split("/") if part.strip()]


def is_partner_folder(folder_path: str | None) -> bool:
    segments = _segments(folder_path)
    return bool(segments) and segments[0].lower() == _PARTNER_FOLDER_KEY


def partner_folder_subpath(folder_path: str | None) -> str:
    """``Partnerportal/Pläne/Dach`` → ``Pläne/Dach``; the folder itself → ``""``."""
    return "/".join(_segments(folder_path)[1:])


def partner_documents(db: Session, project_id: int) -> list[Attachment]:
    """The project's files a partner may read, newest first.

    Project files only: a task's own files are dual-anchored into the
    ``Aufgaben`` folder and reach a partner through their task, never here.
    """
    lowered = func.lower(Attachment.folder_path)
    rows = db.scalars(
        select(Attachment)
        .where(
            Attachment.project_id == project_id,
            Attachment.task_id.is_(None),
            (lowered == _PARTNER_FOLDER_KEY) | lowered.like(f"{_PARTNER_FOLDER_KEY}/%"),
        )
        .order_by(Attachment.created_at.desc(), Attachment.id.desc())
    ).all()
    # The SQL narrows; the segment rule decides (a stored "partnerportal /x"
    # or backslash path must not slip through either way).
    return [row for row in rows if is_partner_folder(row.folder_path)]


def project_phase(project: Project) -> str:
    status = normalize_project_status(project.status)
    return "finished" if status in _FINISHED_STATUSES else "running"


def partner_task_ids(partner_id: int):
    """Subquery: ids of every task linked to the partner."""
    return select(TaskPartner.task_id).where(TaskPartner.partner_id == partner_id)


def partner_task_or_none(db: Session, partner_id: int, task_id: int) -> Task | None:
    linked = db.scalars(
        select(TaskPartner.id).where(
            TaskPartner.partner_id == partner_id, TaskPartner.task_id == task_id
        )
    ).first()
    if linked is None:
        return None
    return db.get(Task, task_id)


def visible_project_ids(db: Session, partner_id: int) -> set[int]:
    direct = db.scalars(
        select(ProjectPartner.project_id).where(ProjectPartner.partner_id == partner_id)
    ).all()
    via_tasks = db.scalars(
        select(Task.project_id).where(
            Task.id.in_(partner_task_ids(partner_id)), Task.project_id.is_not(None)
        )
    ).all()
    return {int(pid) for pid in (*direct, *via_tasks) if pid is not None}


def project_note_for(db: Session, partner_id: int, project_id: int | None) -> str | None:
    if project_id is None:
        return None
    note = db.scalars(
        select(ProjectPartner.note).where(
            ProjectPartner.partner_id == partner_id, ProjectPartner.project_id == project_id
        )
    ).first()
    text = (note or "").strip()
    return text or None


def project_site_address(project: Project | None) -> str | None:
    if project is None:
        return None
    for candidate in (project.construction_site_address, project.customer_address):
        text = (candidate or "").strip()
        if text:
            return text
    return None


def portal_user_counts(db: Session, partner_ids: Iterable[int]) -> dict[int, int]:
    """partner id → number of logins that can sign in today.

    Active AND accepted: an invite nobody has taken up yet is not access, and
    counting it would tell the office "sees it in the portal" too early.
    """
    ids = sorted({int(pid) for pid in partner_ids})
    if not ids:
        return {}
    rows = db.execute(
        select(User.partner_id, func.count(User.id))
        .where(
            User.partner_id.in_(ids),
            User.role == ROLE_EXTERNAL,
            User.is_active.is_(True),
            User.invite_accepted_at.is_not(None),
        )
        .group_by(User.partner_id)
    ).all()
    return {int(partner_id): int(count) for partner_id, count in rows}


def portal_users_of(db: Session, partner_id: int) -> list[User]:
    return list(
        db.scalars(
            select(User)
            .where(User.partner_id == partner_id, User.role == ROLE_EXTERNAL)
            .order_by(User.is_active.desc(), User.full_name.asc(), User.id.asc())
        ).all()
    )


def partner_is_open(partner: Partner | None) -> bool:
    return partner is not None and partner.archived_at is None
