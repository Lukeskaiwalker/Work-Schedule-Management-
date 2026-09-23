"""The Schrank-Etikett: the type label stuck on a finished Verteiler.

Rendered from the owner's WAGO Smart Script blueprint ("Schrank Label.wssl",
template 2100804 = the silver 99 × 44 mm type label 210-804) as EZPL for the
WAGO 258-5101, through the same reading-frame helpers the machine labels are
printed with. The blueprint's geometry is carried over proportionally: the
Smart Script strip is 1854.5 × 840 units for 99 × 44 mm.

What the label shows, and where it comes from:

* top-left — the company logo (the same asset the machine labels print,
  fitted into the blueprint's box);
* top-right — a QR code for the company website;
* left, under the logo — "Kunde: …", "Projekt: …", "Baujahr: MM.YYYY",
  the customer from the panel's customer row, the project number from its
  project, the build month defaulting to the month of printing;
* bottom-right, centred — the e-mail and the phone number.

The website, e-mail and phone number are fixed branding like
``werkstatt_labels._FOOTER_TEXT`` — not the runtime company setting, so a
reworded admin setting cannot silently change what is stuck on a customer's
switchboard. The label is printed on voll-tier stock only; refusing beats
printing a clipped nameplate on a 15 × 6 label.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from app.services import werkstatt_labels as wl
from app.services.werkstatt_label_materials import TIER_VOLL, MaterialProfile, active_material

# ── Fixed branding (owner's blueprint) ────────────────────────────────────────

TYPE_LABEL_URL = "https://smpl-energy.de"
TYPE_LABEL_CONTACT_LINES: tuple[str, ...] = ("info@smpl-energy.de", "02302/ 2894980")

# The Verteiler is built in Germany; "this month" is the German month even
# when the container's clock is UTC at the turn of a month.
LOCAL_TZ = ZoneInfo("Europe/Berlin")
BUILD_MONTH_RE = re.compile(r"^(0[1-9]|1[0-2])\.(\d{4})$")

# ── Blueprint geometry, reading frame in printer dots (12 per mm) ─────────────
#
# Positions are the blueprint's, scaled from Smart Script units to dots
# (x: 99 mm / 1854.5 units, y: 44 mm / 840 units, both × 12 dots/mm).
_LOGO_X, _LOGO_Y, _LOGO_BOX_W, _LOGO_BOX_H = 35, 25, 388, 178
# The QR component's box is 268 × 225 dots; the symbol is square and sits
# centred in the box's width at the box's top.
_QR_BOX_X, _QR_BOX_Y, _QR_BOX_W = 920, 13, 268
_QR_MODULE_PX = 7  # 0.58 mm per module — a version-2 symbol prints 19 mm wide
_QR_QUIET_MODULES = 4
# The three-line block: bold 3.4 mm text in the blueprint; the printer's
# built-in TTF has no bold, so the size carries the weight. The width budget
# runs past the blueprint's box to the edge of the contact block: a long
# customer name then keeps the size instead of shrinking the whole block.
_TEXT_X, _TEXT_BUDGET = 41, 600
_TEXT_LINES_Y = (205, 247, 289)
_TEXT_SIZE_MAX, _TEXT_SIZE_MIN = 42, 26
# The contact block: centred in the blueprint's box (x 668..1177, y 384..507).
_CONTACT_CENTER_X, _CONTACT_BUDGET = 922, 500
_CONTACT_LINES_Y = (404, 446)
_CONTACT_SIZE = 40


@dataclass(frozen=True)
class TypeLabelContent:
    customer: str
    project_number: str | None
    build_month: str  # "MM.YYYY"


def current_build_month(now: datetime | None = None) -> str:
    moment = now if now is not None else datetime.now(LOCAL_TZ)
    if moment.tzinfo is not None:
        moment = moment.astimezone(LOCAL_TZ)
    return moment.strftime("%m.%Y")


def normalize_build_month(raw: str | None) -> str:
    """"MM.YYYY" as typed, blank or absent = this month; anything else is a
    ValueError with the German message the dialog shows."""
    value = (raw or "").strip()
    if not value:
        return current_build_month()
    if not BUILD_MONTH_RE.match(value):
        raise ValueError("Baujahr bitte als MM.JJJJ angeben, z. B. 09.2026")
    return value


def material_supports_type_label(profile: MaterialProfile) -> bool:
    return profile.tier == TIER_VOLL


def type_label_material_error(profile: MaterialProfile) -> str:
    return (
        "Für das Schrank-Etikett muss ein 99 × 44 Etikett (WAGO 210-804) eingelegt sein — "
        f"aktiv ist „{profile.name}“"
    )


# ── Assets ────────────────────────────────────────────────────────────────────


def qr_matrix(text: str) -> list[list[bool]]:
    """The QR modules for ``text`` including the quiet zone, one list per row."""
    import qrcode

    symbol = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=1, border=_QR_QUIET_MODULES)
    symbol.add_data(text)
    symbol.make(fit=True)
    return [list(row) for row in symbol.get_matrix()]


@lru_cache(maxsize=4)
def qr_asset(text: str) -> tuple[str, bytes, int, int]:
    """The QR symbol as a printer flash asset at ``_QR_MODULE_PX`` per module."""
    from PIL import Image

    modules = qr_matrix(text)
    n = len(modules)
    image = Image.new("L", (n, n), 255)
    pixels = image.load()
    for y, row in enumerate(modules):
        for x, dark in enumerate(row):
            if dark:
                pixels[x, y] = 0
    scaled = image.resize((n * _QR_MODULE_PX, n * _QR_MODULE_PX), Image.NEAREST)
    return wl.mono_image_asset(scaled, prefix="QR")


def qr_svg(text: str) -> bytes:
    """The same symbol for the on-screen preview."""
    import qrcode
    from qrcode.image.svg import SvgPathImage

    symbol = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=10, border=_QR_QUIET_MODULES)
    symbol.add_data(text)
    symbol.make(fit=True)
    return symbol.make_image(image_factory=SvgPathImage).to_string()


def logo_png() -> bytes | None:
    """The logo as it prints, for the on-screen preview; None without a logo file."""
    mono = wl.logo_mono_image()
    if mono is None:
        return None
    buf = io.BytesIO()
    mono.save(buf, format="PNG")
    return buf.getvalue()


# ── Rendering ─────────────────────────────────────────────────────────────────


def _centered_text(frame: wl._Frame, center_x: int, reading_y: int, size: int, text: str) -> str:
    left = max(wl._MARGIN, center_x - wl._est_text_w(text, size) // 2)
    return wl._at(frame, left, reading_y, size, text)


def render_type_label(profile: MaterialProfile, content: TypeLabelContent, *, copies: int = 1) -> tuple[list[str], list[tuple[str, bytes, int, int] | None]]:
    """The EZPL job (one sheet, ``copies`` prints) and the assets it places."""
    frame = wl._frame(profile)
    logo = wl.logo_asset_for_box(_LOGO_BOX_W, _LOGO_BOX_H)
    qr = qr_asset(TYPE_LABEL_URL)

    lines: list[str] = []
    if logo is not None:
        lines.append(wl.place_image(frame, logo, _LOGO_X, _LOGO_Y))
    qr_x = _QR_BOX_X + max(0, (_QR_BOX_W - qr[2]) // 2)
    lines.append(wl.place_image(frame, qr, qr_x, _QR_BOX_Y))

    texts = (
        f"Kunde: {wl._clean(content.customer, 60)}",
        f"Projekt: {wl._clean(content.project_number or '—', 30)}",
        f"Baujahr: {wl._clean(content.build_month, 10)}",
    )
    # One size for the block, fitted to its longest line, so the three lines
    # read as one paragraph the way the blueprint sets them.
    size = min(wl._fit_text_size(text, _TEXT_BUDGET, _TEXT_SIZE_MAX, _TEXT_SIZE_MIN) for text in texts)
    for reading_y, text in zip(_TEXT_LINES_Y, texts):
        lines.append(wl._at(frame, _TEXT_X, reading_y, size, text))

    for reading_y, text in zip(_CONTACT_LINES_Y, TYPE_LABEL_CONTACT_LINES):
        contact_size = wl._fit_text_size(text, _CONTACT_BUDGET, _CONTACT_SIZE, _TEXT_SIZE_MIN)
        lines.append(_centered_text(frame, _CONTACT_CENTER_X, reading_y, contact_size, text))

    return wl._sheet(profile, lines, copies=copies), [logo, qr]


def print_type_label(db: Session, content: TypeLabelContent, *, copies: int = 1) -> tuple[str, MaterialProfile]:
    """Render and ship the label on the active stock; returns ("host:port", profile)."""
    profile = active_material(db)
    if not material_supports_type_label(profile):
        raise wl.LabelFormatUnsupported(type_label_material_error(profile))
    job, assets = render_type_label(profile, content, copies=max(1, copies))
    payload = wl.image_download_preamble(assets) + ("\r\n".join(job) + "\r\n").encode(wl._ENCODING)
    printer = wl._ship(db, payload)
    wl.logger.info("Type label sent to %s — %d cop(y/ies), %d bytes", printer, copies, len(payload))
    return printer, profile
