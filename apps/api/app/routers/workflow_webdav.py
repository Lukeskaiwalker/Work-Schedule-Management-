from __future__ import annotations

from fastapi import APIRouter

from app.routers.workflow_helpers import *  # noqa: F401,F403

router = APIRouter(prefix="", tags=["webdav"])


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
