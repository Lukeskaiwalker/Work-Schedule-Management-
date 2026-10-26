"""The behaviour-preserving extractions of R4 §9: the names stay where they were.

``werkstatt_labels`` and ``routers/workflow_schaltplan`` were at or over the
800-line cap; the reading frame, the marking strips and the label print
route moved into their own modules. Every caller and every test still
reaches the old names, as the same objects, and the two files do not grow.
"""

from __future__ import annotations

from pathlib import Path

from app.services import werkstatt_label_frame as frame
from app.services import werkstatt_label_strips as strips
from app.services import werkstatt_labels as wl

APP = Path(__file__).resolve().parents[1] / "app"


def test_the_moved_names_are_re_exported_as_the_same_objects() -> None:
    for name in ("_ENCODING", "_at", "_clean", "_Frame", "_frame", "_sheet"):
        assert getattr(wl, name) is getattr(frame, name), name
    for name in (
        "CAP_HEIGHT_RATIO", "CAP_TOP_RATIO", "MARKING_STRIP_MATERIAL_ID", "TERMINAL_BLOCK_PAD_DOTS",
        "_render_block_label", "_render_rail_strip", "print_marking_strips",
    ):
        assert getattr(wl, name) is getattr(strips, name), name


def test_the_frame_helpers_render_what_they_rendered() -> None:
    sheet = frame._Frame(h_px=130, w_px=400, x_offset_px=24)
    assert frame._at(sheet, 10, 20, 35, "F1") == "AT,110,34,35,35,0,1E,0,0,F1"
    assert frame.at_line(13, 70, 35, "UNSM", rotation="0") == "AT,13,70,35,35,0,0E,0,0,UNSM"
    assert frame._clean("A~B^C\r\nD", 40) == "A B C D"


def _lines(relative: str) -> int:
    return len((APP / relative).read_text(encoding="utf-8").splitlines())


def test_the_split_files_stay_under_the_cap() -> None:
    assert _lines("services/werkstatt_labels.py") <= 800
    assert _lines("routers/workflow_schaltplan.py") <= 790  # its size before the split; it must not grow
    for module in ("werkstatt_label_frame", "werkstatt_label_strips", "werkstatt_label_control_strip"):
        assert _lines(f"services/{module}.py") <= 800, module
    assert _lines("routers/workflow_schaltplan_labels.py") <= 800
