from __future__ import annotations

from fastapi import APIRouter

from app.routers.workflow_helpers import *  # noqa: F401,F403

router = APIRouter(prefix="", tags=["sites"])


@router.post("/projects/{project_id}/sites", response_model=SiteOut)
def create_site(
    project_id: int,
    payload: SiteCreate,
    current_user: User = Depends(require_permission("tickets:manage")),
    db: Session = Depends(get_db),
):
    assert_project_access(db, current_user, project_id)
    site = Site(project_id=project_id, name=payload.name, address=payload.address)
    db.add(site)
    db.commit()
    db.refresh(site)
    return site

@router.get("/projects/{project_id}/sites", response_model=list[SiteOut])
def list_sites(
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_project_access(db, current_user, project_id)
    return list(db.scalars(select(Site).where(Site.project_id == project_id).order_by(Site.id.desc())).all())

@router.post("/projects/{project_id}/job-tickets", response_model=JobTicketOut)
def create_job_ticket(
    project_id: int,
    payload: JobTicketCreate,
    current_user: User = Depends(require_permission("tickets:manage")),
    db: Session = Depends(get_db),
):
    assert_project_access(db, current_user, project_id)
    ticket = JobTicket(project_id=project_id, **payload.model_dump())
    db.add(ticket)
    db.flush()
    _record_project_activity(
        db,
        project_id=project_id,
        actor_user_id=current_user.id,
        event_type="ticket.created",
        message=f"Job ticket created: {ticket.title}",
        details={"ticket_id": ticket.id},
    )
    db.commit()
    db.refresh(ticket)
    return ticket

@router.get("/projects/{project_id}/job-tickets", response_model=list[JobTicketOut])
def list_job_tickets(
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_project_access(db, current_user, project_id)
    return list(
        db.scalars(select(JobTicket).where(JobTicket.project_id == project_id).order_by(JobTicket.ticket_date.desc())).all()
    )

@router.post("/projects/{project_id}/job-tickets/{ticket_id}/attachments")
async def upload_job_ticket_attachment(
    project_id: int,
    ticket_id: int,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_project_access(db, current_user, project_id)
    ticket = db.get(JobTicket, ticket_id)
    if not ticket or ticket.project_id != project_id:
        raise HTTPException(status_code=404, detail="Ticket not found")
    if not file.filename:
        raise HTTPException(status_code=400, detail="File name is required")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="File body is required")
    extension = file.filename.rsplit(".", 1)[-1] if "." in file.filename else "bin"
    stored_path = store_encrypted_file(raw, extension)

    attachment = Attachment(
        project_id=project_id,
        site_id=ticket.site_id,
        job_ticket_id=ticket_id,
        uploaded_by=current_user.id,
        folder_path="Tickets",
        file_name=file.filename,
        content_type=file.content_type or "application/octet-stream",
        stored_path=stored_path,
        is_encrypted=True,
    )
    db.add(attachment)
    _record_project_activity(
        db,
        project_id=project_id,
        actor_user_id=current_user.id,
        event_type="ticket.updated",
        message=f"Job ticket updated: #{ticket_id}",
        details={"ticket_id": ticket_id, "file_name": file.filename},
    )
    db.commit()
    db.refresh(attachment)
    return _attachment_out(attachment)

@router.get("/projects/{project_id}/job-tickets/{ticket_id}/attachments")
def list_job_ticket_attachments(
    project_id: int,
    ticket_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_project_access(db, current_user, project_id)
    ticket = db.get(JobTicket, ticket_id)
    if not ticket or ticket.project_id != project_id:
        raise HTTPException(status_code=404, detail="Ticket not found")

    attachments = db.scalars(
        select(Attachment)
        .where(Attachment.project_id == project_id, Attachment.job_ticket_id == ticket_id)
        .order_by(Attachment.created_at.desc())
    ).all()
    return [_attachment_out(attachment) for attachment in attachments]

@router.get("/projects/{project_id}/job-tickets/{ticket_id}/print", response_class=HTMLResponse)
def print_job_ticket(
    project_id: int,
    ticket_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_project_access(db, current_user, project_id)
    ticket = db.get(JobTicket, ticket_id)
    if not ticket or ticket.project_id != project_id:
        raise HTTPException(status_code=404, detail="Ticket not found")

    checklist_html = "".join(
        [f"<li>{item.get('label', 'Item')}: {'OK' if item.get('done') else 'Open'}</li>" for item in ticket.checklist]
    )
    crew = ", ".join(ticket.assigned_crew)
    html = f"""
    <html>
      <head>
        <style>
          body {{ font-family: Arial, sans-serif; margin: 24px; }}
          .label {{ font-weight: bold; }}
          @media print {{ .no-print {{ display: none; }} }}
        </style>
      </head>
      <body>
        <button class='no-print' onclick='window.print()'>Print</button>
        <h1>Job Ticket: {ticket.title}</h1>
        <p><span class='label'>Site Address:</span> {ticket.site_address}</p>
        <p><span class='label'>Date:</span> {ticket.ticket_date}</p>
        <p><span class='label'>Assigned Crew:</span> {crew}</p>
        <p><span class='label'>Notes:</span> {ticket.notes or ''}</p>
        <h2>Checklist</h2>
        <ul>{checklist_html}</ul>
      </body>
    </html>
    """
    return HTMLResponse(html)
