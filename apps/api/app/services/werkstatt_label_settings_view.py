"""Response builders for the label-printer settings and overview.

One place turns profiles, the calibration state and the session into API
shapes, so the admin settings (``/admin/settings/label-printer``) and the
workshop overview (``/werkstatt/label-printer``) can never describe the same
material differently.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.models.entities import User
from app.schemas.label_printer import (
    CalibrationRecordOut,
    CalibrationSummaryOut,
    JobSettingsOut,
    LastAppliedOut,
    MaterialHintOut,
    MediaWebIO,
    OffsetLimitsOut,
    SessionInfoOut,
    SessionOut,
)
from app.schemas.settings import LabelMaterialOut, LabelPrinterOverviewOut, LabelPrinterSettingsOut
from app.services import werkstatt_label_session as sessions
from app.services.werkstatt_label_builtins import BUILTIN_HINTS, autosense_cost_hint, pattern_cost_hint
from app.services.werkstatt_label_calibration import read_state
from app.services.werkstatt_label_jobs import offset_limits
from app.services.werkstatt_label_materials import get_label_printer_config
from app.services.werkstatt_label_patterns import pattern_supported
from app.services.werkstatt_label_profile import PHYSICAL_DOTS_PER_MM, MaterialProfile, web_to_dict


def _mm(dots: Any) -> float | None:
    return None if dots is None else round(int(dots) / PHYSICAL_DOTS_PER_MM, 2)  # real mm, see the profile


def calibration_summary(record: dict[str, Any] | None, profile: MaterialProfile) -> CalibrationSummaryOut | None:
    if not record:
        return None
    try:
        return CalibrationSummaryOut(
            kind=record["kind"],
            at=record["at"],
            by_name=record.get("by_name", ""),
            verdict=record["verdict"],
            fresh=bool(record.get("fresh")),
            accepted=bool(record.get("accepted")),
            stale=record.get("fingerprint") != profile.fingerprint,
            measured_length_mm=_mm(record.get("measured_length_dots")),
            measured_gap_mm=_mm(record.get("measured_gap_dots")),
            notes=record.get("notes", ""),
        )
    except (KeyError, ValueError, TypeError):
        return None  # a malformed record reads as "not calibrated", never a 500


def calibration_record_out(record: dict[str, Any], profile: MaterialProfile) -> CalibrationRecordOut:
    return CalibrationRecordOut(
        **{key: record.get(key) for key in CalibrationRecordOut.model_fields if key != "stale"},
        stale=record.get("fingerprint") != profile.fingerprint,
    )


def material_out(profile: MaterialProfile, *, overridden: frozenset[str], record: dict[str, Any] | None) -> LabelMaterialOut:
    supported = pattern_supported(profile)
    limits = offset_limits(profile)
    job = profile.job_settings
    return LabelMaterialOut(
        id=profile.id,
        name=profile.name,
        part_no=profile.part_no,
        width_mm=profile.width_mm,
        length_mm=profile.length_mm,
        gap_mm=profile.gap_mm,
        x_offset_mm=profile.x_offset_mm,
        darkness=profile.darkness,
        builtin=profile.builtin,
        tier=profile.tier,
        continuous=profile.continuous,
        media_type=profile.media_type,
        across_offset_mm=profile.across_offset_mm,
        speed_ips=profile.speed_ips,
        stop_mm=profile.stop_mm,
        resolved=JobSettingsOut(darkness=job.darkness, speed_ips=job.speed_ips, stop_mm=job.stop_mm),
        mark_width_mm=profile.mark_width_mm,
        mark_offset_mm=profile.mark_offset_mm,
        mark_inside=profile.mark_inside,
        sensor_mode=profile.sensor_mode,
        sensor_scale=profile.sensor_scale,
        guide=profile.guide,
        feed_path=profile.feed_path,
        roller=profile.roller,
        web=MediaWebIO(**web_to_dict(profile.web)),
        web_width_mm=profile.web_width_mm,
        overridden_fields=sorted(overridden),
        hints=[MaterialHintOut(topic=topic, text=text) for topic, text in BUILTIN_HINTS.get(profile.id, [])] if profile.builtin else [],
        calibration=calibration_summary(record, profile),
        autosense_cost_hint=autosense_cost_hint(profile),
        pattern_cost_hint=pattern_cost_hint(profile, supported=supported),
        pattern_supported=supported,
        offset_limits=OffsetLimitsOut(
            x_min=limits.x_min, x_max=limits.x_max, across_min=limits.across_min, across_max=limits.across_max
        ),
    )


def materials_out(config: dict[str, Any], state: dict[str, Any]) -> list[LabelMaterialOut]:
    return [
        material_out(profile, overridden=config["overrides"].get(profile.id, frozenset()), record=state["calibrations"].get(profile.id))
        for profile in config["materials"]
    ]


def session_info(session: sessions.CalibrationSession | None, user: User) -> SessionInfoOut | None:
    """The live session as anyone may see it; its id only for its holder."""
    if session is None:
        return None
    mine = session.user_id == user.id
    return SessionInfoOut(
        mode=session.mode,
        material_id=session.material_id,
        user_name=session.user_name,
        acquired_at=session.acquired_at,
        expires_at=session.expires_at,
        mine=mine,
        session_id=session.session_id if mine else None,
    )


def last_applied_out(state: dict[str, Any]) -> LastAppliedOut | None:
    raw = state.get("last_applied")
    if not raw:
        return None
    try:
        return LastAppliedOut(
            material_id=raw["material_id"], at=raw["at"], by_name=raw.get("by_name", ""),
            commands=list(raw.get("commands") or []), confirmed=raw.get("confirmed"),
        )
    except (KeyError, ValueError, TypeError):
        return None


def label_printer_settings_out(db: Session, user: User) -> LabelPrinterSettingsOut:
    from app.services import werkstatt_labels

    config = get_label_printer_config(db)
    state = read_state(db)
    address = werkstatt_labels.printer_address(db)
    host, port = address if address else ("", 9100)
    active = next(profile for profile in config["materials"] if profile.id == config["active_material_id"])
    baseline = config["baseline"]
    return LabelPrinterSettingsOut(
        host=host,
        port=port,
        configured=address is not None,
        source=werkstatt_labels.printer_address_source(db),
        materials=materials_out(config, state),
        active_material_id=active.id,
        active_material_name=active.name,
        active_tier=active.tier,
        revision=config["revision"],
        baseline=JobSettingsOut(darkness=baseline.darkness, speed_ips=baseline.speed_ips, stop_mm=baseline.stop_mm),
        baseline_overridden=sorted(config["baseline_overrides"]),
        row_offset_dots=config["row_offset_dots"],
        label_calibration_staff_enabled=config["label_calibration_staff_enabled"],
        session=session_info(sessions.active_session(db), user),
        last_applied=last_applied_out(state),
    )


def label_printer_overview_out(db: Session, user: User) -> LabelPrinterOverviewOut:
    from app.services import werkstatt_labels

    config = get_label_printer_config(db)
    state = read_state(db)
    address = werkstatt_labels.printer_address(db)
    active = next(profile for profile in config["materials"] if profile.id == config["active_material_id"])
    return LabelPrinterOverviewOut(
        configured=address is not None,
        printer=f"{address[0]}:{address[1]}" if address else "",
        active_material_id=active.id,
        active_material_name=active.name,
        materials=materials_out(config, state),
        session=session_info(sessions.active_session(db), user),
        last_applied=last_applied_out(state),
        can_full=sessions.has_settings(user),
        staff_enabled=config["label_calibration_staff_enabled"],
    )


def session_out(db: Session, session: sessions.CalibrationSession, *, config_revision: int | None = None) -> SessionOut:
    if config_revision is None:
        config_revision = get_label_printer_config(db)["revision"]
    return SessionOut(
        session_id=session.session_id,
        mode=session.mode,
        material_id=session.material_id,
        phase=session.phase,
        user_name=session.user_name,
        acquired_at=session.acquired_at,
        expires_at=session.expires_at,
        applied=session.applied,
        sensed=session.sensed,
        verdict=(session.verify or {}).get("verdict"),
        config_revision=config_revision,
    )
