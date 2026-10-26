"""Werkstatt label printer: overview, status and the calibration session.

Workshop staff (``werkstatt:manage``) run the quick flow "Material gewechselt"
once the owner has switched it on (``label_calibration_staff_enabled``);
``settings:manage`` additionally runs the full wizard with the measuring
pattern. Every error answers ``{"detail": {"code", "message", …}}`` so the web
client can branch on the code and show the German message verbatim.

Paper moves only on ``autosense`` and ``pattern``, and only with
``confirm_feed: true`` in the body — the server never assumes consent.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user, require_any_permission, require_permission
from app.models.entities import User
from app.schemas.label_printer import (
    ActivateIn,
    ApplyOut,
    AutosenseIn,
    AutosenseOut,
    CalibrationRecordOut,
    CalibrationSaveIn,
    FeedConfirmIn,
    PatternGeometryOut,
    PatternOut,
    PresenseOut,
    PrinterConfigOut,
    PrinterStatusOut,
    PrinterWarningOut,
    SensePollOut,
    SessionOut,
    SessionStartIn,
    VerdictOut,
)
from app.schemas.settings import LabelPrinterOverviewOut
from app.services import werkstatt_label_calibration as calibration
from app.services import werkstatt_label_session as sessions
from app.services.werkstatt_label_builtins import autosense_cost_hint, pattern_cost_hint
from app.services.werkstatt_label_errors import (
    LabelFormatUnsupported,
    LabelPrinterIoBusy,
    LabelPrinterNotConfigured,
    LabelPrinterSessionBusy,
    LabelPrinterUnreachable,
    LabelRequestRefused,
    PatternUnsupported,
)
from app.services.werkstatt_label_io_lock import BUSY_MESSAGE
from app.services.werkstatt_label_printer_status import PrinterConfig, PrinterStatus, read_status
from app.services.werkstatt_label_settings_view import (
    calibration_record_out,
    label_printer_overview_out,
    session_out,
)

router = APIRouter(
    prefix="/werkstatt/label-printer",
    tags=["werkstatt-label-printer"],
    dependencies=[Depends(require_any_permission("werkstatt:manage", "settings:manage"))],
)


def _refusal(status: int, code: str, message: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message, **extra})


@contextmanager
def _answers() -> Iterator[None]:
    """Translate the label services' exceptions into the API's error shape."""
    try:
        yield
    except LabelRequestRefused as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail()) from exc
    except LabelPrinterNotConfigured as exc:
        raise _refusal(503, "not_configured", "Kein Etikettendrucker konfiguriert") from exc
    except LabelPrinterUnreachable as exc:
        raise _refusal(502, "unreachable", f"Etikettendrucker nicht erreichbar ({exc})", printer=str(exc)) from exc
    except LabelPrinterSessionBusy as exc:
        # Our own session was replaced or expired between the steps.
        raise _refusal(409, "session_lost", sessions.SESSION_LOST_MESSAGE) from exc
    except LabelPrinterIoBusy as exc:
        raise _refusal(409, "printer_busy", BUSY_MESSAGE) from exc
    except PatternUnsupported as exc:
        raise _refusal(422, "pattern_unsupported", str(exc)) from exc
    except LabelFormatUnsupported as exc:
        raise _refusal(422, "layout_out_of_bounds", str(exc)) from exc


def _config_out(config: PrinterConfig | None) -> PrinterConfigOut | None:
    return None if config is None else PrinterConfigOut(**asdict(config))


def _warnings(status: PrinterStatus) -> list[PrinterWarningOut]:
    return [PrinterWarningOut(code=warning.code, message=warning.message) for warning in status.warnings]


# ── Overview and status (no session needed) ────────────────────────────────


@router.get("", response_model=LabelPrinterOverviewOut)
def label_printer_overview(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Materials, the live session and the switches — DB only, no printer I/O."""
    return label_printer_overview_out(db, current_user)


@router.get("/status", response_model=PrinterStatusOut)
def label_printer_status(
    full: bool = Query(default=False),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Read the printer. Queries only — never a setting, never a session check."""
    with _answers():
        status = read_status(db, full=full)
    return PrinterStatusOut(
        printer=status.printer,
        answered=status.answered,
        code=status.code,
        code_text=status.code_text,
        action_text=status.action_text,
        ready=status.ready,
        pending=status.pending,
        config=_config_out(status.config),
        raw_config=status.raw_config if sessions.has_settings(current_user) else None,
        warnings=_warnings(status),
        errors_seen=list(status.errors_seen),
    )


# ── Session ────────────────────────────────────────────────────────────────


@router.post("/session", response_model=SessionOut)
def start_calibration_session(
    payload: SessionStartIn,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    with _answers():
        session = calibration.start_session(
            db, current_user, mode=payload.mode, material_id=payload.material_id.strip(), takeover=payload.takeover
        )
    return session_out(db, session)


@router.post("/session/{session_id}/heartbeat", response_model=SessionOut)
def calibration_heartbeat(
    session_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    with _answers():
        session = calibration.heartbeat(db, current_user, session_id)
    return session_out(db, session)


@router.delete("/session/{session_id}", status_code=204)
def end_calibration_session(
    session_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Idempotent: a stale tab, an unknown id or a session someone took over
    are all answered 204 — and only the caller's own session is released."""
    calibration.end_session(db, current_user, session_id)


@router.post("/session/{session_id}/activate", response_model=SessionOut)
def activate_material(
    session_id: str,
    payload: ActivateIn,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    with _answers():
        session, revision = calibration.activate(db, current_user, session_id, payload.material_id.strip())
    return session_out(db, session, config_revision=revision)


@router.post("/session/{session_id}/apply", response_model=ApplyOut)
def apply_material_settings(
    session_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Sensor and label size to the printer — per the manual no paper moves."""
    with _answers():
        result = calibration.apply_material(db, current_user, session_id)
    return ApplyOut(
        printer=result.printer,
        commands=result.commands,
        confirmed=result.confirmed,
        mismatches=result.mismatches,
        config=_config_out(result.config),
        session=session_out(db, result.session),
    )


@router.post("/session/{session_id}/autosense", response_model=AutosenseOut)
def start_autosense(
    session_id: str,
    payload: AutosenseIn,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """The printer feeds media and measures label and gap."""
    with _answers():
        result = calibration.start_autosense(
            db, current_user, session_id, confirm_feed=payload.confirm_feed, method=payload.method
        )
    presense = None
    if result.presense is not None:
        qd = result.presense.get("qd") or [None, None]
        presense = PresenseOut(
            stored_q=result.presense.get("stored_q"),
            measured_length_dots=qd[0],
            measured_gap_dots=qd[1],
            apply_confirmed=result.presense.get("apply_confirmed"),
        )
    return AutosenseOut(
        printer=result.printer,
        method=result.method,
        cost_hint=autosense_cost_hint(result.profile),
        status_answered=result.status_answered,
        presense=presense,
        session=session_out(db, result.session),
    )


@router.post("/session/{session_id}/poll", response_model=SensePollOut)
def poll_sensing(
    session_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    with _answers():
        result = calibration.poll_sensing(db, current_user, session_id)
    return SensePollOut(
        phase=result.phase,
        answered=result.answered,
        code=result.code,
        code_text=result.code_text,
        message=result.message,
        saw_busy=result.saw_busy,
        elapsed_s=result.elapsed_s,
        session=session_out(db, result.session),
    )


from app.services.werkstatt_label_profile import PHYSICAL_DOTS_PER_MM  # noqa: E402


def _mm(dots: int | None) -> float | None:
    return None if dots is None else round(dots / PHYSICAL_DOTS_PER_MM, 2)


@router.post("/session/{session_id}/verify", response_model=VerdictOut)
def verify_measurement(
    session_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    with _answers():
        result = calibration.verify_material(db, current_user, session_id)
    verdict = result.verdict
    return VerdictOut(
        material_id=result.profile.id,
        verdict=verdict.verdict,
        title=verdict.title,
        detail=verdict.detail,
        notes=list(verdict.notes),
        fresh=verdict.fresh,
        freshness=verdict.freshness,
        from_latch=verdict.from_latch,
        expected_length_mm=verdict.expected_length_mm,
        expected_gap_mm=verdict.expected_gap_mm,
        expected_pitch_mm=verdict.expected_pitch_mm,
        measured_length_mm=_mm(verdict.measured_length_dots),
        measured_gap_mm=_mm(verdict.measured_gap_dots),
        measured_pitch_mm=_mm(verdict.measured_pitch_dots),
        measured_length_dots=verdict.measured_length_dots,
        measured_gap_dots=verdict.measured_gap_dots,
        delta_length_mm=verdict.delta_length_mm,
        delta_pitch_mm=verdict.delta_pitch_mm,
        tolerance_mm=verdict.tolerance_mm,
        dots_per_mm=round(PHYSICAL_DOTS_PER_MM, 2),
        sensor_kind=verdict.sensor_kind,
        sensor_expected=verdict.sensor_expected,
        sensor_ok=verdict.sensor_ok,
        suggested_material_ids=list(verdict.suggested_material_ids),
        status_code=result.status.code,
        status_text=result.status.code_text,
        offers=list(verdict.offers),
        warnings=_warnings(result.status),
        session=session_out(db, result.session),
    )


@router.post("/session/{session_id}/pattern", response_model=PatternOut)
def print_measuring_pattern(
    session_id: str,
    payload: FeedConfirmIn,
    current_user: User = Depends(require_permission("settings:manage")),
    db: Session = Depends(get_db),
):
    """One label (or a short strip) with the measuring box — full wizard only."""
    with _answers():
        result = calibration.print_pattern(db, current_user, session_id, confirm_feed=payload.confirm_feed)
    return PatternOut(
        printer=result.printer,
        cost_hint=pattern_cost_hint(result.profile, supported=True),
        geometry=PatternGeometryOut(**asdict(result.geometry)),
        x_offset_mm=result.profile.x_offset_mm,
        across_offset_mm=result.profile.across_offset_mm,
        session=session_out(db, result.session),
    )


@router.post("/session/{session_id}/save", response_model=CalibrationRecordOut)
def save_calibration(
    session_id: str,
    payload: CalibrationSaveIn,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Store the calibration record and end the session."""
    with _answers():
        record = calibration.save_calibration(
            db,
            current_user,
            session_id,
            notes=payload.notes,
            accept_verdict=payload.accept_verdict,
            pattern=payload.pattern.model_dump() if payload.pattern is not None else None,
        )
        profile = calibration.material_profile(db, record["material_id"])
    return calibration_record_out(record, profile)
