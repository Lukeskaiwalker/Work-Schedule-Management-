from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter

from app.routers.workflow_helpers import *  # noqa: F401,F403

router = APIRouter(prefix="", tags=["files"])


@router.get("/projects/{project_id}/folders", response_model=list[ProjectFolderOut])
def list_project_folders(
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_project_access(db, current_user, project_id)
    rows = db.scalars(
        select(ProjectFolder).where(ProjectFolder.project_id == project_id).order_by(ProjectFolder.path.asc())
    ).all()
    out_by_path: dict[str, ProjectFolderOut] = {}
    for path_value, protected in DEFAULT_PROJECT_FOLDERS:
        if not _folder_visible_to_user(current_user, path_value, protected):
            continue
        out_by_path[path_value] = ProjectFolderOut(path=path_value, is_protected=protected)
    for row in rows:
        if not _folder_visible_to_user(current_user, row.path, row.is_protected):
            continue
        out_by_path[row.path] = ProjectFolderOut(path=row.path, is_protected=row.is_protected)
    return sorted(out_by_path.values(), key=lambda item: item.path.lower())

@router.post("/projects/{project_id}/folders", response_model=ProjectFolderOut)
def create_project_folder(
    project_id: int,
    payload: ProjectFolderCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_project_access(db, current_user, project_id)
    normalized = _normalize_project_folder_path(payload.path, allow_empty=False)
    protected = _folder_path_is_protected(normalized)
    if protected and not _can_access_project_protected_folder(current_user):
        raise HTTPException(status_code=403, detail="Folder access denied")
    _register_project_folder(
        db,
        project_id=project_id,
        folder_path=normalized,
        created_by=current_user.id,
    )
    db.commit()
    return ProjectFolderOut(path=normalized, is_protected=protected)

@router.post("/projects/{project_id}/files")
async def upload_project_files(
    project_id: int,
    folder: str = Form(default=""),
    files: list[UploadFile] | None = File(default=None),
    file: UploadFile | None = File(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Upload one or more files to a project's folder.

    v2.5.22: extended to accept ``files: list[UploadFile]`` so the
    frontend can submit multi-file uploads in a single request (used by
    the new drag-and-drop UI and the multi-select file picker). The
    legacy singular ``file`` parameter is still accepted for backward
    compatibility with any frontend build that hasn't been reloaded yet
    after the v2.5.22 deploy — without that fallback we'd return 422
    for every upload between "backend deployed" and "every browser
    refreshed".

    Always returns a list, even for single-file uploads. Old callers
    that only inspected status code keep working; callers that read
    the response body need to handle the new shape.
    """
    assert_project_access(db, current_user, project_id)
    incoming: list[UploadFile] = []
    if files:
        incoming.extend(f for f in files if f and f.filename)
    if file and file.filename:
        incoming.append(file)
    if not incoming:
        raise HTTPException(status_code=400, detail="At least one file is required")

    created: list[Attachment] = []
    for upload in incoming:
        if not upload.filename:
            raise HTTPException(status_code=400, detail="File name is required")
        normalized_folder = _resolve_project_upload_folder(folder, upload.filename, upload.content_type)
        if _folder_path_is_protected(normalized_folder) and not _can_access_project_protected_folder(current_user):
            raise HTTPException(status_code=403, detail="Folder access denied")
        _register_project_folder(
            db,
            project_id=project_id,
            folder_path=normalized_folder,
            created_by=current_user.id,
        )
        raw = await upload.read()
        if not raw:
            # Skip empty files in a multi-upload rather than failing the
            # whole batch — operators sometimes select a partially
            # uploaded directory and we don't want one zero-byte placeholder
            # to abort 14 real files.
            continue
        extension = upload.filename.rsplit(".", 1)[-1] if "." in upload.filename else "bin"
        stored_path = store_encrypted_file(raw, extension)

        attachment = Attachment(
            project_id=project_id,
            uploaded_by=current_user.id,
            folder_path=normalized_folder,
            file_name=upload.filename,
            content_type=upload.content_type or "application/octet-stream",
            stored_path=stored_path,
            is_encrypted=True,
        )
        db.add(attachment)
        _record_project_activity(
            db,
            project_id=project_id,
            actor_user_id=current_user.id,
            event_type="file.uploaded",
            message=f"File uploaded: {upload.filename}",
            details={"file_name": upload.filename, "folder": normalized_folder},
        )
        created.append(attachment)

    if not created:
        raise HTTPException(status_code=400, detail="No valid file bodies in the request")

    db.commit()
    for attachment in created:
        db.refresh(attachment)
    return [_attachment_out(a) for a in created]

@router.get("/projects/{project_id}/files")
def list_project_files(
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_project_access(db, current_user, project_id)
    attachments = db.scalars(
        select(Attachment).where(Attachment.project_id == project_id).order_by(Attachment.created_at.desc())
    ).all()
    visible_rows: list[dict] = []
    for attachment in attachments:
        folder = _normalize_project_folder_path(attachment.folder_path, allow_empty=True)
        if _folder_path_is_protected(folder) and not _can_access_project_protected_folder(current_user):
            continue
        visible_rows.append(_attachment_out(attachment))
    return visible_rows

@router.get("/files/{attachment_id}/download")
def download_file(
    attachment_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    attachment = _resolve_attachment_for_access(db, current_user, attachment_id)
    return _attachment_http_response(attachment, inline=False)

@router.get("/files/{attachment_id}/preview")
def preview_file(
    attachment_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    attachment = _resolve_attachment_for_access(db, current_user, attachment_id)
    return _attachment_http_response(attachment, inline=True)


@router.delete("/files/{attachment_id}", status_code=204)
def delete_file(
    attachment_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    attachment = db.get(Attachment, attachment_id)
    if not attachment:
        raise HTTPException(status_code=404, detail="File not found")
    # Only project files can be deleted via this endpoint (not chat attachments)
    if attachment.project_id is None:
        raise HTTPException(status_code=403, detail="Cannot delete this file type")
    assert_project_access(db, current_user, attachment.project_id)
    folder = _normalize_project_folder_path(attachment.folder_path, allow_empty=True)
    if _folder_path_is_protected(folder) and not _can_access_project_protected_folder(current_user):
        raise HTTPException(status_code=403, detail="File access denied")
    if not has_permission_for_user(current_user.id, current_user.role, "files:manage"):
        raise HTTPException(status_code=403, detail="File management permission required")

    stored_path = attachment.stored_path
    _record_project_activity(
        db,
        project_id=attachment.project_id,
        actor_user_id=current_user.id,
        event_type="file.deleted",
        message=f"File deleted: {attachment.file_name}",
        details={"file_name": attachment.file_name, "folder": folder},
    )
    db.delete(attachment)
    db.commit()

    # Best-effort: remove the stored file from disk after the DB commit
    try:
        Path(stored_path).unlink(missing_ok=True)
    except OSError:
        pass
