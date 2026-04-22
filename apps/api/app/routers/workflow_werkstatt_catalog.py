"""Werkstatt catalog search.

Wraps the shared `search_material_catalog` so the Werkstatt UI can look up
Datanorm rows to create articles from. The response shape differs from the
legacy `/api/materials/catalog`:

- Returns `MaterialCatalogItemLiteOut` (a projected subset)
- Optionally filters by supplier_id
- Groups rows with the same non-empty EAN into a single hero + supplier list,
  so the picker can show "one article, multiple suppliers" cleanly.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, Query
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user
from app.models.entities import MaterialCatalogItem, User, WerkstattSupplier
from app.schemas.werkstatt import (
    MaterialCatalogItemLiteOut,
    WerkstattCatalogGroupOut,
)
from app.services.material_catalog import record_searched_item_ids

router = APIRouter(prefix="", tags=["werkstatt-desktop"])


def _supplier_name_map(db: Session, supplier_ids: set[int]) -> dict[int, str]:
    if not supplier_ids:
        return {}
    rows = db.execute(
        select(WerkstattSupplier.id, WerkstattSupplier.name).where(
            WerkstattSupplier.id.in_(supplier_ids)
        )
    ).all()
    return {sid: name for sid, name in rows}


def _catalog_lite(row: MaterialCatalogItem, *, supplier_name: str | None) -> MaterialCatalogItemLiteOut:
    return MaterialCatalogItemLiteOut(
        id=row.id,
        external_key=row.external_key,
        supplier_id=row.supplier_id,
        supplier_name=supplier_name,
        article_no=row.article_no,
        item_name=row.item_name,
        ean=row.ean,
        manufacturer=row.manufacturer,
        unit=row.unit,
        price_text=row.price_text,
        image_url=row.image_url,
    )


def _search_werkstatt_catalog(
    db: Session, *, query: str, limit: int, supplier_id: int | None
) -> list[MaterialCatalogItem]:
    """Werkstatt-scoped catalog search.

    Differs from `search_material_catalog` in that it does NOT trigger the
    filesystem-based reimport (`ensure_material_catalog_up_to_date`) — the
    Werkstatt Datanorm imports own the catalog data for their supplier, and
    we don't want a read path to wipe them.
    """
    q = query.strip().lower()
    capped_limit = max(1, min(limit, 120))
    stmt = select(MaterialCatalogItem)
    if supplier_id is not None:
        stmt = stmt.where(MaterialCatalogItem.supplier_id == supplier_id)
    if q:
        terms = [term for term in re.split(r"\s+", q) if term]
        for term in terms:
            escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            stmt = stmt.where(
                func.lower(MaterialCatalogItem.search_text).like(f"%{escaped}%", escape="\\")
            )
        rank = case(
            (func.lower(MaterialCatalogItem.article_no) == q, 0),
            (func.lower(MaterialCatalogItem.article_no).like(f"{q}%", escape="\\"), 1),
            (func.lower(MaterialCatalogItem.item_name).like(f"{q}%", escape="\\"), 2),
            else_=3,
        )
        stmt = stmt.order_by(
            rank.asc(), MaterialCatalogItem.item_name.asc(), MaterialCatalogItem.id.asc()
        )
    else:
        stmt = stmt.order_by(MaterialCatalogItem.item_name.asc(), MaterialCatalogItem.id.asc())
    rows = list(db.scalars(stmt.limit(capped_limit)).all())
    # Still prioritise these IDs for the background image loop.
    record_searched_item_ids([r.id for r in rows])
    return rows


@router.get("/catalog/search", response_model=list[WerkstattCatalogGroupOut])
def search_catalog(
    q: str = Query(default=""),
    limit: int = Query(default=40, ge=1, le=120),
    supplier_id: int | None = Query(default=None),
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[WerkstattCatalogGroupOut]:
    rows = _search_werkstatt_catalog(db, query=q, limit=limit, supplier_id=supplier_id)
    supplier_ids = {row.supplier_id for row in rows if row.supplier_id}
    supplier_names = _supplier_name_map(db, supplier_ids)

    groups: list[WerkstattCatalogGroupOut] = []
    groups_by_ean: dict[str, WerkstattCatalogGroupOut] = {}
    for row in rows:
        lite = _catalog_lite(
            row,
            supplier_name=(supplier_names.get(row.supplier_id) if row.supplier_id else None),
        )
        ean_key = (row.ean or "").strip()
        if ean_key and ean_key in groups_by_ean:
            groups_by_ean[ean_key].suppliers.append(lite)
            continue
        group = WerkstattCatalogGroupOut(
            ean=ean_key or None,
            hero=lite,
            suppliers=[lite],
        )
        groups.append(group)
        if ean_key:
            groups_by_ean[ean_key] = group
    return groups
