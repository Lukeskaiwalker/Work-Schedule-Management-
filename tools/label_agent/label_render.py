"""Warehouse inventory label renderer for 12 mm Brother TZe tape (PT-P710BT).

Produces two things from one :class:`LabelSpec`:

* :func:`render_png`    -- a 1-bit PNG preview, pixel-identical to what burns.
* :func:`render_raster` -- a list of 16-byte raster scan lines for the printer.

Everything here is stdlib + Pillow. Code 128 is implemented in this module on
purpose (see the CODE 128 section) so the tool has no barcode dependency.


GEOMETRY (from the Brother raster command reference -- not re-derived here)
--------------------------------------------------------------------------
* Print head: 128 pins, 180 dpi, 16 bytes per raster line (128 bits, MSB
  first, pin 1 == bit 7 of byte 0).
* 12 mm tape: 84 dots of tape, 70 *printable* dots, with 29 dead pins of
  margin on each side (29 + 70 + 29 == 128, exactly).
* 180 dpi => 1 mm == 7.0866 dots, 1 dot == 0.1411 mm.
* Across the tape you therefore get 70 dots ~= 9.9 mm and nothing more, ever.
  Along the tape you are effectively unbounded (the printer always feeds at
  least 24.5 mm, so anything shorter than that is free).


ORIENTATION -- why the image is 70 px TALL and then transposed
--------------------------------------------------------------
This is the part that is easy to get backwards, so, explicitly:

A single raster line is one firing of the whole 128-pin head. The pins sit
side by side ACROSS the narrow dimension of the tape. So one raster line is a
column of 128 dots spanning the tape's WIDTH (9.9 mm of which is printable),
not a row of the finished label.

The tape then advances by one dot row and the head fires again. Successive
raster lines therefore march ALONG the tape -- which is the long dimension, the
one a human reads left-to-right as the label's "width".

Consequences, and the whole reason for the transpose:

* The label's HEIGHT (as read by a human) == the tape's short dimension
  == 70 dots. Hard cap. Barcode bar height and text size live in this budget.
* The label's LENGTH (as read by a human) == the number of raster lines.
  Free. This is why the layout puts text lengthwise underneath the bars rather
  than squeezing it into a column beside them: vertical space is the scarce
  resource, horizontal space is not.

So we compose a normal, human-oriented PIL image of height 70 and variable
width, and then in :func:`render_raster` we walk it COLUMN by column -- image
column x becomes raster line x, image row y becomes pin (29 + y). That column
walk *is* the transpose from human orientation to head orientation.

If a physical test print comes out mirrored or reading backwards, the fix is
one of the two flags below, not a rewrite. Both are False for the convention
"first raster line is the left edge of the label, image row 0 is the pin-29
edge of the head".
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from functools import lru_cache

from PIL import Image, ImageDraw, ImageFont

__all__ = [
    "TAPE_12MM_USABLE_DOTS",
    "RASTER_LINE_BYTES",
    "LabelSpec",
    "LabelTooLongError",
    "render_png",
    "render_raster",
    "estimate_length_mm",
]


# --------------------------------------------------------------------------
# Printer geometry
# --------------------------------------------------------------------------

DPI = 180
MM_PER_INCH = 25.4
DOTS_PER_MM = DPI / MM_PER_INCH  # 7.0866...

PRINT_HEAD_PINS = 128
RASTER_LINE_BYTES = 16  # 128 bits / 8
TAPE_12MM_USABLE_DOTS = 70


@dataclass(frozen=True)
class _TapeGeometry:
    """Pin allocation across the head for one tape width."""

    tape_mm: int
    usable_dots: int
    left_margin_pins: int

    @property
    def right_margin_pins(self) -> int:
        return PRINT_HEAD_PINS - self.left_margin_pins - self.usable_dots


# Only 12 mm is exercised by this tool; the others come from the same table in
# the raster reference and are here so another tape width degrades gracefully
# instead of raising -- server.py feeds us whatever the printer reports.
# Every row must satisfy left + usable + right == 128. On the narrow tapes the
# text band shrinks to nothing and only the bars survive; that is intentional.
# These match brother_raster.TAPE_GEOMETRY row for row.
_TAPE_GEOMETRY: dict[int, _TapeGeometry] = {
    4: _TapeGeometry(4, 24, 52),   # 3.5 mm tape reports a media width of 4 mm
    6: _TapeGeometry(6, 32, 48),
    9: _TapeGeometry(9, 50, 39),
    12: _TapeGeometry(12, TAPE_12MM_USABLE_DOTS, 29),
    18: _TapeGeometry(18, 112, 8),
    24: _TapeGeometry(24, 128, 0),
}

# Physical-orientation escape hatches. See the ORIENTATION note in the module
# docstring. Flip these (and only these) if a real print comes out wrong.
FEED_ORDER_REVERSED = False   # True => emit the last image column first
ACROSS_TAPE_FLIPPED = False   # True => image row 0 maps to the far edge pin


# --------------------------------------------------------------------------
# Label layout budget (fractions of the usable dot count, so other tape
# widths scale sanely)
# --------------------------------------------------------------------------

_TOP_QUIET_DOTS = 2          # white above the bars
_BAR_GAP_DOTS = 2            # white between bars and the text row
_BAR_HEIGHT_FRACTION = 0.66  # 0.66 * 70 == 46 dots == 6.49 mm of bar
_SIDE_MARGIN_DOTS = 6        # white at each end of the text row
_TEXT_GAP_DOTS = 6           # white between text runs
_MIN_TITLE_DOTS = 24         # never squeeze the article name below this
_SMALL_TEXT_FRACTION = 0.72  # subtitle/code font height vs. the title font
_MIN_FONT_SIZE = 4           # floor for the font search (see _fit_font)

# The printer always feeds >= 24.5 mm, so a shorter raster just wastes tape and
# crams the content into one end. Pad up to it and centre instead.
MIN_LABEL_DOTS = round(24.5 * DOTS_PER_MM)   # 174
# A warehouse label longer than this is a mistake, not a requirement.
MAX_LABEL_MM = 120.0
MAX_LABEL_DOTS = round(MAX_LABEL_MM * DOTS_PER_MM)  # 850

_FONT_CANDIDATES = (
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/HelveticaNeue.ttc",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
)

_BLACK = 0  # in PIL mode "1", 0 is black and 255 is white
_WHITE = 1


class LabelTooLongError(ValueError):
    """The payload cannot be printed within :data:`MAX_LABEL_MM` of tape."""


@dataclass
class LabelSpec:
    code: str                     # what goes in the barcode
    title: str                    # human-readable article name
    subtitle: str | None = None   # e.g. article number or EAN
    tape_mm: int = 12


# ==========================================================================
# CODE 128
# ==========================================================================
#
# Structure of a Code 128 symbol:
#
#     [start] [data ...] [checksum] [stop]
#
# Every character is 11 modules wide (3 bars + 3 spaces, always starting with a
# bar and ending with a space) except the stop character, which is 13 modules
# because it carries a 2-module termination bar on the end.
#
# The table below stores element WIDTHS rather than bit strings: "212222" means
# bar 2, space 1, bar 2, space 2, bar 2, space 2. That form is far easier to
# transcribe without error, and the self-test validates every invariant the
# real specification imposes (11 modules, even total bar width, uniqueness) plus
# the four published start/stop bit patterns.
#
# Checksum: sum = start_value + sum(value_i * position_i) for positions 1..n,
# taken modulo 103. A wrong checksum yields a barcode that looks flawless and
# never scans, which is why __main__ proves it against a published vector.

_CODE128_WIDTHS: tuple[str, ...] = (
    # 0-9
    "212222", "222122", "222221", "121223", "121322",
    "131222", "122213", "122312", "132212", "221213",
    # 10-19
    "221312", "231212", "112232", "122132", "122231",
    "113222", "123122", "123221", "223211", "221132",
    # 20-29
    "221231", "213212", "223112", "312131", "311222",
    "321122", "321221", "312212", "322112", "322211",
    # 30-39
    "212123", "212321", "232121", "111323", "131123",
    "131321", "112313", "132113", "132311", "211313",
    # 40-49
    "231113", "231311", "112133", "112331", "132131",
    "113123", "113321", "133121", "313121", "211331",
    # 50-59
    "231131", "213113", "213311", "213131", "311123",
    "311321", "331121", "312113", "312311", "332111",
    # 60-69
    "314111", "221411", "431111", "111224", "111422",
    "121124", "121421", "141122", "141221", "112214",
    # 70-79
    "112412", "122114", "122411", "142112", "142211",
    "241211", "221114", "413111", "241112", "134111",
    # 80-89
    "111242", "121142", "121241", "114212", "124112",
    "124211", "411212", "421112", "421211", "212141",
    # 90-99
    "214121", "412121", "111143", "111341", "131141",
    "114113", "114311", "411113", "411311", "113141",
    # 100-106
    "114131", "311141", "411131",
    "211412",   # 103 START A
    "211214",   # 104 START B
    "211232",   # 105 START C
    "2331112",  # 106 STOP (13 modules, includes the termination bar)
)

_START_A, _START_B, _START_C, _STOP = 103, 104, 105, 106
_CODE_C = 99   # from set B, latch to set C
_QUIET_MODULES = 10  # specification minimum quiet zone on each side

# Below this many digits, Code C's fixed overhead is not worth the switch.
_CODE_C_MIN_DIGITS = 4


def _widths_to_bits(widths: str) -> str:
    """Expand an element-width string into modules; elements alternate bar/space."""
    bits = []
    for index, width in enumerate(widths):
        bits.append(("1" if index % 2 == 0 else "0") * int(width))
    return "".join(bits)


_CODE128_BITS: tuple[str, ...] = tuple(_widths_to_bits(w) for w in _CODE128_WIDTHS)
_WIDTHS_TO_VALUE: dict[str, int] = {w: v for v, w in enumerate(_CODE128_WIDTHS)}


def code128_values(payload: str) -> list[int]:
    """Full symbol value list: start, data, modulo-103 checksum, stop.

    Code set choice, deliberately:

    * All digits and at least ``_CODE_C_MIN_DIGITS`` long -> Code Set C, which
      packs two digits into one 11-module symbol and so nearly halves the
      printed length. On 12 mm tape that is the difference between a label that
      fits a shelf lip and one that does not, and warehouse codes are usually
      all digits, so this is the common path.
    * Odd digit count -> start in B, emit the first digit in B, latch to C for
      the remaining even-length tail. Still shorter than pure B from 5 digits up.
    * Anything else (letters, dashes, mixed) -> Code Set B for the whole
      payload. Set A only buys control characters, which no article code uses.
    """
    if not payload:
        raise ValueError("barcode payload is empty")
    for char in payload:
        if not 32 <= ord(char) <= 126:
            raise ValueError(
                f"character {char!r} is not encodable in Code 128 set B "
                "(printable ASCII 32..126 only)"
            )

    if payload.isdigit() and len(payload) >= _CODE_C_MIN_DIGITS:
        values = _values_code_c(payload)
    else:
        values = [_START_B] + [ord(char) - 32 for char in payload]

    values.append(code128_checksum(values))
    values.append(_STOP)
    return values


def _values_code_c(payload: str) -> list[int]:
    """Digit payload as Code Set C pairs, with a B prefix when odd-length."""
    if len(payload) % 2 == 0:
        values = [_START_C]
        rest = payload
    else:
        values = [_START_B, ord(payload[0]) - 32, _CODE_C]
        rest = payload[1:]
    values.extend(int(rest[i:i + 2]) for i in range(0, len(rest), 2))
    return values


def code128_checksum(values: list[int]) -> int:
    """Modulo-103 check value over start (weight 1) plus data at weights 1..n."""
    total = values[0] + sum(value * pos for pos, value in enumerate(values[1:], start=1))
    return total % 103


def code128_modules(payload: str) -> str:
    """Payload -> module string of '1' (bar) and '0' (space)."""
    return "".join(_CODE128_BITS[value] for value in code128_values(payload))


def _bits_to_widths(chunk: str) -> str:
    """Run-length a module chunk back into an element-width string."""
    widths, current, run = [], chunk[0], 0
    for bit in chunk:
        if bit == current:
            run += 1
        else:
            widths.append(str(run))
            current, run = bit, 1
    widths.append(str(run))
    return "".join(widths)


def _decode_modules(bits: str) -> list[int]:
    """Read a module string back to symbol values (used by the self-test).

    Safe to chunk blindly: every Code 128 character starts with a bar and ends
    with a space, so no run ever straddles a character boundary.
    """
    if len(bits) < 24 or (len(bits) - 13) % 11:
        raise ValueError("not a well-formed Code 128 module string")
    chunks = [bits[i:i + 11] for i in range(0, len(bits) - 13, 11)]
    chunks.append(bits[-13:])
    return [_WIDTHS_TO_VALUE[_bits_to_widths(chunk)] for chunk in chunks]


def _decode_payload(values: list[int]) -> str:
    """Reconstruct the payload from decoded values (used by the self-test)."""
    if values[-1] != _STOP:
        raise ValueError("missing stop character")
    if code128_checksum(values[:-2]) != values[-2]:
        raise ValueError("checksum mismatch")
    mode_c = values[0] == _START_C
    out = []
    for value in values[1:-2]:
        if value == _CODE_C:
            mode_c = True
            continue
        out.append(f"{value:02d}" if mode_c else chr(value + 32))
    return "".join(out)


# ==========================================================================
# Fonts and text helpers
# ==========================================================================

def _probe(font) -> None:
    """Raise unless ``font`` can actually measure and report metrics.

    Constructing a font is not proof that it works: Helvetica.ttc accepts any
    size but then raises OSError("division by zero") from getlength() below
    about 8 px, i.e. only once you try to use it. So every candidate is probed
    with a real measurement before it is handed out.
    """
    ascent, descent = font.getmetrics()
    length = font.getlength("0Mg")
    if length <= 0 or ascent <= 0:
        raise ValueError("font reports degenerate metrics")


@lru_cache(maxsize=None)
def _load_font(size: int):
    """Best available *working* font at ``size``; never raises, never crashes.

    Falls through the candidate list, then to Pillow's bundled font (which does
    cope with tiny sizes), then to the plain bitmap default.
    """
    size = max(1, int(size))
    for path in _FONT_CANDIDATES:
        try:
            font = ImageFont.truetype(path, size)
            _probe(font)
            return font
        except Exception:  # noqa: BLE001 - any bad face just means "try the next"
            continue
    for factory in (lambda: ImageFont.load_default(size=size), ImageFont.load_default):
        try:
            font = factory()
            _probe(font)
            return font
        except Exception:  # noqa: BLE001
            continue
    return ImageFont.load_default()


def _font_metrics(font) -> tuple[int, int]:
    """(ascent, descent) in pixels, with a sane fallback for bitmap fonts."""
    try:
        ascent, descent = font.getmetrics()
        return int(ascent), int(descent)
    except Exception:  # noqa: BLE001
        height = int(getattr(font, "size", 11) or 11)
        return height, 0


def _text_width(text: str, font) -> int:
    """Pixel width of ``text``; 0 rather than an exception if the font balks."""
    if not text:
        return 0
    try:
        return int(round(font.getlength(text)))
    except Exception:  # noqa: BLE001
        try:
            box = font.getbbox(text)
            return int(box[2] - box[0])
        except Exception:  # noqa: BLE001
            return 0


@lru_cache(maxsize=None)
def _fit_font(max_height: int):
    """Largest working font whose ascent+descent fits ``max_height``.

    If nothing fits -- which only happens on tapes so narrow that the text band
    is a few dots tall -- return the smallest working font and let the paste
    clip. Bars still print; illegible text on 3.5 mm tape is not a crash.
    """
    for size in range(max(_MIN_FONT_SIZE, max_height + 4), _MIN_FONT_SIZE - 1, -1):
        font = _load_font(size)
        ascent, descent = _font_metrics(font)
        if ascent + descent <= max_height:
            return font
    return _load_font(_MIN_FONT_SIZE)


def _truncate(text: str, font, max_width: int) -> str:
    """Trim ``text`` with an ellipsis until it fits ``max_width`` pixels."""
    if not text or _text_width(text, font) <= max_width:
        return text
    for cut in range(len(text) - 1, 0, -1):
        candidate = text[:cut].rstrip() + "..."
        if _text_width(candidate, font) <= max_width:
            return candidate
    return ""


def _text_strip(text: str, font) -> tuple[Image.Image, int]:
    """Render ``text`` to its own 1-bit strip; returns (image, ascent).

    Rendering into a mode "1" image with ``fontmode = "1"`` disables
    antialiasing outright: the thermal head is one bit per dot, and a grey
    fringe would just become an arbitrary black or white dot.
    """
    ascent, descent = _font_metrics(font)
    width = max(1, _text_width(text, font))
    strip = Image.new("1", (width, max(1, ascent + descent)), _WHITE)
    draw = ImageDraw.Draw(strip)
    draw.fontmode = "1"
    draw.text((0, 0), text, font=font, fill=_BLACK)  # default anchor: ascender top
    return strip, ascent


# ==========================================================================
# Layout
# ==========================================================================

@dataclass(frozen=True)
class _Plan:
    geometry: _TapeGeometry
    modules: str
    module_width: int
    width: int
    height: int
    bars_x: int
    bars_top: int
    bars_height: int
    band_top: int
    band_height: int


def _tape_geometry(tape_mm: int) -> _TapeGeometry:
    try:
        return _TAPE_GEOMETRY[tape_mm]
    except KeyError:
        supported = ", ".join(f"{mm} mm" for mm in sorted(_TAPE_GEOMETRY))
        raise ValueError(f"unsupported tape width {tape_mm} mm (have: {supported})") from None


def _choose_module_width(module_count: int) -> int:
    """Dots per barcode module.

    2 dots (0.28 mm) is the default X-dimension -- comfortably scannable and
    compact. Widen to 3 only when the whole symbol still fits inside the free
    24.5 mm minimum feed (bigger modules scan better, and that tape is spent
    either way). Shrink to the 1-dot floor rather than fail. Only if even 1-dot
    modules overflow :data:`MAX_LABEL_MM` do we raise, which needs a payload of
    roughly 70+ characters.
    """
    for width in (3, 2, 1):
        total = (module_count + 2 * _QUIET_MODULES) * width
        if width == 3 and total > MIN_LABEL_DOTS:
            continue  # do not grow the label past the length that is free
        if total <= MAX_LABEL_DOTS:
            return width
    raise LabelTooLongError(
        f"barcode needs {module_count} modules; even at a 1-dot module width "
        f"that exceeds the {MAX_LABEL_MM:.0f} mm maximum label length"
    )


def _band_fonts(band_height: int):
    title_font = _fit_font(band_height)
    small_font = _fit_font(max(6, int(band_height * _SMALL_TEXT_FRACTION)))
    return title_font, small_font


def _plan_label(spec: LabelSpec) -> _Plan:
    """Work out every dimension before a single pixel is drawn."""
    geometry = _tape_geometry(spec.tape_mm)
    usable = geometry.usable_dots

    modules = code128_modules(spec.code)
    module_width = _choose_module_width(len(modules))
    barcode_block = (len(modules) + 2 * _QUIET_MODULES) * module_width

    bars_height = max(1, int(round(usable * _BAR_HEIGHT_FRACTION)))
    band_top = _TOP_QUIET_DOTS + bars_height + _BAR_GAP_DOTS
    band_height = max(1, usable - band_top)

    width = max(barcode_block, MIN_LABEL_DOTS, _text_row_minimum(spec, band_height))
    width = min(width, MAX_LABEL_DOTS)

    return _Plan(
        geometry=geometry,
        modules=modules,
        module_width=module_width,
        width=width,
        height=usable,
        bars_x=(width - len(modules) * module_width) // 2,
        bars_top=_TOP_QUIET_DOTS,
        bars_height=bars_height,
        band_top=band_top,
        band_height=band_height,
    )


def _text_row_minimum(spec: LabelSpec, band_height: int) -> int:
    """Length needed so the fixed text (code, subtitle) plus a stub title fits.

    Length along the tape is free, so rather than shrink the type we lengthen
    the label -- but only up to MAX_LABEL_DOTS, after which the title truncates.
    """
    title_font, small_font = _band_fonts(band_height)
    needed = 2 * _SIDE_MARGIN_DOTS + _MIN_TITLE_DOTS
    needed += _TEXT_GAP_DOTS + _text_width(spec.code, small_font)
    if spec.subtitle:
        needed += _TEXT_GAP_DOTS + _text_width(spec.subtitle, small_font)
    _ = title_font
    return needed


# ==========================================================================
# Drawing
# ==========================================================================

def _draw_bars(image: Image.Image, plan: _Plan) -> None:
    """Paint the Code 128 modules as exact-pixel rectangles.

    Rectangles on integer boundaries in a 1-bit image: no antialiasing, no
    resampling, no grey. An antialiased barcode does not scan.
    """
    draw = ImageDraw.Draw(image)
    top = plan.bars_top
    bottom = plan.bars_top + plan.bars_height - 1
    x = plan.bars_x
    for bit in plan.modules:
        if bit == "1":
            draw.rectangle([x, top, x + plan.module_width - 1, bottom], fill=_BLACK)
        x += plan.module_width


def _draw_text_row(image: Image.Image, plan: _Plan, spec: LabelSpec) -> None:
    """Title (left, large) + optional subtitle + code (right, small), one baseline.

    All three run lengthwise under the bars because tape length is the cheap
    axis; stacking them beside the bars would eat the 9.9 mm that the bars need.
    """
    title_font, small_font = _band_fonts(plan.band_height)
    baseline = plan.band_top + _font_metrics(title_font)[0]

    code_text = spec.code
    code_width = _text_width(code_text, small_font)
    subtitle = (spec.subtitle or "").strip()

    available = plan.width - 2 * _SIDE_MARGIN_DOTS - code_width - _TEXT_GAP_DOTS
    if subtitle:
        subtitle = _truncate(subtitle, small_font, max(0, available - _MIN_TITLE_DOTS))
        available -= _text_width(subtitle, small_font) + _TEXT_GAP_DOTS

    title = _truncate(spec.title.strip(), title_font, max(0, available))

    cursor = _SIDE_MARGIN_DOTS
    for text, font in ((title, title_font), (subtitle, small_font)):
        if not text:
            continue
        strip, ascent = _text_strip(text, font)
        image.paste(strip, (cursor, baseline - ascent))
        cursor += strip.width + _TEXT_GAP_DOTS

    if code_text:
        strip, ascent = _text_strip(code_text, small_font)
        x = max(cursor, plan.width - _SIDE_MARGIN_DOTS - strip.width)
        if x + strip.width <= plan.width:
            image.paste(strip, (x, baseline - ascent))


def _render_label_image(spec: LabelSpec) -> Image.Image:
    """The label in human orientation: height == usable tape dots, width == length."""
    plan = _plan_label(spec)
    image = Image.new("1", (plan.width, plan.height), _WHITE)
    _draw_bars(image, plan)
    _draw_text_row(image, plan, spec)
    return image


# ==========================================================================
# Public API
# ==========================================================================

def render_png(spec: LabelSpec) -> bytes:
    """PNG preview, same pixels the printer will burn. For the UI."""
    image = _render_label_image(spec)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def render_raster(spec: LabelSpec) -> list[bytes]:
    """List of 16-byte scan lines, ready for BrotherPTouch.print_raster().

    The transpose lives here: image COLUMN x -> raster line x, image ROW y ->
    print-head pin (left_margin + y). See the ORIENTATION note at the top for
    why that is the right way round.
    """
    image = _render_label_image(spec)
    geometry = _tape_geometry(spec.tape_mm)
    width, height = image.size
    pixels = image.load()
    offset = geometry.left_margin_pins

    columns = range(width - 1, -1, -1) if FEED_ORDER_REVERSED else range(width)
    lines: list[bytes] = []
    for x in columns:
        line = bytearray(RASTER_LINE_BYTES)
        for y in range(height):
            if pixels[x, y] != _BLACK:
                continue
            pin = offset + (height - 1 - y if ACROSS_TAPE_FLIPPED else y)
            line[pin >> 3] |= 0x80 >> (pin & 7)  # MSB first within each byte
        lines.append(bytes(line))
    return lines


def estimate_length_mm(spec: LabelSpec) -> float:
    """Printed length along the tape, in millimetres."""
    return _render_label_image(spec).size[0] / DOTS_PER_MM


# ==========================================================================
# Self-test
# ==========================================================================

def _self_test() -> bool:  # pragma: no cover - developer entry point
    results: list[tuple[str, bool, str]] = []

    def check(name: str, condition: bool, detail: str = "") -> None:
        results.append((name, bool(condition), detail))

    # -- 1. Pattern table structure -------------------------------------
    check("table has 107 entries", len(_CODE128_WIDTHS) == 107, str(len(_CODE128_WIDTHS)))
    bad = [
        v for v, w in enumerate(_CODE128_WIDTHS[:106])
        if len(w) != 6 or sum(int(c) for c in w) != 11
    ]
    check("values 0..105 are 6 elements / 11 modules", not bad, f"bad: {bad}")
    check("stop is 13 modules", sum(int(c) for c in _CODE128_WIDTHS[106]) == 13)
    odd_parity = [
        v for v, w in enumerate(_CODE128_WIDTHS[:106])
        if sum(int(c) for c in w[0::2]) % 2
    ]
    check("every symbol has even bar parity", not odd_parity, f"odd: {odd_parity}")
    check("all 107 patterns unique", len(set(_CODE128_WIDTHS)) == 107)

    # -- 2. Published start/stop bit patterns ---------------------------
    published = {
        _START_A: "11010000100",
        _START_B: "11010010000",
        _START_C: "11010011100",
        _STOP: "1100011101011",
    }
    for value, bits in published.items():
        check(f"published pattern for value {value}", _CODE128_BITS[value] == bits,
              _CODE128_BITS[value])

    # -- 3. Published checksum vector -----------------------------------
    # "Wikipedia" in Code Set B: start 104, then W i k i p e d i a, check 88.
    expected = [104, 55, 73, 75, 73, 80, 69, 68, 73, 65, 88, 106]
    got = code128_values("Wikipedia")
    check("checksum vector 'Wikipedia' -> 88", got == expected, f"got {got}")

    # -- 4. Code Set C selection and checksums --------------------------
    check("all-digit even payload uses Start C", code128_values("12345678")[0] == _START_C)
    check("'12345678' values", code128_values("12345678") == [105, 12, 34, 56, 78, 47, 106],
          str(code128_values("12345678")))
    check("odd digits latch B->C", code128_values("12345") == [104, 17, 99, 23, 45, 53, 106],
          str(code128_values("12345")))
    check("alphanumeric stays in Set B", code128_values("ART-4711")[0] == _START_B)
    check("Set C really is shorter",
          len(code128_modules("12345678")) < len(code128_modules("ABCDEFGH")))

    # -- 5. Module count and round-trip decode --------------------------
    for payload in ("12345678", "12345", "ART-4711/A", "9", "Wikipedia", "4029764001807"):
        values = code128_values(payload)
        bits = code128_modules(payload)
        check(f"module count for {payload!r}",
              len(bits) == 11 * (len(values) - 1) + 13, f"{len(bits)} modules")
        decoded = _decode_modules(bits)
        check(f"round-trip decode of {payload!r}",
              decoded == values and _decode_payload(decoded) == payload,
              f"decoded {_decode_payload(decoded)!r}")

    # -- 6. Raster shape ------------------------------------------------
    spec = LabelSpec(code="4029764001807", title="Kabelbinder 200x4,8 schwarz",
                     subtitle="ART-4711")
    lines = render_raster(spec)
    check("raster produced lines", len(lines) > 0, f"{len(lines)} lines")
    check("every line is exactly 16 bytes",
          all(len(line) == RASTER_LINE_BYTES for line in lines))
    geometry = _tape_geometry(12)
    lo, hi = geometry.left_margin_pins, geometry.left_margin_pins + geometry.usable_dots
    check("29+70+29 == 128", lo + geometry.usable_dots + geometry.right_margin_pins == 128)
    stray = any(
        line[pin >> 3] & (0x80 >> (pin & 7))
        for line in lines for pin in range(PRINT_HEAD_PINS)
        if not lo <= pin < hi
    )
    check("no dots outside the 70 printable pins", not stray)
    check("some dots are actually set", any(any(line) for line in lines))
    check("raster line count == image width", len(lines) == _render_label_image(spec).size[0])

    # -- 7. Fonts: every size must yield a font that can actually measure --
    # Regression: Helvetica.ttc constructs happily below ~8 px and only then
    # raises from getlength(), which crashed rendering on narrow tape.
    broken = []
    for size in range(_MIN_FONT_SIZE, 41):
        try:
            _probe(_load_font(size))
        except Exception as exc:  # noqa: BLE001
            broken.append((size, type(exc).__name__))
    check("_load_font usable at every size 4..40", not broken, f"broken: {broken}")

    saved = globals()["_FONT_CANDIDATES"]
    try:
        globals()["_FONT_CANDIDATES"] = ("/nonexistent/NoSuchFont.ttf",)
        _load_font.cache_clear()
        _fit_font.cache_clear()
        png_nofont = render_png(LabelSpec(code="123456", title="kein Font"))
        check("renders with no system font available", png_nofont[:4] == b"\x89PNG")
    except Exception as exc:  # noqa: BLE001
        check("renders with no system font available", False, f"{type(exc).__name__}: {exc}")
    finally:
        globals()["_FONT_CANDIDATES"] = saved
        _load_font.cache_clear()
        _fit_font.cache_clear()

    # -- 8. Every supported tape width renders ---------------------------
    for tape_mm in sorted(_TAPE_GEOMETRY):
        geo = _TAPE_GEOMETRY[tape_mm]
        check(f"{tape_mm} mm geometry sums to 128",
              geo.left_margin_pins + geo.usable_dots + geo.right_margin_pins == PRINT_HEAD_PINS)
        try:
            tape_lines = render_raster(
                LabelSpec(code="4029764001807", title="Kabelbinder", subtitle="A1",
                          tape_mm=tape_mm)
            )
        except Exception as exc:  # noqa: BLE001
            check(f"{tape_mm} mm renders", False, f"{type(exc).__name__}: {exc}")
            continue
        edge_lo = geo.left_margin_pins
        edge_hi = edge_lo + geo.usable_dots
        outside = any(
            line[pin >> 3] & (0x80 >> (pin & 7))
            for line in tape_lines for pin in range(PRINT_HEAD_PINS)
            if not edge_lo <= pin < edge_hi
        )
        check(f"{tape_mm} mm renders", bool(tape_lines)
              and all(len(line) == RASTER_LINE_BYTES for line in tape_lines)
              and not outside)

    # -- 9. PNG and guards ----------------------------------------------
    png = render_png(spec)
    check("render_png returns a PNG", png[:8] == b"\x89PNG\r\n\x1a\n", f"{png[:8]!r}")
    try:
        render_png(LabelSpec(code="X" * 200, title="overflow"))
        check("over-long payload raises", False, "no exception")
    except LabelTooLongError:
        check("over-long payload raises", True)
    for bad_payload in ("", "café"):
        try:
            code128_values(bad_payload)
            check(f"rejects {bad_payload!r}", False, "no exception")
        except ValueError:
            check(f"rejects {bad_payload!r}", True)

    width = 0
    for name, ok, detail in results:
        width = max(width, len(name))
    for name, ok, detail in results:
        tag = "PASS" if ok else "FAIL"
        suffix = f"   {detail}" if (detail and not ok) else ""
        print(f"[{tag}] {name.ljust(width)}{suffix}")
    failed = sum(1 for _, ok, _ in results if not ok)
    print(f"\n{len(results) - failed}/{len(results)} checks passed"
          f"{'' if not failed else f' -- {failed} FAILED'}")
    return failed == 0


if __name__ == "__main__":  # pragma: no cover
    import sys

    ok = _self_test()

    demo = LabelSpec(
        code="4029764001807",
        title="Kabelbinder 200x4,8 schwarz",
        subtitle="ART-4711",
    )
    image = _render_label_image(demo)
    lines = render_raster(demo)
    out = "/tmp/label_preview.png"
    with open(out, "wb") as handle:
        handle.write(render_png(demo))

    print()
    print(f"sample label : {demo.code}  |  {demo.title}  |  {demo.subtitle}")
    print(f"image        : {image.size[0]} x {image.size[1]} dots "
          f"({image.size[0] / DOTS_PER_MM:.1f} mm x {image.size[1] / DOTS_PER_MM:.1f} mm)")
    print(f"raster       : {len(lines)} scan lines x {RASTER_LINE_BYTES} bytes "
          f"= {len(lines) * RASTER_LINE_BYTES} bytes")
    print(f"module width : {_plan_label(demo).module_width} dots "
          f"({_plan_label(demo).module_width / DOTS_PER_MM * 1000:.0f} um)")
    print(f"preview      : {out}")

    sys.exit(0 if ok else 1)
