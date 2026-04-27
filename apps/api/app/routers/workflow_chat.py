from __future__ import annotations

from fastapi import APIRouter

from app.core.events import notify
from app.routers.workflow_helpers import *  # noqa: F401,F403

router = APIRouter(prefix="", tags=["chat"])


@router.get("/threads/participant-users", response_model=list[AssignableUserOut])
def list_thread_participant_users(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not _chat_permission_allowed(current_user):
        raise HTTPException(status_code=403, detail="Chat access denied")
    return _list_active_assignable_users(db)

@router.get("/threads/participant-roles", response_model=list[str])
def list_thread_participant_roles(
    current_user: User = Depends(get_current_user),
):
    if not _chat_permission_allowed(current_user):
        raise HTTPException(status_code=403, detail="Chat access denied")
    return list(ALL_ROLES)

@router.get("/threads/participant-groups", response_model=list[EmployeeGroupOut])
def list_thread_participant_groups(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not _chat_permission_allowed(current_user):
        raise HTTPException(status_code=403, detail="Chat access denied")
    groups = db.scalars(select(EmployeeGroup).order_by(EmployeeGroup.name.asc(), EmployeeGroup.id.asc())).all()
    return [_employee_group_out(db, group) for group in groups]

@router.post("/threads", response_model=ThreadOut)
def create_global_thread(
    payload: ThreadCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    created = _create_thread_internal(payload, current_user, db)
    notify(db, "thread.created", created.model_dump(mode="json"))
    return created

@router.get("/threads", response_model=list[ThreadOut])
def list_global_threads(
    include_archived: bool = False,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not _chat_permission_allowed(current_user):
        raise HTTPException(status_code=403, detail="Chat access denied")
    sync_report_feed_thread(db)
    db.commit()
    threads = db.scalars(
        select(ChatThread).order_by(
            func.coalesce(ChatThread.updated_at, datetime(1970, 1, 1)).desc(),
            ChatThread.id.desc(),
        )
    ).all()
    return [
        _thread_out(db, thread, current_user)
        for thread in threads
        if _thread_visible_to_user(db, current_user, thread) and (include_archived or not _thread_is_archived(thread))
    ]

@router.post("/projects/{project_id}/threads", response_model=ThreadOut)
def create_project_thread(
    project_id: int,
    payload: ThreadCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    fixed_payload = ThreadCreate(
        name=payload.name,
        project_id=project_id,
        site_id=payload.site_id,
        participant_user_ids=payload.participant_user_ids,
        participant_roles=payload.participant_roles,
        participant_group_ids=payload.participant_group_ids,
    )
    created = _create_thread_internal(fixed_payload, current_user, db)
    notify(db, "thread.created", created.model_dump(mode="json"))
    return created

@router.get("/projects/{project_id}/threads", response_model=list[ThreadOut])
def list_project_threads(
    project_id: int,
    include_archived: bool = False,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_project_access(db, current_user, project_id)
    threads = db.scalars(
        select(ChatThread)
        .where(ChatThread.project_id == project_id)
        .order_by(
            func.coalesce(ChatThread.updated_at, datetime(1970, 1, 1)).desc(),
            ChatThread.id.desc(),
        )
    ).all()
    return [
        _thread_out(db, thread, current_user)
        for thread in threads
        if _thread_visible_to_user(db, current_user, thread) and (include_archived or not _thread_is_archived(thread))
    ]

@router.patch("/threads/{thread_id}", response_model=ThreadOut)
def update_thread(
    thread_id: int,
    payload: ThreadUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    thread = db.get(ChatThread, thread_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")
    _assert_thread_access(db, current_user, thread)
    if not _can_edit_thread(current_user, thread):
        raise HTTPException(status_code=403, detail="Only the creator or chat managers can edit this thread")

    cleaned_name = payload.name.strip()
    if not cleaned_name:
        raise HTTPException(status_code=400, detail="Thread name cannot be empty")

    thread.name = cleaned_name
    provided_fields = getattr(payload, "model_fields_set", None)
    if provided_fields is None:
        provided_fields = getattr(payload, "__fields_set__", set())
    if "project_id" in provided_fields:
        target_project_id = payload.project_id
        if target_project_id is not None:
            assert_project_access(db, current_user, target_project_id)
        if thread.site_id is not None:
            site = db.get(Site, thread.site_id)
            if not site:
                raise HTTPException(status_code=404, detail="Site not found")
            if target_project_id is None:
                raise HTTPException(status_code=400, detail="Cannot clear project_id while site_id is set")
            if target_project_id != site.project_id:
                raise HTTPException(status_code=400, detail="site_id does not belong to project_id")
        thread.project_id = target_project_id

    access_fields = {"participant_user_ids", "participant_roles", "participant_group_ids"}
    if provided_fields & access_fields:
        participant_user_ids = _normalize_id_list(payload.participant_user_ids or [])
        participant_role_keys = _normalize_role_list(payload.participant_roles or [])
        participant_group_ids = _normalize_id_list(payload.participant_group_ids or [])
        _validate_thread_participants(
            db,
            participant_user_ids=participant_user_ids,
            participant_role_keys=participant_role_keys,
            participant_group_ids=participant_group_ids,
            allow_existing_thread_id=thread.id,
        )
        _replace_thread_participants(
            db,
            thread=thread,
            participant_user_ids=participant_user_ids,
            participant_role_keys=participant_role_keys,
            participant_group_ids=participant_group_ids,
            include_creator=True,
        )

    thread.updated_at = utcnow()
    db.commit()
    db.refresh(thread)
    updated = _thread_out(db, thread, current_user)
    notify(db, "thread.updated", updated.model_dump(mode="json"))
    return updated

@router.post("/threads/{thread_id}/archive", response_model=ThreadOut)
def archive_thread(
    thread_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    thread = db.get(ChatThread, thread_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")
    _assert_thread_access(db, current_user, thread)
    if not _can_edit_thread(current_user, thread):
        raise HTTPException(status_code=403, detail="Only the creator or chat managers can archive this thread")
    if not _thread_is_archived(thread):
        thread.status = "archived"
        thread.archived_at = utcnow()
        thread.archived_by = current_user.id
        thread.updated_at = utcnow()
        db.commit()
        db.refresh(thread)
    return _thread_out(db, thread, current_user)

@router.post("/threads/{thread_id}/restore", response_model=ThreadOut)
def restore_thread(
    thread_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    thread = db.get(ChatThread, thread_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")
    _assert_thread_access(db, current_user, thread)
    if not _can_edit_thread(current_user, thread):
        raise HTTPException(status_code=403, detail="Only the creator or chat managers can restore this thread")
    if _thread_is_archived(thread):
        thread.status = "active"
        thread.archived_at = None
        thread.archived_by = None
        thread.updated_at = utcnow()
        db.commit()
        db.refresh(thread)
    return _thread_out(db, thread, current_user)

@router.delete("/threads/{thread_id}")
def delete_thread(
    thread_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    thread = db.get(ChatThread, thread_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")
    _assert_thread_access(db, current_user, thread)
    if not _can_edit_thread(current_user, thread):
        raise HTTPException(status_code=403, detail="Only the creator or chat managers can delete this thread")
    if is_report_feed_thread(thread):
        raise HTTPException(status_code=403, detail="System report feed thread cannot be deleted")
    icon_path = (thread.icon_stored_path or "").strip()
    db.delete(thread)
    db.commit()
    if icon_path:
        try:
            Path(icon_path).unlink(missing_ok=True)
        except OSError:
            pass
    return {"ok": True}

@router.post("/threads/{thread_id}/icon")
async def upload_thread_icon(
    thread_id: int,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    thread = db.get(ChatThread, thread_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")
    _assert_thread_access(db, current_user, thread)
    if not _can_edit_thread(current_user, thread):
        raise HTTPException(status_code=403, detail="Only the creator or chat managers can edit this thread")

    if not file.filename:
        raise HTTPException(status_code=400, detail="File name is required")
    content_type = _safe_media_type(file.content_type, fallback="")
    if not _is_upload_image(file.filename, content_type):
        raise HTTPException(status_code=400, detail="Thread icon must be an image")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Thread icon file is empty")
    if len(raw) > MAX_AVATAR_BYTES:
        raise HTTPException(status_code=413, detail="Thread icon too large (max 5MB)")

    extension = _file_extension(file.filename) or "jpg"
    stored_bytes = raw
    stored_content_type = content_type or (mimetypes.guess_type(file.filename or "")[0] or "image/jpeg")
    if _is_heic_upload(file.filename, content_type):
        converted = _convert_heic_to_jpeg(raw)
        if converted:
            stored_bytes = converted
            extension = "jpg"
            stored_content_type = "image/jpeg"
        else:
            extension = "heic" if extension not in HEIC_IMAGE_EXTENSIONS else extension
            stored_content_type = "image/heif" if extension == "heif" else "image/heic"

    stored_path = store_encrypted_file(stored_bytes, extension)
    thread.icon_stored_path = stored_path
    thread.icon_content_type = stored_content_type
    thread.icon_updated_at = utcnow()
    thread.updated_at = utcnow()
    db.commit()
    return {"ok": True, "icon_updated_at": thread.icon_updated_at}

@router.get("/threads/{thread_id}/icon")
def get_thread_icon(
    thread_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    thread = db.get(ChatThread, thread_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")
    _assert_thread_access(db, current_user, thread)
    if not thread.icon_stored_path:
        raise HTTPException(status_code=404, detail="Thread icon not found")

    content = _avatar_bytes_or_http_error(thread.icon_stored_path)
    file_name = f"thread-{thread.id}-icon"
    return Response(
        content,
        media_type=thread.icon_content_type or "application/octet-stream",
        headers={"Content-Disposition": _content_disposition(file_name, inline=True)},
    )

@router.post("/threads/{thread_id}/messages", response_model=MessageOut)
async def create_message(
    thread_id: int,
    body: str | None = Form(default=None),
    # Multi-file path: the new frontend sends `attachments` as a repeating
    # field. Each entry becomes a separate Attachment row, so a single
    # message can carry several pictures.
    attachments: list[UploadFile] | None = File(default=None),
    # Legacy single-file params kept for backward compatibility with older
    # clients (and any external automation that still posts one file at a
    # time). They're folded into the same list as `attachments` below.
    image: UploadFile | None = File(default=None),
    attachment: UploadFile | None = File(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    thread = db.get(ChatThread, thread_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")
    _assert_thread_access(db, current_user, thread)
    if _thread_is_archived(thread):
        raise HTTPException(status_code=409, detail="Thread is archived")

    text = (body or "").strip() or None

    # Collect every uploaded file into one list. Filter out empty rows
    # (FastAPI sometimes hands back a phantom empty UploadFile when a form
    # field is declared but no file was actually provided).
    uploads: list[UploadFile] = []
    for candidate in (attachments or []):
        if candidate and candidate.filename:
            uploads.append(candidate)
    for legacy in (image, attachment):
        if legacy and legacy.filename:
            uploads.append(legacy)

    if not text and not uploads:
        raise HTTPException(status_code=400, detail="Message text or attachment is required")

    message = Message(thread_id=thread_id, sender_id=current_user.id, body=text)
    db.add(message)
    db.flush()

    for upload in uploads:
        raw = await upload.read()
        if not raw:
            # Skip empty files silently when there's other content; raise
            # otherwise so the user sees a useful error rather than an
            # apparently-successful empty message.
            if not text and len(uploads) == 1:
                raise HTTPException(status_code=400, detail="Attachment file is empty")
            continue
        extension = (
            upload.filename.rsplit(".", 1)[-1] if "." in upload.filename else "bin"
        )
        stored_path = store_encrypted_file(raw, extension)
        db.add(
            Attachment(
                project_id=thread.project_id,
                site_id=thread.site_id,
                message_id=message.id,
                uploaded_by=current_user.id,
                file_name=upload.filename,
                content_type=upload.content_type or "application/octet-stream",
                stored_path=stored_path,
                is_encrypted=True,
            )
        )

    db.flush()
    _mark_thread_read(
        db,
        thread_id=thread_id,
        user_id=current_user.id,
        last_message_id=message.id,
        commit=False,
    )
    db.commit()
    db.refresh(message)
    created = _message_out(db, message)
    notify(db, "message.created", created.model_dump(mode="json"))
    return created

@router.get("/threads/{thread_id}/messages", response_model=list[MessageOut])
def list_messages(
    thread_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    thread = db.get(ChatThread, thread_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")
    _assert_thread_access(db, current_user, thread)
    messages = db.scalars(select(Message).where(Message.thread_id == thread_id).order_by(Message.created_at.asc())).all()
    last_message_id = messages[-1].id if messages else None
    _mark_thread_read(
        db,
        thread_id=thread_id,
        user_id=current_user.id,
        last_message_id=last_message_id,
        commit=True,
    )
    return [_message_out(db, message) for message in messages]
