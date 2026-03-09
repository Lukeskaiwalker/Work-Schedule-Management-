from __future__ import annotations

from fastapi import APIRouter

from app.routers.workflow_helpers import *  # noqa: F401,F403

router = APIRouter(prefix="", tags=["materials"])


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
        (ProjectMaterialNeed.status == "completed", 3),
        else_=4,
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
    limit: int = Query(default=10, ge=1),
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rows = search_material_catalog(db, query=q, limit=min(limit, 10))
    return [_material_catalog_item_out(row) for row in rows]

@router.get("/materials/catalog/state", response_model=MaterialCatalogImportStateOut)
def get_material_catalog_state(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    state = get_material_catalog_import_state(db)
    processed = sync_pending_material_catalog_images(db, limit=1)
    image_status = get_material_catalog_image_status(db)
    return MaterialCatalogImportStateOut(
        file_count=(state.file_count if state is not None else 0),
        item_count=(state.item_count if state is not None else 0),
        duplicates_skipped=(state.duplicates_skipped if state is not None else 0),
        imported_at=(state.imported_at if state is not None else None),
        image_lookup_enabled=image_status.lookup_enabled,
        image_last_run_processed=processed,
        image_total_items=image_status.total_items,
        image_items_with_image=image_status.items_with_image,
        image_items_checked=image_status.items_checked,
        image_items_pending=image_status.items_pending,
        image_items_waiting_retry=image_status.items_waiting_retry,
        image_items_not_found=image_status.items_not_found,
        image_last_checked_at=image_status.last_checked_at,
    )

@router.post("/materials", response_model=ProjectMaterialNeedOut)
def create_project_material_need(
    payload: ProjectMaterialNeedCreate,
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
        ensure_material_catalog_item_image(db, selected_catalog_item)

    row = ProjectMaterialNeed(
        project_id=payload.project_id,
        construction_report_id=None,
        item=item_name,
        material_catalog_item_id=selected_catalog_item.id if selected_catalog_item else None,
        article_no=normalized_article or None,
        unit=normalized_unit or None,
        quantity=normalized_quantity or None,
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
    catalog_item = db.get(MaterialCatalogItem, row.material_catalog_item_id) if row.material_catalog_item_id else None
    return _project_material_need_out(row, project=project, report=report, catalog_item=catalog_item)

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
