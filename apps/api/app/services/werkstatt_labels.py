"""Werkstatt machine labels — Godex EZPL over raw TCP ("port 9100").

The workshop's label printer is a WAGO Smart Printer 258-5101. Despite the
first-generation smartPRINTER (258-5000) being a cab OEM, this generation is a
**Godex** OEM (telnet banner "GoDEX TELNET Server", WAGO firmware V5.UW0m) and
speaks Godex's EZPL: line-oriented commands, `^L` … `E` label blocks, one
socket write per sheet, no driver or spooler involved. Jobs in any other
printer language are swallowed silently — that is the failure mode, not an
error message.

The printer address resolves runtime-first: the admin-editable setting
(`werkstatt_label_printer` in the AppSetting store) wins over the
`WERKSTATT_LABEL_PRINTER_HOST`/`_PORT` env fallback. An unset address means
the feature is off, which callers surface as a clear 503 rather than a
timeout.

Geometry: WAGO 210-804 stock (99 × 44 mm silver polyester type labels). The
print head is only 47 mm wide at 300 dpi (12 dots/mm), so the label feeds with
its SHORT side across the head: `^W44`, `^Q99`. Layouts are designed in a
"reading frame" (x right along 99 mm, y down along 44 mm, 1 px = 1 dot) and
converted to the machine frame via

    x_machine = 528 - y_reading          (validated by physical prints)
    y_machine = x_reading + _X_OFFSET

`_X_OFFSET` compensates the print origin sitting ~2 mm before the label's
physical left edge (measured on the first quad proof).

Two formats exist: the full-sheet machine label (DataMatrix, number, name,
serial, company footer, logo) and the quad sheet — four ≈49 × 22 mm mini
labels with dashed scissor lines, each quadrant its own machine.

The logo is downloaded into printer flash once via `~EB` under a
content-hashed name, so replacing the logo asset re-uploads automatically; a
duplicate download is rejected by the firmware, which is harmless because the
name guarantees identical content.

Every interpolated value is stripped of control characters: EZPL is
line-oriented, so a newline inside an article name would otherwise terminate
the text command and let the remainder run as printer commands. The DataMatrix
data is additionally length-prefixed by the protocol itself.
"""

from __future__ import annotations

import io
import logging
import socket
import zlib
from dataclasses import dataclass
from functools import lru_cache

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.services.runtime_settings import get_label_printer_settings

logger = logging.getLogger(__name__)


class LabelPrinterNotConfigured(RuntimeError):
    """No printer address configured — label printing is off for this deployment."""


class LabelPrinterUnreachable(RuntimeError):
    """Connecting or sending to the printer failed; str() is the address."""


_SEND_TIMEOUT_SECONDS = 5.0

# EZPL's built-in TrueType command (`AT`) takes UTF-8 when the style field
# carries the "E" flag; M-numbers and DataMatrix content are plain ASCII.
_ENCODING = "utf-8"

_DOTS_PER_MM = 12  # 300 dpi head (WAGO 258-51xx datasheet)

# WAGO 210-804: 99 × 44 mm type labels, ~3 mm die-cut gap, short side across
# the head. Reading-frame canvas is therefore 1188 × 528 dots.
_LABEL_WIDTH_MM = 44
_LABEL_LENGTH_MM = 99
_LABEL_GAP_MM = 3
_SHEET_W = _LABEL_LENGTH_MM * _DOTS_PER_MM  # 1188, reading x
_SHEET_H = _LABEL_WIDTH_MM * _DOTS_PER_MM  # 528, reading y

# Print origin sits ~2 mm before the label's physical left edge.
_X_OFFSET = 24

# Deliberately fixed label branding (Luca, 2026-08) — not the runtime company
# setting, so a reworded admin setting cannot silently change tool labels.
_FOOTER_TEXT = "SMPL Energy GmbH · smpl-energy.de"

# ── Full-sheet layout (reading frame, dots) ────────────────────────────────
_DM_X, _DM_Y, _DM_MODULE = 48, 180, 14
_TEXT_X = 264
_NUMBER_Y, _NUMBER_SIZE = 78, 150
_NAME_Y, _NAME_MAX_SIZE, _NAME_MIN_SIZE = 292, 64, 24
_SERIAL_Y, _SERIAL_SIZE = 380, 52
_FOOTER_Y, _FOOTER_SIZE = 452, 44
_RIGHT_MARGIN = 24
# Empirical width of the printer's proportional TTF, as a fraction of height.
_GLYPH_WIDTH_RATIO = 0.58

# ── Quad layout (four ≈49 × 22 mm mini labels) ─────────────────────────────
_QUAD_HALF_W, _QUAD_HALF_H = _SHEET_W // 2, _SHEET_H // 2  # 594 × 264
_QUAD_DM_MODULE = 9  # 12 × 9 = 108 dots ≈ 9 mm symbol
_QUAD_TEXT_X = 152
_QUAD_NUMBER_Y, _QUAD_NUMBER_SIZE = 46, 74
_QUAD_NAME_Y, _QUAD_NAME_MAX_SIZE = 142, 40
_QUAD_SITE_Y, _QUAD_SITE_SIZE = 196, 28
_QUAD_SITE_TEXT = "smpl-energy.de"
_DASH_ON, _DASH_OFF = 14, 10

# ── Logo (top-right of the full-sheet label) ───────────────────────────────
_LOGO_BOX_W, _LOGO_BOX_H = 300, 110  # 25 × 9.2 mm
_LOGO_THRESHOLD = 170
_LOGO_READING_Y = 24


@dataclass(frozen=True)
class LabelContent:
    """Everything a label can show about one machine."""

    unit_number: str
    article_name: str | None = None
    manufacturer: str | None = None
    serial_number: str | None = None


def printer_address(db: Session) -> tuple[str, int] | None:
    """The effective printer as (host, port): runtime setting, then env."""
    runtime = get_label_printer_settings(db)
    if runtime:
        return runtime["host"], runtime["port"]
    settings = get_settings()
    host = (settings.werkstatt_label_printer_host or "").strip()
    if not host:
        return None
    return host, settings.werkstatt_label_printer_port


def printer_address_source(db: Session) -> str:
    """Where the effective address comes from: runtime | env | none."""
    if get_label_printer_settings(db):
        return "runtime"
    if (get_settings().werkstatt_label_printer_host or "").strip():
        return "env"
    return "none"


# ── Frame conversion ───────────────────────────────────────────────────────


def _xm(reading_y: int) -> int:
    """Machine x (across the head) for a reading-frame TOP edge."""
    return _SHEET_H - reading_y


def _ym(reading_x: int) -> int:
    """Machine y (feed direction) for a reading-frame LEFT edge."""
    return reading_x + _X_OFFSET


def _fit_text_size(text: str, budget_px: int, max_size: int, min_size: int) -> int:
    """Shrink a text height until its estimated width fits the budget."""
    if not text:
        return max_size
    fitted = int(budget_px / (_GLYPH_WIDTH_RATIO * len(text)))
    return max(min_size, min(max_size, fitted))


def _at(reading_x: int, reading_y: int, size: int, text: str, bold_utf8: str = "1E") -> str:
    """One rotated built-in-TTF text command anchored in the reading frame."""
    return f"AT,{_xm(reading_y)},{_ym(reading_x)},{size},{size},0,{bold_utf8},0,0,{text}"


def _xrb(reading_x: int, reading_y: int, module: int, data: str) -> list[str]:
    """DataMatrix at a reading-frame position; anchor is the reading BOTTOM."""
    symbol = 12 * module  # 12 × 12 symbol for short ASCII payloads
    return [
        f"XRB{_xm(reading_y + symbol)},{_ym(reading_x)},{module},0,{len(data.encode(_ENCODING))}",
        data,
    ]


# ── Logo pipeline ──────────────────────────────────────────────────────────


@lru_cache(maxsize=1)
def _logo_asset() -> tuple[str, bytes, int, int] | None:
    """(printer_file_name, mono_bmp_bytes, reading_w, reading_h) or None.

    The BMP is drawn in the MACHINE frame (ROTATE_270 maps reading → machine,
    matching the text rotation validated on the physical prints) because the
    `Y` placement command has no rotation parameter. Content-hashed name:
    replacing logo.jpeg yields a new name, and the printer's one-time `~EB`
    download picks it up automatically; re-sending an existing name is
    rejected by the firmware, which is fine — same name means same bytes.
    """
    from PIL import Image

    path = (get_settings().report_logo_path or "").strip()
    try:
        img = Image.open(path).convert("L")
    except (OSError, ValueError):
        logger.warning("Label logo unavailable at %r — printing without it", path)
        return None

    mono = img.point(lambda v: 0 if v < _LOGO_THRESHOLD else 255, mode="L")
    bbox = mono.point(lambda v: 255 - v).getbbox()
    if bbox:
        mono = mono.crop(bbox)
    scale = min(_LOGO_BOX_W / mono.width, _LOGO_BOX_H / mono.height)
    reading_w = max(1, round(mono.width * scale))
    reading_h = max(1, round(mono.height * scale))
    mono = (
        mono.resize((reading_w, reading_h), Image.LANCZOS)
        .point(lambda v: 0 if v < 128 else 255, mode="L")
        .transpose(Image.Transpose.ROTATE_270)
        .convert("1")
    )
    buf = io.BytesIO()
    mono.save(buf, format="BMP")
    bmp = buf.getvalue()
    name = f"SMPL{zlib.crc32(bmp) & 0xFFFFFFFF:08X}"
    return name, bmp, reading_w, reading_h


def _logo_download_preamble() -> bytes:
    asset = _logo_asset()
    if asset is None:
        return b""
    name, bmp, _, _ = asset
    return f"~EB,{name},{len(bmp)}\r\n".encode(_ENCODING) + bmp + b"\r\n"


def _logo_placement_lines() -> list[str]:
    asset = _logo_asset()
    if asset is None:
        return []
    name, _, reading_w, reading_h = asset
    reading_x = _SHEET_W - _RIGHT_MARGIN - reading_w
    return [f"Y{_xm(_LOGO_READING_Y + reading_h)},{_ym(reading_x)},{name}"]


# ── Renderers ──────────────────────────────────────────────────────────────


def _sheet(lines: list[str]) -> list[str]:
    return [f"^Q{_LABEL_LENGTH_MM},{_LABEL_GAP_MM}", f"^W{_LABEL_WIDTH_MM}", "^L", *lines, "E"]


def render_machine_label(content: LabelContent) -> list[str]:
    """Command lines for one full-sheet machine label (without the preamble)."""
    number = _clean(content.unit_number, 20)
    name = _clean(
        " ".join(p for p in (content.article_name, content.manufacturer) if p), 60
    )
    serial = _clean(content.serial_number or "", 30)

    lines = _xrb(_DM_X, _DM_Y, _DM_MODULE, number)
    lines.append(_at(_TEXT_X, _NUMBER_Y, _NUMBER_SIZE, number))
    if name:
        budget = _SHEET_W - _TEXT_X - _RIGHT_MARGIN
        size = _fit_text_size(name, budget, _NAME_MAX_SIZE, _NAME_MIN_SIZE)
        lines.append(_at(_TEXT_X, _NAME_Y, size, name))
    if serial:
        lines.append(_at(_TEXT_X, _SERIAL_Y, _SERIAL_SIZE, f"SN: {serial}", bold_utf8="1E"))
    lines.append(_at(_TEXT_X, _FOOTER_Y, _FOOTER_SIZE, _FOOTER_TEXT))
    lines.extend(_logo_placement_lines())
    return _sheet(lines)


def _dashes(fixed_reading_axis: str, fixed_at: int, start: int, stop: int) -> list[str]:
    """Dashed scissor line as short `Lo` segments, 2 dots thick."""
    out: list[str] = []
    pos = start
    while pos < stop:
        seg_end = min(pos + _DASH_ON, stop)
        if fixed_reading_axis == "x":  # vertical cut in reading frame
            out.append(f"Lo,{_xm(seg_end)},{_ym(fixed_at) - 1},{_xm(pos)},{_ym(fixed_at) + 1}")
        else:  # horizontal cut in reading frame
            out.append(f"Lo,{_xm(fixed_at) - 1},{_ym(pos)},{_xm(fixed_at) + 1},{_ym(seg_end)}")
        pos += _DASH_ON + _DASH_OFF
    return out


def render_quad_sheet(entries: list[LabelContent]) -> list[str]:
    """Command lines for one quad sheet: up to four DIFFERENT mini labels.

    Quadrant order is reading order (top-left, top-right, bottom-left,
    bottom-right); missing entries leave their quadrant blank silver.
    """
    if not 1 <= len(entries) <= 4:
        raise ValueError("quad sheet takes 1..4 entries")

    quadrant_origins = [(0, 0), (_QUAD_HALF_W, 0), (0, _QUAD_HALF_H), (_QUAD_HALF_W, _QUAD_HALF_H)]
    lines: list[str] = []
    for (qx, qy), content in zip(quadrant_origins, entries):
        number = _clean(content.unit_number, 20)
        name = _clean(
            " ".join(p for p in (content.article_name, content.manufacturer) if p), 40
        )
        dm_symbol = 12 * _QUAD_DM_MODULE
        dm_y = qy + (_QUAD_HALF_H - dm_symbol) // 2
        lines += _xrb(qx + 24, dm_y, _QUAD_DM_MODULE, number)
        lines.append(_at(qx + _QUAD_TEXT_X, qy + _QUAD_NUMBER_Y, _QUAD_NUMBER_SIZE, number))
        if name:
            budget = qx + _QUAD_HALF_W - (qx + _QUAD_TEXT_X) - 16
            size = _fit_text_size(name, budget, _QUAD_NAME_MAX_SIZE, 20)
            lines.append(_at(qx + _QUAD_TEXT_X, qy + _QUAD_NAME_Y, size, name))
        lines.append(
            _at(qx + _QUAD_TEXT_X, qy + _QUAD_SITE_Y, _QUAD_SITE_SIZE, _QUAD_SITE_TEXT)
        )

    lines += _dashes("x", _QUAD_HALF_W, 12, _SHEET_H - 12)
    lines += _dashes("y", _QUAD_HALF_H, 12, _SHEET_W - _X_OFFSET - 12)
    return _sheet(lines)


# ── Shipping ───────────────────────────────────────────────────────────────


def print_machine_label(db: Session, content: LabelContent) -> str:
    """Render and ship one full-sheet label; returns the "host:port" used."""
    sheets, printer = print_label_jobs(db, gross=[content], klein=[])
    assert sheets == 1
    return printer


def print_label_jobs(
    db: Session, *, gross: list[LabelContent], klein: list[LabelContent]
) -> tuple[int, str]:
    """Ship a batch in ONE connection: each `gross` entry is its own sheet,
    `klein` entries pack four-per-sheet in reading order (the queue's whole
    point: different machines share one physical label).

    Returns (sheets_printed, "host:port").
    """
    if not gross and not klein:
        raise ValueError("nothing to print")
    address = printer_address(db)
    if address is None:
        raise LabelPrinterNotConfigured()
    host, port = address

    jobs: list[list[str]] = [render_machine_label(c) for c in gross]
    for chunk_start in range(0, len(klein), 4):
        jobs.append(render_quad_sheet(klein[chunk_start : chunk_start + 4]))

    payload = b""
    if gross:  # only full-sheet labels carry the logo
        payload += _logo_download_preamble()
    for job in jobs:
        payload += ("\r\n".join(job) + "\r\n").encode(_ENCODING)

    try:
        _send_tcp(host, port, payload)
    except OSError as exc:
        logger.warning("Label batch to %s:%s failed: %s", host, port, exc)
        raise LabelPrinterUnreachable(f"{host}:{port}") from exc

    logger.info(
        "Label batch sent to %s:%s — %d sheet(s), %d bytes", host, port, len(jobs), len(payload)
    )
    return len(jobs), f"{host}:{port}"


def print_test_label(db: Session) -> str:
    """Admin "Testdruck": one full-sheet label with fixed sample content."""
    return print_machine_label(
        db,
        LabelContent(
            unit_number="M-TEST",
            article_name="Etikettendrucker-Test äöüß",
            manufacturer=None,
            serial_number=None,
        ),
    )


def _clean(value: str, max_chars: int) -> str:
    """Collapse a value to one line of printable text.

    Control characters (CR, LF, tabs, DEL, …) become spaces, runs of
    whitespace collapse, and the result is capped — a label field, not prose.
    """
    printable = "".join(ch if ch >= " " and ch != "\x7f" else " " for ch in value)
    return " ".join(printable.split())[:max_chars].strip()


def _send_tcp(host: str, port: int, payload: bytes) -> None:
    with socket.create_connection((host, port), timeout=_SEND_TIMEOUT_SECONDS) as conn:
        conn.sendall(payload)
