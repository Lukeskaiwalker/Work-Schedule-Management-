from __future__ import annotations

from fastapi import APIRouter

from app.routers.workflow_helpers import *  # noqa: F401,F403

router = APIRouter(prefix="", tags=["wiki"])


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
