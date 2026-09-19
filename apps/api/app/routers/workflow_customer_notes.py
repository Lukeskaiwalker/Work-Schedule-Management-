"""The customer's note feed.

``GET/POST /customers/{id}/notes`` and ``DELETE /customers/{id}/notes/{note_id}``
— the customer-level twin of the project note feed. The single overwritten
``customers.notes`` text became the first entry (migration 0092); from here
on every posting keeps its author and time, and the customer's change log
records it as ``customer.note_posted`` / ``customer.note_deleted``.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user
from app.core.permissions import has_permission_for_user
from app.core.time import utcnow
from app.models.entities import CustomerNote, User
from app.routers.workflow_helpers import _assert_customer_files_access

# The page sizes and the preview rule are the project feed's: the two feeds
# look the same on screen and log the same way, so they share one source.
from app.routers.workflow_project_notes import (
    DEFAULT_NOTES_PAGE,
    MAX_NOTES_PAGE,
    _author_names_by_id,
    _note_preview,
)
from app.schemas.customer import CustomerNoteCreate, CustomerNoteOut
from app.services.customer_activity import record_customer_activity

router = APIRouter(prefix="", tags=["customer-notes"])


def _note_out(note: CustomerNote, *, author_name: str | None) -> CustomerNoteOut:
    return CustomerNoteOut(
        id=note.id,
        customer_id=note.customer_id,
        author_user_id=note.author_user_id,
        author_name=author_name,
        body=note.body,
        created_at=note.created_at,
    )


def customer_notes_out(
    db: Session,
    customer_id: int,
    *,
    limit: int,
    before_id: int | None = None,
) -> list[CustomerNoteOut]:
    """The feed newest first, one page at a time.

    ``before_id`` is the keyset: ids grow with time, so "older than this
    note" is "smaller id" — no offset to drift when someone posts while a
    reader pages back. The entry the migration carried over has the
    smallest id of its customer, so it comes last there as well.
    """
    safe_limit = max(1, min(int(limit), MAX_NOTES_PAGE))
    stmt = select(CustomerNote).where(CustomerNote.customer_id == customer_id)
    if before_id is not None:
        stmt = stmt.where(CustomerNote.id < before_id)
    rows = db.scalars(
        stmt.order_by(CustomerNote.created_at.desc(), CustomerNote.id.desc()).limit(safe_limit)
    ).all()
    names = _author_names_by_id(db, rows)
    return [_note_out(row, author_name=names.get(row.author_user_id or 0)) for row in rows]


def _record_note_event(
    db: Session, *, customer_id: int, actor_user_id: int, event_type: str, note_id: int, body: str
) -> None:
    preview = _note_preview(body)
    record_customer_activity(
        db,
        customer_id=customer_id,
        actor_user_id=actor_user_id,
        event_type=event_type,
        message=preview,
        details={"note_id": note_id, "preview": preview},
    )


@router.get("/customers/{customer_id}/notes", response_model=list[CustomerNoteOut])
def list_customer_notes(
    customer_id: int,
    limit: int = Query(DEFAULT_NOTES_PAGE),
    before_id: int | None = Query(None, ge=1),
    # The same keyset under the name the activity feed pages by, so a
    # client can treat the two feeds alike.
    cursor: int | None = Query(None, ge=1),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # Who may open the customer's files may read the feed: the rule borrowed
    # from the projects (docs/FILE_SCOPES.md). Unknown customer is a 404.
    _assert_customer_files_access(db, current_user, customer_id)
    return customer_notes_out(
        db, customer_id, limit=limit, before_id=before_id if before_id is not None else cursor
    )


@router.post("/customers/{customer_id}/notes", response_model=CustomerNoteOut)
def post_customer_note(
    customer_id: int,
    payload: CustomerNoteCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # Read access is enough to post — the fitter who was on site writes
    # what the customer said, not only the office.
    _assert_customer_files_access(db, current_user, customer_id)
    note = CustomerNote(
        customer_id=customer_id,
        author_user_id=current_user.id,
        body=payload.body,
        created_at=utcnow(),
    )
    db.add(note)
    db.flush()
    _record_note_event(
        db,
        customer_id=customer_id,
        actor_user_id=current_user.id,
        event_type="customer.note_posted",
        note_id=note.id,
        body=note.body,
    )
    db.commit()
    db.refresh(note)
    return _note_out(note, author_name=current_user.display_name)


@router.delete("/customers/{customer_id}/notes/{note_id}", status_code=204)
def delete_customer_note(
    customer_id: int,
    note_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _assert_customer_files_access(db, current_user, customer_id)
    note = db.get(CustomerNote, note_id)
    # A note of another customer is "not found" here rather than "forbidden":
    # the URL names a customer, and this note is not on it.
    if note is None or note.customer_id != customer_id:
        raise HTTPException(status_code=404, detail="Note not found")
    # Your own posting, or a project manager's clean-up. The carried-over
    # first entry has no author, so only a manager can remove it.
    is_author = note.author_user_id is not None and note.author_user_id == current_user.id
    if not is_author and not has_permission_for_user(current_user.id, current_user.role, "projects:manage"):
        raise HTTPException(status_code=403, detail="Only the author or a project manager can delete a note")
    body = note.body
    db.delete(note)
    _record_note_event(
        db,
        customer_id=customer_id,
        actor_user_id=current_user.id,
        event_type="customer.note_deleted",
        note_id=note_id,
        body=body,
    )
    db.commit()
