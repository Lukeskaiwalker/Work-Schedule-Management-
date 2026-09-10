"""Code 128 proved by decoding, not by re-reading the table it was typed from.

A barcode module is unusually easy to test wrongly: assert that ``encode`` for
"X" equals the row you copied out of ``BAR_PATTERNS`` and you have tested
nothing except your own copy-paste, while the scanner on the wall reads the
wrong character. So this file never compares against the module's table.

Instead it does two independent things:

1. **A second transcription.** ``BINARY_PATTERNS`` below is the *other*
   canonical form of the same symbology - each symbol character as its eleven
   module bits, ``1`` for a black module and ``0`` for a white one. The test
   run-length-encodes those into widths and checks them against the module's
   width table. Two transcriptions of one table disagree wherever exactly one
   of them has a typo, which is the failure being hunted.
2. **A decoder.** ``decode_svg`` reads the rendered SVG the way a scanner
   reads glass: it measures the drawn bars and the gaps between them, converts
   the run back into module counts, chunks it into symbol characters, looks
   each one up, verifies the checksum, and returns the text. Every round-trip
   assertion below goes through it, so a wrong row, a wrong checksum, a
   dropped element or a mis-drawn rectangle all surface as "scanned back as
   something else".

On top of that the symbology's own structural rules are asserted for all 107
rows: eleven modules, elements 1..4 wide, and an even number of bar modules.
Those catch the class of typo that survives being made in both transcriptions.
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

import barcode128  # noqa: E402

# The command vocabulary the box screen shows, verbatim from scan_router. These
# six codes are the only input device that screen has.
COMMAND_CODES = (
    "SMPL-CMD-FERTIG",
    "SMPL-CMD-ABBRUCH",
    "SMPL-CMD-ENTNAHME",
    "SMPL-CMD-MENGE-5",
    "SMPL-CMD-MENGE-10",
    "SMPL-CMD-MENGE-50",
)

# --------------------------------------------------------------------------
# The independent transcription: 107 symbol characters as module bits
# --------------------------------------------------------------------------

BINARY_PATTERNS = (
    "11011001100", "11001101100", "11001100110", "10010011000", "10010001100",
    "10001001100", "10011001000", "10011000100", "10001100100", "11001001000",
    "11001000100", "11000100100", "10110011100", "10011011100", "10011001110",
    "10111001100", "10011101100", "10011100110", "11001110010", "11001011100",
    "11001001110", "11011100100", "11001110100", "11101101110", "11101001100",
    "11100101100", "11100100110", "11101100100", "11100110100", "11100110010",
    "11011011000", "11011000110", "11000110110", "10100011000", "10001011000",
    "10001000110", "10110001000", "10001101000", "10001100010", "11010001000",
    "11000101000", "11000100010", "10110111000", "10110001110", "10001101110",
    "10111011000", "10111000110", "10001110110", "11101110110", "11010001110",
    "11000101110", "11011101000", "11011100010", "11011101110", "11101011000",
    "11101000110", "11100010110", "11101101000", "11101100010", "11100011010",
    "11101111010", "11001000010", "11110001010", "10100110000", "10100001100",
    "10010110000", "10010000110", "10000101100", "10000100110", "10110010000",
    "10110000100", "10011010000", "10011000010", "10000110100", "10000110010",
    "11000010010", "11001010000", "11110111010", "11000010100", "10001111010",
    "10100111100", "10010111100", "10010011110", "10111100100", "10011110100",
    "10011110010", "11110100100", "11110010100", "11110010010", "11011011110",
    "11011110110", "11110110110", "10101111000", "10100011110", "10001011110",
    "10111101000", "10111100010", "11110101000", "11110100010", "10111011110",
    "10111101110", "11101011110", "11110101110", "11010000100", "11010010000",
    "11010011100", "1100011101011",
)


def widths_from_bits(bits: str) -> tuple[int, ...]:
    """Run-length encode module bits into element widths, bars first."""
    run = []
    for bit in bits:
        if run and run[-1][0] == bit:
            run[-1][1] += 1
        else:
            run.append([bit, 1])
    assert run[0][0] == "1", "every Code 128 pattern starts on a bar"
    return tuple(count for _bit, count in run)


# The decoder's own lookup, derived from the bits and from nothing else.
WIDTHS_TO_VALUE = {widths_from_bits(bits): value
                   for value, bits in enumerate(BINARY_PATTERNS)}


# --------------------------------------------------------------------------
# The decoder: rendered SVG back to text, the way a scanner sees it
# --------------------------------------------------------------------------

RECT_RE = re.compile(
    r'<rect x="(\d+)" y="0" width="(\d+)" height="(\d+)" fill="(#[0-9a-f]{6})"/>')


class Unreadable(Exception):
    """What a scanner would express as a beep that never comes."""


def read_bars(markup: str):
    """Every black rectangle in the document, left to right."""
    bars = [(int(x), int(w), int(h)) for x, w, h, fill in RECT_RE.findall(markup)
            if fill == "#000000"]
    return sorted(bars)


def measure_run(markup: str, module_px: int) -> list[int]:
    """Measure bars and the gaps between them into an alternating width run."""
    bars = read_bars(markup)
    if not bars:
        raise Unreadable("no bars drawn")
    run = []
    for index, (x, width, _height) in enumerate(bars):
        run.append(width)
        if index + 1 < len(bars):
            gap = bars[index + 1][0] - (x + width)
            if gap <= 0:
                raise Unreadable("bars %d and %d touch or overlap" % (index, index + 1))
            run.append(gap)
    modules = []
    for measured in run:
        if measured % module_px:
            raise Unreadable("element of %dpx is not a whole number of modules" % measured)
        modules.append(measured // module_px)
    return modules


def chunk_run(modules: list[int]) -> list[tuple[int, ...]]:
    """Split the run into symbol characters: sixes, then the seven-wide stop."""
    if len(modules) < 7 or (len(modules) - 7) % 6:
        raise Unreadable("run of %d elements is not sixes plus a stop" % len(modules))
    chunks = []
    cursor = 0
    while len(modules) - cursor > 7:
        chunks.append(tuple(modules[cursor:cursor + 6]))
        cursor += 6
    chunks.append(tuple(modules[cursor:]))
    return chunks


def decode_values(markup: str, module_px: int = 3) -> list[int]:
    """Every code value in the symbol, start and checksum and stop included."""
    values = []
    for chunk in chunk_run(measure_run(markup, module_px)):
        value = WIDTHS_TO_VALUE.get(chunk)
        if value is None:
            raise Unreadable("no symbol character has widths %s" % (chunk,))
        values.append(value)
    return values


def decode_svg(markup: str, module_px: int = 3) -> str:
    """Read the symbol back as text, refusing it if the checksum disagrees."""
    values = decode_values(markup, module_px)
    if len(values) < 3:
        raise Unreadable("symbol is too short to carry a checksum")
    start, *body, checksum, stop = values
    if start != 104:
        raise Unreadable("start character is %d, not start B" % start)
    if stop != 106:
        raise Unreadable("last character is %d, not the stop" % stop)
    expected = start
    for position, value in enumerate(body, start=1):
        expected += position * value
    expected %= 103
    if expected != checksum:
        raise Unreadable("checksum is %d, the data says %d" % (checksum, expected))
    return "".join(chr(value + 32) for value in body)


# --------------------------------------------------------------------------
# The table itself
# --------------------------------------------------------------------------


class TestPatternTable(unittest.TestCase):
    def test_there_are_107_symbol_characters(self):
        self.assertEqual(len(barcode128.BAR_PATTERNS), 107)
        self.assertEqual(len(BINARY_PATTERNS), 107)

    def test_the_two_transcriptions_agree(self):
        # The whole point of this file: widths typed one way, bits typed
        # another, and a typo in either shows up here rather than on a wall.
        for value, bits in enumerate(BINARY_PATTERNS):
            self.assertEqual(barcode128.BAR_PATTERNS[value], widths_from_bits(bits),
                             "symbol character %d disagrees" % value)

    def test_every_pattern_is_eleven_modules_except_the_stop(self):
        for value, pattern in enumerate(barcode128.BAR_PATTERNS):
            if value == barcode128.STOP:
                self.assertEqual(len(pattern), 7, "the stop carries a seventh element")
                self.assertEqual(sum(pattern), 13)
            else:
                self.assertEqual(len(pattern), 6, "character %d" % value)
                self.assertEqual(sum(pattern), 11, "character %d" % value)

    def test_no_element_is_wider_than_four_modules(self):
        for value, pattern in enumerate(barcode128.BAR_PATTERNS):
            for width in pattern:
                self.assertTrue(1 <= width <= 4, "character %d has a %d-wide element"
                                % (value, width))

    def test_every_pattern_has_an_even_number_of_bar_modules(self):
        # Code 128's own parity rule. It catches transpositions that keep the
        # eleven-module total intact, which is exactly the typo that would
        # otherwise sail through every other check here.
        for value, pattern in enumerate(barcode128.BAR_PATTERNS):
            bars = sum(pattern[0::2])
            self.assertEqual(bars % 2, 0, "character %d has %d bar modules" % (value, bars))

    def test_no_two_patterns_are_the_same(self):
        self.assertEqual(len(set(barcode128.BAR_PATTERNS)), 107)


# --------------------------------------------------------------------------
# encode()
# --------------------------------------------------------------------------


class TestEncode(unittest.TestCase):
    def test_it_starts_with_start_b_and_ends_with_the_stop(self):
        values = barcode128.encode("SMPL-CMD-FERTIG")
        self.assertEqual(values[0], 104)
        self.assertEqual(values[-1], 106)
        self.assertEqual(barcode128.START_B, 104)
        self.assertEqual(barcode128.STOP, 106)

    def test_values_are_the_code_point_less_32(self):
        values = barcode128.encode("A0 ~")
        self.assertEqual(values[1:-2], [33, 16, 0, 94])

    def test_the_checksum_of_a_short_input_by_hand(self):
        # "A" is value 33. Start B is 104, the first data character weighs 1:
        #   (104 + 1 * 33) % 103 = 137 % 103 = 34
        self.assertEqual(barcode128.encode("A"), [104, 33, 34, 106])

    def test_the_checksum_weights_by_position_not_by_count(self):
        # "AB" is values 33 and 34, weighing 1 and 2:
        #   (104 + 1 * 33 + 2 * 34) % 103 = 205 % 103 = 102
        self.assertEqual(barcode128.encode("AB"), [104, 33, 34, 102, 106])
        # Swapping the two characters must move the checksum; a sum that
        # ignored position would not notice.
        self.assertNotEqual(barcode128.encode("AB"), barcode128.encode("BA"))

    def test_the_symbol_is_start_plus_data_plus_checksum_plus_stop(self):
        for text in ("X", "SMPL-CMD-FERTIG", "K" * 48):
            self.assertEqual(len(barcode128.encode(text)), len(text) + 3, text)

    def test_it_refuses_characters_outside_printable_ascii(self):
        for text in ("SMPL\tCMD", "Kiste\n", "Größe", "ÄÖÜ", "café", "\x00", "\x7f"):
            with self.assertRaises(ValueError, msg=text):
                barcode128.encode(text)

    def test_the_refusal_names_the_offending_character(self):
        with self.assertRaises(ValueError) as caught:
            barcode128.encode("KISTE-Ä")
        message = str(caught.exception)
        self.assertIn("6", message)
        self.assertIn("196", message)

    def test_it_refuses_an_empty_string(self):
        with self.assertRaises(ValueError):
            barcode128.encode("")

    def test_it_refuses_something_that_is_not_a_string(self):
        for value in (None, 42, b"SMPL"):
            with self.assertRaises(TypeError):
                barcode128.encode(value)

    def test_the_boundaries_of_code_set_b_are_included(self):
        # Space (32) and tilde (126) are the ends of the range, and an
        # off-by-one at either end is a code the workshop cannot print.
        for text in (" ", "~", " ~ "):
            self.assertEqual(decode_svg(barcode128.svg(text)), text)


# --------------------------------------------------------------------------
# The round trip
# --------------------------------------------------------------------------


class TestRoundTrip(unittest.TestCase):
    def assert_round_trip(self, text: str, module_px: int = 3) -> None:
        markup = barcode128.svg(text, module_px=module_px)
        self.assertEqual(decode_svg(markup, module_px), text)

    def test_the_command_the_screen_exists_for(self):
        self.assert_round_trip("SMPL-CMD-FERTIG")

    def test_every_command_in_the_vocabulary(self):
        for code in COMMAND_CODES:
            self.assert_round_trip(code)

    def test_the_six_commands_are_six_different_symbols(self):
        drawn = {code: barcode128.svg(code) for code in COMMAND_CODES}
        self.assertEqual(len(set(drawn.values())), len(COMMAND_CODES))

    def test_a_crate_id(self):
        self.assert_round_trip("KISTE-K3")

    def test_a_single_character(self):
        for char in ("A", "0", "-", " ", "~"):
            self.assert_round_trip(char)

    def test_the_whole_printable_ascii_range_in_chunks(self):
        printable = "".join(chr(point) for point in range(32, 127))
        self.assertEqual(len(printable), 95)
        for start in range(0, len(printable), 32):
            self.assert_round_trip(printable[start:start + 32])

    def test_a_48_character_string(self):
        # 48 is the route's ceiling; the encoder has to reach it.
        text = ("SMPL-CMD-" + string.ascii_uppercase + string.digits + "-abc")[:48]
        self.assertEqual(len(text), 48)
        self.assert_round_trip(text)

    def test_it_survives_a_different_module_size(self):
        for module_px in (1, 2, 5, 8):
            self.assert_round_trip("SMPL-CMD-ABBRUCH", module_px=module_px)

    def test_the_decoder_is_not_simply_agreeable(self):
        # If the decoder said yes to anything, every assertion above would be
        # worthless. Widen one bar by a module and it must refuse.
        markup = barcode128.svg("SMPL-CMD-FERTIG")
        broken = markup.replace('width="9"', 'width="12"', 1)
        self.assertNotEqual(broken, markup)
        with self.assertRaises(Unreadable):
            decode_svg(broken)

    def test_a_tampered_checksum_is_refused(self):
        # Re-render the same text with a deliberately wrong final data value
        # and confirm the decoder's checksum test is the thing that catches it.
        values = barcode128.encode("KISTE-K3")
        values[-2] = (values[-2] + 1) % 103
        run = barcode128.elements(values)
        markup = self._draw(run)
        with self.assertRaises(Unreadable):
            decode_svg(markup)

    @staticmethod
    def _draw(run, module_px: int = 3, quiet: int = 10, height: int = 120) -> str:
        width = (2 * quiet + sum(run)) * module_px
        parts = ['<rect x="0" y="0" width="%d" height="%d" fill="#ffffff"/>' % (width, height)]
        cursor = quiet
        for index, modules in enumerate(run):
            if index % 2 == 0:
                parts.append('<rect x="%d" y="0" width="%d" height="%d" fill="#000000"/>'
                             % (cursor * module_px, modules * module_px, height))
            cursor += modules
        return "<svg>%s</svg>" % "".join(parts)


# --------------------------------------------------------------------------
# The SVG document
# --------------------------------------------------------------------------


class TestSvgDocument(unittest.TestCase):
    def test_the_width_is_the_module_count_times_the_module_size(self):
        for module_px in (1, 3, 4):
            for quiet in (10, 16):
                markup = barcode128.svg("SMPL-CMD-FERTIG", module_px=module_px,
                                        quiet_modules=quiet)
                modules = barcode128.module_width("SMPL-CMD-FERTIG") + 2 * quiet
                self.assertIn('width="%d"' % (modules * module_px), markup)
                self.assertIn('viewBox="0 0 %d ' % (modules * module_px), markup)

    def test_there_is_a_quiet_zone_on_both_sides(self):
        module_px, quiet = 3, 10
        markup = barcode128.svg("SMPL-CMD-FERTIG", module_px=module_px, quiet_modules=quiet)
        bars = read_bars(markup)
        background = RECT_RE.findall(markup)[0]
        total = int(background[1])
        self.assertEqual(background[3], "#ffffff")
        self.assertEqual(bars[0][0], quiet * module_px, "no quiet zone on the left")
        last_x, last_width, _height = bars[-1]
        self.assertEqual(total - (last_x + last_width), quiet * module_px,
                         "no quiet zone on the right")

    def test_the_quiet_zone_is_at_least_ten_modules_by_default(self):
        self.assertGreaterEqual(barcode128.MIN_QUIET_MODULES, 10)
        markup = barcode128.svg("SMPL-CMD-FERTIG")
        self.assertEqual(read_bars(markup)[0][0], barcode128.MIN_QUIET_MODULES * 3)

    def test_a_too_small_quiet_zone_is_refused_rather_than_drawn(self):
        for quiet in (0, 1, 9, -4):
            with self.assertRaises(ValueError, msg=str(quiet)):
                barcode128.svg("SMPL-CMD-FERTIG", quiet_modules=quiet)

    def test_the_ground_is_painted_white_and_the_bars_black(self):
        markup = barcode128.svg("KISTE-K3")
        rects = RECT_RE.findall(markup)
        self.assertEqual(rects[0][3], "#ffffff")
        self.assertTrue(all(rect[3] == "#000000" for rect in rects[1:]))

    def test_the_height_is_the_height_that_was_asked_for(self):
        for height in (40, 120, 140, 400):
            markup = barcode128.svg("KISTE-K3", height_px=height)
            self.assertIn('height="%d"' % height, markup)
            self.assertTrue(all(int(rect[2]) == height for rect in RECT_RE.findall(markup)))

    def test_bars_land_on_whole_pixels(self):
        # crispEdges only helps if the geometry is integral to begin with.
        markup = barcode128.svg("SMPL-CMD-MENGE-50", module_px=3)
        self.assertIn('shape-rendering="crispEdges"', markup)
        self.assertNotIn(".", RECT_RE.findall(markup)[0][0])

    def test_it_references_nothing_outside_itself(self):
        # A kiosk browser with no route off the Pi has to be able to draw
        # this. The one URL allowed in the document is the SVG namespace,
        # which is an identifier and not something a browser fetches, so it
        # is removed before the rest of the document is searched for links.
        markup = barcode128.svg("SMPL-CMD-FERTIG")
        self.assertEqual(markup.count('xmlns="http://www.w3.org/2000/svg"'), 1)
        rest = markup.replace('xmlns="http://www.w3.org/2000/svg"', "")
        for forbidden in ("http://", "https://", "//", "xlink:href", "<image",
                          "<script", "<use", "@import", "url(", "data:"):
            self.assertNotIn(forbidden, rest, forbidden)
        self.assertTrue(markup.startswith("<svg "))
        self.assertTrue(markup.endswith("</svg>"))

    def test_the_label_text_is_escaped(self):
        markup = barcode128.svg('A<B&C"D>E')
        self.assertIn("aria-label=", markup)
        self.assertIn("&lt;", markup)
        self.assertIn("&amp;", markup)
        self.assertIn("&quot;", markup)
        self.assertNotIn("<B", markup)
        # And it still scans as what was asked for.
        self.assertEqual(decode_svg(markup), 'A<B&C"D>E')

    def test_a_zero_or_negative_size_is_refused(self):
        for kwargs in ({"height_px": 0}, {"height_px": -5}, {"module_px": 0},
                       {"module_px": -1}):
            with self.assertRaises(ValueError, msg=str(kwargs)):
                barcode128.svg("SMPL-CMD-FERTIG", **kwargs)

    def test_a_refused_text_never_reaches_the_renderer(self):
        for text in ("", "Größe"):
            with self.assertRaises(ValueError, msg=repr(text)):
                barcode128.svg(text)


if __name__ == "__main__":
    unittest.main()
