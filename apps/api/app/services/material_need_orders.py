"""Turning selected Bedarfe into wholesaler order lines.

The rule the whole module exists to keep: a need only becomes a line when we
know WHO to buy it from and WHAT they call it. That is the catalogue link —
its supplier owns the order, its article number is the supplier number — and
a need without one is skipped with a reason rather than smuggled onto the
order as free text that fails at submit time (the owner's decision).

Everything is built through `services/werkstatt_order_lines.py`, the one line
builder the whole app uses. There is deliberately no second one here: a line
created from a need must resolve in the wholesaler's basket exactly like a
line typed into the drawer.

The result is a draft. It is never sent: an order assembled from a dozen
needs is precisely the one a buyer should look at before it leaves the house,
and the pre-send resolution gate is where that happens.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import (
    MaterialCatalogItem,
    Project,
    ProjectMaterialNeed,
    WerkstattOrder,
    WerkstattSupplier,
)
from app.schemas.material_needs import MaterialNeedOrderAdded, MaterialNeedOrderSkipped
from app.schemas.werkstatt_procurement import OrderLineCreatePayload
from app.services.material_need_rows import order_quantity_for_need
from app.services.werkstatt_order_composition import recompute_total
from app.services.werkstatt_order_lines import build_order_line, create_draft_order

# Statuses a need can still be ordered from. `available` and `completed` are
# already answered; `ordered`/`on_the_way` are caught earlier by the link.
_ORDERABLE_STATUSES = frozenset({"order", "ordered", "on_the_way"})


@dataclass(frozen=True)
class NeedOrderActivity:
    """One feed entry: "n Bedarfe in BST-… übernommen", per project."""

    project_id: int
    order_id: int
    order_number: str
    count: int


@dataclass
class NeedOrderOutcome:
    orders: list[WerkstattOrder] = field(default_factory=list)
    added: list[MaterialNeedOrderAdded] = field(default_factory=list)
    skipped: list[MaterialNeedOrderSkipped] = field(default_factory=list)
    activity: list[NeedOrderActivity] = field(default_factory=list)


def _load_draft_order(db: Session, order_id: int) -> WerkstattOrder:
    """An order that may still be added to, or the German reason it may not."""

    order = db.get(WerkstattOrder, order_id)
    if order is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Bestellung nicht gefunden"
        )
    if order.status != "draft":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Bestellung im Status '{order.status}' kann nicht mehr geändert werden",
        )
    if order.is_template:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Eine Vorlage kann keinen Bedarf aufnehmen",
        )
    return order


def _skip(need_id: int, reason: str, order_number: str | None = None) -> MaterialNeedOrderSkipped:
    return MaterialNeedOrderSkipped(
        need_id=need_id, reason=reason, order_number=order_number
    )


def _classify(
    db: Session,
    need: ProjectMaterialNeed,
    *,
    wanted_supplier_id: int | None,
) -> tuple[MaterialCatalogItem | None, MaterialNeedOrderSkipped | None]:
    """The catalogue row this need orders from, or why it cannot be ordered."""

    if need.werkstatt_order_line_id is not None:
        existing = (
            db.get(WerkstattOrder, need.werkstatt_order_id)
            if need.werkstatt_order_id is not None
            else None
        )
        return None, _skip(
            need.id, "already_ordered", existing.order_number if existing else None
        )
    if need.status not in _ORDERABLE_STATUSES:
        return None, _skip(need.id, "completed")
    if need.material_catalog_item_id is None:
        return None, _skip(need.id, "no_catalog_item")

    catalog_item = db.get(MaterialCatalogItem, need.material_catalog_item_id)
    if catalog_item is None:
        # The FK is SET NULL, so this is the narrow window where the row was
        # deleted inside the same request. Treat it like an unlinked need.
        return None, _skip(need.id, "no_catalog_item")
    if catalog_item.supplier_id is None:
        # A legacy Datanorm row from before per-supplier imports: we know the
        # article but not who sells it, so there is no order to put it on.
        return None, _skip(need.id, "no_supplier")
    if wanted_supplier_id is not None and catalog_item.supplier_id != wanted_supplier_id:
        return None, _skip(need.id, "other_supplier")
    return catalog_item, None


def _order_title(
    explicit: str | None, projects: list[Project], *, project_ids: set[int]
) -> str | None:
    if explicit and explicit.strip():
        return explicit.strip()[:255]
    if len(project_ids) == 1 and projects:
        number = (projects[0].project_number or "").strip()
        return f"Bedarf {number}"[:255] if number else "Bedarf"
    if len(project_ids) > 1:
        return f"Bedarf aus {len(project_ids)} Projekten"[:255]
    return "Bedarf"


def _line_notes(
    need: ProjectMaterialNeed, project: Project | None, warning: str | None
) -> str:
    """What the buyer needs to read on the line itself.

    The warning goes FIRST and stays on the order: the person who confirms
    the modal is not always the person who later checks the basket.
    """

    parts: list[str] = []
    if warning:
        parts.append(warning)
    number = (project.project_number or "").strip() if project else ""
    parts.append(
        f"Projekt {number} · Bedarf #{need.id}" if number else f"Bedarf #{need.id}"
    )
    if (need.notes or "").strip():
        parts.append(need.notes.strip())
    return "\n".join(parts)


def create_orders_from_needs(
    db: Session,
    *,
    needs: list[ProjectMaterialNeed],
    projects_by_id: dict[int, Project],
    supplier_id: int | None,
    order_id: int | None,
    title: str | None,
    actor_user_id: int,
    now: datetime | None = None,
) -> NeedOrderOutcome:
    """Group the needs by supplier, draft one order each, link them back.

    ``needs`` must already be visibility-checked by the caller: this function
    does not know who is asking.
    """

    stamp = now or utcnow()
    outcome = NeedOrderOutcome()

    target_order = _load_draft_order(db, order_id) if order_id is not None else None
    wanted_supplier_id = target_order.supplier_id if target_order else supplier_id

    # Group first, so a draft is only created for a supplier that really has
    # a line to put on it.
    grouped: dict[int, list[tuple[ProjectMaterialNeed, MaterialCatalogItem]]] = {}
    for need in needs:
        catalog_item, skipped = _classify(db, need, wanted_supplier_id=wanted_supplier_id)
        if skipped is not None or catalog_item is None:
            outcome.skipped.append(
                skipped or _skip(need.id, "no_catalog_item")
            )
            continue
        grouped.setdefault(catalog_item.supplier_id, []).append((need, catalog_item))

    for group_supplier_id, entries in grouped.items():
        supplier = db.get(WerkstattSupplier, group_supplier_id)
        if supplier is None or supplier.is_archived:
            # The catalogue still points at a supplier we no longer buy from.
            for need, _ in entries:
                outcome.skipped.append(_skip(need.id, "no_supplier"))
            continue

        project_ids = {need.project_id for need, _ in entries}
        projects = [
            projects_by_id[pid] for pid in project_ids if pid in projects_by_id
        ]
        order = target_order or create_draft_order(
            db,
            supplier=supplier,
            # An order that serves several projects belongs to none of them;
            # each line names its own project instead.
            project_id=next(iter(project_ids)) if len(project_ids) == 1 else None,
            title=_order_title(title, projects, project_ids=project_ids),
            source="needs",
            created_by=actor_user_id,
            now=stamp,
        )

        per_project: dict[int, int] = {}
        for need, catalog_item in entries:
            quantity, warning = order_quantity_for_need(need.quantity)
            project = projects_by_id.get(need.project_id)
            line = build_order_line(
                db,
                order,
                OrderLineCreatePayload(
                    catalog_item_id=catalog_item.id,
                    # The catalogue row wins for name/number/EAN/manufacturer
                    # (the builder snapshots them); only the unit the fitter
                    # typed is worth keeping when the catalogue has none.
                    unit=catalog_item.unit or need.unit,
                    quantity_ordered=quantity,
                    notes=_line_notes(need, project, warning),
                ),
                now=stamp,
            )
            need.werkstatt_order_id = order.id
            need.werkstatt_order_line_id = line.id
            need.ordered_at = stamp
            need.status = "ordered"
            need.updated_by = actor_user_id
            need.updated_at = stamp
            db.add(need)
            outcome.added.append(
                MaterialNeedOrderAdded(
                    need_id=need.id,
                    order_id=order.id,
                    line_id=line.id,
                    quantity_warning=warning,
                )
            )
            per_project[need.project_id] = per_project.get(need.project_id, 0) + 1

        recompute_total(db, order)
        order.updated_at = stamp
        db.add(order)
        outcome.orders.append(order)
        # One feed entry per project and order. Per need would put eighty
        # lines in a project's history for one afternoon's purchasing.
        for project_id, count in per_project.items():
            outcome.activity.append(
                NeedOrderActivity(
                    project_id=project_id,
                    order_id=order.id,
                    order_number=order.order_number,
                    count=count,
                )
            )

    db.flush()
    return outcome
