"""``app_settings.value`` holds the label printer's worst-case blobs.

SQLite does not enforce VARCHAR lengths, so a too-small column would only
fail in production. These tests pin the column type and write the largest
blobs the calibration can produce — six records with 60 poll codes, a pattern
and 200-character notes; four full custom profiles plus builtin overrides; a
lock with 60 poll codes, 20 writes and a full verify — each under the budget
and unchanged after a round trip. (The PostgreSQL upgrade/downgrade and
scripts/check_schema_drift.py run by hand, see the migration.)
"""

from __future__ import annotations

import json

from sqlalchemy import Text

from app.core.db import SessionLocal
from app.models.entities import AppSetting
from app.services import werkstatt_label_session as sessions
from app.services.runtime_settings import (
    WERKSTATT_LABEL_PRINTER_KEY,
    WERKSTATT_LABEL_PRINTER_LOCK_KEY,
    WERKSTATT_LABEL_PRINTER_STATE_KEY,
    get_runtime_setting,
    set_runtime_setting,
)
from app.services.werkstatt_label_builtins import DEFAULT_MATERIALS
from app.services.werkstatt_label_calibration import STATE_BLOB_BUDGET
from app.services.werkstatt_label_materials import _serialize
from app.services.werkstatt_label_profile import MaterialProfile, MediaWeb


def _record(material_id: str) -> dict:
    return {
        "material_id": material_id, "kind": "full", "at": "2026-10-20T09:12:00.123456Z", "by_id": 1,
        "by_name": "Luca Schmidt mit einem langen Namen", "verdict": "match", "fresh": True, "freshness": "busy_seen",
        "accepted": False, "measured_length_dots": 1164, "measured_gap_dots": 30, "measured_pitch_dots": 1194,
        "stored_q_before": "99,3", "stored_q_after": "97,2", "sensor_kind": "see_through", "sensor_line": "S" * 80,
        "firmware": "F" * 60, "row_offset_dots": -19, "poll_codes": ["60"] * 60, "fingerprint": "3f2a9c0d11b7e845",
        "pattern": {"lead_mm": 2.4, "trail_mm": 1.9, "left_mm": 2.1, "right_mm": 2.0, "ruler_nominal_mm": 80, "ruler_measured_mm": 80.4},
        "changes": {name: {"from": 2.0, "to": 1.6} for name in ("x_offset_mm", "across_offset_mm", "darkness", "speed_ips", "stop_mm")},
        "notes": "ü" * 200,
    }


def _worst_state() -> str:
    state = {
        "calibrations": {material.id: _record(material.id) for material in DEFAULT_MATERIALS},
        "last_applied": {"material_id": "wago-210-804", "at": "2026-10-20T09:10:41Z", "by_id": 1, "by_name": "Luca Schmidt",
                         "commands": ["^G1", "^XSET,SENSING,1", "^Q99,3", "^W44"], "confirmed": True},
    }
    return json.dumps(state, ensure_ascii=False)


def _worst_config() -> str:
    customs = [
        MaterialProfile(
            id=f"custom-{index:05d}", name="Fremdetikett mit langem Namen " + "x" * 30, part_no="P" * 40,
            width_mm=40, length_mm=25, mark_width_mm=4, mark_offset_mm=3, darkness=10, speed_ips=3, stop_mm=5,
            across_offset_mm=0.5, web=MediaWeb(lanes=2, label_across_mm=18, label_along_mm=25, lane_gap_mm=2, liner_width_mm=40, source="measured"),
        )
        for index in range(4)
    ]
    builtins = [
        MaterialProfile(**{**{f: getattr(m, f) for f in m.__dataclass_fields__ if f != "job"}, "x_offset_mm": 1.6, "darkness": 9, "sensor_scale": 3.6})
        for m in DEFAULT_MATERIALS
    ]
    payload = _serialize(
        {"host": "192.168.2.158", "port": 9100, "materials": builtins + customs, "active_material_id": "wago-210-804",
         "baseline_overrides": {"darkness": 11, "speed_ips": 3, "stop_mm": 2}, "row_offset_dots": -19,
         "label_calibration_staff_enabled": True},
        revision=123456,
    )
    return json.dumps(payload, ensure_ascii=False)


def _worst_lock() -> str:
    session = sessions.CalibrationSession(
        session_id="8c1e" * 8, mode="full", material_id="wago-210-812", user_id=7, user_name="Max Monteur" * 3,
        acquired_at=sessions.now_utc(), expires_at=sessions.now_utc(), phase="judged",
        profile_at_start={"material_id": "wago-210-812", "x_offset_mm": 2.0, "across_offset_mm": 0.0, "darkness": None, "speed_ips": None, "stop_mm": None},
        apply={"at": "2026-10-20T09:08:30.123456Z", "material_id": "wago-210-812", "commands": ["^G1", "^XSET,SENSING,1", "^Q50,3", "^W25"], "confirmed": True},
        sense=sessions.cap_lists({
            "method": "command", "started_at": "2026-10-20T09:07:10.123456Z", "status_answered": True,
            "presense": {"stored_q": "99,3", "qd": [1164, 30], "apply_confirmed": True}, "saw_busy": True,
            "poll_codes": ["60"] * 61, "no_reply_polls": 0,
            "result": {"phase": "done", "code": "00", "code_text": "Bereit", "message": "x" * 120, "answered": True, "elapsed_s": 12.3},
            "latched": {"at": "2026-10-20T09:07:31.123456Z", "freshness": "busy_seen", "measured_length_dots": 600,
                        "measured_gap_dots": 36, "measured_pitch_dots": 636, "stored_q_after": "50,3", "q_changed": True, "qd_changed": True},
            "writes_since_sense": [{"kind": "pattern", "at": "2026-10-20T09:08:30.123456Z", "q": "50,3"}] * 21,
        }),
        verify={"material_id": "wago-210-812", "at": "2026-10-20T09:08:41.123456Z", "verdict": "match", "freshness": "busy_seen",
                "fresh": True, "from_latch": True, "measured_length_dots": 600, "measured_gap_dots": 36, "measured_pitch_dots": 636,
                "stored_q_after": "50,3", "status_code": "00", "sensor_kind": "see_through", "sensor_line": "S" * 80,
                "sensor_ok": True, "firmware": "F" * 60, "row_offset_dots": -19},
    )
    return json.dumps(session.to_blob(), ensure_ascii=False)


def test_value_column_is_text() -> None:
    assert isinstance(AppSetting.__table__.c.value.type, Text)


def test_worst_case_blobs_fit_the_budget_and_round_trip() -> None:
    blobs = {
        WERKSTATT_LABEL_PRINTER_STATE_KEY: _worst_state(),
        WERKSTATT_LABEL_PRINTER_KEY: _worst_config(),
        WERKSTATT_LABEL_PRINTER_LOCK_KEY: _worst_lock(),
    }
    # The reason for the migration: VARCHAR(2048) would refuse these.
    assert len(blobs[WERKSTATT_LABEL_PRINTER_STATE_KEY]) > 2048
    assert len(blobs[WERKSTATT_LABEL_PRINTER_KEY]) > 2048
    for value in blobs.values():
        assert len(value) < STATE_BLOB_BUDGET
    with SessionLocal() as db:
        for key, value in blobs.items():
            set_runtime_setting(db, key, value)
        db.commit()
    with SessionLocal() as db:
        for key, value in blobs.items():
            assert get_runtime_setting(db, key) == value


def test_session_lists_are_capped() -> None:
    capped = sessions.cap_lists({
        "poll_codes": [str(index) for index in range(70)],
        "writes_since_sense": [{"kind": "apply", "at": str(index), "q": "1,1"} for index in range(25)],
    })
    assert capped["poll_codes"] == [str(index) for index in range(60)]  # the first 60 kept
    assert [write["at"] for write in capped["writes_since_sense"]] == [str(index) for index in range(5, 25)]  # the last 20
