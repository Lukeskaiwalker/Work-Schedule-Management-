"""What the calibration may send — exact commands and the allow-list.

The calibration changes printer state and feeds paper, so its sends are
pinned byte for byte: the no-paper apply per stock (§4.4), the re-prime, the
measuring pattern. Every line any builder can emit — for every material,
sensor mode and the corners of the offset limits — must fully match the
allow-list, and nothing may ever start with a never-send prefix (self-test
print, factory reset, row offset, IMMEDIATE …). User text (a custom part
number) is mapped into the allowed character class, so it can never turn a
valid profile into a 500.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from app.services import werkstatt_label_jobs as jobs
from app.services.werkstatt_label_builtins import DEFAULT_MATERIALS
from app.services.werkstatt_label_calibration import reprime_lines, setup_commands
from app.services.werkstatt_label_errors import DisallowedPrinterCommand, LabelLayoutOutOfBounds, PatternUnsupported
from app.services.werkstatt_label_ezpl_policy import NEVER_SEND_PREFIXES, assert_allowed, is_allowed
from app.services.werkstatt_label_jobs import offset_limits
from app.services.werkstatt_label_patterns import pattern_job, pattern_supported
from app.services.werkstatt_label_profile import MaterialProfile
from app.services.werkstatt_label_transport import PrinterQuery

M = {m.id: m for m in DEFAULT_MATERIALS}
CUSTOM = MaterialProfile(id="custom-38x23", name="Fremdetikett 38 × 23", part_no="", width_mm=23, length_mm=38, sensor_mode="auto")
MARK = MaterialProfile(
    id="custom-mark", name="Schwarzmarke", part_no="", width_mm=40, length_mm=25,
    mark_width_mm=4, mark_offset_mm=3, sensor_mode="reflective",
)


# ^Q/^W in the printer's millimetres (dots / 12) of the physical 300 dpi dots;
# a label length is rounded UP so the form never ends before the label:
# 99 mm = 1169 dots → 97,4 → 98, 50 mm = 591 → 49,25 → 50, 38 mm = 449 → 38;
# a 3 mm gap (35 dots, nearest), 44 mm (520 dots, rounded up) and every width
# here keep their number.
@pytest.mark.parametrize(
    ("profile", "lines"),
    [
        (M["wago-210-804"], ["^G1", "^XSET,SENSING,1", "^Q98,3", "^W44"]),
        (M["wago-210-824"], ["^G1", "^XSET,SENSING,1", "^Q98,3", "^W44"]),
        (M["wago-210-812"], ["^G1", "^XSET,SENSING,1", "^Q50,3", "^W25"]),
        (M["wago-210-805"], ["^G1", "^XSET,SENSING,1", "^Q15,3", "^W6"]),
        (M["wago-211-501"], ["^G1", "^XSET,SENSING,1", "^Q15,0", "^W5"]),
        (M["wago-2009-110"], ["^G1", "^XSET,SENSING,1", "^Q15,0", "^W11"]),
        (replace(M["wago-211-501"], sensor_mode="none"), ["^XSET,SENSING,2", "^Q15,0", "^W5"]),
        (CUSTOM, ["^G2", "^XSET,SENSING,1", "^Q38,3", "^W23"]),
        (MARK, ["^G0", "^XSET,SENSING,0", "^Q25,4,3+", "^W40"]),
        (replace(MARK, mark_inside=True), ["^G0", "^XSET,SENSING,0", "^Q25,4,3-", "^W40"]),
    ],
)
def test_setup_commands_table(profile: MaterialProfile, lines: list[str]) -> None:
    assert setup_commands(profile) == lines
    assert reprime_lines(profile) == lines[-2:]


def test_setup_never_sends_job_or_feed_settings() -> None:
    for profile in [*DEFAULT_MATERIALS, CUSTOM, MARK]:
        for line in setup_commands(profile):
            assert not line.startswith(("^E", "^H", "^S", "^C", "^P", "^L", "~Q", "^R", "^XSET,IMMEDIATE")), line
            assert line != "E"


def _modes(profile: MaterialProfile) -> tuple[str, ...]:
    return ("see_through", "reflective", "none") if profile.continuous else ("see_through", "reflective", "auto")


def _corners(profile: MaterialProfile) -> list[tuple[float, float]]:
    limits = offset_limits(profile)
    return [(x, a) for x in (limits.x_min, limits.x_max) for a in (limits.across_min, limits.across_max)]


def _every_emitted_line() -> list[str]:
    lines: list[str] = []
    profiles = [*DEFAULT_MATERIALS, CUSTOM, MARK, replace(MARK, mark_inside=True)]
    for base in profiles:
        for mode in _modes(base):
            profile = replace(base, sensor_mode=mode)
            lines += setup_commands(profile) + reprime_lines(profile)
        if not pattern_supported(base):
            continue
        for x_offset, across in _corners(base):
            lines += pattern_job(replace(base, x_offset_mm=x_offset, across_offset_mm=across))[0]
    return lines + ["~S,SENSOR"]


def test_every_builder_line_is_allowed() -> None:
    lines = _every_emitted_line()
    assert len(lines) > 500
    assert_allowed(lines)


def test_never_send_prefixes_are_absent() -> None:
    for line in _every_emitted_line():
        assert not line.startswith(NEVER_SEND_PREFIXES), line
        if line.startswith("^XSET,"):
            assert line.startswith("^XSET,SENSING,"), line


def test_outside_the_limits_the_pattern_raises_or_stays_allowed() -> None:
    """Never a disallowed (negative, off-media) line: rules clamp, text raises."""
    for base in DEFAULT_MATERIALS:
        if not pattern_supported(base):
            continue
        limits = offset_limits(base)
        for x_offset, across in ((limits.x_min - 1.5, 0.0), (0.0, limits.across_min - 1.0), (0.0, limits.across_max + 1.0)):
            try:
                lines, _ = pattern_job(replace(base, x_offset_mm=x_offset, across_offset_mm=across))
            except LabelLayoutOutOfBounds:
                continue
            assert_allowed(lines)


def test_policy_details() -> None:
    assert is_allowed("~S,SENSOR")
    assert is_allowed("^P1")
    assert not is_allowed("^XSET,IMMEDIATE,1")
    assert not is_allowed("^P2")
    assert not is_allowed("~V")
    assert not is_allowed("^Q99,3 ")
    assert not is_allowed("AT,1,1,24,24,0,1E,0,0,a~b")
    assert not is_allowed("Lo,-1,0,10,10")
    with pytest.raises(DisallowedPrinterCommand):
        assert_allowed(["^W44", "~Z"])
    assert [query.value for query in PrinterQuery] == ["~S,STATUS", "^XGET,CONFIG"]


def test_pattern_worked_example_210_804() -> None:
    """At 300 dpi: h = 520 (44 mm), w = 1169 (99 mm), inset 24 (2 mm), x_offset 24 (2 mm)."""
    lines, geometry = pattern_job(M["wago-210-804"])
    assert lines[:14] == [
        "^Q98,3", "^W44", "^H12", "^S2", "^E0", "^C1", "^P1", "^L",
        "Lo,24,48,496,51",
        "Lo,24,1166,496,1169",
        "Lo,493,48,496,1169",
        "Lo,24,48,27,1169",
        "Lo,259,573,261,643",
        "Lo,225,607,295,609",
    ]
    assert lines[-1] == "E"  # copies 1: no ^C1 reset after the job
    assert "AT,481,63,24,24,0,1E,0,0,SMPL KAL WAGO 210-804" in lines
    assert (geometry.ruler_from_mm, geometry.ruler_to_mm, geometry.inset_mm, geometry.letters) == (10, 90, 2.0, True)
    assert geometry.across_measurable is False  # guide "max": no across correction
    assert pattern_job(M["wago-210-812"])[1].ruler_to_mm == 40


def test_pattern_on_continuous_stock() -> None:
    lines, geometry = pattern_job(M["wago-2009-110"])
    assert lines[0] == "^Q42,0"
    assert geometry.kind == "continuous" and geometry.feed_measurable is False
    assert pattern_job(M["wago-211-501"])[0][0] == "^Q32,0"
    assert not any(line.startswith("AT,") for line in pattern_job(M["wago-211-501"])[0])  # no letter under 10 mm


def test_pattern_text_cannot_inject() -> None:
    lines, _ = pattern_job(replace(M["wago-210-804"], part_no="X\r\n~Z"))
    assert not any(line.startswith("~Z") for line in lines)
    text_line = next(line for line in lines if line.startswith("AT,") and "SMPL KAL" in line)
    assert "~" not in text_line
    assert_allowed(lines)


def test_pattern_text_maps_non_ascii() -> None:
    lines, _ = pattern_job(replace(M["wago-210-804"], part_no="Brady® Ø3"))
    assert any(line.endswith(",SMPL KAL Brady? ?3") for line in lines)
    assert_allowed(lines)


def test_pattern_has_no_copies() -> None:
    lines, _ = pattern_job(M["wago-210-804"])
    assert [line for line in lines if line.startswith("^C")] == ["^C1"]


def test_pattern_on_two_lane_805_is_unsupported() -> None:
    assert pattern_supported(M["wago-210-805"]) is False
    with pytest.raises(PatternUnsupported):
        pattern_job(M["wago-210-805"])


@pytest.mark.parametrize(
    ("width", "ticks", "numbers"),
    [(4, False, False), (6, False, False), (7, True, False), (8, True, False), (9, True, False), (10, True, True), (12, True, True)],
)
def test_the_ruler_only_where_the_width_has_room(width: int, ticks: bool, numbers: bool) -> None:
    """The ruler's numbers sit 5,5 mm (65 dots) above its baseline and its
    10-mm ticks are 3 mm (35 dots) tall: on a narrow label they would run
    past the top line (ticks, clamped into a smear) or off the material
    (numbers — the pattern of a 6 × 50 raised at every offset). Each is
    drawn only below the top line. A 9 mm label is 106 dots across at
    300 dpi (108 at the old 12 per mm): its numbers no longer fit by a dot."""
    # x_offset 0: at the default 2 mm, line B of a 1-mm inset lies past the
    # label's end and is dropped — by design (B is never used), not the ruler.
    profile = MaterialProfile(id=f"custom-{width}x50", name="Schmal", part_no="", width_mm=width, length_mm=50, x_offset_mm=0.0)
    lines, geometry = pattern_job(profile)
    assert (geometry.ruler_from_mm, geometry.ruler_to_mm) == ((10, 40) if ticks else (None, None))
    assert any(line.startswith("AT,") for line in lines) is numbers  # no letters or text below 20 / 25 mm
    with jobs._without_guard():
        assert pattern_job(profile)[0] == lines  # nothing had to be clamped
    assert_allowed(lines)
