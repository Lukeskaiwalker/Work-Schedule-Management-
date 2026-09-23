"""Verteilerpläne — endpoints for the panel schematic editor.

Gating
------
Reading is open to any authenticated user, with one exception: a panel that
is linked to a project inherits that project's access rules. The reasoning is
that a Verteilerplan is site *documentation*, not commercial data — the whole
point is that whoever stands in front of the board can pull it up, including
the apprentice sent to swap an LS. Customers are already listed to every
authenticated user (``workflow_customers.list_customers``), so scoping panels
tighter than customers would be theatre.

Writing needs ``reports:create``. That is the existing "may document field
work" grant — every employee role carries it by default, and it is what the
Baustellenbericht already uses. A brand-new ``schaltplan:*`` permission was
the other candidate and was rejected deliberately: stored role overrides
*replace* a role's permission set (see ``core/permissions.py``), so a fresh
permission string reaches nobody on an installation that has ever customised
its roles — the feature would ship invisible.

Deleting needs ``projects:manage`` OR being the person who created the plan.
As-built documentation that someone else relies on should not be removable by
any passing colleague.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import assert_project_access, get_current_user, require_permission
from app.core.permissions import has_permission_for_user
from app.models.customer import Customer
from app.models.entities import Project, User
from app.models.schaltplan import PanelPlan
from app.routers.workflow_helpers import _content_disposition
from app.schemas.schaltplan import (
    PanelTypeLabelInfoOut,
    PanelTypeLabelOut,
    PanelTypeLabelPrintRequest,
    PanelLabelsPrintOut,
    PanelStripOut,
    PanelLabelsPrintRequest,
    PanelTerminalBomRow,
    DeviceCatalogEntry,
    PanelDocument,
    PanelPlanCreate,
    PanelPlanOut,
    PanelPlanSummary,
    PanelPlanUpdate,
)
from app.services.audit import log_admin_action
from app.services.runtime_settings import get_company_settings
from app.services.schaltplan_layout import (
    DEVICE_CATALOG,
    board_font_size,
    build_legend,
    document_stats,
    empty_document,
    strip_segments,
    unlabelled_device_count,
    validate_document,
)
from app.services.schaltplan_terminals import (
    STRIP_KIND_BLOCK,
    derive_terminals,
    terminal_bom,
    terminal_font_size,
    terminal_strips,
)
from app.services import schaltplan_type_label as type_label
from app.services import werkstatt_labels
from app.services.werkstatt_label_materials import MaterialProfile, MaterialValidationError
from app.services.schaltplan_pdf import build_panel_plan_pdf

router = APIRouter(prefix="/schaltplan", tags=["schaltplan"])


# ──────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────


def _display_name(user: User | None) -> str | None:
    if user is None:
        return None
    return (user.display_name or user.full_name or user.email or "").strip() or None


def _load_names(db: Session, plans: list[PanelPlan]) -> dict[str, dict]:
    """Batch-resolve the labels the list view needs.

    One query per related table instead of per row: the panel picker on a
    tablet asks for every panel of a customer at once, and an N+1 over
    customers/projects/users made that list visibly slow on site wifi.
    """

    customer_ids = {p.customer_id for p in plans}
    project_ids = {p.project_id for p in plans if p.project_id is not None}
    user_ids = {uid for p in plans for uid in (p.created_by, p.updated_by) if uid is not None}
    panel_ids = {p.fed_from_panel_id for p in plans if p.fed_from_panel_id is not None}

    customers = (
        {c.id: c.name for c in db.scalars(select(Customer).where(Customer.id.in_(customer_ids)))}
        if customer_ids
        else {}
    )
    projects = (
        {p.id: p for p in db.scalars(select(Project).where(Project.id.in_(project_ids)))}
        if project_ids
        else {}
    )
    users = (
        {u.id: _display_name(u) for u in db.scalars(select(User).where(User.id.in_(user_ids)))}
        if user_ids
        else {}
    )
    feeders = (
        {
            p.id: p.designation
            for p in db.scalars(select(PanelPlan).where(PanelPlan.id.in_(panel_ids)))
        }
        if panel_ids
        else {}
    )
    return {"customers": customers, "projects": projects, "users": users, "feeders": feeders}


def _summary(plan: PanelPlan, names: dict[str, dict]) -> PanelPlanSummary:
    project = names["projects"].get(plan.project_id) if plan.project_id else None
    stats = document_stats(plan.document or {})
    return PanelPlanSummary(
        id=plan.id,
        customer_id=plan.customer_id,
        customer_name=names["customers"].get(plan.customer_id),
        project_id=plan.project_id,
        project_number=getattr(project, "project_number", None),
        project_name=getattr(project, "name", None),
        name=plan.name,
        designation=plan.designation,
        panel_type=plan.panel_type,  # type: ignore[arg-type]
        location=plan.location,
        fed_from_panel_id=plan.fed_from_panel_id,
        fed_from_designation=names["feeders"].get(plan.fed_from_panel_id),
        status=plan.status,  # type: ignore[arg-type]
        revision=plan.revision,
        updated_at=plan.updated_at,
        updated_by_name=names["users"].get(plan.updated_by),
        **stats,
    )


def _detail(db: Session, plan: PanelPlan) -> PanelPlanOut:
    names = _load_names(db, [plan])
    summary = _summary(plan, names)
    document = plan.document or empty_document()
    return PanelPlanOut(
        **summary.model_dump(),
        document=PanelDocument.model_validate(document),
        notes=plan.notes,
        legend=build_legend(document),  # type: ignore[arg-type]
        findings=validate_document(document),  # type: ignore[arg-type]
        terminal_bom=[PanelTerminalBomRow(**row) for row in terminal_bom(derive_terminals(document))],
        created_at=plan.created_at,
        created_by_name=names["users"].get(plan.created_by),
    )


def _get_plan_or_404(db: Session, plan_id: int) -> PanelPlan:
    plan = db.get(PanelPlan, plan_id)
    if plan is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Verteilerplan nicht gefunden.")
    return plan


def _assert_readable(db: Session, user: User, plan: PanelPlan) -> None:
    """A project-linked plan is only as visible as its project."""

    if plan.project_id is not None:
        assert_project_access(db, user, plan.project_id)


def _assert_customer_exists(db: Session, customer_id: int) -> Customer:
    customer = db.get(Customer, customer_id)
    if customer is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Kunde nicht gefunden.")
    return customer


def _assert_project_belongs(db: Session, user: User, project_id: int | None, customer_id: int) -> None:
    """A plan's project must belong to the plan's customer.

    Without this a panel could be filed under customer A while pointing at
    customer B's project, and it would then show up in B's project files —
    a cross-customer leak built out of two individually-legal ids.
    """

    if project_id is None:
        return
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Projekt nicht gefunden.")
    if project.customer_id is not None and project.customer_id != customer_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Das Projekt gehört nicht zu diesem Kunden.",
        )
    assert_project_access(db, user, project_id)


def _assert_feeder(db: Session, plan_id: int | None, feeder_id: int | None, customer_id: int) -> None:
    """The feeding panel must exist, be the same customer's, and not be self.

    Only a direct self-reference is blocked, not a longer cycle: a two-hop
    loop is a data-entry mistake that the diagram renders harmlessly (the
    "Einspeisung von" line is one level deep and never walks the chain), and
    a full cycle check on every save would cost a recursive query for a case
    that has no failure mode.
    """

    if feeder_id is None:
        return
    if plan_id is not None and feeder_id == plan_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Ein Verteiler kann sich nicht selbst einspeisen.",
        )
    feeder = db.get(PanelPlan, feeder_id)
    if feeder is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Einspeisender Verteiler nicht gefunden.")
    if feeder.customer_id != customer_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Der einspeisende Verteiler gehört zu einem anderen Kunden.",
        )


def _duplicate_designation(exc: IntegrityError) -> bool:
    """Is this IntegrityError the (customer_id, designation) clash?

    Two spellings, because the two dialects report the violation differently:
    PostgreSQL names the constraint, SQLite names the columns
    ("UNIQUE constraint failed: panel_plans.customer_id, panel_plans.designation").
    Matching only the constraint name passed the Postgres path and turned the
    SQLite path — which is what the test suite and every dev database run on —
    into an unhandled 500.
    """

    message = str(getattr(exc, "orig", exc))
    if "uq_panel_plan_customer_designation" in message:
        return True
    return "panel_plans.customer_id" in message and "panel_plans.designation" in message


# ──────────────────────────────────────────────────────────────────────────
# Catalogue
# ──────────────────────────────────────────────────────────────────────────


@router.get("/devices", response_model=list[DeviceCatalogEntry])
def list_device_catalog(_: User = Depends(get_current_user)) -> list[DeviceCatalogEntry]:
    """The device palette, served from the backend catalogue.

    The editor ships its own copy for instant first paint, but reconciles
    against this so a catalogue addition reaches tablets without an app
    rebuild.
    """

    return [
        DeviceCatalogEntry(
            kind=kind,
            label=entry["label"],
            short=entry["short"],
            te=entry["te"],
            poles=entry["poles"],
            group=entry["group"],
            circuit=entry["circuit"],
            symbol=entry["symbol"],
            rating_hint=entry["rating_hint"],
        )
        for kind, entry in DEVICE_CATALOG.items()
    ]


# ──────────────────────────────────────────────────────────────────────────
# CRUD
# ──────────────────────────────────────────────────────────────────────────


@router.get("/panels", response_model=list[PanelPlanSummary])
def list_panels(
    customer_id: int | None = Query(default=None),
    project_id: int | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[PanelPlanSummary]:
    stmt = select(PanelPlan)
    if customer_id is not None:
        stmt = stmt.where(PanelPlan.customer_id == customer_id)
    if project_id is not None:
        stmt = stmt.where(PanelPlan.project_id == project_id)
    # Main panels first, then sub-panels, then by designation — the order an
    # electrician expects to read a building's boards in.
    plans = list(db.scalars(stmt.order_by(PanelPlan.customer_id, PanelPlan.designation)))

    # Drop project-linked plans the caller may not see. Filtered in Python
    # rather than joined into the query because the access rule is not
    # expressible in SQL (it spans membership, task assignment and the
    # blanket default grant).
    visible: list[PanelPlan] = []
    for plan in plans:
        if plan.project_id is None:
            visible.append(plan)
            continue
        try:
            assert_project_access(db, current_user, plan.project_id)
        except HTTPException:
            continue
        visible.append(plan)

    order = {"main": 0, "meter": 1, "sub": 2}
    visible.sort(key=lambda p: (order.get(p.panel_type, 3), p.designation.lower()))
    names = _load_names(db, visible)
    return [_summary(plan, names) for plan in visible]


@router.post("/panels", response_model=PanelPlanOut)
def create_panel(
    payload: PanelPlanCreate,
    current_user: User = Depends(require_permission("reports:create")),
    db: Session = Depends(get_db),
) -> PanelPlanOut:
    _assert_customer_exists(db, payload.customer_id)
    _assert_project_belongs(db, current_user, payload.project_id, payload.customer_id)
    _assert_feeder(db, None, payload.fed_from_panel_id, payload.customer_id)

    document = payload.document.model_dump() if payload.document else empty_document()
    plan = PanelPlan(
        customer_id=payload.customer_id,
        project_id=payload.project_id,
        name=payload.name.strip(),
        designation=payload.designation.strip(),
        panel_type=payload.panel_type,
        location=(payload.location or "").strip() or None,
        fed_from_panel_id=payload.fed_from_panel_id,
        status="draft",
        revision=1,
        document=document,
        notes=payload.notes,
        created_by=current_user.id,
        updated_by=current_user.id,
    )
    db.add(plan)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        if _duplicate_designation(exc):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Es gibt bereits einen Verteiler „{payload.designation}“ bei diesem Kunden.",
            ) from None
        raise
    db.refresh(plan)
    log_admin_action(
        db, current_user, "panel_plan.create", "panel_plan", str(plan.id),
        {"designation": plan.designation, "customer_id": plan.customer_id},
    )
    return _detail(db, plan)


@router.get("/panels/{plan_id}", response_model=PanelPlanOut)
def get_panel(
    plan_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PanelPlanOut:
    plan = _get_plan_or_404(db, plan_id)
    _assert_readable(db, current_user, plan)
    return _detail(db, plan)


@dataclass
class _PrintPlan:
    """What one label request sends to the printer, before it is shipped.

    ``strips`` is the ``(text, width_mm)`` form ``print_marking_strips``
    takes; ``meta`` is what the response reports per strip. Built by one of
    the two ``_..._print_plan`` functions so the endpoint itself only picks a
    target, ships and answers.
    """

    strips: list[list[tuple[str, float]]] = field(default_factory=list)
    # Terminal Block labels (name, X, cells) — printed after the strips.
    blocks: list[dict[str, Any]] = field(default_factory=list)
    meta: list[PanelStripOut] = field(default_factory=list)
    skipped: int = 0
    font_size: int | None = None
    overflowing: list[str] = field(default_factory=list)
    empty_detail: str = ""


def _bmk_print_plan(document: dict[str, Any], payload: PanelLabelsPrintRequest, profile: MaterialProfile) -> _PrintPlan:
    """The BMK strips of the selected rails (see ``print_panel_labels``)."""
    plan = _PrintPlan(empty_detail="Keine BMK vergeben — erst Betriebsmittelkennzeichen eintragen.")
    # The board size is a strip concept: die-cut labels (210-805) are fitted
    # one by one on their own 15 mm, so there is nothing board-wide to report.
    if profile.continuous:
        plan.font_size, plan.overflowing = board_font_size(document, profile.width_mm)

    wanted = set(payload.row_ids or [])
    if payload.row_id:
        wanted.add(payload.row_id)

    for row in document.get("rows") or []:
        if not isinstance(row, dict):
            continue
        row_id = str(row.get("id") or "")
        if wanted and row_id not in wanted:
            continue
        plan.skipped += unlabelled_device_count(row)
        segments = strip_segments(row)
        if not segments:
            continue
        plan.strips.append([(seg.text, seg.width_mm) for seg in segments])
        plan.meta.append(
            PanelStripOut(
                row_id=row_id,
                row_label=str(row.get("label") or ""),
                length_mm=round(sum(seg.width_mm for seg in segments), 2),
            )
        )
    return plan


def _terminal_print_plan(
    document: dict[str, Any], payload: PanelLabelsPrintRequest, profile: MaterialProfile
) -> _PrintPlan:
    """The Reihenklemmen markers of the selected FI groups, one strip per group.

    Continuous stock only: the markers are 5.2 mm and 12 mm wide and slide
    into the WAGO marker slot as one strip per group, so a die-cut label
    cannot carry them. The font size is fitted over every group of the board
    in the chosen text mode, exactly like the BMK size is fitted over every
    rail — a group reprinted next week must match the ones printed today.
    """
    if not profile.continuous:
        raise HTTPException(status_code=400, detail="Reihenklemmen werden nur auf Endlosstreifen gedruckt.")
    # An explicit empty selection is "nothing", never "everything": the sheet
    # sends exactly the ticked groups, and unticking them all must not print
    # the whole board.
    if payload.strip_ids is not None and not payload.strip_ids:
        raise HTTPException(status_code=400, detail="Keine Klemmenleiste ausgewählt — mindestens eine wählen.")
    groups = derive_terminals(document)
    if not groups:
        raise HTTPException(
            status_code=400,
            detail="Keine Reihenklemmen abgeleitet — erst Abgänge mit „Reihenklemme am Abgang“ markieren.",
        )
    plan = _PrintPlan(
        empty_detail="Keine Beschriftung für die gewählten Klemmen — die Texte in der Vorschau prüfen.",
    )
    plan.font_size, plan.overflowing = terminal_font_size(groups, profile.width_mm)
    selection = terminal_strips(groups, payload.strip_ids)
    # Over the whole selection, not the strips: a Leiste with no text at all
    # produces no strip, but its terminals are still the ones left unmarked.
    plan.skipped = int(selection["skipped"])
    for strip in selection["strips"]:
        if strip["kind"] == STRIP_KIND_BLOCK:
            plan.blocks.append({"name": strip["name"], "x_label": strip["x_label"], "cells": list(strip["cells"])})
        else:
            plan.strips.append(list(strip["segments"]))
        plan.meta.append(
            PanelStripOut(
                row_id=str(strip["strip_id"]),
                row_label=str(strip["label"]),
                length_mm=round(float(strip["length_mm"]), 2),
                part_count=int(strip["part_count"]),
            )
        )
    return plan


@router.post("/panels/{plan_id}/labels", response_model=PanelLabelsPrintOut)
def print_panel_labels(
    plan_id: int,
    payload: PanelLabelsPrintRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PanelLabelsPrintOut:
    """Print the Betriebsmittelkennzeichen of selected rails — or the Reihenklemmen markers.

    Anyone who may read the plan may print its labels: the person at the
    printer is the one building the board, not the one who drew it. On the
    2009-110 every rail becomes one continuous strip laid out at the devices'
    real widths with a cut mark on every boundary and a heavier one at both
    ends; on the 210-805 every BMK becomes one 6 × 15 mm label. Rails go out
    in board order.

    Only labelled devices get a segment. A Blindabdeckung never does, and a
    Betriebsmittel without a BMK gets none either — the strip continues with
    the next labelled device. The unnamed ones ARE counted, because the
    missing designation is the thing to fix, not to hide.

    The font size is one number for the WHOLE board, not per rail and not per
    selection: it is fitted over every labelled device of every row, so a rail
    printed next week matches the ones printed today. BMK that cannot fit
    their segment even at the minimum size are listed in ``overflowing``.

    With ``target="reihenklemmen"`` the same path prints the WAGO terminal
    markers: one piece per strip at the terminals' real pitch (see
    ``services/schaltplan_terminals.py``) — a Leiste reading X1, 1.1, 1.2 …
    or a Block label (name, X, N L1 L2 L3 PE) — ``strips[].row_id`` then
    being the strip id and ``skipped_without_bmk`` the Leiste terminals of
    the selected strips whose text was blanked — a Leiste with no text at
    all gets no strip, but its terminals are counted. ``strip_ids`` null =
    every strip; an explicit empty list is refused, not read as "all".
    """
    plan = _get_plan_or_404(db, plan_id)
    _assert_readable(db, current_user, plan)
    document = plan.document or empty_document()
    material_id = (payload.material_id or werkstatt_labels.MARKING_STRIP_MATERIAL_ID).strip()
    try:
        profile = werkstatt_labels.material_by_id(db, material_id)
    except MaterialValidationError as exc:
        raise HTTPException(status_code=400, detail=f"Unbekanntes Etikettenmaterial: {exc}")

    if payload.target == "reihenklemmen":
        print_plan = _terminal_print_plan(document, payload, profile)
    else:
        print_plan = _bmk_print_plan(document, payload, profile)

    if not print_plan.strips and not print_plan.blocks:
        raise HTTPException(status_code=400, detail=print_plan.empty_detail)
    try:
        printed, printer = werkstatt_labels.print_marking_strips(
            db, strips=print_plan.strips, material_id=material_id, size=print_plan.font_size, blocks=print_plan.blocks
        )
    except werkstatt_labels.LabelPrinterNotConfigured:
        raise HTTPException(status_code=503, detail="Kein Etikettendrucker konfiguriert")
    except werkstatt_labels.LabelPrinterUnreachable as exc:
        raise HTTPException(status_code=502, detail=f"Etikettendrucker nicht erreichbar ({exc})")

    return PanelLabelsPrintOut(
        printed=printed,
        skipped_without_bmk=print_plan.skipped,
        printer=printer,
        material=material_id,
        strips=print_plan.meta if profile.continuous else [],
        font_size_dots=print_plan.font_size,
        overflowing=print_plan.overflowing,
    )


@router.patch("/panels/{plan_id}", response_model=PanelPlanOut)
def update_panel(
    plan_id: int,
    payload: PanelPlanUpdate,
    current_user: User = Depends(require_permission("reports:create")),
    db: Session = Depends(get_db),
) -> PanelPlanOut:
    plan = _get_plan_or_404(db, plan_id)
    _assert_readable(db, current_user, plan)
    fields = payload.model_fields_set

    if "project_id" in fields:
        _assert_project_belongs(db, current_user, payload.project_id, plan.customer_id)
        plan.project_id = payload.project_id
    if "fed_from_panel_id" in fields:
        _assert_feeder(db, plan.id, payload.fed_from_panel_id, plan.customer_id)
        plan.fed_from_panel_id = payload.fed_from_panel_id
    if payload.name is not None:
        plan.name = payload.name.strip()
    if payload.designation is not None:
        plan.designation = payload.designation.strip()
    if payload.panel_type is not None:
        plan.panel_type = payload.panel_type
    if "location" in fields:
        plan.location = (payload.location or "").strip() or None
    if payload.status is not None:
        plan.status = payload.status
    if "notes" in fields:
        plan.notes = payload.notes
    if payload.document is not None:
        plan.document = payload.document.model_dump()
        # A document change is a new revision unless the client already
        # supplied a higher number. Monotonic on purpose: the title block
        # prints "Rev. n" and a revision going backwards would make two
        # different printed drawings claim the same revision.
        plan.revision = max(plan.revision + 1, payload.revision or 0)
    elif payload.revision is not None:
        plan.revision = max(plan.revision, payload.revision)

    plan.updated_by = current_user.id
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        if _duplicate_designation(exc):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Diese Bezeichnung ist bei dem Kunden schon vergeben.",
            ) from None
        raise
    db.refresh(plan)
    return _detail(db, plan)


@router.delete("/panels/{plan_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_panel(
    plan_id: int,
    current_user: User = Depends(require_permission("reports:create")),
    db: Session = Depends(get_db),
) -> Response:
    plan = _get_plan_or_404(db, plan_id)
    _assert_readable(db, current_user, plan)
    is_owner = plan.created_by == current_user.id
    if not is_owner and not has_permission_for_user(current_user.id, current_user.role, "projects:manage"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Nur der Ersteller oder die Projektleitung darf einen Verteilerplan löschen.",
        )
    log_admin_action(
        db, current_user, "panel_plan.delete", "panel_plan", str(plan.id),
        {"designation": plan.designation, "customer_id": plan.customer_id},
    )
    db.delete(plan)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/panels/{plan_id}/duplicate", response_model=PanelPlanOut)
def duplicate_panel(
    plan_id: int,
    current_user: User = Depends(require_permission("reports:create")),
    db: Session = Depends(get_db),
) -> PanelPlanOut:
    """Copy a board, designation suffixed until it is free.

    Buildings are full of near-identical Unterverteiler (one per floor);
    re-typing 30 circuits per floor on a tablet is how documentation stops
    getting written.
    """

    source = _get_plan_or_404(db, plan_id)
    _assert_readable(db, current_user, source)

    taken = {
        designation
        for designation in db.scalars(
            select(PanelPlan.designation).where(PanelPlan.customer_id == source.customer_id)
        )
    }
    base = source.designation[:26]
    designation = f"{base}-K"
    counter = 2
    while designation in taken:
        designation = f"{base}-K{counter}"
        counter += 1

    copy = PanelPlan(
        customer_id=source.customer_id,
        project_id=source.project_id,
        name=f"{source.name} (Kopie)"[:160],
        designation=designation,
        panel_type=source.panel_type,
        location=source.location,
        fed_from_panel_id=source.fed_from_panel_id,
        status="draft",
        revision=1,
        document=source.document,
        notes=source.notes,
        created_by=current_user.id,
        updated_by=current_user.id,
    )
    db.add(copy)
    db.commit()
    db.refresh(copy)
    return _detail(db, copy)


# ──────────────────────────────────────────────────────────────────────────
# PDF
# ──────────────────────────────────────────────────────────────────────────


@router.get("/panels/{plan_id}/pdf")
def panel_pdf(
    plan_id: int,
    legend_only: bool = Query(default=False),
    terminals_only: bool = Query(default=False),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    """Übersichtsschaltplan + Legende (+ Reihenklemmen) as one PDF in the company drawing style.

    ``legend_only`` prints just the Stromkreisliste — that is the sheet that
    gets glued inside the panel door, and workers asked for it without the
    drawing page so it fits on one side. ``terminals_only`` prints just the
    Reihenklemmen sheet (terminal list per FI group plus the Stückliste),
    which the Klemmen tab offers; the full document carries that sheet after
    the legend whenever the board has at least one terminal.
    """

    plan = _get_plan_or_404(db, plan_id)
    _assert_readable(db, current_user, plan)

    customer = db.get(Customer, plan.customer_id)
    project = db.get(Project, plan.project_id) if plan.project_id else None
    feeder = db.get(PanelPlan, plan.fed_from_panel_id) if plan.fed_from_panel_id else None
    settings = get_company_settings(db)

    pdf = build_panel_plan_pdf(
        plan=plan,
        customer_name=getattr(customer, "name", None),
        project_label=(
            f"{project.project_number} · {project.name}" if project is not None else None
        ),
        fed_from=getattr(feeder, "designation", None),
        author=_display_name(current_user),
        company_name=settings.get("company_name"),
        legend_only=legend_only,
        terminals_only=terminals_only,
    )
    suffix = "Reihenklemmen" if terminals_only else ("Legende" if legend_only else "Schaltplan")
    file_name = f"{suffix}_{plan.designation}_{datetime.now():%Y-%m-%d}.pdf".replace(" ", "_")
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": _content_disposition(file_name, inline=True)},
    )


# ── Schrank-Etikett ───────────────────────────────────────────────────────────


def _type_label_content(db: Session, plan: PanelPlan, build_month: str) -> tuple[type_label.TypeLabelContent, Project | None]:
    """The customer from the panel's customer row (the project's snapshot
    as the fallback), the number from its project."""
    customer = db.get(Customer, plan.customer_id)
    project = db.get(Project, plan.project_id) if plan.project_id else None
    name = (getattr(customer, "name", None) or getattr(project, "customer_name", None) or "").strip()
    content = type_label.TypeLabelContent(
        customer=name or "—",
        project_number=(project.project_number or "").strip() or None if project is not None else None,
        build_month=build_month,
    )
    return content, project


@router.get("/panels/{plan_id}/type-label", response_model=PanelTypeLabelInfoOut)
def panel_type_label_info(
    plan_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PanelTypeLabelInfoOut:
    """What the Schrank-Etikett would print right now, for the dialog."""
    plan = _get_plan_or_404(db, plan_id)
    _assert_readable(db, current_user, plan)
    content, project = _type_label_content(db, plan, type_label.current_build_month())
    profile = werkstatt_labels.active_material(db)
    return PanelTypeLabelInfoOut(
        customer=content.customer,
        project_number=content.project_number,
        project_name=(project.name if project is not None else None),
        build_month=content.build_month,
        url=type_label.TYPE_LABEL_URL,
        contact_lines=list(type_label.TYPE_LABEL_CONTACT_LINES),
        material=profile.name,
        material_ok=type_label.material_supports_type_label(profile),
    )


@router.post("/panels/{plan_id}/type-label", response_model=PanelTypeLabelOut)
def print_panel_type_label(
    plan_id: int,
    payload: PanelTypeLabelPrintRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PanelTypeLabelOut:
    """Print the panel's type label — the owner's blueprint filled with the
    customer, the project number and the build month — on the 99 × 44 stock.
    Anyone who may read the plan may print it, as with the marking strips."""
    plan = _get_plan_or_404(db, plan_id)
    _assert_readable(db, current_user, plan)
    try:
        build_month = type_label.normalize_build_month(payload.build_month)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    content, _ = _type_label_content(db, plan, build_month)
    try:
        printer, profile = type_label.print_type_label(db, content, copies=payload.copies)
    except werkstatt_labels.LabelFormatUnsupported as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except werkstatt_labels.LabelPrinterNotConfigured:
        raise HTTPException(status_code=503, detail="Kein Etikettendrucker konfiguriert")
    except werkstatt_labels.LabelPrinterUnreachable as exc:
        raise HTTPException(status_code=502, detail=f"Etikettendrucker nicht erreichbar ({exc})")
    return PanelTypeLabelOut(
        printer=printer,
        material=profile.name,
        sheets=payload.copies,
        customer=content.customer,
        project_number=content.project_number,
        build_month=build_month,
    )


@router.get("/type-label/logo.png")
def type_label_logo(_: User = Depends(get_current_user)) -> Response:
    """The logo as it prints, for the dialog's preview."""
    png = type_label.logo_png()
    if png is None:
        raise HTTPException(status_code=404, detail="Kein Logo hinterlegt")
    return Response(content=png, media_type="image/png", headers={"Cache-Control": "private, max-age=3600"})


@router.get("/type-label/qr.svg")
def type_label_qr(_: User = Depends(get_current_user)) -> Response:
    """The QR code as it prints, for the dialog's preview."""
    return Response(
        content=type_label.qr_svg(type_label.TYPE_LABEL_URL),
        media_type="image/svg+xml",
        headers={"Cache-Control": "private, max-age=3600"},
    )
