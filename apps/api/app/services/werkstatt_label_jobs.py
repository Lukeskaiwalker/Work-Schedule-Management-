"""What every SMPL label job states, and the guard that keeps it on the material.

**The header.** EZPL settings are permanent: ``^H`` (darkness), ``^S``
(speed), ``^E`` (stop position) and ``^C`` (copies) stay stored in the
printer until someone sends another value — and WAGO's own software
(smartScript, GoDoctor) sends them too. A job that relied on the stored
values would print with whatever the last client left behind. So every job
states its baseline (owner decision 2, 13.10.2026)::

    ^Q…  ^W…  ^H{d}  ^S{s}  ^E{e}  ^C{n}  ^P1  ^L  …elements…  E  [^C1]

``^P`` multiplies with ``^C`` ("^C2 ^P3 … 6 pieces", EZPL p.2) and no
persistence is stated for it, so a leftover ``^P2`` could double every SMPL
print — ``^P1`` closes that (pending the owner's confirmation, D1; one
constant removes it). A job with copies > 1 ends with a standalone ``^C1``
after its ``E``, so SMPL does not leave its own copy count behind for the
next client's job. Sensor commands (``^G``, ``^XSET,SENSING``) are NOT part
of a job: whether they re-sense when sent per job is untested (T15); only the
calibration's apply sends them.

**The guard.** ``x_offset_mm`` and ``across_offset_mm`` shift every element.
Pushed too far, text would print onto the bare platen roller or past the
label's edge. ``fit_to_media`` clamps rules (``Lo``) to the material and
refuses text, codes and images that would leave it; ``offset_limits`` says
in advance how far each material's offsets may go, computed by rendering
every layout that can run on it.
"""

from __future__ import annotations

import math
import re
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, fields
from functools import lru_cache
from typing import Callable, Iterator

from app.services.werkstatt_label_errors import (
    LabelFormatUnsupported,
    LabelLayoutOutOfBounds,
    MaterialValidationError,
)
from app.services.werkstatt_label_profile import (
    MIN_CONTINUOUS_MM,  # noqa: F401 — re-exported
    TIER_KOMPAKT,
    TIER_VOLL,
    MaterialProfile,
    dots_to_mm,
    format_mm_de,
    mm_to_dots,
    printer_width_mm,
    q_value,
)

# If the physical test T5 shows that ``^E`` in a header adds a feed, flipping
# this removes it from every job. Nothing else depends on it.
JOB_HEADER_SENDS_STOP = True
# Owner decision D1 is pending: flipping this removes exactly the ``^P1`` line.
JOB_HEADER_SENDS_P1 = True

STATIC_X_OFFSET = (-5.0, 10.0)
STATIC_ACROSS = (-5.0, 5.0)
# What every profile starts with (§3.2) — a new custom material, a builtin:
# a layout must fit there to count for the offset limits.
_PROFILE_DEFAULTS = {item.name: item.default for item in fields(MaterialProfile)}
DEFAULT_X_OFFSET_MM: float = _PROFILE_DEFAULTS["x_offset_mm"]
DEFAULT_ACROSS_OFFSET_MM: float = _PROFILE_DEFAULTS["across_offset_mm"]

OUT_OF_BOUNDS_MESSAGE = "Druckbild läge außerhalb des Materials – Versatz im Material-Profil prüfen"


def job_header(profile: MaterialProfile, *, length_dots: int | None = None, copies: int = 1) -> list[str]:
    """The setup lines before ``^L`` — in this order, always.

    ``^Q``/``^W`` go out in the printer's millimetres (dots / 12) derived
    from the physical dots the job is laid out in; ``length_dots`` is a
    continuous job's content length, which the form covers (rounded up).
    """
    if profile.continuous:
        assert length_dots is not None, "continuous sheets must compute a length"
        head = [f"^Q{q_value(profile, content_dots=length_dots)}"]
    else:
        head = [f"^Q{q_value(profile)}"]
    job = profile.job_settings
    head += [f"^W{printer_width_mm(profile.width_mm)}", f"^H{job.darkness}", f"^S{job.speed_ips}"]
    if JOB_HEADER_SENDS_STOP:
        head.append(f"^E{job.stop_mm}")
    head.append(f"^C{copies}")
    if JOB_HEADER_SENDS_P1:
        head.append("^P1")
    return head


def job_footer(copies: int) -> list[str]:
    """After ``E``: reset the permanent ``^C`` so other clients print once.

    Setup outside ``^L … E`` sets a value without printing (EZPL p.75); that
    it does not shorten the job before it is checked by T5.
    """
    return ["^C1"] if copies > 1 else []


# ── The coordinate guard ───────────────────────────────────────────────────

_LO = re.compile(r"^Lo,(-?\d+),(-?\d+),(-?\d+),(-?\d+)$")
_AT = re.compile(r"^AT,(-?\d+),(-?\d+),(\d+),")
_XRB = re.compile(r"^XRB(-?\d+),(-?\d+),")
_Y = re.compile(r"^Y(-?\d+),(-?\d+),")

_guard_suspended: ContextVar[bool] = ContextVar("label_guard_suspended", default=False)


@contextmanager
def _without_guard() -> Iterator[None]:
    """Render raw element lines (for computing the limits themselves)."""
    token = _guard_suspended.set(True)
    try:
        yield
    finally:
        _guard_suspended.reset(token)


def _clamp(value: int, lo: int, hi: int | None) -> int:
    value = max(lo, value)
    return value if hi is None else min(hi, value)


def _elements(lines: list[str]) -> Iterator[tuple[str, str]]:
    """(kind, line) of every element; the data line after ``XRB`` is "data"."""
    after_matrix = False
    for line in lines:
        if after_matrix:
            after_matrix = False
            yield "data", line
            continue
        if _LO.match(line):
            yield "Lo", line
        elif _AT.match(line):
            yield "AT", line
        elif _XRB.match(line):
            after_matrix = True
            yield "XRB", line
        elif _Y.match(line):
            yield "Y", line
        else:
            yield "other", line


def _anchor_extent(kind: str, line: str) -> tuple[int, int, int] | None:
    """(x_low, x_high, y) of a raising element: the AT em box, else the anchor."""
    if kind == "AT":
        x, y, size = (int(group) for group in _AT.match(line).groups())
        return x - size, x, y
    if kind == "XRB":
        x, y = (int(group) for group in _XRB.match(line).groups())
        return x, x, y
    if kind == "Y":
        x, y = (int(group) for group in _Y.match(line).groups())
        return x, x, y
    return None


def fit_to_media(profile: MaterialProfile, lines: list[str], *, form_length_dots: int | None) -> list[str]:
    """Keep every element on the material, or refuse the job.

    Machine x must lie within the label's physical width [0, h_px] (the
    ``^W`` region, rounded up to whole printer millimetres, is never
    narrower; nor the head: past the label's edge is bare liner or roller);
    machine y ≥ 0 and, on die-cut stock, ≤ the physical label length. Rules
    are clamped (a cut mark that loses a millimetre is still a cut mark; one
    printed onto the roller is ribbon wasted on rubber); a line clamped to
    nothing is dropped. Text, codes and images raise — a clipped number is
    worse than none.
    """
    if _guard_suspended.get():
        return list(lines)
    h_px = mm_to_dots(profile.width_mm)
    out: list[str] = []
    for kind, line in _elements(lines):
        if kind == "Lo":
            x1, y1, x2, y2 = (int(group) for group in _LO.match(line).groups())
            cx1, cx2 = _clamp(x1, 0, h_px), _clamp(x2, 0, h_px)
            cy1, cy2 = _clamp(y1, 0, form_length_dots), _clamp(y2, 0, form_length_dots)
            if (cx1, cy1, cx2, cy2) == (x1, y1, x2, y2):
                out.append(line)
            elif cx1 < cx2 and cy1 < cy2:
                out.append(f"Lo,{cx1},{cy1},{cx2},{cy2}")
            continue
        extent = _anchor_extent(kind, line)
        if extent is not None:
            x_low, x_high, y = extent
            inside_x = 0 <= x_low and x_high <= h_px
            inside_y = 0 <= y and (form_length_dots is None or y <= form_length_dots)
            if not (inside_x and inside_y):
                raise LabelLayoutOutOfBounds(OUT_OF_BOUNDS_MESSAGE)
        out.append(line)
    return out


# ── Offset limits (dry render) ─────────────────────────────────────────────


@dataclass(frozen=True)
class OffsetLimits:
    """How far the offsets may go on a material, in mm (rounded inward to 0.1)."""

    x_min: float
    x_max: float
    across_min: float
    across_max: float


def _machine_content():
    from app.services.werkstatt_labels import LabelContent

    return LabelContent("M-0042", "Makita Akkuschrauber DDF485", "Makita", "SN123456")


def _voll_samples() -> list[Callable[[MaterialProfile], list[str]]]:
    from app.services import schaltplan_type_label as tl
    from app.services import werkstatt_article_labels as art
    from app.services import werkstatt_box_labels as box
    from app.services import werkstatt_labels as wl

    machine = _machine_content()
    return [
        lambda p: wl._render_voll(p, machine),
        lambda p: wl._render_quad(p, [machine, machine, machine, machine]),
        lambda p: art.render_article_label(
            p, art.ArticleLabelContent("SMPL-81JHYT", "WAGO 2016-7607 - TOPJOB S 2L-PE", "WAGO", "SP-0187", "4045454545454")
        ),
        lambda p: box.render_box_label(p, box.BoxLabelContent("KISTE-BK-2026-0001", "BK-2026-0001", "Kiste Wallbox"))[0],
        lambda p: tl.render_type_label(p, tl.TypeLabelContent("Familie Schulze", "381", "09.2026", "VT-0001"))[0],
    ]


def _strip_samples() -> list[Callable[[MaterialProfile], list[str]]]:
    from app.services import werkstatt_labels as wl

    return [
        lambda p: wl._render_rail_strip(p, [("F1", 17.5), ("F2", 35)], size=36),
        lambda p: wl._render_block_label(
            p, name="PV Wechselrichter", x_label="X1", cells=[("N", 5), ("L1", 5), ("L2", 5), ("L3", 5), ("PE", 5)]
        ),
    ]


def dry_render_samples(profile: MaterialProfile, *, pattern: bool) -> list[Callable[[MaterialProfile], list[str]]]:
    """Every renderer that can run on this material, with fixed sample content.

    voll tier: machine label, klein quad, article, box and type label;
    kompakt tier: the kompakt label; mini tier and every continuous material:
    the mini label with a short, a typical and a long text; the 2009-110 also
    the rail strip and the block label; the measuring pattern when supported.
    """
    from app.services import werkstatt_labels as wl
    from app.services.werkstatt_label_patterns import pattern_job

    samples: list[Callable[[MaterialProfile], list[str]]] = []
    if profile.tier == TIER_VOLL:
        samples += _voll_samples()
    elif profile.tier == TIER_KOMPAKT:
        machine = _machine_content()
        samples.append(lambda p: wl._render_kompakt(p, machine))
    if profile.tier not in (TIER_VOLL, TIER_KOMPAKT) or profile.continuous:
        samples += [lambda p, text=text: wl._render_mini(p, text) for text in ("M-0042", "F1.1", "Herd Küche 16A")]
    if profile.id == wl.MARKING_STRIP_MATERIAL_ID:
        samples += _strip_samples()
    if pattern:
        samples.append(lambda p: pattern_job(p)[0])
    return samples


def _job_elements(job: list[str]) -> list[str]:
    start = job.index("^L") + 1
    end = len(job) - 1 - job[::-1].index("E")
    return job[start:end]


def _inward(value: float, *, up: bool) -> float:
    scaled = value * 10
    return (math.ceil(scaled - 1e-9) if up else math.floor(scaled + 1e-9)) / 10


def _sample_extents(render: Callable[[MaterialProfile], list[str]], profile: MaterialProfile) -> list[tuple[int, int, int]]:
    """The raising elements' extents of one sample at offsets 0 — none when
    the sample cannot run here or leaves the material at the default offsets."""
    try:
        job = render(profile)
    except (LabelFormatUnsupported, ValueError):
        return []
    extents = [extent for kind, line in _elements(_job_elements(job)) if (extent := _anchor_extent(kind, line)) is not None]
    h_px = mm_to_dots(profile.width_mm)
    form_length = None if profile.continuous else mm_to_dots(profile.length_mm)
    dx, dy = mm_to_dots(DEFAULT_ACROSS_OFFSET_MM), mm_to_dots(DEFAULT_X_OFFSET_MM)
    for x_low, x_high, y in extents:
        if x_low + dx < 0 or x_high + dx > h_px or y + dy < 0 or (form_length is not None and y + dy > form_length):
            return []
    return extents


@lru_cache(maxsize=64)
def _limits_for(key: tuple) -> OffsetLimits:
    """A sample that leaves the material at the default offsets does not count.

    It is a layout that does not fit this material — the voll layouts were
    drawn for 44 mm and overhang a 40-mm label — and no offset is to blame;
    the guard refuses it at print time as before. Counted, it could demand
    the opposite correction of another layout (40 × 100: across ≥ 1,4 for
    the machine label, ≤ 1,0 for the quad) and leave an empty range that
    refused every offset, so the material could not even be renamed. Every
    counted sample fits at the defaults every profile starts with, so the
    limits always contain them and are never empty.
    """
    profile_id, _tier, width_mm, length_mm, gap_mm, mark_width_mm, pattern = key
    profile = MaterialProfile(
        id=profile_id, name=profile_id, part_no="", width_mm=width_mm, length_mm=length_mm,
        gap_mm=gap_mm, x_offset_mm=0.0, across_offset_mm=0.0, mark_width_mm=mark_width_mm,
    )
    extents: list[tuple[int, int, int]] = []
    with _without_guard():
        for render in dry_render_samples(profile, pattern=pattern):
            extents += _sample_extents(render, profile)
    if not extents:
        return OffsetLimits(STATIC_X_OFFSET[0], STATIC_X_OFFSET[1], STATIC_ACROSS[0], STATIC_ACROSS[1])
    h_px = mm_to_dots(width_mm)
    min_x = min(low for low, _, _ in extents)
    max_x = max(high for _, high, _ in extents)
    min_y = min(y for _, _, y in extents)
    max_y = max(y for _, _, y in extents)
    x_max = STATIC_X_OFFSET[1]
    if length_mm is not None:
        x_max = min(x_max, _inward(dots_to_mm(mm_to_dots(length_mm) - max_y), up=False))
    return OffsetLimits(
        x_min=max(STATIC_X_OFFSET[0], _inward(dots_to_mm(-min_y), up=True)),
        x_max=x_max,
        across_min=max(STATIC_ACROSS[0], _inward(dots_to_mm(-min_x), up=True)),
        across_max=min(STATIC_ACROSS[1], _inward(dots_to_mm(h_px - max_x), up=False)),
    )


def offset_limits(profile: MaterialProfile) -> OffsetLimits:
    """The offsets inside which every sample layout that fits the material
    (at the default offsets) stays on it; the range always contains the
    defaults, so it is never empty.

    Samples render at offsets 0 and coordinates shift linearly with both
    offsets, so the limits are exact for the samples; other content (a longer
    text, another font size) can still hit the guard at print time, and the
    route then answers with the German text. The result depends only on the
    geometry, so it is cached — GET overview/settings must not re-render type
    labels with QR codes on every request.
    """
    from app.services.werkstatt_label_patterns import pattern_supported

    key = (
        profile.id,
        profile.tier,
        float(profile.width_mm),
        None if profile.length_mm is None else float(profile.length_mm),
        float(profile.gap_mm),
        None if profile.mark_width_mm is None else float(profile.mark_width_mm),
        pattern_supported(profile),
    )
    return _limits_for(key)


def dry_render_checks(profile: MaterialProfile) -> None:
    """Profile writes: offsets inside ``offset_limits``, else a German error."""
    limits = offset_limits(profile)
    label = profile.name or profile.id
    for axis, value, low, high in (
        ("Vorschub", profile.x_offset_mm, limits.x_min, limits.x_max),
        ("quer", profile.across_offset_mm, limits.across_min, limits.across_max),
    ):
        if value < low - 1e-9 or value > high + 1e-9:
            raise MaterialValidationError(
                f"{label}: Versatz {axis} muss für dieses Material zwischen {format_mm_de(low)} und "
                f"{format_mm_de(high)} mm liegen – sonst läge das Druckbild außerhalb des Materials"
            )

