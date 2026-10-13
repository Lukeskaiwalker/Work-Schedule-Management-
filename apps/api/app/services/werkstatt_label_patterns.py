"""The measuring pattern: a box the operator measures with a caliper.

Printed through the normal job path (``_frame``/``_at``/``_sheet``), so it
carries the job header and the profile's CURRENT offsets — what the operator
measures is the remaining error, and the wizard corrects by that.

Die-cut stock gets four lines inset from the label edges (A leaves the
printer first, B trails, L is the reading top, R the bottom), a centre cross,
the letters A and L where there is room, a short text and a millimetre ruler
along the bottom. Only edge A gives the feed offset: the trailing line is
placed from the profile length, and when the real label is shorter (the
printer measured 97,0 mm for 99 mm stock) B is small or falls into the gap.

Continuous stock gets side lines 1 mm from both edges, start/end bars and
5 mm ticks — no feed correction is possible without a label edge.

Multi-lane rolls (the 210-805: two lanes ≈ 15 × 6, printed one lane 6 × 15)
are unsupported: a 6 × 15 box would cross the real gaps and the centre slit,
and correcting 805's offsets from it would change its printing, which this
build leaves alone (T8 decides).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.services import werkstatt_labels as wl
from app.services.werkstatt_label_builtins import pattern_length_mm
from app.services.werkstatt_label_errors import PatternUnsupported
from app.services.werkstatt_label_profile import DOTS_PER_MM, MaterialProfile, mm_int

LINE_DOTS = 3  # t: line weight of the die-cut box
RULER_TICK_DOTS = 36  # the 10-mm ticks, the tallest
RULER_NUMBER_RISE_DOTS = 66  # the numbers' top edge above the ruler baseline
_NOT_IN_AT_TEXT = re.compile(r"[^\x20-\x5D\x5F-\x7D]")


@dataclass(frozen=True)
class PatternGeometry:
    """What the UI needs to draw "what to measure" (mm)."""

    kind: str  # "diecut" | "continuous"
    width_mm: float
    length_mm: float
    inset_mm: float
    line_mm: float
    letters: bool
    ruler_from_mm: int | None
    ruler_to_mm: int | None
    side_line_inset_mm: float | None
    bar_inset_mm: float | None
    feed_measurable: bool
    across_measurable: bool


def pattern_supported(profile: MaterialProfile) -> bool:
    """False whenever the physical roll is not the print geometry."""
    web = profile.web
    if web.lanes > 1:
        return False
    if web.label_across_mm is not None and abs(web.label_across_mm - profile.width_mm) > 1e-9:
        return False
    if not profile.continuous and web.label_along_mm is not None and abs(web.label_along_mm - profile.length_mm) > 1e-9:
        return False
    return True


def pattern_ascii(text: str) -> str:
    """Map text into the allow-list's AT character class (non-ASCII → "?").

    A custom part number like "Brady® Ø3" must never make the calibration's
    command check fail — that would be a 500 for a valid profile.
    """
    return _NOT_IN_AT_TEXT.sub("?", text)


def pattern_text(profile: MaterialProfile) -> str:
    return ("SMPL KAL " + pattern_ascii(wl._clean(profile.part_no, 20))).rstrip()


def _box(frame: wl._Frame, x0: int, x1: int, y0: int, y1: int) -> str:
    """A filled reading-frame rectangle x [x0, x1] × y [y0, y1] as one ``Lo``."""
    return f"Lo,{frame.xm(y1)},{frame.ym(x0)},{frame.xm(y0)},{frame.ym(x1)}"


def _diecut_lines(profile: MaterialProfile) -> tuple[list[str], PatternGeometry]:
    frame = wl._frame(profile)
    width, length = mm_int(profile.width_mm), mm_int(profile.length_mm)
    h, w, t = frame.h_px, frame.w_px, LINE_DOTS
    i = 24 if min(width, length) >= 12 else 12
    a = min(36, h // 4, w // 4)
    lines = [
        _box(frame, i, i + t, i, h - i),  # A — leading edge, leaves the printer first
        _box(frame, w - i - t, w - i, i, h - i),  # B — trailing edge
        _box(frame, i, w - i, i, i + t),  # L — reading top
        _box(frame, i, w - i, h - i - t, h - i),  # R — reading bottom
        _box(frame, w // 2 - a, w // 2 + a, h // 2 - 1, h // 2 + 1),  # cross, feed arm
        _box(frame, w // 2 - 1, w // 2 + 1, h // 2 - a, h // 2 + a),  # cross, across arm
    ]
    letters = min(width, length) >= 20
    if letters:
        lines.append(wl._at(frame, i + t + 12, h // 2 + 48, 36, "A"))
        lines.append(wl._at(frame, w // 2 + 48, i + t + 12, 36, "L"))
    if width >= 25 and length >= 50:
        lines.append(wl._at(frame, i + t + 12, i + t + 12, 24, pattern_text(profile)))
    ruler_to = None
    baseline = h - i - t - 12
    # Ticks (up to 36 dots) and numbers (66 dots above the baseline) only
    # where they stay below the top line: on a narrow label the ticks would
    # be clamped into a smear and the numbers would leave the material — the
    # guard then refused the whole pattern at every offset.
    if length >= 50 and baseline - RULER_TICK_DOTS >= i + t:
        ruler_to = 10 * ((length - 9) // 10)
        for k in range(10, ruler_to + 1):
            height = RULER_TICK_DOTS if k % 10 == 0 else 24 if k % 5 == 0 else 12
            lines.append(_box(frame, 12 * k - 1, 12 * k + 1, baseline - height, baseline))
        if baseline - RULER_NUMBER_RISE_DOTS >= i + t:
            for k in range(10, ruler_to + 1, 10):
                number = str(k)
                lines.append(wl._at(frame, 12 * k - wl._est_text_w(number, 24) // 2, baseline - RULER_NUMBER_RISE_DOTS, 24, number))
    geometry = PatternGeometry(
        kind="diecut",
        width_mm=float(width),
        length_mm=float(length),
        inset_mm=i / DOTS_PER_MM,
        line_mm=0.25,
        letters=letters,
        ruler_from_mm=10 if ruler_to is not None else None,
        ruler_to_mm=ruler_to,
        side_line_inset_mm=None,
        bar_inset_mm=None,
        feed_measurable=True,
        across_measurable=profile.guide == "fit",
    )
    return wl._sheet(profile, lines), geometry


def _continuous_lines(profile: MaterialProfile) -> tuple[list[str], PatternGeometry]:
    width = mm_int(profile.width_mm)
    length = pattern_length_mm(profile)
    pw = length * DOTS_PER_MM
    frame = wl._frame(profile, w_px=pw)
    h = frame.h_px
    lines = [
        _box(frame, 36, pw - 36, 12, 14),  # side line, edge L
        _box(frame, 36, pw - 36, h - 14, h - 12),  # side line, edge R
        _box(frame, 34, 38, 12, h - 12),  # start bar
        _box(frame, pw - 38, pw - 34, 12, h - 12),  # end bar
    ]
    tick = min(24, h // 3)
    for mm in range(5, length - 4, 5):
        lines.append(_box(frame, 12 * mm - 1, 12 * mm + 1, 14, 14 + tick))
    letters = width >= 10
    if letters:
        lines.append(wl._at(frame, pw // 2, 18, min(36, h - 40), "L"))
    geometry = PatternGeometry(
        kind="continuous",
        width_mm=float(width),
        length_mm=float(length),
        inset_mm=1.0,
        line_mm=0.25,
        letters=letters,
        ruler_from_mm=None,
        ruler_to_mm=None,
        side_line_inset_mm=1.0,
        bar_inset_mm=3.0,
        feed_measurable=False,
        across_measurable=profile.guide == "fit",
    )
    # Same length rule as the strips: the print origin sits x_offset before
    # the edge, so the form must include it or the end bar lands on the tear.
    return wl._sheet(profile, lines, length_mm=(pw + frame.x_offset_px) / DOTS_PER_MM), geometry


def pattern_job(profile: MaterialProfile) -> tuple[list[str], PatternGeometry]:
    """The measuring pattern as one job (``^C1``, never copies)."""
    if not pattern_supported(profile):
        raise PatternUnsupported("Messmuster für mehrbahniges Material folgt nach dem Praxistest (T8)")
    if profile.continuous:
        return _continuous_lines(profile)
    return _diecut_lines(profile)
