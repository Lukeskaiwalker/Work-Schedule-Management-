"""Werkstatt — Tablet persona endpoints (composite router).

Owned by: Tablet BE agent.

This router covers the "site supervisor" persona:
  - Orders lifecycle (draft → sent → delivered)
  - Reorder suggestions + convert-to-order
  - BG-Prüfung (tool-safety inspection) tracking

See `WERKSTATT_CONTRACT.md` §3.4 for the endpoint contract, §5 for file
ownership, and §6 for conventions.

Business rules enforced here (delegated to service helpers):
  - Strict order status machine — invalid transitions raise 409 Conflict.
  - On status → sent: stamp `ordered_at = now`, compute
    `expected_delivery_at = ordered_at + supplier.default_lead_time_days`
    (or the per-article-supplier override if one exists).
  - On status → delivered: stamp `delivered_at = now`, create an `intake`
    movement per order line with `related_order_line_id` backlink, and
    update `werkstatt_articles.stock_total / stock_available` accordingly.
  - BG-Prüfung: after recording, stamp `last_bg_inspected_at = now` and
    `next_bg_due_at = inspected_at + interval_days` on the article.

Implementation is split across three sibling files because the combined
router exceeded the 400-line file-size cap:

  - ``workflow_werkstatt_orders.py``       — CRUD + state-machine endpoints
  - ``workflow_werkstatt_reorder.py``      — suggestions + submit
  - ``workflow_werkstatt_inspections.py``  — BG-Prüfung endpoints
  - ``_werkstatt_tablet_shared.py``        — (private) serialisation helpers

Each sub-router declares the same ``/werkstatt`` prefix. This composite
router mounts them so the aggregator in ``workflow.py`` can include a
single router.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.routers.workflow_werkstatt_inspections import router as inspections_router
from app.routers.workflow_werkstatt_orders import router as orders_router
from app.routers.workflow_werkstatt_reorder import router as reorder_router

router = APIRouter(tags=["werkstatt-tablet"])

# Sub-routers already carry the ``/werkstatt`` prefix, so we include them
# without re-prefixing here.
router.include_router(orders_router)
router.include_router(reorder_router)
router.include_router(inspections_router)
