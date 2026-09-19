"""Files attached to a task.

A plan or a picture the assignee needs. The attachment row is dual-anchored:
it carries ``task_id`` AND the task's project (or customer), and sits in that
scope's ``Aufgaben`` folder, so the same file shows up in the project's file
browser and its WebDAV tree. Access rules: see docs/FILE_SCOPES.md.

Copying a task never copies its files. There is no server-side copy —
"Aufgabe kopieren" prefills the create modal and POSTs a fresh task — and the
bytes belong to exactly one row (``stored_path`` is unique), so a copied task
starts with an empty attachments section.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.core.events import notify
from app.routers.workflow_helpers import *  # noqa: F401,F403
from app.services.customer_files import TASK_FILES_FOLDER, register_customer_folder
from app.services.task_attachments import list_task_attachments, with_attachment_counts

router = APIRouter(prefix="", tags=["task-files"])


def _task_or_404(db: Session, task_id: int) -> Task:
    task = db.get(Task, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


def _assert_task_visible(db: Session, user: User, task: Task) -> None:
    """Whoever may see the task may see its files.

    The same people the task list shows it to: the assignee, anyone holding
    ``tasks:view_all`` (the unfiltered list), anyone with access to the task's
    project, and — for a customer-only task — anyone who may open the
    customer's files. The assignee is checked first so they never depend on a
    project membership they may not have; that is the point of the task file.
    """
    if _user_is_assigned_to_task(db, user, task.id):
        return
    if has_permission_for_user(user.id, user.role, "tasks:view_all"):
        return
    if task.project_id is not None:
        assert_project_access(db, user, task.project_id)
        return
    if task.customer_id is not None and _user_can_see_customer_files(db, user, task.customer_id):
        return
    raise HTTPException(status_code=403, detail="Task access denied")


def _assert_task_editable(db: Session, user: User, task: Task) -> None:
    """Exactly ``update_task``'s gate: ``tasks:manage``, or being assigned.

    A crew member adds the photo to their own task without ``files:manage``,
    which only the office holds — the task's rule, not the file browser's.
    """
    if has_permission_for_user(user.id, user.role, "tasks:manage"):
        return
    if user.id in _task_assignee_map(db, [task]).get(task.id, []):
        return
    raise HTTPException(status_code=403, detail="Task access denied")


def _register_task_folder(db: Session, task: Task, *, created_by: int) -> None:
    """Make ``Aufgaben`` exist in the scope the file lands in — the project's
    folder table for a project task, the customer's for a customer-only one."""
    if task.project_id is not None:
        _register_project_folder(
            db, project_id=task.project_id, folder_path=TASK_FILES_FOLDER, created_by=created_by
        )
        return
    if task.customer_id is not None:
        register_customer_folder(
            db, customer_id=task.customer_id, folder_path=TASK_FILES_FOLDER, created_by=created_by
        )


def _incoming_uploads(files: list[UploadFile] | None, file: UploadFile | None) -> list[UploadFile]:
    """Same multi-file plus legacy ``file`` shape as the project upload."""
    incoming: list[UploadFile] = []
    if files:
        incoming.extend(f for f in files if f and f.filename)
    if file and file.filename:
        incoming.append(file)
    if not incoming:
        raise HTTPException(status_code=400, detail="At least one file is required")
    return incoming


def _store_task_upload(db: Session, *, task: Task, upload: UploadFile, raw: bytes, user: User) -> Attachment:
    file_name = upload.filename or ""
    extension = file_name.rsplit(".", 1)[-1] if "." in file_name else "bin"
    stored_path = store_encrypted_file(raw, extension)
    attachment = Attachment(
        task_id=task.id,
        project_id=task.project_id,
        # One scope anchor per row: a project task's file is a project file
        # and must not also appear in the customer's own folder. Only a
        # customer-only task files into the customer.
        customer_id=task.customer_id if task.project_id is None else None,
        uploaded_by=user.id,
        folder_path=TASK_FILES_FOLDER,
        file_name=file_name,
        content_type=upload.content_type or "application/octet-stream",
        stored_path=stored_path,
        is_encrypted=True,
    )
    db.add(attachment)
    if task.project_id is not None:
        # Project activity is project-scoped, exactly as for the task itself.
        _record_project_activity(
            db,
            project_id=task.project_id,
            actor_user_id=user.id,
            event_type="file.uploaded",
            message=f"File uploaded: {file_name}",
            details={"file_name": file_name, "folder": TASK_FILES_FOLDER, "task_id": task.id},
        )
    return attachment


@router.get("/tasks/{task_id}/files")
def list_task_files(
    task_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """The task's files, newest first, in the shape the project file list uses."""
    task = _task_or_404(db, task_id)
    _assert_task_visible(db, current_user, task)
    return [_attachment_out(row) for row in list_task_attachments(db, task.id)]


@router.post("/tasks/{task_id}/files")
async def upload_task_files(
    task_id: int,
    files: list[UploadFile] | None = File(default=None),
    file: UploadFile | None = File(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Attach one or more files to a task.

    No folder parameter: a task file always lands in ``Aufgaben`` of the
    task's scope. Whoever may edit the task may add to it, so the assignee
    can attach the photo from site. Empty files are skipped like the project
    upload skips them; a request with nothing usable is a 400. Always returns
    the list of created rows.

    After the commit the same ``task.updated`` event the PATCH fires goes out
    with the task's new ``attachment_count``, so open boards and modals
    refresh their paperclip without a reload.
    """
    task = _task_or_404(db, task_id)
    _assert_task_editable(db, current_user, task)
    incoming = _incoming_uploads(files, file)
    # Registered before the rows are added, as the project upload does, so the
    # folder savepoint's flush carries the folder row and nothing else.
    _register_task_folder(db, task, created_by=current_user.id)

    created: list[Attachment] = []
    for upload in incoming:
        raw = await upload.read()
        if not raw:
            continue
        created.append(_store_task_upload(db, task=task, upload=upload, raw=raw, user=current_user))
    if not created:
        raise HTTPException(status_code=400, detail="No valid file bodies in the request")

    db.commit()
    for attachment in created:
        db.refresh(attachment)
    updated = with_attachment_counts(db, _tasks_out(db, [task]))[0]
    notify(db, "task.updated", updated.model_dump(mode="json"))
    return [_attachment_out(attachment) for attachment in created]
