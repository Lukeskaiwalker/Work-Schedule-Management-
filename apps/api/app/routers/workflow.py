from __future__ import annotations
import json
import mimetypes
import os
import re
import unicodedata
from datetime import date, datetime, timedelta, timezone
from email.utils import format_datetime
from html import escape
from pathlib import Path, PurePosixPath
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from sqlalchemy import case, delete, func, or_, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.db import get_db
from app.core.deps import assert_project_access, get_current_user, require_permission
from app.core.permissions import has_permission
from app.core.time import utcnow
from app.models.entities import (
    Attachment,
    ChatThread,
    ChatThreadRead,
    ConstructionReport,
    ConstructionReportJob,
    JobTicket,
    Message,
    Project,
    ProjectActivity,
    ProjectClassAssignment,
    ProjectClassTemplate,
    ProjectFinance,
    ProjectMaterialNeed,
    ProjectWeatherCache,
    ProjectFolder,
    ProjectMember,
    SchoolAbsence,
    Site,
    Task,
    TaskAssignment,
    User,
    VacationRequest,
    WikiPage,
)
from app.schemas.api import (
    AssignableUserOut,
    ConstructionReportCreate,
    ConstructionReportPayload,
    JobTicketCreate,
    JobTicketOut,
    MessageOut,
    ProjectCreate,
    ProjectFinanceOut,
    ProjectFinanceUpdate,
    ProjectWeatherDayOut,
    ProjectWeatherOut,
    ProjectClassTemplateOut,
    ProjectMaterialNeedOut,
    ProjectMaterialNeedUpdate,
    ProjectOut,
    ProjectOverviewOut,
    ProjectUpdate,
    SiteCreate,
    SiteOut,
    TaskCreate,
    TaskOut,
    TaskUpdate,
    PlanningWeekOut,
    ProjectFolderCreate,
    ProjectFolderOut,
    ThreadCreate,
    ThreadOut,
    ThreadUpdate,
    ProjectActivityOut,
    WikiPageCreate,
    WikiLibraryFileOut,
    WikiPageOut,
    WikiPageUpdate,
)
from app.services.construction_report_pdf import build_report_filename
from app.services.files import (
    encrypted_file_plain_size,
    iter_encrypted_file_bytes,
    read_encrypted_file,
    store_encrypted_file,
)
from app.services.audit import log_admin_action
from app.services.report_jobs import (
    process_construction_report_job,
    queue_construction_report_job,
    report_processing_payload,
)
from app.services.runtime_settings import get_openweather_api_key
from app.core.security import verify_password

router = APIRouter(prefix="", tags=["workflow"])
settings = get_settings()
webdav_security = HTTPBasic(auto_error=False)
MAX_AVATAR_BYTES = 5 * 1024 * 1024
WEATHER_PROVIDER = "openweather"
WEATHER_MIN_REFRESH_SECONDS = 15 * 60
ADDRESS_COMMA_RE = re.compile(r",\s*")
ZIP_RE = re.compile(r"\b(\d{5})\b")
TASK_TYPE_ALIASES = {
    "construction": "construction",
    "site": "construction",
    "baustelle": "construction",
    "office": "office",
    "backoffice": "office",
    "buero": "office",
    "büro": "office",
    "customer_appointment": "customer_appointment",
    "customer-appointment": "customer_appointment",
    "customer appointment": "customer_appointment",
    "appointment": "customer_appointment",
    "kundentermin": "customer_appointment",
    "kundentermine": "customer_appointment",
    "termin": "customer_appointment",
}
PROJECT_SITE_ACCESS_OPTIONS = {
    "customer_on_site",
    "freely_accessible",
    "key_in_office",
    "key_pickup",
    "code_access",
    "key_box",
    "call_before_departure",
}
PROJECT_SITE_ACCESS_OPTIONS_WITH_NOTE = {"key_pickup", "code_access", "key_box"}
MATERIAL_NEED_STATUS_ALIASES = {
    "order": "order",
    "ordered": "order",
    "bestellen": "order",
    "bestellt": "order",
    "on_the_way": "on_the_way",
    "on-the-way": "on_the_way",
    "on the way": "on_the_way",
    "on its way": "on_the_way",
    "in_transit": "on_the_way",
    "unterwegs": "on_the_way",
    "available": "available",
    "verfuegbar": "available",
    "verfügbar": "available",
}


def _normalize_weather_address(raw: str | None) -> str:
    address = (raw or "").strip()
    if not address:
        return ""
    address = address.replace("\r", " ").replace("\n", ", ")
    address = ADDRESS_COMMA_RE.sub(", ", address)
    address = re.sub(r"(,\s*){2,}", ", ", address)
    address = re.sub(r"\s{2,}", " ", address)
    return address.strip(" ,")


def _weather_address_candidates(query_address: str) -> list[str]:
    base = _normalize_weather_address(query_address)
    if not base:
        return []
    candidates = [base]
    lower_base = base.lower()
    if "deutschland" not in lower_base and "germany" not in lower_base:
        candidates.append(f"{base}, Deutschland")
        candidates.append(f"{base}, Germany")
    unique: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = candidate.strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        unique.append(candidate.strip())
    return unique


def _weather_zip_candidates(query_address: str) -> list[str]:
    base = _normalize_weather_address(query_address).lower()
    if not base:
        return []
    zip_codes = ZIP_RE.findall(base)
    if not zip_codes:
        return []

    country_code = "DE"
    if "deutschland" in base or "germany" in base:
        country_code = "DE"

    seen: set[str] = set()
    candidates: list[str] = []
    for zip_code in zip_codes:
        key = f"{zip_code},{country_code}"
        if key in seen:
            continue
        seen.add(key)
        candidates.append(key)
    return candidates


def _normalize_project_site_access(access_type: str | None, access_note: str | None) -> tuple[str | None, str | None]:
    normalized_type = (access_type or "").strip()
    if not normalized_type:
        return None, None
    if normalized_type not in PROJECT_SITE_ACCESS_OPTIONS:
        raise HTTPException(status_code=400, detail="Invalid project site access type")
    normalized_note = (access_note or "").strip()
    if normalized_type not in PROJECT_SITE_ACCESS_OPTIONS_WITH_NOTE:
        normalized_note = ""
    return normalized_type, (normalized_note or None)
WEATHER_DAY_COUNT = 5


def _attachment_out(attachment: Attachment) -> dict:
    folder = (attachment.folder_path or "").strip("/")
    virtual_path = f"{folder}/{attachment.file_name}" if folder else attachment.file_name
    return {
        "id": attachment.id,
        "project_id": attachment.project_id,
        "folder": folder,
        "path": virtual_path,
        "file_name": attachment.file_name,
        "content_type": attachment.content_type,
        "created_at": attachment.created_at,
    }


def _ascii_fallback_filename(file_name: str) -> str:
    normalized = unicodedata.normalize("NFKD", file_name or "")
    ascii_name = normalized.encode("ascii", "ignore").decode("ascii")
    ascii_name = re.sub(r"[^\w.\- ]+", "_", ascii_name).strip().strip(".")
    return ascii_name or "file"


def _content_disposition(file_name: str, *, inline: bool) -> str:
    disposition = "inline" if inline else "attachment"
    fallback = _ascii_fallback_filename(file_name)
    encoded = quote(file_name or fallback, safe="")
    return f"{disposition}; filename=\"{fallback}\"; filename*=UTF-8''{encoded}"


def _safe_media_type(raw_content_type: str | None, *, fallback: str = "application/octet-stream") -> str:
    value = (raw_content_type or "").strip().lower()
    if ";" in value:
        value = value.split(";", 1)[0].strip()
    if not value or "/" not in value:
        return fallback
    main, sub = value.split("/", 1)
    token_re = re.compile(r"^[a-z0-9!#$&^_.+-]+$")
    if not token_re.match(main) or not token_re.match(sub):
        return fallback
    return f"{main}/{sub}"


def _resolve_attachment_for_access(db: Session, current_user: User, attachment_id: int) -> Attachment:
    attachment = db.get(Attachment, attachment_id)
    if not attachment:
        raise HTTPException(status_code=404, detail="File not found")
    if attachment.project_id is not None:
        assert_project_access(db, current_user, attachment.project_id)
        folder = _normalize_project_folder_path(attachment.folder_path, allow_empty=True)
        if _folder_path_is_protected(folder) and not _can_access_project_protected_folder(current_user):
            raise HTTPException(status_code=403, detail="File access denied")
    elif attachment.construction_report_id is not None and not (
        has_permission(current_user.role, "reports:manage")
        or has_permission(current_user.role, "reports:view")
        or has_permission(current_user.role, "reports:create")
    ):
        raise HTTPException(status_code=403, detail="Report access denied")
    return attachment


def _attachment_bytes_or_http_error(attachment: Attachment) -> bytes:
    try:
        return read_encrypted_file(attachment.stored_path)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Stored file payload not found")
    except OSError:
        raise HTTPException(status_code=404, detail="Stored file payload not accessible")
    except RuntimeError:
        raise HTTPException(status_code=409, detail="Stored file payload cannot be decrypted with current key")


def _attachment_content_length_for_listing(attachment: Attachment) -> str:
    """Best-effort file size for WebDAV PROPFIND responses."""
    try:
        chunked_plain_size = encrypted_file_plain_size(attachment.stored_path)
    except (FileNotFoundError, OSError, RuntimeError):
        return "0"
    if chunked_plain_size is not None:
        return str(max(0, int(chunked_plain_size)))
    try:
        encrypted_size = os.path.getsize(attachment.stored_path)
    except OSError:
        return "0"
    return str(max(0, int(encrypted_size)))


def _attachment_http_response(
    attachment: Attachment,
    *,
    inline: bool,
    include_dav_headers: bool = False,
    head_only: bool = False,
) -> Response:
    media_type = _safe_media_type(attachment.content_type)
    headers = {
        "Content-Disposition": _content_disposition(attachment.file_name, inline=inline),
        "X-Content-Type-Options": "nosniff",
    }
    if include_dav_headers:
        headers.update(_dav_headers())
    try:
        chunked_plain_size = encrypted_file_plain_size(attachment.stored_path)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Stored file payload not found")
    except OSError:
        raise HTTPException(status_code=404, detail="Stored file payload not accessible")
    except RuntimeError:
        raise HTTPException(status_code=409, detail="Stored file payload cannot be decrypted with current key")

    if chunked_plain_size is not None:
        if int(chunked_plain_size) <= 0:
            raise HTTPException(status_code=409, detail="Stored file payload is empty; please re-upload the file")
        headers["Content-Length"] = str(chunked_plain_size)
        if head_only:
            return Response(status_code=200, media_type=media_type, headers=headers)
        return StreamingResponse(
            iter_encrypted_file_bytes(attachment.stored_path),
            media_type=media_type,
            headers=headers,
        )

    data = _attachment_bytes_or_http_error(attachment)
    if len(data) == 0:
        raise HTTPException(status_code=409, detail="Stored file payload is empty; please re-upload the file")
    headers["Content-Length"] = str(len(data))
    if head_only:
        return Response(status_code=200, media_type=media_type, headers=headers)
    return Response(content=data, media_type=media_type, headers=headers)


def _avatar_bytes_or_http_error(stored_path: str) -> bytes:
    try:
        return read_encrypted_file(stored_path)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Avatar file not found")
    except OSError:
        raise HTTPException(status_code=404, detail="Avatar file not accessible")
    except RuntimeError:
        raise HTTPException(status_code=409, detail="Avatar file cannot be decrypted with current key")


def _slugify(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value or "").encode("ascii", "ignore").decode("ascii")
    normalized = normalized.lower()
    slug = re.sub(r"[^a-z0-9]+", "-", normalized).strip("-")
    return slug or "wiki-page"


def _unique_wiki_slug(db: Session, title: str, *, exclude_page_id: int | None = None) -> str:
    base = _slugify(title)
    slug = base
    counter = 2
    while True:
        stmt = select(WikiPage.id).where(WikiPage.slug == slug)
        if exclude_page_id is not None:
            stmt = stmt.where(WikiPage.id != exclude_page_id)
        conflict = db.scalars(stmt).first()
        if not conflict:
            return slug
        slug = f"{base}-{counter}"
        counter += 1


def _wiki_root_dir() -> Path:
    return Path(settings.wiki_root_dir).expanduser().resolve()


def _wiki_previewable_mime(media_type: str) -> bool:
    return (
        media_type.startswith("image/")
        or media_type.startswith("text/")
        or media_type == "application/pdf"
    )


def _sanitize_wiki_relative_path(raw_path: str) -> str:
    normalized = (raw_path or "").strip().replace("\\", "/")
    normalized = normalized.lstrip("/")
    if not normalized:
        raise HTTPException(status_code=400, detail="Path is required")
    parts: list[str] = []
    for part in PurePosixPath(normalized).parts:
        if part in {"", "."}:
            continue
        if part == "..":
            raise HTTPException(status_code=400, detail="Invalid wiki path")
        parts.append(part)
    if not parts:
        raise HTTPException(status_code=400, detail="Path is required")
    return "/".join(parts)


def _resolve_wiki_file_path(raw_path: str) -> tuple[Path, str]:
    root = _wiki_root_dir()
    if not root.exists() or not root.is_dir():
        raise HTTPException(status_code=404, detail="Wiki library is not available")

    relative_path = _sanitize_wiki_relative_path(raw_path)
    candidate = (root / Path(*relative_path.split("/"))).resolve()
    if not candidate.is_relative_to(root):
        raise HTTPException(status_code=400, detail="Invalid wiki path")

    if candidate.is_dir():
        index_file = (candidate / "index.html").resolve()
        if index_file.is_file() and index_file.is_relative_to(root):
            relative_index = str(index_file.relative_to(root)).replace(os.sep, "/")
            return index_file, relative_index
        raise HTTPException(status_code=404, detail="Wiki file not found")

    if not candidate.exists() or not candidate.is_file():
        raise HTTPException(status_code=404, detail="Wiki file not found")

    return candidate, str(candidate.relative_to(root)).replace(os.sep, "/")


def _scan_wiki_library_files(root: Path) -> list[WikiLibraryFileOut]:
    files: list[WikiLibraryFileOut] = []
    for file_path in root.rglob("*"):
        if not file_path.is_file():
            continue
        try:
            relative = file_path.relative_to(root)
        except ValueError:
            continue
        parts = list(relative.parts)
        if not parts:
            continue
        if len(parts) < 2:
            # Ignore technical helper files in wiki root; keep brand/folder documents only.
            continue
        if any(part.startswith(".") for part in parts):
            continue
        brand = parts[0]
        folder = "/".join(parts[1:-1])
        file_name = file_path.name
        extension = file_path.suffix.lower().lstrip(".")
        stem = file_path.stem
        guessed = mimetypes.guess_type(file_name)[0]
        media_type = _safe_media_type(guessed, fallback="application/octet-stream")
        stat = file_path.stat()
        files.append(
            WikiLibraryFileOut(
                path=str(relative).replace(os.sep, "/"),
                brand=brand,
                folder=folder,
                stem=stem,
                extension=extension,
                file_name=file_name,
                mime_type=media_type,
                previewable=_wiki_previewable_mime(media_type),
                size_bytes=stat.st_size,
                modified_at=datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc),
            )
        )
    files.sort(
        key=lambda item: (
            item.brand.lower(),
            item.folder.lower(),
            item.stem.lower(),
            item.extension.lower(),
            item.file_name.lower(),
        )
    )
    return files


def _message_out(db: Session, message: Message) -> MessageOut:
    attachments = db.scalars(
        select(Attachment).where(Attachment.message_id == message.id).order_by(Attachment.created_at.asc())
    ).all()
    return MessageOut(
        id=message.id,
        thread_id=message.thread_id,
        sender_id=message.sender_id,
        body=message.body,
        created_at=message.created_at,
        attachments=[
            {
                "id": attachment.id,
                "file_name": attachment.file_name,
                "content_type": attachment.content_type,
                "created_at": attachment.created_at,
            }
            for attachment in attachments
        ],
    )


def _can_edit_thread(user: User, thread: ChatThread) -> bool:
    return has_permission(user.role, "chat:manage") or (thread.created_by is not None and thread.created_by == user.id)


def _thread_unread_count(db: Session, thread_id: int, user_id: int) -> int:
    read_state = db.scalars(
        select(ChatThreadRead).where(ChatThreadRead.thread_id == thread_id, ChatThreadRead.user_id == user_id)
    ).first()
    stmt = select(func.count(Message.id)).where(Message.thread_id == thread_id, Message.sender_id != user_id)
    if read_state and read_state.last_read_message_id:
        stmt = stmt.where(Message.id > read_state.last_read_message_id)
    return int(db.scalar(stmt) or 0)


def _mark_thread_read(
    db: Session,
    *,
    thread_id: int,
    user_id: int,
    last_message_id: int | None,
    commit: bool,
) -> None:
    state = db.scalars(
        select(ChatThreadRead).where(ChatThreadRead.thread_id == thread_id, ChatThreadRead.user_id == user_id)
    ).first()
    now = utcnow()
    if not state:
        db.add(
            ChatThreadRead(
                thread_id=thread_id,
                user_id=user_id,
                last_read_message_id=last_message_id,
                last_read_at=now,
            )
        )
    else:
        state.last_read_message_id = last_message_id
        state.last_read_at = now
    if commit:
        db.commit()


def _thread_out(db: Session, thread: ChatThread, current_user: User) -> ThreadOut:
    messages = db.scalars(select(Message).where(Message.thread_id == thread.id).order_by(Message.created_at.desc())).all()
    last_message = messages[0] if messages else None
    project_name: str | None = None
    if thread.project_id is not None:
        project = db.get(Project, thread.project_id)
        project_name = project.name if project else None
    return ThreadOut(
        id=thread.id,
        name=thread.name,
        created_by=thread.created_by,
        project_id=thread.project_id,
        project_name=project_name,
        site_id=thread.site_id,
        icon_updated_at=thread.icon_updated_at,
        message_count=len(messages),
        unread_count=_thread_unread_count(db, thread.id, current_user.id),
        last_message_at=last_message.created_at if last_message else None,
        last_message_preview=(last_message.body or "")[:80] if last_message and last_message.body else None,
        can_edit=_can_edit_thread(current_user, thread),
    )


def _chat_permission_allowed(user: User) -> bool:
    return has_permission(user.role, "chat:manage") or has_permission(user.role, "chat:project")


def _assert_thread_access(db: Session, user: User, thread: ChatThread) -> None:
    if not _chat_permission_allowed(user):
        raise HTTPException(status_code=403, detail="Chat access denied")
    if thread.project_id is not None:
        assert_project_access(db, user, thread.project_id)


def _thread_visible_to_user(db: Session, user: User, thread: ChatThread) -> bool:
    if not _chat_permission_allowed(user):
        return False
    if thread.project_id is None:
        return True
    try:
        assert_project_access(db, user, thread.project_id)
        return True
    except HTTPException:
        return False


def _webdav_authenticate(credentials: HTTPBasicCredentials | None, db: Session) -> User:
    auth_header = {'WWW-Authenticate': 'Basic realm="SMPL WebDAV", charset="UTF-8"'}
    if credentials is None:
        raise HTTPException(status_code=401, detail="WebDAV authentication required", headers=auth_header)

    username_raw = (credentials.username or "").strip()
    candidates: list[str] = []
    if username_raw:
        candidates.append(username_raw)
        if "\\" in username_raw:
            candidates.append(username_raw.split("\\")[-1].strip())
        if "/" in username_raw:
            candidates.append(username_raw.split("/")[-1].strip())

    user: User | None = None
    for candidate in candidates:
        if not candidate:
            continue
        user = db.scalars(select(User).where(func.lower(User.email) == candidate.lower())).first()
        if user:
            break

    if not user or not user.is_active or not verify_password(credentials.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid WebDAV credentials", headers=auth_header)
    return user


def _dav_headers() -> dict[str, str]:
    return {
        "DAV": "1, 2",
        "Allow": "OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL",
        "MS-Author-Via": "DAV",
    }


def _rfc1123(dt: datetime | None) -> str:
    if not dt:
        dt = datetime.now(timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return format_datetime(dt)


def _dav_multistatus(responses: list[dict[str, str]]) -> Response:
    parts = ['<?xml version="1.0" encoding="utf-8"?>', '<D:multistatus xmlns:D="DAV:">']
    for response in responses:
        parts.extend(
            [
                "<D:response>",
                f"<D:href>{escape(response['href'])}</D:href>",
                "<D:propstat>",
                "<D:prop>",
                f"<D:displayname>{escape(response['displayname'])}</D:displayname>",
                response["resourcetype_xml"],
                f"<D:getlastmodified>{escape(response['last_modified'])}</D:getlastmodified>",
                f"<D:getcontentlength>{escape(response['content_length'])}</D:getcontentlength>",
                f"<D:getcontenttype>{escape(response['content_type'])}</D:getcontenttype>",
                "</D:prop>",
                "<D:status>HTTP/1.1 200 OK</D:status>",
                "</D:propstat>",
                "</D:response>",
            ]
        )
    parts.append("</D:multistatus>")
    return Response("".join(parts), status_code=207, media_type="application/xml", headers=_dav_headers())


DEFAULT_PROJECT_FOLDERS: list[tuple[str, bool]] = [
    ("Bilder", False),
    ("Anträge", False),
    ("Berichte", False),
    ("Tickets", False),
    ("Verwaltung", True),
]
DEFAULT_GENERAL_REPORT_FOLDERS: list[str] = ["Bilder", "Berichte"]
PROJECT_FOLDER_PRIVILEGED_ROLES = {"admin", "ceo", "planning", "accountant"}
WEBDAV_ARCHIVE_SEGMENT = "archive"
WEBDAV_ARCHIVE_DISPLAY = "Archive"
WEBDAV_GENERAL_SEGMENT = "general-projects"
WEBDAV_GENERAL_DISPLAY = "General Projects"


def _can_access_project_protected_folder(user: User) -> bool:
    return user.role in PROJECT_FOLDER_PRIVILEGED_ROLES


def _normalize_project_folder_path(raw_value: str | None, *, allow_empty: bool = False) -> str:
    raw = (raw_value or "").strip().replace("\\", "/")
    raw = raw.strip("/")
    if not raw:
        if allow_empty:
            return ""
        raise HTTPException(status_code=400, detail="Folder path is required")
    parts: list[str] = []
    for part in raw.split("/"):
        segment = part.strip()
        if not segment:
            continue
        if segment in {".", ".."}:
            raise HTTPException(status_code=400, detail="Invalid folder path")
        parts.append(segment)
    if not parts:
        if allow_empty:
            return ""
        raise HTTPException(status_code=400, detail="Folder path is required")
    return "/".join(parts)


def _folder_path_is_protected(folder_path: str) -> bool:
    normalized = _normalize_project_folder_path(folder_path, allow_empty=True)
    if not normalized:
        return False
    first_segment = normalized.split("/", 1)[0].strip().lower()
    return first_segment == "verwaltung"


def _folder_visible_to_user(user: User, folder_path: str, is_protected: bool) -> bool:
    if not folder_path:
        return True
    return (not is_protected) or _can_access_project_protected_folder(user)


def _ensure_project_default_folders(db: Session, project_id: int, created_by: int | None = None) -> None:
    existing_paths = set(
        db.scalars(select(ProjectFolder.path).where(ProjectFolder.project_id == project_id)).all()
    )
    changed = False
    for path, is_protected in DEFAULT_PROJECT_FOLDERS:
        if path in existing_paths:
            continue
        db.add(
            ProjectFolder(
                project_id=project_id,
                path=path,
                is_protected=is_protected,
                created_by=created_by,
            )
        )
        changed = True
    if changed:
        db.flush()


def _register_project_folder(
    db: Session,
    *,
    project_id: int,
    folder_path: str,
    created_by: int | None = None,
) -> None:
    normalized = _normalize_project_folder_path(folder_path, allow_empty=True)
    if not normalized:
        return
    cumulative: list[str] = []
    for segment in normalized.split("/"):
        cumulative.append(segment)
        path_value = "/".join(cumulative)
        exists = db.scalars(
            select(ProjectFolder.id).where(ProjectFolder.project_id == project_id, ProjectFolder.path == path_value)
        ).first()
        if exists:
            continue
        db.add(
            ProjectFolder(
                project_id=project_id,
                path=path_value,
                is_protected=_folder_path_is_protected(path_value),
                created_by=created_by,
            )
        )


def _project_folder_paths_for_user(db: Session, project_id: int, user: User) -> set[str]:
    folder_rows = db.scalars(select(ProjectFolder).where(ProjectFolder.project_id == project_id)).all()
    visible_paths: set[str] = set()
    for path_value, protected in DEFAULT_PROJECT_FOLDERS:
        if _folder_visible_to_user(user, path_value, protected):
            visible_paths.add(path_value)
    for row in folder_rows:
        if _folder_visible_to_user(user, row.path, row.is_protected):
            visible_paths.add(row.path)
    attachment_rows = db.scalars(
        select(Attachment.folder_path).where(Attachment.project_id == project_id, Attachment.folder_path != "")
    ).all()
    for value in attachment_rows:
        normalized = _normalize_project_folder_path(str(value), allow_empty=True)
        if not normalized:
            continue
        segments = normalized.split("/")
        for idx in range(1, len(segments) + 1):
            path_value = "/".join(segments[:idx])
            if _folder_path_is_protected(path_value) and not _can_access_project_protected_folder(user):
                continue
            visible_paths.add(path_value)
    return visible_paths


def _attachment_virtual_path(attachment: Attachment) -> str:
    folder = _normalize_project_folder_path(attachment.folder_path, allow_empty=True)
    return f"{folder}/{attachment.file_name}" if folder else attachment.file_name


def _latest_project_file_by_path(db: Session, project_id: int, user: User) -> dict[str, Attachment]:
    rows = db.scalars(
        select(Attachment).where(Attachment.project_id == project_id).order_by(Attachment.created_at.desc(), Attachment.id.desc())
    ).all()
    by_path: dict[str, Attachment] = {}
    for row in rows:
        folder = _normalize_project_folder_path(row.folder_path, allow_empty=True)
        is_protected = _folder_path_is_protected(folder)
        if not _folder_visible_to_user(user, folder, is_protected):
            continue
        path_value = _attachment_virtual_path(row)
        by_path.setdefault(path_value, row)
    return by_path


def _projects_visible_to_user(db: Session, user: User) -> list[Project]:
    if user.role in {"admin", "ceo", "planning", "accountant"}:
        return list(db.scalars(select(Project).order_by(Project.id.asc())).all())

    member_project_ids = db.scalars(
        select(ProjectMember.project_id).where(ProjectMember.user_id == user.id)
    ).all()
    if not member_project_ids:
        return []

    return list(
        db.scalars(select(Project).where(Project.id.in_(member_project_ids)).order_by(Project.id.asc())).all()
    )


def _project_ids_visible_to_user(db: Session, user: User) -> set[int]:
    return {project.id for project in _projects_visible_to_user(db, user)}


def _project_webdav_ref(project: Project) -> str:
    number = (project.project_number or "").strip()
    if number:
        return number
    return str(project.id)


def _resolve_project_by_webdav_ref(db: Session, project_ref: str) -> Project:
    normalized = (project_ref or "").strip()
    if not normalized:
        raise HTTPException(status_code=404, detail="Project not found")

    by_number = db.scalars(select(Project).where(Project.project_number == normalized)).first()
    if by_number:
        return by_number

    if normalized.isdigit():
        by_id = db.get(Project, int(normalized))
        if by_id:
            return by_id

    raise HTTPException(status_code=404, detail="Project not found")


def _is_project_archived(project: Project) -> bool:
    normalized = (project.status or "").strip().lower()
    if not normalized:
        return False
    return normalized == "archived" or normalized == "archiviert" or "archiv" in normalized


def _active_projects_visible_to_user(db: Session, user: User) -> list[Project]:
    return [project for project in _projects_visible_to_user(db, user) if not _is_project_archived(project)]


def _archived_projects_visible_to_user(db: Session, user: User) -> list[Project]:
    return [project for project in _projects_visible_to_user(db, user) if _is_project_archived(project)]


def _project_webdav_display_name(project: Project) -> str:
    customer = (project.customer_name or "").strip()
    number = (project.project_number or "").strip()
    name = (project.name or "").strip()
    if number and customer:
        return f"{number} - {customer}"
    if customer:
        return customer
    if number and name:
        return f"{number} {name}"
    return number or name or "project"


def _auto_folder_for_upload(file_name: str, content_type: str | None) -> str:
    lowered_content_type = (content_type or "").strip().lower()
    lowered_name = (file_name or "").strip().lower()
    if lowered_content_type.startswith("image/"):
        return "Bilder"
    if lowered_content_type == "application/pdf" or lowered_name.endswith(".pdf"):
        return "Berichte"
    return ""


def _resolve_project_upload_folder(raw_folder: str, file_name: str, content_type: str | None) -> str:
    raw = (raw_folder or "").strip()
    if raw == "/":
        return ""
    normalized = _normalize_project_folder_path(raw, allow_empty=True)
    if normalized:
        return normalized
    return _auto_folder_for_upload(file_name, content_type)


def _touch_project_last_update(db: Session, project_id: int, *, touch_time: datetime | None = None) -> None:
    project = db.get(Project, project_id)
    if not project:
        return
    project.last_updated_at = touch_time or utcnow()
    db.add(project)


def _normalized_timestamp(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is not None:
        return value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def _assert_optimistic_timestamp(
    *,
    expected: datetime | None,
    current: datetime | None,
    conflict_detail: str,
) -> None:
    if _normalized_timestamp(expected) == _normalized_timestamp(current):
        return
    raise HTTPException(status_code=409, detail=conflict_detail)


def _record_project_activity(
    db: Session,
    *,
    project_id: int,
    actor_user_id: int | None,
    event_type: str,
    message: str,
    details: dict | None = None,
) -> None:
    now = utcnow()
    db.add(
        ProjectActivity(
            project_id=project_id,
            actor_user_id=actor_user_id,
            event_type=event_type,
            message=message[:255],
            details=details or {},
            created_at=now,
        )
    )
    _touch_project_last_update(db, project_id, touch_time=now)


def _project_finance_row_or_default(db: Session, project_id: int) -> ProjectFinanceOut:
    row = db.get(ProjectFinance, project_id)
    if row:
        return ProjectFinanceOut.model_validate(row)
    return ProjectFinanceOut(project_id=project_id)


def _parse_report_clock_minutes(raw_value: object) -> int | None:
    text = str(raw_value or "").strip()
    if not text:
        return None
    hour: int
    minute: int
    match = re.fullmatch(r"(\d{1,2}):(\d{1,2})", text)
    if match:
        try:
            hour = int(match.group(1))
            minute = int(match.group(2))
        except Exception:
            return None
    else:
        digits = re.sub(r"\D", "", text)
        if len(digits) == 3:
            digits = f"0{digits}"
        if len(digits) < 4:
            return None
        try:
            hour = int(digits[:2])
            minute = int(digits[2:4])
        except Exception:
            return None
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        return None
    return hour * 60 + minute


def _report_image_extension(filename: str, content_type: str | None) -> str:
    if "." in filename:
        guessed = filename.rsplit(".", 1)[-1].strip().lower()
        if guessed:
            return guessed
    normalized_type = str(content_type or "").split(";", 1)[0].strip().lower()
    if normalized_type:
        guessed_extension = mimetypes.guess_extension(normalized_type)
        if guessed_extension:
            return guessed_extension.lstrip(".")
        if normalized_type.startswith("image/"):
            image_extension = normalized_type.split("/", 1)[1].strip()
            if image_extension:
                return image_extension
    return "bin"


def _report_image_filename(upload: UploadFile, index: int) -> str:
    raw_name = str(getattr(upload, "filename", "") or "").strip()
    file_name = raw_name.replace("\\", "/").split("/")[-1]
    extension = _report_image_extension(file_name, getattr(upload, "content_type", None))
    if file_name:
        if "." not in file_name or not file_name.rsplit(".", 1)[-1].strip():
            return f"{file_name}.{extension}"
        return file_name
    return f"report-photo-{index}.{extension}"


def _construction_report_worker_hours(payload: dict) -> float:
    workers = payload.get("workers")
    if not isinstance(workers, list):
        return 0.0
    total_minutes = 0
    for worker in workers:
        if not isinstance(worker, dict):
            continue
        start_minutes = _parse_report_clock_minutes(worker.get("start_time"))
        end_minutes = _parse_report_clock_minutes(worker.get("end_time"))
        if start_minutes is None or end_minutes is None:
            continue
        duration = end_minutes - start_minutes
        if duration <= 0 or duration > 24 * 60:
            continue
        total_minutes += duration
    return round(total_minutes / 60, 2)


def _accumulate_project_reported_hours(db: Session, *, project_id: int, reported_hours: float) -> None:
    if reported_hours <= 0:
        return
    finance_row = db.get(ProjectFinance, project_id)
    if finance_row is None:
        finance_row = ProjectFinance(project_id=project_id, reported_hours_total=0.0)
        db.add(finance_row)
        db.flush()
    finance_row.reported_hours_total = round(float(finance_row.reported_hours_total or 0.0) + float(reported_hours), 2)
    db.add(finance_row)


def _normalize_material_need_status(raw_value: str | None, *, default: str = "order", strict: bool = False) -> str:
    normalized = str(raw_value or "").strip().lower()
    if not normalized:
        return default
    mapped = MATERIAL_NEED_STATUS_ALIASES.get(normalized)
    if mapped:
        return mapped
    if strict:
        raise HTTPException(status_code=400, detail="Invalid material status")
    return default


def _parse_office_material_need_items(raw_value: object) -> list[str]:
    raw = str(raw_value or "").replace("\r", "\n")
    if not raw.strip():
        return []

    items: list[str] = []
    seen: set[str] = set()
    for line in raw.split("\n"):
        cleaned_line = re.sub(r"\s{2,}", " ", line).strip().strip("-*•")
        if not cleaned_line:
            continue
        parts = re.split(r"[;,]", cleaned_line)
        for part in parts:
            item = re.sub(r"\s{2,}", " ", part).strip().strip("-*•")
            if not item:
                continue
            key = item.lower()
            if key in seen:
                continue
            seen.add(key)
            items.append(item)
    return items


def _create_material_needs_from_report_payload(
    db: Session,
    *,
    project_id: int,
    report_id: int,
    payload: dict,
    actor_user_id: int | None,
) -> int:
    items = _parse_office_material_need_items(payload.get("office_material_need"))
    if not items:
        return 0
    created_count = 0
    for item in items:
        db.add(
            ProjectMaterialNeed(
                project_id=project_id,
                construction_report_id=report_id,
                item=item,
                status="order",
                created_by=actor_user_id,
                updated_by=actor_user_id,
            )
        )
        created_count += 1
    return created_count


def _project_material_need_out(
    row: ProjectMaterialNeed,
    *,
    project: Project,
    report: ConstructionReport | None,
) -> ProjectMaterialNeedOut:
    return ProjectMaterialNeedOut(
        id=row.id,
        project_id=row.project_id,
        project_number=project.project_number,
        project_name=project.name,
        customer_name=project.customer_name,
        construction_report_id=row.construction_report_id,
        report_date=report.report_date if report else None,
        item=row.item,
        status=_normalize_material_need_status(row.status),
        created_by=row.created_by,
        updated_by=row.updated_by,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _recent_project_activities_out(db: Session, project_id: int, *, limit: int = 10) -> list[ProjectActivityOut]:
    rows = db.scalars(
        select(ProjectActivity)
        .where(ProjectActivity.project_id == project_id)
        .order_by(ProjectActivity.created_at.desc(), ProjectActivity.id.desc())
        .limit(limit)
    ).all()
    actor_ids = sorted({row.actor_user_id for row in rows if row.actor_user_id is not None})
    actor_names_by_id: dict[int, str] = {}
    if actor_ids:
        users = db.scalars(select(User).where(User.id.in_(actor_ids))).all()
        actor_names_by_id = {user.id: user.full_name for user in users}
    return [
        ProjectActivityOut(
            id=row.id,
            project_id=row.project_id,
            actor_user_id=row.actor_user_id,
            actor_name=actor_names_by_id.get(row.actor_user_id or 0),
            event_type=row.event_type,
            message=row.message,
            details=row.details or {},
            created_at=row.created_at,
        )
        for row in rows
    ]


def _effective_openweather_api_key(db: Session) -> str:
    runtime_key = get_openweather_api_key(db)
    if runtime_key:
        return runtime_key
    return (settings.openweather_api_key or "").strip()


def _normalize_openweather_5day(rows: list[dict], *, timezone_offset_seconds: int = 0) -> list[dict]:
    grouped: dict[str, dict] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        raw_dt = row.get("dt")
        try:
            local_dt = datetime.fromtimestamp(int(raw_dt) + int(timezone_offset_seconds), tz=timezone.utc)
        except Exception:
            continue

        day_key = local_dt.date().isoformat()
        day_bucket = grouped.setdefault(
            day_key,
            {
                "date": day_key,
                "temp_min": None,
                "temp_max": None,
                "precipitation_probability": None,
                "wind_speed": None,
                "best_distance": None,
                "description": None,
                "icon": None,
            },
        )

        main = row.get("main") if isinstance(row.get("main"), dict) else {}
        temp_min = main.get("temp_min")
        temp_max = main.get("temp_max")
        if isinstance(temp_min, (int, float)):
            temp_min_value = float(temp_min)
            day_bucket["temp_min"] = (
                temp_min_value
                if day_bucket["temp_min"] is None
                else min(float(day_bucket["temp_min"]), temp_min_value)
            )
        if isinstance(temp_max, (int, float)):
            temp_max_value = float(temp_max)
            day_bucket["temp_max"] = (
                temp_max_value
                if day_bucket["temp_max"] is None
                else max(float(day_bucket["temp_max"]), temp_max_value)
            )

        pop_value = row.get("pop")
        if isinstance(pop_value, (int, float)):
            pop_percent = float(pop_value) * 100 if float(pop_value) <= 1 else float(pop_value)
            day_bucket["precipitation_probability"] = (
                round(pop_percent, 1)
                if day_bucket["precipitation_probability"] is None
                else max(float(day_bucket["precipitation_probability"]), round(pop_percent, 1))
            )

        wind = row.get("wind") if isinstance(row.get("wind"), dict) else {}
        wind_speed = wind.get("speed")
        if isinstance(wind_speed, (int, float)):
            wind_value = float(wind_speed)
            day_bucket["wind_speed"] = (
                wind_value
                if day_bucket["wind_speed"] is None
                else max(float(day_bucket["wind_speed"]), wind_value)
            )

        weather_rows = row.get("weather")
        weather_info = weather_rows[0] if isinstance(weather_rows, list) and weather_rows else {}
        weather_desc = (str(weather_info.get("description") or weather_info.get("main") or "").strip() or None)
        weather_icon = (str(weather_info.get("icon") or "").strip() or None)
        hour_distance = abs(local_dt.hour - 12)
        best_distance = day_bucket["best_distance"]
        if best_distance is None or hour_distance < int(best_distance):
            day_bucket["best_distance"] = hour_distance
            day_bucket["description"] = weather_desc
            day_bucket["icon"] = weather_icon

    normalized: list[dict] = []
    for day_key in sorted(grouped.keys())[:WEATHER_DAY_COUNT]:
        bucket = grouped[day_key]
        normalized.append(
            {
                "date": bucket["date"],
                "temp_min": bucket["temp_min"],
                "temp_max": bucket["temp_max"],
                "description": bucket["description"],
                "icon": bucket["icon"],
                "precipitation_probability": bucket["precipitation_probability"],
                "wind_speed": bucket["wind_speed"],
            }
        )
    return normalized


def _openweather_error_message(response: httpx.Response, *, context: str) -> str:
    message = ""
    try:
        payload = response.json()
    except Exception:
        payload = None
    if isinstance(payload, dict):
        raw_msg = payload.get("message") or payload.get("detail")
        if raw_msg is not None:
            message = str(raw_msg).strip()
    if not message:
        message = (response.text or "").strip()
    if not message:
        message = f"HTTP {response.status_code}"
    return f"{context}: {message}"


def _sanitize_weather_language(value: str | None) -> str:
    language = (value or "").strip().lower()
    if language.startswith("de"):
        return "de"
    return "en"


def _fetch_openweather_forecast(*, api_key: str, query_address: str, language: str = "en") -> tuple[float, float, list[dict]]:
    weather_language = _sanitize_weather_language(language)
    timeout = httpx.Timeout(12.0, connect=5.0)
    with httpx.Client(timeout=timeout) as client:
        lat: float | None = None
        lon: float | None = None
        geocode_error: str | None = None
        for candidate in _weather_address_candidates(query_address):
            geocode = client.get(
                "https://api.openweathermap.org/geo/1.0/direct",
                params={
                    "q": candidate,
                    "limit": 1,
                    "appid": api_key,
                },
            )
            if geocode.status_code >= 400:
                geocode_error = _openweather_error_message(geocode, context="Geocoding failed")
                continue
            geo_rows = geocode.json()
            if not isinstance(geo_rows, list) or not geo_rows:
                continue
            first_row = geo_rows[0] if isinstance(geo_rows[0], dict) else {}
            try:
                lat = float(first_row["lat"])
                lon = float(first_row["lon"])
                break
            except Exception:
                continue

        if lat is None or lon is None:
            for zip_candidate in _weather_zip_candidates(query_address):
                geocode_zip = client.get(
                    "https://api.openweathermap.org/geo/1.0/zip",
                    params={
                        "zip": zip_candidate,
                        "appid": api_key,
                    },
                )
                if geocode_zip.status_code >= 400:
                    geocode_error = _openweather_error_message(geocode_zip, context="Geocoding failed")
                    continue
                geocode_zip_payload = geocode_zip.json()
                if not isinstance(geocode_zip_payload, dict):
                    continue
                try:
                    lat = float(geocode_zip_payload["lat"])
                    lon = float(geocode_zip_payload["lon"])
                    break
                except Exception:
                    continue

        if lat is None or lon is None:
            if geocode_error:
                raise ValueError(geocode_error)
            raise ValueError("Address could not be geocoded")

        forecast = client.get(
            "https://api.openweathermap.org/data/2.5/forecast",
            params={
                "lat": lat,
                "lon": lon,
                "units": "metric",
                "lang": weather_language,
                "appid": api_key,
            },
        )
        if forecast.status_code >= 400:
            raise ValueError(_openweather_error_message(forecast, context="Forecast fetch failed"))
        forecast_payload = forecast.json()
        rows = forecast_payload.get("list")
        if not isinstance(rows, list) or not rows:
            raise ValueError("No weather forecast data available")
        timezone_offset = 0
        city = forecast_payload.get("city") if isinstance(forecast_payload.get("city"), dict) else {}
        if isinstance(city.get("timezone"), int):
            timezone_offset = int(city.get("timezone"))
        days = _normalize_openweather_5day(rows, timezone_offset_seconds=timezone_offset)
        if not days:
            raise ValueError("No daily weather forecast available")
        return lat, lon, days


def _project_weather_out(
    *,
    project_id: int,
    query_address: str,
    cache_row: ProjectWeatherCache | None,
    stale: bool,
    from_cache: bool,
    can_refresh: bool,
    message: str | None = None,
) -> ProjectWeatherOut:
    days_payload = cache_row.payload.get("days") if cache_row and isinstance(cache_row.payload, dict) else []
    days: list[ProjectWeatherDayOut] = []
    if isinstance(days_payload, list):
        for row in days_payload[:WEATHER_DAY_COUNT]:
            if not isinstance(row, dict):
                continue
            raw_date = str(row.get("date") or "").strip()
            if not raw_date:
                continue
            try:
                parsed_date = date.fromisoformat(raw_date)
            except ValueError:
                continue
            days.append(
                ProjectWeatherDayOut(
                    date=parsed_date,
                    temp_min=row.get("temp_min"),
                    temp_max=row.get("temp_max"),
                    description=row.get("description"),
                    icon=row.get("icon"),
                    precipitation_probability=row.get("precipitation_probability"),
                    wind_speed=row.get("wind_speed"),
                )
            )

    fetched_at = cache_row.fetched_at if cache_row else None
    next_refresh_at = (
        fetched_at + timedelta(seconds=WEATHER_MIN_REFRESH_SECONDS)
        if fetched_at is not None
        else None
    )
    provider = cache_row.provider if cache_row else WEATHER_PROVIDER
    query = query_address or (cache_row.query_address if cache_row else "")
    return ProjectWeatherOut(
        project_id=project_id,
        provider=provider,
        query_address=query,
        fetched_at=fetched_at,
        next_refresh_at=next_refresh_at,
        stale=stale,
        from_cache=from_cache,
        can_refresh=can_refresh,
        message=message,
        days=days,
    )


def _latest_general_report_file_by_path(db: Session) -> dict[str, Attachment]:
    rows = db.scalars(
        select(Attachment)
        .where(Attachment.project_id.is_(None), Attachment.construction_report_id.is_not(None))
        .order_by(Attachment.created_at.desc(), Attachment.id.desc())
    ).all()
    by_path: dict[str, Attachment] = {}
    for row in rows:
        path_value = _attachment_virtual_path(row)
        by_path.setdefault(path_value, row)
    return by_path


def _general_report_folder_paths(db: Session) -> set[str]:
    paths = set(DEFAULT_GENERAL_REPORT_FOLDERS)
    folder_rows = db.scalars(
        select(Attachment.folder_path).where(
            Attachment.project_id.is_(None),
            Attachment.construction_report_id.is_not(None),
            Attachment.folder_path != "",
        )
    ).all()
    for folder_value in folder_rows:
        normalized = _normalize_project_folder_path(str(folder_value), allow_empty=True)
        if not normalized:
            continue
        segments = normalized.split("/")
        for idx in range(1, len(segments) + 1):
            paths.add("/".join(segments[:idx]))
    return paths


def _normalize_task_status(raw_status: str | None, *, default: str = "open") -> str:
    status = (raw_status or "").strip().lower()
    if not status:
        return default
    if status in {"completed", "complete"}:
        return "done"
    return status


def _normalize_task_type(raw_task_type: str | None, *, default: str = "construction") -> str:
    normalized = (raw_task_type or "").strip().lower()
    if not normalized:
        return default
    mapped = TASK_TYPE_ALIASES.get(normalized)
    if not mapped:
        raise HTTPException(status_code=400, detail="Unknown task type")
    return mapped


def _normalize_class_template_ids(class_template_ids: list[int] | None) -> list[int]:
    normalized: list[int] = []
    seen: set[int] = set()
    for raw_id in class_template_ids or []:
        template_id = int(raw_id)
        if template_id <= 0:
            raise HTTPException(status_code=400, detail="Invalid class template id")
        if template_id in seen:
            continue
        seen.add(template_id)
        normalized.append(template_id)
    return normalized


def _class_template_task_rows(raw_templates: object) -> list[dict[str, str | None]]:
    if not isinstance(raw_templates, list):
        return []
    rows: list[dict[str, str | None]] = []
    for raw_item in raw_templates:
        if not isinstance(raw_item, dict):
            continue
        title = str(raw_item.get("title") or "").strip()
        if not title:
            continue
        description = str(raw_item.get("description") or "").strip() or None
        task_type_raw = str(raw_item.get("task_type") or "construction")
        try:
            task_type = _normalize_task_type(task_type_raw, default="construction")
        except HTTPException:
            task_type = "construction"
        rows.append({"title": title, "description": description, "task_type": task_type})
    return rows


def _project_class_template_out(template: ProjectClassTemplate) -> ProjectClassTemplateOut:
    return ProjectClassTemplateOut(
        id=template.id,
        name=template.name,
        materials_required=template.materials_required,
        tools_required=template.tools_required,
        task_templates=_class_template_task_rows(template.task_templates),
    )


def _project_class_templates_for_project(db: Session, project_id: int) -> list[ProjectClassTemplate]:
    return list(
        db.scalars(
            select(ProjectClassTemplate)
            .join(ProjectClassAssignment, ProjectClassAssignment.class_template_id == ProjectClassTemplate.id)
            .where(ProjectClassAssignment.project_id == project_id)
            .order_by(ProjectClassTemplate.name.asc(), ProjectClassTemplate.id.asc())
        ).all()
    )


def _resolve_project_class_template(
    db: Session, *, project_id: int, class_template_id: int
) -> ProjectClassTemplate:
    template = db.scalars(
        select(ProjectClassTemplate)
        .join(ProjectClassAssignment, ProjectClassAssignment.class_template_id == ProjectClassTemplate.id)
        .where(
            ProjectClassAssignment.project_id == project_id,
            ProjectClassAssignment.class_template_id == class_template_id,
        )
        .limit(1)
    ).first()
    if not template:
        raise HTTPException(status_code=400, detail="Class template is not assigned to this project")
    return template


def _class_template_materials_text(template: ProjectClassTemplate) -> str:
    materials = (template.materials_required or "").strip()
    tools = (template.tools_required or "").strip()
    sections: list[str] = []
    if materials:
        sections.append(f"Materials:\n{materials}")
    if tools:
        sections.append(f"Tools:\n{tools}")
    return "\n\n".join(sections).strip()


def _sync_project_class_templates(
    db: Session,
    *,
    project_id: int,
    class_template_ids: list[int],
    actor_user_id: int | None,
) -> dict[str, int]:
    requested_ids = _normalize_class_template_ids(class_template_ids)
    existing_ids = set(
        db.scalars(
            select(ProjectClassAssignment.class_template_id).where(ProjectClassAssignment.project_id == project_id)
        ).all()
    )

    templates_by_id: dict[int, ProjectClassTemplate] = {}
    if requested_ids:
        rows = db.scalars(select(ProjectClassTemplate).where(ProjectClassTemplate.id.in_(requested_ids))).all()
        templates_by_id = {row.id: row for row in rows}
        missing = [template_id for template_id in requested_ids if template_id not in templates_by_id]
        if missing:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown class template id(s): {', '.join(str(value) for value in missing)}",
            )

    added_ids = [template_id for template_id in requested_ids if template_id not in existing_ids]
    removed_ids = [template_id for template_id in existing_ids if template_id not in requested_ids]

    if removed_ids:
        db.execute(
            delete(ProjectClassAssignment).where(
                ProjectClassAssignment.project_id == project_id,
                ProjectClassAssignment.class_template_id.in_(removed_ids),
            )
        )

    for template_id in added_ids:
        db.add(ProjectClassAssignment(project_id=project_id, class_template_id=template_id))

    created_task_count = 0
    for template_id in added_ids:
        template = templates_by_id[template_id]
        for task_template in _class_template_task_rows(template.task_templates):
            task = Task(
                project_id=project_id,
                title=task_template["title"] or "",
                description=task_template["description"],
                materials_required=None,
                task_type=_normalize_task_type(task_template["task_type"], default="construction"),
                class_template_id=template.id,
                status="open",
            )
            db.add(task)
            db.flush()
            created_task_count += 1
            _record_project_activity(
                db,
                project_id=project_id,
                actor_user_id=actor_user_id,
                event_type="task.created",
                message=f"Task created: {task.title}",
                details={
                    "task_id": task.id,
                    "status": task.status,
                    "source": "project_class_template",
                    "class_template_id": template.id,
                },
            )

    return {
        "added": len(added_ids),
        "removed": len(removed_ids),
        "created_tasks": created_task_count,
    }


def _normalize_assignee_ids(candidate_ids: list[int | None]) -> list[int]:
    normalized: list[int] = []
    seen: set[int] = set()
    for candidate in candidate_ids:
        if candidate is None:
            continue
        if candidate <= 0 or candidate in seen:
            continue
        seen.add(candidate)
        normalized.append(candidate)
    return normalized


def _validate_assignee_ids(db: Session, assignee_ids: list[int]) -> None:
    if not assignee_ids:
        return
    existing_ids = set(db.scalars(select(User.id).where(User.id.in_(assignee_ids), User.is_active.is_(True))).all())
    missing = [user_id for user_id in assignee_ids if user_id not in existing_ids]
    if missing:
        raise HTTPException(status_code=400, detail=f"Unknown assignee id(s): {', '.join(str(x) for x in missing)}")


def _task_assignee_map(db: Session, tasks: list[Task]) -> dict[int, list[int]]:
    if not tasks:
        return {}
    task_ids = [task.id for task in tasks]
    out: dict[int, list[int]] = {task_id: [] for task_id in task_ids}
    rows = db.execute(
        select(TaskAssignment.task_id, TaskAssignment.user_id)
        .where(TaskAssignment.task_id.in_(task_ids))
        .order_by(TaskAssignment.task_id.asc(), TaskAssignment.id.asc())
    ).all()
    for task_id, user_id in rows:
        out[task_id].append(user_id)
    for task in tasks:
        if not out[task.id] and task.assignee_id is not None:
            out[task.id] = [task.assignee_id]
    return out


def _task_out(task: Task, assignee_ids: list[int]) -> TaskOut:
    return TaskOut(
        id=task.id,
        project_id=task.project_id,
        title=task.title,
        description=task.description,
        materials_required=task.materials_required,
        storage_box_number=task.storage_box_number,
        task_type=task.task_type,
        class_template_id=task.class_template_id,
        status=task.status,
        due_date=task.due_date,
        start_time=task.start_time,
        assignee_id=assignee_ids[0] if assignee_ids else None,
        assignee_ids=assignee_ids,
        week_start=task.week_start,
        updated_at=task.updated_at,
    )


def _tasks_out(db: Session, tasks: list[Task]) -> list[TaskOut]:
    assignees_by_task = _task_assignee_map(db, tasks)
    return [_task_out(task, assignees_by_task.get(task.id, [])) for task in tasks]


def _sync_task_assignments(db: Session, task: Task, assignee_ids: list[int]) -> None:
    db.execute(delete(TaskAssignment).where(TaskAssignment.task_id == task.id))
    task.assignee_id = assignee_ids[0] if assignee_ids else None
    for assignee_id in assignee_ids:
        db.add(TaskAssignment(task_id=task.id, user_id=assignee_id))


def _my_task_filter(user_id: int):
    assigned_subquery = select(TaskAssignment.task_id).where(TaskAssignment.user_id == user_id)
    return or_(Task.assignee_id == user_id, Task.id.in_(assigned_subquery))


def _planning_visibility_user_ids(db: Session, current_user: User) -> set[int]:
    if current_user.role in {"admin", "ceo", "planning", "accountant"}:
        return set(db.scalars(select(User.id).where(User.is_active.is_(True))).all())
    return {current_user.id}


def _expand_school_absence_days(
    absence: SchoolAbsence,
    *,
    period_start: date,
    period_end: date,
) -> list[date]:
    if absence.recurrence_weekday is None:
        start = max(absence.start_date, period_start)
        end = min(absence.end_date, period_end)
        if end < start:
            return []
        days: list[date] = []
        cursor = start
        while cursor <= end:
            days.append(cursor)
            cursor += timedelta(days=1)
        return days

    recur_until = absence.recurrence_until or period_end
    window_end = min(recur_until, period_end)
    if window_end < period_start:
        return []
    first = max(absence.start_date, period_start)
    offset = (absence.recurrence_weekday - first.weekday()) % 7
    first_match = first + timedelta(days=offset)
    days: list[date] = []
    cursor = first_match
    while cursor <= window_end:
        days.append(cursor)
        cursor += timedelta(days=7)
    return days


def _planning_absences_by_day(
    db: Session,
    *,
    current_user: User,
    week_start: date,
    week_end: date,
) -> dict[date, list[dict[str, object]]]:
    allowed_user_ids = _planning_visibility_user_ids(db, current_user)
    if not allowed_user_ids:
        return {}

    users = db.scalars(select(User).where(User.id.in_(allowed_user_ids))).all()
    names_by_user_id = {user.id: user.full_name for user in users}
    by_day: dict[date, list[dict[str, object]]] = {}

    vacation_rows = db.scalars(
        select(VacationRequest).where(
            VacationRequest.user_id.in_(allowed_user_ids),
            VacationRequest.status == "approved",
            VacationRequest.end_date >= week_start,
            VacationRequest.start_date <= week_end,
        )
    ).all()
    for row in vacation_rows:
        day_cursor = max(row.start_date, week_start)
        day_end = min(row.end_date, week_end)
        while day_cursor <= day_end:
            by_day.setdefault(day_cursor, []).append(
                {
                    "type": "vacation",
                    "user_id": row.user_id,
                    "user_name": names_by_user_id.get(row.user_id, f"#{row.user_id}"),
                    "label": "Urlaub",
                    "status": row.status,
                }
            )
            day_cursor += timedelta(days=1)

    school_rows = db.scalars(
        select(SchoolAbsence).where(
            SchoolAbsence.user_id.in_(allowed_user_ids),
            SchoolAbsence.start_date <= week_end,
            or_(SchoolAbsence.recurrence_until.is_(None), SchoolAbsence.recurrence_until >= week_start),
        )
    ).all()
    for row in school_rows:
        for day_value in _expand_school_absence_days(row, period_start=week_start, period_end=week_end):
            by_day.setdefault(day_value, []).append(
                {
                    "type": "school",
                    "user_id": row.user_id,
                    "user_name": names_by_user_id.get(row.user_id, f"#{row.user_id}"),
                    "label": row.title,
                    "status": None,
                }
            )

    for day_key in by_day:
        by_day[day_key].sort(key=lambda entry: (str(entry.get("label") or ""), int(entry.get("user_id") or 0)))
    return by_day


def _can_access_reports(user: User, *, write: bool) -> bool:
    if has_permission(user.role, "reports:manage"):
        return True
    if write:
        return has_permission(user.role, "reports:create")
    return has_permission(user.role, "reports:create") or has_permission(user.role, "reports:view")


def _assert_report_access(user: User, *, write: bool) -> None:
    if _can_access_reports(user, write=write):
        return
    detail = "Report create access denied" if write else "Report access denied"
    raise HTTPException(status_code=403, detail=detail)


def _optional_project_id(raw_value: object) -> int | None:
    if raw_value is None:
        return None
    raw_text = str(raw_value).strip()
    if not raw_text:
        return None
    try:
        project_id = int(raw_text)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="project_id must be an integer") from exc
    if project_id <= 0:
        raise HTTPException(status_code=400, detail="project_id must be positive")
    return project_id


def _hydrate_report_payload_with_project_defaults(payload: dict, project: Project | None) -> dict:
    hydrated = dict(payload)
    if project is None:
        return hydrated
    defaults: dict[str, str | None] = {
        "customer": project.customer_name,
        "customer_address": project.customer_address,
        "customer_contact": project.customer_contact,
        "customer_email": project.customer_email,
        "customer_phone": project.customer_phone,
        "project_name": project.name,
        "project_number": project.project_number,
    }
    for field, default_value in defaults.items():
        if not default_value:
            continue
        current_value = str(hydrated.get(field) or "").strip()
        if not current_value:
            hydrated[field] = default_value
    return hydrated


async def _create_construction_report_impl(
    request: Request,
    current_user: User,
    db: Session,
    *,
    forced_project_id: int | None,
) -> dict:
    content_type = request.headers.get("content-type", "")
    report_images: list[UploadFile] = []
    requested_project_id: int | None = None

    if "multipart/form-data" in content_type:
        form = await request.form()
        requested_project_id = _optional_project_id(form.get("project_id"))
        raw_report_date = str(form.get("report_date") or "").strip()
        if not raw_report_date:
            raise HTTPException(status_code=400, detail="report_date is required")
        try:
            report_date = date.fromisoformat(raw_report_date)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid report_date") from exc

        payload_json = form.get("payload")
        if payload_json is None:
            raise HTTPException(status_code=400, detail="payload is required")
        try:
            payload_data = json.loads(str(payload_json))
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="payload must be valid JSON") from exc

        report_payload = ConstructionReportPayload(**payload_data).model_dump()
        send_telegram = str(form.get("send_telegram") or "").lower() in {"1", "true", "yes", "on"}
        report_images = []
        for form_key, form_value in form.multi_items():
            if form_key not in {"images", "images[]", "camera_images", "camera_images[]"}:
                continue
            if not hasattr(form_value, "read"):
                continue
            content_type = str(getattr(form_value, "content_type", "") or "").lower()
            file_name = str(getattr(form_value, "filename", "") or "").strip()
            if content_type.startswith("image/") or file_name:
                report_images.append(form_value)
    else:
        payload = ConstructionReportCreate(**(await request.json()))
        requested_project_id = payload.project_id
        report_date = payload.report_date
        send_telegram = payload.send_telegram
        report_payload = payload.payload.model_dump()

    if forced_project_id is not None and requested_project_id not in {None, forced_project_id}:
        raise HTTPException(status_code=400, detail="project_id mismatch")

    target_project_id = forced_project_id if forced_project_id is not None else requested_project_id
    project: Project | None = None
    if target_project_id is not None:
        assert_project_access(db, current_user, target_project_id)
        project = db.get(Project, target_project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
    else:
        _assert_report_access(current_user, write=True)

    report_payload = _hydrate_report_payload_with_project_defaults(report_payload, project)

    report_file_name = build_report_filename(report_payload, report_date)
    telegram_configured = bool(settings.telegram_bot_token and settings.telegram_chat_id)
    report = ConstructionReport(
        project_id=target_project_id,
        user_id=current_user.id,
        report_date=report_date,
        payload=report_payload,
        telegram_sent=False,
        telegram_mode="pending" if (send_telegram and telegram_configured) else "stub",
        processing_status="queued",
        pdf_file_name=report_file_name,
    )
    db.add(report)
    db.flush()

    report_image_rows: list[dict[str, str]] = []
    for image_index, image_file in enumerate(report_images, start=1):
        raw_image = await image_file.read()
        if not raw_image:
            continue
        file_name = _report_image_filename(image_file, image_index)
        extension = _report_image_extension(file_name, image_file.content_type)
        stored_path = store_encrypted_file(raw_image, extension)
        image_folder = "Bilder"
        if target_project_id is not None:
            _register_project_folder(
                db,
                project_id=target_project_id,
                folder_path=image_folder,
                created_by=current_user.id,
            )
        row = Attachment(
            project_id=target_project_id,
            construction_report_id=report.id,
            uploaded_by=current_user.id,
            folder_path=image_folder,
            file_name=file_name,
            content_type=image_file.content_type or "application/octet-stream",
            stored_path=stored_path,
            is_encrypted=True,
        )
        db.add(row)
        db.flush()
        report_image_rows.append({"id": str(row.id), "file_name": row.file_name, "content_type": row.content_type})

    job = queue_construction_report_job(
        db,
        report_id=report.id,
        send_telegram=send_telegram,
        max_attempts=settings.report_job_max_attempts,
    )

    report_worker_hours = _construction_report_worker_hours(report_payload)
    material_need_items_count = 0
    if target_project_id is not None:
        material_need_items_count = _create_material_needs_from_report_payload(
            db,
            project_id=target_project_id,
            report_id=report.id,
            payload=report_payload,
            actor_user_id=current_user.id,
        )
        _accumulate_project_reported_hours(
            db,
            project_id=target_project_id,
            reported_hours=report_worker_hours,
        )
        _record_project_activity(
            db,
            project_id=target_project_id,
            actor_user_id=current_user.id,
            event_type="report.created",
            message=f"Construction report created ({report_date.isoformat()})",
            details={
                "report_id": report.id,
                "reported_hours": report_worker_hours,
                "material_need_items": material_need_items_count,
            },
        )
    db.commit()
    if settings.report_processing_mode.strip().lower() == "inline":
        inline_job = db.get(ConstructionReportJob, job.id)
        if inline_job and inline_job.status == "queued":
            await process_construction_report_job(db, inline_job.id)
    db.refresh(report)
    return {
        "id": report.id,
        "project_id": report.project_id,
        "telegram_sent": report.telegram_sent,
        "telegram_mode": report.telegram_mode,
        "attachment_file_name": report.pdf_file_name,
        "report_images": report_image_rows,
        "processing_status": report.processing_status,
        "processing_error": report.processing_error,
    }


@router.get("/projects", response_model=list[ProjectOut])
def list_projects(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.role in {"admin", "ceo", "planning", "accountant"}:
        return list(db.scalars(select(Project).order_by(Project.id.desc())).all())

    member_project_ids = db.scalars(
        select(ProjectMember.project_id).where(ProjectMember.user_id == current_user.id)
    ).all()
    if not member_project_ids:
        return []
    return list(db.scalars(select(Project).where(Project.id.in_(member_project_ids))).all())


@router.get("/materials", response_model=list[ProjectMaterialNeedOut])
def list_project_material_needs(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    visible_projects = _active_projects_visible_to_user(db, current_user)
    if not visible_projects:
        return []
    visible_project_ids = [project.id for project in visible_projects]
    projects_by_id = {project.id: project for project in visible_projects}
    status_rank = case(
        (ProjectMaterialNeed.status == "order", 0),
        (ProjectMaterialNeed.status == "on_the_way", 1),
        (ProjectMaterialNeed.status == "available", 2),
        else_=3,
    )
    rows = db.execute(
        select(ProjectMaterialNeed, ConstructionReport)
        .outerjoin(ConstructionReport, ConstructionReport.id == ProjectMaterialNeed.construction_report_id)
        .where(ProjectMaterialNeed.project_id.in_(visible_project_ids))
        .order_by(status_rank.asc(), ProjectMaterialNeed.created_at.desc(), ProjectMaterialNeed.id.desc())
    ).all()
    result: list[ProjectMaterialNeedOut] = []
    for material_need, report in rows:
        project = projects_by_id.get(material_need.project_id)
        if not project:
            continue
        result.append(_project_material_need_out(material_need, project=project, report=report))
    return result


@router.patch("/materials/{material_need_id}", response_model=ProjectMaterialNeedOut)
def update_project_material_need(
    material_need_id: int,
    payload: ProjectMaterialNeedUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    row = db.get(ProjectMaterialNeed, material_need_id)
    if not row:
        raise HTTPException(status_code=404, detail="Material item not found")
    visible_project_ids = _project_ids_visible_to_user(db, current_user)
    if row.project_id not in visible_project_ids:
        raise HTTPException(status_code=403, detail="Project access denied")
    project = db.get(Project, row.project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    previous_status = _normalize_material_need_status(row.status)
    next_status = _normalize_material_need_status(payload.status, strict=True)
    row.status = next_status
    row.updated_by = current_user.id
    row.updated_at = utcnow()
    db.add(row)
    if previous_status != next_status:
        _record_project_activity(
            db,
            project_id=row.project_id,
            actor_user_id=current_user.id,
            event_type="material.status_updated",
            message=f"Material status updated ({row.item[:80]})",
            details={"material_need_id": row.id, "item": row.item, "from": previous_status, "to": next_status},
        )
    db.commit()
    db.refresh(row)
    report = db.get(ConstructionReport, row.construction_report_id) if row.construction_report_id is not None else None
    return _project_material_need_out(row, project=project, report=report)


@router.get("/project-class-templates", response_model=list[ProjectClassTemplateOut])
def list_project_class_templates(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rows = db.scalars(select(ProjectClassTemplate).order_by(ProjectClassTemplate.name.asc(), ProjectClassTemplate.id.asc())).all()
    return [_project_class_template_out(row) for row in rows]


@router.get("/projects/{project_id}/class-templates", response_model=list[ProjectClassTemplateOut])
def list_project_assigned_class_templates(
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_project_access(db, current_user, project_id)
    rows = _project_class_templates_for_project(db, project_id)
    return [_project_class_template_out(row) for row in rows]


@router.post("/projects", response_model=ProjectOut)
def create_project(
    payload: ProjectCreate,
    current_user: User = Depends(require_permission("projects:manage")),
    db: Session = Depends(get_db),
):
    project_number = payload.project_number.strip()
    if not project_number:
        raise HTTPException(status_code=400, detail="Project number is required")
    existing = db.scalars(select(Project).where(Project.project_number == project_number)).first()
    if existing:
        raise HTTPException(status_code=400, detail="Project number already exists")
    site_access_type, site_access_note = _normalize_project_site_access(
        payload.site_access_type,
        payload.site_access_note,
    )

    project = Project(
        project_number=project_number,
        name=payload.name,
        description=payload.description,
        status=payload.status,
        last_state=payload.last_state,
        last_status_at=payload.last_status_at,
        last_updated_at=utcnow(),
        customer_name=payload.customer_name,
        customer_address=payload.customer_address,
        customer_contact=payload.customer_contact,
        customer_email=payload.customer_email,
        customer_phone=payload.customer_phone,
        site_access_type=site_access_type,
        site_access_note=site_access_note,
        extra_attributes=payload.extra_attributes or {},
        created_by=current_user.id,
    )
    db.add(project)
    db.flush()
    _ensure_project_default_folders(db, project.id, created_by=current_user.id)
    class_sync = _sync_project_class_templates(
        db,
        project_id=project.id,
        class_template_ids=payload.class_template_ids,
        actor_user_id=current_user.id,
    )
    _record_project_activity(
        db,
        project_id=project.id,
        actor_user_id=current_user.id,
        event_type="project.created",
        message=f"Project created: {project.project_number}",
        details={"project_number": project.project_number, "name": project.name},
    )
    if class_sync["added"] or class_sync["created_tasks"]:
        _record_project_activity(
            db,
            project_id=project.id,
            actor_user_id=current_user.id,
            event_type="project.classes_updated",
            message="Project classes assigned",
            details={
                "classes_added": class_sync["added"],
                "classes_removed": class_sync["removed"],
                "auto_created_tasks": class_sync["created_tasks"],
            },
        )
    db.commit()
    db.refresh(project)

    if current_user.role == "employee":
        db.add(ProjectMember(project_id=project.id, user_id=current_user.id, can_manage=True))
        db.commit()

    return project


@router.patch("/projects/{project_id}", response_model=ProjectOut)
def update_project(
    project_id: int,
    payload: ProjectUpdate,
    current_user: User = Depends(require_permission("projects:manage")),
    db: Session = Depends(get_db),
):
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    assert_project_access(db, current_user, project_id, manage_required=True)
    if "expected_last_updated_at" in payload.model_fields_set:
        _assert_optimistic_timestamp(
            expected=payload.expected_last_updated_at,
            current=project.last_updated_at,
            conflict_detail="Project was updated by another user. Please reload and retry.",
        )

    previous_status = (project.status or "").strip()
    previous_description = project.description or ""
    class_sync: dict[str, int] | None = None

    if payload.project_number is not None:
        candidate = payload.project_number.strip()
        if not candidate:
            raise HTTPException(status_code=400, detail="Project number is required")
        duplicate = db.scalars(
            select(Project).where(Project.project_number == candidate, Project.id != project_id)
        ).first()
        if duplicate:
            raise HTTPException(status_code=400, detail="Project number already exists")
        project.project_number = candidate

    for field in [
        "name",
        "description",
        "status",
        "last_state",
        "last_status_at",
        "customer_name",
        "customer_address",
        "customer_contact",
        "customer_email",
        "customer_phone",
        "extra_attributes",
    ]:
        value = getattr(payload, field)
        if value is not None:
            setattr(project, field, value)

    if "site_access_type" in payload.model_fields_set or "site_access_note" in payload.model_fields_set:
        next_site_access_type, next_site_access_note = _normalize_project_site_access(
            payload.site_access_type if "site_access_type" in payload.model_fields_set else project.site_access_type,
            payload.site_access_note if "site_access_note" in payload.model_fields_set else project.site_access_note,
        )
        project.site_access_type = next_site_access_type
        project.site_access_note = next_site_access_note

    if "class_template_ids" in payload.model_fields_set and payload.class_template_ids is not None:
        class_sync = _sync_project_class_templates(
            db,
            project_id=project.id,
            class_template_ids=payload.class_template_ids,
            actor_user_id=current_user.id,
        )

    next_status = (project.status or "").strip()
    if next_status != previous_status:
        _record_project_activity(
            db,
            project_id=project.id,
            actor_user_id=current_user.id,
            event_type="project.state_changed",
            message=f"State changed to {next_status or '-'}",
            details={"from": previous_status, "to": next_status},
        )
    elif project.description != previous_description:
        _record_project_activity(
            db,
            project_id=project.id,
            actor_user_id=current_user.id,
            event_type="project.note_updated",
            message="Internal note updated",
            details={},
        )
    if class_sync and (class_sync["added"] or class_sync["removed"] or class_sync["created_tasks"]):
        _record_project_activity(
            db,
            project_id=project.id,
            actor_user_id=current_user.id,
            event_type="project.classes_updated",
            message="Project classes updated",
            details={
                "classes_added": class_sync["added"],
                "classes_removed": class_sync["removed"],
                "auto_created_tasks": class_sync["created_tasks"],
            },
        )
    project.last_updated_at = utcnow()
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


@router.get("/projects/{project_id}/finance", response_model=ProjectFinanceOut)
def get_project_finance(
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_project_access(db, current_user, project_id)
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return _project_finance_row_or_default(db, project_id)


@router.patch("/projects/{project_id}/finance", response_model=ProjectFinanceOut)
def update_project_finance(
    project_id: int,
    payload: ProjectFinanceUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.role not in {"admin", "ceo", "accountant"}:
        raise HTTPException(status_code=403, detail="Finance access denied")
    assert_project_access(db, current_user, project_id)
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    finance_row = db.get(ProjectFinance, project_id)
    if "expected_updated_at" in payload.model_fields_set:
        _assert_optimistic_timestamp(
            expected=payload.expected_updated_at,
            current=finance_row.updated_at if finance_row else None,
            conflict_detail="Project finances were updated by another user. Please reload and retry.",
        )
    if not finance_row:
        finance_row = ProjectFinance(project_id=project_id)
        db.add(finance_row)
        db.flush()

    changed_fields: dict[str, float | None] = {}
    for field in [
        "order_value_net",
        "down_payment_35",
        "main_components_50",
        "final_invoice_15",
        "planned_costs",
        "actual_costs",
        "contribution_margin",
        "planned_hours_total",
    ]:
        if field not in payload.model_fields_set:
            continue
        value = getattr(payload, field)
        setattr(finance_row, field, value)
        changed_fields[field] = value

    finance_row.updated_by = current_user.id
    finance_row.updated_at = utcnow()
    db.add(finance_row)
    _record_project_activity(
        db,
        project_id=project_id,
        actor_user_id=current_user.id,
        event_type="finance.updated",
        message="Project finances updated",
        details=changed_fields,
    )
    db.commit()
    db.refresh(finance_row)
    return ProjectFinanceOut.model_validate(finance_row)


@router.get("/projects/{project_id}/overview", response_model=ProjectOverviewOut)
def project_overview_detail(
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_project_access(db, current_user, project_id)
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    open_tasks = int(
        db.scalar(select(func.count(Task.id)).where(Task.project_id == project_id, Task.status != "done")) or 0
    )
    my_open_tasks = int(
        db.scalar(
            select(func.count(Task.id)).where(
                Task.project_id == project_id,
                Task.status != "done",
                _my_task_filter(current_user.id),
            )
        )
        or 0
    )
    return ProjectOverviewOut(
        project=ProjectOut.model_validate(project),
        open_tasks=open_tasks,
        my_open_tasks=my_open_tasks,
        finance=_project_finance_row_or_default(db, project_id),
        recent_changes=_recent_project_activities_out(db, project_id, limit=10),
    )


@router.get("/projects/{project_id}/weather", response_model=ProjectWeatherOut)
def get_project_weather(
    project_id: int,
    refresh: bool = True,
    lang: str = "en",
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_project_access(db, current_user, project_id)
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    query_address = _normalize_weather_address(project.customer_address)
    cache_row = db.get(ProjectWeatherCache, project_id)
    has_cached_days = bool(cache_row and isinstance(cache_row.payload, dict) and cache_row.payload.get("days"))
    weather_language = _sanitize_weather_language(lang)
    cached_language = (
        _sanitize_weather_language(cache_row.payload.get("lang"))
        if cache_row and isinstance(cache_row.payload, dict)
        else "en"
    )

    if not query_address:
        return _project_weather_out(
            project_id=project_id,
            query_address="",
            cache_row=cache_row if has_cached_days else None,
            stale=has_cached_days,
            from_cache=has_cached_days,
            can_refresh=False,
            message="Project address is missing",
        )

    api_key = _effective_openweather_api_key(db)
    if not api_key:
        return _project_weather_out(
            project_id=project_id,
            query_address=query_address,
            cache_row=cache_row if has_cached_days else None,
            stale=has_cached_days,
            from_cache=has_cached_days,
            can_refresh=False,
            message="OpenWeather API key is not configured",
        )

    now = utcnow()
    last_fetch = cache_row.fetched_at if cache_row else None
    next_refresh_at = (
        last_fetch + timedelta(seconds=WEATHER_MIN_REFRESH_SECONDS)
        if last_fetch is not None
        else None
    )
    address_changed = bool(cache_row and cache_row.query_address != query_address)
    language_changed = bool(cache_row and cached_language != weather_language)
    throttle_blocked = bool(next_refresh_at and now < next_refresh_at and not address_changed and not language_changed)
    should_refresh = bool(refresh and (not throttle_blocked or not has_cached_days))

    if should_refresh:
        try:
            lat, lon, days = _fetch_openweather_forecast(
                api_key=api_key,
                query_address=query_address,
                language=weather_language,
            )
            if cache_row is None:
                cache_row = ProjectWeatherCache(
                    project_id=project_id,
                    provider=WEATHER_PROVIDER,
                    query_address=query_address,
                )
            cache_row.provider = WEATHER_PROVIDER
            cache_row.query_address = query_address
            cache_row.latitude = lat
            cache_row.longitude = lon
            cache_row.payload = {"days": days, "lang": weather_language}
            cache_row.fetched_at = now
            cache_row.last_error = None
            db.add(cache_row)
            db.commit()
            db.refresh(cache_row)
            return _project_weather_out(
                project_id=project_id,
                query_address=query_address,
                cache_row=cache_row,
                stale=False,
                from_cache=False,
                can_refresh=False,
            )
        except Exception as exc:
            error_text = str(exc).strip() or "Weather refresh failed"
            error_lower = error_text.lower()
            if "invalid api key" in error_lower:
                error_text = "OpenWeather API key is invalid (or not active yet)"
            elif "not subscribed" in error_lower:
                error_text = "OpenWeather forecast API access is not enabled for this key"
            if cache_row is not None and has_cached_days:
                cache_row.last_error = error_text[:500]
                db.add(cache_row)
                db.commit()
                db.refresh(cache_row)
                return _project_weather_out(
                    project_id=project_id,
                    query_address=query_address,
                    cache_row=cache_row,
                    stale=True,
                    from_cache=True,
                    can_refresh=not throttle_blocked,
                    message=f"Using cached weather values ({error_text[:140]})",
                )
            return _project_weather_out(
                project_id=project_id,
                query_address=query_address,
                cache_row=None,
                stale=True,
                from_cache=False,
                can_refresh=not throttle_blocked,
                message=f"Weather fetch failed: {error_text[:180]}",
            )

    if cache_row is not None and has_cached_days:
        return _project_weather_out(
            project_id=project_id,
            query_address=query_address,
            cache_row=cache_row,
            stale=bool(cache_row.last_error),
            from_cache=True,
            can_refresh=not throttle_blocked,
            message=cache_row.last_error,
        )

    return _project_weather_out(
        project_id=project_id,
        query_address=query_address,
        cache_row=None,
        stale=False,
        from_cache=False,
        can_refresh=True,
        message="No cached weather values yet",
    )


@router.delete("/projects/{project_id}")
def delete_project(
    project_id: int,
    current_user: User = Depends(require_permission("projects:manage")),
    db: Session = Depends(get_db),
):
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    assert_project_access(db, current_user, project_id, manage_required=True)

    attachment_paths = [
        str(path)
        for path in db.scalars(
            select(Attachment.stored_path).where(
                Attachment.project_id == project_id,
                Attachment.stored_path.is_not(None),
            )
        ).all()
        if path
    ]
    thread_icon_paths = [
        str(path)
        for path in db.scalars(
            select(ChatThread.icon_stored_path).where(
                ChatThread.project_id == project_id,
                ChatThread.icon_stored_path.is_not(None),
            )
        ).all()
        if path
    ]

    project_number = project.project_number
    db.delete(project)
    db.commit()

    for path in attachment_paths + thread_icon_paths:
        try:
            Path(path).unlink(missing_ok=True)
        except OSError:
            continue

    log_admin_action(
        db,
        current_user,
        "project.delete",
        "project",
        str(project_id),
        {"project_number": project_number},
    )
    return {"ok": True}


@router.post("/projects/{project_id}/members")
def add_project_member(
    project_id: int,
    user_id: int = Form(...),
    can_manage: bool = Form(False),
    current_user: User = Depends(require_permission("projects:manage")),
    db: Session = Depends(get_db),
):
    assert_project_access(db, current_user, project_id, manage_required=True)
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    membership = db.scalars(
        select(ProjectMember).where(ProjectMember.project_id == project_id, ProjectMember.user_id == user_id)
    ).first()
    if membership:
        membership.can_manage = can_manage
    else:
        db.add(ProjectMember(project_id=project_id, user_id=user_id, can_manage=can_manage))
    db.commit()
    return {"ok": True}


@router.get("/users/assignable", response_model=list[AssignableUserOut])
def list_assignable_users(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _ = current_user
    users = db.scalars(
        select(User)
        .where(User.is_active.is_(True))
        .order_by(User.full_name.asc(), User.id.asc())
    ).all()
    return list(users)


@router.post("/users/me/avatar")
async def upload_my_avatar(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not file.filename:
        raise HTTPException(status_code=400, detail="Avatar file is required")

    content_type = (file.content_type or "").strip().lower()
    if not content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Avatar must be an image")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Avatar file is empty")
    if len(raw) > MAX_AVATAR_BYTES:
        raise HTTPException(status_code=413, detail="Avatar exceeds 5 MB limit")

    extension = file.filename.rsplit(".", 1)[-1] if "." in file.filename else "jpg"
    stored_path = store_encrypted_file(raw, extension)

    previous_path = current_user.avatar_stored_path
    current_user.avatar_stored_path = stored_path
    current_user.avatar_content_type = content_type
    current_user.avatar_updated_at = utcnow()
    db.add(current_user)
    db.commit()
    db.refresh(current_user)

    if previous_path and previous_path != stored_path:
        try:
            os.remove(previous_path)
        except OSError:
            pass

    return {
        "ok": True,
        "avatar_updated_at": current_user.avatar_updated_at,
    }


@router.delete("/users/me/avatar")
def delete_my_avatar(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    previous_path = current_user.avatar_stored_path
    had_avatar = bool(previous_path)
    current_user.avatar_stored_path = None
    current_user.avatar_content_type = None
    current_user.avatar_updated_at = None
    db.add(current_user)
    db.commit()

    if previous_path:
        try:
            os.remove(previous_path)
        except OSError:
            pass

    return {"ok": True, "deleted": had_avatar, "avatar_updated_at": None}


@router.get("/users/{user_id}/avatar")
def get_user_avatar(
    user_id: int,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    user = db.get(User, user_id)
    if not user or not user.avatar_stored_path:
        raise HTTPException(status_code=404, detail="Avatar not found")

    avatar_bytes = _avatar_bytes_or_http_error(user.avatar_stored_path)
    media_type = user.avatar_content_type or "image/jpeg"
    headers = {
        "Content-Disposition": 'inline; filename="avatar.jpg"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    }
    return Response(content=avatar_bytes, media_type=media_type, headers=headers)


@router.get("/tasks", response_model=list[TaskOut])
def list_tasks(
    view: str = "all_open",
    project_id: int | None = None,
    week_start: date | None = None,
    task_type: str | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    stmt = select(Task)
    if project_id:
        assert_project_access(db, current_user, project_id)
        stmt = stmt.where(Task.project_id == project_id)

    if view == "my":
        stmt = stmt.where(_my_task_filter(current_user.id))
        stmt = stmt.where(Task.status != "done")
    elif view == "all_open":
        stmt = stmt.where(Task.status != "done")
        if current_user.role == "employee":
            stmt = stmt.where(_my_task_filter(current_user.id))
    elif view == "completed":
        stmt = stmt.where(Task.status == "done")
        if current_user.role == "employee":
            stmt = stmt.where(_my_task_filter(current_user.id))
    elif view == "projects_overview":
        if current_user.role == "employee":
            stmt = stmt.where(_my_task_filter(current_user.id))

    if week_start:
        stmt = stmt.where(Task.week_start == week_start)
    if task_type:
        stmt = stmt.where(Task.task_type == _normalize_task_type(task_type))

    tasks = list(db.scalars(stmt.order_by(Task.due_date.asc().nulls_last(), Task.id.desc())).all())
    return _tasks_out(db, tasks)


@router.post("/tasks", response_model=TaskOut)
def create_task(
    payload: TaskCreate,
    current_user: User = Depends(require_permission("tasks:manage")),
    db: Session = Depends(get_db),
):
    assert_project_access(db, current_user, payload.project_id, manage_required=True)
    class_template: ProjectClassTemplate | None = None
    if payload.class_template_id is not None:
        class_template = _resolve_project_class_template(
            db, project_id=payload.project_id, class_template_id=payload.class_template_id
        )
    assignee_ids = _normalize_assignee_ids([*(payload.assignee_ids or []), payload.assignee_id])
    _validate_assignee_ids(db, assignee_ids)
    task_data = payload.model_dump(exclude={"assignee_id", "assignee_ids", "class_template_id"})
    task = Task(**task_data)
    task.task_type = _normalize_task_type(payload.task_type, default="construction")
    task.class_template_id = class_template.id if class_template else None
    if class_template and not (task.materials_required or "").strip():
        task.materials_required = _class_template_materials_text(class_template) or None
    task.status = _normalize_task_status(payload.status, default="open")
    task.assignee_id = assignee_ids[0] if assignee_ids else None
    db.add(task)
    db.flush()
    _sync_task_assignments(db, task, assignee_ids)
    _record_project_activity(
        db,
        project_id=task.project_id,
        actor_user_id=current_user.id,
        event_type="task.created",
        message=f"Task created: {task.title}",
        details={"task_id": task.id, "status": task.status},
    )
    db.commit()
    db.refresh(task)
    return _task_out(task, assignee_ids)


@router.patch("/tasks/{task_id}", response_model=TaskOut)
def update_task(
    task_id: int,
    payload: TaskUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    existing_assignee_ids = _task_assignee_map(db, [task]).get(task.id, [])
    previous_status = task.status
    previous_due_date = task.due_date.isoformat() if task.due_date else None
    previous_start_time = task.start_time.isoformat() if task.start_time else None
    can_manage = current_user.role in {"admin", "ceo", "planning"}
    if not can_manage and current_user.id not in existing_assignee_ids:
        raise HTTPException(status_code=403, detail="Task access denied")
    if "expected_updated_at" in payload.model_fields_set:
        _assert_optimistic_timestamp(
            expected=payload.expected_updated_at,
            current=task.updated_at,
            conflict_detail="Task was updated by another user. Please reload and retry.",
        )

    if not can_manage:
        illegal_fields = payload.model_fields_set.difference({"status"})
        if illegal_fields:
            raise HTTPException(status_code=403, detail="Assigned employees can only mark tasks complete")
        normalized_status = _normalize_task_status(payload.status, default="")
        if normalized_status != "done":
            raise HTTPException(status_code=403, detail="Assigned employees can only set status to done")
        task.status = "done"
    else:
        if "title" in payload.model_fields_set:
            task.title = payload.title or task.title
        if "description" in payload.model_fields_set:
            task.description = payload.description
        if "materials_required" in payload.model_fields_set:
            task.materials_required = payload.materials_required
        if "storage_box_number" in payload.model_fields_set:
            task.storage_box_number = payload.storage_box_number
        if "task_type" in payload.model_fields_set:
            task.task_type = _normalize_task_type(payload.task_type, default=task.task_type)
        if "class_template_id" in payload.model_fields_set:
            if payload.class_template_id is None:
                task.class_template_id = None
            else:
                class_template = _resolve_project_class_template(
                    db, project_id=task.project_id, class_template_id=payload.class_template_id
                )
                task.class_template_id = class_template.id
                if "materials_required" not in payload.model_fields_set and not (task.materials_required or "").strip():
                    task.materials_required = _class_template_materials_text(class_template) or None
        if "status" in payload.model_fields_set:
            task.status = _normalize_task_status(payload.status, default=task.status)
        if "due_date" in payload.model_fields_set:
            task.due_date = payload.due_date
        if "start_time" in payload.model_fields_set:
            task.start_time = payload.start_time
        if "week_start" in payload.model_fields_set:
            task.week_start = payload.week_start

        if "assignee_ids" in payload.model_fields_set or "assignee_id" in payload.model_fields_set:
            next_assignee_candidates: list[int | None] = []
            if "assignee_ids" in payload.model_fields_set and payload.assignee_ids is not None:
                next_assignee_candidates.extend(payload.assignee_ids)
            if "assignee_id" in payload.model_fields_set:
                next_assignee_candidates.append(payload.assignee_id)
            next_assignee_ids = _normalize_assignee_ids(next_assignee_candidates)
            _validate_assignee_ids(db, next_assignee_ids)
            _sync_task_assignments(db, task, next_assignee_ids)
            existing_assignee_ids = next_assignee_ids

    db.add(task)
    if task.status != previous_status or (task.due_date.isoformat() if task.due_date else None) != previous_due_date or (
        task.start_time.isoformat() if task.start_time else None
    ) != previous_start_time:
        _record_project_activity(
            db,
            project_id=task.project_id,
            actor_user_id=current_user.id,
            event_type="task.updated",
            message=f"Task updated: {task.title}",
            details={
                "task_id": task.id,
                "status": task.status,
                "due_date": task.due_date.isoformat() if task.due_date else None,
                "start_time": task.start_time.isoformat() if task.start_time else None,
            },
        )
    db.commit()
    db.refresh(task)
    return _task_out(task, existing_assignee_ids)


@router.delete("/tasks/{task_id}")
def delete_task(
    task_id: int,
    current_user: User = Depends(require_permission("tasks:manage")),
    db: Session = Depends(get_db),
):
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    assert_project_access(db, current_user, task.project_id, manage_required=True)
    _record_project_activity(
        db,
        project_id=task.project_id,
        actor_user_id=current_user.id,
        event_type="task.deleted",
        message=f"Task deleted: {task.title}",
        details={"task_id": task.id},
    )
    db.delete(task)
    db.commit()
    return {"ok": True}


@router.post("/planning/week/{week_start}")
def planning_assign_week(
    week_start: date,
    assignments: list[TaskCreate],
    current_user: User = Depends(require_permission("planning:manage")),
    db: Session = Depends(get_db),
):
    created_ids: list[int] = []
    for assignment in assignments:
        assert_project_access(db, current_user, assignment.project_id)
        class_template: ProjectClassTemplate | None = None
        if assignment.class_template_id is not None:
            class_template = _resolve_project_class_template(
                db, project_id=assignment.project_id, class_template_id=assignment.class_template_id
            )
        assignee_ids = _normalize_assignee_ids([*(assignment.assignee_ids or []), assignment.assignee_id])
        _validate_assignee_ids(db, assignee_ids)
        assignment_data = assignment.model_dump(
            exclude={"week_start", "due_date", "assignee_id", "assignee_ids", "status", "task_type", "class_template_id"}
        )
        due_date = assignment.due_date or week_start
        task = Task(
            **assignment_data,
            status=_normalize_task_status(assignment.status, default="open"),
            task_type=_normalize_task_type(assignment.task_type, default="construction"),
            class_template_id=class_template.id if class_template else None,
            due_date=due_date,
            week_start=week_start,
        )
        if class_template and not (task.materials_required or "").strip():
            task.materials_required = _class_template_materials_text(class_template) or None
        db.add(task)
        db.flush()
        _sync_task_assignments(db, task, assignee_ids)
        _record_project_activity(
            db,
            project_id=task.project_id,
            actor_user_id=current_user.id,
            event_type="task.created",
            message=f"Task created: {task.title}",
            details={"task_id": task.id, "status": task.status},
        )
        created_ids.append(task.id)
    db.commit()
    return {"ok": True, "created_task_ids": created_ids}


@router.get("/planning/week/{week_start}", response_model=PlanningWeekOut)
def planning_week_view(
    week_start: date,
    project_id: int | None = None,
    task_type: str | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    stmt = select(Task).where(Task.week_start == week_start)
    if project_id is not None:
        assert_project_access(db, current_user, project_id)
        stmt = stmt.where(Task.project_id == project_id)

    if current_user.role == "employee":
        stmt = stmt.where(_my_task_filter(current_user.id))
    if task_type:
        stmt = stmt.where(Task.task_type == _normalize_task_type(task_type))

    tasks = list(db.scalars(stmt.order_by(Task.due_date.asc().nulls_last(), Task.id.asc())).all())
    task_out_rows = _tasks_out(db, tasks)
    by_day: dict[date, list[TaskOut]] = {}
    for task in task_out_rows:
        target_day = task.due_date if task.due_date else week_start
        by_day.setdefault(target_day, []).append(task)
    week_end = week_start + timedelta(days=6)
    absences_by_day = _planning_absences_by_day(
        db,
        current_user=current_user,
        week_start=week_start,
        week_end=week_end,
    )

    days = []
    for offset in range(7):
        day_date = week_start + timedelta(days=offset)
        days.append({"date": day_date, "tasks": by_day.get(day_date, []), "absences": absences_by_day.get(day_date, [])})

    return {
        "week_start": week_start,
        "week_end": week_end,
        "days": days,
    }


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
async def upload_project_file(
    project_id: int,
    folder: str = Form(default=""),
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_project_access(db, current_user, project_id)
    if not file.filename:
        raise HTTPException(status_code=400, detail="File name is required")
    normalized_folder = _resolve_project_upload_folder(folder, file.filename, file.content_type)
    if _folder_path_is_protected(normalized_folder) and not _can_access_project_protected_folder(current_user):
        raise HTTPException(status_code=403, detail="Folder access denied")
    _register_project_folder(
        db,
        project_id=project_id,
        folder_path=normalized_folder,
        created_by=current_user.id,
    )
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="File body is required")
    extension = file.filename.rsplit(".", 1)[-1] if "." in file.filename else "bin"
    stored_path = store_encrypted_file(raw, extension)

    attachment = Attachment(
        project_id=project_id,
        uploaded_by=current_user.id,
        folder_path=normalized_folder,
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
        event_type="file.uploaded",
        message=f"File uploaded: {file.filename}",
        details={"file_name": file.filename, "folder": normalized_folder},
    )
    db.commit()
    db.refresh(attachment)
    return _attachment_out(attachment)


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


def _sanitize_dav_relative_path(raw_path: str, *, allow_empty: bool = False) -> str:
    normalized = (raw_path or "").replace("\\", "/").strip("/")
    if not normalized:
        if allow_empty:
            return ""
        raise HTTPException(status_code=400, detail="Path is required")
    parts: list[str] = []
    for part in normalized.split("/"):
        segment = part.strip()
        if not segment:
            continue
        if segment in {".", ".."}:
            raise HTTPException(status_code=400, detail="Invalid path")
        parts.append(segment)
    if not parts:
        if allow_empty:
            return ""
        raise HTTPException(status_code=400, detail="Path is required")
    return "/".join(parts)


def _dav_quote_path(value: str) -> str:
    if not value:
        return ""
    return "/".join(quote(segment, safe="") for segment in value.split("/"))


def _dav_project_href(project_ref: str, relative_path: str = "", *, collection: bool) -> str:
    encoded_ref = quote((project_ref or "").strip(), safe="")
    base = f"/api/dav/projects/{encoded_ref}/"
    if not relative_path:
        return base
    encoded = _dav_quote_path(relative_path)
    if collection:
        return f"{base}{encoded}/"
    return f"{base}{encoded}"


def _dav_general_href(relative_path: str = "", *, collection: bool) -> str:
    base = f"/api/dav/projects/{WEBDAV_GENERAL_SEGMENT}/"
    if not relative_path:
        return base
    encoded = _dav_quote_path(relative_path)
    if collection:
        return f"{base}{encoded}/"
    return f"{base}{encoded}"


def _dav_archive_project_href(project_id: int, relative_path: str = "", *, collection: bool) -> str:
    base = f"/api/dav/projects/{WEBDAV_ARCHIVE_SEGMENT}/{project_id}/"
    if not relative_path:
        return base
    encoded = _dav_quote_path(relative_path)
    if collection:
        return f"{base}{encoded}/"
    return f"{base}{encoded}"


def _dav_general_listing_responses(
    db: Session,
    *,
    folder_path: str,
    depth: str,
) -> list[dict[str, str]]:
    file_map = _latest_general_report_file_by_path(db)
    folder_paths = _general_report_folder_paths(db)

    if folder_path:
        has_folder = folder_path in folder_paths
        has_children = any(path.startswith(f"{folder_path}/") for path in folder_paths) or any(
            path.startswith(f"{folder_path}/") for path in file_map
        )
        if not has_folder and not has_children and folder_path not in file_map:
            raise HTTPException(status_code=404, detail="Path not found")

    display_name = folder_path.split("/")[-1] if folder_path else WEBDAV_GENERAL_DISPLAY
    responses: list[dict[str, str]] = [
        {
            "href": _dav_general_href(folder_path, collection=True),
            "displayname": display_name,
            "resourcetype_xml": "<D:resourcetype><D:collection/></D:resourcetype>",
            "last_modified": _rfc1123(datetime.now(timezone.utc)),
            "content_length": "0",
            "content_type": "httpd/unix-directory",
        }
    ]

    if depth == "0":
        return responses

    child_folders: set[str] = set()
    child_files: set[str] = set()

    for path in folder_paths:
        if folder_path:
            if not path.startswith(f"{folder_path}/"):
                continue
            remainder = path[len(folder_path) + 1 :]
        else:
            remainder = path
        if not remainder:
            continue
        if "/" in remainder:
            child_folders.add(remainder.split("/", 1)[0])
        else:
            child_folders.add(remainder)

    for path in file_map.keys():
        if folder_path:
            if not path.startswith(f"{folder_path}/"):
                continue
            remainder = path[len(folder_path) + 1 :]
        else:
            remainder = path
        if not remainder:
            continue
        if "/" in remainder:
            child_folders.add(remainder.split("/", 1)[0])
        else:
            child_files.add(remainder)

    for folder_name in sorted(child_folders):
        child_path = f"{folder_path}/{folder_name}" if folder_path else folder_name
        responses.append(
            {
                "href": _dav_general_href(child_path, collection=True),
                "displayname": folder_name,
                "resourcetype_xml": "<D:resourcetype><D:collection/></D:resourcetype>",
                "last_modified": _rfc1123(datetime.now(timezone.utc)),
                "content_length": "0",
                "content_type": "httpd/unix-directory",
            }
        )

    for file_name in sorted(child_files):
        child_path = f"{folder_path}/{file_name}" if folder_path else file_name
        attachment = file_map.get(child_path)
        if not attachment:
            continue
        responses.append(
            {
                "href": _dav_general_href(child_path, collection=False),
                "displayname": file_name,
                "resourcetype_xml": "<D:resourcetype/>",
                "last_modified": _rfc1123(attachment.created_at),
                "content_length": _attachment_content_length_for_listing(attachment),
                "content_type": _safe_media_type(attachment.content_type),
            }
        )

    return responses


def _dav_folder_listing_responses(
    db: Session,
    *,
    project_id: int,
    project_ref: str,
    user: User,
    folder_path: str,
    depth: str,
) -> list[dict[str, str]]:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    folder_paths = _project_folder_paths_for_user(db, project_id, user)
    file_map = _latest_project_file_by_path(db, project_id, user)
    if folder_path:
        has_folder = folder_path in folder_paths
        has_children = any(path.startswith(f"{folder_path}/") for path in folder_paths) or any(
            path.startswith(f"{folder_path}/") for path in file_map
        )
        if not has_folder and not has_children:
            raise HTTPException(status_code=404, detail="Folder not found")
    root_display = _project_webdav_display_name(project)
    display_name = folder_path.split("/")[-1] if folder_path else root_display
    responses = [
        {
            "href": _dav_project_href(project_ref, folder_path, collection=True),
            "displayname": display_name,
            "resourcetype_xml": "<D:resourcetype><D:collection/></D:resourcetype>",
            "last_modified": _rfc1123(project.last_status_at or project.created_at),
            "content_length": "0",
            "content_type": "httpd/unix-directory",
        }
    ]
    if depth == "0":
        return responses

    child_folders: set[str] = set()
    child_files: set[str] = set()

    for path in folder_paths:
        if folder_path:
            if not path.startswith(f"{folder_path}/"):
                continue
            remainder = path[len(folder_path) + 1 :]
        else:
            remainder = path
        if not remainder:
            continue
        if "/" in remainder:
            child_folders.add(remainder.split("/", 1)[0])
        else:
            child_folders.add(remainder)

    for path in file_map.keys():
        if folder_path:
            if not path.startswith(f"{folder_path}/"):
                continue
            remainder = path[len(folder_path) + 1 :]
        else:
            remainder = path
        if not remainder:
            continue
        if "/" in remainder:
            child_folders.add(remainder.split("/", 1)[0])
        else:
            child_files.add(remainder)

    for folder_name in sorted(child_folders):
        child_path = f"{folder_path}/{folder_name}" if folder_path else folder_name
        responses.append(
            {
                "href": _dav_project_href(project_ref, child_path, collection=True),
                "displayname": folder_name,
                "resourcetype_xml": "<D:resourcetype><D:collection/></D:resourcetype>",
                "last_modified": _rfc1123(datetime.now(timezone.utc)),
                "content_length": "0",
                "content_type": "httpd/unix-directory",
            }
        )

    for file_name in sorted(child_files):
        child_path = f"{folder_path}/{file_name}" if folder_path else file_name
        attachment = file_map.get(child_path)
        if not attachment:
            continue
        responses.append(
            {
                "href": _dav_project_href(project_ref, child_path, collection=False),
                "displayname": file_name,
                "resourcetype_xml": "<D:resourcetype/>",
                "last_modified": _rfc1123(attachment.created_at),
                "content_length": _attachment_content_length_for_listing(attachment),
                "content_type": _safe_media_type(attachment.content_type),
            }
        )

    return responses


@router.api_route("/dav/projects", methods=["OPTIONS", "PROPFIND", "GET", "HEAD"])
@router.api_route("/dav/projects/", methods=["OPTIONS", "PROPFIND", "GET", "HEAD"], include_in_schema=False)
def webdav_projects_root(
    request: Request,
    db: Session = Depends(get_db),
    credentials: HTTPBasicCredentials | None = Depends(webdav_security),
):
    user = _webdav_authenticate(credentials, db)

    if request.method == "OPTIONS":
        return Response(status_code=204, headers=_dav_headers())
    if request.method in {"GET", "HEAD"}:
        return Response(status_code=204, headers=_dav_headers())

    depth = request.headers.get("Depth", "1")
    base_href = "/api/dav/projects/"
    responses = [
        {
            "href": base_href,
            "displayname": "projects",
            "resourcetype_xml": "<D:resourcetype><D:collection/></D:resourcetype>",
            "last_modified": _rfc1123(datetime.now(timezone.utc)),
            "content_length": "0",
            "content_type": "httpd/unix-directory",
        }
    ]
    if depth != "0":
        responses.extend(
            [
                {
                    "href": f"/api/dav/projects/{WEBDAV_GENERAL_SEGMENT}/",
                    "displayname": WEBDAV_GENERAL_DISPLAY,
                    "resourcetype_xml": "<D:resourcetype><D:collection/></D:resourcetype>",
                    "last_modified": _rfc1123(datetime.now(timezone.utc)),
                    "content_length": "0",
                    "content_type": "httpd/unix-directory",
                },
                {
                    "href": f"/api/dav/projects/{WEBDAV_ARCHIVE_SEGMENT}/",
                    "displayname": WEBDAV_ARCHIVE_DISPLAY,
                    "resourcetype_xml": "<D:resourcetype><D:collection/></D:resourcetype>",
                    "last_modified": _rfc1123(datetime.now(timezone.utc)),
                    "content_length": "0",
                    "content_type": "httpd/unix-directory",
                },
            ]
        )
        for project in _active_projects_visible_to_user(db, user):
            project_ref = quote(_project_webdav_ref(project), safe="")
            responses.append(
                {
                    "href": f"/api/dav/projects/{project_ref}/",
                    "displayname": _project_webdav_display_name(project),
                    "resourcetype_xml": "<D:resourcetype><D:collection/></D:resourcetype>",
                    "last_modified": _rfc1123(project.last_status_at or project.created_at),
                    "content_length": "0",
                    "content_type": "httpd/unix-directory",
                }
            )

    return _dav_multistatus(responses)


@router.api_route(f"/dav/projects/{WEBDAV_GENERAL_SEGMENT}", methods=["OPTIONS", "PROPFIND", "GET", "HEAD"])
@router.api_route(
    f"/dav/projects/{WEBDAV_GENERAL_SEGMENT}/",
    methods=["OPTIONS", "PROPFIND", "GET", "HEAD"],
    include_in_schema=False,
)
def webdav_general_projects_root(
    request: Request,
    db: Session = Depends(get_db),
    credentials: HTTPBasicCredentials | None = Depends(webdav_security),
):
    user = _webdav_authenticate(credentials, db)
    _assert_report_access(user, write=False)

    if request.method == "OPTIONS":
        return Response(status_code=204, headers=_dav_headers())
    if request.method in {"GET", "HEAD"}:
        return Response(status_code=204, headers=_dav_headers())

    depth = request.headers.get("Depth", "1")
    return _dav_multistatus(_dav_general_listing_responses(db, folder_path="", depth=depth))


@router.api_route(
    f"/dav/projects/{WEBDAV_GENERAL_SEGMENT}" + "/{file_path:path}",
    methods=["OPTIONS", "PROPFIND", "GET", "HEAD"],
)
def webdav_general_projects_file(
    request: Request,
    file_path: str,
    db: Session = Depends(get_db),
    credentials: HTTPBasicCredentials | None = Depends(webdav_security),
):
    user = _webdav_authenticate(credentials, db)
    _assert_report_access(user, write=False)
    normalized_path = _sanitize_dav_relative_path(file_path, allow_empty=True)
    file_map = _latest_general_report_file_by_path(db)
    folder_paths = _general_report_folder_paths(db)
    latest = file_map.get(normalized_path)

    if request.method == "OPTIONS":
        return Response(status_code=204, headers=_dav_headers())

    if request.method == "PROPFIND":
        depth = request.headers.get("Depth", "1")
        is_collection_request = request.url.path.endswith("/") or normalized_path in folder_paths
        if is_collection_request:
            return _dav_multistatus(_dav_general_listing_responses(db, folder_path=normalized_path, depth=depth))
        if not latest:
            raise HTTPException(status_code=404, detail="Path not found")
        return _dav_multistatus(
            [
                {
                    "href": _dav_general_href(normalized_path, collection=False),
                    "displayname": latest.file_name,
                    "resourcetype_xml": "<D:resourcetype/>",
                    "last_modified": _rfc1123(latest.created_at),
                    "content_length": _attachment_content_length_for_listing(latest),
                    "content_type": _safe_media_type(latest.content_type),
                }
            ]
        )

    if request.method in {"GET", "HEAD"}:
        if not latest:
            raise HTTPException(status_code=404, detail="File not found")
        return _attachment_http_response(
            latest,
            inline=False,
            include_dav_headers=True,
            head_only=request.method == "HEAD",
        )

    raise HTTPException(status_code=405, detail="Method not allowed")


@router.api_route(f"/dav/projects/{WEBDAV_ARCHIVE_SEGMENT}", methods=["OPTIONS", "PROPFIND", "GET", "HEAD"])
@router.api_route(
    f"/dav/projects/{WEBDAV_ARCHIVE_SEGMENT}/",
    methods=["OPTIONS", "PROPFIND", "GET", "HEAD"],
    include_in_schema=False,
)
def webdav_archive_root(
    request: Request,
    db: Session = Depends(get_db),
    credentials: HTTPBasicCredentials | None = Depends(webdav_security),
):
    user = _webdav_authenticate(credentials, db)

    if request.method == "OPTIONS":
        return Response(status_code=204, headers=_dav_headers())
    if request.method in {"GET", "HEAD"}:
        return Response(status_code=204, headers=_dav_headers())

    depth = request.headers.get("Depth", "1")
    responses = [
        {
            "href": f"/api/dav/projects/{WEBDAV_ARCHIVE_SEGMENT}/",
            "displayname": WEBDAV_ARCHIVE_DISPLAY,
            "resourcetype_xml": "<D:resourcetype><D:collection/></D:resourcetype>",
            "last_modified": _rfc1123(datetime.now(timezone.utc)),
            "content_length": "0",
            "content_type": "httpd/unix-directory",
        }
    ]
    if depth != "0":
        for project in _archived_projects_visible_to_user(db, user):
            responses.append(
                {
                    "href": f"/api/dav/projects/{WEBDAV_ARCHIVE_SEGMENT}/{project.id}/",
                    "displayname": _project_webdav_display_name(project),
                    "resourcetype_xml": "<D:resourcetype><D:collection/></D:resourcetype>",
                    "last_modified": _rfc1123(project.last_status_at or project.created_at),
                    "content_length": "0",
                    "content_type": "httpd/unix-directory",
                }
            )
    return _dav_multistatus(responses)


def _assert_archived_project_webdav_access(db: Session, user: User, project_id: int) -> None:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if not _is_project_archived(project):
        raise HTTPException(status_code=404, detail="Archived project not found")
    assert_project_access(db, user, project_id)


@router.api_route(
    f"/dav/projects/{WEBDAV_ARCHIVE_SEGMENT}" + "/{project_id}",
    methods=["OPTIONS", "PROPFIND", "GET", "HEAD"],
)
@router.api_route(
    f"/dav/projects/{WEBDAV_ARCHIVE_SEGMENT}" + "/{project_id}/",
    methods=["OPTIONS", "PROPFIND", "GET", "HEAD"],
    include_in_schema=False,
)
def webdav_archive_project_root(
    request: Request,
    project_id: int,
    db: Session = Depends(get_db),
    credentials: HTTPBasicCredentials | None = Depends(webdav_security),
):
    user = _webdav_authenticate(credentials, db)
    _assert_archived_project_webdav_access(db, user, project_id)

    if request.method == "OPTIONS":
        return Response(status_code=204, headers=_dav_headers())
    if request.method in {"GET", "HEAD"}:
        return Response(status_code=204, headers=_dav_headers())

    depth = request.headers.get("Depth", "1")
    return _dav_multistatus(
        _dav_folder_listing_responses(
            db,
            project_id=project_id,
            project_ref=str(project_id),
            user=user,
            folder_path="",
            depth=depth,
        )
    )


@router.api_route(
    f"/dav/projects/{WEBDAV_ARCHIVE_SEGMENT}" + "/{project_id}/{file_path:path}",
    methods=["OPTIONS", "PROPFIND", "GET", "HEAD"],
)
def webdav_archive_project_file(
    request: Request,
    project_id: int,
    file_path: str,
    db: Session = Depends(get_db),
    credentials: HTTPBasicCredentials | None = Depends(webdav_security),
):
    user = _webdav_authenticate(credentials, db)
    _assert_archived_project_webdav_access(db, user, project_id)
    normalized_path = _sanitize_dav_relative_path(file_path, allow_empty=True)

    if request.method == "OPTIONS":
        return Response(status_code=204, headers=_dav_headers())

    file_map = _latest_project_file_by_path(db, project_id, user)
    folder_paths = _project_folder_paths_for_user(db, project_id, user)
    latest = file_map.get(normalized_path)

    if request.method == "PROPFIND":
        depth = request.headers.get("Depth", "1")
        is_collection_request = request.url.path.endswith("/") or normalized_path in folder_paths
        if is_collection_request:
            return _dav_multistatus(
                _dav_folder_listing_responses(
                    db,
                    project_id=project_id,
                    project_ref=str(project_id),
                    user=user,
                    folder_path=normalized_path,
                    depth=depth,
                )
            )
        if not latest:
            raise HTTPException(status_code=404, detail="Path not found")
        return _dav_multistatus(
            [
                {
                    "href": _dav_archive_project_href(project_id, normalized_path, collection=False),
                    "displayname": latest.file_name,
                    "resourcetype_xml": "<D:resourcetype/>",
                    "last_modified": _rfc1123(latest.created_at),
                    "content_length": _attachment_content_length_for_listing(latest),
                    "content_type": _safe_media_type(latest.content_type),
                }
            ]
        )

    if request.method in {"GET", "HEAD"}:
        if not latest:
            raise HTTPException(status_code=404, detail="File not found")
        return _attachment_http_response(
            latest,
            inline=False,
            include_dav_headers=True,
            head_only=request.method == "HEAD",
        )

    raise HTTPException(status_code=405, detail="Method not allowed")


@router.api_route("/dav/projects/{project_ref}", methods=["OPTIONS", "PROPFIND", "GET", "HEAD"])
@router.api_route(
    "/dav/projects/{project_ref}/",
    methods=["OPTIONS", "PROPFIND", "GET", "HEAD"],
    include_in_schema=False,
)
def webdav_project_root(
    request: Request,
    project_ref: str,
    db: Session = Depends(get_db),
    credentials: HTTPBasicCredentials | None = Depends(webdav_security),
):
    user = _webdav_authenticate(credentials, db)
    project = _resolve_project_by_webdav_ref(db, project_ref)
    assert_project_access(db, user, project.id)
    canonical_ref = _project_webdav_ref(project)

    if request.method == "OPTIONS":
        return Response(status_code=204, headers=_dav_headers())
    if request.method in {"GET", "HEAD"}:
        return Response(status_code=204, headers=_dav_headers())

    depth = request.headers.get("Depth", "1")
    return _dav_multistatus(
        _dav_folder_listing_responses(
            db,
            project_id=project.id,
            project_ref=canonical_ref,
            user=user,
            folder_path="",
            depth=depth,
        )
    )


@router.api_route(
    "/dav/projects/{project_ref}/{file_path:path}",
    methods=["OPTIONS", "PROPFIND", "GET", "HEAD", "PUT", "DELETE", "MKCOL"],
)
async def webdav_project_file(
    request: Request,
    project_ref: str,
    file_path: str,
    db: Session = Depends(get_db),
    credentials: HTTPBasicCredentials | None = Depends(webdav_security),
):
    user = _webdav_authenticate(credentials, db)
    project = _resolve_project_by_webdav_ref(db, project_ref)
    assert_project_access(db, user, project.id)
    canonical_ref = _project_webdav_ref(project)

    normalized_path = _sanitize_dav_relative_path(file_path, allow_empty=True)

    if request.method == "OPTIONS":
        return Response(status_code=204, headers=_dav_headers())

    file_map = _latest_project_file_by_path(db, project.id, user)
    folder_paths = _project_folder_paths_for_user(db, project.id, user)
    latest = file_map.get(normalized_path)

    if request.method == "PROPFIND":
        depth = request.headers.get("Depth", "1")
        is_collection_request = request.url.path.endswith("/") or normalized_path in folder_paths
        if is_collection_request:
            return _dav_multistatus(
                _dav_folder_listing_responses(
                    db,
                    project_id=project.id,
                    project_ref=canonical_ref,
                    user=user,
                    folder_path=normalized_path,
                    depth=depth,
                )
            )
        if not latest:
            raise HTTPException(status_code=404, detail="Path not found")
        return _dav_multistatus(
            [
                {
                    "href": _dav_project_href(canonical_ref, normalized_path, collection=False),
                    "displayname": latest.file_name,
                    "resourcetype_xml": "<D:resourcetype/>",
                    "last_modified": _rfc1123(latest.created_at),
                    "content_length": _attachment_content_length_for_listing(latest),
                    "content_type": _safe_media_type(latest.content_type),
                }
            ]
        )

    if request.method in {"GET", "HEAD"}:
        if not latest:
            raise HTTPException(status_code=404, detail="File not found")
        return _attachment_http_response(
            latest,
            inline=False,
            include_dav_headers=True,
            head_only=request.method == "HEAD",
        )

    if request.method == "MKCOL":
        folder_path = _sanitize_dav_relative_path(file_path, allow_empty=False)
        if _folder_path_is_protected(folder_path) and not _can_access_project_protected_folder(user):
            raise HTTPException(status_code=403, detail="Folder access denied")
        _register_project_folder(
            db,
            project_id=project.id,
            folder_path=folder_path,
            created_by=user.id,
        )
        db.commit()
        return Response(status_code=201, headers=_dav_headers())

    if request.method == "PUT":
        if not normalized_path or normalized_path.endswith("/"):
            raise HTTPException(status_code=400, detail="Invalid file path")
        if "/" in normalized_path:
            folder_path, file_name = normalized_path.rsplit("/", 1)
        else:
            folder_path, file_name = "", normalized_path
        folder_path = _normalize_project_folder_path(folder_path, allow_empty=True)
        if _folder_path_is_protected(folder_path) and not _can_access_project_protected_folder(user):
            raise HTTPException(status_code=403, detail="Folder access denied")
        _register_project_folder(
            db,
            project_id=project.id,
            folder_path=folder_path,
            created_by=user.id,
        )
        raw = await request.body()
        if not raw:
            raise HTTPException(status_code=400, detail="File body is required")
        extension = file_name.rsplit(".", 1)[-1] if "." in file_name else "bin"
        stored_path = store_encrypted_file(raw, extension)
        attachment = Attachment(
            project_id=project.id,
            uploaded_by=user.id,
            folder_path=folder_path,
            file_name=file_name,
            content_type=request.headers.get("content-type") or "application/octet-stream",
            stored_path=stored_path,
            is_encrypted=True,
        )
        db.add(attachment)
        _record_project_activity(
            db,
            project_id=project.id,
            actor_user_id=user.id,
            event_type="file.uploaded",
            message=f"File uploaded: {file_name}",
            details={"file_name": file_name, "folder": folder_path},
        )
        db.commit()
        return Response(status_code=201, headers=_dav_headers())

    if request.method == "DELETE":
        if not latest:
            raise HTTPException(status_code=404, detail="File not found")
        _record_project_activity(
            db,
            project_id=project.id,
            actor_user_id=user.id,
            event_type="file.deleted",
            message=f"File deleted: {latest.file_name}",
            details={"file_name": latest.file_name, "folder": latest.folder_path},
        )
        db.delete(latest)
        db.commit()
        return Response(status_code=204, headers=_dav_headers())

    raise HTTPException(status_code=405, detail="Method not allowed")


@router.get("/wiki/library/files", response_model=list[WikiLibraryFileOut])
def list_wiki_library_files(
    q: str | None = None,
    _: User = Depends(require_permission("wiki:view")),
):
    root = _wiki_root_dir()
    if not root.exists() or not root.is_dir():
        return []
    files = _scan_wiki_library_files(root)
    query = (q or "").strip().lower()
    if not query:
        return files
    return [
        file
        for file in files
        if query in file.path.lower()
        or query in file.file_name.lower()
        or query in file.stem.lower()
        or query in file.folder.lower()
        or query in file.brand.lower()
    ]


@router.api_route("/wiki/library/raw/{wiki_path:path}", methods=["GET", "HEAD"])
def serve_wiki_library_file(
    wiki_path: str,
    request: Request,
    download: bool = False,
    _: User = Depends(require_permission("wiki:view")),
):
    file_path, normalized_path = _resolve_wiki_file_path(wiki_path)
    guessed_type = mimetypes.guess_type(file_path.name)[0]
    media_type = _safe_media_type(guessed_type, fallback="application/octet-stream")
    inline = (not download) and _wiki_previewable_mime(media_type)
    stat = file_path.stat()
    headers = {
        "Content-Disposition": _content_disposition(file_path.name, inline=inline),
        "Content-Length": str(stat.st_size),
        "X-Wiki-Path": normalized_path,
    }
    if request.method == "HEAD":
        return Response(status_code=200, media_type=media_type, headers=headers)
    return FileResponse(file_path, media_type=media_type, filename=None, headers=headers)


@router.get("/wiki/pages", response_model=list[WikiPageOut])
def list_wiki_pages(
    q: str | None = None,
    category: str | None = None,
    _: User = Depends(require_permission("wiki:view")),
    db: Session = Depends(get_db),
):
    stmt = select(WikiPage)
    if category and category.strip():
        stmt = stmt.where(WikiPage.category == category.strip())
    if q and q.strip():
        pattern = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(
                WikiPage.title.ilike(pattern),
                WikiPage.content.ilike(pattern),
                WikiPage.category.ilike(pattern),
            )
        )
    pages = db.scalars(stmt.order_by(WikiPage.updated_at.desc(), WikiPage.id.desc())).all()
    return pages


@router.get("/wiki/pages/{page_id}", response_model=WikiPageOut)
def get_wiki_page(
    page_id: int,
    _: User = Depends(require_permission("wiki:view")),
    db: Session = Depends(get_db),
):
    page = db.get(WikiPage, page_id)
    if not page:
        raise HTTPException(status_code=404, detail="Wiki page not found")
    return page


@router.post("/wiki/pages", response_model=WikiPageOut)
def create_wiki_page(
    payload: WikiPageCreate,
    current_user: User = Depends(require_permission("wiki:manage")),
    db: Session = Depends(get_db),
):
    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Title is required")
    page = WikiPage(
        title=title,
        slug=_unique_wiki_slug(db, title),
        category=(payload.category or "").strip() or None,
        content=payload.content or "",
        created_by=current_user.id,
        updated_by=current_user.id,
    )
    db.add(page)
    db.commit()
    db.refresh(page)
    return page


@router.patch("/wiki/pages/{page_id}", response_model=WikiPageOut)
def update_wiki_page(
    page_id: int,
    payload: WikiPageUpdate,
    current_user: User = Depends(require_permission("wiki:manage")),
    db: Session = Depends(get_db),
):
    page = db.get(WikiPage, page_id)
    if not page:
        raise HTTPException(status_code=404, detail="Wiki page not found")

    if payload.title is not None:
        title = payload.title.strip()
        if not title:
            raise HTTPException(status_code=400, detail="Title cannot be empty")
        page.title = title
        page.slug = _unique_wiki_slug(db, title, exclude_page_id=page.id)

    if payload.category is not None:
        page.category = payload.category.strip() or None
    if payload.content is not None:
        page.content = payload.content
    page.updated_by = current_user.id
    db.commit()
    db.refresh(page)
    return page


@router.delete("/wiki/pages/{page_id}")
def delete_wiki_page(
    page_id: int,
    _: User = Depends(require_permission("wiki:manage")),
    db: Session = Depends(get_db),
):
    page = db.get(WikiPage, page_id)
    if not page:
        raise HTTPException(status_code=404, detail="Wiki page not found")
    db.delete(page)
    db.commit()
    return {"ok": True}


def _create_thread_internal(payload: ThreadCreate, current_user: User, db: Session) -> ThreadOut:
    if not _chat_permission_allowed(current_user):
        raise HTTPException(status_code=403, detail="Chat access denied")

    project_id = payload.project_id
    if payload.site_id is not None:
        site = db.get(Site, payload.site_id)
        if not site:
            raise HTTPException(status_code=404, detail="Site not found")
        if project_id is not None and project_id != site.project_id:
            raise HTTPException(status_code=400, detail="site_id does not belong to project_id")
        project_id = site.project_id

    if project_id is not None:
        assert_project_access(db, current_user, project_id)

    thread = ChatThread(
        project_id=project_id,
        site_id=payload.site_id,
        name=payload.name.strip(),
        created_by=current_user.id,
        updated_at=utcnow(),
    )
    db.add(thread)
    db.commit()
    db.refresh(thread)
    return _thread_out(db, thread, current_user)


@router.post("/threads", response_model=ThreadOut)
def create_global_thread(
    payload: ThreadCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return _create_thread_internal(payload, current_user, db)


@router.get("/threads", response_model=list[ThreadOut])
def list_global_threads(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not _chat_permission_allowed(current_user):
        raise HTTPException(status_code=403, detail="Chat access denied")
    threads = db.scalars(select(ChatThread).order_by(ChatThread.id.desc())).all()
    return [_thread_out(db, thread, current_user) for thread in threads if _thread_visible_to_user(db, current_user, thread)]


@router.post("/projects/{project_id}/threads", response_model=ThreadOut)
def create_project_thread(
    project_id: int,
    payload: ThreadCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    fixed_payload = ThreadCreate(name=payload.name, project_id=project_id, site_id=payload.site_id)
    return _create_thread_internal(fixed_payload, current_user, db)


@router.get("/projects/{project_id}/threads", response_model=list[ThreadOut])
def list_project_threads(
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_project_access(db, current_user, project_id)
    threads = db.scalars(select(ChatThread).where(ChatThread.project_id == project_id).order_by(ChatThread.id.desc())).all()
    return [_thread_out(db, thread, current_user) for thread in threads]


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
    thread.updated_at = utcnow()
    db.commit()
    db.refresh(thread)
    return _thread_out(db, thread, current_user)


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
    content_type = (file.content_type or "").lower()
    if not content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Thread icon must be an image")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Thread icon file is empty")
    if len(raw) > MAX_AVATAR_BYTES:
        raise HTTPException(status_code=413, detail="Thread icon too large (max 5MB)")

    extension = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else "bin"
    stored_path = store_encrypted_file(raw, extension)
    thread.icon_stored_path = stored_path
    thread.icon_content_type = file.content_type or "application/octet-stream"
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
    image: UploadFile | None = File(default=None),
    attachment: UploadFile | None = File(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    thread = db.get(ChatThread, thread_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")
    _assert_thread_access(db, current_user, thread)

    text = (body or "").strip() or None
    upload = None
    if image and image.filename:
        upload = image
    elif attachment and attachment.filename:
        upload = attachment
    if not text and not upload:
        raise HTTPException(status_code=400, detail="Message text or attachment is required")

    message = Message(thread_id=thread_id, sender_id=current_user.id, body=text)
    db.add(message)
    db.flush()

    if upload:
        raw = await upload.read()
        if raw:
            extension = upload.filename.rsplit(".", 1)[-1] if "." in upload.filename else "bin"
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
        elif not text:
            raise HTTPException(status_code=400, detail="Attachment file is empty")

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
    return _message_out(db, message)


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


@router.post("/projects/{project_id}/construction-reports")
async def create_construction_report(
    project_id: int,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return await _create_construction_report_impl(
        request=request,
        current_user=current_user,
        db=db,
        forced_project_id=project_id,
    )


@router.post("/construction-reports")
async def create_construction_report_global(
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return await _create_construction_report_impl(
        request=request,
        current_user=current_user,
        db=db,
        forced_project_id=None,
    )


@router.get("/projects/{project_id}/construction-reports")
def list_construction_reports(
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_project_access(db, current_user, project_id)
    reports = db.scalars(
        select(ConstructionReport).where(ConstructionReport.project_id == project_id).order_by(ConstructionReport.id.desc())
    ).all()
    return [
        {
            "id": report.id,
            "project_id": report.project_id,
            "user_id": report.user_id,
            "report_date": report.report_date,
            "payload": report.payload,
            "telegram_sent": report.telegram_sent,
            "telegram_mode": report.telegram_mode,
            "processing_status": report.processing_status,
            "processing_error": report.processing_error,
            "processed_at": report.processed_at,
            "attachment_file_name": report.pdf_file_name,
            "created_at": report.created_at,
        }
        for report in reports
    ]


@router.get("/construction-reports")
def list_global_or_project_reports(
    project_id: int | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if project_id is not None:
        assert_project_access(db, current_user, project_id)
        stmt = select(ConstructionReport).where(ConstructionReport.project_id == project_id)
    else:
        _assert_report_access(current_user, write=False)
        stmt = select(ConstructionReport).where(ConstructionReport.project_id.is_(None))
    reports = db.scalars(stmt.order_by(ConstructionReport.id.desc())).all()
    return [
        {
            "id": report.id,
            "project_id": report.project_id,
            "user_id": report.user_id,
            "report_date": report.report_date,
            "payload": report.payload,
            "telegram_sent": report.telegram_sent,
            "telegram_mode": report.telegram_mode,
            "processing_status": report.processing_status,
            "processing_error": report.processing_error,
            "processed_at": report.processed_at,
            "attachment_file_name": report.pdf_file_name,
            "created_at": report.created_at,
        }
        for report in reports
    ]


@router.get("/construction-reports/{report_id}/processing")
def get_construction_report_processing_status(
    report_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    report = db.get(ConstructionReport, report_id)
    if not report:
        raise HTTPException(status_code=404, detail="Construction report not found")
    if report.project_id is not None:
        assert_project_access(db, current_user, report.project_id)
    else:
        _assert_report_access(current_user, write=False)
    return report_processing_payload(report)


@router.get("/construction-reports/files")
def list_construction_report_files(
    project_id: int | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    stmt = select(Attachment).where(Attachment.construction_report_id.is_not(None))
    if project_id is not None:
        assert_project_access(db, current_user, project_id)
        stmt = stmt.where(Attachment.project_id == project_id)
    else:
        _assert_report_access(current_user, write=False)
        stmt = stmt.where(Attachment.project_id.is_(None))
    attachments = db.scalars(stmt.order_by(Attachment.created_at.desc())).all()
    return [_attachment_out(attachment) for attachment in attachments]


@router.get("/projects-overview")
def projects_overview(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project_stmt = select(Project)
    if current_user.role == "employee":
        project_ids = db.scalars(select(ProjectMember.project_id).where(ProjectMember.user_id == current_user.id)).all()
        if not project_ids:
            return []
        project_stmt = project_stmt.where(Project.id.in_(project_ids))

    projects = db.scalars(project_stmt.order_by(Project.id.desc())).all()
    output = []
    for project in projects:
        total_open = db.scalar(
            select(func.count(Task.id)).where(Task.project_id == project.id, Task.status != "done")
        )
        total_sites = db.scalar(select(func.count(Site.id)).where(Site.project_id == project.id))
        output.append(
            {
                "project_id": project.id,
                "project_number": project.project_number,
                "name": project.name,
                "status": project.status,
                "last_updated_at": project.last_updated_at,
                "open_tasks": total_open or 0,
                "sites": total_sites or 0,
            }
        )
    return output


@router.get("/healthz")
def healthz(db: Session = Depends(get_db)):
    db.execute(select(1))
    return {"ok": True, "timestamp": utcnow().isoformat()}
