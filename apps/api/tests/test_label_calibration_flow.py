"""The calibration flow against the simulated printer, step by step.

Quick flow: activate → apply (no paper) → autosense (feeds) → poll → verify →
save. What must hold: the exact bytes of every send; a measurement counts
only with proof that it is fresh, and the first fresh verify latches it so a
later ``^Q`` write (which might echo into ``^QD``, untested T1) can never turn
into a match on the wrong stock; the printer's silence routes to the
calibration button; every step refuses out of order; paper moves only with
``confirm_feed``.
"""

from __future__ import annotations

import json
import threading
import time
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.core.db import SessionLocal
from app.models.entities import AuditLog
from app.services import werkstatt_label_calibration as calibration
from app.services import werkstatt_label_session as sessions
from app.services.runtime_settings import WERKSTATT_LABEL_PRINTER_LOCK_KEY, get_runtime_setting, set_runtime_setting
from app.services.werkstatt_label_errors import LabelPrinterIoBusy, LabelPrinterUnreachable
from app.services.werkstatt_label_io_lock import BUSY_MESSAGE
from tests.conftest import auth_headers
from tests.fake_ezpl_printer import configure_fake
from tests.label_calibration_helpers import A, W, settings, start, step, to_sensed


@pytest.fixture
def printer(client: TestClient, admin_token: str, fake_printer):
    configure_fake(client, admin_token, fake_printer)
    return fake_printer


def _lock() -> dict:
    with SessionLocal() as db:
        return json.loads(get_runtime_setting(db, WERKSTATT_LABEL_PRINTER_LOCK_KEY) or "{}")


def _set_lock(blob: dict) -> None:
    with SessionLocal() as db:
        set_runtime_setting(db, WERKSTATT_LABEL_PRINTER_LOCK_KEY, json.dumps(blob))
        db.commit()


def _verify(client: TestClient, token: str, sid: str, expect: int = 200) -> dict:
    return step(client, token, sid, "verify", expect=expect)


# ── The happy path, byte for byte ──────────────────────────────────────────


def test_quick_flow_end_to_end(client: TestClient, admin_token: str, printer) -> None:
    sid = start(client, admin_token)["session_id"]
    activated = step(client, admin_token, sid, "activate", {"material_id": "wago-210-804"})
    assert activated["phase"] == "activated"
    assert printer.received == []  # choosing the material touches no printer

    applied = step(client, admin_token, sid, "apply")
    printer.wait_for_connections(3)
    # 99 + 3 × 44 mm in the printer's millimetres (dots / 12 of 1169 + 35 × 520 dots).
    assert printer.received == [b"~S,STATUS\r\n", b"^G1\r\n^XSET,SENSING,1\r\n^Q97,3\r\n^W44\r\n", b"^XGET,CONFIG\r\n"]
    assert applied["commands"] == ["^G1", "^XSET,SENSING,1", "^Q97,3", "^W44"]
    # The readback shows the profile's ^W/^Q and sensor: confirmed.
    assert (applied["confirmed"], applied["mismatches"], applied["session"]["applied"]) == (True, [], True)
    assert applied["config"]["stored_q"] == "97,3" and applied["config"]["width_mm"] == 44

    sensing = step(client, admin_token, sid, "autosense", {"confirm_feed": True})
    printer.wait_for_connections(7)
    assert printer.received[3:7] == [b"~S,STATUS\r\n", b"^Q97,3\r\n^W44\r\n", b"^XGET,CONFIG\r\n", b"~S,SENSOR\r\n"]
    assert sensing["presense"] == {"stored_q": "97,3", "measured_length_dots": 1164, "measured_gap_dots": 30, "apply_confirmed": True}
    assert sensing["status_answered"] is True
    assert sensing["cost_hint"] == "voraussichtlich 2–3 Etiketten (≈ 20–30 cm, Schätzung)"
    assert sensing["session"]["phase"] == "sensing"

    polls = [step(client, admin_token, sid, "poll") for _ in range(3)]
    assert [(p["phase"], p["code"]) for p in polls] == [("sensing", "60"), ("sensing", "60"), ("done", "00")]
    assert polls[-1]["saw_busy"] is True and polls[-1]["session"]["phase"] == "sensed"

    verdict = _verify(client, admin_token, sid)
    assert verdict["verdict"] == "match"
    assert (verdict["freshness"], verdict["fresh"], verdict["from_latch"]) == ("busy_seen", True, False)
    assert verdict["title"] == "Passt zu „Typenschilder 99 × 44 (silber)“"
    # Physical millimetres: the printer's 1164/30 dots at 300 dpi, not its own dots/12 (T4 13.10.2026).
    assert verdict["detail"] == "Gemessen 98,6 + 2,5 mm (Teilung 101,1 mm), Abweichung −0,9 mm bei ± 3,1 mm Toleranz."
    assert (verdict["delta_length_mm"], verdict["delta_pitch_mm"], verdict["tolerance_mm"]) == (-0.45, -0.91, 3.06)
    assert (verdict["measured_length_mm"], verdict["measured_gap_mm"], verdict["measured_pitch_mm"]) == (98.55, 2.54, 101.09)
    assert verdict["dots_per_mm"] == 11.81
    assert verdict["offers"] == ["save"]
    assert verdict["notes"] == ["210-804 und 210-824 sind gleich groß – die Messung unterscheidet sie nicht."]
    assert _lock()["sense"]["latched"]["freshness"] == "busy_seen"

    record = step(client, admin_token, sid, "save", {"notes": "Rolle\r\n neu ~ eingelegt"})
    assert record["verdict"] == "match" and record["accepted"] is False and record["stale"] is False
    assert (record["measured_length_dots"], record["measured_gap_dots"], record["measured_pitch_dots"]) == (1164, 30, 1194)
    assert record["notes"] == "Rolle neu eingelegt"
    assert record["firmware"] == "Smart Printer V5.UW0m" and record["row_offset_dots"] == -19
    assert _lock() == {}
    with SessionLocal() as db:
        from app.services.werkstatt_label_calibration import read_state

        state = read_state(db)
    stored = state["calibrations"]["wago-210-804"]
    assert stored["by_id"] == 1 and stored["stored_q_before"] == "97,3" and stored["poll_codes"] == ["60", "60", "00"]
    assert state["last_applied"]["commands"] == ["^G1", "^XSET,SENSING,1", "^Q97,3", "^W44"]
    chip = next(m for m in settings(client, admin_token)["materials"] if m["id"] == "wago-210-804")["calibration"]
    assert chip["verdict"] == "match" and chip["kind"] == "quick"

    with SessionLocal() as db:
        actions = {row.action for row in db.query(AuditLog).all()}
    assert {
        "werkstatt.label_printer.session_start", "werkstatt.label_printer.activate", "werkstatt.label_printer.apply",
        "werkstatt.label_printer.autosense", "werkstatt.label_printer.calibration_save",
    } <= actions


def test_apply_sends_no_job_settings(client: TestClient, admin_token: str, printer) -> None:
    sid = start(client, admin_token)["session_id"]
    step(client, admin_token, sid, "activate", {"material_id": "wago-210-804"})
    step(client, admin_token, sid, "apply")
    printer.wait_for_connections(3)
    lines = printer.received[1].decode().split("\r\n")
    assert not any(line.startswith(("^E", "^H", "^S", "^C", "^P", "^L")) for line in lines)


def test_apply_readback_mismatch_is_a_warning(client: TestClient, admin_token: str, printer) -> None:
    keep = printer._setup
    printer._setup = lambda line: None if line.startswith(("^W", "^G")) else keep(line)
    printer.sensor = "reflective"
    sid = start(client, admin_token)["session_id"]
    step(client, admin_token, sid, "activate", {"material_id": "wago-210-804"})
    applied = step(client, admin_token, sid, "apply")
    assert applied["confirmed"] is False
    assert applied["mismatches"] == ["Breite: Drucker 34 mm, Profil 44 mm", "Sensor: Drucker Reflex, Profil Durchlicht"]
    assert applied["session"]["phase"] == "applied"  # a warning, not an error


def test_apply_without_config_reply_is_unconfirmed(client: TestClient, admin_token: str, printer) -> None:
    printer.silent = {"CONFIG"}
    sid = start(client, admin_token)["session_id"]
    step(client, admin_token, sid, "activate", {"material_id": "wago-210-804"})
    applied = step(client, admin_token, sid, "apply")
    assert (applied["confirmed"], applied["config"]) == (None, None)


# ── What reached the printer is on record ──────────────────────────────────


def _audits(action: str) -> list[dict]:
    with SessionLocal() as db:
        rows = db.query(AuditLog).filter(AuditLog.action == f"werkstatt.label_printer.{action}").all()
        return [dict(row.details or {}) for row in rows]


def _last_applied() -> dict | None:
    with SessionLocal() as db:
        return calibration.read_state(db)["last_applied"]


def _taken_over(db) -> None:
    """Another session replaces the caller's: an admin takeover, the user's
    second tab, or an expiry followed by someone else's start."""
    thief = sessions.CalibrationSession(
        session_id="thief", mode="full", material_id="wago-210-804", user_id=1, user_name="Admin",
        acquired_at=sessions.now_utc().replace(microsecond=0), expires_at=sessions.now_utc() + timedelta(minutes=5),
    )
    sessions.write(db, thief)
    db.commit()


@pytest.mark.parametrize("failure", ["unreachable", "busy"])
def test_an_apply_whose_readback_fails_is_recorded(client, admin_token, printer, monkeypatch, failure) -> None:
    """The setup lines went out, so the printer changed. "Kein Sensor"
    (``^XSET,SENSING,2``) is invisible in CONFIG: if the readback after it
    fails, the record is the only place it shows. A readback without an
    answer is "no values reported", not a failed apply."""
    revision = settings(client, admin_token)["revision"]
    put = client.put(f"{A}/materials/wago-211-501", headers=auth_headers(admin_token), json={"revision": revision, "sensor_mode": "none"})
    assert put.status_code == 200, put.text
    sid = start(client, admin_token, "wago-211-501")["session_id"]
    step(client, admin_token, sid, "activate", {"material_id": "wago-211-501"})
    error = LabelPrinterUnreachable(f"{printer.host}:{printer.port}") if failure == "unreachable" else LabelPrinterIoBusy(BUSY_MESSAGE)

    def readback(db):
        raise error

    monkeypatch.setattr(calibration, "_read_config", readback)
    applied = step(client, admin_token, sid, "apply")
    printer.wait_for_connections(2)
    commands = ["^XSET,SENSING,2", "^Q15,0", "^W5"]
    assert printer.received[1] == b"^XSET,SENSING,2\r\n^Q15,0\r\n^W5\r\n"
    assert (applied["confirmed"], applied["mismatches"], applied["config"]) == (None, [], None)
    assert applied["session"]["phase"] == "applied"
    assert (_lock()["apply"]["commands"], _lock()["apply"]["confirmed"]) == (commands, None)
    last = _last_applied()
    assert (last["material_id"], last["commands"], last["confirmed"]) == ("wago-211-501", commands, None)
    assert [audit["commands"] for audit in _audits("apply")] == [commands]


def test_an_apply_is_recorded_although_the_session_was_lost(client, admin_token, printer, monkeypatch) -> None:
    sid = start(client, admin_token)["session_id"]
    step(client, admin_token, sid, "activate", {"material_id": "wago-210-804"})
    original = calibration._read_config

    def readback_then_taken_over(db):
        config = original(db)
        _taken_over(db)
        return config

    monkeypatch.setattr(calibration, "_read_config", readback_then_taken_over)
    lost = step(client, admin_token, sid, "apply", expect=409)
    assert lost["detail"]["code"] == "session_lost"
    commands = ["^G1", "^XSET,SENSING,1", "^Q97,3", "^W44"]
    last = _last_applied()
    # The readback answered, so the record says what the printer confirmed.
    assert (last["material_id"], last["commands"], last["confirmed"]) == ("wago-210-804", commands, True)
    assert [audit["commands"] for audit in _audits("apply")] == [commands]


def test_a_sense_started_for_a_lost_session_is_audited(client, admin_token, printer, monkeypatch) -> None:
    sid = start(client, admin_token)["session_id"]
    step(client, admin_token, sid, "activate", {"material_id": "wago-210-804"})
    step(client, admin_token, sid, "apply")
    original = calibration.send_lines

    def send_then_taken_over(db, lines, *, session_id):
        printer_address = original(db, lines, session_id=session_id)
        if lines == ["~S,SENSOR"]:
            _taken_over(db)
        return printer_address

    monkeypatch.setattr(calibration, "send_lines", send_then_taken_over)
    lost = step(client, admin_token, sid, "autosense", {"confirm_feed": True}, expect=409)
    assert lost["detail"]["code"] == "session_lost"
    assert printer.sense_runs == 1  # the printer is feeding paper all the same
    audits = _audits("autosense")
    assert len(audits) == 1 and audits[0]["session_lost"] is True and audits[0]["method"] == "command"


def test_a_pattern_printed_for_a_lost_session_is_audited(client, admin_token, printer, monkeypatch) -> None:
    sid = _judged_full(client, admin_token)
    printed = len(printer.jobs_printed)
    original = calibration.send_lines

    def send_then_taken_over(db, lines, *, session_id):
        printer_address = original(db, lines, session_id=session_id)
        _taken_over(db)
        return printer_address

    monkeypatch.setattr(calibration, "send_lines", send_then_taken_over)
    lost = step(client, admin_token, sid, "pattern", {"confirm_feed": True}, expect=409)
    assert lost["detail"]["code"] == "session_lost"
    printer.wait_for_jobs(printed + 1)
    audits = _audits("pattern")
    assert len(audits) == 1 and audits[0]["session_lost"] is True


def test_the_audit_of_a_step_that_completed_has_no_session_lost(client, admin_token, printer) -> None:
    sid = _judged_full(client, admin_token)
    step(client, admin_token, sid, "pattern", {"confirm_feed": True})
    assert all("session_lost" not in audit for audit in _audits("autosense") + _audits("pattern"))


# ── Freshness ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("rewrites_q", "result_qd", "freshness", "verdict"),
    [
        (True, (1164, 30), "q_changed", "match"),
        (False, (1170, 24), "qd_changed", "match"),
        (False, (1164, 30), "none", "unchecked"),
    ],
)
def test_freshness_without_busy(client, admin_token, printer, rewrites_q, result_qd, freshness, verdict) -> None:
    printer.sense_busy_polls = 0
    printer.sense_rewrites_q = rewrites_q
    printer.sense_result_qd = result_qd
    sid, poll = to_sensed(client, admin_token)
    assert poll["phase"] == "done"
    result = _verify(client, admin_token, sid)
    assert (result["freshness"], result["verdict"]) == (freshness, verdict)
    if verdict == "unchecked":
        assert result["detail"] == "Kein Nachweis, dass gerade neu gemessen wurde – angezeigt werden möglicherweise Werte einer früheren Messung."
        assert result["offers"] == ["requery", "resense", "accept_anyway"]
        assert _lock()["sense"]["latched"] is None


@pytest.mark.parametrize("cut_reads", [1, 3])
def test_a_cut_presense_read_proves_nothing(client, admin_token, printer, cut_reads) -> None:
    """The stale-match scenario of a cut reply: the sense changes nothing the
    printer reports, but the pre-sense CONFIG read ends inside "^QD1164,30".
    Read as 1164/3, the whole ^QD of the verify would look changed and a
    stale measurement would be latched as a match. A cut read is retried
    like a stale ^Q; when every retry is cut too, the snapshot is unknown."""
    printer.sense_busy_polls = 0
    printer.sense_rewrites_q = False
    sid = start(client, admin_token)["session_id"]
    step(client, admin_token, sid, "activate", {"material_id": "wago-210-804"})
    step(client, admin_token, sid, "apply")
    printer.config_cuts = ["^QD1164,3"] * cut_reads
    sensing = step(client, admin_token, sid, "autosense", {"confirm_feed": True})
    if cut_reads == 1:
        assert sensing["presense"] == {"stored_q": "97,3", "measured_length_dots": 1164, "measured_gap_dots": 30, "apply_confirmed": True}
    else:
        assert sensing["presense"] == {"stored_q": None, "measured_length_dots": None, "measured_gap_dots": None, "apply_confirmed": None}
    assert step(client, admin_token, sid, "poll")["phase"] == "done"
    result = _verify(client, admin_token, sid)
    assert (result["freshness"], result["verdict"]) == ("none", "unchecked")
    assert _lock()["sense"]["latched"] is None


@pytest.mark.parametrize(
    ("cut", "freshness"),
    [("^QD1164,3", "busy_seen"), ("^QD1170,24  ^Q97.5,2.0\r\n", "qd_changed")],
)
def test_a_cut_verify_read_latches_nothing(client, admin_token, printer, cut, freshness) -> None:
    """A verify read that did not reach its terminator is no measurement —
    cut inside ^QD (1164/3 instead of 1164/30) or after it (the whole line,
    but nothing proves the rest of the reply). Only a whole read is latched."""
    if freshness == "qd_changed":
        printer.sense_busy_polls = 0
        printer.sense_rewrites_q = False
        printer.sense_result_qd = (1170, 24)
    sid, _ = to_sensed(client, admin_token)
    printer.config_cuts = [cut]
    first = _verify(client, admin_token, sid)
    assert (first["verdict"], first["measured_length_dots"], first["measured_gap_dots"]) == ("no_result", None, None)
    assert "incomplete_reply" in {warning["code"] for warning in first["warnings"]}
    assert _lock()["sense"]["latched"] is None
    requery = _verify(client, admin_token, sid)
    assert (requery["verdict"], requery["freshness"], requery["from_latch"]) == ("match", freshness, False)
    assert _lock()["sense"]["latched"]["measured_gap_dots"] == (30 if freshness == "busy_seen" else 24)


def test_no_measurement_is_no_result(client, admin_token, printer) -> None:
    printer.sense_result_qd = None
    sid, _ = to_sensed(client, admin_token)
    result = _verify(client, admin_token, sid)
    assert result["verdict"] == "no_result" and result["offers"] == ["requery", "accept_anyway"]


def test_other_material_is_suggested(client, admin_token, printer) -> None:
    printer.sense_result_qd = (591, 35)  # 50 + 3 mm at 300 dpi (210-812)
    sid, _ = to_sensed(client, admin_token)
    result = _verify(client, admin_token, sid)
    assert result["verdict"] == "other_material"
    assert result["suggested_material_ids"] == ["wago-210-812"]
    assert result["detail"] == "Gemessen 53 mm Teilung – passt zu „Typenschilder 50 × 25 (silber)“ (WAGO 210-812). Ist ein anderes Material eingelegt?"
    assert result["offers"] == ["switch_material", "resense"]


def test_no_gap_on_die_cut(client, admin_token, printer) -> None:
    printer.sense_result_qd = (1200, 0)
    sid, _ = to_sensed(client, admin_token)
    result = _verify(client, admin_token, sid)
    assert result["verdict"] == "no_gap"
    assert result["detail"] == "Der Sensor sieht keine Spalte. Zeiger auf 3,4 der Skala stellen und erneut einmessen."


@pytest.mark.parametrize(
    ("rewrites_q", "result_qd", "verdict"),
    [(False, (1164, 30), "unchecked"), (True, (480, 0), "match"), (True, (600, 36), "gap_on_continuous")],
)
def test_continuous_verdicts(client, admin_token, printer, rewrites_q, result_qd, verdict) -> None:
    printer.sense_rewrites_q = rewrites_q
    printer.sense_result_qd = result_qd
    sid, _ = to_sensed(client, admin_token, "wago-2009-110")
    result = _verify(client, admin_token, sid)
    assert result["verdict"] == verdict
    if verdict == "unchecked":
        assert result["freshness"] == "busy_seen"
        assert result["detail"] == "Der Drucker hat gemessen, für Endlosmaterial aber kein neues Messergebnis gemeldet."
    if verdict == "match":
        assert result["detail"] == "Endlosmaterial erkannt."
    if verdict == "gap_on_continuous":
        assert result["suggested_material_ids"] == ["wago-210-812"]
        assert result["offers"] == ["switch_material", "resense"]


def test_final_status_error_is_printer_error(client, admin_token, printer) -> None:
    printer.sense_final_code = "02"
    sid, poll = to_sensed(client, admin_token)
    assert (poll["phase"], poll["code"], poll["code_text"]) == ("error", "02", "Papierstau oder Spalt nicht gefunden")
    result = _verify(client, admin_token, sid)
    assert result["verdict"] == "printer_error"
    assert result["title"] == "Drucker meldet: Papierstau oder Spalt nicht gefunden"
    assert result["detail"] == "Material, Sensorposition und Führungen prüfen"
    assert result["offers"] == ["requery", "resense"]


# ── The latch ──────────────────────────────────────────────────────────────


def test_latch_survives_a_reapply(client, admin_token, printer) -> None:
    printer.sense_sensor_after = "reflective"
    sid, _ = to_sensed(client, admin_token)
    first = _verify(client, admin_token, sid)
    assert (first["verdict"], first["sensor_ok"], first["offers"]) == ("match", False, ["save", "reapply"])
    assert any(w["code"] == "sensor_mismatch" for w in first["warnings"])
    step(client, admin_token, sid, "apply")
    second = _verify(client, admin_token, sid)
    assert (second["verdict"], second["freshness"], second["from_latch"]) == ("match", "busy_seen", True)
    assert second["notes"][-1].startswith("Bewertet wird die Messung vom Einmessen um ")


def test_switch_material_judges_the_latch_not_the_echo(client, admin_token, printer) -> None:
    printer.sense_result_qd = (601, 30)  # a 210-812 read a few dots long (300 dpi)
    printer.q_write_updates_qd = True
    sid, _ = to_sensed(client, admin_token)
    assert _verify(client, admin_token, sid)["verdict"] == "other_material"
    switched = step(client, admin_token, sid, "activate", {"material_id": "wago-210-812"})
    assert (switched["applied"], switched["sensed"], switched["verdict"]) == (False, True, None)
    step(client, admin_token, sid, "apply")
    assert printer.qd == (588, 36)  # the ^Q49,3 write (50 mm = 591 dots) echoed into ^QD
    result = _verify(client, admin_token, sid)
    assert (result["verdict"], result["from_latch"], result["freshness"]) == ("match", True, "busy_seen")
    assert (result["measured_length_dots"], result["measured_gap_dots"]) == (601, 30)


@pytest.mark.parametrize("echo", [True, False])
def test_a_write_before_the_latch_is_unchecked(client, admin_token, printer, echo) -> None:
    printer.q_write_updates_qd = echo
    sid, _ = to_sensed(client, admin_token)
    step(client, admin_token, sid, "activate", {"material_id": "wago-210-812"})
    step(client, admin_token, sid, "apply")
    result = _verify(client, admin_token, sid)
    assert result["verdict"] == "unchecked" and result["freshness"] == "none"
    assert result["offers"] == ["resense", "accept_anyway"]
    if echo:
        assert result["detail"] == "Messwert entspricht nur der übertragenen Einstellung – bitte erneut einmessen."
        assert _verify(client, admin_token, sid)["verdict"] == "unchecked"  # requery stays unchecked
    else:
        assert result["detail"].startswith("Seit dem Einmessen wurden Einstellungen übertragen oder ein Messmuster gedruckt")


def test_a_new_autosense_clears_latch_and_writes(client, admin_token, printer) -> None:
    sid, _ = to_sensed(client, admin_token)
    _verify(client, admin_token, sid)
    step(client, admin_token, sid, "apply")
    assert _lock()["sense"]["latched"] is not None and _lock()["sense"]["writes_since_sense"]
    step(client, admin_token, sid, "autosense", {"confirm_feed": True})
    sense = _lock()["sense"]
    assert sense["latched"] is None and sense["writes_since_sense"] == []
    assert _lock()["verify"] is None


# ── Order of steps ─────────────────────────────────────────────────────────


def test_step_order_refusals(client, admin_token, printer) -> None:
    sid = start(client, admin_token)["session_id"]
    assert step(client, admin_token, sid, "verify", expect=409)["detail"]["code"] == "step_order"
    step(client, admin_token, sid, "activate", {"material_id": "wago-210-804"})
    no_confirm = step(client, admin_token, sid, "autosense", {"confirm_feed": False}, expect=422)
    assert no_confirm["detail"] == {"code": "confirm_feed_required", "message": "Materialeinzug muss bestätigt werden"}
    assert step(client, admin_token, sid, "autosense", {"confirm_feed": True}, expect=409)["detail"]["message"] == "Zuerst Einstellungen übertragen"
    step(client, admin_token, sid, "apply")
    step(client, admin_token, sid, "autosense", {"confirm_feed": True})
    running = "Einmessen läuft noch – bitte warten, bis es abgeschlossen ist"
    assert step(client, admin_token, sid, "activate", {"material_id": "wago-210-812"}, expect=409)["detail"]["message"] == running
    assert step(client, admin_token, sid, "apply", expect=409)["detail"]["message"] == running
    for _ in range(3):
        step(client, admin_token, sid, "poll")
    _verify(client, admin_token, sid)
    assert step(client, admin_token, sid, "poll", expect=409)["detail"]["message"] == "Kein Einmessen aktiv"
    switched = step(client, admin_token, sid, "activate", {"material_id": "wago-210-812"})
    assert (switched["applied"], switched["sensed"], switched["verdict"]) == (False, True, None)
    assert step(client, admin_token, sid, "verify", expect=409)["detail"]["message"] == "Zuerst Einstellungen übertragen"


def test_autosense_refused_while_the_head_is_open(client, admin_token, printer) -> None:
    sid = start(client, admin_token)["session_id"]
    step(client, admin_token, sid, "activate", {"material_id": "wago-210-804"})
    step(client, admin_token, sid, "apply")
    printer.status_code = "04"
    refused = step(client, admin_token, sid, "autosense", {"confirm_feed": True}, expect=409)
    assert refused["detail"] == {
        "code": "printer_not_ready", "message": "Drucker nicht bereit: Druckkopf offen",
        "status_code": "04", "code_text": "Druckkopf offen", "action_text": "Deckel schließen",
    }
    assert b"~S,SENSOR\r\n" not in printer.received
    assert _lock()["sense_pending"] is False


def test_apply_refused_while_printing(client, admin_token, printer) -> None:
    sid = start(client, admin_token)["session_id"]
    step(client, admin_token, sid, "activate", {"material_id": "wago-210-804"})
    printer.status_code = "50"
    refused = step(client, admin_token, sid, "apply", expect=409)
    assert refused["detail"]["code"] == "printer_not_ready"
    assert refused["detail"]["message"] == "Drucker nicht bereit: Druckt"


# ── Button fallback ────────────────────────────────────────────────────────


@pytest.mark.parametrize("silence", ["requires_immediate", "silent"])
def test_silent_status_routes_to_the_button(client, admin_token, printer, silence) -> None:
    if silence == "requires_immediate":
        printer.requires_immediate = True
    else:
        printer.silent = {"STATUS"}
    sid = start(client, admin_token)["session_id"]
    step(client, admin_token, sid, "activate", {"material_id": "wago-210-804"})
    step(client, admin_token, sid, "apply")
    printer.wait_for_connections(3)
    sent_before = len(printer.received)

    refused = step(client, admin_token, sid, "autosense", {"confirm_feed": True, "method": "command"}, expect=409)
    assert refused["detail"]["code"] == "no_status_reply"
    assert refused["detail"]["message"] == "Drucker antwortet nicht auf Statusabfragen – stattdessen die Kalibriertaste auf der Rückseite verwenden"

    button = step(client, admin_token, sid, "autosense", {"confirm_feed": True, "method": "button"})
    assert (button["method"], button["status_answered"]) == ("button", False)
    assert _lock()["sense"]["method"] == "button"
    poll = step(client, admin_token, sid, "poll")
    assert (poll["phase"], poll["answered"]) == ("sensing", False)
    assert poll["message"] == "Drucker meldet keinen Status – wenn er stillsteht, „Ergebnis abfragen“ drücken."
    printer.press_calibration_button()
    result = _verify(client, admin_token, sid)
    assert (result["verdict"], result["freshness"]) == ("match", "q_changed")

    later = b"".join(printer.received[sent_before:])
    assert b"~S,SENSOR" not in later and b"^XSET" not in later
    assert b"^XSET,IMMEDIATE" not in b"".join(printer.received)
    assert printer.immediate is False


# ── Polling ────────────────────────────────────────────────────────────────


def _sensing(client, admin_token) -> str:
    sid = start(client, admin_token)["session_id"]
    step(client, admin_token, sid, "activate", {"material_id": "wago-210-804"})
    step(client, admin_token, sid, "apply")
    step(client, admin_token, sid, "autosense", {"confirm_feed": True})
    return sid


def test_unknown_status_code_is_an_error(client, admin_token, printer) -> None:
    sid = _sensing(client, admin_token)
    printer.status_override = ["99"]
    poll = step(client, admin_token, sid, "poll")
    assert (poll["phase"], poll["message"], poll["code_text"]) == ("error", "Unbekannter Status 99", "Unbekannter Status 99")


def test_timeout_wins_over_busy(client, admin_token, printer, monkeypatch) -> None:
    sid = _sensing(client, admin_token)
    monkeypatch.setattr(calibration, "AUTOSENSE_TIMEOUT_S", 0)
    time.sleep(0.01)
    poll = step(client, admin_token, sid, "poll")
    assert (poll["phase"], poll["code"]) == ("timeout", "60")
    assert poll["message"] == "Einmessen dauert ungewöhnlich lange – bitte am Drucker nachsehen. Läuft noch Material durch: Deckel öffnen."


def test_poll_in_sensed_replays_without_a_query(client, admin_token, printer) -> None:
    printer.sense_final_code = "02"
    sid, final = to_sensed(client, admin_token)
    printer.wait_for_connections(len(printer.received))
    count = len(printer.received)
    replay = step(client, admin_token, sid, "poll")
    assert (replay["phase"], replay["code"], replay["message"], replay["code_text"]) == (final["phase"], final["code"], final["message"], final["code_text"])
    assert len(printer.received) == count


def test_slow_message(client, admin_token, printer, monkeypatch) -> None:
    sid = _sensing(client, admin_token)
    monkeypatch.setattr(calibration, "AUTOSENSE_SLOW_S", 0)
    poll = step(client, admin_token, sid, "poll")
    assert poll["phase"] == "sensing"
    assert poll["message"] == "Dauert länger als erwartet – läuft Material durch, Deckel öffnen (der Drucker stoppt dann vermutlich)."


def test_command_without_reply_errors_on_the_third_poll(client, admin_token, printer) -> None:
    sid = _sensing(client, admin_token)
    printer.silent = {"STATUS"}
    polls = [step(client, admin_token, sid, "poll") for _ in range(3)]
    assert [p["phase"] for p in polls] == ["sensing", "sensing", "error"]
    assert polls[-1]["message"] == "Drucker antwortet nicht – Ergebnis abfragen"


# ── Measuring pattern ──────────────────────────────────────────────────────


def _judged_full(client, admin_token, material_id: str = "wago-210-804") -> str:
    sid, _ = to_sensed(client, admin_token, material_id, mode="full")
    _verify(client, admin_token, sid)
    return sid


def test_pattern_full_flow(client, admin_token, printer) -> None:
    sid = _judged_full(client, admin_token)
    printed = len(printer.jobs_printed)
    result = step(client, admin_token, sid, "pattern", {"confirm_feed": True})
    printer.wait_for_jobs(printed + 1)
    assert result["cost_hint"] == "1 Etikett" and result["geometry"]["ruler_to_mm"] == 90
    job = printer.jobs_printed[-1]
    assert job[:6] == ["Lo,24,48,496,51", "Lo,24,1166,496,1169", "Lo,493,48,496,1169", "Lo,24,48,27,1169", "Lo,259,573,261,643", "Lo,225,607,295,609"]
    assert printer.pieces_printed[-1] == 1
    writes = _lock()["sense"]["writes_since_sense"]
    assert writes[-1]["kind"] == "pattern" and writes[-1]["q"] == "97,3"
    assert result["session"]["phase"] == "judged"
    record = step(client, admin_token, sid, "save", {"pattern": {"lead_mm": 2.4, "left_mm": 2.0}})
    assert record["kind"] == "full" and record["pattern"]["lead_mm"] == 2.4


def test_pattern_refusals(client, admin_token, printer) -> None:
    sid = start(client, admin_token, mode="full")["session_id"]
    step(client, admin_token, sid, "activate", {"material_id": "wago-210-804"})
    assert step(client, admin_token, sid, "pattern", {}, expect=422)["detail"]["code"] == "confirm_feed_required"
    step(client, admin_token, sid, "apply")
    assert step(client, admin_token, sid, "pattern", {"confirm_feed": True}, expect=409)["detail"]["code"] == "step_order"
    step(client, admin_token, sid, "autosense", {"confirm_feed": True})
    assert step(client, admin_token, sid, "pattern", {"confirm_feed": True}, expect=409)["detail"]["code"] == "step_order"
    for _ in range(3):
        step(client, admin_token, sid, "poll")
    _verify(client, admin_token, sid)

    printer.status_code = "04"
    printed = len(printer.jobs_printed)
    head_open = step(client, admin_token, sid, "pattern", {"confirm_feed": True}, expect=409)
    assert head_open["detail"]["message"] == "Drucker nicht bereit: Druckkopf offen"
    assert len(printer.jobs_printed) == printed and _lock()["pattern_pending"] is False
    printer.status_code = "00"

    _set_lock({**_lock(), "pattern_pending": True})
    pending = step(client, admin_token, sid, "pattern", {"confirm_feed": True}, expect=409)
    assert pending["detail"]["message"] == "Messmuster wird bereits gedruckt"


def test_two_parallel_pattern_clicks_print_once(client, admin_token, printer) -> None:
    sid = _judged_full(client, admin_token)
    printed = len(printer.jobs_printed)
    printer.reply_delay_s = 0.4  # the first request sits in its STATUS read
    answers: list[int] = []

    def click() -> None:
        response = client.post(f"{W}/session/{sid}/pattern", headers=auth_headers(admin_token), json={"confirm_feed": True})
        answers.append(response.status_code)

    first = threading.Thread(target=click)
    first.start()
    time.sleep(0.15)
    click()
    first.join()
    printer.reply_delay_s = 0.0
    printer.wait_for_jobs(printed + 1)
    time.sleep(0.2)
    assert sorted(answers) == [200, 409]
    assert len(printer.jobs_printed) == printed + 1


def test_pattern_unsupported_and_quick_only(client, admin_token, printer) -> None:
    sid = _judged_full(client, admin_token, "wago-210-805")
    unsupported = step(client, admin_token, sid, "pattern", {"confirm_feed": True}, expect=422)
    assert unsupported["detail"] == {"code": "pattern_unsupported", "message": "Messmuster für mehrbahniges Material folgt nach dem Praxistest (T8)"}
    step(client, admin_token, sid, "save", {"accept_verdict": True})

    quick, _ = to_sensed(client, admin_token)
    _verify(client, admin_token, quick)
    only_full = step(client, admin_token, quick, "pattern", {"confirm_feed": True}, expect=422)
    assert only_full["detail"]["code"] == "pattern_full_only"
    with_pattern = step(client, admin_token, quick, "save", {"pattern": {"lead_mm": 1}}, expect=422)
    assert with_pattern["detail"]["code"] == "pattern_full_only"


def test_save_needs_acceptance_for_a_non_match(client, admin_token, printer) -> None:
    printer.sense_result_qd = (591, 35)  # 50 + 3 mm at 300 dpi (210-812)
    sid, _ = to_sensed(client, admin_token)
    assert step(client, admin_token, sid, "save", {}, expect=409)["detail"]["message"] == "Zuerst Ergebnis prüfen"
    _verify(client, admin_token, sid)
    refused = step(client, admin_token, sid, "save", {}, expect=422)
    assert refused["detail"] == {"code": "accept_required", "message": "Abweichendes Ergebnis muss ausdrücklich bestätigt werden"}
    record = step(client, admin_token, sid, "save", {"accept_verdict": True})
    assert (record["verdict"], record["accepted"]) == ("other_material", True)


@pytest.mark.parametrize(("length_dots", "gap_dots"), [(1154, 42), (1150, 44)])
def test_the_real_210_804_measurements_judge_as_a_match(length_dots: int, gap_dots: int) -> None:
    """Physical test 13.10.2026: two auto-senses on 210-804 (99 + 2,9 mm by ruler)
    reported 1154/42 and 1150/44 dots. Read as dots/12 — the printer's own mm —
    they looked 2,5 mm short and the second fell out of tolerance; the printer
    really feeds 300 dots per inch (a 80 mm ruler printed 81,5 mm)."""
    from app.services.werkstatt_label_verdict import _Expected, _deltas, _passes

    expected = _Expected(length_mm=99.0, gap_mm=3.0)
    d_length, d_pitch = _deltas(expected, length_dots, length_dots + gap_dots)
    assert abs(d_pitch) < 1.0 and abs(d_length) < 2.0
    assert _passes(expected, length_dots, length_dots + gap_dots)


def test_the_printers_own_millimetres_stay_dots_over_12() -> None:
    """The printer stores ^QD1154,42 as ^Q96.2,3.5 — its own unit is dots/12.
    Comparisons with what the printer stores keep that unit."""
    from app.services.werkstatt_label_verdict import consistent

    assert consistent("96,3", (1154, 42))
    assert not consistent("98,4", (1154, 42))
