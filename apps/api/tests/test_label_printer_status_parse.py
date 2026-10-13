"""Parsing the printer's STATUS and CONFIG replies.

The CONFIG dump is undocumented beyond the probe of 13.10.2026, which is the
golden fixture here. What must hold: every field of the probe is read, any
garbage reads as "absent" without an exception, the sensor line is
classified (and kept raw when unknown), ``^QD0,0`` is no measurement, and the
warnings fire exactly on their conditions — with no "stored ^W differs"
warning at all (SMPL states ^W in every job).
"""

from __future__ import annotations

from dataclasses import fields
from pathlib import Path

import pytest

from app.services.werkstatt_label_builtins import DEFAULT_MATERIALS
from app.services.werkstatt_label_printer_status import (
    PrinterConfig,
    config_warnings,
    error_warnings,
    parse_config,
    parse_status,
    status_action,
    status_text,
)
from app.services.werkstatt_label_transport import _parse, PrinterQuery

FIXTURE = Path(__file__).parent / "fixtures" / "ezpl_config_258_5101.txt"
M = {m.id: m for m in DEFAULT_MATERIALS}


def _probe_text() -> str:
    reply = _parse(FIXTURE.read_bytes(), PrinterQuery.CONFIG, final=True)
    assert reply.complete
    return reply.text


def test_golden_probe_reply() -> None:
    config = parse_config(_probe_text(), True)
    assert config.complete is True
    assert config.firmware == "Smart Printer V5.UW0m"
    assert config.sensor_kind == "see_through"
    assert config.sensor_line == "See.:0.1 1.7 1.0 [1.6_58]"
    assert (config.measured_length_dots, config.measured_gap_dots, config.measured_pitch_dots) == (1164, 30, 1194)
    assert config.stored_q == "97,2"
    assert config.width_mm == 34
    assert config.darkness == 12
    assert config.speed_ips == 2
    assert config.stop_mm == 0
    assert config.row_offset_dots == -19
    assert config.left_margin_dots == 0
    assert config.print_mode == "thermal_transfer"
    assert config.resolution_dpi == 300


@pytest.mark.parametrize("text", ["", "garbage\n\x00\x01 nothing here", "^S ^H ~Q\n^W ^Q ^E\n^QDx,y"])
def test_garbage_reads_as_absent(text: str) -> None:
    config = parse_config(text, False)
    for item in fields(PrinterConfig):
        if item.name in ("complete", "sensor_kind", "firmware", "sensor_line"):
            continue
        assert getattr(config, item.name) is None, item.name
    assert config.sensor_kind == "unknown"


def test_truncated_reply_keeps_what_arrived() -> None:
    text = "\n".join(_probe_text().split("\n")[:24])  # cut before the sensor line
    config = parse_config(text, False)
    assert config.complete is False
    assert config.stored_q == "97,2"
    assert config.sensor_kind == "unknown"
    assert config.measured_length_dots is None


def test_reflective_and_unknown_sensor_lines() -> None:
    reflective = parse_config(_probe_text().replace("See.:0.1 1.7 1.0 [1.6_58]", "Reflective Volt:2.4 3.1 3.9(1.4_1.1)"), True)
    assert reflective.sensor_kind == "reflective"
    assert reflective.sensor_line.startswith("Reflective")
    unknown = parse_config(_probe_text().replace("See.:0.1 1.7 1.0 [1.6_58]", "Gap Sensor AD : 129 162 195"), True)
    assert unknown.sensor_kind == "unknown"
    assert unknown.sensor_line == "Gap Sensor AD : 129 162 195"


def test_qd_zero_is_no_measurement() -> None:
    text = _probe_text().replace("^QD1164,30  ^Q97.0,2.5", "^QD0,0  ^Q0.0,0.0").replace("Label+Gap = 1194 Dots", "Label+Gap = 0 Dots")
    config = parse_config(text, True)
    assert config.measured_length_dots is None
    assert config.measured_gap_dots is None
    assert config.measured_pitch_dots is None


def test_mark_stock_q_is_normalised() -> None:
    config = parse_config(_probe_text().replace("^W34 ^Q97,2 ^E0", "^W40 ^Q25,4,3+ ^E0"), True)
    assert config.stored_q == "25,4,3+"


def test_status_line() -> None:
    assert parse_status("ERROR02\n00,00000") == ("00", 0)
    assert parse_status("60,00002\n") == ("60", 2)
    assert parse_status("") == (None, None)
    assert parse_status("hello") == (None, None)


def test_status_texts() -> None:
    assert status_text("00") == "Bereit"
    assert status_text("04") == "Druckkopf offen"
    assert status_action("04") == "Deckel schließen"
    assert status_text("99") == "Unbekannter Status 99"
    assert status_text(None) == "Drucker antwortet nicht auf Abfragen"


def test_warnings() -> None:
    probe = parse_config(_probe_text(), True)
    drift = config_warnings(probe, profile=M["wago-210-804"], pinned_row_offset=-10, reply_text="x")
    assert [w.code for w in drift] == ["row_offset_drift"]
    assert drift[0].message.startswith("Zeilenversatz am Drucker (-19 Punkte) weicht vom Bezugswert (-10) ab")
    assert config_warnings(probe, profile=M["wago-210-804"], pinned_row_offset=-19, reply_text="x") == []

    direct = parse_config(_probe_text().replace("^AT", "^AD"), True)
    assert [w.code for w in config_warnings(direct, profile=None, pinned_row_offset=None, reply_text="x")] == ["direct_thermal"]

    incomplete = parse_config(_probe_text(), False)
    assert [w.code for w in config_warnings(incomplete, profile=None, pinned_row_offset=None, reply_text="x")] == ["incomplete_reply"]

    dpi = parse_config(_probe_text().replace("300 Dpi", "203 Dpi"), True)
    warnings = config_warnings(dpi, profile=None, pinned_row_offset=None, reply_text="x")
    assert [w.message for w in warnings] == ["Drucker meldet 203 dpi – SMPL rechnet mit 300 dpi."]

    reflective = parse_config(_probe_text().replace("See.:0.1 1.7 1.0 [1.6_58]", "Reflective Volt:2.4"), True)
    mismatch = config_warnings(reflective, profile=M["wago-210-804"], pinned_row_offset=None, reply_text="x")
    assert [w.message for w in mismatch] == ["Drucker nutzt den Reflex-Sensor, „Typenschilder 99 × 44 (silber)“ erwartet Durchlicht."]

    assert [w.message for w in error_warnings(("ERROR02", "ERROR02"))] == ["Drucker meldete ERROR02."]


def test_no_stored_width_warning_exists() -> None:
    probe = parse_config(_probe_text(), True)  # stored ^W34, the 210-804 profile says 44
    codes = {w.code for w in config_warnings(probe, profile=M["wago-210-804"], pinned_row_offset=None, reply_text="x")}
    assert codes == set()
