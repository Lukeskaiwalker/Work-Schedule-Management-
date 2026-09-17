"""Werkstatt › Projekt-Bedarfe — the office's shopping list.

One screen answers "what is missing, on which building site, and can I buy
it?", so the endpoints here are shaped for working through a hundred rows at
once rather than clicking one at a time:

  GET  /werkstatt/bedarfe              filtered, with supplier + order context
  POST /werkstatt/bedarfe/bulk         set a status (or note) on a selection
  POST /werkstatt/bedarfe/bulk-delete  remove a selection
  POST /werkstatt/bedarfe/create-order draft an order per supplier from one

Visibility is checked on every one of them, by id, because a selection made
minutes ago can name a project that has since been archived or a membership
that has since been removed — a bulk endpoint that trusted its input would be
the widest hole in the app.

The heavy lifting lives in services: `material_need_orders` builds the lines,
`material_needs` carries order events back. This file stays a router.
"""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from sqlalchemy import case, or_, select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user, require_permission
from app.core.time import utcnow
from app.models.entities import (
    ConstructionReport,
    MaterialCatalogItem,
    Project,
    ProjectMaterialNeed,
    User,
    WerkstattOrder,
    WerkstattSupplier,
)
from app.routers._werkstatt_tablet_shared import load_order_full
from app.routers.workflow_helpers import (
    _active_projects_visible_to_user,
    _normalize_material_need_status,
    _project_ids_visible_to_user,
    _project_material_need_out,
    _projects_visible_to_user,
    _record_project_activity,
)
from app.schemas.material_needs import (
    MaterialNeedBulkDelete,
    MaterialNeedBulkDeleteResult,
    MaterialNeedBulkUpdate,
    MaterialNeedOrderRequest,
    MaterialNeedOrderResult,
)
from app.schemas.materials import ProjectMaterialNeedOut
from app.services.material_need_orders import create_orders_from_needs

router = APIRouter(prefix="", tags=["werkstatt-desktop"])

# Sort key for the list: what still has to be bought first, what is finished
# last. Mirrors utils/materials.ts so the page never re-sorts server output.
_STATUS_RANK = case(
    (ProjectMaterialNeed.status == "order", 0),
    (ProjectMaterialNeed.status == "ordered", 1),
    (ProjectMaterialNeed.status == "on_the_way", 2),
    (ProjectMaterialNeed.status == "available", 3),
    (ProjectMaterialNeed.status == "completed", 4),
    else_=5,
)


def _requested_statuses(raw: str | None) -> list[str]:
    """"order,ordered" → the canonical values.

    A filter nobody recognises is refused rather than dropped: silently
    ignoring it would answer `?status=bestelt` with MORE rows than asked for
    (everything except completed), which is the opposite of what a filter is.
    """

    if not raw or not raw.strip():
        return []
    wanted: list[str] = []
    for chunk in raw.split(","):
        normalized = _normalize_material_need_status(chunk, default="")
        if normalized and normalized not in wanted:
            wanted.append(normalized)
    if not wanted:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unbekannter Status-Filter: '{raw.strip()[:64]}'",
        )
    return wanted


# What the toolbar's "ohne Katalog" option sends. Spelled out rather than
# overloading 0, because a supplier id of 0 is a typo, not a request.
_SUPPLIER_WITHOUT_CATALOG = "none"


def _requested_supplier(raw: str | None) -> int | str | None:
    """A supplier id, the "no catalogue supplier" sentinel, or no filter."""

    text = (raw or "").strip().lower()
    if not text:
        return None
    if text in {_SUPPLIER_WITHOUT_CATALOG, "ohne", "null"}:
        return _SUPPLIER_WITHOUT_CATALOG
    try:
        return int(text)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unbekannter Lieferanten-Filter: '{text[:64]}'",
        ) from None


@router.get("/bedarfe", response_model=list[ProjectMaterialNeedOut])
def list_werkstatt_bedarfe(
    status_filter: str | None = Query(default=None, alias="status"),
    project_id: int | None = None,
    supplier_id: str | None = Query(
        default=None,
        description="Lieferanten-ID, oder 'none' für Zeilen ohne Katalog-Lieferant",
    ),
    q: str = "",
    include_completed: bool = False,
    orderable_only: bool = False,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ProjectMaterialNeedOut]:
    """Every need the caller may see, narrowed by the toolbar's filters."""

    # Parsed before anything is loaded: a malformed filter is a bad request
    # whether or not the caller happens to have a visible project, and the
    # empty-list shortcut below would otherwise answer a typo with 200.
    statuses = _requested_statuses(status_filter)
    supplier_filter = _requested_supplier(supplier_id)

    visible_projects = _active_projects_visible_to_user(db, current_user)
    if project_id is not None:
        visible_projects = [project for project in visible_projects if project.id == project_id]
    if not visible_projects:
        return []
    projects_by_id = {project.id: project for project in visible_projects}

    query = (
        select(
            ProjectMaterialNeed,
            ConstructionReport,
            MaterialCatalogItem,
            WerkstattSupplier,
            WerkstattOrder,
        )
        .outerjoin(
            ConstructionReport,
            ConstructionReport.id == ProjectMaterialNeed.construction_report_id,
        )
        .outerjoin(
            MaterialCatalogItem,
            MaterialCatalogItem.id == ProjectMaterialNeed.material_catalog_item_id,
        )
        .outerjoin(WerkstattSupplier, WerkstattSupplier.id == MaterialCatalogItem.supplier_id)
        .outerjoin(WerkstattOrder, WerkstattOrder.id == ProjectMaterialNeed.werkstatt_order_id)
        .where(ProjectMaterialNeed.project_id.in_(list(projects_by_id)))
    )

    if statuses:
        # The chips and "Erledigte anzeigen" are additive, not exclusive: a
        # user who ticks the box after clicking a chip is asking for the
        # finished rows AS WELL, and silently ignoring one of two visibly
        # active controls is indistinguishable from a broken checkbox.
        wanted = statuses + ["completed"] if include_completed else statuses
        query = query.where(ProjectMaterialNeed.status.in_(wanted))
    elif not include_completed:
        query = query.where(ProjectMaterialNeed.status != "completed")

    if supplier_filter == _SUPPLIER_WITHOUT_CATALOG:
        # The outer join makes this NULL for both shapes of unorderable row —
        # no catalogue link at all, and a catalogue row without a supplier —
        # which is exactly the queue "Katalog-Artikel zuordnen" works through.
        query = query.where(MaterialCatalogItem.supplier_id.is_(None))
    elif supplier_filter is not None:
        query = query.where(MaterialCatalogItem.supplier_id == supplier_filter)
    if orderable_only:
        query = query.where(MaterialCatalogItem.supplier_id.is_not(None))

    needle = q.strip()
    if needle:
        # The project number is in here because it is what the office says out
        # loud ("was fehlt auf der 2026-110?"), and it is not on the need row.
        matching_project_ids = [
            project.id
            for project in visible_projects
            if needle.lower() in (project.project_number or "").lower()
        ]
        pattern = f"%{needle}%"
        conditions = [
            ProjectMaterialNeed.item.ilike(pattern),
            ProjectMaterialNeed.article_no.ilike(pattern),
            ProjectMaterialNeed.notes.ilike(pattern),
            MaterialCatalogItem.item_name.ilike(pattern),
        ]
        if matching_project_ids:
            conditions.append(ProjectMaterialNeed.project_id.in_(matching_project_ids))
        query = query.where(or_(*conditions))

    rows = db.execute(
        query.order_by(
            _STATUS_RANK.asc(),
            ProjectMaterialNeed.created_at.desc(),
            ProjectMaterialNeed.id.desc(),
        )
    ).all()

    result: list[ProjectMaterialNeedOut] = []
    for material_need, report, catalog_item, supplier, order in rows:
        project = projects_by_id.get(material_need.project_id)
        if project is None:
            continue
        result.append(
            _project_material_need_out(
                material_need,
                project=project,
                report=report,
                catalog_item=catalog_item,
                supplier=supplier,
                order=order,
            )
        )
    return result


def _load_needs_for_ids(
    db: Session, current_user: User, ids: list[int]
) -> tuple[list[ProjectMaterialNeed], dict[int, Project]]:
    """The rows behind a selection, or a 403 naming the ones that are not.

    Archived projects are included deliberately: they are hidden from the
    list, but a row already selected must still be completable rather than
    silently skipped. What is refused is a row the caller cannot see at all.
    """

    unique_ids = list(dict.fromkeys(ids))
    needs = list(
        db.scalars(select(ProjectMaterialNeed).where(ProjectMaterialNeed.id.in_(unique_ids))).all()
    )
    found_ids = {need.id for need in needs}
    missing = [need_id for need_id in unique_ids if need_id not in found_ids]
    if missing:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Bedarfe nicht gefunden: {missing}",
        )

    visible_project_ids = _project_ids_visible_to_user(db, current_user)
    denied = sorted({need.id for need in needs if need.project_id not in visible_project_ids})
    if denied:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Kein Zugriff auf diese Bedarfe: {denied}",
        )

    projects_by_id = {
        project.id: project for project in _projects_visible_to_user(db, current_user)
    }
    return needs, projects_by_id


def _needs_out(
    db: Session, need_ids: list[int], projects_by_id: dict[int, Project]
) -> list[ProjectMaterialNeedOut]:
    """Re-read a set of needs WITH their context, in one query.

    Per-row `db.get` calls would be five queries times the selection — the
    bulk endpoints exist precisely for selections of eighty, so the answer
    must not cost four hundred round trips.
    """

    if not need_ids:
        return []
    rows = db.execute(
        select(
            ProjectMaterialNeed,
            ConstructionReport,
            MaterialCatalogItem,
            WerkstattSupplier,
            WerkstattOrder,
        )
        .outerjoin(
            ConstructionReport,
            ConstructionReport.id == ProjectMaterialNeed.construction_report_id,
        )
        .outerjoin(
            MaterialCatalogItem,
            MaterialCatalogItem.id == ProjectMaterialNeed.material_catalog_item_id,
        )
        .outerjoin(WerkstattSupplier, WerkstattSupplier.id == MaterialCatalogItem.supplier_id)
        .outerjoin(WerkstattOrder, WerkstattOrder.id == ProjectMaterialNeed.werkstatt_order_id)
        .where(ProjectMaterialNeed.id.in_(need_ids))
    ).all()

    by_id: dict[int, ProjectMaterialNeedOut] = {}
    for need, report, catalog_item, supplier, order in rows:
        project = projects_by_id.get(need.project_id)
        if project is None:
            continue
        by_id[need.id] = _project_material_need_out(
            need,
            project=project,
            report=report,
            catalog_item=catalog_item,
            supplier=supplier,
            order=order,
        )
    # Answer in the order the caller asked, so the page can zip the response
    # onto its own rows without sorting.
    return [by_id[need_id] for need_id in need_ids if need_id in by_id]


@router.post("/bedarfe/bulk", response_model=list[ProjectMaterialNeedOut])
def bulk_update_werkstatt_bedarfe(
    payload: MaterialNeedBulkUpdate = Body(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ProjectMaterialNeedOut]:
    """Set one status (and/or note) on a whole selection, in one transaction."""

    if payload.status is None and payload.notes is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Bitte Status oder Notiz angeben",
        )
    needs, projects_by_id = _load_needs_for_ids(db, current_user, payload.ids)
    next_status = (
        _normalize_material_need_status(payload.status, strict=True)
        if payload.status is not None
        else None
    )
    notes = payload.notes.strip() if payload.notes is not None else None

    now = utcnow()
    touched_per_project: dict[int, int] = {}
    for need in needs:
        if next_status is not None:
            need.status = next_status
        if payload.notes is not None:
            need.notes = notes or None
        need.updated_by = current_user.id
        need.updated_at = now
        db.add(need)
        touched_per_project[need.project_id] = touched_per_project.get(need.project_id, 0) + 1

    # ONE entry per project, not one per row: eighty needs completed on a
    # Friday afternoon would otherwise bury everything else in the feed.
    for project_id, count in touched_per_project.items():
        _record_project_activity(
            db,
            project_id=project_id,
            actor_user_id=current_user.id,
            event_type="material.bulk_status_updated",
            message=f"{count} Bedarfe aktualisiert",
            details={"count": count, "to": next_status, "notes_set": payload.notes is not None},
        )
    db.commit()

    return _needs_out(db, [need.id for need in needs], projects_by_id)


@router.post("/bedarfe/bulk-delete", response_model=MaterialNeedBulkDeleteResult)
def bulk_delete_werkstatt_bedarfe(
    payload: MaterialNeedBulkDelete = Body(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> MaterialNeedBulkDeleteResult:
    """Delete a selection. Order lines they reached are left in place."""

    needs, _ = _load_needs_for_ids(db, current_user, payload.ids)
    deleted_per_project: dict[int, int] = {}
    for need in needs:
        deleted_per_project[need.project_id] = deleted_per_project.get(need.project_id, 0) + 1
        db.delete(need)
    for project_id, count in deleted_per_project.items():
        _record_project_activity(
            db,
            project_id=project_id,
            actor_user_id=current_user.id,
            event_type="material.bulk_deleted",
            message=f"{count} Bedarfe gelöscht",
            details={"count": count},
        )
    db.commit()
    return MaterialNeedBulkDeleteResult(deleted=len(needs))


@router.post("/bedarfe/create-order", response_model=MaterialNeedOrderResult)
def create_order_from_werkstatt_bedarfe(
    payload: MaterialNeedOrderRequest = Body(...),
    current_user: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> MaterialNeedOrderResult:
    """Draft one order per supplier from the selected needs.

    Always a DRAFT: an order assembled from a dozen sites is exactly the one a
    buyer should read before it leaves the house, and the pre-send resolution
    gate is where that happens. Nothing here sends anything.
    """

    needs, projects_by_id = _load_needs_for_ids(db, current_user, payload.need_ids)
    now = utcnow()
    try:
        outcome = create_orders_from_needs(
            db,
            needs=needs,
            projects_by_id=projects_by_id,
            supplier_id=payload.supplier_id,
            order_id=payload.order_id,
            title=payload.title,
            actor_user_id=current_user.id,
            now=now,
        )
    except HTTPException:
        # A refused line must not leave a half-built draft behind.
        db.rollback()
        raise

    for entry in outcome.activity:
        _record_project_activity(
            db,
            project_id=entry.project_id,
            actor_user_id=current_user.id,
            event_type="material.ordered",
            message=f"{entry.count} Bedarfe in {entry.order_number} übernommen",
            details={
                "count": entry.count,
                "order_id": entry.order_id,
                "order_number": entry.order_number,
            },
        )
    db.commit()

    return MaterialNeedOrderResult(
        orders=[load_order_full(db, order) for order in outcome.orders],
        added=outcome.added,
        skipped=outcome.skipped,
        created_at=now,
    )
