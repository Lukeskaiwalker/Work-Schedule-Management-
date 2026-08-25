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

from datetime import datetime

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
    build_legend,
    document_stats,
    empty_document,
    validate_document,
)
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
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    """Übersichtsschaltplan + Legende as one PDF in the company drawing style.

    ``legend_only`` prints just the Stromkreisliste — that is the sheet that
    gets glued inside the panel door, and workers asked for it without the
    drawing page so it fits on one side.
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
    )
    suffix = "Legende" if legend_only else "Schaltplan"
    file_name = f"{suffix}_{plan.designation}_{datetime.now():%Y-%m-%d}.pdf".replace(" ", "_")
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": _content_disposition(file_name, inline=True)},
    )
