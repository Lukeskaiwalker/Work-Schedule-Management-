from __future__ import annotations

from fastapi import APIRouter

from app.core.events import notify
from app.routers.workflow_helpers import *  # noqa: F401,F403
from app.models.entities import Customer
from app.services.customers import (
    match_or_create_customer,
    sync_project_from_customer,
)

router = APIRouter(prefix="", tags=["projects"])


def _project_weather_query_address(project: Project) -> str:
    return _project_location_address(project)


def _resolve_project_customer(
    db: Session,
    *,
    project: Project,
    customer_id: int | None,
    fallback_name: str | None,
    fallback_address: str | None,
    fallback_contact: str | None,
    fallback_email: str | None,
    fallback_phone: str | None,
    actor_user_id: int | None,
    explicit_customer_id_in_payload: bool = True,
) -> None:
    """Link a Project to a Customer using a three-step rule:

    1. If `customer_id` is provided, mirror that Customer's fields onto
       the Project (Customer is source of truth).
    2. Else, if `customer_name` is set on the Project, match-or-create
       a Customer using the import normalisation rule.
    3. Else, clear `customer_id` and leave the legacy fields null.
    """
    if customer_id is not None:
        customer = db.get(Customer, customer_id)
        if customer is None:
            raise HTTPException(status_code=400, detail="Customer not found")
        sync_project_from_customer(project, customer)
        return

    # No explicit customer_id — fall through to legacy-fields path.
    # (`explicit_customer_id_in_payload=False` + no legacy fields would
    # be caller-filtered upstream; we only arrive here when at least
    # one customer_* field was on the payload.)
    name = (fallback_name or "").strip()
    if name:
        customer = match_or_create_customer(
            db,
            name=name,
            address=fallback_address,
            contact_person=fallback_contact,
            email=fallback_email,
            phone=fallback_phone,
            created_by=actor_user_id,
        )
        sync_project_from_customer(project, customer)
        return

    # No identity at all — wipe the link.
    project.customer_id = None


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
        construction_site_address=payload.construction_site_address,
        customer_contact=payload.customer_contact,
        customer_email=payload.customer_email,
        customer_phone=payload.customer_phone,
        site_access_type=site_access_type,
        site_access_note=site_access_note,
        extra_attributes=payload.extra_attributes or {},
        created_by=current_user.id,
    )
    _resolve_project_customer(
        db,
        project=project,
        customer_id=payload.customer_id,
        fallback_name=payload.customer_name,
        fallback_address=payload.customer_address,
        fallback_contact=payload.customer_contact,
        fallback_email=payload.customer_email,
        fallback_phone=payload.customer_phone,
        actor_user_id=current_user.id,
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
        "construction_site_address",
        "customer_contact",
        "customer_email",
        "customer_phone",
        "extra_attributes",
    ]:
        value = getattr(payload, field)
        if value is not None:
            setattr(project, field, value)

    # Customer resolution. Three cases:
    #   (a) payload set customer_id  → look it up, mirror its fields.
    #   (b) payload set customer_name (legacy path) → match-or-create by
    #       normalised name+address, re-link the project.
    #   (c) payload only set other customer_* fields (email/contact/etc.) →
    #       treat as a patch against the project's *current* customer_name
    #       if it still has one.
    #   (d) otherwise leave the existing link alone.
    if "customer_id" in payload.model_fields_set:
        _resolve_project_customer(
            db,
            project=project,
            customer_id=payload.customer_id,
            fallback_name=project.customer_name,
            fallback_address=project.customer_address,
            fallback_contact=project.customer_contact,
            fallback_email=project.customer_email,
            fallback_phone=project.customer_phone,
            actor_user_id=current_user.id,
            explicit_customer_id_in_payload=True,
        )
    elif {"customer_name", "customer_address", "customer_contact", "customer_email", "customer_phone"} & payload.model_fields_set:
        _resolve_project_customer(
            db,
            project=project,
            customer_id=None,
            fallback_name=project.customer_name,
            fallback_address=project.customer_address,
            fallback_contact=project.customer_contact,
            fallback_email=project.customer_email,
            fallback_phone=project.customer_phone,
            actor_user_id=current_user.id,
            explicit_customer_id_in_payload=False,
        )

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
    updated_out = ProjectOut.model_validate(project)
    notify(db, "project.updated", updated_out.model_dump(mode="json"))
    return project


@router.put("/projects/{project_id}/critical", response_model=ProjectOut)
def set_project_critical(
    project_id: int,
    payload: ProjectCriticalUpdate,
    current_user: User = Depends(require_permission("projects:mark_critical")),
    db: Session = Depends(get_db),
):
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    # Anyone with the permission + any project access can toggle the flag —
    # lighter than `manage_required=True` because marking critical is a social
    # signal, not a destructive edit.
    assert_project_access(db, current_user, project_id, manage_required=False)

    changed = False
    if payload.is_critical and not project.is_critical:
        project.is_critical = True
        project.critical_since = utcnow()
        project.critical_set_by_user_id = current_user.id
        _record_project_activity(
            db,
            project_id=project.id,
            actor_user_id=current_user.id,
            event_type="project.critical_set",
            message="Project marked critical",
            details={},
        )
        changed = True
    elif not payload.is_critical and project.is_critical:
        project.is_critical = False
        project.critical_since = None
        project.critical_set_by_user_id = None
        _record_project_activity(
            db,
            project_id=project.id,
            actor_user_id=current_user.id,
            event_type="project.critical_cleared",
            message="Critical flag cleared",
            details={},
        )
        changed = True

    if changed:
        project.last_updated_at = utcnow()
        db.add(project)
        db.commit()
        db.refresh(project)
        updated_out = ProjectOut.model_validate(project)
        notify(db, "project.updated", updated_out.model_dump(mode="json"))
    return project


@router.get("/projects/{project_id}/finance", response_model=ProjectFinanceOut)
def get_project_finance(
    project_id: int,
    current_user: User = Depends(require_permission("finance:view")),
    db: Session = Depends(get_db),
):
    assert_project_access(db, current_user, project_id)
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return _project_finance_row_or_default(db, project_id)

@router.get("/projects/{project_id}/materials", response_model=list[ProjectTrackedMaterialOut])
def list_project_report_materials(
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_project_access(db, current_user, project_id)
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    reports = db.scalars(
        select(ConstructionReport)
        .where(ConstructionReport.project_id == project_id)
        .order_by(ConstructionReport.report_date.asc(), ConstructionReport.id.asc())
    ).all()
    buckets: dict[tuple[str, str, str], dict[str, object]] = {}
    for report in reports:
        payload = report.payload if isinstance(report.payload, dict) else {}
        materials = payload.get("materials")
        if not isinstance(materials, list):
            continue
        for raw_row in materials:
            if not isinstance(raw_row, dict):
                continue
            item = _normalize_report_material_text(raw_row.get("item"))
            if not item:
                continue
            unit = _normalize_report_material_text(raw_row.get("unit"))
            article_no = _normalize_report_material_text(raw_row.get("article_no"))
            qty_raw = _normalize_report_material_text(raw_row.get("qty"))

            key = (item.lower(), unit.lower(), article_no.lower())
            bucket = buckets.get(key)
            if bucket is None:
                bucket = {
                    "item": item,
                    "unit": unit or None,
                    "article_no": article_no or None,
                    "quantity_total": Decimal("0"),
                    "has_numeric_qty": False,
                    "quantity_notes": set(),
                    "occurrence_count": 0,
                    "report_ids": set(),
                    "last_report_date": None,
                }
                buckets[key] = bucket

            bucket["occurrence_count"] = int(bucket["occurrence_count"]) + 1
            report_ids = bucket["report_ids"]
            if isinstance(report_ids, set):
                report_ids.add(report.id)
            current_last = bucket["last_report_date"]
            if report.report_date and (not isinstance(current_last, date) or report.report_date > current_last):
                bucket["last_report_date"] = report.report_date

            qty_numeric = _parse_report_material_quantity(qty_raw)
            if qty_numeric is not None:
                bucket["quantity_total"] = Decimal(bucket["quantity_total"]) + qty_numeric
                bucket["has_numeric_qty"] = True
            elif qty_raw:
                quantity_notes = bucket["quantity_notes"]
                if isinstance(quantity_notes, set):
                    quantity_notes.add(qty_raw)

    result: list[ProjectTrackedMaterialOut] = []
    ordered_buckets = sorted(
        buckets.values(),
        key=lambda row: (
            str(row["item"]).lower(),
            str(row.get("unit") or "").lower(),
            str(row.get("article_no") or "").lower(),
        ),
    )
    for bucket in ordered_buckets:
        quantity_total: float | None = None
        if bool(bucket["has_numeric_qty"]):
            quantity_total = float(bucket["quantity_total"])
        quantity_notes = bucket["quantity_notes"]
        report_ids = bucket["report_ids"]
        result.append(
            ProjectTrackedMaterialOut(
                item=str(bucket["item"]),
                unit=bucket.get("unit"),
                article_no=bucket.get("article_no"),
                quantity_total=quantity_total,
                quantity_notes=sorted(quantity_notes) if isinstance(quantity_notes, set) else [],
                occurrence_count=int(bucket["occurrence_count"]),
                report_count=len(report_ids) if isinstance(report_ids, set) else 0,
                last_report_date=bucket.get("last_report_date"),
            )
        )
    return result

@router.patch("/projects/{project_id}/finance", response_model=ProjectFinanceOut)
def update_project_finance(
    project_id: int,
    payload: ProjectFinanceUpdate,
    current_user: User = Depends(require_permission("finance:manage")),
    db: Session = Depends(get_db),
):
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
        office_notes=_recent_project_office_notes_out(db, project_id, limit=10),
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

    query_address = _project_weather_query_address(project)
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
            message="Project construction site/customer address is missing",
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
            from app.routers import workflow as workflow_router
            lat, lon, days = workflow_router._fetch_openweather_forecast(
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
    return _list_active_assignable_users(db)

@router.post("/users/me/avatar")
async def upload_my_avatar(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not file.filename:
        raise HTTPException(status_code=400, detail="Avatar file is required")

    content_type = _safe_media_type(file.content_type, fallback="")
    if not _is_upload_image(file.filename, content_type):
        raise HTTPException(status_code=400, detail="Avatar must be an image")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Avatar file is empty")
    if len(raw) > MAX_AVATAR_BYTES:
        raise HTTPException(status_code=413, detail="Avatar exceeds 5 MB limit")

    extension = _file_extension(file.filename) or "jpg"
    stored_bytes = raw
    stored_content_type = content_type or (mimetypes.guess_type(file.filename or "")[0] or "image/jpeg")
    if _is_heic_upload(file.filename, content_type):
        converted = _convert_heic_to_jpeg(raw)
        if converted:
            stored_bytes = converted
            extension = "jpg"
            stored_content_type = "image/jpeg"
        else:
            extension = "heic" if extension not in HEIC_IMAGE_EXTENSIONS else extension
            stored_content_type = "image/heif" if extension == "heif" else "image/heic"

    stored_path = store_encrypted_file(stored_bytes, extension)

    previous_path = current_user.avatar_stored_path
    current_user.avatar_stored_path = stored_path
    current_user.avatar_content_type = stored_content_type
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
