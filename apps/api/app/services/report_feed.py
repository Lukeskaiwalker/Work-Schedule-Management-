from __future__ import annotations

import logging

from sqlalchemy import case, delete, or_, select
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import (
    Attachment,
    ChatThread,
    ChatThreadParticipantGroup,
    ChatThreadParticipantRole,
    ChatThreadParticipantUser,
    ConstructionReport,
    Message,
    Project,
    User,
)

logger = logging.getLogger(__name__)

REPORT_FEED_THREAD_NAME = "Latest Construction Reports"


def _find_report_feed_thread(db: Session) -> ChatThread | None:
    return db.scalars(
        select(ChatThread)
        .where(
            ChatThread.project_id.is_(None),
            ChatThread.site_id.is_(None),
            ChatThread.name == REPORT_FEED_THREAD_NAME,
        )
        .order_by(ChatThread.id.asc())
        .limit(1)
    ).first()


def is_report_feed_thread(thread: ChatThread | None) -> bool:
    if thread is None:
        return False
    return (
        thread.project_id is None
        and thread.site_id is None
        and str(thread.name or "").strip() == REPORT_FEED_THREAD_NAME
    )


def ensure_report_feed_thread(db: Session, *, actor_user_id: int | None = None) -> ChatThread:
    thread = _find_report_feed_thread(db)
    if not thread:
        thread = ChatThread(
            project_id=None,
            site_id=None,
            name=REPORT_FEED_THREAD_NAME,
            visibility="public",
            status="active",
            archived_at=None,
            archived_by=None,
            created_by=actor_user_id,
            updated_at=utcnow(),
        )
        db.add(thread)
        db.flush()
        return thread

    needs_reset = False
    if (thread.visibility or "public") != "public":
        thread.visibility = "public"
        needs_reset = True
    if str(thread.status or "").strip().lower() == "archived" or thread.archived_at is not None or thread.archived_by is not None:
        thread.status = "active"
        thread.archived_at = None
        thread.archived_by = None
        needs_reset = True
    if thread.project_id is not None:
        thread.project_id = None
        needs_reset = True
    if thread.site_id is not None:
        thread.site_id = None
        needs_reset = True

    if needs_reset:
        db.execute(delete(ChatThreadParticipantUser).where(ChatThreadParticipantUser.thread_id == thread.id))
        db.execute(delete(ChatThreadParticipantRole).where(ChatThreadParticipantRole.thread_id == thread.id))
        db.execute(delete(ChatThreadParticipantGroup).where(ChatThreadParticipantGroup.thread_id == thread.id))
        thread.updated_at = utcnow()
        db.flush()

    return thread


def _report_feed_sender_id(db: Session, preferred_user_id: int | None) -> int | None:
    if preferred_user_id:
        preferred = db.get(User, int(preferred_user_id))
        if preferred:
            return int(preferred.id)

    prioritized_active = db.scalars(
        select(User.id)
        .where(User.is_active.is_(True))
        .order_by(
            case(
                (User.role == "admin", 0),
                (User.role == "ceo", 1),
                (User.role == "planning", 2),
                (User.role == "accountant", 3),
                else_=4,
            ),
            User.id.asc(),
        )
        .limit(1)
    ).first()
    if prioritized_active is not None:
        return int(prioritized_active)

    fallback_any = db.scalars(select(User.id).order_by(User.id.asc()).limit(1)).first()
    if fallback_any is not None:
        return int(fallback_any)
    return None


def _report_project_label(report: ConstructionReport, project: Project | None) -> str:
    payload = report.payload if isinstance(report.payload, dict) else {}
    project_number = (
        str(project.project_number or "").strip() if project else str(payload.get("project_number") or "").strip()
    )
    project_name = str(project.name or "").strip() if project else str(payload.get("project_name") or "").strip()
    if project_number and project_name:
        return f"{project_number} - {project_name}"
    if project_number:
        return project_number
    if project_name:
        return project_name
    if report.project_id is not None:
        return f"Project {report.project_id}"
    return "General report"


def _report_feed_message_text(report: ConstructionReport, project: Project | None) -> str:
    report_token = f"#{int(report.report_number)}" if report.report_number is not None else f"ID {report.id}"
    payload = report.payload if isinstance(report.payload, dict) else {}
    project_number = (
        str(project.project_number or "").strip() if project else str(payload.get("project_number") or "").strip()
    )
    project_name = str(project.name or "").strip() if project else str(payload.get("project_name") or "").strip()
    if not project_number and not project_name:
        project_label = _report_project_label(report, project)
    elif project_number and project_name:
        project_label = f"{project_number} - {project_name}"
    else:
        project_label = project_number or project_name
    return f"Construction report {report_token} | Project {project_label} | Date {report.report_date.isoformat()}"


def post_report_to_feed_thread(
    db: Session,
    *,
    report: ConstructionReport,
    pdf_attachment: Attachment | None,
    thread: ChatThread | None = None,
) -> Message | None:
    thread = thread or ensure_report_feed_thread(db, actor_user_id=report.user_id)
    project = db.get(Project, report.project_id) if report.project_id is not None else None
    message_text = _report_feed_message_text(report, project)
    if pdf_attachment and pdf_attachment.message_id:
        existing_message = db.get(Message, int(pdf_attachment.message_id))
        if existing_message and existing_message.thread_id == thread.id:
            if (existing_message.body or "") != message_text:
                existing_message.body = message_text
                thread.updated_at = utcnow()
                db.flush()
            return existing_message

    sender_id = _report_feed_sender_id(db, report.user_id)
    if sender_id is None:
        logger.warning("Skipping report feed post for report %s: no sender user available", report.id)
        return None

    message = Message(
        thread_id=thread.id,
        sender_id=sender_id,
        body=message_text,
    )
    db.add(message)
    db.flush()

    if pdf_attachment is not None:
        pdf_attachment.message_id = message.id
    thread.updated_at = utcnow()
    db.flush()
    return message


def sync_report_feed_thread(db: Session, *, batch_size: int = 500) -> ChatThread | None:
    thread = _find_report_feed_thread(db)
    has_any_report = db.scalars(select(ConstructionReport.id).order_by(ConstructionReport.id.asc()).limit(1)).first()
    if thread is None and has_any_report is None:
        return None
    if thread is None:
        thread = ensure_report_feed_thread(db)
    else:
        thread = ensure_report_feed_thread(db, actor_user_id=thread.created_by)
    candidates = db.scalars(
        select(Attachment)
        .outerjoin(Message, Message.id == Attachment.message_id)
        .where(
            Attachment.construction_report_id.is_not(None),
            Attachment.content_type == "application/pdf",
            or_(
                Attachment.message_id.is_(None),
                Message.id.is_(None),
                Message.thread_id != thread.id,
            ),
        )
        .order_by(Attachment.id.asc())
        .limit(max(1, int(batch_size)))
    ).all()

    for attachment in candidates:
        report_id = int(attachment.construction_report_id or 0)
        if report_id <= 0:
            continue
        report = db.get(ConstructionReport, report_id)
        if report is None:
            continue
        post_report_to_feed_thread(
            db,
            report=report,
            pdf_attachment=attachment,
            thread=thread,
        )
    return thread
