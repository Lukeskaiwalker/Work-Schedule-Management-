"""Werkstatt taxonomy — categories and locations CRUD.

Included from `workflow_werkstatt_desktop.py`. Covers:

- GET/POST/PATCH/DELETE /werkstatt/categories
- GET/POST/PATCH/DELETE /werkstatt/locations

Soft-archive on DELETE (sets `is_archived=True`).

See `WERKSTATT_CONTRACT.md` §3.3.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user, require_permission
from app.core.time import utcnow
from app.models.entities import (
    User,
    WerkstattArticle,
    WerkstattCategory,
    WerkstattLocation,
)
from app.schemas.werkstatt import (
    WerkstattCategoryCreate,
    WerkstattCategoryOut,
    WerkstattCategoryUpdate,
    WerkstattLocationCreate,
    WerkstattLocationOut,
    WerkstattLocationUpdate,
)

router = APIRouter(prefix="", tags=["werkstatt-desktop"])


# ──────────────────────────────────────────────────────────────────────────
# Shared helpers
# ──────────────────────────────────────────────────────────────────────────


def _category_article_counts(db: Session) -> dict[int, int]:
    rows = db.execute(
        select(WerkstattArticle.category_id, func.count(WerkstattArticle.id))
        .where(
            WerkstattArticle.is_archived.is_(False),
            WerkstattArticle.category_id.is_not(None),
        )
        .group_by(WerkstattArticle.category_id)
    ).all()
    return {cid: int(count) for cid, count in rows}


def _location_article_counts(db: Session) -> dict[int, int]:
    rows = db.execute(
        select(WerkstattArticle.location_id, func.count(WerkstattArticle.id))
        .where(
            WerkstattArticle.is_archived.is_(False),
            WerkstattArticle.location_id.is_not(None),
        )
        .group_by(WerkstattArticle.location_id)
    ).all()
    return {lid: int(count) for lid, count in rows}


def _sort_tree(nodes: list, *, parent_attr: str = "parent_id") -> list:
    """Sort so that parents come first, then children by display_order → name → id.

    Works for any mapping where each node has `.id`, `.parent_id`, `.display_order`,
    `.name`. Orphans (parent not in set) are treated as roots.
    """
    by_parent: dict[int | None, list] = {}
    ids = {node.id for node in nodes}
    for node in nodes:
        parent = getattr(node, parent_attr)
        key = parent if parent in ids else None
        by_parent.setdefault(key, []).append(node)
    for siblings in by_parent.values():
        siblings.sort(key=lambda n: (n.display_order, (n.name or "").lower(), n.id))
    ordered: list = []

    def _walk(key: int | None) -> None:
        for child in by_parent.get(key, []):
            ordered.append(child)
            _walk(child.id)

    _walk(None)
    # Fallback — if cycles exist or we missed anything, append leftovers.
    seen = {n.id for n in ordered}
    for node in nodes:
        if node.id not in seen:
            ordered.append(node)
    return ordered


def _category_out(row: WerkstattCategory, *, article_count: int = 0) -> WerkstattCategoryOut:
    return WerkstattCategoryOut(
        id=row.id,
        name=row.name,
        parent_id=row.parent_id,
        display_order=row.display_order,
        icon_key=row.icon_key,
        notes=row.notes,
        is_archived=row.is_archived,
        article_count=article_count,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _location_out(row: WerkstattLocation, *, article_count: int = 0) -> WerkstattLocationOut:
    return WerkstattLocationOut(
        id=row.id,
        name=row.name,
        location_type=row.location_type,  # type: ignore[arg-type]
        parent_id=row.parent_id,
        address=row.address,
        display_order=row.display_order,
        notes=row.notes,
        is_archived=row.is_archived,
        article_count=article_count,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


# ──────────────────────────────────────────────────────────────────────────
# Categories
# ──────────────────────────────────────────────────────────────────────────


@router.get("/categories", response_model=list[WerkstattCategoryOut])
def list_categories(
    include_archived: bool = Query(default=False),
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[WerkstattCategoryOut]:
    stmt = select(WerkstattCategory)
    if not include_archived:
        stmt = stmt.where(WerkstattCategory.is_archived.is_(False))
    rows = list(db.scalars(stmt).all())
    counts = _category_article_counts(db)
    sorted_rows = _sort_tree(rows)
    return [_category_out(r, article_count=counts.get(r.id, 0)) for r in sorted_rows]


@router.post("/categories", response_model=WerkstattCategoryOut)
def create_category(
    payload: WerkstattCategoryCreate,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattCategoryOut:
    if payload.parent_id is not None:
        parent = db.get(WerkstattCategory, payload.parent_id)
        if parent is None:
            raise HTTPException(status_code=400, detail="Parent category not found")
    row = WerkstattCategory(
        name=payload.name.strip(),
        parent_id=payload.parent_id,
        display_order=payload.display_order,
        icon_key=(payload.icon_key or None),
        notes=(payload.notes or None),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _category_out(row)


@router.patch("/categories/{category_id}", response_model=WerkstattCategoryOut)
def update_category(
    category_id: int,
    payload: WerkstattCategoryUpdate,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattCategoryOut:
    row = db.get(WerkstattCategory, category_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Category not found")
    data = payload.model_dump(exclude_unset=True)
    if "parent_id" in data:
        new_parent = data["parent_id"]
        if new_parent == category_id:
            raise HTTPException(status_code=400, detail="Category cannot be its own parent")
        if new_parent is not None and db.get(WerkstattCategory, new_parent) is None:
            raise HTTPException(status_code=400, detail="Parent category not found")
    for field, value in data.items():
        if field == "name" and value is not None:
            value = value.strip()
        setattr(row, field, value)
    row.updated_at = utcnow()
    db.add(row)
    db.commit()
    db.refresh(row)
    return _category_out(row)


@router.delete("/categories/{category_id}", response_model=WerkstattCategoryOut)
def archive_category(
    category_id: int,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattCategoryOut:
    row = db.get(WerkstattCategory, category_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Category not found")
    row.is_archived = True
    row.updated_at = utcnow()
    db.add(row)
    db.commit()
    db.refresh(row)
    return _category_out(row)


# ──────────────────────────────────────────────────────────────────────────
# Locations
# ──────────────────────────────────────────────────────────────────────────


@router.get("/locations", response_model=list[WerkstattLocationOut])
def list_locations(
    include_archived: bool = Query(default=False),
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[WerkstattLocationOut]:
    stmt = select(WerkstattLocation)
    if not include_archived:
        stmt = stmt.where(WerkstattLocation.is_archived.is_(False))
    rows = list(db.scalars(stmt).all())
    counts = _location_article_counts(db)
    sorted_rows = _sort_tree(rows)
    return [_location_out(r, article_count=counts.get(r.id, 0)) for r in sorted_rows]


@router.post("/locations", response_model=WerkstattLocationOut)
def create_location(
    payload: WerkstattLocationCreate,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattLocationOut:
    if payload.parent_id is not None:
        parent = db.get(WerkstattLocation, payload.parent_id)
        if parent is None:
            raise HTTPException(status_code=400, detail="Parent location not found")
    row = WerkstattLocation(
        name=payload.name.strip(),
        location_type=payload.location_type,
        parent_id=payload.parent_id,
        address=(payload.address or None),
        display_order=payload.display_order,
        notes=(payload.notes or None),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _location_out(row)


@router.patch("/locations/{location_id}", response_model=WerkstattLocationOut)
def update_location(
    location_id: int,
    payload: WerkstattLocationUpdate,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattLocationOut:
    row = db.get(WerkstattLocation, location_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Location not found")
    data = payload.model_dump(exclude_unset=True)
    if "parent_id" in data:
        new_parent = data["parent_id"]
        if new_parent == location_id:
            raise HTTPException(status_code=400, detail="Location cannot be its own parent")
        if new_parent is not None and db.get(WerkstattLocation, new_parent) is None:
            raise HTTPException(status_code=400, detail="Parent location not found")
    for field, value in data.items():
        if field == "name" and value is not None:
            value = value.strip()
        setattr(row, field, value)
    row.updated_at = utcnow()
    db.add(row)
    db.commit()
    db.refresh(row)
    return _location_out(row)


@router.delete("/locations/{location_id}", response_model=WerkstattLocationOut)
def archive_location(
    location_id: int,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattLocationOut:
    row = db.get(WerkstattLocation, location_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Location not found")
    row.is_archived = True
    row.updated_at = utcnow()
    db.add(row)
    db.commit()
    db.refresh(row)
    return _location_out(row)
