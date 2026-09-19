"""The project's internal note feed.

``GET/POST /projects/{id}/notes`` and ``DELETE /projects/{id}/notes/{note_id}``.
Replaces the single overwritten "Interne Notiz": every posting keeps its
author and time, and the activity log records it so the customer's
cross-project log shows it too.
"""

from __future__ import annotations

from collections.abc import Sequence

from fastapi import APIRouter

from app.core.events import notify
from app.models.entities import ProjectNote
from app.routers.workflow_helpers import *  # noqa: F401,F403
from app.schemas.project import ProjectNoteCreate, ProjectNoteOut

router = APIRouter(prefix="", tags=["project-notes"])

# The overview shows the latest page of the feed; "Ältere anzeigen" fetches
# the rest from the list endpoint, which never hands out more than the cap
# whatever the client asks for.
OVERVIEW_NOTES_PAGE = 20
DEFAULT_NOTES_PAGE = 50
MAX_NOTES_PAGE = 200
# What the activity log keeps of a note: enough to recognise it on the
# customer's cross-project log, on one line.
NOTE_PREVIEW_CHARS = 120


def _note_preview(body: str) -> str:
    """The note on one line, cut to what an activity row can show."""
    return " ".join(body.split())[:NOTE_PREVIEW_CHARS]


def _author_names_by_id(db: Session, notes: Sequence[ProjectNote]) -> dict[int, str]:
    """One query for every author on the page, as the activity feed does it."""
    author_ids = sorted({note.author_user_id for note in notes if note.author_user_id is not None})
    if not author_ids:
        return {}
    users = db.scalars(select(User).where(User.id.in_(author_ids))).all()
    return {user.id: user.display_name for user in users}


def _note_out(note: ProjectNote, *, author_name: str | None) -> ProjectNoteOut:
    return ProjectNoteOut(
        id=note.id,
        project_id=note.project_id,
        author_user_id=note.author_user_id,
        author_name=author_name,
        body=note.body,
        created_at=note.created_at,
    )


def project_notes_out(
    db: Session,
    project_id: int,
    *,
    limit: int,
    before_id: int | None = None,
) -> list[ProjectNoteOut]:
    """The feed newest first, one page at a time.

    ``before_id`` is the keyset: ids grow with time, so "older than this
    note" is "smaller id" — no offset to drift when someone posts while a
    reader pages back. The note the migration carried over has the
    smallest id of its project, so it comes last there as well.
    """
    safe_limit = max(1, min(int(limit), MAX_NOTES_PAGE))
    stmt = select(ProjectNote).where(ProjectNote.project_id == project_id)
    if before_id is not None:
        stmt = stmt.where(ProjectNote.id < before_id)
    rows = db.scalars(
        stmt.order_by(ProjectNote.created_at.desc(), ProjectNote.id.desc()).limit(safe_limit)
    ).all()
    names = _author_names_by_id(db, rows)
    return [_note_out(row, author_name=names.get(row.author_user_id or 0)) for row in rows]


def _broadcast_project_updated(db: Session, project: Project) -> None:
    """What ``update_project`` sends after a change: the project as the list
    shows it. An open overview reloads on any ``project.*`` event, which is
    how a posting appears on a colleague's screen without a manual refresh."""
    db.refresh(project)
    notify(db, "project.updated", ProjectOut.model_validate(project).model_dump(mode="json"))


def _project_or_404(db: Session, project_id: int) -> Project:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@router.get("/projects/{project_id}/notes", response_model=list[ProjectNoteOut])
def list_project_notes(
    project_id: int,
    limit: int = Query(DEFAULT_NOTES_PAGE),
    before_id: int | None = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_project_access(db, current_user, project_id)
    _project_or_404(db, project_id)
    return project_notes_out(db, project_id, limit=limit, before_id=before_id)


@router.post("/projects/{project_id}/notes", response_model=ProjectNoteOut)
def post_project_note(
    project_id: int,
    payload: ProjectNoteCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # Read access is enough to post: the crew writes from the site, not
    # only the office — that is the point of a feed over one office text.
    assert_project_access(db, current_user, project_id)
    project = _project_or_404(db, project_id)
    note = ProjectNote(
        project_id=project_id,
        author_user_id=current_user.id,
        body=payload.body,
        created_at=utcnow(),
    )
    db.add(note)
    db.flush()
    preview = _note_preview(note.body)
    _record_project_activity(
        db,
        project_id=project_id,
        actor_user_id=current_user.id,
        event_type="project.note_posted",
        message=preview,
        details={"note_id": note.id, "preview": preview},
    )
    db.commit()
    db.refresh(note)
    _broadcast_project_updated(db, project)
    return _note_out(note, author_name=current_user.display_name)


@router.delete("/projects/{project_id}/notes/{note_id}", status_code=204)
def delete_project_note(
    project_id: int,
    note_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_project_access(db, current_user, project_id)
    project = _project_or_404(db, project_id)
    note = db.get(ProjectNote, note_id)
    # A note of another project is "not found" here rather than "forbidden":
    # the URL names a project, and this note is not on it.
    if note is None or note.project_id != project_id:
        raise HTTPException(status_code=404, detail="Note not found")
    # Your own posting, or a project manager's clean-up. The carried-over
    # first note has no author, so only a manager can remove it.
    is_author = note.author_user_id is not None and note.author_user_id == current_user.id
    if not is_author and not has_permission_for_user(current_user.id, current_user.role, "projects:manage"):
        raise HTTPException(status_code=403, detail="Only the author or a project manager can delete a note")
    preview = _note_preview(note.body)
    db.delete(note)
    _record_project_activity(
        db,
        project_id=project_id,
        actor_user_id=current_user.id,
        event_type="project.note_deleted",
        message=preview,
        details={"note_id": note_id, "preview": preview},
    )
    db.commit()
    _broadcast_project_updated(db, project)
