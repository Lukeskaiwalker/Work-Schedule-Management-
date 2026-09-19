"""QR proved by reading it back, not by re-reading the tables it was built from.

Same discipline as ``test_barcode128``: asserting that the encoder's output
equals the encoder's own table tests a copy-paste, not a symbol. So this file
does three independent things.

1. **A reader.** ``decode`` walks the finished matrix the way a scanner does:
   it works out the function modules from the standard's layout rules (its
   own transcription, alignment centres computed rather than copied), takes
   the mask off, un-zig-zags the bits, de-interleaves the blocks with its own
   copy of the level-M block table, checks every Reed-Solomon block's
   syndromes with its own GF(256), and parses the byte stream back into text.
   A wrong block size, a wrong generator, a bit placed one module off - all of
   them come back as "did not decode".

2. **A fixed vector.** The module matrix of ``SMPL-CMD-FERTIG`` as the
   ``qrcode`` package (7.4.2) draws it - version 2, mask 1 - typed in below.
   That pins the whole pipeline, mask choice included, without needing the
   package at test time.

3. **The package itself, when it is there.** In the API venv ``qrcode`` is
   importable, and then every payload across the version boundaries is held
   against it at all eight forced masks and at the automatic one. Elsewhere
   those tests skip; the two above still run.

A note on the reference: ``QRCode.best_mask_pattern()`` re-runs the symbol in
test mode and leaves ``modules`` at mask 7 with the format area blank, so the
reference matrix has to be read *before* the mask is asked for.
"""

from __future__ import annotations

import re
import string
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import qrcode_svg  # noqa: E402

try:
    import qrcode  # noqa: E402
    import qrcode.base  # noqa: E402
    import qrcode.constants  # noqa: E402
    import qrcode.util  # noqa: E402
    HAVE_QRCODE = True
except ImportError:
    HAVE_QRCODE = False

# The command vocabulary the crate screen shows, verbatim from scan_router.
COMMAND_CODES = (
    "SMPL-CMD-FERTIG",
    "SMPL-CMD-ABBRUCH",
    "SMPL-CMD-ENTNAHME",
    "SMPL-CMD-MITNEHMEN",
)

# Byte-mode capacity at level M, versions 1..10 (ISO/IEC 18004 table 7). The
# other transcription of what the block table implies.
M_CAPACITY = (14, 26, 42, 62, 84, 106, 122, 152, 180, 213)

# Level M blocks as (ec codewords, data codewords per block, block by block):
# a different shape from the encoder's table on purpose.
M_BLOCKS = (
    (10, (16,)), (16, (28,)), (26, (44,)), (18, (32, 32)), (24, (43, 43)),
    (16, (27, 27, 27, 27)), (18, (31, 31, 31, 31)), (22, (38, 38, 39, 39)),
    (22, (36, 36, 36, 37, 37)), (26, (43, 43, 43, 43, 44)),
)

FINDER = (
    "1111111",
    "1000001",
    "1011101",
    "1011101",
    "1011101",
    "1000001",
    "1111111",
)

# qrcode 7.4.2, ERROR_CORRECT_M, MODE_8BIT_BYTE, border=0: version 2, mask 1.
FIXED_VECTOR = (
    "1111111011011001101111111",
    "1000001001011110101000001",
    "1011101010110011101011101",
    "1011101000000010001011101",
    "1011101001111111001011101",
    "1000001011011001001000001",
    "1111111010101010101111111",
    "0000000000000011100000000",
    "1010001101010110100100101",
    "0100000000000110000100010",
    "0011011010101001001011101",
    "0110000011011101101111010",
    "1100011001111101101101100",
    "0101110001001000100001100",
    "1100011110001111001111101",
    "0001100011011010010100011",
    "1111011110100110111111011",
    "0000000010000110100011110",
    "1111111011010001101010101",
    "1000001001000101100011011",
    "1011101000111101111111100",
    "1011101001001000010000000",
    "1011101010101110101010011",
    "1000001000111011000101000",
    "1111111011000110110001101",
)

ALPHABET = string.ascii_letters + string.digits + "-/ .:"


def payload(size: int) -> str:
    """A deterministic text of ``size`` ASCII bytes with no repeating run."""
    return "".join(ALPHABET[(i * 7) % len(ALPHABET)] for i in range(size))


def at_version(version: int) -> str:
    """The longest text version ``version`` holds at level M."""
    return payload(M_CAPACITY[version - 1])


def bits(matrix) -> str:
    return "".join("1" if dark else "0" for row in matrix for dark in row)


# --------------------------------------------------------------------------
# The reader
# --------------------------------------------------------------------------

_EXP = [0] * 512
_LOG = [0] * 256
_x = 1
for _i in range(255):
    _EXP[_i], _LOG[_x] = _x, _i
    _x = (_x << 1) ^ (0x11D if _x & 0x80 else 0)
for _i in range(255, 512):
    _EXP[_i] = _EXP[_i - 255]


def gf_mul(a: int, b: int) -> int:
    return 0 if 0 in (a, b) else _EXP[_LOG[a] + _LOG[b]]


def alignment_centres(version: int) -> list[int]:
    """Annex E of the standard, computed (Nayuki's closed form), not copied."""
    if version == 1:
        return []
    count = version // 7 + 2
    step = (version * 8 + count * 3 + 5) // (count * 4 - 4) * 2
    size = 17 + 4 * version
    return [6] + [size - 7 - step * i for i in range(count - 2, -1, -1)]


def function_map(version: int) -> list[list[bool]]:
    """True wherever the symbol is not data: the layout rules, transcribed."""
    n = 17 + 4 * version
    fixed = [[False] * n for _ in range(n)]

    def mark(r: int, c: int) -> None:
        if 0 <= r < n and 0 <= c < n:
            fixed[r][c] = True

    for top, left in ((0, 0), (0, n - 7), (n - 7, 0)):
        for r in range(-1, 8):
            for c in range(-1, 8):
                mark(top + r, left + c)
    centres = alignment_centres(version)
    for r in centres:
        for c in centres:
            if fixed[r][c]:
                continue
            for dr in range(-2, 3):
                for dc in range(-2, 3):
                    mark(r + dr, c + dc)
    for i in range(n):
        mark(6, i)
        mark(i, 6)
    for i in range(9):
        mark(8, i)
        mark(i, 8)
    for i in range(8):
        mark(8, n - 1 - i)
        mark(n - 1 - i, 8)
    if version >= 7:
        for i in range(18):
            mark(i // 3, n - 11 + i % 3)
            mark(n - 11 + i % 3, i // 3)
    return fixed


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


def read_format(matrix) -> tuple[int, int]:
    """(level bits, mask) from the copy beside the top-left finder, BCH-checked.

    Bit 0 - the least significant - sits at (0, 8) and at (8, n-1); bit 14
    at (8, 0) and at (n-1, 8). Both lists below run from bit 0 upward.
    """
    n = len(matrix)
    positions = [(i, 8) for i in range(6)] + [(7, 8), (8, 8), (8, 7)] + [(8, 5 - i) for i in range(6)]
    value = 0
    for index, (r, c) in enumerate(positions):
        value |= int(matrix[r][c]) << index
    other = [(8, n - 1 - i) for i in range(8)] + [(n - 7 + i, 8) for i in range(7)]
    mirrored = 0
    for index, (r, c) in enumerate(other):
        mirrored |= int(matrix[r][c]) << index
    if mirrored != value:
        raise Unreadable("the two copies of the format information disagree")
    unmasked = value ^ 0x5412
    remainder = unmasked
    for shift in range(14, 9, -1):
        if remainder & (1 << shift):
            remainder ^= 0x537 << (shift - 10)
    if remainder:
        raise Unreadable("format information fails its BCH check")
    return unmasked >> 13, (unmasked >> 10) & 0b111


def read_version(matrix) -> int:
    n = len(matrix)
    value = 0
    for i in range(18):
        value |= int(matrix[i // 3][n - 11 + i % 3]) << i
        if matrix[i // 3][n - 11 + i % 3] != matrix[n - 11 + i % 3][i // 3]:
            raise Unreadable("the two copies of the version information disagree")
    remainder = value
    for shift in range(17, 11, -1):
        if remainder & (1 << shift):
            remainder ^= 0x1F25 << (shift - 12)
    if remainder:
        raise Unreadable("version information fails its BCH check")
    return value >> 12


class Unreadable(Exception):
    """What a scanner would express as a beep that never comes."""


def read_codewords(matrix, version: int, mask: int) -> list[int]:
    n = len(matrix)
    fixed = function_map(version)
    unmask = MASKS[mask]
    stream = []
    row, step = n - 1, -1
    for col in range(n - 1, 0, -2):
        if col <= 6:
            col -= 1
        while 0 <= row < n:
            for c in (col, col - 1):
                if not fixed[row][c]:
                    stream.append(matrix[row][c] ^ unmask(row, c))
            row += step
        step = -step
        row += step
    return [int("".join("1" if b else "0" for b in stream[i:i + 8]), 2)
            for i in range(0, len(stream) - len(stream) % 8, 8)]


def decode(matrix) -> str:
    """The text a scanner would report, or ``Unreadable``."""
    n = len(matrix)
    if (n - 17) % 4 or not all(len(row) == n for row in matrix):
        raise Unreadable("not a square of 17 + 4 * version modules")
    version = (n - 17) // 4
    if version >= 7 and read_version(matrix) != version:
        raise Unreadable("version information names another version")
    level, mask = read_format(matrix)
    if level != 0:
        raise Unreadable("level bits say %d, not M" % level)
    ec, sizes = M_BLOCKS[version - 1]
    words = iter(read_codewords(matrix, version, mask))
    blocks = [[] for _ in sizes]
    for i in range(max(sizes)):
        for index, size in enumerate(sizes):
            if i < size:
                blocks[index].append(next(words))
    for i in range(ec):
        for block in blocks:
            block.append(next(words))
    data = []
    for index, block in enumerate(blocks):
        for power in range(ec):
            root, value = _EXP[power], 0
            for word in block:
                value = gf_mul(value, root) ^ word
            if value:
                raise Unreadable("block %d fails its Reed-Solomon check" % index)
        data.extend(block[:sizes[index]])
    stream = "".join("{:08b}".format(word) for word in data)
    if stream[:4] != "0100":
        raise Unreadable("mode is %s, not byte" % stream[:4])
    count_bits = 16 if version >= 10 else 8
    count = int(stream[4:4 + count_bits], 2)
    body = stream[4 + count_bits:4 + count_bits + 8 * count]
    return bytes(int(body[i:i + 8], 2) for i in range(0, len(body), 8)).decode("utf-8")


# --------------------------------------------------------------------------
# Reading the SVG back into modules
# --------------------------------------------------------------------------

SEGMENT_RE = re.compile(r"M(\d+) (\d+)h(\d+)v(\d+)h-(\d+)z")
SIZE_RE = re.compile(r'<svg [^>]*width="(\d+)" height="(\d+)"')


def read_svg(markup: str, module_px: int, quiet: int) -> list[list[bool]]:
    width, height = (int(v) for v in SIZE_RE.search(markup).groups())
    if width != height or width % module_px:
        raise Unreadable("the document is %dx%d, not a whole square of modules" % (width, height))
    n = width // module_px - 2 * quiet
    grid = [[False] * n for _ in range(n)]
    for x, y, w, h, back in (map(int, m) for m in SEGMENT_RE.findall(markup)):
        if w != back or h != module_px or x % module_px or y % module_px or w % module_px:
            raise Unreadable("a run at %d,%d is not whole modules" % (x, y))
        row, col = y // module_px - quiet, x // module_px - quiet
        for i in range(w // module_px):
            if not (0 <= row < n and 0 <= col + i < n):
                raise Unreadable("a module at %d,%d lies in the quiet zone" % (row, col + i))
            grid[row][col + i] = True
    return grid


# --------------------------------------------------------------------------
# The tables
# --------------------------------------------------------------------------


class TestTables(unittest.TestCase):
    def test_every_block_row_reaches_the_versions_codeword_count(self):
        for level, rows in qrcode_svg.BLOCKS.items():
            self.assertEqual(len(rows), 10, level)
            for version, (ec, g1, d1, g2, d2) in enumerate(rows, start=1):
                self.assertEqual(g1 * (d1 + ec) + g2 * (d2 + ec),
                                 qrcode_svg.TOTAL_CODEWORDS[version - 1],
                                 "level %s version %d" % (level, version))

    def test_a_second_group_holds_one_codeword_more_per_block(self):
        for level, rows in qrcode_svg.BLOCKS.items():
            for version, (_ec, _g1, d1, g2, d2) in enumerate(rows, start=1):
                if g2:
                    self.assertEqual(d2, d1 + 1, "level %s version %d" % (level, version))

    def test_the_level_m_capacities_are_the_standards(self):
        for version, expected in enumerate(M_CAPACITY, start=1):
            self.assertEqual(qrcode_svg.capacity(version, "M"), expected, version)

    def test_the_ceiling_constant_is_what_the_table_says(self):
        self.assertEqual(qrcode_svg.MAX_BYTES, 213)
        self.assertEqual(qrcode_svg.capacity(qrcode_svg.MAX_VERSION, "M"), qrcode_svg.MAX_BYTES)

    def test_the_alignment_centres_are_the_computed_ones(self):
        for version in range(1, 11):
            self.assertEqual(list(qrcode_svg.ALIGNMENT[version - 1]),
                             alignment_centres(version), version)


# --------------------------------------------------------------------------
# Version choice and refusals
# --------------------------------------------------------------------------


class TestVersionChoice(unittest.TestCase):
    def test_the_boundaries_at_level_m(self):
        for version, limit in enumerate(M_CAPACITY, start=1):
            self.assertEqual(qrcode_svg.version_for(payload(limit)), version, limit)
            if version < 10:
                self.assertEqual(qrcode_svg.version_for(payload(limit + 1)), version + 1, limit + 1)

    def test_the_command_codes_fit_version_two(self):
        for code in COMMAND_CODES:
            self.assertEqual(qrcode_svg.version_for(code), 2, code)

    def test_it_counts_utf8_bytes_not_characters(self):
        self.assertEqual(qrcode_svg.version_for("ä" * 7), 1)   # 14 bytes
        self.assertEqual(qrcode_svg.version_for("ä" * 8), 2)   # 16 bytes
        self.assertEqual(qrcode_svg.version_for("ä" * 13), 2)  # 26 bytes
        self.assertEqual(qrcode_svg.version_for("ä" * 14), 3)  # 28 bytes

    def test_a_text_beyond_version_ten_is_refused_and_says_so(self):
        with self.assertRaises(ValueError) as caught:
            qrcode_svg.version_for(payload(214))
        message = str(caught.exception)
        self.assertIn("214", message)
        self.assertIn("213", message)
        for size in (300, 1000):
            with self.assertRaises(ValueError, msg=str(size)):
                qrcode_svg.matrix(payload(size))

    def test_an_empty_string_is_refused(self):
        for fn in (qrcode_svg.version_for, qrcode_svg.matrix, qrcode_svg.svg):
            with self.assertRaises(ValueError, msg=fn.__name__):
                fn("")

    def test_something_that_is_not_a_string_is_refused(self):
        for value in (None, 42, b"SMPL"):
            with self.assertRaises(TypeError, msg=repr(value)):
                qrcode_svg.matrix(value)

    def test_an_unknown_level_is_refused(self):
        for level in ("X", "m", "", None):
            with self.assertRaises(ValueError, msg=repr(level)):
                qrcode_svg.matrix("SMPL-CMD-FERTIG", ec=level)

    def test_a_mask_outside_the_eight_is_refused(self):
        for mask in (-1, 8, "1"):
            with self.assertRaises(ValueError, msg=repr(mask)):
                qrcode_svg.matrix("SMPL-CMD-FERTIG", mask=mask)


# --------------------------------------------------------------------------
# Structure: what every symbol carries regardless of its data
# --------------------------------------------------------------------------


class TestStructure(unittest.TestCase):
    def test_the_matrix_is_17_plus_4_times_the_version_square(self):
        for version in range(1, 11):
            matrix = qrcode_svg.matrix(at_version(version))
            self.assertEqual(len(matrix), 17 + 4 * version, version)
            self.assertTrue(all(len(row) == len(matrix) for row in matrix), version)

    def test_finder_patterns_in_three_corners_with_light_separators(self):
        for version in (1, 2, 7, 10):
            matrix = qrcode_svg.matrix(at_version(version))
            n = len(matrix)
            for top, left in ((0, 0), (0, n - 7), (n - 7, 0)):
                for r in range(7):
                    got = "".join("1" if matrix[top + r][left + c] else "0" for c in range(7))
                    self.assertEqual(got, FINDER[r], "version %d finder at %d,%d row %d"
                                     % (version, top, left, r))
            for i in range(8):
                self.assertFalse(matrix[7][i] or matrix[i][7], "top-left separator")
                self.assertFalse(matrix[7][n - 1 - i] or matrix[i][n - 8], "top-right separator")
                self.assertFalse(matrix[n - 8][i] or matrix[n - 1 - i][7], "bottom-left separator")

    def test_timing_patterns_alternate_starting_dark(self):
        for version in (1, 3, 10):
            matrix = qrcode_svg.matrix(at_version(version))
            n = len(matrix)
            for i in range(8, n - 8):
                self.assertEqual(matrix[6][i], i % 2 == 0, "row 6 column %d" % i)
                self.assertEqual(matrix[i][6], i % 2 == 0, "column 6 row %d" % i)

    def test_the_dark_module(self):
        for version in range(1, 11):
            matrix = qrcode_svg.matrix(at_version(version))
            self.assertTrue(matrix[4 * version + 9][8], version)

    def test_the_alignment_pattern_of_version_two_sits_at_18_18(self):
        matrix = qrcode_svg.matrix("SMPL-CMD-FERTIG")
        for r in range(-2, 3):
            for c in range(-2, 3):
                expected = abs(r) == 2 or abs(c) == 2 or r == c == 0
                self.assertEqual(matrix[18 + r][18 + c], expected, "%d,%d" % (r, c))

    def test_the_format_information_names_level_m_and_the_chosen_mask(self):
        for code in COMMAND_CODES:
            level, mask = read_format(qrcode_svg.matrix(code))
            self.assertEqual(level, 0, code)
            self.assertEqual(mask, qrcode_svg.best_mask(code), code)
        for forced in range(8):
            _level, mask = read_format(qrcode_svg.matrix("KISTE-K3", mask=forced))
            self.assertEqual(mask, forced)

    def test_the_format_information_names_the_other_levels_too(self):
        for level, expected in (("L", 1), ("M", 0), ("Q", 3), ("H", 2)):
            got, _mask = read_format(qrcode_svg.matrix("KISTE-K3", ec=level))
            self.assertEqual(got, expected, level)

    def test_versions_seven_and_up_carry_their_version_information(self):
        for version in range(7, 11):
            self.assertEqual(read_version(qrcode_svg.matrix(at_version(version))), version)

    def test_versions_below_seven_leave_that_corner_to_data(self):
        # Nothing to read there; the reader must not be fooled into thinking
        # a data pattern is a version block.
        matrix = qrcode_svg.matrix(at_version(6))
        with self.assertRaises(Unreadable):
            read_version(matrix)

    def test_the_masks_differ_only_in_the_data_region(self):
        fixed = function_map(2)
        symbols = [qrcode_svg.matrix("SMPL-CMD-FERTIG", mask=k) for k in range(8)]
        self.assertEqual(len({bits(s) for s in symbols}), 8, "eight masks, eight symbols")
        n = len(symbols[0])
        for r in range(n):
            for c in range(n):
                if fixed[r][c] and not (r == 8 or c == 8):
                    self.assertEqual(len({s[r][c] for s in symbols}), 1, "%d,%d" % (r, c))


# --------------------------------------------------------------------------
# The round trip and the fixed vector
# --------------------------------------------------------------------------


class TestRoundTrip(unittest.TestCase):
    def assert_round_trip(self, text: str, mask=None) -> None:
        self.assertEqual(decode(qrcode_svg.matrix(text, mask=mask)), text)

    def test_the_command_the_screen_exists_for(self):
        self.assert_round_trip("SMPL-CMD-FERTIG")

    def test_every_command_in_the_vocabulary(self):
        for code in COMMAND_CODES:
            self.assert_round_trip(code)

    def test_the_four_commands_are_four_different_symbols(self):
        drawn = {code: bits(qrcode_svg.matrix(code)) for code in COMMAND_CODES}
        self.assertEqual(len(set(drawn.values())), len(COMMAND_CODES))

    def test_every_version_at_its_fullest(self):
        for version in range(1, 11):
            self.assert_round_trip(at_version(version))

    def test_every_version_one_byte_past_the_smaller_one(self):
        for version in range(2, 11):
            self.assert_round_trip(payload(M_CAPACITY[version - 2] + 1))

    def test_every_mask_decodes(self):
        for mask in range(8):
            self.assert_round_trip("SMPL-CMD-MITNEHMEN", mask=mask)

    def test_utf8_survives(self):
        for text in ("Größe", "Kiste K3 – 1,5 m", "ÄÖÜ äöü ß", "€"):
            self.assert_round_trip(text)

    def test_a_single_character(self):
        for char in ("A", "0", "-", " ", "~"):
            self.assert_round_trip(char)

    def test_the_reader_is_not_simply_agreeable(self):
        # Flip one data module: the Reed-Solomon check must refuse the block.
        matrix = qrcode_svg.matrix("SMPL-CMD-FERTIG")
        fixed = function_map(2)
        r, c = next((r, c) for r in range(len(matrix)) for c in range(len(matrix))
                    if not fixed[r][c])
        broken = [row[:] for row in matrix]
        broken[r][c] = not broken[r][c]
        with self.assertRaises(Unreadable):
            decode(broken)


class TestFixedVector(unittest.TestCase):
    def test_smpl_cmd_fertig_is_version_two_mask_one_and_these_modules(self):
        self.assertEqual(qrcode_svg.version_for("SMPL-CMD-FERTIG"), 2)
        self.assertEqual(qrcode_svg.best_mask("SMPL-CMD-FERTIG"), 1)
        matrix = qrcode_svg.matrix("SMPL-CMD-FERTIG")
        got = ["".join("1" if d else "0" for d in row) for row in matrix]
        self.assertEqual(got, list(FIXED_VECTOR))

    def test_the_vector_itself_decodes(self):
        # If the transcription above were wrong, the reader would say so and
        # the test above would be pinning a typo.
        matrix = [[char == "1" for char in row] for row in FIXED_VECTOR]
        self.assertEqual(decode(matrix), "SMPL-CMD-FERTIG")


# --------------------------------------------------------------------------
# The SVG document
# --------------------------------------------------------------------------


class TestSvgDocument(unittest.TestCase):
    def test_the_drawing_is_the_matrix(self):
        for code in COMMAND_CODES:
            for module_px, quiet in ((4, 4), (2, 4), (3, 6), (12, 4)):
                markup = qrcode_svg.svg(code, module_px=module_px, quiet_modules=quiet)
                self.assertEqual(read_svg(markup, module_px, quiet), qrcode_svg.matrix(code),
                                 "%s m=%d q=%d" % (code, module_px, quiet))

    def test_the_size_is_modules_plus_quiet_zone_times_pixels(self):
        for module_px, quiet in ((1, 4), (4, 4), (4, 8), (5, 4)):
            markup = qrcode_svg.svg("SMPL-CMD-FERTIG", module_px=module_px, quiet_modules=quiet)
            size = (25 + 2 * quiet) * module_px
            self.assertIn('width="%d" height="%d"' % (size, size), markup)
            self.assertIn('viewBox="0 0 %d %d"' % (size, size), markup)

    def test_a_command_at_the_default_is_132_pixels_square(self):
        # What the crate page lays out for: 25 modules plus four each side,
        # four pixels a module.
        markup = qrcode_svg.svg("SMPL-CMD-FERTIG")
        self.assertIn('width="132" height="132"', markup)

    def test_there_is_a_quiet_zone_all_round(self):
        module_px, quiet = 4, 4
        markup = qrcode_svg.svg("SMPL-CMD-ABBRUCH", module_px=module_px, quiet_modules=quiet)
        runs = [tuple(map(int, m)) for m in SEGMENT_RE.findall(markup)]
        size = (25 + 2 * quiet) * module_px
        self.assertEqual(min(x for x, *_ in runs), quiet * module_px, "left")
        self.assertEqual(min(y for _x, y, *_ in runs), quiet * module_px, "top")
        self.assertEqual(max(x + w for x, _y, w, *_ in runs), size - quiet * module_px, "right")
        self.assertEqual(max(y + h for _x, y, _w, h, _b in runs), size - quiet * module_px, "bottom")

    def test_a_too_small_quiet_zone_is_refused_rather_than_drawn(self):
        self.assertEqual(qrcode_svg.MIN_QUIET_MODULES, 4)
        for quiet in (0, 1, 3, -4):
            with self.assertRaises(ValueError, msg=str(quiet)):
                qrcode_svg.svg("SMPL-CMD-FERTIG", quiet_modules=quiet)

    def test_a_zero_or_negative_module_is_refused(self):
        for module_px in (0, -1):
            with self.assertRaises(ValueError, msg=str(module_px)):
                qrcode_svg.svg("SMPL-CMD-FERTIG", module_px=module_px)

    def test_the_ground_is_painted_white_and_the_modules_black_on_crisp_edges(self):
        # KISTE-K3 is eight bytes, a version-1 symbol: 21 modules and the
        # quiet zone, four pixels each, 116 px.
        markup = qrcode_svg.svg("KISTE-K3")
        self.assertIn('<rect x="0" y="0" width="116" height="116" fill="#ffffff"/>', markup)
        self.assertIn('<path fill="#000000" d="M', markup)
        self.assertIn('shape-rendering="crispEdges"', markup)
        self.assertNotIn(".", SEGMENT_RE.search(markup).group(0))

    def test_it_references_nothing_outside_itself(self):
        markup = qrcode_svg.svg("SMPL-CMD-FERTIG")
        self.assertEqual(markup.count('xmlns="http://www.w3.org/2000/svg"'), 1)
        rest = markup.replace('xmlns="http://www.w3.org/2000/svg"', "")
        for forbidden in ("http://", "https://", "//", "xlink:href", "<image",
                          "<script", "<use", "@import", "url(", "data:"):
            self.assertNotIn(forbidden, rest, forbidden)
        self.assertTrue(markup.startswith("<svg "))
        self.assertTrue(markup.endswith("</svg>"))

    def test_the_label_text_is_escaped(self):
        markup = qrcode_svg.svg('A<B&C"D>E')
        self.assertIn("aria-label=", markup)
        self.assertIn("&lt;", markup)
        self.assertIn("&amp;", markup)
        self.assertIn("&quot;", markup)
        self.assertNotIn("<B", markup)
        self.assertEqual(decode(read_svg(markup, 4, 4)), 'A<B&C"D>E')

    def test_a_refused_text_never_reaches_the_renderer(self):
        for text in ("", payload(214)):
            with self.assertRaises(ValueError, msg=repr(text)[:20]):
                qrcode_svg.svg(text)


# --------------------------------------------------------------------------
# Against the qrcode package, where it is installed
# --------------------------------------------------------------------------


@unittest.skipUnless(HAVE_QRCODE, "the qrcode package is not importable here")
class TestAgainstTheQrcodePackage(unittest.TestCase):
    """Bit for bit against qrcode 7.4.2, at every forced mask and the chosen one.

    The scorer copies the package's (format area left light while comparing,
    lowest mask on a tie), so the automatic choice is expected to agree
    outright. Should a later package change that, the forced-mask assertions
    still hold and the automatic one is the place to document the difference.
    """

    PAYLOADS = COMMAND_CODES + tuple(at_version(v) for v in range(1, 11)) + tuple(
        payload(M_CAPACITY[v - 2] + 1) for v in range(2, 11)
    ) + ("KISTE-K3", "Größe der Kiste: 1,5 m", "A")

    LEVELS = {"L": 1, "M": 0, "Q": 3, "H": 2}

    def reference(self, text: str, level: str = "M", mask=None):
        qr = qrcode.QRCode(error_correction=self.LEVELS[level], box_size=1, border=0,
                           mask_pattern=mask)
        qr.add_data(qrcode.util.QRData(text.encode("utf-8"), mode=qrcode.util.MODE_8BIT_BYTE))
        qr.make(fit=True)
        matrix = qr.get_matrix()  # before best_mask_pattern(), which clobbers modules
        chosen = qr.best_mask_pattern() if mask is None else mask
        return qr.version, chosen, matrix

    def test_the_version_matches(self):
        for text in self.PAYLOADS:
            version, _mask, _matrix = self.reference(text)
            self.assertEqual(qrcode_svg.version_for(text), version, text[:24])

    def test_every_forced_mask_matches(self):
        for text in self.PAYLOADS:
            for mask in range(8):
                _version, _mask, expected = self.reference(text, mask=mask)
                self.assertEqual(qrcode_svg.matrix(text, mask=mask), expected,
                                 "%s at mask %d" % (text[:24], mask))

    def test_the_automatically_chosen_mask_matches(self):
        for text in self.PAYLOADS:
            _version, mask, expected = self.reference(text)
            self.assertEqual(qrcode_svg.best_mask(text), mask, text[:24])
            self.assertEqual(qrcode_svg.matrix(text), expected, text[:24])

    def test_the_other_levels_match_at_every_mask(self):
        # 106 bytes is the longest of these; version 10 at level H holds 119.
        for level in ("L", "Q", "H"):
            for text in ("SMPL-CMD-FERTIG", at_version(4), at_version(6), "KISTE-K3"):
                for mask in range(8):
                    _v, _m, expected = self.reference(text, level, mask)
                    self.assertEqual(qrcode_svg.matrix(text, ec=level, mask=mask), expected,
                                     "%s level %s mask %d" % (text[:24], level, mask))
                _v, mask, expected = self.reference(text, level)
                self.assertEqual(qrcode_svg.matrix(text, ec=level), expected,
                                 "%s level %s automatic" % (text[:24], level))

    def test_the_block_table_matches_the_packages(self):
        for level, constant in self.LEVELS.items():
            for version in range(1, 11):
                theirs = [(b.total_count - b.data_count, b.data_count)
                          for b in qrcode.base.rs_blocks(version, constant)]
                ec, g1, d1, g2, d2 = qrcode_svg.BLOCKS[level][version - 1]
                self.assertEqual([(ec, d1)] * g1 + [(ec, d2)] * g2, theirs,
                                 "level %s version %d" % (level, version))


if __name__ == "__main__":
    unittest.main()
