"""WebDAV tree rooted at the customer.

``/api/dav/customers/<ref>/`` holds the customer's own folders and files and
one collection per project of that customer, so a mounted drive shows the
same hierarchy the app does: the customer folder with the project folders
inside. The project tree at ``/api/dav/projects/`` stays as it is for drives
already mounted. Layout and refs: see docs/FILE_SCOPES.md.

Two levels, one code path. A ``_Level`` bundles what differs between the
customer's own folder and a project served under it — where the data comes
from, how hrefs are rooted, how a write is booked — and ``_serve_level``
handles every method once. The project level therefore has exactly the
semantics of ``webdav_project_file`` (same access checks, same folder
registration, same activity log), only with hrefs under the customer.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter

from app.routers.workflow_helpers import *  # noqa: F401,F403
from app.services.customer_files import (
    customer_folder_paths_for_user,
    customers_visible_to_user,
    latest_customer_file_by_path,
    register_customer_folder,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="", tags=["webdav"])

CUSTOMERS_ROOT_HREF = "/api/dav/customers/"
CUSTOMERS_ROOT_DISPLAY = "customers"
# Finder names a mounted folder after the last segment of its href, not after
# displayname, which is why the customer's name travels in the ref — and must
# therefore be a legal file name: no path separators, no control characters,
# no runs of whitespace, and short enough to leave room for what follows.
CUSTOMER_REF_NAME_MAX_CHARS = 120
_REF_UNSAFE_RE = re.compile(r"[\\/\x00-\x1f\x7f]+")
_REF_WHITESPACE_RE = re.compile(r"\s+")
_REF_LEADING_ID_RE = re.compile(r"^\s*(\d+)")
COLLECTION_RESOURCETYPE = "<D:resourcetype><D:collection/></D:resourcetype>"
FILE_RESOURCETYPE = "<D:resourcetype/>"
ROOT_METHODS = ["OPTIONS", "PROPFIND", "GET", "HEAD"]
PATH_METHODS = ["OPTIONS", "PROPFIND", "GET", "HEAD", "PUT", "DELETE", "MKCOL"]

# (relative path, is a collection) -> href
HrefFor = Callable[[str, bool], str]


# ── Refs ────────────────────────────────────────────────────────────────────


def customer_webdav_ref(customer: Customer) -> str:
    """``"<id> - <name>"`` with the name reduced to a file-safe form, or the
    bare id when nothing of the name survives."""
    safe_name = _REF_WHITESPACE_RE.sub(" ", _REF_UNSAFE_RE.sub(" ", customer.name or "")).strip()
    safe_name = safe_name[:CUSTOMER_REF_NAME_MAX_CHARS].strip()
    if not safe_name:
        return str(customer.id)
    return f"{customer.id} - {safe_name}"


def _resolve_customer_by_webdav_ref(db: Session, customer_ref: str) -> Customer:
    """The leading integer is the ref. The name behind it is for Finder and
    is not checked: it goes stale when a customer is renamed while the drive
    stays mounted, and a script may pass the bare id."""
    match = _REF_LEADING_ID_RE.match(customer_ref or "")
    customer = db.get(Customer, int(match.group(1))) if match else None
    if customer is None:
        raise HTTPException(status_code=404, detail="Customer not found")
    return customer


def _project_of_customer_by_ref(db: Session, customer: Customer, segment: str) -> Project | None:
    """The customer's project a path segment names, if any.

    Decided before the segment is read as a customer folder, so a folder
    that happens to be called like one of the customer's project numbers is
    shadowed by the project — the project is what a mounted drive expects
    there. Another customer's project is not reachable through this one.
    """
    if not segment:
        return None
    try:
        project = _resolve_project_by_webdav_ref(db, segment)
    except HTTPException as exc:
        if exc.status_code == 404:
            return None
        raise
    return project if project.customer_id == customer.id else None


# ── hrefs and PROPFIND rows ─────────────────────────────────────────────────


def _tree_href(*refs: str) -> HrefFor:
    """hrefs under ``/api/dav/customers/<ref>/[<project ref>/]`` — the one
    thing about a listing that depends on where in the tree it is served."""
    base = CUSTOMERS_ROOT_HREF + "".join(f"{quote(ref, safe='')}/" for ref in refs)

    def href_for(relative_path: str, collection: bool) -> str:
        if not relative_path:
            return base
        encoded = _dav_quote_path(relative_path)
        return f"{base}{encoded}/" if collection else f"{base}{encoded}"

    return href_for


def _collection_response(href: str, display_name: str, last_modified: str) -> dict[str, str]:
    return {
        "href": href,
        "displayname": display_name,
        "resourcetype_xml": COLLECTION_RESOURCETYPE,
        "last_modified": last_modified,
        "content_length": "0",
        "content_type": "httpd/unix-directory",
    }


def _file_response(href: str, attachment: Attachment) -> dict[str, str]:
    return {
        "href": href,
        "displayname": attachment.file_name,
        "resourcetype_xml": FILE_RESOURCETYPE,
        "last_modified": _rfc1123(attachment.created_at),
        "content_length": _attachment_content_length_for_listing(attachment),
        "content_type": _safe_media_type(attachment.content_type),
    }


def _child_names(paths: Iterable[str], folder_path: str) -> tuple[set[str], set[str]]:
    """Split the paths below ``folder_path`` into the names that continue
    deeper and the names that end right there."""
    prefix = f"{folder_path}/" if folder_path else ""
    deeper: set[str] = set()
    direct: set[str] = set()
    for path in paths:
        if not path.startswith(prefix):
            continue
        remainder = path[len(prefix) :]
        if not remainder:
            continue
        if "/" in remainder:
            deeper.add(remainder.split("/", 1)[0])
        else:
            direct.add(remainder)
    return deeper, direct


def _listing_responses(
    *,
    folder_paths: set[str],
    file_map: dict[str, Attachment],
    href_for: HrefFor,
    root_display: str,
    root_last_modified: str,
    folder_path: str,
    depth: str,
    root_extra: Sequence[dict[str, str]] = (),
) -> list[dict[str, str]]:
    """One PROPFIND body for any collection of either level.

    Modelled on ``_dav_folder_listing_responses``. ``root_extra`` are
    collections that live at the root without being folders — the customer's
    projects; they are listed between the folders and the files.
    """
    if folder_path and folder_path not in folder_paths:
        below = f"{folder_path}/"
        if not any(path.startswith(below) for path in folder_paths) and not any(
            path.startswith(below) for path in file_map
        ):
            raise HTTPException(status_code=404, detail="Folder not found")
    display_name = folder_path.rsplit("/", 1)[-1] if folder_path else root_display
    responses = [_collection_response(href_for(folder_path, True), display_name, root_last_modified)]
    if depth == "0":
        return responses

    deeper_folders, direct_folders = _child_names(folder_paths, folder_path)
    deeper_files, direct_files = _child_names(file_map, folder_path)
    now = _rfc1123(datetime.now(timezone.utc))
    for name in sorted(deeper_folders | direct_folders | deeper_files):
        child_path = f"{folder_path}/{name}" if folder_path else name
        responses.append(_collection_response(href_for(child_path, True), name, now))
    if not folder_path:
        responses.extend(root_extra)
    for name in sorted(direct_files):
        child_path = f"{folder_path}/{name}" if folder_path else name
        attachment = file_map.get(child_path)
        if attachment is not None:
            responses.append(_file_response(href_for(child_path, False), attachment))
    return responses


# ── The two levels ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class _Level:
    """What differs between the customer's own folder and a project served
    under it. Everything else — methods, checks, answers — is shared."""

    href_for: HrefFor
    root_display: str
    root_last_modified: str
    folder_paths: set[str]
    file_map: dict[str, Attachment]
    # Collections at the root that are not folders (the customer's projects);
    # a callable because only a root listing needs them.
    root_extra: Callable[[], list[dict[str, str]]]
    register_folder: Callable[[str], None]
    # (folder path, file name, bytes, content type) -> the new row
    store_file: Callable[[str, str, bytes, str], Attachment]
    on_deleted: Callable[[Attachment], None]


def _store_attachment(
    db: Session,
    *,
    uploaded_by: int,
    folder_path: str,
    file_name: str,
    raw: bytes,
    content_type: str,
    project_id: int | None = None,
    customer_id: int | None = None,
) -> Attachment:
    extension = file_name.rsplit(".", 1)[-1] if "." in file_name else "bin"
    attachment = Attachment(
        project_id=project_id,
        customer_id=customer_id,
        uploaded_by=uploaded_by,
        folder_path=folder_path,
        file_name=file_name,
        content_type=content_type,
        stored_path=store_encrypted_file(raw, extension),
        is_encrypted=True,
    )
    db.add(attachment)
    return attachment


def _project_collections(db: Session, user: User, customer: Customer, customer_ref: str) -> list[dict[str, str]]:
    """One collection per project of the customer the user may open — all of
    them, archived ones included: the customer folder is the customer's whole
    history; the archive split belongs to the project tree."""
    visible_ids = _project_ids_visible_to_user(db, user)
    projects = db.scalars(select(Project).where(Project.customer_id == customer.id).order_by(Project.id.asc())).all()
    return [
        _collection_response(
            _tree_href(customer_ref, _project_webdav_ref(project))("", True),
            _project_webdav_display_name(project),
            _rfc1123(project.last_status_at or project.created_at),
        )
        for project in projects
        if project.id in visible_ids
    ]


def _customer_level(db: Session, user: User, customer: Customer, customer_ref: str) -> _Level:
    def register_folder(folder_path: str) -> None:
        register_customer_folder(db, customer_id=customer.id, folder_path=folder_path, created_by=user.id)

    def store_file(folder_path: str, file_name: str, raw: bytes, content_type: str) -> Attachment:
        return _store_attachment(
            db,
            uploaded_by=user.id,
            folder_path=folder_path,
            file_name=file_name,
            raw=raw,
            content_type=content_type,
            customer_id=customer.id,
        )

    return _Level(
        href_for=_tree_href(customer_ref),
        root_display=customer_ref,
        root_last_modified=_rfc1123(customer.updated_at or customer.created_at),
        folder_paths=customer_folder_paths_for_user(db, customer.id, user),
        file_map=latest_customer_file_by_path(db, customer.id, user),
        root_extra=lambda: _project_collections(db, user, customer, customer_ref),
        register_folder=register_folder,
        store_file=store_file,
        # A customer has no activity log; the row going away is the whole record.
        on_deleted=lambda attachment: None,
    )


def _project_level(db: Session, user: User, project: Project, customer_ref: str) -> _Level:
    def register_folder(folder_path: str) -> None:
        _register_project_folder(db, project_id=project.id, folder_path=folder_path, created_by=user.id)

    def store_file(folder_path: str, file_name: str, raw: bytes, content_type: str) -> Attachment:
        attachment = _store_attachment(
            db,
            uploaded_by=user.id,
            folder_path=folder_path,
            file_name=file_name,
            raw=raw,
            content_type=content_type,
            project_id=project.id,
        )
        _record_project_activity(
            db,
            project_id=project.id,
            actor_user_id=user.id,
            event_type="file.uploaded",
            message=f"File uploaded: {file_name}",
            details={"file_name": file_name, "folder": folder_path},
        )
        return attachment

    def on_deleted(attachment: Attachment) -> None:
        _record_project_activity(
            db,
            project_id=project.id,
            actor_user_id=user.id,
            event_type="file.deleted",
            message=f"File deleted: {attachment.file_name}",
            details={"file_name": attachment.file_name, "folder": attachment.folder_path},
        )

    return _Level(
        href_for=_tree_href(customer_ref, _project_webdav_ref(project)),
        root_display=_project_webdav_display_name(project),
        root_last_modified=_rfc1123(project.last_status_at or project.created_at),
        folder_paths=_project_folder_paths_for_user(db, project.id, user),
        file_map=_latest_project_file_by_path(db, project.id, user),
        root_extra=lambda: [],
        register_folder=register_folder,
        store_file=store_file,
        on_deleted=on_deleted,
    )


# ── Methods, once ───────────────────────────────────────────────────────────


def _assert_may_write_folder(user: User, folder_path: str) -> None:
    if _folder_path_is_protected(folder_path) and not _can_access_project_protected_folder(user):
        raise HTTPException(status_code=403, detail="Folder access denied")


def _unlink_quietly(stored_path: str) -> None:
    # Best effort after the commit, as the REST delete does: the row is gone
    # either way, and a blob nothing points at is a leak, not a risk.
    try:
        Path(stored_path).unlink(missing_ok=True)
    except OSError:
        logger.warning("stored file could not be removed after delete: %s", stored_path)


def _answer_propfind(request: Request, level: _Level, relative_path: str) -> Response:
    depth = request.headers.get("Depth", "1")
    is_collection_request = (
        not relative_path or request.url.path.endswith("/") or relative_path in level.folder_paths
    )
    if is_collection_request:
        wants_root_extra = not relative_path and depth != "0"
        return _dav_multistatus(
            _listing_responses(
                folder_paths=level.folder_paths,
                file_map=level.file_map,
                href_for=level.href_for,
                root_display=level.root_display,
                root_last_modified=level.root_last_modified,
                folder_path=relative_path,
                depth=depth,
                root_extra=level.root_extra() if wants_root_extra else (),
            )
        )
    latest = level.file_map.get(relative_path)
    if latest is None:
        raise HTTPException(status_code=404, detail="Path not found")
    return _dav_multistatus([_file_response(level.href_for(relative_path, False), latest)])


def _answer_get(request: Request, level: _Level, relative_path: str) -> Response:
    if not relative_path:
        # A collection has no body; the roots answer 204 so a mount probe succeeds.
        return Response(status_code=204, headers=_dav_headers())
    latest = level.file_map.get(relative_path)
    if latest is None:
        raise HTTPException(status_code=404, detail="File not found")
    return _attachment_http_response(
        latest,
        inline=False,
        include_dav_headers=True,
        head_only=request.method == "HEAD",
    )


def _answer_mkcol(db: Session, user: User, level: _Level, relative_path: str) -> Response:
    folder_path = _sanitize_dav_relative_path(relative_path, allow_empty=False)
    _assert_may_write_folder(user, folder_path)
    level.register_folder(folder_path)
    db.commit()
    return Response(status_code=201, headers=_dav_headers())


async def _answer_put(request: Request, db: Session, user: User, level: _Level, relative_path: str) -> Response:
    if not relative_path:
        raise HTTPException(status_code=400, detail="Invalid file path")
    folder_path, _, file_name = relative_path.rpartition("/")
    folder_path = _normalize_project_folder_path(folder_path, allow_empty=True)
    _assert_may_write_folder(user, folder_path)
    level.register_folder(folder_path)
    raw = await request.body()
    if not raw:
        raise HTTPException(status_code=400, detail="File body is required")
    level.store_file(folder_path, file_name, raw, request.headers.get("content-type") or "application/octet-stream")
    db.commit()
    return Response(status_code=201, headers=_dav_headers())


def _answer_delete(db: Session, user: User, level: _Level, relative_path: str) -> Response:
    latest = level.file_map.get(relative_path)
    if latest is None:
        raise HTTPException(status_code=404, detail="File not found")
    # The REST delete gate (workflow_files.delete_file), so a drive cannot
    # remove what the app would refuse to: protected folder, then files:manage.
    delete_folder = _normalize_project_folder_path(latest.folder_path, allow_empty=True)
    if _folder_path_is_protected(delete_folder) and not _can_access_project_protected_folder(user):
        raise HTTPException(status_code=403, detail="File access denied")
    if not has_permission_for_user(user.id, user.role, "files:manage"):
        raise HTTPException(status_code=403, detail="File management permission required")
    level.on_deleted(latest)
    stored_path = latest.stored_path
    db.delete(latest)
    db.commit()
    _unlink_quietly(stored_path)
    return Response(status_code=204, headers=_dav_headers())


async def _serve_level(request: Request, db: Session, user: User, level: _Level, relative_path: str) -> Response:
    if request.method == "PROPFIND":
        return _answer_propfind(request, level, relative_path)
    if request.method in {"GET", "HEAD"}:
        return _answer_get(request, level, relative_path)
    if request.method == "MKCOL":
        return _answer_mkcol(db, user, level, relative_path)
    if request.method == "PUT":
        return await _answer_put(request, db, user, level, relative_path)
    if request.method == "DELETE":
        return _answer_delete(db, user, level, relative_path)
    raise HTTPException(status_code=405, detail="Method not allowed")


# ── Routes — the literal roots before the catch-all path ────────────────────


@router.api_route("/dav/customers", methods=ROOT_METHODS)
@router.api_route("/dav/customers/", methods=ROOT_METHODS, include_in_schema=False)
def webdav_customers_root(
    request: Request,
    db: Session = Depends(get_db),
    credentials: HTTPBasicCredentials | None = Depends(webdav_security),
):
    user = _webdav_authenticate(credentials, db)
    if request.method in {"OPTIONS", "GET", "HEAD"}:
        return Response(status_code=204, headers=_dav_headers())

    now = _rfc1123(datetime.now(timezone.utc))
    responses = [_collection_response(CUSTOMERS_ROOT_HREF, CUSTOMERS_ROOT_DISPLAY, now)]
    if request.headers.get("Depth", "1") != "0":
        for customer in customers_visible_to_user(db, user):
            ref = customer_webdav_ref(customer)
            responses.append(
                _collection_response(
                    _tree_href(ref)("", True),
                    ref,
                    _rfc1123(customer.updated_at or customer.created_at),
                )
            )
    return _dav_multistatus(responses)


@router.api_route("/dav/customers/{customer_ref}", methods=ROOT_METHODS)
@router.api_route("/dav/customers/{customer_ref}/", methods=ROOT_METHODS, include_in_schema=False)
def webdav_customer_root(
    request: Request,
    customer_ref: str,
    db: Session = Depends(get_db),
    credentials: HTTPBasicCredentials | None = Depends(webdav_security),
):
    user = _webdav_authenticate(credentials, db)
    customer = _resolve_customer_by_webdav_ref(db, customer_ref)
    _assert_customer_files_access(db, user, customer.id)
    if request.method in {"OPTIONS", "GET", "HEAD"}:
        return Response(status_code=204, headers=_dav_headers())
    level = _customer_level(db, user, customer, customer_webdav_ref(customer))
    return _answer_propfind(request, level, "")


@router.api_route("/dav/customers/{customer_ref}/{file_path:path}", methods=PATH_METHODS)
async def webdav_customer_path(
    request: Request,
    customer_ref: str,
    file_path: str,
    db: Session = Depends(get_db),
    credentials: HTTPBasicCredentials | None = Depends(webdav_security),
):
    user = _webdav_authenticate(credentials, db)
    customer = _resolve_customer_by_webdav_ref(db, customer_ref)
    _assert_customer_files_access(db, user, customer.id)
    if request.method == "OPTIONS":
        return Response(status_code=204, headers=_dav_headers())

    normalized_path = _sanitize_dav_relative_path(file_path, allow_empty=True)
    canonical_ref = customer_webdav_ref(customer)
    head, _, rest = normalized_path.partition("/")
    project = _project_of_customer_by_ref(db, customer, head)
    if project is not None:
        assert_project_access(db, user, project.id)
        return await _serve_level(request, db, user, _project_level(db, user, project, canonical_ref), rest)
    return await _serve_level(request, db, user, _customer_level(db, user, customer, canonical_ref), normalized_path)
