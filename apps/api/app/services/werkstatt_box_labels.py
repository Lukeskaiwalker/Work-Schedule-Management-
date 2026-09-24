"""The sticker on a Baustellenkiste — what ``POST /werkstatt/boxes/{id}/print-label``
prints on the 99 × 44 type label.

Until 2026-09-24 a crate borrowed the MACHINE label, which is laid out for
a five-character M-number: its DataMatrix anchor assumes the 12 × 12 symbol
of "M-0062" and its headline is sized for it. A crate code is
"KISTE-BK-2026-0001" — eighteen characters, fourteen DataMatrix codewords, an
18 × 18 symbol — so the matrix grew into the name and the code text ran
across the whole sheet and through the logo. This layout is sized from the
code it prints:

* left — the DataMatrix, its module chosen so the symbol the code really
  needs (``datamatrix_symbol_modules``) stays inside a fixed box, the code
  in small type under it (scanned, not read);
* right — the crate's number ("BK-2026-0001", "K4") as the headline, fitted
  to the room left of the logo; the crate's name under it on up to two
  lines; "Baustellenkiste" small at the foot;
* top-right — the logo in its own box, which the headline never enters.

Voll-tier stock only, like the type label and the shelf label.
"""

from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.services import werkstatt_labels as wl
from app.services.werkstatt_label_materials import TIER_VOLL, MaterialProfile, active_material

# ── DataMatrix sizing ─────────────────────────────────────────────────────────
#
# ECC200 square symbols and their data capacity in codewords. ASCII encoding
# packs a digit pair into one codeword and any other character into one;
# the printer picks the smallest symbol that holds the data, so the anchor
# has to be computed for the same symbol.
_SYMBOL_CAPACITY: tuple[tuple[int, int], ...] = (
    (10, 3), (12, 5), (14, 8), (16, 12), (18, 18), (20, 22), (22, 30), (24, 36), (26, 44),
)


def datamatrix_codewords(data: str) -> int:
    """Data codewords of ``data`` in ECC200 ASCII encoding."""
    count = 0
    index = 0
    while index < len(data):
        if index + 1 < len(data) and data[index].isdigit() and data[index + 1].isdigit():
            index += 2
        else:
            index += 1
        count += 1
    return count


def datamatrix_symbol_modules(data: str) -> int:
    """Side length, in modules, of the smallest square symbol holding ``data``."""
    needed = datamatrix_codewords(data)
    for modules, capacity in _SYMBOL_CAPACITY:
        if needed <= capacity:
            return modules
    return _SYMBOL_CAPACITY[-1][0]


# ── Layout, reading frame in printer dots (12 per mm) on the 99 × 44 sheet ──

_DM_X, _DM_Y = 36, 96
_DM_BOX = 200  # the symbol, whatever its module count, stays inside this square
_DM_MODULE_MAX, _DM_MODULE_MIN = 12, 6
_CODE_SIZE_MAX, _CODE_SIZE_MIN = 26, 16

_COL_X = _DM_X + _DM_BOX + 32  # 268
_LOGO_BOX_W, _LOGO_BOX_H = 260, 96
_LOGO_X, _LOGO_Y = wl._MARGIN, wl._MARGIN
_HEAD_Y, _HEAD_MAX, _HEAD_MIN = 44, 96, 40
_NAME_Y, _NAME_MAX, _NAME_MIN, _NAME_LINES, _NAME_LEADING = 176, 54, 26, 2, 1.25
_FOOT_Y, _FOOT_SIZE = 458, 28
_FOOT_TEXT = "Baustellenkiste"


@dataclass(frozen=True)
class BoxLabelContent:
    code: str  # KISTE-BK-2026-0001 — what the matrix encodes
    box_number: str  # BK-2026-0001 / K4 — the headline
    label: str | None = None  # "Kiste Wallbox" — the crate's name


def _module_for(code: str) -> tuple[int, int]:
    """(module dots, symbol modules) so the symbol fits ``_DM_BOX``."""
    modules = datamatrix_symbol_modules(code)
    module = max(_DM_MODULE_MIN, min(_DM_MODULE_MAX, _DM_BOX // modules))
    return module, modules


def _xrb_sized(frame: wl._Frame, reading_x: int, reading_y: int, code: str) -> tuple[list[str], int]:
    """The matrix anchored for the symbol the code needs; returns (lines, symbol dots)."""
    module, modules = _module_for(code)
    symbol = module * modules
    lines = [
        f"XRB{frame.xm(reading_y + symbol)},{frame.ym(reading_x)},{module},0,{len(code.encode(wl._ENCODING))}",
        code,
    ]
    return lines, symbol


def _layout(frame: wl._Frame, content: BoxLabelContent, symbol: int) -> list[tuple[str, int, int, int]]:
    """The text as (text, reading_x, reading_y, size) — printer job and preview alike."""
    out: list[tuple[str, int, int, int]] = []
    code = wl._clean(content.code, 40)
    code_size = wl._fit_text_size(code, _COL_X - _DM_X - 12, _CODE_SIZE_MAX, _CODE_SIZE_MIN)
    out.append((code, _DM_X, _DM_Y + symbol + 14, code_size))

    # The headline stops where the logo box starts.
    logo_left = frame.w_px - _LOGO_X - _LOGO_BOX_W
    head = wl._clean(content.box_number, 24)
    if head:
        size = wl._fit_text_size(head, logo_left - 20 - _COL_X, _HEAD_MAX, _HEAD_MIN)
        out.append((head, _COL_X, _HEAD_Y, size))

    name = wl._clean(content.label or "", 80)
    if name:
        budget = frame.w_px - wl._MARGIN - _COL_X
        # A name that fits on one line at full size stays on one line;
        # only a long one is spread over two ("Kiste 4" is not two lines).
        if wl._fit_text_size(name, budget, _NAME_MAX, _NAME_MIN) >= _NAME_MAX:
            lines = [name]
        else:
            lines = wl._wrap_words(name, _NAME_LINES)
        size = min(wl._fit_text_size(line, budget, _NAME_MAX, _NAME_MIN) for line in lines)
        y = _NAME_Y
        for line in lines:
            out.append((line, _COL_X, y, size))
            y += int(size * _NAME_LEADING)

    out.append((_FOOT_TEXT, _COL_X, _FOOT_Y, _FOOT_SIZE))
    return out


def render_box_label(profile: MaterialProfile, content: BoxLabelContent) -> tuple[list[str], list[tuple[str, bytes, int, int] | None]]:
    """The EZPL job for one crate sticker and the assets it places."""
    frame = wl._frame(profile)
    code = wl._clean(content.code, 40)
    lines, symbol = _xrb_sized(frame, _DM_X, _DM_Y, code)
    for text, x, y, size in _layout(frame, content, symbol):
        lines.append(wl._at(frame, x, y, size, text))
    logo = wl.logo_asset_for_box(_LOGO_BOX_W, _LOGO_BOX_H)
    if logo is not None:
        logo_x = frame.w_px - _LOGO_X - logo[2]
        lines.append(wl.place_image(frame, logo, logo_x, _LOGO_Y))
    return wl._sheet(profile, lines), [logo]


def print_box_label(db: Session, content: BoxLabelContent) -> str:
    """Render and ship one sticker on the active stock; returns "host:port"."""
    profile = active_material(db)
    if profile.tier != TIER_VOLL:
        raise wl.LabelFormatUnsupported(
            "Das Kisten-Etikett braucht ein großes Etikett (z. B. WAGO 210-804/-824) — "
            f"aktiv ist „{profile.name}“"
        )
    job, assets = render_box_label(profile, content)
    payload = wl.image_download_preamble(assets) + ("\r\n".join(job) + "\r\n").encode(wl._ENCODING)
    printer = wl._ship(db, payload)
    wl.logger.info("Box label sent to %s — %s, %d bytes", printer, content.code, len(payload))
    return printer


# ── Preview ──────────────────────────────────────────────────────────────────


def _placeholder_matrix(code: str, modules: int) -> list[list[bool]]:
    """A stand-in symbol of the right size: solid L finder, dashed clock edges,
    the inside seeded from the code. Shows placement and size, not a scan."""
    seed = hashlib.sha1(code.encode("utf-8")).digest()
    bits = "".join(f"{byte:08b}" for byte in seed) * 8
    cells = [[False] * modules for _ in range(modules)]
    k = 0
    for y in range(modules):
        for x in range(modules):
            if x == 0 or y == modules - 1:
                cells[y][x] = True
            elif y == 0 or x == modules - 1:
                cells[y][x] = (x + y) % 2 == 0
            else:
                cells[y][x] = bits[k] == "1"
                k += 1
    return cells


def preview_box_label_png(
    content: BoxLabelContent,
    *,
    profile: MaterialProfile | None = None,
    font_path: str | None = None,
) -> bytes:
    """The sticker as a PNG at printer resolution, drawn with a system TTF
    where the printer uses its own — positions and sizes are the job's."""
    from PIL import Image, ImageDraw, ImageFont

    from app.services.werkstatt_label_materials import DEFAULT_MATERIALS

    profile = profile or DEFAULT_MATERIALS[0]
    frame = wl._frame(profile)
    image = Image.new("L", (frame.w_px, frame.h_px), 235)
    draw = ImageDraw.Draw(image)

    code = wl._clean(content.code, 40)
    module, modules = _module_for(code)
    for y, row in enumerate(_placeholder_matrix(code, modules)):
        for x, dark in enumerate(row):
            if dark:
                x0, y0 = _DM_X + x * module, _DM_Y + y * module
                draw.rectangle([x0, y0, x0 + module - 1, y0 + module - 1], fill=0)

    def font(size: int):
        try:
            return ImageFont.truetype(font_path, size) if font_path else ImageFont.load_default(size=size)
        except (OSError, TypeError):
            return ImageFont.load_default()

    for text, x, y, size in _layout(frame, content, module * modules):
        draw.text((x, y), text, fill=0, font=font(size))

    logo = wl.logo_mono_image()
    if logo is not None:
        fitted = logo.copy()
        fitted.thumbnail((_LOGO_BOX_W, _LOGO_BOX_H))
        image.paste(fitted.convert("L"), (frame.w_px - _LOGO_X - fitted.width, _LOGO_Y))
    draw.rectangle([0, 0, frame.w_px - 1, frame.h_px - 1], outline=120)
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()
