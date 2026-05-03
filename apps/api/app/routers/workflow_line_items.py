"""ProjectLineItem CRUD router — manual entry path for v2.4.0.

The LLM-extraction path (which adds POST /extract and POST /bulk-create)
will land in a follow-up commit. This router only covers the operator-
typed-it-by-hand flow plus list/get/edit/delete, so we have working
end-to-end manual CRUD before any LLM dependency is wired in.

Permission gating mirrors the rest of the project workflow: the
existing ``projects:manage`` role permission covers everything here.
There's no separate ``line_items:manage`` because the items are an
intrinsic part of a project's data — anyone who can manage projects
can manage their line items.

Audit trail: every mutating endpoint writes a ``project_line_item.*``
audit log entry via ``log_admin_action`` so admins can later answer
"who added/changed/deleted this row, and when?".
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user, require_permission
from app.core.time import utcnow
from app.models.entities import Project, ProjectLineItem, User
from app.schemas.project_line_item import (
    ProjectLineItemCreate,
    ProjectLineItemOut,
    ProjectLineItemUpdate,
)
from app.services.audit import log_admin_action

router = APIRouter(prefix="", tags=["project-line-items"])


def _serialize(item: ProjectLineItem) -> ProjectLineItemOut:
    """Build the response shape including the computed status +
    quantity_missing fields that aren't in the ORM column set."""
    return ProjectLineItemOut.model_validate(
        {
            "id": item.id,
            "project_id": item.project_id,
            "type": item.type,
            "section_title": item.section_title,
            "position": item.position,
            "description": item.description,
            "sku": item.sku,
            "manufacturer": item.manufacturer,
            "quantity_required": item.quantity_required,
            "quantity_ordered": item.quantity_ordered,
            "quantity_delivered": item.quantity_delivered,
            "quantity_at_site": item.quantity_at_site,
            "quantity_reserved": item.quantity_reserved,
            "quantity_missing": item.quantity_missing,
            "unit": item.unit,
            "unit_price_eur": item.unit_price_eur,
            "total_price_eur": item.total_price_eur,
            "supplier_id": item.supplier_id,
            "source_doc_type": item.source_doc_type,
            "source_doc_filename": item.source_doc_filename,
            "extracted_by_model": item.extracted_by_model,
            "extraction_confidence": item.extraction_confidence,
            "notes": item.notes,
            "is_active": item.is_active,
            "status": item.status,
            "created_by": item.created_by,
            "created_at": item.created_at,
            "updated_at": item.updated_at,
        }
    )


def _get_project_or_404(db: Session, project_id: int) -> Project:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@router.get(
    "/projects/{project_id}/line-items",
    response_model=list[ProjectLineItemOut],
)
def list_line_items(
    project_id: int,
    include_inactive: bool = False,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ProjectLineItemOut]:
    """List line items for a project. Defaults to active-only;
    pass ``include_inactive=true`` to see soft-deleted rows."""
    _get_project_or_404(db, project_id)
    stmt = select(ProjectLineItem).where(ProjectLineItem.project_id == project_id)
    if not include_inactive:
        stmt = stmt.where(ProjectLineItem.is_active.is_(True))
    # Stable ordering: section first, then position, then id.
    # NULLs last on the string fields so manually-added items
    # (which may not have section/position) sort to the end.
    stmt = stmt.order_by(
        ProjectLineItem.section_title.asc().nulls_last(),
        ProjectLineItem.position.asc().nulls_last(),
        ProjectLineItem.id.asc(),
    )
    rows = db.scalars(stmt).all()
    return [_serialize(row) for row in rows]


@router.post(
    "/projects/{project_id}/line-items",
    response_model=ProjectLineItemOut,
)
def create_line_item(
    project_id: int,
    payload: ProjectLineItemCreate,
    current_user: User = Depends(require_permission("projects:manage")),
    db: Session = Depends(get_db),
) -> ProjectLineItemOut:
    """Manually create one line item. The LLM-extraction path uses a
    different bulk-create endpoint (forthcoming) so that one extraction
    review-and-commit equals one transaction across all proposed items."""
    _get_project_or_404(db, project_id)
    item = ProjectLineItem(
        project_id=project_id,
        type=payload.type,
        section_title=payload.section_title,
        position=payload.position,
        description=payload.description.strip(),
        sku=payload.sku,
        manufacturer=payload.manufacturer,
        quantity_required=payload.quantity_required,
        quantity_ordered=payload.quantity_ordered,
        quantity_delivered=payload.quantity_delivered,
        quantity_at_site=payload.quantity_at_site,
        quantity_reserved=payload.quantity_reserved,
        unit=payload.unit,
        unit_price_eur=payload.unit_price_eur,
        total_price_eur=payload.total_price_eur,
        supplier_id=payload.supplier_id,
        source_doc_type=payload.source_doc_type or "manuell",
        source_doc_filename=payload.source_doc_filename,
        extracted_by_model=payload.extracted_by_model,
        extraction_confidence=payload.extraction_confidence,
        notes=payload.notes,
        is_active=payload.is_active,
        created_by=current_user.id,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    log_admin_action(
        db,
        current_user,
        "project_line_item.create",
        "project_line_item",
        str(item.id),
        {
            "project_id": project_id,
            "type": item.type,
            "description_preview": (item.description or "")[:80],
            "source": item.source_doc_type,
        },
        category="projects",
    )
    return _serialize(item)


@router.get(
    "/projects/{project_id}/line-items/{item_id}",
    response_model=ProjectLineItemOut,
)
def get_line_item(
    project_id: int,
    item_id: int,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ProjectLineItemOut:
    item = db.get(ProjectLineItem, item_id)
    if item is None or item.project_id != project_id:
        raise HTTPException(status_code=404, detail="Line item not found")
    return _serialize(item)


@router.patch(
    "/projects/{project_id}/line-items/{item_id}",
    response_model=ProjectLineItemOut,
)
def update_line_item(
    project_id: int,
    item_id: int,
    payload: ProjectLineItemUpdate,
    current_user: User = Depends(require_permission("projects:manage")),
    db: Session = Depends(get_db),
) -> ProjectLineItemOut:
    item = db.get(ProjectLineItem, item_id)
    if item is None or item.project_id != project_id:
        raise HTTPException(status_code=404, detail="Line item not found")

    data = payload.model_dump(exclude_unset=True)
    if "description" in data and data["description"] is not None:
        data["description"] = data["description"].strip()
        if not data["description"]:
            raise HTTPException(status_code=400, detail="description cannot be empty")

    for field, value in data.items():
        setattr(item, field, value)
    item.updated_at = utcnow()
    db.add(item)
    db.commit()
    db.refresh(item)
    log_admin_action(
        db,
        current_user,
        "project_line_item.update",
        "project_line_item",
        str(item.id),
        {"project_id": project_id, "fields": sorted(data.keys())},
        category="projects",
    )
    return _serialize(item)


@router.delete("/projects/{project_id}/line-items/{item_id}")
def delete_line_item(
    project_id: int,
    item_id: int,
    current_user: User = Depends(require_permission("projects:manage")),
    db: Session = Depends(get_db),
):
    """Soft-delete (sets ``is_active = False``). Hard-delete is not
    exposed via the API on purpose — line items are an audit-relevant
    record of what was sold to a customer; once entered, they're
    history. Use ``include_inactive=true`` on the list endpoint to
    surface soft-deleted rows."""
    item = db.get(ProjectLineItem, item_id)
    if item is None or item.project_id != project_id:
        raise HTTPException(status_code=404, detail="Line item not found")
    if not item.is_active:
        # Idempotent — already soft-deleted, nothing to do.
        return {"ok": True, "id": item.id, "soft_deleted": True}
    item.is_active = False
    item.updated_at = utcnow()
    db.add(item)
    db.commit()
    log_admin_action(
        db,
        current_user,
        "project_line_item.soft_delete",
        "project_line_item",
        str(item.id),
        {"project_id": project_id},
        category="projects",
    )
    return {"ok": True, "id": item.id, "soft_deleted": True}
