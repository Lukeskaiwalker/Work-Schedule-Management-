# workflow.py — backward-compatibility shim + sub-router aggregator.
# All endpoint logic now lives in domain-specific sub-router files.
# This module combines them into a single APIRouter to preserve the existing
# main.py registration: app.include_router(workflow.router, prefix="/api")
from __future__ import annotations

from fastapi import APIRouter

from app.routers.workflow_customers import router as customers_router
from app.routers.workflow_materials import router as materials_router
from app.routers.workflow_partners import router as partners_router
from app.routers.workflow_projects import router as projects_router
from app.routers.workflow_tasks import router as tasks_router
from app.routers.workflow_sites import router as sites_router
from app.routers.workflow_files import router as files_router
from app.routers.workflow_webdav import router as webdav_router
from app.routers.workflow_wiki import router as wiki_router
from app.routers.workflow_chat import router as chat_router
from app.routers.workflow_line_items import router as line_items_router
from app.routers.workflow_line_items_extract import router as line_items_extract_router
from app.routers.workflow_reports import router as reports_router
from app.routers.workflow_system import router as system_router
from app.routers.workflow_werkstatt_desktop import router as werkstatt_desktop_router
from app.routers.workflow_werkstatt_tablet import router as werkstatt_tablet_router
from app.routers.workflow_werkstatt_mobile import router as werkstatt_mobile_router
from app.routers.workflow_helpers import (
    _fetch_openweather_forecast,
    _weather_address_candidates,
    _weather_zip_candidates,
)

router = APIRouter(prefix="", tags=["workflow"])

router.include_router(materials_router)
router.include_router(customers_router)
router.include_router(partners_router)
router.include_router(projects_router)
router.include_router(tasks_router)
router.include_router(sites_router)
router.include_router(files_router)
router.include_router(webdav_router)
router.include_router(wiki_router)
router.include_router(chat_router)
# Register the more-specific extract router BEFORE the generic CRUD
# router. FastAPI evaluates routes in registration order, so without
# this ordering ``GET /projects/{id}/line-items/extract`` would be
# matched by ``GET /projects/{id}/line-items/{item_id}`` with
# ``item_id="extract"`` and 422 on the int coercion.
router.include_router(line_items_extract_router)
router.include_router(line_items_router)
router.include_router(reports_router)
router.include_router(system_router)
# Werkstatt — three persona-scoped routers under /api/werkstatt. All three
# share the prefix; route paths within each do not collide. See
# WERKSTATT_CONTRACT.md §5 for file ownership.
router.include_router(werkstatt_desktop_router)
router.include_router(werkstatt_tablet_router)
router.include_router(werkstatt_mobile_router)
