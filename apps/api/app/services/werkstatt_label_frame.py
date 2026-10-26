"""The reading frame and the EZPL element helpers every renderer shares.

Moved out of ``werkstatt_labels`` unchanged (docs/PANEL_ENCLOSURE_R4.md §9,
the 800-line cap), so the marking strips (``werkstatt_label_strips``) and the
§14a strip (``werkstatt_label_control_strip``) can use them without importing
the machine-label module; ``werkstatt_labels`` re-exports every name.

Layouts are designed in a "reading frame" (x right along the feed, y down
across the head, 1 px = 1 dot of the 300 dpi head) and converted per sheet:

    x_machine = sheet_height - y_reading + across_offset   (validated by physical prints)
    y_machine = x_reading + x_offset

Every interpolated value goes through ``_clean``: EZPL is line-oriented, so a
newline inside a text would end the command and run the rest as printer
commands.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.services.werkstatt_label_jobs import fit_to_media, job_footer, job_header
from app.services.werkstatt_label_profile import MaterialProfile, mm_to_dots

# EZPL's built-in TrueType command (`AT`) takes UTF-8 when the style field
# carries the "E" flag; M-numbers and DataMatrix content are plain ASCII.
_ENCODING = "utf-8"

# The AT rotation of every text that reads along the feed (validated on the
# physical prints): 90°, glyph tops toward the reading top.
ROTATION_ALONG_FEED = "1"


@dataclass(frozen=True)
class _Frame:
    """One sheet's reading-frame geometry and its machine-frame conversion."""

    h_px: int  # across the head (reading height)
    w_px: int  # along the feed (reading width)
    x_offset_px: int
    across_px: int = 0  # + moves the print toward the reading-top edge ("L")

    def xm(self, reading_y: int) -> int:
        """Machine x (across the head) for a reading-frame TOP edge."""
        return self.h_px - reading_y + self.across_px

    def ym(self, reading_x: int) -> int:
        """Machine y (feed direction) for a reading-frame LEFT edge."""
        return reading_x + self.x_offset_px


def at_line(x_machine: int, y_machine: int, size: int, text: str, *, rotation: str = ROTATION_ALONG_FEED) -> str:
    """One built-in-TTF text command at a MACHINE anchor; style "E" = UTF-8."""
    return f"AT,{x_machine},{y_machine},{size},{size},0,{rotation}E,0,0,{text}"


def _at(frame: _Frame, reading_x: int, reading_y: int, size: int, text: str) -> str:
    """One rotated built-in-TTF text command anchored in the reading frame."""
    return at_line(frame.xm(reading_y), frame.ym(reading_x), size, text)


def _sheet(
    profile: MaterialProfile,
    lines: list[str],
    *,
    length_dots: int | None = None,
    copies: int = 1,
) -> list[str]:
    """Wrap element lines into one complete job for this material.

    The header states the baseline (``job_header``), the elements pass the
    coordinate guard, and a copies job ends with the ``^C1`` reset.
    ``length_dots`` is a continuous job's content length; the header turns
    it into the printer's millimetres.
    """
    if profile.continuous:
        assert length_dots is not None, "continuous sheets must compute a length"
        form_length_dots = None
    else:
        # The label's last dot; the header's ^Q form reaches it (``q_value``
        # rounds the length up).
        form_length_dots = mm_to_dots(profile.length_mm)
    head = job_header(profile, length_dots=length_dots, copies=copies)
    body = fit_to_media(profile, lines, form_length_dots=form_length_dots)
    return [*head, "^L", *body, "E", *job_footer(copies)]


def _frame(profile: MaterialProfile, *, w_px: int | None = None) -> _Frame:
    """The sheet in physical dots: the label's real width and length, the
    profile's offsets (physical mm)."""
    return _Frame(
        h_px=mm_to_dots(profile.width_mm),
        w_px=w_px if w_px is not None else mm_to_dots(profile.length_mm or 0),
        x_offset_px=mm_to_dots(profile.x_offset_mm),
        across_px=mm_to_dots(profile.across_offset_mm),
    )


def _clean(value: str, max_chars: int) -> str:
    """Collapse a value to one line of printable text.

    Control characters (CR, LF, tabs, DEL, …) and the EZPL command prefixes
    `~` and `^` become spaces, runs of whitespace collapse, and the result is
    capped — a label field, not prose.
    """
    printable = "".join(" " if ch < " " or ch in "\x7f~^" else ch for ch in value)
    return " ".join(printable.split())[:max_chars].strip()
