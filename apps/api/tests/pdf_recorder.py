"""A recording reportlab canvas for PDF layout tests.

``Recorder`` starts as a copy of ``_Recorder`` in ``tests/test_panel_enclosure_pdf.py``
(SCHALTPLAN_STROMLAUF.md §6: that file belongs to another slice and is left
alone) — every string drawn as ``(text, font, size)`` and every rectangle —
and adds what the schematic tests need: every primitive with its bounding box
in page coordinates (the current transform applied), its stroke and fill
colour, line width and dash pattern. Nothing is drawn differently: each
method records and then calls the real canvas.
"""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from typing import Any

from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen.canvas import Canvas


@dataclass(frozen=True)
class Primitive:
    """One drawn thing. ``bbox`` is (x0, y0, x1, y1) on the page, y up."""

    kind: str  # "string" | "line" | "rect" | "circle" | "arc" | "roundRect"
    bbox: tuple[float, float, float, float]
    stroke: str
    fill: str
    width: float
    dash: tuple[float, ...]
    text: str = ""
    font: str = ""
    size: float = 0.0
    page: int = 0


def _hex(colour: Any) -> str:
    try:
        return colour.hexval().lower().replace("0x", "#")
    except AttributeError:
        return str(colour)


class Recorder(Canvas):
    """A canvas that remembers every string it draws (text, font, size), every
    rectangle, and every primitive with its page bounding box and style."""

    def __init__(self, pagesize: tuple[float, float] = landscape(A4)) -> None:
        super().__init__(BytesIO(), pagesize=pagesize)
        self.strings: list[tuple[str, str, float]] = []
        self.rects: list[tuple[float, float, float, float]] = []
        self.primitives: list[Primitive] = []
        self._page = 0
        self._rec_dash: tuple[float, ...] = ()
        self._dash_stack: list[tuple[float, ...]] = []

    # ── style tracking ──────────────────────────────────────────────────────

    def setDash(self, array=(), phase=0):  # noqa: N802 (reportlab's name)
        if isinstance(array, (int, float)):
            self._rec_dash = (float(array), float(phase))
        else:
            self._rec_dash = tuple(float(v) for v in array)
        return super().setDash(array, phase)

    def saveState(self):  # noqa: N802
        self._dash_stack.append(self._rec_dash)
        return super().saveState()

    def restoreState(self):  # noqa: N802
        self._rec_dash = self._dash_stack.pop() if self._dash_stack else ()
        return super().restoreState()

    def showPage(self):  # noqa: N802
        self._page += 1
        self._rec_dash = ()
        return super().showPage()

    # ── geometry ────────────────────────────────────────────────────────────

    def _page_bbox(self, points: list[tuple[float, float]]) -> tuple[float, float, float, float]:
        a, b, c, d, e, f = self._currentMatrix
        xs = [a * x + c * y + e for x, y in points]
        ys = [b * x + d * y + f for x, y in points]
        return (min(xs), min(ys), max(xs), max(ys))

    def _add(self, kind: str, points: list[tuple[float, float]], **extra: Any) -> None:
        self.primitives.append(Primitive(
            kind=kind, bbox=self._page_bbox(points), stroke=_hex(self._strokeColorObj),
            fill=_hex(self._fillColorObj), width=float(self._lineWidth), dash=self._rec_dash,
            page=self._page, **extra,
        ))

    def _note(self, text: str) -> None:
        self.strings.append((text, self._fontname, self._fontsize))

    def _string(self, x0: float, y: float, text: str) -> None:
        width = stringWidth(text, self._fontname, self._fontsize)
        top = y + self._fontsize * 0.75
        bottom = y - self._fontsize * 0.22
        self._add("string", [(x0, bottom), (x0 + width, top)], text=text, font=self._fontname,
                  size=float(self._fontsize))

    def drawString(self, x, y, text, *args, **kwargs):  # noqa: N802 (reportlab's name)
        self._note(text)
        self._string(x, y, text)
        return super().drawString(x, y, text, *args, **kwargs)

    def drawCentredString(self, x, y, text, *args, **kwargs):  # noqa: N802
        self._note(text)
        self._string(x - stringWidth(text, self._fontname, self._fontsize) / 2, y, text)
        return super().drawCentredString(x, y, text, *args, **kwargs)

    def drawRightString(self, x, y, text, *args, **kwargs):  # noqa: N802
        self._note(text)
        self._string(x - stringWidth(text, self._fontname, self._fontsize), y, text)
        return super().drawRightString(x, y, text, *args, **kwargs)

    def rect(self, x, y, width, height, *args, **kwargs):
        self.rects.append((x, y, width, height))
        self._add("rect", [(x, y), (x + width, y + height)])
        return super().rect(x, y, width, height, *args, **kwargs)

    def roundRect(self, x, y, width, height, radius, *args, **kwargs):  # noqa: N802
        self._add("roundRect", [(x, y), (x + width, y + height)])
        return super().roundRect(x, y, width, height, radius, *args, **kwargs)

    def line(self, x1, y1, x2, y2):
        self._add("line", [(x1, y1), (x2, y2)])
        return super().line(x1, y1, x2, y2)

    def circle(self, x_cen, y_cen, r, *args, **kwargs):
        self._add("circle", [(x_cen - r, y_cen - r), (x_cen + r, y_cen + r)])
        return super().circle(x_cen, y_cen, r, *args, **kwargs)

    def arc(self, x1, y1, x2, y2, startAng=0, extent=90):  # noqa: N803 (reportlab's names)
        self._add("arc", [(x1, y1), (x2, y2)])
        return super().arc(x1, y1, x2, y2, startAng, extent)

    # ── queries ─────────────────────────────────────────────────────────────

    def texts(self) -> list[str]:
        return [text for text, _, _ in self.strings]

    def on_page(self, page: int) -> list[Primitive]:
        return [p for p in self.primitives if p.page == page]
