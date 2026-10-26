"""The Schrank-Etikett of a Verteiler: what it would print, printing it, and
the logo and QR code its dialog previews.

Moved out of ``workflow_schaltplan`` unchanged (docs/PANEL_ENCLOSURE.md §7),
so that file stays a plan router under 800 lines. Same prefix and the same
rule: anyone who may read the plan may print its label — the person at the
printer is the one building the board.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user
from app.models.customer import Customer
from app.models.entities import Project, User
from app.models.schaltplan import PanelPlan
from app.routers.workflow_schaltplan import _assert_readable, _get_plan_or_404
from app.schemas.schaltplan import PanelTypeLabelInfoOut, PanelTypeLabelOut, PanelTypeLabelPrintRequest
from app.services import schaltplan_type_label as type_label
from app.services import werkstatt_labels

router = APIRouter(prefix="/schaltplan", tags=["schaltplan"])


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
        panel_number=plan.panel_number,
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
        panel_number=plan.panel_number,
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
    except werkstatt_labels.LabelPrinterBusy as exc:
        # A calibration session holds the printer, or another job is on the wire.
        raise HTTPException(status_code=409, detail=str(exc))
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
