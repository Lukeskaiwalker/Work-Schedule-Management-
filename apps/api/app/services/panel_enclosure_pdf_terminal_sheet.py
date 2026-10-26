"""Layout primitives of the WAGO close-up pages (docs/PANEL_ENCLOSURE_R2.md §7.3).

A page is laid out as plain data before anything is drawn: rectangles, and
texts that each carry the cell they must stay inside. ``Sheet`` collects
them; ``panel_enclosure_pdf_terminals`` draws them. Two ways into a cell:

* ``Sheet.fit``: ``label_fit.fit_label`` in Helvetica (the rule the app's
  close-up shares): horizontal, shrunk, rotated, then cut with "…". With
  ``along=True`` the text runs along the cell's height (the rotated column).
  A cut terminal text marks the page as shortened: it gets a legend page.
* ``Sheet.line``: one line of running text in any font, cut with ``wrap``.

Coordinates are PDF points on an A4 landscape page, origin bottom left.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfbase.pdfmetrics import stringWidth

from app.services.label_fit import fit_label
from app.services.schaltplan_pdf_style import BLUE, FONT, FONT_BOLD, INK, wrap

MM = 72 / 25.4
PAGE_W, PAGE_H = landscape(A4)
MARGIN = 12 * MM
USABLE_W = PAGE_W - 2 * MARGIN  # 273 mm
TOP = PAGE_H - MARGIN  # the header bar fills the top margin
BOTTOM = MARGIN
HEADER_H = 34.0
CONTROL = "Kontrollmaß 100 mm"
CONTROL_MM = 100.0


@dataclass(frozen=True)
class PageText:
    """A text and its cell (``x``, ``y``, ``w``, ``h``). ``rotated``: it runs
    up the cell, so its width must fit ``h`` and its size ``w``."""

    text: str
    font: str
    size: float
    x: float
    y: float
    w: float
    h: float
    rotated: bool = False
    truncated: bool = False
    align: str = "centre"  # "centre" | "left" | "right"
    color: Any = INK


@dataclass(frozen=True)
class PageShape:
    x: float
    y: float
    w: float
    h: float
    fill: Any = None
    stroke: Any = None
    width: float = 0.35


@dataclass(frozen=True)
class LayoutPage:
    field: int
    legend: bool
    shapes: tuple[PageShape, ...]
    texts: tuple[PageText, ...]
    shortened: bool  # a terminal's text was cut: a legend page follows


@dataclass
class Sheet:
    """One page under construction (local to one layout call)."""

    shapes: list[PageShape] = field(default_factory=list)
    texts: list[PageText] = field(default_factory=list)
    shortened: bool = False

    def rect(self, x: float, y: float, w: float, h: float, *, fill: Any = None, stroke: Any = None,
             width: float = 0.35) -> None:
        self.shapes.append(PageShape(x, y, w, h, fill, stroke, width))

    def fit(self, text: str, x: float, y: float, w: float, h: float, size_max: float, size_min: float, *,
            item: bool = False, along: bool = False, color: Any = INK) -> None:
        """``text`` fitted into the cell; ``item``: a terminal's text (cutting it adds the legend)."""
        if not text:
            return
        fit = fit_label(text, h, w, size_max, size_min) if along else fit_label(text, w, h, size_max, size_min)
        if fit.truncated and item:
            self.shortened = True
        if fit.text:
            self.texts.append(PageText(fit.text, FONT, fit.size, x, y, w, h, rotated=fit.rotated != along,
                                       truncated=fit.truncated, color=color))

    def line(self, text: str, x: float, y: float, w: float, h: float, *, font: str = FONT, size: float = 7.0,
             color: Any = INK, align: str = "left") -> None:
        """One line of running text, cut with "…" at the cell's width."""
        lines = wrap(text, font, size, w, 1)
        if lines:
            self.texts.append(PageText(lines[0], font, size, x, y, w, h, truncated=lines[0] != " ".join(text.split()),
                                       align=align, color=color))

    @staticmethod
    def fits(text: str, width: float, *, font: str = FONT, size: float = 7.0) -> bool:
        return stringWidth(text, font, size) <= width

    def page(self, field_index: int, *, legend: bool) -> LayoutPage:
        return LayoutPage(field_index, legend, tuple(self.shapes), tuple(self.texts), self.shortened)


def page_header(sheet: Sheet, company: str) -> None:
    """The blue bar of the Aufbau sheet ("Aufbau", the company), as on page 1."""
    sheet.rect(0, PAGE_H - HEADER_H, PAGE_W, HEADER_H, fill=BLUE)
    sheet.line("Aufbau", 34, PAGE_H - HEADER_H, 300, HEADER_H, font=FONT_BOLD, size=13, color=colors.white)
    sheet.line(company, PAGE_W - 34 - 300, PAGE_H - HEADER_H, 300, HEADER_H, size=9, color=colors.white,
               align="right")


def sheet_scale(extent_mm: float) -> float:
    """1 (1:1) when ``extent_mm`` fits the sheet's width, else the factor that makes it fit."""
    return min(1.0, USABLE_W / (extent_mm * MM)) if extent_mm > 0 else 1.0


def control_measure(sheet: Sheet) -> None:
    """The Kontrollmaß bar top right: 100 mm with end and middle marks, so a
    fitter sees whether the printer scaled the page (an iPad's "fit to page")."""
    left = MARGIN + USABLE_W - CONTROL_MM * MM
    sheet.line(CONTROL, left, TOP - 14, CONTROL_MM * MM, 14, size=7.5, align="right")
    sheet.rect(left, TOP - 22, CONTROL_MM * MM, 1.2 * MM, fill=INK)
    for tick in (0.0, 50.0, 100.0):  # end and middle marks, so the bar is read at its ends
        sheet.rect(left + tick * MM - 0.2, TOP - 26, 0.4, 4 * MM, fill=INK)
