"""Customer-level folders and files.

The customer folder is the level above the project folder: what belongs to
the customer rather than to one of their jobs lives here. Endpoints mirror
the project ones in ``workflow_files`` (``/customers/{id}/folders``,
``/customers/{id}/files``); the shared ``/files/{id}/...`` routes serve
preview, download and delete for every scope. Access rules: see
docs/FILE_SCOPES.md.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.models.entities import CustomerFolder
from app.routers.workflow_helpers import *  # noqa: F401,F403
from app.services.customer_files import (
    DEFAULT_CUSTOMER_FOLDERS,
    ensure_customer_default_folders,
    register_customer_folder,
)

router = APIRouter(prefix="", tags=["customer-files"])


def _resolve_customer_upload_folder(raw_folder: str) -> str:
    """Where a customer upload lands: "" or "/" is the root, anything else
    the normalised path.

    No sorting by type, unlike ``_resolve_project_upload_folder``: a
    project's photos go to ``Bilder`` because the report flow puts them
    there, while the customer folder holds what the office files by hand —
    contracts, plans, letters — so the folder the caller names is the folder.
    """
    raw = (raw_folder or "").strip()
    if raw == "/":
        return ""
    return _normalize_project_folder_path(raw, allow_empty=True)


def _incoming_uploads(files: list[UploadFile] | None, file: UploadFile | None) -> list[UploadFile]:
    """Both spellings of the multipart body, as the project upload takes
    them: ``files`` from the multi-select UI and the legacy single ``file``
    from any client that has not been reloaded since."""
    incoming = [upload for upload in (files or []) if upload and upload.filename]
    if file and file.filename:
        incoming.append(file)
    if not incoming:
        raise HTTPException(status_code=400, detail="At least one file is required")
    return incoming


def _store_customer_upload(
    db: Session,
    *,
    customer_id: int,
    user: User,
    folder_path: str,
    upload: UploadFile,
    raw: bytes,
) -> Attachment:
    file_name = upload.filename or ""
    extension = file_name.rsplit(".", 1)[-1] if "." in file_name else "bin"
    attachment = Attachment(
        customer_id=customer_id,
        uploaded_by=user.id,
        folder_path=folder_path,
        file_name=file_name,
        content_type=upload.content_type or "application/octet-stream",
        stored_path=store_encrypted_file(raw, extension),
        is_encrypted=True,
    )
    db.add(attachment)
    return attachment


@router.get("/customers/{customer_id}/folders", response_model=list[ProjectFolderOut])
def list_customer_folders(
    customer_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _assert_customer_files_access(db, current_user, customer_id)
    # Customers come into being in several places — the customer form, a
    # legacy project's customer_name, an import — and none of them seeds
    # folders. The first look at the folder does, which is why this GET
    # writes: it keeps every creation path out of the picture.
    ensure_customer_default_folders(db, customer_id)
    db.commit()
    rows = db.scalars(
        select(CustomerFolder).where(CustomerFolder.customer_id == customer_id).order_by(CustomerFolder.path.asc())
    ).all()
    out_by_path: dict[str, ProjectFolderOut] = {}
    for path_value, protected in DEFAULT_CUSTOMER_FOLDERS:
        if _folder_visible_to_user(current_user, path_value, protected):
            out_by_path[path_value] = ProjectFolderOut(path=path_value, is_protected=protected)
    for row in rows:
        if _folder_visible_to_user(current_user, row.path, row.is_protected):
            out_by_path[row.path] = ProjectFolderOut(path=row.path, is_protected=row.is_protected)
    return sorted(out_by_path.values(), key=lambda item: item.path.lower())


@router.post("/customers/{customer_id}/folders", response_model=ProjectFolderOut)
def create_customer_folder(
    customer_id: int,
    payload: ProjectFolderCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _assert_customer_files_access(db, current_user, customer_id)
    normalized = _normalize_project_folder_path(payload.path, allow_empty=False)
    protected = _folder_path_is_protected(normalized)
    if protected and not _can_access_project_protected_folder(current_user):
        raise HTTPException(status_code=403, detail="Folder access denied")
    register_customer_folder(db, customer_id=customer_id, folder_path=normalized, created_by=current_user.id)
    db.commit()
    return ProjectFolderOut(path=normalized, is_protected=protected)


@router.post("/customers/{customer_id}/files")
async def upload_customer_files(
    customer_id: int,
    folder: str = Form(default=""),
    files: list[UploadFile] | None = File(default=None),
    file: UploadFile | None = File(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Upload one or more files into a customer's folder.

    Same body as the project upload (``files[]`` plus the legacy single
    ``file``), same answers (always a list; empty bodies skipped, 400 when
    nothing usable is left), same storage. What differs is the folder rule
    — see ``_resolve_customer_upload_folder`` — and that a customer has no
    activity log to write to.
    """
    _assert_customer_files_access(db, current_user, customer_id)
    normalized_folder = _resolve_customer_upload_folder(folder)
    if _folder_path_is_protected(normalized_folder) and not _can_access_project_protected_folder(current_user):
        raise HTTPException(status_code=403, detail="Folder access denied")
    incoming = _incoming_uploads(files, file)
    ensure_customer_default_folders(db, customer_id)
    register_customer_folder(
        db,
        customer_id=customer_id,
        folder_path=normalized_folder,
        created_by=current_user.id,
    )

    created: list[Attachment] = []
    for upload in incoming:
        raw = await upload.read()
        if not raw:
            # Skipped, not fatal — one zero-byte placeholder in a dropped
            # directory must not abort the other files (as for projects).
            continue
        created.append(
            _store_customer_upload(
                db,
                customer_id=customer_id,
                user=current_user,
                folder_path=normalized_folder,
                upload=upload,
                raw=raw,
            )
        )
    if not created:
        raise HTTPException(status_code=400, detail="No valid file bodies in the request")

    db.commit()
    for attachment in created:
        db.refresh(attachment)
    return [_attachment_out(attachment) for attachment in created]


@router.get("/customers/{customer_id}/files")
def list_customer_files(
    customer_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _assert_customer_files_access(db, current_user, customer_id)
    attachments = db.scalars(
        select(Attachment)
        .where(Attachment.customer_id == customer_id)
        .order_by(Attachment.created_at.desc(), Attachment.id.desc())
    ).all()
    visible_rows: list[dict] = []
    for attachment in attachments:
        folder = _normalize_project_folder_path(attachment.folder_path, allow_empty=True)
        if _folder_path_is_protected(folder) and not _can_access_project_protected_folder(current_user):
            continue
        visible_rows.append(_attachment_out(attachment))
    return visible_rows
