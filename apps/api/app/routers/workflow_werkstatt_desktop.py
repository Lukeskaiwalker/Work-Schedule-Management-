"""Werkstatt — Desktop persona endpoints.

Owned by: Desktop BE agent.

This router covers the "workshop admin" persona:
  - Articles CRUD (incl. from-catalog creation, image refresh, link-catalog)
  - Categories & Locations (taxonomy)
  - Suppliers CRUD
  - Article-Supplier link management
  - Datanorm upload + supplier-scoped import (preview + commit)
  - Catalog search (proxied for Werkstatt context)
  - Projekt-Bedarfe read-through (cross-project material needs view,
    relocated from legacy MaterialsPage)
  - Desktop dashboard aggregate

Implementation is split across the following sub-files (mounted below) so no
single file grows past ~400 lines:

  workflow_werkstatt_taxonomy.py  — categories + locations
  workflow_werkstatt_suppliers.py — suppliers CRUD
  workflow_werkstatt_articles.py  — articles + article-supplier links
  workflow_werkstatt_datanorm.py  — Datanorm upload + commit + history
  workflow_werkstatt_catalog.py   — Werkstatt-shaped catalog search
  workflow_werkstatt_bedarfe.py   — Projekt-Bedarfe read-through

All endpoints:
  - Use the shared dependency pattern `get_current_user` + `get_db`
  - Respect `effective_permissions` — mutations require `"werkstatt:manage"`
    (admin role implicitly has it; see `app/core/permissions.py`)
  - Return Pydantic schemas from `app.schemas.werkstatt`
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.core.db import get_db
from app.core.deps import get_current_user
from app.models.entities import User
from app.routers.workflow_werkstatt_article_suppliers import router as article_suppliers_router
from app.routers.workflow_werkstatt_articles import router as articles_router
from app.routers.workflow_werkstatt_bedarfe import router as bedarfe_router
from app.routers.workflow_werkstatt_catalog import router as catalog_router
from app.routers.workflow_werkstatt_datanorm import router as datanorm_router
from app.routers.workflow_werkstatt_suppliers import router as suppliers_router
from app.routers.workflow_werkstatt_taxonomy import router as taxonomy_router
from app.schemas.werkstatt import WerkstattDashboardOut
from app.services.werkstatt_dashboard import (
    compute_dashboard_kpis,
    compute_reorder_preview,
    maintenance_entries,
    on_site_groups,
    recent_movements,
)
from sqlalchemy.orm import Session

router = APIRouter(prefix="/werkstatt", tags=["werkstatt-desktop"])

router.include_router(taxonomy_router)
router.include_router(suppliers_router)
router.include_router(articles_router)
router.include_router(article_suppliers_router)
router.include_router(datanorm_router)
router.include_router(catalog_router)
router.include_router(bedarfe_router)


@router.get("/dashboard", response_model=WerkstattDashboardOut)
def get_werkstatt_dashboard(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WerkstattDashboardOut:
    """Aggregate dashboard payload: KPIs + reorder preview + recent movements
    + on-site groups + upcoming BG-Prüfung inspections. Small limits (≤5 each)."""
    return WerkstattDashboardOut(
        kpis=compute_dashboard_kpis(db),
        reorder_preview=compute_reorder_preview(db),
        recent_movements=recent_movements(db),
        on_site_groups=on_site_groups(db),
        maintenance_entries=maintenance_entries(db),
    )
