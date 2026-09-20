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
from app.routers.workflow_tasks import (
    router as tasks_router,
    public_confirmations_router,
)
from app.routers.workflow_sites import router as sites_router
from app.routers.workflow_files import router as files_router
from app.routers.workflow_webdav import router as webdav_router
from app.routers.workflow_customer_files import router as customer_files_router
from app.routers.workflow_project_notes import router as project_notes_router
from app.routers.workflow_project_report import router as project_report_router
from app.routers.workflow_customer_notes import router as customer_notes_router
from app.routers.workflow_customer_visits import router as customer_visits_router
from app.routers.workflow_task_files import router as task_files_router
from app.routers.workflow_webdav_customers import router as webdav_customers_router
from app.routers.workflow_wiki import router as wiki_router
from app.routers.workflow_chat import router as chat_router
from app.routers.workflow_line_items import router as line_items_router
from app.routers.workflow_line_items_extract import router as line_items_extract_router
from app.routers.workflow_reports import router as reports_router
from app.routers.workflow_system import router as system_router
from app.routers.workflow_werkstatt_desktop import router as werkstatt_desktop_router
from app.routers.workflow_werkstatt_tablet import router as werkstatt_tablet_router
from app.routers.workflow_werkstatt_mobile import router as werkstatt_mobile_router
from app.routers.workflow_werkstatt_boxes import (
    customer_boxes_router as werkstatt_customer_boxes_router,
    router as werkstatt_boxes_router,
)
from app.routers.workflow_werkstatt_machines import router as werkstatt_machines_router
from app.routers.workflow_werkstatt_ids import router as werkstatt_ids_router
from app.routers.workflow_werkstatt_ids_handoff import (
    router as werkstatt_ids_handoff_router,
)
from app.routers.workflow_werkstatt_order_composition import (
    router as werkstatt_order_composition_router,
)
from app.routers.workflow_werkstatt_order_send import (
    router as werkstatt_order_send_router,
)
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
# v2.5.0: customer-confirmation public endpoints (no JWT required).
# Mounted under /api/public/customer-confirmations/<token> — token
# uniqueness gates access. Lives in workflow_tasks.py because the
# token resolves to a Task; the file boundary stays clean since the
# whole feature is task-centric.
router.include_router(public_confirmations_router)
router.include_router(sites_router)
router.include_router(files_router)
router.include_router(webdav_router)
router.include_router(customer_files_router)
router.include_router(project_notes_router)
router.include_router(project_report_router)
router.include_router(customer_notes_router)
router.include_router(customer_visits_router)
router.include_router(task_files_router)
router.include_router(webdav_customers_router)
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
# Procurement extends the order surface the tablet router owns, so it mounts
# first: FastAPI matches routes in registration order, and
# ``POST /werkstatt/orders/from-template`` must reach its own literal route
# before anything tries to read "from-template" as an order id.
router.include_router(werkstatt_order_composition_router)
# Pre-send resolution and the manual-channel export sit on
# ``/werkstatt/orders/{id}/resolution|export`` — literal suffixes, mounted
# here for the same reason as the composition router above.
router.include_router(werkstatt_order_send_router)
router.include_router(werkstatt_ids_router)
# The two unauthenticated hand-over pages (/handoff, /hook) — same prefix,
# own file, no route overlap with the connection/submit router above.
router.include_router(werkstatt_ids_handoff_router)
# Werkstatt — three persona-scoped routers under /api/werkstatt. All three
# share the prefix; route paths within each do not collide. See
# WERKSTATT_CONTRACT.md §5 for file ownership.
router.include_router(werkstatt_desktop_router)
router.include_router(werkstatt_tablet_router)
router.include_router(werkstatt_mobile_router)
# Boxes are cross-persona (phone packs, desktop assigns) so they mount beside
# the persona routers rather than inside the desktop composite.
router.include_router(werkstatt_boxes_router)
router.include_router(werkstatt_customer_boxes_router)
# Machines are cross-persona for the same reason boxes are: the phone books
# them out by scan, the desktop maintains the register.
router.include_router(werkstatt_machines_router)
