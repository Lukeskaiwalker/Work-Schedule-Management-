"""Werkstatt machine labels — GoDEX EZPL over raw TCP ("port 9100").

The workshop's label printer is a WAGO smartPRINTER 258-5101, a **GoDEX**
OEM (telnet banner "GoDEX TELNET Server", WAGO firmware V5.UW0m) that speaks
GoDEX's EZPL: line-oriented commands, `^L` … `E` label blocks, one socket
write per batch, no driver or spooler involved. Jobs in any other printer
language are swallowed silently — that is the failure mode, not an error
message. (Research in 2026-10 found WAGO's own GoDoctor screenshots
identifying the first generation, 258-5000, as a GoDEX RT230i too; the old
note that it was a cab OEM was wrong.)

WHAT gets rendered depends on the loaded material (see
:mod:`werkstatt_label_materials`): the active profile decides sheet geometry
(`^W`/`^Q`), the per-job print values, and the layout *tier* — voll (logo,
footer, serial), kompakt (DataMatrix + number + name), mini (number only; a
DataMatrix under ~6 mm cannot be scanned, and hand-typing the number is a
designed-in fallback of the scan cascade). Continuous stock computes its
per-label length from content. The 4-way split with dashed scissor lines
exists only on voll stock — smaller die-cut material IS the small label.

Every job states its baseline in the header (`^H ^S ^E ^C ^P1`, see
:mod:`werkstatt_label_jobs`) because EZPL settings are permanent and WAGO's
own software changes them too; a copies job ends with a `^C1` reset. The
coordinate guard there keeps every element on the material.

Layouts are designed in a "reading frame" (x right along the feed, y down
across the head, 1 px = 1 dot of the 300 dpi head) and converted per sheet:

    x_machine = sheet_height - y_reading + across_offset   (validated by physical prints)
    y_machine = x_reading + x_offset

`x_offset` compensates the print origin sitting ~2 mm before the label's
physical left edge (measured on the first quad proof; per-profile tunable);
`across_offset` (0 by default) moves the print toward the reading-top edge.

Every position, distance and box is a PHYSICAL millimetre converted with
``mm_to_dots`` (300 / 25,4 dots per mm, rounded once — sums of millimetres
are converted as a sum, so a 12-module strip cannot drift). Font sizes, code
module sizes and line weights are dots. The printer's own millimetre is
dots / 12 (physical test T4, 13.10.2026: a ruler drawn at 12 dots per mm
printed 1,9 % long), so ``^Q``/``^W`` go out through ``printer_mm`` only.

The logo is downloaded into printer flash once via `~EB` under a
content-hashed name, so replacing the logo asset re-uploads automatically; a
duplicate download is rejected by the firmware, which is harmless because the
name guarantees identical content.

Every interpolated value is stripped of control characters and of `~`/`^`:
EZPL is line-oriented, so a newline inside an article name would otherwise
terminate the text command and let the remainder run as printer commands, and
whether `~` acts inside text data is untested (T16). The DataMatrix data is
additionally length-prefixed by the protocol itself.

`_ship` is the only write path: it refuses while another user's calibration
session holds the printer, and it holds the one-connection-at-a-time lock
around exactly one connection.
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
from app.services.werkstatt_label_errors import (  # noqa: F401 — re-exported
    LabelFormatUnsupported,
    LabelLayoutOutOfBounds,
    LabelPrinterBusy,
    LabelPrinterIoBusy,
    LabelPrinterNotConfigured,
    LabelPrinterSessionBusy,
    LabelPrinterUnreachable,
)
# The reading frame and the element helpers moved to werkstatt_label_frame
# (docs/PANEL_ENCLOSURE_R4.md §9); every renderer still reaches them here.
from app.services.werkstatt_label_frame import (  # noqa: F401 — re-exported
    _ENCODING,
    _at,
    _clean,
    _Frame,
    _frame,
    _sheet,
)
from app.services.werkstatt_label_io_lock import printer_io_lock
from app.services.werkstatt_label_materials import (  # noqa: F401 — material_by_id is re-exported
    material_by_id,
    TIER_KOMPAKT,
    TIER_VOLL,
    MaterialProfile,
    active_material,
    get_label_printer_config,
)
from app.services.werkstatt_label_profile import MIN_CONTINUOUS_MM, mm_to_dots
# The marking strips (rail BMK, terminal Block labels) moved the same way.
from app.services.werkstatt_label_strips import (  # noqa: F401 — re-exported
    CAP_HEIGHT_RATIO,
    CAP_TOP_RATIO,
    MARKING_STRIP_MATERIAL_ID,
    TERMINAL_BLOCK_PAD_DOTS,
    _render_block_label,
    _render_rail_strip,
    print_marking_strips,
)

logger = logging.getLogger(__name__)


_SEND_TIMEOUT_SECONDS = 5.0

# Deliberately fixed label branding (Luca, 2026-08) — not the runtime company
# setting, so a reworded admin setting cannot silently change tool labels.
_FOOTER_TEXT = "SMPL Energy GmbH · smpl-energy.de"
_SITE_TEXT = "smpl-energy.de"

# Empirical width of the printer's proportional TTF, fraction of height.
_GLYPH_WIDTH_RATIO = 0.58

_MARGIN = mm_to_dots(2)  # breathing room on sheet edges
_EDGE = mm_to_dots(1)  # the side margin of stock too small for _MARGIN
# A short M-number fits the 12 × 12 DataMatrix symbol (five codewords).
_SYMBOL_MODULES = 12

# ── Voll layout (validated on 99 × 44; requires that class of sheet) ───────
# Positions in mm (the layout's dots of 2026-08, drawn at 12 per mm, / 12);
# the matrix module and the font sizes are dots.
_V_DM_X, _V_DM_Y, _V_DM_MODULE = mm_to_dots(4), mm_to_dots(15), 14
_V_TEXT_X = mm_to_dots(22)
_V_NUMBER_Y, _V_NUMBER_SIZE = mm_to_dots(6.5), 150
_V_NAME_Y, _V_NAME_MAX, _V_NAME_MIN = mm_to_dots(24.3), 64, 24
_V_SERIAL_Y, _V_SERIAL_SIZE = mm_to_dots(31.7), 52
_V_FOOTER_Y, _V_FOOTER_SIZE = mm_to_dots(37.7), 44

# ── Kompakt ratios (from the physically validated quad quadrant, h = 264 dots at 12 per mm) ──
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
_K_TEXT_GAP = mm_to_dots(1.7)  # between the matrix and the text column
_K_TEXT_END = mm_to_dots(1.3)  # the name stops this far before the block's edge
_K_SITE_MIN_H = mm_to_dots(20)  # the site line needs this much height to stay legible

# Scissor lines: 1,2 mm dash every 2 mm, laid from the line's start.
_DASH_ON_MM, _DASH_PERIOD_MM = 1.2, 2.0

# ── Logo (top-right of the voll label) ─────────────────────────────────────
_LOGO_BOX_W, _LOGO_BOX_H = mm_to_dots(25), mm_to_dots(9.2)
_LOGO_THRESHOLD = 170
_LOGO_READING_Y = mm_to_dots(2)


@dataclass(frozen=True)
class LabelContent:
    """Everything a label can show about one machine."""

    unit_number: str
    article_name: str | None = None
    manufacturer: str | None = None
    serial_number: str | None = None


def printer_address(db: Session) -> tuple[str, int] | None:
    """The effective printer as (host, port): runtime setting, then env.

    A runtime address the policy refuses (stored before the rule existed) is
    not dialled — the calibration reads replies back, see
    werkstatt_label_address. The env address is the operator's own.
    """
    from app.services.werkstatt_label_address import address_problem

    config = get_label_printer_config(db)
    if config["host"]:
        if address_problem(config["host"], config["port"]) is None:
            return config["host"], config["port"]
        logger.warning("label printer: stored runtime address refused by the address policy; not dialled")
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


def _xrb(frame: _Frame, reading_x: int, reading_y: int, module: int, data: str) -> list[str]:
    """DataMatrix at a reading-frame position; anchor is the reading BOTTOM."""
    symbol = _SYMBOL_MODULES * module
    return [
        f"XRB{frame.xm(reading_y + symbol)},{frame.ym(reading_x)},{module},0,{len(data.encode(_ENCODING))}",
        data,
    ]


# ── Logo pipeline ──────────────────────────────────────────────────────────


@lru_cache(maxsize=1)
def _logo_asset() -> tuple[str, bytes, int, int] | None:
    """The machine label's logo: the company logo fitted into its box."""
    return logo_asset_for_box(_LOGO_BOX_W, _LOGO_BOX_H)


def _logo_path() -> str:
    return (get_settings().report_logo_path or "").strip()


def logo_mono_image(threshold: int = _LOGO_THRESHOLD, *, path: str | None = None):
    """The company logo as a cropped 1-bit-ready greyscale image (reading
    frame, not yet rotated), or None when the file is missing. Shared by the
    printer assets and the on-screen preview of the type label."""
    from PIL import Image

    if path is None:
        path = _logo_path()
    try:
        img = Image.open(path).convert("L")
    except (OSError, ValueError):
        logger.warning("Label logo unavailable at %r — printing without it", path)
        return None
    mono = img.point(lambda v: 0 if v < threshold else 255, mode="L")
    bbox = mono.point(lambda v: 255 - v).getbbox()
    if bbox:
        mono = mono.crop(bbox)
    return mono


def logo_asset_for_box(box_w: int, box_h: int) -> tuple[str, bytes, int, int] | None:
    """(printer_file_name, mono_bmp_bytes, reading_w, reading_h) or None —
    the logo fitted into a reading-frame box of the given size. Cached per
    logo path, so a "no logo" answer from before the path was configured
    can never outlive the configuration."""
    return _logo_asset_for_path(_logo_path(), box_w, box_h)


@lru_cache(maxsize=8)
def _logo_asset_for_path(path: str, box_w: int, box_h: int) -> tuple[str, bytes, int, int] | None:
    """The cached body of ``logo_asset_for_box``.

    The BMP is drawn in the MACHINE frame (ROTATE_270 maps reading → machine,
    matching the text rotation validated on the physical prints) because the
    `Y` placement command has no rotation parameter. Content-hashed name:
    replacing logo.jpeg — or a different box — yields a new name, and the
    printer's one-time `~EB` download picks it up automatically; re-sending
    an existing name is rejected by the firmware, which is fine — same name
    means same bytes.
    """
    from PIL import Image

    mono = logo_mono_image(path=path)
    if mono is None:
        return None
    scale = min(box_w / mono.width, box_h / mono.height)
    reading_w = max(1, round(mono.width * scale))
    reading_h = max(1, round(mono.height * scale))
    # LANCZOS as on the physically validated prints. Another box size (the
    # 300 dpi correction of 2026-10 made the machine label's 300 × 110 dots
    # 295 × 109) is another bitmap under another content-hashed name, which
    # the next job that places it downloads once.
    return mono_image_asset(mono.resize((reading_w, reading_h), Image.LANCZOS), prefix="SMPL")


def mono_image_asset(image, *, prefix: str) -> tuple[str, bytes, int, int]:
    """Turn a greyscale reading-frame image into a printer flash asset:
    (name, 1-bit BMP in the machine frame, reading_w, reading_h). The name
    is content-hashed under ``prefix`` (letters and digits only — it is a
    file name on the printer)."""
    from PIL import Image

    reading_w, reading_h = image.size
    machine = (
        image.point(lambda v: 0 if v < 128 else 255, mode="L")
        .transpose(Image.Transpose.ROTATE_270)
        .convert("1")
    )
    buf = io.BytesIO()
    machine.save(buf, format="BMP")
    bmp = buf.getvalue()
    name = f"{prefix}{zlib.crc32(bmp) & 0xFFFFFFFF:08X}"
    return name, bmp, reading_w, reading_h


def image_download_preamble(assets: list[tuple[str, bytes, int, int] | None]) -> bytes:
    """The ``~EB`` downloads for every asset a job places, in one payload."""
    payload = b""
    for asset in assets:
        if asset is None:
            continue
        name, bmp, _, _ = asset
        payload += f"~EB,{name},{len(bmp)}\r\n".encode(_ENCODING) + bmp + b"\r\n"
    return payload


def place_image(frame: _Frame, asset: tuple[str, bytes, int, int], reading_x: int, reading_y: int) -> str:
    """A ``Y`` placement of a downloaded asset at a reading-frame top-left."""
    name, _, _, reading_h = asset
    return f"Y{frame.xm(reading_y + reading_h)},{frame.ym(reading_x)},{name}"


def _logo_download_preamble() -> bytes:
    return image_download_preamble([_logo_asset()])


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

    module = max(6, min(9, (block_h - 2 * _MARGIN) // _SYMBOL_MODULES))
    symbol = _SYMBOL_MODULES * module
    dm_y = origin_y + (block_h - symbol) // 2
    text_x = origin_x + _MARGIN + symbol + _K_TEXT_GAP

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
        budget = origin_x + block_w - text_x - _K_TEXT_END
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
    if serial and block_h >= _K_SITE_MIN_H:
        lines.append(
            _at(
                frame,
                text_x,
                origin_y + round(block_h * _K_SERIAL_Y),
                round(block_h * _K_SERIAL_SIZE),
                f"SN {serial}",
            )
        )
    if block_h >= _K_SITE_MIN_H:
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
    h_px = mm_to_dots(profile.width_mm)
    if profile.continuous:
        number = _clean(content.unit_number, 20)
        name = _clean(" ".join(p for p in (content.article_name, content.manufacturer) if p), 40)
        module = max(6, min(9, (h_px - 2 * _MARGIN) // _SYMBOL_MODULES))
        widest = max(
            _est_text_w(number, round(h_px * _K_NUMBER_SIZE)),
            _est_text_w(max(_wrap_words(name, _K_NAME_LINES), key=len), round(h_px * _K_NAME_MAX)),
            _est_text_w(_SITE_TEXT, round(h_px * _K_SITE_SIZE)) if h_px >= _K_SITE_MIN_H else 0,
        )
        w_px = _MARGIN + _SYMBOL_MODULES * module + _K_TEXT_GAP + widest + _MARGIN
        frame = _frame(profile, w_px=w_px)
        lines = _compact_block(frame, 0, 0, w_px, h_px, content)
        return _sheet(profile, lines, length_dots=w_px)
    frame = _frame(profile)
    lines = _compact_block(frame, 0, 0, frame.w_px, frame.h_px, content)
    return _sheet(profile, lines)


def _render_mini(profile: MaterialProfile, text: str, *, copies: int = 1) -> list[str]:
    """Number/text only, centered — for stock too small for anything more."""
    cleaned = _clean(text, 40) or "?"
    h_px = mm_to_dots(profile.width_mm)

    if profile.continuous:
        size = max(16, min(h_px - _EDGE, int(h_px * 0.72)))
        w_px = max(_MARGIN + _est_text_w(cleaned, size) + _MARGIN, mm_to_dots(MIN_CONTINUOUS_MM))
        frame = _frame(profile, w_px=w_px)
        lines = [_at(frame, _MARGIN, (h_px - size) // 2, size, cleaned)]
        return _sheet(profile, lines, length_dots=w_px, copies=copies)

    frame = _frame(profile)
    budget = frame.w_px - 2 * _EDGE  # mini stock is tiny
    size = max(16, min(h_px - _EDGE, int(budget / (_GLYPH_WIDTH_RATIO * len(cleaned)))))
    reading_x = max(_EDGE, (frame.w_px - _est_text_w(cleaned, size)) // 2)
    lines = [_at(frame, reading_x, (h_px - size) // 2, size, cleaned)]
    return _sheet(profile, lines, copies=copies)


def _dashes(
    frame: _Frame, fixed_reading_axis: str, fixed_at: int, start: int, stop: int
) -> list[str]:
    """Dashed scissor line as short `Lo` segments, 2 dots thick.

    Every dash is placed in millimetres from ``start`` and converted on its
    own, so a long line does not collect the rounding of every dash.
    """
    out: list[str] = []
    index = 0
    while (pos := start + mm_to_dots(index * _DASH_PERIOD_MM)) < stop:
        seg_end = min(start + mm_to_dots(index * _DASH_PERIOD_MM + _DASH_ON_MM), stop)
        if fixed_reading_axis == "x":  # vertical cut in reading frame
            out.append(
                f"Lo,{frame.xm(seg_end)},{frame.ym(fixed_at) - 1},{frame.xm(pos)},{frame.ym(fixed_at) + 1}"
            )
        else:  # horizontal cut in reading frame
            out.append(
                f"Lo,{frame.xm(fixed_at) - 1},{frame.ym(pos)},{frame.xm(fixed_at) + 1},{frame.ym(seg_end)}"
            )
        index += 1
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
    lines += _dashes(frame, "x", half_w, _EDGE, frame.h_px - _EDGE)
    lines += _dashes(frame, "y", half_h, _EDGE, frame.w_px - frame.x_offset_px - _EDGE)
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


def _ship(db: Session, payload: bytes, *, session_id: str | None = None) -> str:
    """Send one payload in one connection; returns "host:port".

    Refused while ANOTHER calibration session holds the printer (a print in
    the middle of an auto-sense would feed the wrong material or mix the
    measurement up); ``session_id`` names the caller's own session, whose
    sends pass. The DB is read before the I/O lock and never while holding
    it, so a slow printer can never hold a database lock.
    """
    from app.services.werkstatt_label_session import active_session, busy_message

    address = printer_address(db)
    if address is None:
        raise LabelPrinterNotConfigured()
    holder = active_session(db)
    if holder is not None and holder.session_id != session_id:
        raise LabelPrinterSessionBusy(busy_message(holder), holder_name=holder.user_name, since=holder.acquired_at)
    host, port = address
    with printer_io_lock():
        try:
            _send_tcp(host, port, payload)
        except OSError as exc:
            logger.warning("Label job to %s:%s failed: %s", host, port, exc)
            raise LabelPrinterUnreachable(f"{host}:{port}") from exc
    return f"{host}:{port}"


def _send_tcp(host: str, port: int, payload: bytes) -> None:
    from app.services.werkstatt_label_address import open_checked

    with open_checked(host, port, timeout=_SEND_TIMEOUT_SECONDS) as conn:
        conn.sendall(payload)
