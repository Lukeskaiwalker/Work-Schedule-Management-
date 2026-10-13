"""Reading the printer: STATUS codes, the CONFIG dump, and German texts.

Parsing is pure and never raises — every field is optional, because the dump
is undocumented beyond the probe of 13.10.2026 (Appendix A of
docs/LABEL_PRINTER_CALIBRATION.md, the golden fixture). ``read_status`` is
strictly read-only: it never sends a setting, not even
``^XSET,IMMEDIATE,1`` when STATUS stays silent (that may switch on error
pushes for every client, persistence unknown, T10) — a silent printer is
reported as such and the calibration offers the button on the back instead.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from app.services.werkstatt_label_profile import MaterialProfile
from app.services.werkstatt_label_transport import PrinterQuery, QueryReply, query_printer

NO_REPLY_TEXT = "Drucker antwortet nicht auf Abfragen"

STATUS_TEXT_DE: dict[str, str] = {
    "00": "Bereit",
    "01": "Kein Material erkannt",
    "02": "Papierstau oder Spalt nicht gefunden",
    "03": "Farbband leer",
    "04": "Druckkopf offen",
    "05": "Aufwickler voll",
    "06": "Speicher voll",
    "07": "Datei nicht gefunden",
    "08": "Name doppelt",
    "09": "Befehlsfehler",
    "10": "Messer blockiert",
    "11": "Externer Speicher nicht gefunden",
    "20": "Pause",
    "21": "Einstellmodus am Drucker",
    "22": "Tastaturmodus am Drucker",
    "50": "Druckt",
    "60": "Verarbeitet Daten",
}

_CHECK_MEDIA = "Material, Sensorposition und Führungen prüfen"
_LEAVE_MENU = "Menü am Drucker verlassen"
STATUS_ACTION_DE: dict[str, str] = {
    "01": _CHECK_MEDIA,
    "02": _CHECK_MEDIA,
    "03": "Farbband einlegen",
    "04": "Deckel schließen",
    "05": "Aufwickler leeren",
    "06": "Drucker neu starten oder WAGO-Software prüfen",
    "10": "Messer prüfen",
    "20": "Pause am Drucker beenden",
    "21": _LEAVE_MENU,
    "22": _LEAVE_MENU,
    "50": "Bitte warten",
    "60": "Bitte warten",
}

BUSY_CODES = frozenset({"50", "60"})
EXPECTED_DPI = 300
RAW_CONFIG_MAX_CHARS = 8000
SENSOR_LINE_MAX_CHARS = 80
FIRMWARE_MAX_CHARS = 60


def status_text(code: str | None) -> str:
    if code is None:
        return NO_REPLY_TEXT
    return STATUS_TEXT_DE.get(code, f"Unbekannter Status {code}")


def status_action(code: str | None) -> str:
    return STATUS_ACTION_DE.get(code or "", "")


def sensor_word(kind: str | None) -> str:
    return {"see_through": "Durchlicht", "reflective": "Reflex"}.get(kind or "", "unbekannt")


@dataclass(frozen=True)
class PrinterConfig:
    complete: bool
    firmware: str | None = None
    sensor_kind: str = "unknown"
    sensor_line: str | None = None
    measured_length_dots: int | None = None
    measured_gap_dots: int | None = None
    measured_pitch_dots: int | None = None
    stored_q: str | None = None
    width_mm: float | None = None
    darkness: int | None = None
    speed_ips: int | None = None
    stop_mm: int | None = None
    left_margin_dots: int | None = None
    row_offset_dots: int | None = None
    print_mode: str | None = None
    resolution_dpi: int | None = None


@dataclass(frozen=True)
class PrinterWarning:
    code: str
    message: str


@dataclass(frozen=True)
class PrinterStatus:
    printer: str
    answered: bool
    code: str | None
    code_text: str
    action_text: str
    pending: int | None
    config: PrinterConfig | None = None
    raw_config: str | None = None
    warnings: tuple[PrinterWarning, ...] = ()
    errors_seen: tuple[str, ...] = field(default_factory=tuple)

    @property
    def ready(self) -> bool:
        return self.code == "00"


# ── Parsing ────────────────────────────────────────────────────────────────

_STATUS = re.compile(r"^(\d{2}),(\d{5})$", re.ASCII)
_NUM = r"(\d+(?:\.\d+)?)"


def parse_status(text: str) -> tuple[str | None, int | None]:
    for line in (text or "").splitlines():
        match = _STATUS.match(line.strip())
        if match:
            return match.group(1), int(match.group(2))
    return None, None


def _search_int(pattern: str, text: str) -> int | None:
    match = re.search(pattern, text)
    return int(match.group(1)) if match else None


def _number_text(value: str) -> str:
    """"97" / "97.0" → "97"; "2.5" stays "2.5" — the comma separates the
    ``^Q`` arguments, so a decimal must keep its point to stay readable."""
    number = float(value)
    return str(int(number)) if number == int(number) else f"{number:g}"


def _stored_q(line: str) -> str | None:
    match = re.search(rf"\^Q{_NUM},{_NUM}(?:,{_NUM}([+-]))?", line)
    if not match:
        return None
    length, second, third, sign = match.groups()
    if third is not None:
        return f"{_number_text(length)},{_number_text(second)},{_number_text(third)}{sign}"
    return f"{_number_text(length)},{_number_text(second)}"


def parse_config(text: str, complete: bool) -> PrinterConfig:
    lines = [line.strip() for line in (text or "").splitlines()]
    nonempty = [line for line in lines if line]
    values: dict[str, object] = {}
    if nonempty:
        values["firmware"] = nonempty[0][:FIRMWARE_MAX_CHARS]
    for line in lines:
        if "^S" in line and "~Q" in line:
            values["speed_ips"] = _search_int(r"\^S(\d+)", line)
            values["darkness"] = _search_int(r"\^H(\d+)", line)
            values["left_margin_dots"] = _search_int(r"\^R(\d+)", line)
            values["row_offset_dots"] = _search_int(r"~Q([+-]?\d+)", line)
        elif "^W" in line and not line.startswith("^QD"):
            width = re.search(rf"\^W{_NUM}", line)
            values["width_mm"] = float(width.group(1)) if width else None
            values["stored_q"] = _stored_q(line)
            values["stop_mm"] = _search_int(r"\^E(\d+)", line)
        if line.startswith("^QD"):
            match = re.search(r"\^QD(\d+),(\d+)", line)
            if match and (int(match.group(1)), int(match.group(2))) != (0, 0):
                values["measured_length_dots"] = int(match.group(1))
                values["measured_gap_dots"] = int(match.group(2))
        pitch = re.search(r"Label\+Gap\s*=\s*(\d+)\s*Dots", line)
        if pitch:
            values["measured_pitch_dots"] = int(pitch.group(1))
        if line.startswith("See"):
            values["sensor_kind"], values["sensor_line"] = "see_through", line[:SENSOR_LINE_MAX_CHARS]
        elif "Reflect" in line:
            values["sensor_kind"], values["sensor_line"] = "reflective", line[:SENSOR_LINE_MAX_CHARS]
        elif "sensor" in line.lower() and "sensor_line" not in values:
            values["sensor_line"] = line[:SENSOR_LINE_MAX_CHARS]
        mode = re.search(r"\^A([TD])\b", line)
        if mode:
            values["print_mode"] = "thermal_transfer" if mode.group(1) == "T" else "direct_thermal"
        dpi = re.search(r"resolution\s*=\s*(\d+)\s*Dpi", line, re.IGNORECASE)
        if dpi:
            values["resolution_dpi"] = int(dpi.group(1))
    if "measured_length_dots" not in values:
        values.pop("measured_pitch_dots", None)  # a pitch without ^QD is no measurement
    elif "measured_pitch_dots" not in values:
        values["measured_pitch_dots"] = int(values["measured_length_dots"]) + int(values["measured_gap_dots"])
    return PrinterConfig(complete=complete, **values)


# ── Warnings and the read ──────────────────────────────────────────────────


def config_warnings(
    config: PrinterConfig | None,
    *,
    profile: MaterialProfile | None,
    pinned_row_offset: int | None,
    reply_text: str,
) -> list[PrinterWarning]:
    warnings: list[PrinterWarning] = []
    if config is None:
        return warnings
    if pinned_row_offset is not None and config.row_offset_dots is not None and config.row_offset_dots != pinned_row_offset:
        warnings.append(PrinterWarning(
            "row_offset_drift",
            f"Zeilenversatz am Drucker ({config.row_offset_dots} Punkte) weicht vom Bezugswert ({pinned_row_offset}) ab – "
            "ein anderes Programm hat ihn geändert. SMPL-Drucke können in Vorschubrichtung verschoben sein.",
        ))
    if config.print_mode == "direct_thermal":
        warnings.append(PrinterWarning(
            "direct_thermal",
            "Drucker steht auf Thermodirekt – WAGO-Material braucht Thermotransfer mit Farbband.",
        ))
    mismatch = sensor_mismatch(config.sensor_kind, profile)
    if mismatch is not None:
        warnings.append(mismatch)
    if reply_text and not config.complete:
        warnings.append(PrinterWarning("incomplete_reply", "Antwort des Druckers unvollständig – einzelne Werte können fehlen."))
    if config.resolution_dpi is not None and config.resolution_dpi != EXPECTED_DPI:
        warnings.append(PrinterWarning(
            "resolution_unexpected", f"Drucker meldet {config.resolution_dpi} dpi – SMPL rechnet mit 300 dpi."
        ))
    return warnings


def expected_sensor(profile: MaterialProfile | None) -> str | None:
    if profile is None or profile.sensor_mode not in ("see_through", "reflective"):
        return None
    return profile.sensor_mode


def sensor_mismatch(kind: str | None, profile: MaterialProfile | None) -> PrinterWarning | None:
    expected = expected_sensor(profile)
    if expected is None or kind not in ("see_through", "reflective") or kind == expected:
        return None
    return PrinterWarning(
        "sensor_mismatch",
        f"Drucker nutzt den {sensor_word(kind)}-Sensor, „{profile.name}“ erwartet {sensor_word(expected)}.",
    )


def error_warnings(errors: tuple[str, ...]) -> list[PrinterWarning]:
    return [PrinterWarning("error_pushed", f"Drucker meldete {error}.") for error in dict.fromkeys(errors)]


def read_status(db: Session, *, full: bool, profile: MaterialProfile | None = None) -> PrinterStatus:
    """STATUS, and with ``full`` CONFIG — both read-only, under the I/O lock.

    ``profile`` is the material the sensor warning compares against (the
    calibration's session material); default is the active one.
    """
    from app.services import werkstatt_labels as wl
    from app.services.werkstatt_label_materials import get_label_printer_config

    config_values = get_label_printer_config(db)
    if profile is None:
        by_id = {material.id: material for material in config_values["materials"]}
        profile = by_id[config_values["active_material_id"]]
    host, port = wl.printer_address(db) or ("", 0)

    status_reply = query_printer(db, PrinterQuery.STATUS)
    code, pending = parse_status(status_reply.text)
    errors = list(status_reply.errors_seen)
    config: PrinterConfig | None = None
    config_reply: QueryReply | None = None
    if full:
        config_reply = query_printer(db, PrinterQuery.CONFIG)
        errors += config_reply.errors_seen
        if config_reply.text:
            config = parse_config(config_reply.text, config_reply.complete)
    warnings = config_warnings(
        config,
        profile=profile,
        pinned_row_offset=config_values["row_offset_dots"],
        reply_text=config_reply.text if config_reply else "",
    )
    warnings += error_warnings(tuple(errors))
    return PrinterStatus(
        printer=f"{host}:{port}",
        answered=code is not None,
        code=code,
        code_text=status_text(code),
        action_text=status_action(code),
        pending=pending,
        config=config,
        raw_config=(config_reply.text[:RAW_CONFIG_MAX_CHARS] if config_reply and config_reply.text else None),
        warnings=tuple(warnings),
        errors_seen=tuple(dict.fromkeys(errors)),
    )
