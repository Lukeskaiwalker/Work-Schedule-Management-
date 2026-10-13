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

Every distance is a physical millimetre (``mm_to_dots``, 300 dpi): the
ruler's 10 → 90 is 945 dots, so a steel rule reads 80,0 mm when the printer
feeds true to its 300 dpi. Until 2026-10 it was drawn at 12 dots per mm and
read 81,5 (physical test T4). Line weights and font sizes are dots.

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
from app.services.werkstatt_label_profile import MaterialProfile, mm_int, mm_to_dots

LINE_DOTS = 3  # t: line weight of the die-cut box (0,25 mm)
RULER_TICK_DOTS = mm_to_dots(3)  # the 10-mm ticks, the tallest
RULER_MID_TICK_DOTS = mm_to_dots(2)  # every 5 mm
RULER_MINOR_TICK_DOTS = mm_to_dots(1)  # every millimetre
RULER_NUMBER_RISE_DOTS = mm_to_dots(5.5)  # the numbers' top edge above the ruler baseline
_ONE_MM = mm_to_dots(1)
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


def _tick(frame: wl._Frame, mm: float, y0: int, y1: int) -> str:
    """A 2-dot tick centred on the physical millimetre ``mm`` along the feed."""
    centre = mm_to_dots(mm)
    return _box(frame, centre - 1, centre + 1, y0, y1)


def _diecut_lines(profile: MaterialProfile) -> tuple[list[str], PatternGeometry]:
    frame = wl._frame(profile)
    width, length = mm_int(profile.width_mm), mm_int(profile.length_mm)
    h, w, t = frame.h_px, frame.w_px, LINE_DOTS
    inset_mm = 2.0 if min(width, length) >= 12 else 1.0
    i = mm_to_dots(inset_mm)
    a = min(mm_to_dots(3), h // 4, w // 4)
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
        lines.append(wl._at(frame, i + t + _ONE_MM, h // 2 + mm_to_dots(4), 36, "A"))
        lines.append(wl._at(frame, w // 2 + mm_to_dots(4), i + t + _ONE_MM, 36, "L"))
    if width >= 25 and length >= 50:
        lines.append(wl._at(frame, i + t + _ONE_MM, i + t + _ONE_MM, 24, pattern_text(profile)))
    ruler_to = None
    baseline = h - i - t - _ONE_MM
    # Ticks (up to 3 mm) and numbers (5,5 mm above the baseline) only
    # where they stay below the top line: on a narrow label the ticks would
    # be clamped into a smear and the numbers would leave the material — the
    # guard then refused the whole pattern at every offset.
    if length >= 50 and baseline - RULER_TICK_DOTS >= i + t:
        ruler_to = 10 * ((length - 9) // 10)
        for k in range(10, ruler_to + 1):
            height = RULER_TICK_DOTS if k % 10 == 0 else RULER_MID_TICK_DOTS if k % 5 == 0 else RULER_MINOR_TICK_DOTS
            lines.append(_tick(frame, k, baseline - height, baseline))
        if baseline - RULER_NUMBER_RISE_DOTS >= i + t:
            for k in range(10, ruler_to + 1, 10):
                number = str(k)
                lines.append(wl._at(frame, mm_to_dots(k) - wl._est_text_w(number, 24) // 2, baseline - RULER_NUMBER_RISE_DOTS, 24, number))
    geometry = PatternGeometry(
        kind="diecut",
        width_mm=float(width),
        length_mm=float(length),
        inset_mm=inset_mm,
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
    pw = mm_to_dots(length)
    frame = wl._frame(profile, w_px=pw)
    h = frame.h_px
    side, bar = _ONE_MM, mm_to_dots(3)  # side lines 1 mm in, bars 3 mm in
    lines = [
        _box(frame, bar, pw - bar, side, side + 2),  # side line, edge L
        _box(frame, bar, pw - bar, h - side - 2, h - side),  # side line, edge R
        _box(frame, bar - 2, bar + 2, side, h - side),  # start bar
        _box(frame, pw - bar - 2, pw - bar + 2, side, h - side),  # end bar
    ]
    tick = min(mm_to_dots(2), h // 3)
    for mm in range(5, length - 4, 5):
        lines.append(_tick(frame, mm, side + 2, side + 2 + tick))
    letters = width >= 10
    if letters:
        lines.append(wl._at(frame, pw // 2, mm_to_dots(1.5), min(36, h - 40), "L"))
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
    return wl._sheet(profile, lines, length_dots=pw + frame.x_offset_px), geometry


def pattern_job(profile: MaterialProfile) -> tuple[list[str], PatternGeometry]:
    """The measuring pattern as one job (``^C1``, never copies)."""
    if not pattern_supported(profile):
        raise PatternUnsupported("Messmuster für mehrbahniges Material folgt nach dem Praxistest (T8)")
    if profile.continuous:
        return _continuous_lines(profile)
    return _diecut_lines(profile)
