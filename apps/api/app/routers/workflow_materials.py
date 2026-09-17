from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, File, UploadFile
from fastapi.responses import FileResponse, RedirectResponse, Response

from app.core.config import get_settings
from app.core.db import SessionLocal
from app.routers.workflow_helpers import *  # noqa: F401,F403
from app.services.material_catalog_images import (
    CATALOG_IMAGE_MAX_BYTES,
    CATALOG_IMAGE_PUBLIC_URL_PREFIX,
    _is_public_http_url,
    normalize_material_catalog_image_external_key,
    remove_cached_material_catalog_image,
    resolve_cached_material_catalog_image_file,
    store_uploaded_material_catalog_image,
)


def _kick_catalog_item_image_bg(item_id: int) -> None:
    """Background task: open a fresh session and attempt image lookup for one catalog item."""
    try:
        with SessionLocal() as db:
            item = db.get(MaterialCatalogItem, item_id)
            if item is not None:
                ensure_material_catalog_item_image(db, item)
    except Exception:
        pass

router = APIRouter(prefix="", tags=["materials"])


@router.get("/projects", response_model=list[ProjectOut])
def list_projects(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # Respect the live permission map so admin-UI role edits take effect immediately.
    if has_global_project_access(current_user.id, current_user.role):
        return list(db.scalars(select(Project).order_by(Project.id.desc())).all())

    # v2.5.35 — membership UNION task-assigned projects (see deps.py).
    from app.core.deps import task_assigned_project_ids

    visible_ids = set(
        db.scalars(select(ProjectMember.project_id).where(ProjectMember.user_id == current_user.id)).all()
    )
    visible_ids |= task_assigned_project_ids(db, current_user.id)
    if not visible_ids:
        return []
    return list(db.scalars(select(Project).where(Project.id.in_(visible_ids))).all())

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
    # Same ladder as workflow_werkstatt_bedarfe.py::_STATUS_RANK — the two
    # lists show the same rows and must not disagree about their order.
    status_rank = case(
        (ProjectMaterialNeed.status == "order", 0),
        (ProjectMaterialNeed.status == "ordered", 1),
        (ProjectMaterialNeed.status == "on_the_way", 2),
        (ProjectMaterialNeed.status == "available", 3),
        (ProjectMaterialNeed.status == "completed", 4),
        else_=5,
    )
    rows = db.execute(
        select(ProjectMaterialNeed, ConstructionReport, MaterialCatalogItem)
        .outerjoin(ConstructionReport, ConstructionReport.id == ProjectMaterialNeed.construction_report_id)
        .outerjoin(MaterialCatalogItem, MaterialCatalogItem.id == ProjectMaterialNeed.material_catalog_item_id)
        .where(
            ProjectMaterialNeed.project_id.in_(visible_project_ids),
            ProjectMaterialNeed.status != "completed",
        )
        .order_by(status_rank.asc(), ProjectMaterialNeed.created_at.desc(), ProjectMaterialNeed.id.desc())
    ).all()
    result: list[ProjectMaterialNeedOut] = []
    for material_need, report, catalog_item in rows:
        project = projects_by_id.get(material_need.project_id)
        if not project:
            continue
        result.append(
            _project_material_need_out(
                material_need,
                project=project,
                report=report,
                catalog_item=catalog_item,
            )
        )
    return result

@router.get("/materials/catalog", response_model=list[MaterialCatalogItemOut])
def list_material_catalog_items(
    q: str = "",
    limit: int = Query(default=40, ge=1, le=120),
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # Was hard-capped at 10 regardless of what the client asked for, which
    # silently truncated the result set: a matching article ranked 11th simply
    # never reached the UI, so it read as "the article isn't in our pool".
    # The 120 ceiling matches what search_material_catalog already enforces.
    rows = search_material_catalog(db, query=q, limit=limit)
    return [_material_catalog_item_out(row) for row in rows]


@router.get("/materials/catalog/images/{external_key}")
def get_material_catalog_image_asset(
    external_key: str,
    db: Session = Depends(get_db),
):
    normalized_key = normalize_material_catalog_image_external_key(external_key)
    if not normalized_key:
        raise HTTPException(status_code=404, detail="Catalog image not found")

    catalog_row = db.scalar(select(MaterialCatalogItem).where(MaterialCatalogItem.external_key == normalized_key))
    if catalog_row is None:
        raise HTTPException(status_code=404, detail="Catalog image not found")

    cached = resolve_cached_material_catalog_image_file(
        external_key=normalized_key,
        uploads_dir=get_settings().uploads_dir,
    )
    if cached is not None:
        return FileResponse(
            path=cached.path,
            media_type=cached.content_type,
            headers={
                "Cache-Control": "public, max-age=86400",
                "X-Content-Type-Options": "nosniff",
            },
        )

    # Only ever bounce the browser to a validated *public* URL — never redirect
    # to an attacker-influenced internal/arbitrary host (open-redirect / SSRF).
    fallback_url = str(catalog_row.image_url or "").strip()
    if _is_public_http_url(fallback_url):
        return RedirectResponse(url=fallback_url, status_code=307)
    raise HTTPException(status_code=404, detail="Catalog image not found")


# Upload endpoint: user-supplied image overrides the scraped one. After this
# lands, `image_source = "manual"` — the background Unielektro/EAN lookup
# loop skips rows with a non-empty source (see
# `material_catalog._should_lookup_image`), so the manual image sticks.
@router.post("/materials/catalog/images/{external_key}")
async def upload_material_catalog_image(
    external_key: str,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    normalized_key = normalize_material_catalog_image_external_key(external_key)
    if not normalized_key:
        raise HTTPException(status_code=404, detail="Catalog item not found")

    catalog_row = db.scalar(
        select(MaterialCatalogItem).where(MaterialCatalogItem.external_key == normalized_key)
    )
    if catalog_row is None:
        raise HTTPException(status_code=404, detail="Catalog item not found")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="File body is required")
    if len(raw) > CATALOG_IMAGE_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Image exceeds {CATALOG_IMAGE_MAX_BYTES // (1024 * 1024)} MB limit",
        )

    stored = store_uploaded_material_catalog_image(
        external_key=normalized_key,
        uploads_dir=get_settings().uploads_dir,
        image_bytes=raw,
        content_type=file.content_type or "",
    )
    if stored is None:
        raise HTTPException(
            status_code=415,
            detail="Unsupported image type — upload a JPEG, PNG, WebP or GIF.",
        )

    # Point the catalog row at the freshly-cached file and tag the source as
    # 'manual' so the scraper leaves it alone.
    catalog_row.image_url = stored.public_url[:1000]
    catalog_row.image_source = "manual"
    catalog_row.image_checked_at = utcnow()
    db.add(catalog_row)
    db.commit()

    log_admin_action(
        db,
        current_user,
        "material_catalog.image.upload",
        "material_catalog_item",
        str(catalog_row.id),
        {
            "external_key": normalized_key,
            "filename": file.filename or "",
            "content_type": stored.content_type,
            "byte_size": stored.byte_size,
        },
        category="files",
    )
    return {
        "ok": True,
        "external_key": normalized_key,
        "image_url": stored.public_url,
        "image_source": "manual",
        "byte_size": stored.byte_size,
        "content_type": stored.content_type,
    }


@router.delete("/materials/catalog/images/{external_key}")
def delete_material_catalog_image(
    external_key: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Remove the cached image and reset the row's image state so the
    auto-scraper can retry from scratch on the next sync."""
    normalized_key = normalize_material_catalog_image_external_key(external_key)
    if not normalized_key:
        raise HTTPException(status_code=404, detail="Catalog item not found")

    catalog_row = db.scalar(
        select(MaterialCatalogItem).where(MaterialCatalogItem.external_key == normalized_key)
    )
    if catalog_row is None:
        raise HTTPException(status_code=404, detail="Catalog item not found")

    removed_any = remove_cached_material_catalog_image(
        external_key=normalized_key,
        uploads_dir=get_settings().uploads_dir,
    )

    previous_source = catalog_row.image_source or ""
    catalog_row.image_url = None
    catalog_row.image_source = None
    catalog_row.image_checked_at = None
    db.add(catalog_row)
    db.commit()

    log_admin_action(
        db,
        current_user,
        "material_catalog.image.delete",
        "material_catalog_item",
        str(catalog_row.id),
        {
            "external_key": normalized_key,
            "previous_source": previous_source,
            "removed_cached_file": removed_any,
        },
        category="files",
    )
    return {
        "ok": True,
        "external_key": normalized_key,
        "removed_cached_file": removed_any,
    }


@router.get("/materials/catalog/state", response_model=MaterialCatalogImportStateOut)
def get_material_catalog_state(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # Pure read-only: image processing is handled by the background loop in main.py.
    state = get_material_catalog_import_state(db)
    image_status = get_material_catalog_image_status(db)
    return MaterialCatalogImportStateOut(
        file_count=(state.file_count if state is not None else 0),
        item_count=(state.item_count if state is not None else 0),
        duplicates_skipped=(state.duplicates_skipped if state is not None else 0),
        imported_at=(state.imported_at if state is not None else None),
        image_lookup_enabled=image_status.lookup_enabled,
        image_lookup_phase=image_status.lookup_phase,
        image_last_run_processed=0,
        image_total_items=image_status.total_items,
        image_items_with_image=image_status.items_with_image,
        image_items_checked=image_status.items_checked,
        image_items_pending=image_status.items_pending,
        image_items_waiting_fallback=image_status.items_waiting_fallback,
        image_items_waiting_retry=image_status.items_waiting_retry,
        image_items_not_found=image_status.items_not_found,
        image_last_checked_at=image_status.last_checked_at,
    )

@router.post("/materials", response_model=ProjectMaterialNeedOut)
def create_project_material_need(
    payload: ProjectMaterialNeedCreate,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    visible_project_ids = _project_ids_visible_to_user(db, current_user)
    if payload.project_id not in visible_project_ids:
        raise HTTPException(status_code=403, detail="Project access denied")
    project = db.get(Project, payload.project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    selected_catalog_item: MaterialCatalogItem | None = None
    if payload.material_catalog_item_id is not None:
        selected_catalog_item = db.get(MaterialCatalogItem, payload.material_catalog_item_id)
        if not selected_catalog_item:
            raise HTTPException(status_code=404, detail="Catalog item not found")

    item_name = _normalize_report_material_text(payload.item)
    if not item_name and selected_catalog_item is not None:
        item_name = _normalize_report_material_text(selected_catalog_item.item_name)
    if not item_name:
        raise HTTPException(status_code=400, detail="Material item is required")

    normalized_status = _normalize_material_need_status(payload.status, strict=True)
    normalized_article = _normalize_report_material_text(payload.article_no)
    normalized_unit = _normalize_report_material_text(payload.unit)
    normalized_quantity = _normalize_report_material_text(payload.quantity)
    if selected_catalog_item is not None:
        if not normalized_article:
            normalized_article = _normalize_report_material_text(selected_catalog_item.article_no)
        if not normalized_unit:
            normalized_unit = _normalize_report_material_text(selected_catalog_item.unit)
        background_tasks.add_task(_kick_catalog_item_image_bg, selected_catalog_item.id)

    row = ProjectMaterialNeed(
        project_id=payload.project_id,
        construction_report_id=None,
        item=item_name,
        material_catalog_item_id=selected_catalog_item.id if selected_catalog_item else None,
        article_no=normalized_article or None,
        unit=normalized_unit or None,
        quantity=normalized_quantity or None,
        # Not run through _normalize_report_material_text: a note may be
        # several lines, and collapsing them is not this field's business.
        notes=(payload.notes or "").strip() or None,
        status=normalized_status,
        created_by=current_user.id,
        updated_by=current_user.id,
    )
    db.add(row)
    db.flush()
    _record_project_activity(
        db,
        project_id=payload.project_id,
        actor_user_id=current_user.id,
        event_type="material.created",
        message=f"Material need added ({item_name[:80]})",
        details={
            "material_need_id": row.id,
            "item": row.item,
            "article_no": row.article_no,
            "unit": row.unit,
            "quantity": row.quantity,
        },
    )
    db.commit()
    db.refresh(row)
    return _project_material_need_out(
        row,
        project=project,
        report=None,
        catalog_item=selected_catalog_item,
    )

def _load_visible_material_need(
    db: Session, current_user: User, material_need_id: int
) -> tuple[ProjectMaterialNeed, Project]:
    """The need and its project, or the reason the caller may not have them."""

    row = db.get(ProjectMaterialNeed, material_need_id)
    if not row:
        raise HTTPException(status_code=404, detail="Material item not found")
    visible_project_ids = _project_ids_visible_to_user(db, current_user)
    if row.project_id not in visible_project_ids:
        raise HTTPException(status_code=403, detail="Project access denied")
    project = db.get(Project, row.project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return row, project


def _apply_material_need_edits(
    db: Session, row: ProjectMaterialNeed, payload: ProjectMaterialNeedUpdate
) -> list[str]:
    """Write the edited fields onto the row. Returns which ones changed.

    ``material_catalog_item_id`` and ``notes`` use explicit-null semantics:
    sending null unlinks the catalogue row (the recovery path after a Datanorm
    re-import) or clears the note, while omitting the key keeps what is there.
    A newly linked row fills EMPTY article number and unit from the catalogue —
    the same rule creation uses — and never overwrites what a fitter typed.
    """

    changed: list[str] = []
    fields_set = payload.model_fields_set

    if "material_catalog_item_id" in fields_set:
        catalog_item: MaterialCatalogItem | None = None
        if payload.material_catalog_item_id is not None:
            catalog_item = db.get(MaterialCatalogItem, payload.material_catalog_item_id)
            if catalog_item is None:
                raise HTTPException(status_code=404, detail="Katalogeintrag nicht gefunden")
        if row.material_catalog_item_id != (catalog_item.id if catalog_item else None):
            row.material_catalog_item_id = catalog_item.id if catalog_item else None
            changed.append("material_catalog_item_id")
        if catalog_item is not None:
            if not (row.article_no or "").strip():
                row.article_no = _normalize_report_material_text(catalog_item.article_no) or None
            if not (row.unit or "").strip():
                row.unit = _normalize_report_material_text(catalog_item.unit) or None

    if "item" in fields_set and payload.item is not None:
        item_text = _normalize_report_material_text(payload.item)
        if not item_text:
            raise HTTPException(status_code=400, detail="Bezeichnung darf nicht leer sein")
        if item_text != row.item:
            row.item = item_text
            changed.append("item")

    for field in ("quantity", "unit", "article_no"):
        if field not in fields_set:
            continue
        value = _normalize_report_material_text(getattr(payload, field)) or None
        if value != getattr(row, field):
            setattr(row, field, value)
            changed.append(field)

    # `model_fields_set`, not `is not None`: the row editor clears a note by
    # sending an explicit null, and an is-not-None guard would silently put
    # the old text back — with a 200 and the unchanged row as proof.
    if "notes" in fields_set:
        notes = (payload.notes or "").strip() or None
        if notes != row.notes:
            row.notes = notes
            changed.append("notes")
    return changed


@router.patch("/materials/{material_need_id}", response_model=ProjectMaterialNeedOut)
def update_project_material_need(
    material_need_id: int,
    payload: ProjectMaterialNeedUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    row, project = _load_visible_material_need(db, current_user, material_need_id)

    previous_status = _normalize_material_need_status(row.status)
    if payload.status is not None:
        next_status = _normalize_material_need_status(payload.status, strict=True)
        row.status = next_status
    else:
        next_status = previous_status

    changed_fields = _apply_material_need_edits(db, row, payload)
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
    if changed_fields:
        _record_project_activity(
            db,
            project_id=row.project_id,
            actor_user_id=current_user.id,
            event_type="material.updated",
            message=f"Material need updated ({row.item[:80]})",
            details={"material_need_id": row.id, "item": row.item, "fields": changed_fields},
        )
    db.commit()
    db.refresh(row)
    report = db.get(ConstructionReport, row.construction_report_id) if row.construction_report_id is not None else None
    catalog_item = db.get(MaterialCatalogItem, row.material_catalog_item_id) if row.material_catalog_item_id else None
    supplier = (
        db.get(WerkstattSupplier, catalog_item.supplier_id)
        if catalog_item is not None and catalog_item.supplier_id is not None
        else None
    )
    order = db.get(WerkstattOrder, row.werkstatt_order_id) if row.werkstatt_order_id else None
    return _project_material_need_out(
        row,
        project=project,
        report=report,
        catalog_item=catalog_item,
        supplier=supplier,
        order=order,
    )


@router.delete("/materials/{material_need_id}", status_code=204)
def delete_project_material_need(
    material_need_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Remove one need. An order it reached keeps its line.

    Deleting the need is a statement about the Bedarfe list, not about the
    wholesaler: the line is what was actually bought and somebody will have
    to receive it either way. So this unlinks and stops there.
    """

    row, _ = _load_visible_material_need(db, current_user, material_need_id)
    item_label = row.item
    _record_project_activity(
        db,
        project_id=row.project_id,
        actor_user_id=current_user.id,
        event_type="material.deleted",
        message=f"Material need deleted ({item_label[:80]})",
        details={
            "material_need_id": row.id,
            "item": item_label,
            "werkstatt_order_id": row.werkstatt_order_id,
        },
    )
    db.delete(row)
    db.commit()
    return Response(status_code=204)

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
