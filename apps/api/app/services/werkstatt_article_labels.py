"""The shelf label of a stock article — what "Etikett drucken" prints for a
box of terminals, on the 99 × 44 type label.

Not the machine label. A drill's label is about the one tool it is stuck
to (its M-number big, logo, footer); a shelf label is about WHAT is in the
box, read from a metre away while picking: the manufacturer's part number
large, the description under it, and beside them the DataMatrix of our
internal code so the scan station books the box in and out. The code's
text sits small under its matrix — it is scanned, not typed.

An SMPL-XXXXXX code is ten DataMatrix codewords, which the printer encodes
as a 16 × 16 symbol; the machine layout assumes 12 × 12 for its short
M-numbers, and the wider symbol is what ran into the text column on the
first article label printed (2026-09-23). Everything here is laid out for
the 16 × 16 symbol.
"""

from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.services import werkstatt_labels as wl
from app.services.werkstatt_label_materials import TIER_VOLL, MaterialProfile, active_material

# ── Layout, reading frame in printer dots (12 per mm) on the 99 × 44 sheet ──

_DM_X, _DM_Y, _DM_MODULE = 36, 150, 11
_DM_SYMBOL_MODULES = 16  # ECC200 for 9..12 codewords — an SMPL code is 10
_DM_SIZE = _DM_MODULE * _DM_SYMBOL_MODULES  # 176 dots, 14.7 mm — scans at arm's length
_CODE_Y, _CODE_SIZE = _DM_Y + _DM_SIZE + 14, 28

_COL_X = 252
_HEAD_Y, _HEAD_MAX, _HEAD_MIN = 44, 96, 44
_DESC_Y, _DESC_MAX, _DESC_MIN, _DESC_LINES, _DESC_LEADING = 168, 50, 26, 2, 1.25
_FOOT_Y, _FOOT_SIZE = 458, 30

# "WAGO 2016-7607 - TOPJOB S …": the catalog names lead with the part
# number and separate the description with " - ". A head longer than this
# is prose, not a part number, and the whole name becomes the description.
_HEAD_MAX_CHARS = 26


@dataclass(frozen=True)
class ArticleLabelContent:
    code: str  # the internal code the matrix encodes, e.g. SMPL-81JHYT
    item_name: str
    manufacturer: str | None = None
    article_number: str | None = None  # SP-0187
    ean: str | None = None


def split_item_name(item_name: str, manufacturer: str | None) -> tuple[str, str]:
    """(head, description): the part number line and the rest.

    "WAGO 2016-7607 - TOPJOB S 2L-PE …" → ("WAGO 2016-7607", "TOPJOB S 2L-PE …").
    A name without the separator has no head; the manufacturer then serves
    as the head when it is not already the start of the name, so the label
    still says whose part it is.
    """
    name = wl._clean(item_name, 120)
    maker = wl._clean(manufacturer or "", 40)
    head, sep, rest = name.partition(" - ")
    if sep and 0 < len(head) <= _HEAD_MAX_CHARS and rest.strip():
        return head.strip(), rest.strip()
    if maker and not name.lower().startswith(maker.lower()):
        return maker, name
    return "", name


def _xrb_16(frame: wl._Frame, reading_x: int, reading_y: int, module: int, data: str) -> list[str]:
    """A DataMatrix anchored so a 16 × 16 symbol sits at the reading-frame
    top-left given — ``werkstatt_labels._xrb`` assumes the 12 × 12 symbol of
    a short M-number."""
    symbol = _DM_SYMBOL_MODULES * module
    return [
        f"XRB{frame.xm(reading_y + symbol)},{frame.ym(reading_x)},{module},0,{len(data.encode(wl._ENCODING))}",
        data,
    ]


def _layout(frame: wl._Frame, content: ArticleLabelContent) -> list[tuple[str, int, int, int]]:
    """The text as (text, reading_x, reading_y, size) — one source for the
    printer job and the on-screen preview."""
    budget = frame.w_px - _COL_X - wl._MARGIN
    head, description = split_item_name(content.item_name, content.manufacturer)
    out: list[tuple[str, int, int, int]] = []
    code = wl._clean(content.code, 20)
    out.append((code, _DM_X, _CODE_Y, _CODE_SIZE))
    y = _HEAD_Y
    if head:
        size = wl._fit_text_size(head, budget, _HEAD_MAX, _HEAD_MIN)
        out.append((head, _COL_X, y, size))
        y = _DESC_Y
    lines = wl._wrap_words(description, _DESC_LINES) if description else []
    if lines:
        size = min(wl._fit_text_size(line, budget, _DESC_MAX, _DESC_MIN) for line in lines)
        for line in lines:
            out.append((line, _COL_X, y, size))
            y += int(size * _DESC_LEADING)
    foot = " · ".join(
        part for part in (wl._clean(content.article_number or "", 20), f"EAN {wl._clean(content.ean, 20)}" if content.ean else "") if part
    )
    if foot:
        out.append((foot, _COL_X, _FOOT_Y, _FOOT_SIZE))
    return out


def render_article_label(profile: MaterialProfile, content: ArticleLabelContent) -> list[str]:
    """The EZPL job for one shelf label on voll-tier stock."""
    frame = wl._frame(profile)
    lines = _xrb_16(frame, _DM_X, _DM_Y, _DM_MODULE, wl._clean(content.code, 20))
    for text, x, y, size in _layout(frame, content):
        lines.append(wl._at(frame, x, y, size, text))
    return wl._sheet(profile, lines)


def print_article_labels(db: Session, contents: list[ArticleLabelContent]) -> tuple[int, str]:
    """Ship one job per article in ONE connection; returns (sheets, "host:port")."""
    if not contents:
        raise ValueError("nothing to print")
    profile = active_material(db)
    if profile.tier != TIER_VOLL:
        raise wl.LabelFormatUnsupported(
            "Das Artikel-Etikett braucht ein großes Etikett (z. B. WAGO 210-804/-824) — "
            f"aktiv ist „{profile.name}“"
        )
    payload = b""
    for content in contents:
        payload += ("\r\n".join(render_article_label(profile, content)) + "\r\n").encode(wl._ENCODING)
    printer = wl._ship(db, payload)
    wl.logger.info("Article labels sent to %s — %d sheet(s), %d bytes", printer, len(contents), len(payload))
    return len(contents), printer


def print_article_label(db: Session, content: ArticleLabelContent) -> str:
    _, printer = print_article_labels(db, [content])
    return printer


# ── Preview ──────────────────────────────────────────────────────────────────


def _placeholder_matrix(code: str) -> list[list[bool]]:
    """A 16 × 16 stand-in with DataMatrix's solid L finder (left, bottom) and
    dashed top/right edges, the inside seeded from the code — the preview
    shows where the symbol sits and how big it is, not a scannable one."""
    n = _DM_SYMBOL_MODULES
    seed = hashlib.sha1(code.encode("utf-8")).digest()
    bits = "".join(f"{byte:08b}" for byte in seed) * 4
    cells = [[False] * n for _ in range(n)]
    k = 0
    for y in range(n):
        for x in range(n):
            if x == 0 or y == n - 1:
                cells[y][x] = True
            elif y == 0 or x == n - 1:
                cells[y][x] = (x + y) % 2 == 0
            else:
                cells[y][x] = bits[k] == "1"
                k += 1
    return cells


def preview_article_label_png(
    content: ArticleLabelContent,
    *,
    profile: MaterialProfile | None = None,
    font_path: str | None = None,
    bold_font_path: str | None = None,
) -> bytes:
    """The label as a PNG at printer resolution (12 px/mm), drawn with a
    system TTF where the printer uses its own — sizes and positions are the
    job's, glyph shapes are approximate."""
    from PIL import Image, ImageDraw, ImageFont

    from app.services.werkstatt_label_materials import DEFAULT_MATERIALS

    profile = profile or DEFAULT_MATERIALS[0]
    frame = wl._frame(profile)
    image = Image.new("L", (frame.w_px, frame.h_px), 235)  # silver stock
    draw = ImageDraw.Draw(image)

    cells = _placeholder_matrix(content.code)
    for y, row in enumerate(cells):
        for x, dark in enumerate(row):
            if dark:
                x0, y0 = _DM_X + x * _DM_MODULE, _DM_Y + y * _DM_MODULE
                draw.rectangle([x0, y0, x0 + _DM_MODULE - 1, y0 + _DM_MODULE - 1], fill=0)

    def font(size: int, bold: bool):
        path = bold_font_path if bold else font_path
        try:
            return ImageFont.truetype(path, size) if path else ImageFont.load_default(size=size)
        except (OSError, TypeError):
            return ImageFont.load_default()

    items = _layout(frame, content)
    for index, (text, x, y, size) in enumerate(items):
        # The head (second item, right after the code) carries the weight.
        bold = index == 1 and bool(split_item_name(content.item_name, content.manufacturer)[0])
        draw.text((x, y), text, fill=0, font=font(size, bold))
    draw.rectangle([0, 0, frame.w_px - 1, frame.h_px - 1], outline=120)
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()
