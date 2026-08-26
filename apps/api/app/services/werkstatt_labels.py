"""Werkstatt machine labels — Godex EZPL over raw TCP ("port 9100").

The workshop's label printer is a WAGO Smart Printer 258-5101. Despite the
first-generation smartPRINTER (258-5000) being a cab OEM, this generation is a
**Godex** OEM (telnet banner "GoDEX TELNET Server", WAGO firmware V5.UW0m) and
speaks Godex's EZPL: line-oriented commands, `^L` … `E` label blocks, one
socket write per batch, no driver or spooler involved. Jobs in any other
printer language are swallowed silently — that is the failure mode, not an
error message.

WHAT gets rendered depends on the loaded material (see
:mod:`werkstatt_label_materials`): the active profile decides sheet geometry
(`^W`/`^Q`), heat, and the layout *tier* — voll (logo, footer, serial),
kompakt (DataMatrix + number + name), mini (number only; a DataMatrix under
~6 mm cannot be scanned, and hand-typing the number is a designed-in fallback
of the scan cascade). Continuous stock computes its per-label length from
content. The 4-way split with dashed scissor lines exists only on voll stock —
smaller die-cut material IS the small label.

Layouts are designed in a "reading frame" (x right along the feed, y down
across the head, 1 px = 1 dot at 12 dots/mm) and converted per sheet:

    x_machine = sheet_height - y_reading      (validated by physical prints)
    y_machine = x_reading + x_offset

`x_offset` compensates the print origin sitting ~2 mm before the label's
physical left edge (measured on the first quad proof; per-profile tunable).

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
from itertools import combinations
from functools import lru_cache

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.services.werkstatt_label_materials import (
    TIER_KOMPAKT,
    TIER_VOLL,
    MaterialProfile,
    active_material,
    get_label_printer_config,
)

logger = logging.getLogger(__name__)


class LabelPrinterNotConfigured(RuntimeError):
    """No printer address configured — label printing is off for this deployment."""


class LabelPrinterUnreachable(RuntimeError):
    """Connecting or sending to the printer failed; str() is the address."""


class LabelFormatUnsupported(RuntimeError):
    """The requested format does not fit the ACTIVE material; str() is German."""


_SEND_TIMEOUT_SECONDS = 5.0

# EZPL's built-in TrueType command (`AT`) takes UTF-8 when the style field
# carries the "E" flag; M-numbers and DataMatrix content are plain ASCII.
_ENCODING = "utf-8"

_DOTS_PER_MM = 12  # 300 dpi head (WAGO 258-51xx datasheet)

# Deliberately fixed label branding (Luca, 2026-08) — not the runtime company
# setting, so a reworded admin setting cannot silently change tool labels.
_FOOTER_TEXT = "SMPL Energy GmbH · smpl-energy.de"
_SITE_TEXT = "smpl-energy.de"

# Empirical width of the printer's proportional TTF, fraction of height.
_GLYPH_WIDTH_RATIO = 0.58

_MARGIN = 24  # 2 mm breathing room on sheet edges
_MIN_CONTINUOUS_MM = 15  # shorter strips jam the feed

# ── Voll layout (validated on 99 × 44; requires that class of sheet) ───────
_V_DM_X, _V_DM_Y, _V_DM_MODULE = 48, 180, 14
_V_TEXT_X = 264
_V_NUMBER_Y, _V_NUMBER_SIZE = 78, 150
_V_NAME_Y, _V_NAME_MAX, _V_NAME_MIN = 292, 64, 24
_V_SERIAL_Y, _V_SERIAL_SIZE = 380, 52
_V_FOOTER_Y, _V_FOOTER_SIZE = 452, 44

# ── Kompakt ratios (from the physically validated quad quadrant, h = 264) ──
#
# The device name and the site line were doubled at the owner's request: at
# 0.1515/0.106 of a 264 px quadrant they rendered around 27 px, which is
# legible on a bench and not on a drill in a van.
#
# Doubling the SITE line is just a bigger number. Doubling the NAME is not:
# _fit_text_size divides the width budget by the character count, so a 27-char
# name like "Makita Akkustichsäge DJV184" was already being shrunk to fit and
# would simply be shrunk again. The name therefore wraps onto up to two lines —
# halving the characters per line is what buys the height back.
# Three name lines, not two: the longest word group in a typical tool name
# ("Akkustichsäge DJV184") is ~20 chars on two lines, and 20 chars is what caps
# the font size — width binds here, not height. Three lines gets it to ~13.
# The number shrinks to pay for it; it is the least valuable glyph on the label
# because the DataMatrix beside it already encodes exactly that string.
# Sized to sit comfortably inside the quadrant, NOT to fill it. A first pass at
# genuinely doubling everything left only 6 px under the site line; on the two
# lower quadrants that is the physical edge of the sheet, and feed tolerance
# printed the company name off the label. The original layout's ~40 px of
# bottom margin was doing real work. _K_BOTTOM_MARGIN now states it explicitly.
_K_NUMBER_Y, _K_NUMBER_SIZE = 0.050, 0.150
_K_NAME_Y, _K_NAME_MAX = 0.240, 0.160
# The manufacturer's serial. Nineteen battery packs carry the same name and
# look identical on a shelf, so without this the M-number is the only thing
# telling two labels apart — and if the wrong sticker goes on the wrong pack
# nothing downstream looks wrong, it is just quietly incorrect forever.
# Smaller than the name on purpose: it is read once, when matching a label to
# the tool in your hand, not across a van.
_K_SERIAL_Y, _K_SERIAL_SIZE = 0.560, 0.106
_K_SITE_Y, _K_SITE_SIZE = 0.705, 0.135
_K_BOTTOM_MARGIN = 0.14  # of quadrant height — never draw into this
_K_NAME_MIN = 20
_K_NAME_LINES = 2
_K_NAME_LEADING = 1.10

_DASH_ON, _DASH_OFF = 14, 10

# ── Logo (top-right of the voll label) ─────────────────────────────────────
_LOGO_BOX_W, _LOGO_BOX_H = 300, 110
_LOGO_THRESHOLD = 170
_LOGO_READING_Y = 24


@dataclass(frozen=True)
class LabelContent:
    """Everything a label can show about one machine."""

    unit_number: str
    article_name: str | None = None
    manufacturer: str | None = None
    serial_number: str | None = None


@dataclass(frozen=True)
class _Frame:
    """One sheet's reading-frame geometry and its machine-frame conversion."""

    h_px: int  # across the head (reading height)
    w_px: int  # along the feed (reading width)
    x_offset_px: int

    def xm(self, reading_y: int) -> int:
        """Machine x (across the head) for a reading-frame TOP edge."""
        return self.h_px - reading_y

    def ym(self, reading_x: int) -> int:
        """Machine y (feed direction) for a reading-frame LEFT edge."""
        return reading_x + self.x_offset_px


def printer_address(db: Session) -> tuple[str, int] | None:
    """The effective printer as (host, port): runtime setting, then env."""
    config = get_label_printer_config(db)
    if config["host"]:
        return config["host"], config["port"]
    settings = get_settings()
    host = (settings.werkstatt_label_printer_host or "").strip()
    if not host:
        return None
    return host, settings.werkstatt_label_printer_port


def printer_address_source(db: Session) -> str:
    """Where the effective address comes from: runtime | env | none."""
    if get_label_printer_config(db)["host"]:
        return "runtime"
    if (get_settings().werkstatt_label_printer_host or "").strip():
        return "env"
    return "none"


# ── Command helpers ────────────────────────────────────────────────────────


def _mm(value: float) -> int:
    return int(round(value))


def _est_text_w(text: str, size: int) -> int:
    return int(_GLYPH_WIDTH_RATIO * size * len(text))


def _wrap_words(text: str, lines: int) -> list[str]:
    """Split on word boundaries into at most `lines`, balancing the parts.

    Balanced, not greedy. Greedy wrapping of "Makita Akkustichsäge DJV184"
    yields a 20-char line and a 6-char stub, and the LONGEST line is what caps
    the font size for every line — so the stub buys nothing. Splitting evenly
    gets the same name to 13 chars a line, which is what actually doubles the
    rendered size.

    Words are never broken: a hyphenated part number split across lines reads
    as two different numbers, which on an asset label is worse than small text.
    """

    words = text.split()
    if lines <= 1 or len(words) < 2:
        return [text]
    lines = min(lines, len(words))

    # Exhaustive over cut positions — a tool name is a handful of words, so the
    # search space is trivial and an optimal split is worth more than cleverness.
    best: list[str] = [text]
    best_cost: int | None = None
    for cuts in combinations(range(1, len(words)), lines - 1):
        parts: list[str] = []
        previous = 0
        for cut in (*cuts, len(words)):
            parts.append(" ".join(words[previous:cut]))
            previous = cut
        cost = max(len(part) for part in parts)
        if best_cost is None or cost < best_cost:
            best, best_cost = parts, cost
    return best


def _fit_text_size(text: str, budget_px: int, max_size: int, min_size: int) -> int:
    if not text:
        return max_size
    fitted = int(budget_px / (_GLYPH_WIDTH_RATIO * len(text)))
    return max(min_size, min(max_size, fitted))


def _at(frame: _Frame, reading_x: int, reading_y: int, size: int, text: str) -> str:
    """One rotated built-in-TTF text command anchored in the reading frame."""
    return f"AT,{frame.xm(reading_y)},{frame.ym(reading_x)},{size},{size},0,1E,0,0,{text}"


def _xrb(frame: _Frame, reading_x: int, reading_y: int, module: int, data: str) -> list[str]:
    """DataMatrix at a reading-frame position; anchor is the reading BOTTOM."""
    symbol = 12 * module  # 12 × 12 symbol for short ASCII payloads
    return [
        f"XRB{frame.xm(reading_y + symbol)},{frame.ym(reading_x)},{module},0,{len(data.encode(_ENCODING))}",
        data,
    ]


def _sheet(
    profile: MaterialProfile,
    lines: list[str],
    *,
    length_mm: float | None = None,
    copies: int = 1,
) -> list[str]:
    """Wrap element lines into one complete job for this material."""
    if profile.continuous:
        assert length_mm is not None, "continuous sheets must compute a length"
        head = [f"^Q{_mm(max(length_mm, _MIN_CONTINUOUS_MM))},0"]
    else:
        head = [f"^Q{_mm(profile.length_mm)},{_mm(profile.gap_mm)}"]
    head.append(f"^W{_mm(profile.width_mm)}")
    if profile.darkness is not None:
        head.append(f"^H{profile.darkness}")
    if copies > 1:
        head.append(f"^C{copies}")
    return [*head, "^L", *lines, "E"]


def _frame(profile: MaterialProfile, *, w_px: int | None = None) -> _Frame:
    return _Frame(
        h_px=_mm(profile.width_mm) * _DOTS_PER_MM,
        w_px=w_px if w_px is not None else _mm(profile.length_mm or 0) * _DOTS_PER_MM,
        x_offset_px=int(round(profile.x_offset_mm * _DOTS_PER_MM)),
    )


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


def _logo_placement_lines(frame: _Frame) -> list[str]:
    asset = _logo_asset()
    if asset is None:
        return []
    name, _, reading_w, reading_h = asset
    reading_x = frame.w_px - _MARGIN - reading_w
    return [f"Y{frame.xm(_LOGO_READING_Y + reading_h)},{frame.ym(reading_x)},{name}"]


# ── Renderers ──────────────────────────────────────────────────────────────


def _render_voll(profile: MaterialProfile, content: LabelContent) -> list[str]:
    """The full machine label — logo, footer, serial. Voll-tier stock only."""
    frame = _frame(profile)
    number = _clean(content.unit_number, 20)
    name = _clean(" ".join(p for p in (content.article_name, content.manufacturer) if p), 60)
    serial = _clean(content.serial_number or "", 30)

    lines = _xrb(frame, _V_DM_X, _V_DM_Y, _V_DM_MODULE, number)
    lines.append(_at(frame, _V_TEXT_X, _V_NUMBER_Y, _V_NUMBER_SIZE, number))
    if name:
        budget = frame.w_px - _V_TEXT_X - _MARGIN
        size = _fit_text_size(name, budget, _V_NAME_MAX, _V_NAME_MIN)
        lines.append(_at(frame, _V_TEXT_X, _V_NAME_Y, size, name))
    if serial:
        lines.append(_at(frame, _V_TEXT_X, _V_SERIAL_Y, _V_SERIAL_SIZE, f"SN: {serial}"))
    lines.append(_at(frame, _V_TEXT_X, _V_FOOTER_Y, _V_FOOTER_SIZE, _FOOTER_TEXT))
    lines.extend(_logo_placement_lines(frame))
    return _sheet(profile, lines)


def _compact_block(
    frame: _Frame,
    origin_x: int,
    origin_y: int,
    block_w: int,
    block_h: int,
    content: LabelContent,
) -> list[str]:
    """One kompakt label block: DataMatrix + number + name + site line.

    Used verbatim by quad quadrants (the physically validated layout) and by
    whole kompakt sheets — one recipe, so a fix lands everywhere.
    """
    number = _clean(content.unit_number, 20)
    name = _clean(" ".join(p for p in (content.article_name, content.manufacturer) if p), 40)

    module = max(6, min(9, (block_h - 48) // 12))
    symbol = 12 * module
    dm_y = origin_y + (block_h - symbol) // 2
    text_x = origin_x + _MARGIN + symbol + 20

    lines = _xrb(frame, origin_x + _MARGIN, dm_y, module, number)
    lines.append(
        _at(
            frame,
            text_x,
            origin_y + round(block_h * _K_NUMBER_Y),
            round(block_h * _K_NUMBER_SIZE),
            number,
        )
    )
    if name:
        budget = origin_x + block_w - text_x - 16
        ceiling = round(block_h * _K_NAME_MAX)
        # Size on the LONGEST wrapped line — the widest line is what has to fit.
        name_lines = _wrap_words(name, _K_NAME_LINES)
        size = _fit_text_size(max(name_lines, key=len), budget, ceiling, _K_NAME_MIN)
        # A single line that already fits at full size needs no wrap.
        if len(name_lines) > 1 and _fit_text_size(name, budget, ceiling, _K_NAME_MIN) >= size:
            name_lines = [name]
            size = _fit_text_size(name, budget, ceiling, _K_NAME_MIN)
        step = round(size * _K_NAME_LEADING)
        top = origin_y + round(block_h * _K_NAME_Y)
        for index, chunk in enumerate(name_lines):
            lines.append(_at(frame, text_x, top + index * step, size, chunk))
    serial = _clean(content.serial_number or "", 24)
    if serial and block_h >= 240:
        lines.append(
            _at(
                frame,
                text_x,
                origin_y + round(block_h * _K_SERIAL_Y),
                round(block_h * _K_SERIAL_SIZE),
                f"SN {serial}",
            )
        )
    if block_h >= 240:  # the site line needs ≥ 20 mm of height to stay legible
        lines.append(
            _at(
                frame,
                text_x,
                origin_y + round(block_h * _K_SITE_Y),
                round(block_h * _K_SITE_SIZE),
                _SITE_TEXT,
            )
        )
    return lines


def _render_kompakt(profile: MaterialProfile, content: LabelContent) -> list[str]:
    """One kompakt label as its own sheet (die-cut or continuous)."""
    h_px = _mm(profile.width_mm) * _DOTS_PER_MM
    if profile.continuous:
        number = _clean(content.unit_number, 20)
        name = _clean(" ".join(p for p in (content.article_name, content.manufacturer) if p), 40)
        module = max(6, min(9, (h_px - 48) // 12))
        widest = max(
            _est_text_w(number, round(h_px * _K_NUMBER_SIZE)),
            _est_text_w(max(_wrap_words(name, _K_NAME_LINES), key=len), round(h_px * _K_NAME_MAX)),
            _est_text_w(_SITE_TEXT, round(h_px * _K_SITE_SIZE)) if h_px >= 240 else 0,
        )
        w_px = _MARGIN + 12 * module + 20 + widest + _MARGIN
        frame = _frame(profile, w_px=w_px)
        lines = _compact_block(frame, 0, 0, w_px, h_px, content)
        return _sheet(profile, lines, length_mm=w_px / _DOTS_PER_MM)
    frame = _frame(profile)
    lines = _compact_block(frame, 0, 0, frame.w_px, frame.h_px, content)
    return _sheet(profile, lines)


def _render_mini(profile: MaterialProfile, text: str, *, copies: int = 1) -> list[str]:
    """Number/text only, centered — for stock too small for anything more."""
    cleaned = _clean(text, 40) or "?"
    h_px = _mm(profile.width_mm) * _DOTS_PER_MM

    if profile.continuous:
        size = max(16, min(h_px - 12, int(h_px * 0.72)))
        w_px = max(_MARGIN + _est_text_w(cleaned, size) + _MARGIN, _MIN_CONTINUOUS_MM * 12)
        frame = _frame(profile, w_px=w_px)
        lines = [_at(frame, _MARGIN, (h_px - size) // 2, size, cleaned)]
        return _sheet(profile, lines, length_mm=w_px / _DOTS_PER_MM, copies=copies)

    frame = _frame(profile)
    budget = frame.w_px - 2 * 12  # 1 mm side margins — mini stock is tiny
    size = max(16, min(h_px - 12, int(budget / (_GLYPH_WIDTH_RATIO * len(cleaned)))))
    reading_x = max(12, (frame.w_px - _est_text_w(cleaned, size)) // 2)
    lines = [_at(frame, reading_x, (h_px - size) // 2, size, cleaned)]
    return _sheet(profile, lines, copies=copies)


def _dashes(
    frame: _Frame, fixed_reading_axis: str, fixed_at: int, start: int, stop: int
) -> list[str]:
    """Dashed scissor line as short `Lo` segments, 2 dots thick."""
    out: list[str] = []
    pos = start
    while pos < stop:
        seg_end = min(pos + _DASH_ON, stop)
        if fixed_reading_axis == "x":  # vertical cut in reading frame
            out.append(
                f"Lo,{frame.xm(seg_end)},{frame.ym(fixed_at) - 1},{frame.xm(pos)},{frame.ym(fixed_at) + 1}"
            )
        else:  # horizontal cut in reading frame
            out.append(
                f"Lo,{frame.xm(fixed_at) - 1},{frame.ym(pos)},{frame.xm(fixed_at) + 1},{frame.ym(seg_end)}"
            )
        pos += _DASH_ON + _DASH_OFF
    return out


def _render_quad(profile: MaterialProfile, entries: list[LabelContent]) -> list[str]:
    """Up to four DIFFERENT mini labels on one voll sheet, with cut lines."""
    if not 1 <= len(entries) <= 4:
        raise ValueError("quad sheet takes 1..4 entries")
    frame = _frame(profile)
    half_w, half_h = frame.w_px // 2, frame.h_px // 2
    origins = [(0, 0), (half_w, 0), (0, half_h), (half_w, half_h)]
    lines: list[str] = []
    for (qx, qy), content in zip(origins, entries):
        lines += _compact_block(frame, qx, qy, half_w, half_h, content)
    lines += _dashes(frame, "x", half_w, 12, frame.h_px - 12)
    lines += _dashes(frame, "y", half_h, 12, frame.w_px - frame.x_offset_px - 12)
    return _sheet(profile, lines)


# ── Shipping ───────────────────────────────────────────────────────────────


def _klein_jobs(profile: MaterialProfile, entries: list[LabelContent]) -> list[list[str]]:
    """Klein entries → sheets for the active material.

    Voll stock packs four per sheet with scissor lines; smaller die-cut and
    continuous stock IS the small label, so it prints one per sheet.
    """
    if profile.tier == TIER_VOLL:
        return [
            _render_quad(profile, entries[start : start + 4])
            for start in range(0, len(entries), 4)
        ]
    if profile.tier == TIER_KOMPAKT:
        return [_render_kompakt(profile, content) for content in entries]
    return [_render_mini(profile, content.unit_number) for content in entries]


def print_machine_label(db: Session, content: LabelContent) -> str:
    """Render and ship one voll label; returns the "host:port" used."""
    sheets, printer = print_label_jobs(db, gross=[content], klein=[])
    assert sheets == 1
    return printer


def print_label_jobs(
    db: Session, *, gross: list[LabelContent], klein: list[LabelContent]
) -> tuple[int, str]:
    """Ship a batch in ONE connection; returns (sheets_printed, "host:port").

    `gross` needs voll-tier stock — refusing beats silently printing a
    clipped nameplate on a 15 × 6 label.
    """
    if not gross and not klein:
        raise ValueError("nothing to print")
    profile = active_material(db)
    if gross and profile.tier != TIER_VOLL:
        raise LabelFormatUnsupported(
            "Vollformat braucht ein großes Etikett (z. B. WAGO 210-804/-824) — "
            f"aktiv ist „{profile.name}“"
        )

    jobs: list[list[str]] = [_render_voll(profile, content) for content in gross]
    jobs += _klein_jobs(profile, klein)
    payload = _logo_download_preamble() if gross else b""
    for job in jobs:
        payload += ("\r\n".join(job) + "\r\n").encode(_ENCODING)
    printer = _ship(db, payload)
    logger.info("Label batch sent to %s — %d sheet(s), %d bytes", printer, len(jobs), len(payload))
    return len(jobs), printer


def print_freetext(db: Session, *, text: str, copies: int = 1) -> str:
    """Free text on the active material — marking strips, shrink tube, labels."""
    profile = active_material(db)
    # Free text has no number to pair a DataMatrix with, so every tier gets
    # the centered single-line treatment; continuous stock computes length.
    job = _render_mini(profile, text, copies=copies)
    payload = ("\r\n".join(job) + "\r\n").encode(_ENCODING)
    printer = _ship(db, payload)
    logger.info("Freetext label sent to %s (%d copies)", printer, copies)
    return printer


def print_test_label(db: Session) -> str:
    """Admin "Testdruck", adapted to the ACTIVE material's tier."""
    profile = active_material(db)
    sample = LabelContent(
        unit_number="M-TEST",
        article_name="Etikettendrucker-Test äöüß",
        manufacturer=None,
        serial_number=None,
    )
    if profile.tier == TIER_VOLL:
        return print_machine_label(db, sample)
    if profile.tier == TIER_KOMPAKT:
        job = _render_kompakt(profile, sample)
    else:
        job = _render_mini(profile, "M-TEST")
    payload = ("\r\n".join(job) + "\r\n").encode(_ENCODING)
    return _ship(db, payload)


def _ship(db: Session, payload: bytes) -> str:
    address = printer_address(db)
    if address is None:
        raise LabelPrinterNotConfigured()
    host, port = address
    try:
        _send_tcp(host, port, payload)
    except OSError as exc:
        logger.warning("Label job to %s:%s failed: %s", host, port, exc)
        raise LabelPrinterUnreachable(f"{host}:{port}") from exc
    return f"{host}:{port}"


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
