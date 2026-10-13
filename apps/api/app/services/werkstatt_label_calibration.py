"""Calibrating the label printer per material — the session's steps.

Quick flow (``werkstatt:manage``): activate the loaded material → apply its
sensor and size settings (no paper per the manual) → auto-sense (feeds
paper) → verify → save a record. The full wizard (``settings:manage``) adds
the measuring pattern. Every step follows the three-phase rule so no row lock
is ever held across printer I/O: (1) ``require`` + checks + mark + commit,
(2) printer I/O, (3) ``require`` again + write results + commit — if the
session vanished in between, the caller gets ``session_lost`` and the printer
action is audited all the same. Whatever reached the printer is on record
however the step ends: an apply writes ``last_applied`` and its audit row
the moment its lines went out, auto-sense and pattern audit in step 3 even
when it fails.

Nothing here invents printer behaviour. What the manual says, what the probe
showed and what is still open (``T…`` in docs/LABEL_PRINTER_CALIBRATION.md
§9) is handled defensively: a silent STATUS routes to the calibration button,
a mismatching readback is a warning, and a measurement counts only with proof
that it is fresh (``werkstatt_label_verdict``).
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, replace
from typing import Any, Callable

from sqlalchemy.orm import Session

from app.models.entities import User
from app.services import werkstatt_label_session as sessions
from app.services.audit import log_admin_action
from app.services.runtime_settings import (
    WERKSTATT_LABEL_PRINTER_STATE_KEY,
    get_runtime_setting,
    get_runtime_setting_for_update,
    set_runtime_setting,
)
from app.services.werkstatt_label_errors import LabelPrinterIoBusy, LabelPrinterUnreachable, LabelRequestRefused
from app.services.werkstatt_label_printer_status import (
    BUSY_CODES,
    STATUS_TEXT_DE,
    PrinterConfig,
    PrinterStatus,
    expected_sensor,
    parse_config,
    read_status,
    sensor_word,
)
from app.services.werkstatt_label_profile import MaterialProfile, format_mm_de, mm_int, q_value
from app.services.werkstatt_label_transport import PrinterQuery, query_printer, send_lines
from app.services.werkstatt_label_verdict import Verdict, judge

logger = logging.getLogger(__name__)

APPLY_SETTLE_S = 0.3
APPLY_CONFIRM_RETRIES = 2
APPLY_CONFIRM_DELAY_S = 0.5
AUTOSENSE_TIMEOUT_S = 45
BUTTON_SENSE_TIMEOUT_S = 120
AUTOSENSE_MIN_WAIT_S = 6.0
AUTOSENSE_SLOW_S = 15
NOTES_MAX_CHARS = 200
# Asserted by a test, not enforced: the worst-case state blob stays far below.
STATE_BLOB_BUDGET = 65536

SENSING_RUNNING = "Einmessen läuft noch – bitte warten, bis es abgeschlossen ist"
APPLY_FIRST = "Zuerst Einstellungen übertragen"
P1_TIMEOUT = "Einmessen dauert ungewöhnlich lange – bitte am Drucker nachsehen. Läuft noch Material durch: Deckel öffnen."
P2_NO_REPLY = "Drucker antwortet nicht – Ergebnis abfragen"
P3_BUTTON_SILENT = "Drucker meldet keinen Status – wenn er stillsteht, „Ergebnis abfragen“ drücken."
P8_BUTTON_IDLE = "Wenn der Drucker stillsteht: „Ergebnis abfragen“ drücken."
SLOW_MESSAGE = "Dauert länger als erwartet – läuft Material durch, Deckel öffnen (der Drucker stoppt dann vermutlich)."

AUDIT_TARGET = "label_printer"


# ── Commands ───────────────────────────────────────────────────────────────

_SENSOR_LINES = {
    ("die-cut", "see_through"): ["^G1", "^XSET,SENSING,1"],
    ("die-cut", "reflective"): ["^G0", "^XSET,SENSING,0"],
    ("die-cut", "auto"): ["^G2", "^XSET,SENSING,1"],
    ("continuous", "see_through"): ["^G1", "^XSET,SENSING,1"],
    ("continuous", "reflective"): ["^G0", "^XSET,SENSING,0"],
    ("continuous", "none"): ["^XSET,SENSING,2"],
}


def setup_commands(profile: MaterialProfile) -> list[str]:
    """The no-paper apply: sensor, then exactly one ``^Q`` and one ``^W``.

    EVERY apply states ``^XSET,SENSING,n``, die-cut included: CONFIG cannot
    show it, so a "Kein Sensor" apply (``SENSING,2``) left behind would
    otherwise linger into the next material unseen (T1/T17). Never ``^E``
    (it can feed, EZPL p.4), never ``^H ^S ^C ^P`` (every job states them),
    never ``^L``/``E`` (setup between them is ignored, EZPL p.75).
    """
    kind = "continuous" if profile.continuous else "die-cut"
    sensor = _SENSOR_LINES[(kind, profile.sensor_mode)]
    return [*sensor, f"^Q{q_value(profile)}", f"^W{mm_int(profile.width_mm)}"]


def reprime_lines(profile: MaterialProfile) -> list[str]:
    """``^Q``/``^W`` only — re-sent right before the pre-sense snapshot, so a
    ``^Q`` rewritten by an unnoticed lid-close auto-sense (T3) cannot pass
    for a fresh measurement."""
    return setup_commands(profile)[-2:]


# ── Results handed to the router ───────────────────────────────────────────


@dataclass(frozen=True)
class ApplyResult:
    printer: str
    commands: list[str]
    confirmed: bool | None
    mismatches: list[str]
    config: PrinterConfig | None
    session: sessions.CalibrationSession


@dataclass(frozen=True)
class AutosenseResult:
    printer: str
    method: str
    status_answered: bool
    presense: dict[str, Any] | None
    profile: MaterialProfile
    session: sessions.CalibrationSession


@dataclass(frozen=True)
class PollResult:
    phase: str
    answered: bool
    code: str | None
    code_text: str
    message: str
    saw_busy: bool
    elapsed_s: float
    session: sessions.CalibrationSession


@dataclass(frozen=True)
class VerifyResult:
    verdict: Verdict
    status: PrinterStatus
    profile: MaterialProfile
    session: sessions.CalibrationSession


@dataclass(frozen=True)
class PatternResult:
    printer: str
    lines: list[str]
    geometry: Any
    profile: MaterialProfile
    session: sessions.CalibrationSession


# ── Shared helpers ─────────────────────────────────────────────────────────


def step_order(message: str) -> LabelRequestRefused:
    return LabelRequestRefused(409, "step_order", message)


def printer_not_ready(code: str | None, code_text: str, action_text: str) -> LabelRequestRefused:
    """The ONE template for every "not ready" — apply, autosense, pattern.

    The printer's status code travels as ``status_code``: ``code`` is the
    error code the client branches on and must stay "printer_not_ready".
    """
    return LabelRequestRefused(
        409, "printer_not_ready", f"Drucker nicht bereit: {code_text}",
        status_code=code, code_text=code_text, action_text=action_text,
    )


def _material(db: Session, material_id: str) -> tuple[MaterialProfile, list[MaterialProfile]]:
    from app.services.werkstatt_label_materials import get_label_printer_config, require_material

    config = get_label_printer_config(db)
    return require_material(config["materials"], material_id), config["materials"]


def material_profile(db: Session, material_id: str) -> MaterialProfile:
    return _material(db, material_id)[0]


def _audit(db: Session, user: User, action: str, target_id: str, details: dict[str, Any]) -> None:
    log_admin_action(db, user, f"werkstatt.label_printer.{action}", AUDIT_TARGET, target_id, details)


@contextmanager
def _audited_after_send(db: Session, user: User, action: str, target_id: str, details: dict[str, Any]) -> Iterator[None]:
    """Step 3 of a step whose send went out: the audit row is written however
    the step ends. The sense runs and the pattern is printed whether or not
    the session survived meanwhile, so a ``session_lost`` answer carries
    ``session_lost: true`` in the row instead of losing it (§5.4)."""
    lost = False
    try:
        yield
    except BaseException as exc:
        lost = isinstance(exc, LabelRequestRefused) and exc.code == "session_lost"
        db.rollback()
        raise
    finally:
        _audit(db, user, action, target_id, {**details, "session_lost": True} if lost else details)


def _read_config(db: Session) -> PrinterConfig | None:
    reply = query_printer(db, PrinterQuery.CONFIG)
    return parse_config(reply.text, reply.complete) if reply.text else None


def _with_write(sense: dict[str, Any] | None, kind: str, at: str, q: str | None) -> dict[str, Any] | None:
    if sense is None:
        return None
    writes = [*(sense.get("writes_since_sense") or []), {"kind": kind, "at": at, "q": q}]
    return sessions.cap_lists({**sense, "writes_since_sense": writes})


def _elapsed(sense: dict[str, Any]) -> float:
    started = sessions.parse_iso(sense.get("started_at"))
    if started is None:
        return 0.0
    return max(0.0, (sessions.now_utc() - started).total_seconds())


# ── State blob: calibration records and the last apply ─────────────────────


def _state_from(raw: str | None) -> dict[str, Any]:
    try:
        parsed = json.loads(raw) if raw else {}
    except Exception:
        parsed = {}
    if not isinstance(parsed, dict):
        parsed = {}
    calibrations = parsed.get("calibrations")
    last_applied = parsed.get("last_applied")
    return {
        "calibrations": {
            key: value for key, value in (calibrations.items() if isinstance(calibrations, dict) else [])
            if isinstance(value, dict)
        },
        "last_applied": last_applied if isinstance(last_applied, dict) else None,
    }


def read_state(db: Session) -> dict[str, Any]:
    """Records and the last apply; malformed JSON reads as empty."""
    return _state_from(get_runtime_setting(db, WERKSTATT_LABEL_PRINTER_STATE_KEY))


def _update_state(db: Session, mutate: Callable[[dict[str, Any]], dict[str, Any]]) -> None:
    """Read-modify-write of the state blob under its row lock (no revision:
    config writes never touch it)."""
    row = get_runtime_setting_for_update(db, WERKSTATT_LABEL_PRINTER_STATE_KEY)
    state = _state_from(row.value if row is not None else None)
    state = {**state, **mutate(state)}
    set_runtime_setting(db, WERKSTATT_LABEL_PRINTER_STATE_KEY, json.dumps(state, ensure_ascii=False))


# ── Session lifecycle ──────────────────────────────────────────────────────


def start_session(db: Session, user: User, *, mode: str, material_id: str, takeover: bool) -> sessions.CalibrationSession:
    session, replaced = sessions.acquire(db, user=user, mode=mode, material_id=material_id, takeover=takeover)
    db.commit()
    details: dict[str, Any] = {"session_id": session.session_id, "mode": mode, "material_id": session.material_id}
    if replaced is not None and replaced.user_id != user.id:
        details["takeover_of"] = {"user_id": replaced.user_id, "user_name": replaced.user_name, "session_id": replaced.session_id}
    _audit(db, user, "session_start", session.material_id, details)
    return session


def heartbeat(db: Session, user: User, session_id: str) -> sessions.CalibrationSession:
    session = sessions.require(db, session_id, user)
    db.commit()
    return session


def end_session(db: Session, user: User, session_id: str) -> None:
    if sessions.release(db, session_id, user):
        db.commit()
        _audit(db, user, "session_end", session_id, {"session_id": session_id})
    else:
        db.rollback()


def activate(db: Session, user: User, session_id: str, material_id: str) -> tuple[sessions.CalibrationSession, int]:
    """Choose the loaded material: session AND active material, no printer I/O."""
    from app.services.werkstatt_label_materials import set_active_material

    session = sessions.require(db, session_id, user)
    if session.phase == "sensing" or session.sense_pending or session.pattern_pending:
        raise step_order(SENSING_RUNNING)
    config, _changed = set_active_material(db, material_id)
    profile = next(item for item in config["materials"] if item.id == material_id)
    snapshot = session.profile_at_start if material_id == session.material_id else sessions.profile_snapshot(profile)
    # The latch and the writes stay: switching to the stock the run actually
    # measured is judged on that measurement, not on a fresh read.
    session = replace(session, material_id=material_id, apply=None, verify=None, phase="activated", profile_at_start=snapshot)
    sessions.write(db, session)
    db.commit()
    _audit(db, user, "activate", material_id, {"session_id": session_id, "revision": config["revision"]})
    return session, config["revision"]


# ── Apply (no paper per the manual) ────────────────────────────────────────


def _confirm(profile: MaterialProfile, config: PrinterConfig | None) -> tuple[bool | None, list[str]]:
    if config is None:
        return None, []
    mismatches: list[str] = []
    width = mm_int(profile.width_mm)
    if config.width_mm is None or abs(config.width_mm - width) > 1e-9:
        printed = "?" if config.width_mm is None else format_mm_de(config.width_mm)
        mismatches.append(f"Breite: Drucker {printed} mm, Profil {width} mm")
    expected_q = q_value(profile)
    if config.stored_q != expected_q:
        mismatches.append(f"Etikett/Spalt: Drucker {config.stored_q or '?'}, Profil {expected_q}")
    expected = expected_sensor(profile)
    if expected is not None and config.sensor_kind != expected:
        mismatches.append(f"Sensor: Drucker {sensor_word(config.sensor_kind)}, Profil {sensor_word(expected)}")
    return not mismatches, mismatches


def _record_apply(
    db: Session, user: User, session: sessions.CalibrationSession, profile: MaterialProfile,
    commands: list[str], at: str, printer: str,
) -> None:
    """``last_applied`` and the audit row, written as soon as the setup lines
    went out — before the readback or the session check can fail. The printer
    has changed either way, and ``SENSING`` cannot be read back: this record
    is what the cancel dialog names (H3)."""
    last_applied = {
        "material_id": profile.id, "at": at, "by_id": user.id, "by_name": session.user_name,
        "commands": commands, "confirmed": None,
    }
    _update_state(db, lambda _state: {"last_applied": last_applied})
    db.commit()
    _audit(db, user, "apply", profile.id, {"session_id": session.session_id, "commands": commands, "printer": printer})


def _record_confirmation(db: Session, at: str, material_id: str, confirmed: bool) -> None:
    """The readback's verdict onto ``last_applied`` — if it still names this apply."""

    def mutate(state: dict[str, Any]) -> dict[str, Any]:
        last = state["last_applied"]
        if not last or last.get("at") != at or last.get("material_id") != material_id:
            return {}
        return {"last_applied": {**last, "confirmed": confirmed}}

    _update_state(db, mutate)
    db.commit()


def _readback(db: Session) -> PrinterConfig | None:
    """CONFIG after the setup lines. They went out already, so a printer that
    stops answering now is "no values reported" (``confirmed`` None), not a
    failed apply — the auto-sense checks the result."""
    time.sleep(APPLY_SETTLE_S)
    try:
        return _read_config(db)
    except (LabelPrinterUnreachable, LabelPrinterIoBusy) as exc:
        logger.warning("Label printer readback after apply failed: %s", exc)
        return None


def apply_material(db: Session, user: User, session_id: str) -> ApplyResult:
    session = sessions.require(db, session_id, user)
    if session.phase == "sensing" or session.sense_pending:
        raise step_order(SENSING_RUNNING)
    if session.phase == "open":
        raise step_order("Zuerst das eingelegte Material bestätigen")
    from app.services.werkstatt_label_materials import get_label_printer_config

    if get_label_printer_config(db)["active_material_id"] != session.material_id:
        raise step_order("Gewähltes Material wurde geändert – bitte Material erneut wählen")
    profile, _ = _material(db, session.material_id)
    db.commit()

    status = read_status(db, full=False, profile=profile)
    if status.code in BUSY_CODES:
        raise printer_not_ready(status.code, status.code_text, status.action_text)
    commands = setup_commands(profile)
    printer = send_lines(db, commands, session_id=session_id)
    at = sessions.iso(sessions.now_utc())
    _record_apply(db, user, session, profile, commands, at, printer)
    config = _readback(db)
    confirmed, mismatches = _confirm(profile, config)
    if confirmed is not None:
        _record_confirmation(db, at, profile.id, confirmed)

    session = sessions.require(db, session_id, user)
    session = replace(
        session,
        apply={"at": at, "material_id": profile.id, "commands": commands, "confirmed": confirmed},
        phase="applied",
        sense=_with_write(session.sense, "apply", at, q_value(profile)),
    )
    sessions.write(db, session)
    db.commit()
    return ApplyResult(printer, commands, confirmed, mismatches, config, session)


# ── Auto-sense (feeds media) ───────────────────────────────────────────────


def _presense(db: Session, profile: MaterialProfile) -> dict[str, Any] | None:
    """The pre-sense snapshot freshness is proven against.

    A read that ended before its terminator is retried like a stale ``^Q``;
    if every retry is cut too, the snapshot is unknown rather than read from
    a partial reply — "^QD1164,3" of "^QD1164,30" would make an unchanged
    measurement look new.
    """
    expected_q = q_value(profile)
    config: PrinterConfig | None = None
    for attempt in range(APPLY_CONFIRM_RETRIES + 1):
        config = _read_config(db)
        if config is None:
            return None
        if (config.complete and config.stored_q == expected_q) or attempt == APPLY_CONFIRM_RETRIES:
            break
        time.sleep(APPLY_CONFIRM_DELAY_S)
    if not config.complete:
        return {"stored_q": None, "qd": None, "apply_confirmed": None}
    qd = None
    if config.measured_length_dots is not None and config.measured_gap_dots is not None:
        qd = [config.measured_length_dots, config.measured_gap_dots]
    return {"stored_q": config.stored_q, "qd": qd, "apply_confirmed": config.stored_q == expected_q}


def _release_pending(db: Session, user: User, session_id: str, flag: str, write: tuple[str, str, str | None] | None) -> None:
    """After a failed start: clear the pending flag, record a write that happened."""
    try:
        session = sessions.require(db, session_id, user)
    except LabelRequestRefused:
        db.rollback()
        return
    sense = _with_write(session.sense, *write) if write else session.sense
    sessions.write(db, replace(session, **{flag: False}, sense=sense))
    db.commit()


def start_autosense(db: Session, user: User, session_id: str, *, confirm_feed: bool, method: str) -> AutosenseResult:
    if not confirm_feed:
        raise LabelRequestRefused(422, "confirm_feed_required", "Materialeinzug muss bestätigt werden")
    session = sessions.require(db, session_id, user)
    if session.sense_pending or session.pattern_pending:
        raise step_order("Einmessen wird bereits gestartet")
    if session.phase == "sensing":
        raise step_order(SENSING_RUNNING)
    if session.phase not in ("applied", "sensed", "judged") or not session.applied:
        raise step_order(APPLY_FIRST)
    profile, _ = _material(db, session.material_id)
    sessions.write(db, replace(session, sense_pending=True))
    db.commit()

    reprime: tuple[str, str, str | None] | None = None
    try:
        status = read_status(db, full=False, profile=profile)
        if not status.answered:
            if method == "command":
                raise LabelRequestRefused(
                    409, "no_status_reply",
                    "Drucker antwortet nicht auf Statusabfragen – stattdessen die Kalibriertaste auf der Rückseite verwenden",
                )
        elif status.code != "00":
            raise printer_not_ready(status.code, status.code_text, status.action_text)
        printer = send_lines(db, reprime_lines(profile), session_id=session_id)
        reprime = ("reprime", sessions.iso(sessions.now_utc()), q_value(profile))
        presense = _presense(db, profile)
        if method == "command":
            send_lines(db, ["~S,SENSOR"], session_id=session_id)
        started_at = sessions.iso(sessions.now_utc())
    except Exception:
        _release_pending(db, user, session_id, "sense_pending", reprime)
        raise

    details = {"session_id": session_id, "method": method, "status_answered": status.answered, "presense": presense}
    with _audited_after_send(db, user, "autosense", profile.id, details):
        session = sessions.require(db, session_id, user)
        sense = {
            "method": method, "started_at": started_at, "status_answered": status.answered, "presense": presense,
            "saw_busy": False, "poll_codes": [], "no_reply_polls": 0, "result": None, "latched": None,
            "writes_since_sense": [],
        }
        session = replace(session, sense=sense, verify=None, phase="sensing", sense_pending=False)
        sessions.write(db, session)
        db.commit()
    return AutosenseResult(printer, method, status.answered, presense, profile, session)


def _poll_outcome(sense: dict[str, Any], code: str | None, elapsed: float) -> tuple[str, str, dict[str, Any]]:
    """(phase, message, updated sense) — the first matching row of §4.6."""
    method = sense.get("method")
    timeout = AUTOSENSE_TIMEOUT_S if method == "command" else BUTTON_SENSE_TIMEOUT_S
    if elapsed > timeout:  # P1 — wins over a simultaneous "busy"
        return "timeout", P1_TIMEOUT, sense
    if code is None:
        if method == "command":  # P2
            polls = int(sense.get("no_reply_polls") or 0) + 1
            sense = {**sense, "no_reply_polls": polls}
            return ("error", P2_NO_REPLY, sense) if polls >= 3 else ("sensing", "", sense)
        return "sensing", P3_BUTTON_SILENT, sense  # P3 — the button needs no STATUS
    if code in BUSY_CODES:  # P4
        return "sensing", "", {**sense, "saw_busy": True}
    if code == "00":
        if sense.get("saw_busy"):  # P5
            return "done", "", sense
        if method == "command":  # P6 / P7
            return ("done", "", sense) if elapsed >= AUTOSENSE_MIN_WAIT_S else ("sensing", "", sense)
        return "sensing", P8_BUTTON_IDLE, sense  # P8
    if code in STATUS_TEXT_DE:  # P9
        return "error", "", sense
    return "error", f"Unbekannter Status {code}", sense  # P10


def poll_sensing(db: Session, user: User, session_id: str) -> PollResult:
    session = sessions.require(db, session_id, user)
    if session.phase == "sensed" and session.sense and session.sense.get("result"):
        db.commit()
        result = session.sense["result"]
        return PollResult(
            result["phase"], bool(result.get("answered", result.get("code") is not None)), result.get("code"),
            result.get("code_text", ""), result.get("message", ""), bool(session.sense.get("saw_busy")),
            float(result.get("elapsed_s", 0.0)), session,
        )
    if session.phase != "sensing" or not session.sense:
        raise step_order("Kein Einmessen aktiv")
    profile, _ = _material(db, session.material_id)
    db.commit()

    status = read_status(db, full=False, profile=profile)

    session = sessions.require(db, session_id, user)
    if session.phase != "sensing" or not session.sense:
        raise step_order("Kein Einmessen aktiv")
    sense = dict(session.sense)
    if status.code is not None:
        sense["poll_codes"] = [*(sense.get("poll_codes") or []), status.code]
    elapsed = _elapsed(sense)
    phase, message, sense = _poll_outcome(sense, status.code, elapsed)
    if phase == "sensing" and not message and elapsed >= AUTOSENSE_SLOW_S:
        message = SLOW_MESSAGE
    sense = sessions.cap_lists(sense)
    if phase != "sensing":
        sense["result"] = {
            "phase": phase, "code": status.code, "code_text": status.code_text, "message": message,
            "answered": status.answered, "elapsed_s": round(elapsed, 1),
        }
        session = replace(session, sense=sense, phase="sensed")
    else:
        session = replace(session, sense=sense)
    sessions.write(db, session)
    db.commit()
    return PollResult(phase, status.answered, status.code, status.code_text, message, bool(sense.get("saw_busy")), round(elapsed, 1), session)


# ── Verify ─────────────────────────────────────────────────────────────────


def verify_material(db: Session, user: User, session_id: str) -> VerifyResult:
    session = sessions.require(db, session_id, user)
    if not session.sense:
        raise step_order("Zuerst einmessen")
    if not session.applied:
        raise step_order(APPLY_FIRST)
    if session.sense_pending:
        raise step_order("Einmessen wird bereits gestartet")
    profile, materials = _material(db, session.material_id)
    db.commit()

    status = read_status(db, full=True, profile=profile)

    session = sessions.require(db, session_id, user)
    if not session.sense or session.material_id != profile.id:
        raise sessions_lost()
    now = sessions.now_utc()
    verdict = judge(
        profile=profile, materials=materials, status_code=status.code, status_text=status.code_text,
        status_action=status.action_text, config=status.config, sense=session.sense, now_iso=sessions.iso(now),
        hhmm=sessions.local_hhmm, parse_time=sessions.parse_iso,
    )
    sense = session.sense if verdict.new_latch is None else {**session.sense, "latched": verdict.new_latch}
    config = status.config
    verify = {
        "material_id": profile.id, "at": sessions.iso(now), "verdict": verdict.verdict, "freshness": verdict.freshness,
        "fresh": verdict.fresh, "from_latch": verdict.from_latch,
        "measured_length_dots": verdict.measured_length_dots, "measured_gap_dots": verdict.measured_gap_dots,
        "measured_pitch_dots": verdict.measured_pitch_dots, "stored_q_after": verdict.stored_q_after,
        "status_code": status.code, "sensor_kind": verdict.sensor_kind,
        "sensor_line": config.sensor_line if config else None, "sensor_ok": verdict.sensor_ok,
        "firmware": config.firmware if config else None, "row_offset_dots": config.row_offset_dots if config else None,
    }
    session = replace(session, sense=sense, verify=verify, phase="judged")
    sessions.write(db, session)
    db.commit()
    return VerifyResult(verdict, status, profile, session)


def sessions_lost() -> LabelRequestRefused:
    return LabelRequestRefused(409, "session_lost", sessions.SESSION_LOST_MESSAGE)


# ── Measuring pattern (full wizard, feeds one label) ───────────────────────


def print_pattern(db: Session, user: User, session_id: str, *, confirm_feed: bool) -> PatternResult:
    from app.services.werkstatt_label_patterns import pattern_job, pattern_supported

    if not confirm_feed:
        raise LabelRequestRefused(422, "confirm_feed_required", "Materialeinzug muss bestätigt werden")
    session = sessions.require(db, session_id, user)
    if session.mode != "full":
        raise LabelRequestRefused(422, "pattern_full_only", "Messmuster gibt es nur in der vollständigen Einrichtung")
    profile, _ = _material(db, session.material_id)
    if not pattern_supported(profile):
        raise LabelRequestRefused(422, "pattern_unsupported", "Messmuster für mehrbahniges Material folgt nach dem Praxistest (T8)")
    if session.phase != "judged" or not session.applied:
        raise step_order("Zuerst Einstellungen übertragen und Ergebnis prüfen")
    if session.pattern_pending or session.sense_pending:
        raise step_order("Messmuster wird bereits gedruckt")
    sessions.write(db, replace(session, pattern_pending=True))
    db.commit()

    try:
        status = read_status(db, full=False, profile=profile)
        if status.code != "00":
            raise printer_not_ready(status.code, status.code_text, status.action_text)
        if status.pending:
            # A buffered job would interleave with the pattern.
            raise printer_not_ready(status.code, "Druckaufträge in Arbeit", "Bitte warten")
        lines, geometry = pattern_job(profile)
        printer = send_lines(db, lines, session_id=session_id)
    except Exception:
        _release_pending(db, user, session_id, "pattern_pending", None)
        raise

    details = {"session_id": session_id, "x_offset_mm": profile.x_offset_mm, "across_offset_mm": profile.across_offset_mm, "printer": printer}
    with _audited_after_send(db, user, "pattern", profile.id, details):
        session = sessions.require(db, session_id, user)
        q = lines[0][len("^Q"):]
        session = replace(session, pattern_pending=False, sense=_with_write(session.sense, "pattern", sessions.iso(sessions.now_utc()), q))
        sessions.write(db, session)
        db.commit()
    return PatternResult(printer, lines, geometry, profile, session)


# ── Save ───────────────────────────────────────────────────────────────────

CHANGE_FIELDS = sessions.PROFILE_AT_START_FIELDS


def save_calibration(
    db: Session, user: User, session_id: str, *, notes: str, accept_verdict: bool, pattern: dict[str, Any] | None
) -> dict[str, Any]:
    """Write the record (everything from the server, nothing from the client
    but notes, acceptance and the caliper readings) and release the session."""
    from app.services import werkstatt_labels as wl

    session = sessions.require(db, session_id, user)
    verify = session.verify
    if not verify or verify.get("material_id") != session.material_id:
        raise step_order("Zuerst Ergebnis prüfen")
    if verify.get("verdict") != "match" and not accept_verdict:
        raise LabelRequestRefused(422, "accept_required", "Abweichendes Ergebnis muss ausdrücklich bestätigt werden")
    if pattern is not None and session.mode != "full":
        raise LabelRequestRefused(422, "pattern_full_only", "Messmuster gibt es nur in der vollständigen Einrichtung")
    profile, _ = _material(db, session.material_id)
    sense = session.sense or {}
    start = session.profile_at_start
    changes = {
        name: {"from": start.get(name), "to": getattr(profile, name)}
        for name in CHANGE_FIELDS
        if start.get("material_id") == profile.id and start.get(name) != getattr(profile, name)
    }
    record = {
        "material_id": profile.id,
        "kind": session.mode,
        "at": sessions.iso(sessions.now_utc()),
        "by_id": user.id,
        "by_name": session.user_name,
        "verdict": verify["verdict"],
        "fresh": bool(verify.get("fresh")),
        "freshness": verify.get("freshness", "none"),
        "accepted": verify["verdict"] != "match" and accept_verdict,
        "measured_length_dots": verify.get("measured_length_dots"),
        "measured_gap_dots": verify.get("measured_gap_dots"),
        "measured_pitch_dots": verify.get("measured_pitch_dots"),
        "stored_q_before": (sense.get("presense") or {}).get("stored_q"),
        "stored_q_after": verify.get("stored_q_after"),
        "sensor_kind": verify.get("sensor_kind", "unknown"),
        "sensor_line": (verify.get("sensor_line") or None) and str(verify["sensor_line"])[:80],
        "firmware": (verify.get("firmware") or None) and str(verify["firmware"])[:60],
        "row_offset_dots": verify.get("row_offset_dots"),
        "poll_codes": list(sense.get("poll_codes") or [])[: sessions.POLL_CODES_CAP],
        "fingerprint": profile.fingerprint,
        "pattern": pattern,
        "changes": changes,
        "notes": wl._clean(notes or "", NOTES_MAX_CHARS),
    }
    _update_state(db, lambda state: {"calibrations": {**state["calibrations"], profile.id: record}})
    sessions.write(db, None)
    db.commit()
    _audit(db, user, "calibration_save", profile.id, {
        "session_id": session_id, "verdict": record["verdict"], "accepted": record["accepted"], "changes": changes,
    })
    return record
