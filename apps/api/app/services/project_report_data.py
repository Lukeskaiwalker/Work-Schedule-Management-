"""What the Projektbericht is made of: the project's data, read once, as plain values.

The report is DERIVED — nothing is bookkept as "already in the report". Every
preview and the one final rendering read the database afresh through
``collect_project_report_data`` and hand the renderer an immutable snapshot.
Keeping the collection apart from ReportLab means the sections and their
order can be asserted on data, and the renderer never touches a session.

Two things are left out on purpose, and the renderer says so on the page:
photos (a project's reports can carry hundreds — the finalized PDF would
not fit in memory; the count and the report number are enough to find
them) and finance figures (the stored PDF is readable by everyone with
project access; margins are not).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import (
    Attachment,
    ConstructionReport,
    ProjectActivity,
    ProjectClassAssignment,
    ProjectClassTemplate,
    ProjectMaterialNeed,
    ProjectMember,
    ProjectNote,
    Task,
    TaskAssignment,
    User,
    WerkstattConstructionBox,
)
from app.models.project import Project
from app.services.construction_report_pdf import format_work_done_for_report
from app.services.project_status import normalize_project_status

# The history the Verlauf section tells: how the project came to be, how its
# status moved, and when a report was stored. Task and file churn stay out —
# they have sections of their own, and as a timeline they would drown the
# status changes the reader is looking for.
VERLAUF_EVENT_TYPES: tuple[str, ...] = (
    "project.created",
    "project.state_changed",
    "project.report_finalized",
    "project.report_finalize_failed",
)

# Display names for the machine values the report prints. German only: the
# report is a document in the product's language, not a UI that follows the
# reader's setting.
PROJECT_STATUS_LABELS: dict[str, str] = {
    "angebotsphase": "Angebotsphase",
    "in_durchfuehrung": "In Durchführung",
    "rechnung_verschickt": "Rechnung verschickt",
    "abgeschlossen": "Abgeschlossen",
    "archived": "Archiviert",
    "archiviert": "Archiviert",
}

TASK_STATUS_LABELS: dict[str, str] = {
    "open": "Offen",
    "in_progress": "In Arbeit",
    "on_hold": "Pausiert",
    "overdue": "Überfällig",
    "done": "Erledigt",
}

MATERIAL_NEED_STATUS_LABELS: dict[str, str] = {
    "order": "Bestellen",
    "ordered": "Bestellt",
    "on_the_way": "Unterwegs",
    "available": "Verfügbar",
    "completed": "Erledigt",
}

SITE_ACCESS_LABELS: dict[str, str] = {
    "customer_on_site": "Kunde ist vor Ort",
    "freely_accessible": "frei zugänglich",
    "key_in_office": "Schlüssel im Büro",
    "key_pickup": "Schlüssel abholen bei",
    "code_access": "Zugang über Code",
    "key_box": "Schlüsselbox",
    "call_before_departure": "Anrufen vor Abfahrt",
}

ACTIVITY_LABELS: dict[str, str] = {
    "project.created": "Projekt erstellt",
    "project.state_changed": "Status geändert",
    "project.report_finalized": "Projektbericht finalisiert",
    "project.report_finalize_failed": "Projektbericht konnte nicht abgelegt werden",
}

# Files in the protected folder are for people with files:view_protected; the
# stored report is not. Same first-segment rule as workflow_helpers.
PROTECTED_FOLDER_SEGMENT = "verwaltung"

_IMAGE_EXTENSIONS = frozenset({"jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "avif"})


@dataclass(frozen=True)
class ReportCustomer:
    name: str
    address: str
    contact: str
    email: str
    phone: str


@dataclass(frozen=True)
class ReportMember:
    display_name: str
    can_manage: bool


@dataclass(frozen=True)
class ReportTask:
    title: str
    status_label: str
    due_date: date | None
    end_date: date | None
    assignees: tuple[str, ...]
    box: str
    is_done: bool


@dataclass(frozen=True)
class ReportNote:
    created_at: datetime
    author: str
    body: str


@dataclass(frozen=True)
class ReportWorker:
    name: str
    start_time: str
    end_time: str
    hours: float | None


@dataclass(frozen=True)
class ReportMaterialLine:
    item: str
    qty: str
    unit: str
    note: str


@dataclass(frozen=True)
class ReportConstructionReport:
    number: int | None
    report_date: date
    author: str
    workers: tuple[ReportWorker, ...]
    total_hours: float
    work_done: str
    materials_consumed: tuple[ReportMaterialLine, ...]
    materials_needed: tuple[ReportMaterialLine, ...]
    open_points: tuple[str, ...]
    office_rework: tuple[str, ...]
    incidents: tuple[str, ...]
    photo_count: int


@dataclass(frozen=True)
class ReportMaterialNeed:
    item: str
    article_no: str
    quantity: str
    unit: str
    status_label: str
    ordered_at: datetime | None


@dataclass(frozen=True)
class ReportFile:
    folder: str
    file_name: str
    created_at: datetime


@dataclass(frozen=True)
class ReportActivity:
    created_at: datetime
    label: str
    actor: str
    message: str


@dataclass(frozen=True)
class ProjectReportData:
    project_id: int
    project_number: str
    name: str
    status_label: str
    is_critical: bool
    critical_since: datetime | None
    created_at: datetime
    last_updated_at: datetime | None
    customer: ReportCustomer
    site_address: str
    site_access: str
    classes: tuple[str, ...]
    extra_attributes: tuple[tuple[str, str], ...]
    members: tuple[ReportMember, ...] = ()
    tasks: tuple[ReportTask, ...] = ()
    notes: tuple[ReportNote, ...] = ()
    construction_reports: tuple[ReportConstructionReport, ...] = ()
    material_needs: tuple[ReportMaterialNeed, ...] = ()
    files: tuple[ReportFile, ...] = ()
    activities: tuple[ReportActivity, ...] = field(default_factory=tuple)

    @property
    def open_task_count(self) -> int:
        return sum(1 for task in self.tasks if not task.is_done)

    @property
    def done_task_count(self) -> int:
        return sum(1 for task in self.tasks if task.is_done)


class ProjectNotFound(LookupError):
    """No project with that id — the caller answers 404."""


# ── Collection ───────────────────────────────────────────────────────────────


def collect_project_report_data(db: Session, project_id: int) -> ProjectReportData:
    """Read everything the report shows, in the order the report shows it."""
    project = db.get(Project, project_id)
    if project is None:
        raise ProjectNotFound(project_id)
    names = _UserNames(db)
    return ProjectReportData(
        project_id=project.id,
        project_number=project.project_number,
        name=project.name,
        status_label=project_status_label(project.status),
        is_critical=bool(project.is_critical),
        critical_since=project.critical_since,
        created_at=project.created_at,
        last_updated_at=project.last_updated_at,
        customer=ReportCustomer(
            name=_text(project.customer_name),
            address=_text(project.customer_address),
            contact=_text(project.customer_contact),
            email=_text(project.customer_email),
            phone=_text(project.customer_phone),
        ),
        site_address=_text(project.construction_site_address),
        site_access=site_access_display(project.site_access_type, project.site_access_note),
        classes=_class_names(db, project.id),
        extra_attributes=_extra_attribute_pairs(project.extra_attributes),
        members=_members(db, project.id, names),
        tasks=_tasks(db, project.id, names),
        notes=_notes(db, project.id, names),
        construction_reports=_construction_reports(db, project.id, names),
        material_needs=_material_needs(db, project.id),
        files=_files(db, project),
        activities=_activities(db, project.id, names),
    )


def project_status_label(raw: str | None) -> str:
    value = (raw or "").strip()
    if not value:
        return "—"
    normalized = normalize_project_status(value)
    return PROJECT_STATUS_LABELS.get(normalized.lower(), value)


def site_access_display(access_type: str | None, note: str | None) -> str:
    key = (access_type or "").strip().lower()
    label = SITE_ACCESS_LABELS.get(key, key)
    detail = _text(note)
    if label and detail:
        return f"{label}: {detail}"
    return label or detail


class _UserNames:
    """Display names looked up once per id — the sections share authors."""

    def __init__(self, db: Session) -> None:
        self._db = db
        self._cache: dict[int, str] = {}

    def of(self, user_id: int | None, *, fallback: str = "—") -> str:
        if user_id is None:
            return fallback
        if user_id not in self._cache:
            user = self._db.get(User, user_id)
            self._cache[user_id] = user.display_name if user else fallback
        return self._cache[user_id]

    def many(self, user_ids: list[int]) -> tuple[str, ...]:
        return tuple(self.of(user_id) for user_id in user_ids)


def _text(value: Any) -> str:
    return str(value or "").strip()


def _class_names(db: Session, project_id: int) -> tuple[str, ...]:
    rows = db.scalars(
        select(ProjectClassTemplate.name)
        .join(ProjectClassAssignment, ProjectClassAssignment.class_template_id == ProjectClassTemplate.id)
        .where(ProjectClassAssignment.project_id == project_id)
        .order_by(ProjectClassTemplate.name.asc())
    ).all()
    return tuple(rows)


def _extra_attribute_pairs(raw: Any) -> tuple[tuple[str, str], ...]:
    if not isinstance(raw, dict):
        return ()
    pairs = []
    for key in sorted(raw, key=lambda item: str(item).lower()):
        value = raw[key]
        if value is None or value == "":
            continue
        pairs.append((str(key), value if isinstance(value, str) else str(value)))
    return tuple(pairs)


def _members(db: Session, project_id: int, names: _UserNames) -> tuple[ReportMember, ...]:
    # Deliberate memberships only. Everyone is on every project by default
    # (is_default rows, so a fitter can open any job), and a report that
    # listed the whole company under "Team" for each project would say
    # nothing about who actually worked on it.
    rows = db.scalars(
        select(ProjectMember).where(ProjectMember.project_id == project_id, ProjectMember.is_default.is_(False))
    ).all()
    members = [ReportMember(display_name=names.of(row.user_id), can_manage=bool(row.can_manage)) for row in rows]
    # Managers first, then by name — the order the Team tab uses.
    members.sort(key=lambda member: (not member.can_manage, member.display_name.lower()))
    return tuple(members)


def _tasks(db: Session, project_id: int, names: _UserNames) -> tuple[ReportTask, ...]:
    tasks = db.scalars(
        select(Task)
        .where(Task.project_id == project_id)
        .order_by(Task.due_date.asc().nulls_last(), Task.id.asc())
    ).all()
    if not tasks:
        return ()
    assignees_by_task = _assignee_ids_by_task(db, tasks)
    boxes = _box_labels(db, tasks)
    out = []
    for task in tasks:
        status = (task.status or "").strip().lower()
        out.append(
            ReportTask(
                title=task.title,
                status_label=TASK_STATUS_LABELS.get(status, task.status or "—"),
                due_date=task.due_date,
                end_date=task.end_date,
                assignees=names.many(assignees_by_task.get(task.id, [])),
                box=boxes.get(task.construction_box_id or 0, ""),
                is_done=status == "done",
            )
        )
    return tuple(out)


def _assignee_ids_by_task(db: Session, tasks: list[Task]) -> dict[int, list[int]]:
    task_ids = [task.id for task in tasks]
    by_task: dict[int, list[int]] = {task_id: [] for task_id in task_ids}
    rows = db.execute(
        select(TaskAssignment.task_id, TaskAssignment.user_id)
        .where(TaskAssignment.task_id.in_(task_ids))
        .order_by(TaskAssignment.task_id.asc(), TaskAssignment.id.asc())
    ).all()
    for task_id, user_id in rows:
        by_task[task_id].append(user_id)
    # Rows written before the assignment table only carry assignee_id.
    for task in tasks:
        if not by_task[task.id] and task.assignee_id is not None:
            by_task[task.id] = [task.assignee_id]
    return by_task


def _box_labels(db: Session, tasks: list[Task]) -> dict[int, str]:
    box_ids = {task.construction_box_id for task in tasks if task.construction_box_id is not None}
    if not box_ids:
        return {}
    rows = db.scalars(select(WerkstattConstructionBox).where(WerkstattConstructionBox.id.in_(box_ids))).all()
    return {row.id: f"{row.box_number} · {row.label}" if row.label else row.box_number for row in rows}


def _notes(db: Session, project_id: int, names: _UserNames) -> tuple[ReportNote, ...]:
    rows = db.scalars(
        select(ProjectNote)
        .where(ProjectNote.project_id == project_id)
        .order_by(ProjectNote.created_at.asc(), ProjectNote.id.asc())
    ).all()
    return tuple(
        ReportNote(created_at=row.created_at, author=names.of(row.author_user_id), body=row.body) for row in rows
    )


def _construction_reports(
    db: Session, project_id: int, names: _UserNames
) -> tuple[ReportConstructionReport, ...]:
    reports = db.scalars(
        select(ConstructionReport)
        .where(ConstructionReport.project_id == project_id)
        .order_by(ConstructionReport.report_date.asc(), ConstructionReport.id.asc())
    ).all()
    if not reports:
        return ()
    photo_counts = _photo_counts(db, [report.id for report in reports])
    return tuple(
        _construction_report(report, author=names.of(report.user_id), photo_count=photo_counts.get(report.id, 0))
        for report in reports
    )


def _construction_report(report: ConstructionReport, *, author: str, photo_count: int) -> ReportConstructionReport:
    payload = report.payload if isinstance(report.payload, dict) else {}
    workers = tuple(_worker(row) for row in payload.get("workers") or [] if isinstance(row, dict))
    # Pre-v2.5.13 reports kept everything under "materials".
    consumed_raw = payload.get("materials_consumed") or payload.get("materials") or []
    return ReportConstructionReport(
        number=report.report_number,
        report_date=report.report_date,
        author=author,
        workers=workers,
        total_hours=sum(worker.hours or 0.0 for worker in workers),
        work_done=format_work_done_for_report(payload),
        materials_consumed=tuple(_material_line(row) for row in consumed_raw if isinstance(row, dict)),
        materials_needed=tuple(
            _material_line(row) for row in payload.get("materials_needed") or [] if isinstance(row, dict)
        ),
        open_points=_open_points(payload),
        office_rework=lines_of(payload.get("office_rework")),
        incidents=lines_of(payload.get("incidents")),
        photo_count=photo_count,
    )


def _worker(row: dict[str, Any]) -> ReportWorker:
    start = _text(row.get("start_time"))
    end = _text(row.get("end_time"))
    return ReportWorker(name=_text(row.get("name")) or "—", start_time=start, end_time=end, hours=worker_hours(start, end))


def _material_line(row: dict[str, Any]) -> ReportMaterialLine:
    return ReportMaterialLine(
        item=_text(row.get("item")) or "—",
        qty=_text(row.get("qty")),
        unit=_text(row.get("unit")),
        note=_text(row.get("note")),
    )


def _open_points(payload: dict[str, Any]) -> tuple[str, ...]:
    """Next steps and the extras the crew found — what the construction
    report's "Offene Arbeiten" box shows, without the office rework, which
    gets its own line here."""
    items = list(lines_of(payload.get("office_next_steps")))
    for extra in payload.get("extras") or []:
        if not isinstance(extra, dict):
            continue
        description = _text(extra.get("description"))
        reason = _text(extra.get("reason"))
        if description and reason:
            items.append(f"{description} ({reason})")
        elif description:
            items.append(description)
    return tuple(items)


def lines_of(text: Any) -> tuple[str, ...]:
    """A free-text field as bullet lines, with the crew's own bullets stripped."""
    if not text:
        return ()
    items = []
    for line in str(text).splitlines():
        cleaned = re.sub(r"^[-*•]\s*", "", line.strip())
        cleaned = re.sub(r"^\d+[.)]\s*", "", cleaned)
        if cleaned:
            items.append(cleaned)
    return tuple(items)


def worker_hours(start: str, end: str) -> float | None:
    """Hours between two clock strings as the crew types them (HH:MM, HH.MM,
    HHMM, HHh); None when either is missing, 0 when the shift crossed
    midnight or was typed backwards — never a negative."""
    begin = _parse_clock(start)
    finish = _parse_clock(end)
    if begin is None or finish is None:
        return None
    minutes = (finish[0] * 60 + finish[1]) - (begin[0] * 60 + begin[1])
    return max(minutes, 0) / 60.0


def _parse_clock(raw: str) -> tuple[int, int] | None:
    text = raw.strip()
    if not text:
        return None
    match = re.fullmatch(r"(\d{1,2})[:.h](\d{0,2})", text) or re.fullmatch(r"(\d{1,2})(\d{2})", text)
    if not match:
        return None
    hour, minute = int(match.group(1)), int(match.group(2) or "0")
    if 0 <= hour < 24 and 0 <= minute < 60:
        return (hour, minute)
    return None


def _photo_counts(db: Session, report_ids: list[int]) -> dict[int, int]:
    rows = db.execute(
        select(Attachment.construction_report_id, Attachment.content_type, Attachment.file_name).where(
            Attachment.construction_report_id.in_(report_ids)
        )
    ).all()
    counts: dict[int, int] = {}
    for report_id, content_type, file_name in rows:
        if report_id is None or not _looks_like_image(content_type, file_name):
            continue
        counts[report_id] = counts.get(report_id, 0) + 1
    return counts


def _looks_like_image(content_type: str | None, file_name: str | None) -> bool:
    if (content_type or "").strip().lower().startswith("image/"):
        return True
    extension = (file_name or "").rsplit(".", 1)[-1].lower() if "." in (file_name or "") else ""
    return extension in _IMAGE_EXTENSIONS


def _material_needs(db: Session, project_id: int) -> tuple[ReportMaterialNeed, ...]:
    rows = db.scalars(
        select(ProjectMaterialNeed)
        .where(ProjectMaterialNeed.project_id == project_id)
        .order_by(ProjectMaterialNeed.created_at.asc(), ProjectMaterialNeed.id.asc())
    ).all()
    return tuple(
        ReportMaterialNeed(
            item=row.item,
            article_no=_text(row.article_no),
            quantity=_text(row.quantity),
            unit=_text(row.unit),
            status_label=MATERIAL_NEED_STATUS_LABELS.get((row.status or "").strip().lower(), row.status or "—"),
            ordered_at=row.ordered_at,
        )
        for row in rows
    )


def _files(db: Session, project: Project) -> tuple[ReportFile, ...]:
    rows = db.scalars(
        select(Attachment)
        .where(Attachment.project_id == project.id)
        .order_by(Attachment.folder_path.asc(), Attachment.created_at.asc(), Attachment.id.asc())
    ).all()
    files = []
    for row in rows:
        # The report does not list itself, and never what the protected
        # folder holds — the PDF is read by people the folder is closed to.
        if row.id == project.report_attachment_id or _is_protected_folder(row.folder_path):
            continue
        files.append(ReportFile(folder=(row.folder_path or "").strip("/"), file_name=row.file_name, created_at=row.created_at))
    return tuple(files)


def _is_protected_folder(folder_path: str | None) -> bool:
    first = (folder_path or "").strip("/").split("/", 1)[0].strip().lower()
    return first == PROTECTED_FOLDER_SEGMENT


def _activities(db: Session, project_id: int, names: _UserNames) -> tuple[ReportActivity, ...]:
    rows = db.scalars(
        select(ProjectActivity)
        .where(ProjectActivity.project_id == project_id, ProjectActivity.event_type.in_(VERLAUF_EVENT_TYPES))
        .order_by(ProjectActivity.created_at.asc(), ProjectActivity.id.asc())
    ).all()
    return tuple(
        ReportActivity(
            created_at=row.created_at,
            label=ACTIVITY_LABELS.get(row.event_type, row.event_type),
            actor=names.of(row.actor_user_id),
            message=_activity_message(row),
        )
        for row in rows
    )


def _activity_message(row: ProjectActivity) -> str:
    """A status change reads as labels, not as the slugs the row stores."""
    details = row.details if isinstance(row.details, dict) else {}
    if row.event_type == "project.state_changed" and "to" in details:
        return f"{project_status_label(details.get('from'))} → {project_status_label(details.get('to'))}"
    return row.message or ""
