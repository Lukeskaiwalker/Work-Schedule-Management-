"""The material profile of the Werkstatt label printer — data only.

A profile has two geometries on purpose. The PRINT geometry (``width_mm``,
``length_mm``, ``gap_mm``, the black mark) is what SMPL sends as ``^W``/``^Q``
and lays labels out on. The PHYSICAL roll (``web``) is what the operator
loads: lanes, label size on the liner, liner width. They differ for the
210-805, which WAGO ships two lanes wide while SMPL still prints it one lane
6 × 15 — the guide, the sensor diagram and the verify step must describe the
real roll, the renderers must not change.

``darkness``/``speed_ips``/``stop_mm`` are the admin's STORED overrides
(None = the printer baseline). What a job actually sends is resolved against
the baseline and attached as ``job`` by the materials reader; profiles built
directly in tests fall back to ``CODE_BASELINE`` through ``job_settings``.

``sensor_scale`` is the reading the sensor carriage's ▲▼ pointer must show on
the printed scale 1–5 of the owner's 258-5101 (centimetres, millimetre ticks,
3 = media centre line — photo of 13.10.2026). It is never sent to the printer.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field

# The PRINTER's own unit: it reports and takes millimetres as dots / 12
# (it stores ^QD1154,42 as ^Q96.2,3.5). Comparisons with what the printer
# stores, and every job SMPL renders today, use this.
DOTS_PER_MM = 12
# The PHYSICAL feed: 300 dots per inch (the printer's config says "300 Dpi").
# Physical test 13.10.2026 on 210-804: a 10 → 90 ruler (960 dots) printed
# 81,5 mm, and a label pitch the owner measured as 99 + 2,9 mm read 1196 dots.
# Comparisons with REAL millimetres — profile sizes, a ruler — use this.
PHYSICAL_DOTS_PER_MM = 300 / 25.4

# Printer envelope (WAGO 258-51xx datasheet): 47 mm printable width,
# 5–762 mm feed length.
HEAD_WIDTH_MM = 47.0
MIN_LENGTH_MM = 5.0
MAX_LENGTH_MM = 762.0

TIER_VOLL = "voll"
TIER_KOMPAKT = "kompakt"
TIER_MINI = "mini"

SENSOR_MODES = ("see_through", "reflective", "auto", "none")
GUIDE_SETTINGS = ("max", "fit")
FEED_PATHS = ("internal", "external")
ROLLERS = ("258-5006", "258-5007")
WEB_SOURCES = ("catalogue", "estimate", "measured")

# The housing scale (photo of 13.10.2026): printed ticks run from about 0,6
# to 5,4; the range adds a millimetre either side and stays inside the
# pointer's travel (≈ 0,3 … 5,7).
SENSOR_SCALE_MIN = 0.5
SENSOR_SCALE_MAX = 5.5
SENSOR_SCALE_CENTRE = 3.0
SENSOR_SCALE_LABELS = 3.4  # default reading for die-cut stock (WAGO's "triangle")


def mm_int(value: float) -> int:
    """The printer's whole-millimetre value — Python's round, unchanged.

    Banker's rounding (2.5 → 2) is what every job has been sent with; a
    half-up switch would move bytes of jobs nobody asked to change.
    """
    return int(round(value))


def format_scale_de(reading: float) -> str:
    """A scale reading in German: one decimal, a trailing ",0" dropped."""
    text = f"{round(float(reading), 1):.1f}".replace(".", ",")
    return text[:-2] if text.endswith(",0") else text


def format_mm_de(value: float, decimals: int = 1) -> str:
    """Millimetres in German: decimal comma, U+2212 minus, trailing zeros dropped."""
    rounded = round(float(value), decimals)
    if rounded == 0:
        rounded = 0.0  # never "−0"
    text = f"{abs(rounded):.{decimals}f}".rstrip("0").rstrip(".").replace(".", ",")
    return f"−{text}" if rounded < 0 else text


@dataclass(frozen=True)
class MediaWeb:
    """The physical roll, for guide, diagram and verify only — never printed."""

    lanes: int = 1  # 1..4 labels side by side
    label_across_mm: float | None = None  # None → profile.width_mm
    label_along_mm: float | None = None  # None → profile.length_mm (ignored when continuous)
    lane_gap_mm: float = 0.0  # slit between lanes, 0..10
    liner_width_mm: float | None = None  # 3..60; None = unknown
    source: str = "catalogue"  # "catalogue" | "estimate" | "measured"


@dataclass(frozen=True)
class JobSettings:
    """Resolved per-job values, never None."""

    darkness: int  # ^H 0..19
    speed_ips: int  # ^S 2..4
    stop_mm: int  # ^E 0..40


# Read from the office printer on 13.10.2026 (^H12 ^S2 ^E0); WAGO recommends
# 2 inch/s.
CODE_BASELINE = JobSettings(darkness=12, speed_ips=2, stop_mm=0)


@dataclass(frozen=True)
class MaterialProfile:
    # Existing fields, in their existing order (keyword construction elsewhere
    # in the code base relies on it).
    id: str
    name: str
    part_no: str
    width_mm: float  # across the print head
    length_mm: float | None  # feed direction; None = continuous
    gap_mm: float = 3.0
    x_offset_mm: float = 2.0  # print origin sits before the label's left edge
    darkness: int | None = None  # stored ^H override; None = baseline
    builtin: bool = False
    # Calibration fields. None for the three type-dependent ones means "the
    # default for this kind of stock" and is resolved in __post_init__, so a
    # profile built in a test with only the geometry still makes sense.
    across_offset_mm: float = 0.0
    speed_ips: int | None = None
    stop_mm: int | None = None
    mark_width_mm: float | None = None  # set ⇒ black-mark stock
    mark_offset_mm: float = 0.0
    mark_inside: bool = False
    sensor_mode: str | None = None
    sensor_scale: float | None = None
    guide: str = "fit"
    feed_path: str | None = None
    roller: str = "258-5006"
    web: MediaWeb = field(default_factory=MediaWeb)
    job: JobSettings | None = field(default=None, compare=False)

    def __post_init__(self) -> None:
        if self.sensor_mode is None:
            object.__setattr__(self, "sensor_mode", default_sensor_mode(self.length_mm, self.mark_width_mm))
        if self.sensor_scale is None:
            object.__setattr__(self, "sensor_scale", default_sensor_scale(self.length_mm))
        if self.feed_path is None:
            object.__setattr__(self, "feed_path", default_feed_path(self.length_mm))

    @property
    def continuous(self) -> bool:
        return self.length_mm is None

    @property
    def media_type(self) -> str:
        if self.continuous:
            return "continuous"
        return "mark" if self.mark_width_mm is not None else "gap"

    @property
    def tier(self) -> str:
        """What this stock has room to carry.

        voll    — the full machine label (logo, footer, serial, DataMatrix)
        kompakt — DataMatrix + number + name
        mini    — number/text only; a DataMatrix under ~6 mm does not scan
        """
        if not self.continuous and self.length_mm >= 80 and self.width_mm >= 36:
            return TIER_VOLL
        if self.width_mm >= 12 and (self.continuous or (self.length_mm or 0) >= 30):
            return TIER_KOMPAKT
        return TIER_MINI

    @property
    def job_settings(self) -> JobSettings:
        if self.job is not None:
            return self.job
        return resolve_job_settings(self, CODE_BASELINE)

    @property
    def web_width_mm(self) -> float:
        if self.web.liner_width_mm is not None:
            return self.web.liner_width_mm
        across = self.web.label_across_mm if self.web.label_across_mm is not None else self.width_mm
        return self.web.lanes * across + (self.web.lanes - 1) * self.web.lane_gap_mm

    @property
    def physical_length_mm(self) -> float | None:
        if self.web.label_along_mm is not None:
            return self.web.label_along_mm
        return self.length_mm

    @property
    def fingerprint(self) -> str:
        """Identity of everything a measurement depends on (stale detection)."""
        # Floats normalised so 44 and 44.0 hash alike.
        canonical = {
            "width_mm": _opt_float(self.width_mm),
            "length_mm": _opt_float(self.length_mm),
            "gap_mm": _opt_float(self.gap_mm),
            "mark_width_mm": _opt_float(self.mark_width_mm),
            "mark_offset_mm": _opt_float(self.mark_offset_mm),
            "mark_inside": bool(self.mark_inside),
            "sensor_mode": self.sensor_mode,
            "sensor_scale": _opt_float(self.sensor_scale),
            "web": {
                "lanes": int(self.web.lanes),
                "label_across_mm": _opt_float(self.web.label_across_mm),
                "label_along_mm": _opt_float(self.web.label_along_mm),
                "lane_gap_mm": _opt_float(self.web.lane_gap_mm),
                "liner_width_mm": _opt_float(self.web.liner_width_mm),
                "source": self.web.source,
            },
        }
        blob = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def _opt_float(value: float | None) -> float | None:
    return None if value is None else float(value)


def web_to_dict(web: MediaWeb) -> dict:
    return asdict(web)


def default_sensor_mode(length_mm: float | None, mark_width_mm: float | None) -> str:
    if length_mm is None:
        return "see_through"
    return "reflective" if mark_width_mm is not None else "auto"


def default_sensor_scale(length_mm: float | None) -> float:
    return SENSOR_SCALE_CENTRE if length_mm is None else SENSOR_SCALE_LABELS


def default_feed_path(length_mm: float | None) -> str:
    return "external" if length_mm is None else "internal"


def resolve_job_settings(profile: MaterialProfile, baseline: JobSettings) -> JobSettings:
    """The values a job sends: the profile's override, else the baseline."""
    return JobSettings(
        darkness=profile.darkness if profile.darkness is not None else baseline.darkness,
        speed_ips=profile.speed_ips if profile.speed_ips is not None else baseline.speed_ips,
        stop_mm=profile.stop_mm if profile.stop_mm is not None else baseline.stop_mm,
    )


def q_value(profile: MaterialProfile, *, continuous_length_mm: float = 15) -> str:
    """The ``^Q`` argument for this stock: ``99,3`` / ``25,4,3+`` / ``15,0``."""
    if profile.continuous:
        return f"{mm_int(continuous_length_mm)},0"
    if profile.mark_width_mm is not None:
        sign = "-" if profile.mark_inside else "+"
        return f"{mm_int(profile.length_mm)},{mm_int(profile.mark_width_mm)},{mm_int(profile.mark_offset_mm)}{sign}"
    return f"{mm_int(profile.length_mm)},{mm_int(profile.gap_mm)}"


# Fields a profile has, in the order of the dataclass (``job`` excluded: it
# is attached by the reader, never stored).
PROFILE_FIELDS = (
    "id", "name", "part_no", "width_mm", "length_mm", "gap_mm", "x_offset_mm",
    "darkness", "builtin", "across_offset_mm", "speed_ips", "stop_mm",
    "mark_width_mm", "mark_offset_mm", "mark_inside", "sensor_mode",
    "sensor_scale", "guide", "feed_path", "roller", "web",
)
# Fields that take None as a value (everything else ignores an explicit null).
NULLABLE_FIELDS = frozenset({"length_mm", "darkness", "speed_ips", "stop_mm", "mark_width_mm"})
# Stored per profile (``id`` is the key, ``builtin`` comes from identity).
STORED_FIELDS = tuple(name for name in PROFILE_FIELDS if name not in ("id", "builtin"))
