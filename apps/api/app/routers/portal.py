"""The partner portal API — everything a subcontractor's login may call.

Mounted in ``main.py`` under ``/api``, so every route here lives below
``/api/portal/``. The last line of this file registers these routes with the
fence in ``app.core.deps`` — they are the only ones a partner login may
call; nothing outside this file is reachable for them.

Rules every endpoint keeps:

* identity comes from ``get_portal_context`` — a partner login whose partner
  exists and is not archived; office staff are turned away (they have the
  office app, and the portal's 404-for-everything-else rule would only
  confuse them);
* visibility comes from ``app.services.partner_portal`` and every miss is a
  404, so the portal never confirms that something it does not show exists;
* responses are the narrow ``schemas.portal`` shapes — no customer phone or
  email, no finances, no project description, no internal status words.
"""

from __future__ import annotations

from datetime import date, time, timedelta
from pathlib import PurePath
from types import SimpleNamespace

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import register_portal_routes
from app.core.events import notify
from app.core.permissions import is_external_role
from app.core.security import get_password_hash, verify_password
from app.core.time import utcnow
from app.models.entities import (
    Attachment,
    Customer,
    CustomerNote,
    Project,
    ProjectNote,
    Task,
    User,
)
from app.routers.workflow_helpers import (
    _attachment_http_response,
    _normalize_task_status,
    _record_project_activity,
    _task_assignee_map,
    _task_is_overdue,
)
from app.routers.portal_common import PortalContext, get_portal_context
from app.routers.workflow_task_files import _register_task_folder, _store_task_upload
from app.routers.workflow_tasks import _record_task_activity, _resolve_task_notifications, _task_rows_out
from app.schemas.portal import (
    PortalCompanyOut,
    PortalCompleteIn,
    PortalDocumentOut,
    PortalFileOut,
    PortalMeOut,
    PortalNextTask,
    PortalPartnerOut,
    PortalPasswordChange,
    PortalProjectDetailOut,
    PortalProjectOut,
    PortalProjectRef,
    PortalTaskDetailOut,
    PortalTaskOut,
    PortalUserOut,
)
from app.services.audit import log_admin_action
from app.services.customer_activity import record_customer_activity
from app.services.partner_hours import entries_for_project, entries_for_task, hours_total, portal_entries_out
from app.services.partner_portal import (
    partner_documents,
    partner_folder_subpath,
    partner_task_ids,
    partner_task_or_none,
    project_note_for,
    project_phase,
    project_site_address,
    visible_project_ids,
)
from app.services.runtime_settings import get_company_settings
from app.services.task_attachments import attachment_counts, list_task_attachments
from app.services.task_material_settlement import settle_task_materials

router = APIRouter(prefix="/portal", tags=["partner-portal"])

#: How far back the "Erledigt" list reaches, and how many rows it holds.
DONE_WINDOW_DAYS = 180
DONE_LIMIT = 100
#: Upload limits. A site photo is 2–8 MB; a PDF plan rarely more.
MAX_FILES_PER_UPLOAD = 10
MAX_FILE_BYTES = 25 * 1024 * 1024
#: Uploads are typed by their first bytes, never by the name or the client's
#: Content-Type — a partner login is an internet-facing account.
_UPLOAD_TYPES: dict[str, str] = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif",
    "application/pdf": "pdf",
}
_HEIC_BRANDS = {b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis"}
_HEIF_BRANDS = {b"mif1", b"msf1"}


# ── Serialisation ────────────────────────────────────────────────────────────

def _status(task: Task) -> str:
    try:
        normalized = _normalize_task_status(task.status, default="open")
    except ValueError:
        normalized = "open"
    # The legacy stored "overdue" is a date fact, carried by is_overdue.
    return normalized if normalized in {"open", "in_progress", "on_hold", "done"} else "open"


def _lookup(db: Session, tasks: list[Task]) -> tuple[dict[int, Project], dict[int, Customer]]:
    project_ids = {t.project_id for t in tasks if t.project_id is not None}
    customer_ids = {t.customer_id for t in tasks if t.customer_id is not None and t.project_id is None}
    projects = {p.id: p for p in db.scalars(select(Project).where(Project.id.in_(project_ids))).all()} if project_ids else {}
    customers = {c.id: c for c in db.scalars(select(Customer).where(Customer.id.in_(customer_ids))).all()} if customer_ids else {}
    return projects, customers


def _task_out(
    task: Task,
    *,
    projects: dict[int, Project],
    customers: dict[int, Customer],
    files: dict[int, int],
) -> PortalTaskOut:
    project = projects.get(task.project_id) if task.project_id is not None else None
    customer = customers.get(task.customer_id) if task.project_id is None and task.customer_id is not None else None
    address = project_site_address(project) if project is not None else ((customer.address or "").strip() or None if customer else None)
    return PortalTaskOut(
        id=task.id,
        title=task.title,
        status=_status(task),
        due_date=task.due_date,
        end_date=task.end_date,
        start_time=task.start_time,
        estimated_hours=task.estimated_hours,
        is_overdue=_task_is_overdue(task),
        project=PortalProjectRef(id=project.id, number=project.project_number, name=project.name) if project else None,
        customer_name=(customer.name if customer else None),
        address=address,
        attachment_count=int(files.get(task.id, 0)),
    )


def _tasks_out(db: Session, tasks: list[Task]) -> list[PortalTaskOut]:
    projects, customers = _lookup(db, tasks)
    files = attachment_counts(db, [t.id for t in tasks])
    return [_task_out(t, projects=projects, customers=customers, files=files) for t in tasks]


def _open_sort_key(task: Task) -> tuple:
    return (task.due_date or date.max, task.start_time or time.max, task.id)


def _file_source(uploader: User | None, partner_id: int) -> str:
    if uploader is None or not is_external_role(uploader.role):
        return "office"
    return "partner" if uploader.partner_id == partner_id else "external"


def _task_detail(db: Session, ctx: PortalContext, task: Task) -> PortalTaskDetailOut:
    base = _tasks_out(db, [task])[0]
    project = db.get(Project, task.project_id) if task.project_id is not None else None
    assignee_ids = _task_assignee_map(db, [task]).get(task.id, [])
    team_users = db.scalars(select(User).where(User.id.in_(assignee_ids))).all() if assignee_ids else []
    team = sorted(u.display_name for u in team_users if not is_external_role(u.role))
    attachments = list_task_attachments(db, task.id)
    hours = entries_for_task(db, task.id, partner_id=ctx.partner.id)
    uploader_ids = {a.uploaded_by for a in attachments if a.uploaded_by is not None}
    uploaders = {u.id: u for u in db.scalars(select(User).where(User.id.in_(uploader_ids))).all()} if uploader_ids else {}
    files = [
        PortalFileOut(
            id=a.id,
            file_name=a.file_name,
            content_type=a.content_type,
            created_at=a.created_at,
            source=_file_source(uploaders.get(a.uploaded_by), ctx.partner.id),
        )
        for a in attachments
    ]
    return PortalTaskDetailOut(
        **base.model_dump(),
        description=(task.description or "").strip() or None,
        subtasks=[s for s in (task.subtasks or []) if isinstance(s, str) and s.strip()],
        materials=(task.materials_required or "").strip() or None,
        site_access_type=(project.site_access_type if project else None),
        site_access_note=(project.site_access_note if project else None),
        project_note=project_note_for(db, ctx.partner.id, task.project_id),
        team=team,
        files=files,
        documents=_documents_out(db, task.project_id),
        hours=portal_entries_out(db, hours, partner_id=ctx.partner.id, now=utcnow()),
        hours_total=hours_total(hours),
        can_complete=base.status != "done",
    )


def _documents_out(db: Session, project_id: int | None) -> list[PortalDocumentOut]:
    """The project's ``Partnerportal`` files. Callers have already checked that
    the partner sees the project (through the task or the project itself)."""
    if project_id is None:
        return []
    return [
        PortalDocumentOut(
            id=row.id,
            file_name=row.file_name,
            content_type=row.content_type,
            folder=partner_folder_subpath(row.folder_path),
            created_at=row.created_at,
        )
        for row in partner_documents(db, project_id)
    ]


def _task_or_404(db: Session, ctx: PortalContext, task_id: int) -> Task:
    task = partner_task_or_none(db, ctx.partner.id, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


# ── Me ───────────────────────────────────────────────────────────────────────

@router.get("/me", response_model=PortalMeOut)
def portal_me(ctx: PortalContext = Depends(get_portal_context), db: Session = Depends(get_db)) -> PortalMeOut:
    company = get_company_settings(db)
    return PortalMeOut(
        user=PortalUserOut(id=ctx.user.id, full_name=ctx.user.full_name, email=ctx.user.email),
        partner=PortalPartnerOut(id=ctx.partner.id, name=ctx.partner.name, trade=ctx.partner.trade),
        company=PortalCompanyOut(
            name=str(company.get("company_name") or "SMPL"),
            logo_url=str(company.get("logo_url") or ""),
            phone=str(company.get("company_phone") or ""),
            email=str(company.get("company_email") or ""),
        ),
    )


@router.post("/me/password", status_code=204)
def portal_change_password(
    payload: PortalPasswordChange,
    ctx: PortalContext = Depends(get_portal_context),
    db: Session = Depends(get_db),
):
    if not verify_password(payload.current_password, ctx.user.password_hash):
        raise HTTPException(status_code=403, detail="Current password is wrong")
    ctx.user.password_hash = get_password_hash(payload.new_password)
    db.add(ctx.user)
    db.commit()
    log_admin_action(db, ctx.user, "auth.password_change", "user", str(ctx.user.id), {"via": "partner_portal"}, category="auth")
    return Response(status_code=204)


# ── Tasks ────────────────────────────────────────────────────────────────────

@router.get("/tasks", response_model=list[PortalTaskOut])
def portal_tasks(
    scope: str = Query("open", pattern="^(open|done)$"),
    ctx: PortalContext = Depends(get_portal_context),
    db: Session = Depends(get_db),
) -> list[PortalTaskOut]:
    tasks = list(db.scalars(select(Task).where(Task.id.in_(partner_task_ids(ctx.partner.id)))).all())
    if scope == "open":
        chosen = sorted((t for t in tasks if _status(t) != "done"), key=_open_sort_key)
    else:
        since = utcnow() - timedelta(days=DONE_WINDOW_DAYS)
        done = [t for t in tasks if _status(t) == "done" and (t.updated_at is None or t.updated_at >= since)]
        chosen = sorted(done, key=lambda t: (t.updated_at, t.id), reverse=True)[:DONE_LIMIT]
    return _tasks_out(db, chosen)


@router.get("/tasks/{task_id}", response_model=PortalTaskDetailOut)
def portal_task(task_id: int, ctx: PortalContext = Depends(get_portal_context), db: Session = Depends(get_db)) -> PortalTaskDetailOut:
    return _task_detail(db, ctx, _task_or_404(db, ctx, task_id))


@router.post("/tasks/{task_id}/complete", response_model=PortalTaskDetailOut)
def portal_complete_task(
    task_id: int,
    payload: PortalCompleteIn,
    ctx: PortalContext = Depends(get_portal_context),
    db: Session = Depends(get_db),
) -> PortalTaskDetailOut:
    """"Erledigt melden": the task becomes done, once.

    Does what completing a task does in the office app — open notifications
    on it are resolved, its crate is settled back onto the shelf, the change
    is logged where the task lives and pushed to open boards — with the
    partner's login as the actor. A second report is a 409, so a retried tap
    never posts the message twice.
    """
    task = _task_or_404(db, ctx, task_id)
    if _status(task) == "done":
        raise HTTPException(status_code=409, detail="Task is already done")
    task.status = "done"
    db.add(task)
    resolved_user_ids = _resolve_task_notifications(db, task.id)
    settlement = settle_task_materials(db, task=task, user_id=ctx.user.id, disposition="shelf")
    if settlement is not None:
        _record_task_activity(
            db,
            task,
            actor_user_id=ctx.user.id,
            event_type="task.materials_settled",
            message=f"Material abgerechnet: {task.title} ({settlement.remainder_text})",
            details={"task_id": task.id, **settlement.as_details()},
        )
    _record_task_activity(
        db,
        task,
        actor_user_id=ctx.user.id,
        event_type="task.updated",
        message=f"Erledigt gemeldet von {ctx.partner.name}: {task.title}",
        details={"task_id": task.id, "status": "done", "via": "partner_portal", "partner_id": ctx.partner.id},
    )
    note = (payload.note or "").strip()
    if note:
        body = f"Rückmeldung von {ctx.partner.name} zu „{task.title}“:\n{note}"
        preview = " ".join(body.split())[:120]
        if task.project_id is not None:
            row = ProjectNote(project_id=task.project_id, author_user_id=ctx.user.id, body=body, created_at=utcnow())
            db.add(row)
            db.flush()
            _record_project_activity(
                db,
                project_id=task.project_id,
                actor_user_id=ctx.user.id,
                event_type="project.note_posted",
                message=preview,
                details={"note_id": row.id, "preview": preview},
            )
        elif task.customer_id is not None:
            row = CustomerNote(customer_id=task.customer_id, author_user_id=ctx.user.id, body=body, created_at=utcnow())
            db.add(row)
            db.flush()
            record_customer_activity(
                db,
                customer_id=task.customer_id,
                actor_user_id=ctx.user.id,
                event_type="customer.note_posted",
                message=preview,
                details={"note_id": row.id, "preview": preview},
            )
    db.commit()
    db.refresh(task)
    notify(db, "task.updated", _task_rows_out(db, [task])[0].model_dump(mode="json"))
    for uid in resolved_user_ids:
        notify(db, "notification.resolved", {"user_id": uid})
    return _task_detail(db, ctx, task)


def _sniff_upload_type(raw: bytes) -> str | None:
    if raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    if raw.startswith(b"%PDF-"):
        return "application/pdf"
    if raw[4:8] == b"ftyp":
        brand = raw[8:12]
        if brand in _HEIC_BRANDS:
            return "image/heic"
        if brand in _HEIF_BRANDS:
            return "image/heif"
    return None


def _clean_file_name(raw_name: str | None, content_type: str) -> str:
    """The base name only, no control characters, and a suffix that matches the bytes."""
    name = PurePath((raw_name or "").replace("\\", "/")).name
    name = "".join(ch for ch in name if ch.isprintable()).strip().strip(".")[:180]
    expected = _UPLOAD_TYPES[content_type]
    stem, _, suffix = name.rpartition(".")
    if not name:
        return f"foto.{expected}"
    if not stem or suffix.lower() not in {expected, "jpeg" if expected == "jpg" else expected}:
        return f"{name}.{expected}"
    return name


@router.post("/tasks/{task_id}/files", response_model=list[PortalFileOut])
async def portal_upload_files(
    task_id: int,
    request: Request,
    ctx: PortalContext = Depends(get_portal_context),
    db: Session = Depends(get_db),
) -> list[PortalFileOut]:
    """Photos or PDFs from site onto the partner's own task.

    The body is read here, AFTER the login and the task were checked — no
    File() parameter, which FastAPI would parse before any dependency runs.
    """
    task = _task_or_404(db, ctx, task_id)
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_FILES_PER_UPLOAD * MAX_FILE_BYTES + 1024 * 1024:
        raise HTTPException(status_code=413, detail="Upload too large")
    form = await request.form(max_files=MAX_FILES_PER_UPLOAD, max_fields=20)
    accepted: list[tuple[str, str, bytes]] = []
    try:
        uploads = [item for item in form.getlist("files") if hasattr(item, "read")]
        if not uploads:
            raise HTTPException(status_code=400, detail="No files in the request")
        if len(uploads) > MAX_FILES_PER_UPLOAD:
            raise HTTPException(status_code=400, detail="Too many files")
        for upload in uploads:
            raw = await upload.read(MAX_FILE_BYTES + 1)
            if len(raw) > MAX_FILE_BYTES:
                raise HTTPException(status_code=413, detail="File too large")
            if not raw:
                continue
            content_type = _sniff_upload_type(raw)
            if content_type is None:
                raise HTTPException(status_code=400, detail="Only photos (JPEG, PNG, WebP, HEIC) and PDF files")
            accepted.append((_clean_file_name(upload.filename, content_type), content_type, raw))
    finally:
        # Parsed by hand, so closed by hand: the spooled temp files go now,
        # on the error paths too, not whenever the request object is collected.
        await form.close()
    if not accepted:
        raise HTTPException(status_code=400, detail="No valid file bodies in the request")

    _register_task_folder(db, task, created_by=ctx.user.id)
    created: list[Attachment] = []
    for file_name, content_type, raw in accepted:
        # The office's own task-upload path — encryption at rest, the task's
        # Aufgaben folder, the project activity row — fed the sniffed type.
        shaped = SimpleNamespace(filename=file_name, content_type=content_type)
        created.append(_store_task_upload(db, task=task, upload=shaped, raw=raw, user=ctx.user))
    db.commit()
    for row in created:
        db.refresh(row)
    notify(db, "task.updated", _task_rows_out(db, [task])[0].model_dump(mode="json"))
    return [
        PortalFileOut(id=row.id, file_name=row.file_name, content_type=row.content_type, created_at=row.created_at, source="partner")
        for row in created
    ]


@router.get("/tasks/{task_id}/files/{file_id}")
def portal_file(
    task_id: int,
    file_id: int,
    download: bool = Query(False),
    ctx: PortalContext = Depends(get_portal_context),
    db: Session = Depends(get_db),
):
    task = _task_or_404(db, ctx, task_id)
    attachment = db.get(Attachment, file_id)
    if attachment is None or attachment.task_id != task.id:
        raise HTTPException(status_code=404, detail="File not found")
    return _attachment_http_response(attachment, inline=not download)


# ── Projects ─────────────────────────────────────────────────────────────────

def _project_summary(project: Project, partner_tasks: list[Task]) -> PortalProjectOut:
    open_tasks = sorted((t for t in partner_tasks if _status(t) != "done"), key=_open_sort_key)
    nxt = open_tasks[0] if open_tasks else None
    return PortalProjectOut(
        id=project.id,
        number=project.project_number,
        name=project.name,
        address=project_site_address(project),
        phase=project_phase(project),
        open_task_count=len(open_tasks),
        overdue_task_count=sum(1 for t in open_tasks if _task_is_overdue(t)),
        next_task=PortalNextTask(id=nxt.id, title=nxt.title, due_date=nxt.due_date, start_time=nxt.start_time) if nxt else None,
    )


def _partner_tasks_by_project(db: Session, ctx: PortalContext, project_ids: set[int]) -> dict[int, list[Task]]:
    if not project_ids:
        return {}
    rows = db.scalars(
        select(Task).where(Task.id.in_(partner_task_ids(ctx.partner.id)), Task.project_id.in_(project_ids))
    ).all()
    grouped: dict[int, list[Task]] = {pid: [] for pid in project_ids}
    for task in rows:
        grouped.setdefault(int(task.project_id), []).append(task)
    return grouped


@router.get("/projects", response_model=list[PortalProjectOut])
def portal_projects(
    scope: str = Query("open", pattern="^(open|done)$"),
    ctx: PortalContext = Depends(get_portal_context),
    db: Session = Depends(get_db),
) -> list[PortalProjectOut]:
    ids = visible_project_ids(db, ctx.partner.id)
    projects = list(db.scalars(select(Project).where(Project.id.in_(ids))).all()) if ids else []
    wanted = "running" if scope == "open" else "finished"
    projects = [p for p in projects if project_phase(p) == wanted]
    tasks = _partner_tasks_by_project(db, ctx, {p.id for p in projects})
    rows = [_project_summary(p, tasks.get(p.id, [])) for p in projects]
    if scope == "open":
        rows.sort(key=lambda r: (
            (r.next_task.due_date if r.next_task and r.next_task.due_date else date.max),
            r.number,
        ))
    else:
        updated = {p.id: (p.last_updated_at or p.created_at) for p in projects}
        rows.sort(key=lambda r: updated.get(r.id), reverse=True)
    return rows


@router.get("/projects/{project_id}", response_model=PortalProjectDetailOut)
def portal_project(project_id: int, ctx: PortalContext = Depends(get_portal_context), db: Session = Depends(get_db)) -> PortalProjectDetailOut:
    if project_id not in visible_project_ids(db, ctx.partner.id):
        raise HTTPException(status_code=404, detail="Project not found")
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    tasks = _partner_tasks_by_project(db, ctx, {project.id}).get(project.id, [])
    summary = _project_summary(project, tasks)
    open_tasks = sorted((t for t in tasks if _status(t) != "done"), key=_open_sort_key)
    done_tasks = sorted((t for t in tasks if _status(t) == "done"), key=lambda t: (t.updated_at, t.id), reverse=True)[:20]
    hours = entries_for_project(db, project.id, partner_id=ctx.partner.id)
    return PortalProjectDetailOut(
        **summary.model_dump(),
        site_access_type=project.site_access_type,
        site_access_note=project.site_access_note,
        partner_note=project_note_for(db, ctx.partner.id, project.id),
        tasks=_tasks_out(db, open_tasks + done_tasks),
        documents=_documents_out(db, project.id),
        hours=portal_entries_out(db, hours, partner_id=ctx.partner.id, now=utcnow()),
        hours_total=hours_total(hours),
    )


# Last, after every route above exists: these and only these are open to
# partner logins (see the fence in app.core.deps).
register_portal_routes(router.routes)
