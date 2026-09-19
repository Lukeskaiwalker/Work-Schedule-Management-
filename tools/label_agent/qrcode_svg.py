#!/usr/bin/env python3
"""QR Code (model 2) as a module matrix and as a self-contained SVG.

Why this exists: the wall screen facing the construction boxes has no
keyboard, so its commands (``SMPL-CMD-FERTIG`` and friends) are symbols drawn
on the glass for the worker to scan. They were Code 128, and the handheld -
a 2D imager - kept missing them: a one-dimensional code has to be swept level
in one pass, on a screen above eye height and behind a reflection. A QR code
is read as a picture, at any angle, in one frame. So the crate screen embeds
these instead, and ``barcode128`` stays for the printed sheets.

Stdlib only, for the same reason as ``barcode128``: a broken wheel must never
be able to stop the agent from booting, and a command code that will not
render is that failure one screen further on. So: no Pillow, no ``qrcode``
package - a handful of tables and the arithmetic the standard describes.

What is here, and what is deliberately not:

* Byte mode only, UTF-8. Alphanumeric mode would save a few modules on the
  upper-case command codes at the cost of a second encoder nothing reaches.
* Versions 1..10, automatically chosen. The vocabulary fits version 2;
  version 10 at level M carries 213 bytes, past anything the route admits.
* All four error-correction levels, because the parameter exists to name
  one; the wall uses M, which survives a reflection across a corner.
* Every mask is tried and scored with the standard's four penalty rules. The
  scoring copies python-qrcode's - format information left light while the
  masks are compared, ties to the lowest number. Any mask decodes; matching
  that package is what lets the tests hold this module against vectors taken
  from it, bit for bit, without shipping the package.

Two things about screens, inherited from ``barcode128`` and both the
difference between "it scans" and "it does not": the **quiet zone** - four
light modules all round are part of the symbol, so four is a floor here and
the page paints the white ground behind it - and **pixel boundaries** -
``shape-rendering="crispEdges"`` keeps the browser from antialiasing a
module's edge into grey that the decoder samples wrong.
"""

from __future__ import annotations

import itertools

# --------------------------------------------------------------------------
# The symbology's tables
# --------------------------------------------------------------------------

MIN_VERSION = 1
MAX_VERSION = 10
DEFAULT_LEVEL = "M"
# What version 10 at level M holds in byte mode - the encoder's ceiling,
# asserted in the tests against the block table it is derived from.
MAX_BYTES = 213
# The standard's quiet zone. Less is the will-not-read bug, so it is a floor.
MIN_QUIET_MODULES = 4

# Alignment pattern centres per version; every pair of coordinates that does
# not land on a finder gets a pattern.
ALIGNMENT = ((), (6, 18), (6, 22), (6, 26), (6, 30), (6, 34),
             (6, 22, 38), (6, 24, 42), (6, 26, 46), (6, 28, 50))

# Reed-Solomon block structure per level and version (ISO/IEC 18004 table 9):
# (ec codewords per block, blocks in group 1, data codewords per group-1
# block, blocks in group 2, data codewords per group-2 block). Every row sums
# to the version's codeword count, which the tests assert: a transposed digit
# here is a symbol that decodes to nothing.
BLOCKS = {
    "L": ((7, 1, 19, 0, 0), (10, 1, 34, 0, 0), (15, 1, 55, 0, 0), (20, 1, 80, 0, 0),
          (26, 1, 108, 0, 0), (18, 2, 68, 0, 0), (20, 2, 78, 0, 0), (24, 2, 97, 0, 0),
          (30, 2, 116, 0, 0), (18, 2, 68, 2, 69)),
    "M": ((10, 1, 16, 0, 0), (16, 1, 28, 0, 0), (26, 1, 44, 0, 0), (18, 2, 32, 0, 0),
          (24, 2, 43, 0, 0), (16, 4, 27, 0, 0), (18, 4, 31, 0, 0), (22, 2, 38, 2, 39),
          (22, 3, 36, 2, 37), (26, 4, 43, 1, 44)),
    "Q": ((13, 1, 13, 0, 0), (22, 1, 22, 0, 0), (18, 2, 17, 0, 0), (26, 2, 24, 0, 0),
          (18, 2, 15, 2, 16), (24, 4, 19, 0, 0), (18, 2, 14, 4, 15), (22, 4, 18, 2, 19),
          (20, 4, 16, 4, 17), (24, 6, 19, 2, 20)),
    "H": ((17, 1, 9, 0, 0), (28, 1, 16, 0, 0), (22, 2, 13, 0, 0), (16, 4, 9, 0, 0),
          (22, 2, 11, 2, 12), (28, 4, 15, 0, 0), (26, 4, 13, 1, 14), (26, 4, 14, 2, 15),
          (24, 4, 12, 4, 13), (28, 6, 15, 2, 16)),
}
# Total codewords per version, the sum every BLOCKS row must reach.
TOTAL_CODEWORDS = (26, 44, 70, 100, 134, 172, 196, 242, 292, 346)
# The two bits that name the level inside the format information.
LEVEL_BITS = {"L": 1, "M": 0, "Q": 3, "H": 2}

BYTE_MODE = 0b0100
PAD_BYTES = (0xEC, 0x11)
FORMAT_GENERATOR = 0x537        # x^10 + x^8 + x^5 + x^4 + x^2 + x + 1
FORMAT_MASK = 0x5412
VERSION_GENERATOR = 0x1F25      # x^12 + x^11 + x^10 + x^9 + x^8 + x^5 + x^2 + 1

MASKS = (
    lambda r, c: (r + c) % 2 == 0,
    lambda r, c: r % 2 == 0,
    lambda r, c: c % 3 == 0,
    lambda r, c: (r + c) % 3 == 0,
    lambda r, c: (r // 2 + c // 3) % 2 == 0,
    lambda r, c: (r * c) % 2 + (r * c) % 3 == 0,
    lambda r, c: ((r * c) % 2 + (r * c) % 3) % 2 == 0,
    lambda r, c: ((r * c) % 3 + (r + c) % 2) % 2 == 0,
)
# Penalty rule 3: a finder-like 1:1:3:1:1 run with four light modules on one
# side, scored wherever it appears in a row or a column.
FINDER_LIKE = ("10111010000", "00001011101")

# --------------------------------------------------------------------------
# GF(256) and Reed-Solomon
# --------------------------------------------------------------------------

_EXP = [0] * 512
_LOG = [0] * 256
_value = 1
for _power in range(255):
    _EXP[_power], _LOG[_value] = _value, _power
    _value = (_value << 1) ^ (0x11D if _value & 0x80 else 0)
for _power in range(255, 512):
    _EXP[_power] = _EXP[_power - 255]


def _multiply(a: int, b: int) -> int:
    return 0 if a == 0 or b == 0 else _EXP[_LOG[a] + _LOG[b]]


def _generator(degree: int) -> list[int]:
    """The product of (x - a^i) for i below ``degree``, highest power first."""
    poly = [1]
    for power in range(degree):
        root = _EXP[power]
        poly = [coefficient ^ (_multiply(poly[index - 1], root) if index else 0)
                for index, coefficient in enumerate(poly + [0])]
    return poly


def _ec_codewords(data: list[int], degree: int) -> list[int]:
    """The remainder of data * x^degree divided by the generator."""
    generator = _generator(degree)
    remainder = [0] * degree
    for byte in data:
        factor = byte ^ remainder[0]
        remainder = remainder[1:] + [0]
        if factor:
            for index in range(degree):
                remainder[index] ^= _multiply(generator[index + 1], factor)
    return remainder


# --------------------------------------------------------------------------
# Validation and version choice
# --------------------------------------------------------------------------


def data_codewords(version: int, level: str) -> int:
    ec, g1, d1, g2, d2 = BLOCKS[level][version - 1]
    return g1 * d1 + g2 * d2


def capacity(version: int, level: str) -> int:
    """Bytes a version holds in byte mode: mode, count and the data itself."""
    return (data_codewords(version, level) * 8 - 4 - (16 if version >= 10 else 8)) // 8


def _level(ec: str) -> str:
    if ec not in BLOCKS:
        raise ValueError("error-correction level must be L, M, Q or H, not %r" % (ec,))
    return ec


def _payload(text: str, level: str) -> bytes:
    if not isinstance(text, str):
        raise TypeError("text must be a string, not %s" % type(text).__name__)
    if not text:
        raise ValueError("there is nothing to encode: text is empty")
    payload = text.encode("utf-8")
    limit = capacity(MAX_VERSION, level)
    if len(payload) > limit:
        raise ValueError("text is %d bytes as UTF-8; a version-%d QR code at level %s holds %d"
                         % (len(payload), MAX_VERSION, level, limit))
    return payload


def version_for(text: str, ec: str = DEFAULT_LEVEL) -> int:
    """The smallest version 1..10 whose data area holds ``text`` at ``ec``."""
    level = _level(ec)
    size = len(_payload(text, level))
    return next(v for v in range(MIN_VERSION, MAX_VERSION + 1) if size <= capacity(v, level))


# --------------------------------------------------------------------------
# Codewords
# --------------------------------------------------------------------------


def _data_codewords(payload: bytes, version: int, level: str) -> list[int]:
    """Mode, count, data, terminator, byte alignment, then the pad pattern."""
    room = data_codewords(version, level)
    bits = "{:04b}".format(BYTE_MODE) + "{:0{}b}".format(len(payload), 16 if version >= 10 else 8)
    bits += "".join("{:08b}".format(byte) for byte in payload)
    bits += "0" * min(4, room * 8 - len(bits))
    bits += "0" * (-len(bits) % 8)
    words = [int(bits[i:i + 8], 2) for i in range(0, len(bits), 8)]
    return words + [PAD_BYTES[i % 2] for i in range(room - len(words))]


def _codewords(payload: bytes, version: int, level: str) -> list[int]:
    """Split into blocks, protect each, and interleave the way a reader expects."""
    data = _data_codewords(payload, version, level)
    ec, g1, d1, g2, d2 = BLOCKS[level][version - 1]
    blocks, cursor = [], 0
    for count, size in ((g1, d1), (g2, d2)):
        for _ in range(count):
            blocks.append(data[cursor:cursor + size])
            cursor += size
    protection = [_ec_codewords(block, ec) for block in blocks]
    out = [block[i] for i in range(max(map(len, blocks))) for block in blocks if i < len(block)]
    return out + [block[i] for i in range(ec) for block in protection]


# --------------------------------------------------------------------------
# The matrix
# --------------------------------------------------------------------------


def _format_positions(n: int):
    """Where the 15 format bits go, bit 0 first: beside the top-left finder,
    then the copy split between the other two. Row 8 and column 8 cross the
    timing patterns, which neither list touches."""
    near = [(i, 8) for i in range(6)] + [(7, 8), (8, 8), (8, 7)] + [(8, 5 - i) for i in range(6)]
    far = [(8, n - 1 - i) for i in range(8)] + [(n - 7 + i, 8) for i in range(7)]
    return near, far


def _blank(version: int):
    """Function patterns drawn, everything the data may not touch reserved."""
    n = 17 + 4 * version
    modules = [[False] * n for _ in range(n)]
    reserved = [[False] * n for _ in range(n)]

    def paint(row: int, col: int, dark: bool) -> None:
        if 0 <= row < n and 0 <= col < n:
            modules[row][col] = dark
            reserved[row][col] = True

    for top, left in ((0, 0), (0, n - 7), (n - 7, 0)):
        for r in range(-1, 8):
            for c in range(-1, 8):
                ring = (0 <= r <= 6 and c in (0, 6)) or (0 <= c <= 6 and r in (0, 6))
                paint(top + r, left + c, ring or (2 <= r <= 4 and 2 <= c <= 4))
    centres = ALIGNMENT[version - 1]
    for row in centres:
        for col in centres:
            if reserved[row][col]:
                continue  # it would sit on a finder
            for r in range(-2, 3):
                for c in range(-2, 3):
                    paint(row + r, col + c, abs(r) == 2 or abs(c) == 2 or r == c == 0)
    for i in range(8, n - 8):
        paint(6, i, i % 2 == 0)
        paint(i, 6, i % 2 == 0)
    # Format information, both copies, the dark module, and the version
    # information from 7 up: reserved light, written once the mask is known.
    near, far = _format_positions(n)
    for row, col in near + far + [(n - 8, 8)]:
        paint(row, col, False)
    if version >= 7:
        for i in range(18):
            paint(i // 3, n - 11 + i % 3, False)
            paint(n - 11 + i % 3, i // 3, False)
    return modules, reserved


def _place(modules, reserved, codewords: list[int], mask) -> None:
    """Walk the standard's zig-zag, two columns at a time, masking as it goes."""
    n = len(modules)
    bits = iter(bit for word in codewords for bit in ((word >> s) & 1 for s in range(7, -1, -1)))
    row, step = n - 1, -1
    for col in range(n - 1, 0, -2):
        if col <= 6:
            col -= 1  # the timing column is never a data column
        while 0 <= row < n:
            for c in (col, col - 1):
                if not reserved[row][c]:
                    modules[row][c] = bool(next(bits, 0)) ^ mask(row, c)
            row += step
        step = -step
        row += step


def _bch(data: int, generator: int, degree: int, width: int) -> int:
    """``data`` shifted up by ``degree`` with the generator's remainder appended."""
    remainder = data << degree
    for shift in range(width - degree - 1, -1, -1):
        if remainder & (1 << (shift + degree)):
            remainder ^= generator << shift
    return (data << degree) | remainder


def _write_format(modules, level: str, mask: int) -> None:
    n = len(modules)
    bits = _bch((LEVEL_BITS[level] << 3) | mask, FORMAT_GENERATOR, 10, 15) ^ FORMAT_MASK
    for i, positions in enumerate(zip(*_format_positions(n))):
        for row, col in positions:
            modules[row][col] = bool((bits >> i) & 1)
    modules[n - 8][8] = True  # the dark module, always


def _write_version(modules, version: int) -> None:
    n = len(modules)
    bits = _bch(version, VERSION_GENERATOR, 12, 18)
    for i in range(18):
        modules[i // 3][n - 11 + i % 3] = modules[n - 11 + i % 3][i // 3] = bool((bits >> i) & 1)


# --------------------------------------------------------------------------
# Mask scoring
# --------------------------------------------------------------------------


def penalty(modules) -> int:
    """The standard's four rules, summed, the way python-qrcode sums them."""
    n = len(modules)
    rows = ["".join("1" if dark else "0" for dark in row) for row in modules]
    cols = ["".join(rows[r][c] for r in range(n)) for c in range(n)]
    score = 0
    for line in rows + cols:
        runs = [len(list(run)) for _bit, run in itertools.groupby(line)]
        score += sum(length - 2 for length in runs if length >= 5)
        score += 40 * sum(1 for i in range(n - 10) if line[i:i + 11] in FINDER_LIKE)
    for r in range(n - 1):
        for c in range(n - 1):
            if modules[r][c] == modules[r][c + 1] == modules[r + 1][c] == modules[r + 1][c + 1]:
                score += 3
    # Rule 4 in the reference's own floating point: the tests compare mask
    # choices against it, and a boundary rounded the other way is a tie
    # broken the other way.
    percent = float(sum(map(sum, modules))) / (n * n)
    return score + 10 * int(abs(percent * 100 - 50) / 5)


def _symbol(text: str, ec: str, mask):
    level = _level(ec)
    payload = _payload(text, level)
    version = version_for(text, level)
    codewords = _codewords(payload, version, level)
    blank, reserved = _blank(version)

    def masked(number: int):
        modules = [row[:] for row in blank]
        _place(modules, reserved, codewords, MASKS[number])
        return modules

    if mask is None:
        mask = min(range(len(MASKS)), key=lambda number: penalty(masked(number)))
    elif mask not in range(len(MASKS)):
        raise ValueError("mask must be 0..7 or None for automatic, not %r" % (mask,))
    modules = masked(mask)
    _write_format(modules, level, mask)
    if version >= 7:
        _write_version(modules, version)
    return version, mask, modules


# --------------------------------------------------------------------------
# Public surface
# --------------------------------------------------------------------------


def matrix(text: str, ec: str = DEFAULT_LEVEL, mask=None) -> list[list[bool]]:
    """The finished symbol, row-major, ``True`` for a dark module.

    ``mask`` is normally left to the scorer; forcing one is for the tests,
    which hold every mask against a reference.
    """
    return _symbol(text, ec, mask)[2]


def best_mask(text: str, ec: str = DEFAULT_LEVEL) -> int:
    """The mask the scorer picks for ``text`` - the one ``matrix`` draws."""
    return _symbol(text, ec, None)[1]


def svg(text: str, module_px: int = 4, quiet_modules: int = MIN_QUIET_MODULES,
        ec: str = DEFAULT_LEVEL) -> str:
    """Render ``text`` as a standalone QR SVG document.

    White ground, black modules as one path, a quiet zone of at least four
    modules all round, and not one external reference - no font, no
    stylesheet, no image - so the page can drop it into an ``<img src>`` and
    a browser with no network can still draw it.
    """
    module_px = int(module_px)
    if module_px < 1:
        raise ValueError("module_px must be at least 1, got %r" % (module_px,))
    quiet_modules = int(quiet_modules)
    if quiet_modules < MIN_QUIET_MODULES:
        raise ValueError(
            "quiet_modules must be at least %d: a QR code scanned off a screen "
            "without a quiet zone is the classic will-not-read bug" % MIN_QUIET_MODULES
        )
    modules = matrix(text, ec)
    size_px = (len(modules) + 2 * quiet_modules) * module_px

    # Each row's dark runs become one rectangle apiece; the path is a third
    # the size of a rect per module and draws identically.
    segments = []
    for r, row in enumerate(modules):
        col = 0
        for dark, run in itertools.groupby(row):
            length = len(list(run))
            if dark:
                segments.append("M%d %dh%dv%dh-%dz" % (
                    (quiet_modules + col) * module_px, (quiet_modules + r) * module_px,
                    length * module_px, module_px, length * module_px))
            col += length
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" '
        'width="%d" height="%d" viewBox="0 0 %d %d" '
        'shape-rendering="crispEdges" role="img" aria-label="%s">'
        % (size_px, size_px, size_px, size_px, _escape(text))
        # The ground is drawn, not assumed: a transparent symbol inherits
        # whatever panel it lands on, and dark blue is not a quiet zone.
        + '<rect x="0" y="0" width="%d" height="%d" fill="#ffffff"/>' % (size_px, size_px)
        + '<path fill="#000000" d="%s"/></svg>' % "".join(segments)
    )


def _escape(text: str) -> str:
    """XML-escape the label: this document is served as ``image/svg+xml``."""
    return (text.replace("&", "&amp;").replace("<", "&lt;")
                .replace(">", "&gt;").replace('"', "&quot;"))
