#!/usr/bin/env python3
"""Code 128 (code set B) as bar widths and as a self-contained SVG.

Why this exists: the wall screen facing the construction boxes has no mouse
and no keyboard - the keyboard is bolted to the *other* screen across the
workshop - so the only input device that screen has is the barcode scanner in
the worker's hand. The way back to the overview is therefore a barcode printed
on the screen itself, which the worker scans off the glass. This module draws
those barcodes.

Stdlib only, and deliberately so. ``requirements.txt`` next door is two lines
long because a broken wheel must never be able to stop the agent from booting;
a command code that will not render is the same class of failure, one screen
further on. So: no Pillow, no reportlab, no barcode package - a 107-row table
and some arithmetic.

Code set B only. It covers ASCII 32..126, which is every character our command
vocabulary (``SMPL-CMD-FERTIG`` and friends) and our crate ids (``KISTE-K3``)
will ever contain. Set A buys control characters we do not print and set C
buys a digit-pair compression that would save a few millimetres on codes that
already fit, at the cost of shift logic that can be wrong.

Two things about screens in particular, both of which are the difference
between "it scans" and "it does not":

* **The quiet zone.** The white margin either side is part of the symbol, not
  decoration. A barcode rendered flush against a coloured panel is the classic
  will-not-read bug, and the scanner gives no hint why - so the quiet zone is
  a floor here, not a default you can talk down to zero.
* **Pixel boundaries.** ``shape-rendering="crispEdges"`` keeps the browser
  from antialiasing a one-module bar into two grey ones. A blurred narrow bar
  is a bar the decoder measures wrong.
"""

from __future__ import annotations

# --------------------------------------------------------------------------
# The symbology
# --------------------------------------------------------------------------

# Element widths, in modules, for the 107 Code 128 symbol characters. Each row
# alternates bar, space, bar, space, bar, space and sums to 11 modules; the
# stop pattern (106) is the exception, carrying a seventh element - the extra
# terminating bar - for 13 modules total.
#
# Three structural invariants hold for every row and are asserted in the
# tests, because a single transposed digit here is a barcode that scans as the
# wrong character: eleven modules, every element 1..4 wide, and the three bars
# summing to an even number of modules. That last one is the symbology's own
# parity rule and catches the typo the first two miss.
BAR_PATTERNS: tuple[tuple[int, ...], ...] = (
    (2, 1, 2, 2, 2, 2),  # 0    space
    (2, 2, 2, 1, 2, 2),  # 1    !
    (2, 2, 2, 2, 2, 1),  # 2    "
    (1, 2, 1, 2, 2, 3),  # 3    #
    (1, 2, 1, 3, 2, 2),  # 4    $
    (1, 3, 1, 2, 2, 2),  # 5    %
    (1, 2, 2, 2, 1, 3),  # 6    &
    (1, 2, 2, 3, 1, 2),  # 7    '
    (1, 3, 2, 2, 1, 2),  # 8    (
    (2, 2, 1, 2, 1, 3),  # 9    )
    (2, 2, 1, 3, 1, 2),  # 10   *
    (2, 3, 1, 2, 1, 2),  # 11   +
    (1, 1, 2, 2, 3, 2),  # 12   ,
    (1, 2, 2, 1, 3, 2),  # 13   -
    (1, 2, 2, 2, 3, 1),  # 14   .
    (1, 1, 3, 2, 2, 2),  # 15   /
    (1, 2, 3, 1, 2, 2),  # 16   0
    (1, 2, 3, 2, 2, 1),  # 17   1
    (2, 2, 3, 2, 1, 1),  # 18   2
    (2, 2, 1, 1, 3, 2),  # 19   3
    (2, 2, 1, 2, 3, 1),  # 20   4
    (2, 1, 3, 2, 1, 2),  # 21   5
    (2, 2, 3, 1, 1, 2),  # 22   6
    (3, 1, 2, 1, 3, 1),  # 23   7
    (3, 1, 1, 2, 2, 2),  # 24   8
    (3, 2, 1, 1, 2, 2),  # 25   9
    (3, 2, 1, 2, 2, 1),  # 26   :
    (3, 1, 2, 2, 1, 2),  # 27   ;
    (3, 2, 2, 1, 1, 2),  # 28   <
    (3, 2, 2, 2, 1, 1),  # 29   =
    (2, 1, 2, 1, 2, 3),  # 30   >
    (2, 1, 2, 3, 2, 1),  # 31   ?
    (2, 3, 2, 1, 2, 1),  # 32   @
    (1, 1, 1, 3, 2, 3),  # 33   A
    (1, 3, 1, 1, 2, 3),  # 34   B
    (1, 3, 1, 3, 2, 1),  # 35   C
    (1, 1, 2, 3, 1, 3),  # 36   D
    (1, 3, 2, 1, 1, 3),  # 37   E
    (1, 3, 2, 3, 1, 1),  # 38   F
    (2, 1, 1, 3, 1, 3),  # 39   G
    (2, 3, 1, 1, 1, 3),  # 40   H
    (2, 3, 1, 3, 1, 1),  # 41   I
    (1, 1, 2, 1, 3, 3),  # 42   J
    (1, 1, 2, 3, 3, 1),  # 43   K
    (1, 3, 2, 1, 3, 1),  # 44   L
    (1, 1, 3, 1, 2, 3),  # 45   M
    (1, 1, 3, 3, 2, 1),  # 46   N
    (1, 3, 3, 1, 2, 1),  # 47   O
    (3, 1, 3, 1, 2, 1),  # 48   P
    (2, 1, 1, 3, 3, 1),  # 49   Q
    (2, 3, 1, 1, 3, 1),  # 50   R
    (2, 1, 3, 1, 1, 3),  # 51   S
    (2, 1, 3, 3, 1, 1),  # 52   T
    (2, 1, 3, 1, 3, 1),  # 53   U
    (3, 1, 1, 1, 2, 3),  # 54   V
    (3, 1, 1, 3, 2, 1),  # 55   W
    (3, 3, 1, 1, 2, 1),  # 56   X
    (3, 1, 2, 1, 1, 3),  # 57   Y
    (3, 1, 2, 3, 1, 1),  # 58   Z
    (3, 3, 2, 1, 1, 1),  # 59   [
    (3, 1, 4, 1, 1, 1),  # 60   \
    (2, 2, 1, 4, 1, 1),  # 61   ]
    (4, 3, 1, 1, 1, 1),  # 62   ^
    (1, 1, 1, 2, 2, 4),  # 63   _
    (1, 1, 1, 4, 2, 2),  # 64   `
    (1, 2, 1, 1, 2, 4),  # 65   a
    (1, 2, 1, 4, 2, 1),  # 66   b
    (1, 4, 1, 1, 2, 2),  # 67   c
    (1, 4, 1, 2, 2, 1),  # 68   d
    (1, 1, 2, 2, 1, 4),  # 69   e
    (1, 1, 2, 4, 1, 2),  # 70   f
    (1, 2, 2, 1, 1, 4),  # 71   g
    (1, 2, 2, 4, 1, 1),  # 72   h
    (1, 4, 2, 1, 1, 2),  # 73   i
    (1, 4, 2, 2, 1, 1),  # 74   j
    (2, 4, 1, 2, 1, 1),  # 75   k
    (2, 2, 1, 1, 1, 4),  # 76   l
    (4, 1, 3, 1, 1, 1),  # 77   m
    (2, 4, 1, 1, 1, 2),  # 78   n
    (1, 3, 4, 1, 1, 1),  # 79   o
    (1, 1, 1, 2, 4, 2),  # 80   p
    (1, 2, 1, 1, 4, 2),  # 81   q
    (1, 2, 1, 2, 4, 1),  # 82   r
    (1, 1, 4, 2, 1, 2),  # 83   s
    (1, 2, 4, 1, 1, 2),  # 84   t
    (1, 2, 4, 2, 1, 1),  # 85   u
    (4, 1, 1, 2, 1, 2),  # 86   v
    (4, 2, 1, 1, 1, 2),  # 87   w
    (4, 2, 1, 2, 1, 1),  # 88   x
    (2, 1, 2, 1, 4, 1),  # 89   y
    (2, 1, 4, 1, 2, 1),  # 90   z
    (4, 1, 2, 1, 2, 1),  # 91   {
    (1, 1, 1, 1, 4, 3),  # 92   |
    (1, 1, 1, 3, 4, 1),  # 93   }
    (1, 3, 1, 1, 4, 1),  # 94   ~
    (1, 1, 4, 1, 1, 3),  # 95   DEL / FNC 3
    (1, 1, 4, 3, 1, 1),  # 96   FNC 2
    (4, 1, 1, 1, 1, 3),  # 97   SHIFT
    (4, 1, 1, 3, 1, 1),  # 98   CODE C
    (1, 1, 3, 1, 4, 1),  # 99   CODE A / FNC 4
    (1, 1, 4, 1, 3, 1),  # 100  FNC 4 / CODE A
    (3, 1, 1, 1, 4, 1),  # 101  CODE B
    (4, 1, 1, 1, 3, 1),  # 102  FNC 1
    (2, 1, 1, 4, 1, 2),  # 103  START A
    (2, 1, 1, 2, 1, 4),  # 104  START B
    (2, 1, 1, 2, 3, 2),  # 105  START C
    (2, 3, 3, 1, 1, 1, 2),  # 106  STOP (13 modules, seven elements)
)

START_B = 104
STOP = 106
CHECKSUM_MODULUS = 103

# Code set B's window onto ASCII. Value = code point - 32.
LOWEST_CODE_POINT = 32
HIGHEST_CODE_POINT = 126

# The white margin either side, in modules. The spec says ten; a screen-read
# barcode with less is the bug this constant exists to make un-writable.
MIN_QUIET_MODULES = 10


def encode(text: str) -> list[int]:
    """Return the full run of code values: start B, data, checksum, stop.

    The checksum is the weighted modulo-103 sum the symbology defines: the
    start value plus each data value multiplied by its one-based position.
    """
    values = data_values(text)
    checksum = START_B
    for position, value in enumerate(values, start=1):
        checksum += position * value
    return [START_B, *values, checksum % CHECKSUM_MODULUS, STOP]


def data_values(text: str) -> list[int]:
    """The data portion alone, validating every character on the way through."""
    if not isinstance(text, str):
        raise TypeError("text must be a string, not %s" % type(text).__name__)
    if not text:
        raise ValueError("there is nothing to encode: text is empty")
    values = []
    for index, char in enumerate(text):
        point = ord(char)
        if point < LOWEST_CODE_POINT or point > HIGHEST_CODE_POINT:
            raise ValueError(
                "character %d (%r, code point %d) is outside printable ASCII; "
                "Code 128 set B encodes %d..%d only"
                % (index, char, point, LOWEST_CODE_POINT, HIGHEST_CODE_POINT)
            )
        values.append(point - LOWEST_CODE_POINT)
    return values


def elements(values) -> list[int]:
    """Flatten code values into one alternating bar/space width run.

    The run starts on a bar and every non-stop pattern is six elements long,
    so the alternation survives concatenation; the stop pattern's seventh
    element is the terminating bar and comes last by construction.
    """
    run: list[int] = []
    for value in values:
        run.extend(BAR_PATTERNS[value])
    return run


def module_width(text: str) -> int:
    """Total modules the symbol occupies, quiet zones excluded."""
    return sum(elements(encode(text)))


def svg(text: str, height_px: int = 120, module_px: int = 3,
        quiet_modules: int = MIN_QUIET_MODULES) -> str:
    """Render ``text`` as a standalone Code 128 SVG document.

    White ground, black bars, a quiet zone of at least ten modules each side,
    and not one external reference - no font, no stylesheet, no image - so the
    page can drop it into an ``<img src>`` and a browser with no network can
    still draw it.
    """
    height_px = _positive(height_px, "height_px")
    module_px = _positive(module_px, "module_px")
    quiet_modules = int(quiet_modules)
    if quiet_modules < MIN_QUIET_MODULES:
        raise ValueError(
            "quiet_modules must be at least %d: a barcode scanned off a screen "
            "without a quiet zone is the classic will-not-read bug"
            % MIN_QUIET_MODULES
        )

    run = elements(encode(text))
    width_px = (2 * quiet_modules + sum(run)) * module_px

    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" '
        'width="%d" height="%d" viewBox="0 0 %d %d" '
        'shape-rendering="crispEdges" role="img" aria-label="%s">'
        % (width_px, height_px, width_px, height_px, _escape(text)),
        # The ground is drawn, not assumed: an SVG with a transparent
        # background inherits whatever panel it lands on, and a barcode on a
        # dark panel is a barcode with no contrast and no quiet zone.
        '<rect x="0" y="0" width="%d" height="%d" fill="#ffffff"/>'
        % (width_px, height_px),
    ]
    cursor = quiet_modules
    for index, modules in enumerate(run):
        if index % 2 == 0:  # even elements are bars, odd ones are spaces
            parts.append(
                '<rect x="%d" y="0" width="%d" height="%d" fill="#000000"/>'
                % (cursor * module_px, modules * module_px, height_px)
            )
        cursor += modules
    parts.append("</svg>")
    return "".join(parts)


def _positive(value, name: str) -> int:
    number = int(value)
    if number < 1:
        raise ValueError("%s must be at least 1, got %r" % (name, value))
    return number


def _escape(text: str) -> str:
    """XML-escape the label text.

    ``<`` and ``&`` are both inside code set B's range, and this document is
    served as ``image/svg+xml`` - which a browser will happily parse as a
    document if someone opens the URL directly. Escaping is what keeps a query
    parameter from becoming markup.
    """
    return (text.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace('"', "&quot;"))
