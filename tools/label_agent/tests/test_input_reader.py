"""Reading the USB barcode scanner straight off /dev/input, with no evdev.

There is no python3-evdev on the Pi and the virtualenv has no system site
packages, so the reader decodes ``struct input_event`` by hand. That is a
small amount of code with a large blast radius — get the struct size wrong on
one architecture and every scan is silently garbage — so it is tested against
packed bytes rather than against a device.

A regular file decodes identically to a character device: same struct, same
order, EOF instead of a blocking read. Every test here therefore feeds a temp
file, which is why they run on a Mac with no scanner attached.

Verified on the Pi (aarch64, Linux 6.12): ``struct.calcsize("llHHi")`` is 24,
and the scanner is 1a86:5456 at /dev/input/event4 behind the by-id symlink
``usb-NT_USB_Keyboard-event-kbd``.

The keycode tables are German, and ``TestTheScannerSpeaksGerman`` below is the
reason: two scans captured off that device on 2026-09-10 decode to the labels
they were read from only under a German table. Do not "fix" evdev 53 back to a
slash — that is the bug, and it is measured, not argued.
"""

from __future__ import annotations

import json
import os
import struct
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import input_reader  # noqa: E402


K = input_reader.KEYS


def ev(code: int, value: int, sec: int = 0, usec: int = 0) -> bytes:
    return input_reader.pack_event(sec, usec, input_reader.EV_KEY, code, value)


def syn(sec: int = 0, usec: int = 0) -> bytes:
    return input_reader.pack_event(sec, usec, input_reader.EV_SYN, 0, 0)


def tap(code: int, sec: int = 0, usec: int = 0) -> bytes:
    """A key down + up + report, the way a HID keyboard actually writes it."""
    return ev(code, 1, sec, usec) + syn(sec, usec) + ev(code, 0, sec, usec) + syn(sec, usec)


def shifted(code: int, sec: int = 0) -> bytes:
    return (ev(input_reader.KEY_LEFTSHIFT, 1, sec) + tap(code, sec)
            + ev(input_reader.KEY_LEFTSHIFT, 0, sec))


def type_text(text: str, *, sec: int = 0, suffix: int | None = None,
              layout: str = input_reader.SCANNER_LAYOUT) -> bytes:
    """Encode a barcode the way the scanner types it: shift for capitals."""
    out = b""
    for char in text:
        code, needs_shift = input_reader.keycode_for(char, layout)
        out += shifted(code, sec) if needs_shift else tap(code, sec)
    if suffix is not None:
        out += tap(suffix, sec)
    return out


def _keystrokes(char: str, layout: str):
    """The (code, value) events one character costs, shift included."""
    code, needs_shift = input_reader.keycode_for(char, layout)
    if needs_shift:
        return [(input_reader.KEY_LEFTSHIFT, 1), (code, 1), (input_reader.KEY_LEFTSHIFT, 0)]
    return [(code, 1)]


def write_events(root: Path, name: str, blob: bytes) -> Path:
    path = root / name
    path.write_bytes(blob)
    return path


class FileFedCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.scans: list[str] = []

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def reader(self, path: Path, **kwargs) -> input_reader.ScannerReader:
        return input_reader.ScannerReader(
            self.scans.append, device_path=str(path), grab=False,
            retry_s=0.01, **kwargs
        )


# --------------------------------------------------------------------------
# The struct
# --------------------------------------------------------------------------


class TestEventStruct(unittest.TestCase):
    def test_the_event_size_is_derived_not_hardcoded(self):
        self.assertEqual(input_reader.EVENT_SIZE, struct.calcsize("llHHi"))
        self.assertIn(input_reader.EVENT_SIZE, (16, 24))  # 32-bit and 64-bit

    def test_the_size_matches_the_pi(self):
        # aarch64: two 8-byte longs, two shorts, one int, padded to 24.
        if struct.calcsize("l") == 8:
            self.assertEqual(input_reader.EVENT_SIZE, 24)

    def test_pack_and_unpack_round_trip(self):
        blob = input_reader.pack_event(12, 345, 1, 30, 1)
        self.assertEqual(len(blob), input_reader.EVENT_SIZE)
        self.assertEqual(struct.unpack("llHHi", blob), (12, 345, 1, 30, 1))

    def test_the_grab_ioctl_is_the_documented_constant(self):
        # _IOW('E', 0x90, int) - wrong by one bit and the grab silently fails.
        self.assertEqual(input_reader.EVIOCGRAB, 0x40044590)


# --------------------------------------------------------------------------
# Decoding
# --------------------------------------------------------------------------


class TestDecoding(FileFedCase):
    def test_a_command_code_comes_out_whole(self):
        path = write_events(self.root, "cmd",
                            type_text("SMPL-CMD-FERTIG", suffix=input_reader.KEY_ENTER))
        self.reader(path).run_once()
        self.assertEqual(self.scans, ["SMPL-CMD-FERTIG"])

    def test_an_ean_comes_out_whole(self):
        path = write_events(self.root, "ean",
                            type_text("4011923456789", suffix=input_reader.KEY_ENTER))
        self.reader(path).run_once()
        self.assertEqual(self.scans, ["4011923456789"])

    def test_two_scans_in_one_stream(self):
        blob = (type_text("KISTE-K3", suffix=input_reader.KEY_ENTER)
                + type_text("SMPL-A1B2C3", suffix=input_reader.KEY_ENTER))
        self.reader(write_events(self.root, "two", blob)).run_once()
        self.assertEqual(self.scans, ["KISTE-K3", "SMPL-A1B2C3"])

    def test_an_internal_code_survives_the_round_trip(self):
        # The alphabet the server mints from, end to end.
        import scan_router

        code = "SMPL-" + scan_router.CODE_ALPHABET[:6]
        self.reader(write_events(
            self.root, "internal", type_text(code, suffix=input_reader.KEY_ENTER)
        )).run_once()
        self.assertEqual(self.scans, [code])

    def test_tab_and_keypad_enter_also_commit(self):
        for suffix in (input_reader.KEY_TAB, input_reader.KEY_KPENTER):
            self.scans.clear()
            path = write_events(self.root, "suffix-%d" % suffix,
                                type_text("SMPL-A1B2C3", suffix=suffix))
            self.reader(path).run_once()
            self.assertEqual(self.scans, ["SMPL-A1B2C3"])

    def test_a_scan_with_no_terminator_is_not_delivered(self):
        # Half a barcode is worse than none: it would count the wrong article.
        path = write_events(self.root, "partial", type_text("40119234"))
        self.reader(path).run_once()
        self.assertEqual(self.scans, [])

    def test_key_release_and_autorepeat_are_ignored(self):
        blob = (ev(input_reader.KEY_5, 1) + ev(input_reader.KEY_5, 0)
                + ev(input_reader.KEY_5, 2) + ev(input_reader.KEY_5, 2)
                + tap(input_reader.KEY_ENTER))
        self.reader(write_events(self.root, "repeat", blob)).run_once()
        self.assertEqual(self.scans, ["5"])

    def test_non_key_events_are_ignored(self):
        blob = (input_reader.pack_event(0, 0, 4, 4, 458792)  # EV_MSC scancode
                + tap(input_reader.KEY_7) + syn() + tap(input_reader.KEY_ENTER))
        self.reader(write_events(self.root, "msc", blob)).run_once()
        self.assertEqual(self.scans, ["7"])

    def test_an_unmapped_key_is_dropped_not_guessed(self):
        blob = (tap(input_reader.KEY_7) + tap(input_reader.KEY_F1)
                + tap(input_reader.KEY_8) + tap(input_reader.KEY_ENTER))
        self.reader(write_events(self.root, "f1", blob)).run_once()
        self.assertEqual(self.scans, ["78"])

    def test_an_empty_terminator_delivers_nothing(self):
        blob = tap(input_reader.KEY_ENTER) + tap(input_reader.KEY_ENTER)
        self.reader(write_events(self.root, "bare", blob)).run_once()
        self.assertEqual(self.scans, [])

    def test_a_truncated_final_event_does_not_raise(self):
        blob = type_text("77", suffix=input_reader.KEY_ENTER) + b"\x01\x02\x03"
        self.reader(write_events(self.root, "trunc", blob)).run_once()
        self.assertEqual(self.scans, ["77"])


# --------------------------------------------------------------------------
# The keymap
# --------------------------------------------------------------------------


class TestKeymap(unittest.TestCase):
    def test_the_whole_barcode_alphabet_is_mappable_on_every_layout(self):
        import scan_router

        alphabet = scan_router.CODE_ALPHABET + "-./ " + "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        for layout in input_reader.LAYOUTS:
            for char in alphabet:
                code, _ = input_reader.keycode_for(char, layout)
                self.assertIsNotNone(code, "no %s keycode for %r" % (layout, char))

    def test_every_character_survives_being_typed_and_read_back(self):
        # Both directions of both tables: what keycode_for emits is what the
        # decoder reads. A table with one entry pointing at the wrong key
        # passes the mappability test above and fails this one.
        import scan_router

        alphabet = scan_router.CODE_ALPHABET + "-./ " + "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        for layout in input_reader.LAYOUTS:
            for char in alphabet:
                decoder = input_reader.ScanDecoder(clock=lambda: 0.0, layout=layout)
                for code, value in _keystrokes(char, layout):
                    decoder.feed(code, value, 0.0)
                self.assertEqual(decoder.feed(input_reader.KEY_ENTER, 1, 0.0), char,
                                 "%s round trip for %r" % (layout, char))

    def test_letters_arrive_uppercase_with_or_without_shift(self):
        # Some wedges drop the shift entirely. Our alphabet is uppercase-only,
        # so accepting both spellings costs nothing and saves a support call.
        decoder = input_reader.ScanDecoder(clock=lambda: 0.0)
        self.assertIsNone(decoder.feed(input_reader.KEY_A, 1, 0.0))
        self.assertEqual(decoder.feed(input_reader.KEY_ENTER, 1, 0.0), "A")

    def test_shift_plus_the_hyphen_key_is_an_underscore_on_both_layouts(self):
        # The underscore sits above the hyphen — which is a different physical
        # key per layout: <AB10> (53) on German, <AE11> (12) on US.
        for layout, hyphen in (("de", 53), ("us", input_reader.KEY_MINUS)):
            decoder = input_reader.ScanDecoder(clock=lambda: 0.0, layout=layout)
            decoder.feed(input_reader.KEY_LEFTSHIFT, 1, 0.0)
            decoder.feed(hyphen, 1, 0.0)
            decoder.feed(input_reader.KEY_LEFTSHIFT, 0, 0.0)
            decoder.feed(hyphen, 1, 0.0)
            self.assertEqual(decoder.feed(input_reader.KEY_ENTER, 1, 0.0), "_-", layout)

    def test_the_keypad_digits_decode_to_digits(self):
        decoder = input_reader.ScanDecoder(clock=lambda: 0.0)
        for code in (input_reader.KEY_KP4, input_reader.KEY_KP0, input_reader.KEY_KP7):
            decoder.feed(code, 1, 0.0)
        self.assertEqual(decoder.feed(input_reader.KEY_KPENTER, 1, 0.0), "407")

    def test_digits_are_not_shifted_into_punctuation(self):
        # A scanner that holds shift over a digit still means the digit.
        decoder = input_reader.ScanDecoder(clock=lambda: 0.0)
        decoder.feed(input_reader.KEY_LEFTSHIFT, 1, 0.0)
        decoder.feed(input_reader.KEY_4, 1, 0.0)
        decoder.feed(input_reader.KEY_LEFTSHIFT, 0, 0.0)
        self.assertEqual(decoder.feed(input_reader.KEY_ENTER, 1, 0.0), "4")


# --------------------------------------------------------------------------
# The scanner speaks German (measured, 2026-09-10)
# --------------------------------------------------------------------------


#: Captured read-only off /dev/input/event4 on the office Pi from USB
#: 1a86:5456 "NT USB Keyboard": the keycodes the kernel reported for two real
#: scans, and the text printed on the two labels that were scanned. The first
#: is a machine DataMatrix, the second an SMPL code label.
CAPTURED_SCANS = (
    ([50, 53, 11, 11, 7, 3], "M-0062", "M/0062"),
    ([31, 50, 25, 38, 53, 19, 25, 36, 49, 8, 35], "SMPL-RPJN7H", "SMPL/RPJN7H"),
)


def decode(keycodes, layout):
    decoder = input_reader.ScanDecoder(clock=lambda: 0.0, layout=layout)
    for code in keycodes:
        decoder.feed(code, 1, 0.0)
    return decoder.feed(input_reader.KEY_ENTER, 1, 0.0)


class TestTheScannerSpeaksGerman(unittest.TestCase):
    """Two captured scans, and the table that reads them as their own labels.

    This is the only test in this file written from a measurement rather than
    from a document. The keycodes are what the kernel reported; the strings are
    what is printed on the two labels. Any table that disagrees with this is
    wrong about the hardware, however well it matches somebody's keyboard.
    """

    def test_the_captured_scans_decode_to_the_labels_they_were_read_from(self):
        for keycodes, printed, _us in CAPTURED_SCANS:
            self.assertEqual(decode(keycodes, "de"), printed)

    def test_a_us_table_turns_every_hyphen_into_a_slash(self):
        # The bug this replaces, kept as a test so nobody "corrects" evdev 53
        # back to a slash: under a US table both labels come out unfindable.
        for keycodes, printed, mangled in CAPTURED_SCANS:
            self.assertEqual(decode(keycodes, "us"), mangled)
            self.assertNotEqual(mangled, printed)

    def test_the_three_keys_that_differ_are_the_documented_three(self):
        # de vs us in /usr/share/X11/xkb/symbols: <AB10> is minus not slash,
        # <AD06> is z not y, <AB01> is y not z. Everything our codes can
        # contain is identical on both.
        de, us = input_reader.keys_for("de"), input_reader.keys_for("us")
        differ = {code for code in set(de) | set(us) if de.get(code) != us.get(code)}
        self.assertEqual(differ, {12, 21, 27, 44, 53})
        self.assertEqual((de[53], us[53]), ("-", "/"))
        self.assertEqual((de[21], us[21]), ("Z", "Y"))
        self.assertEqual((de[44], us[44]), ("Y", "Z"))
        # 12 is "ß" on a German keyboard and 27 is "+", so neither is a
        # hyphen: the German hyphen is 53 and nothing else.
        self.assertNotIn(12, de)
        self.assertNotIn(27, us)

    def test_both_letters_of_the_code_alphabet_are_reachable(self):
        # Y and Z are both in CODE_ALPHABET, which is why the swap is
        # expensive: 14 of 55 coded articles carry one.
        import scan_router

        self.assertIn("Y", scan_router.CODE_ALPHABET)
        self.assertIn("Z", scan_router.CODE_ALPHABET)
        self.assertEqual(decode([21, 44], "de"), "ZY")
        self.assertEqual(decode([21, 44], "us"), "YZ")


class TestTheLayoutIsASetting(unittest.TestCase):
    def test_german_is_the_default(self):
        self.assertEqual(input_reader.SCANNER_LAYOUT, "de")
        self.assertIs(input_reader.KEYS, input_reader.LAYOUTS["de"])
        self.assertEqual(sorted(input_reader.LAYOUTS), ["de", "us"])

    def test_a_reader_decodes_through_the_layout_it_was_given(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        for layout, expected in (("de", "M-0062"), ("us", "M/0062")):
            scans: list[str] = []
            blob = b"".join(ev(code, 1) + ev(code, 0) for code in CAPTURED_SCANS[0][0])
            blob += tap(input_reader.KEY_ENTER)
            path = write_events(root, "capture-%s" % layout, blob)
            input_reader.ScannerReader(scans.append, device_path=str(path), grab=False,
                                       retry_s=0.01, layout=layout).run_once()
            self.assertEqual(scans, [expected], layout)

    def test_the_layout_in_use_is_reported_for_health(self):
        reader = input_reader.ScannerReader(lambda code: None, layout="us")
        self.assertEqual(reader.status()["layout"], "us")

    def test_a_typo_is_the_default_rather_than_a_dead_scanner(self):
        # A misspelled setting must never be the reason a workshop has no
        # scanner at all, so it normalises instead of raising.
        self.assertEqual(input_reader.resolve_layout("DE"), "de")
        self.assertEqual(input_reader.resolve_layout(" us "), "us")
        for junk in ("", None, "gb", "qwertz", "de-DE"):
            self.assertEqual(input_reader.resolve_layout(junk), "de")
        self.assertEqual(
            input_reader.ScanDecoder(clock=lambda: 0.0, layout="klingon").layout, "de")


# --------------------------------------------------------------------------
# The inter-key gap
# --------------------------------------------------------------------------


class TestInterKeyGap(unittest.TestCase):
    def test_a_long_pause_resets_the_buffer(self):
        clock = [0.0]
        decoder = input_reader.ScanDecoder(clock=lambda: clock[0], gap_s=1.5)
        decoder.feed(input_reader.KEY_4, 1, clock[0])
        clock[0] = 2.0
        decoder.feed(input_reader.KEY_7, 1, clock[0])
        self.assertEqual(decoder.feed(input_reader.KEY_ENTER, 1, clock[0]), "7")

    def test_a_short_pause_does_not(self):
        clock = [0.0]
        decoder = input_reader.ScanDecoder(clock=lambda: clock[0], gap_s=1.5)
        decoder.feed(input_reader.KEY_4, 1, clock[0])
        clock[0] = 0.4
        decoder.feed(input_reader.KEY_7, 1, clock[0])
        self.assertEqual(decoder.feed(input_reader.KEY_ENTER, 1, clock[0]), "47")

    def test_the_buffer_cannot_grow_without_bound(self):
        decoder = input_reader.ScanDecoder(clock=lambda: 0.0, max_len=8)
        for _ in range(50):
            decoder.feed(input_reader.KEY_4, 1, 0.0)
        result = decoder.feed(input_reader.KEY_ENTER, 1, 0.0)
        self.assertIsNotNone(result)
        self.assertLessEqual(len(result), 8)


# --------------------------------------------------------------------------
# Finding the device
# --------------------------------------------------------------------------


class TestDeviceDiscovery(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.dev = self.root / "input"
        self.by_id = self.dev / "by-id"
        self.sysfs = self.root / "sys"
        self.by_id.mkdir(parents=True)
        self.sysfs.mkdir(parents=True)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def make_device(self, event: str, vendor: str, product: str, *, by_id_name="") -> None:
        (self.dev / event).write_bytes(b"")
        ids = self.sysfs / event / "device" / "id"
        ids.mkdir(parents=True)
        (ids / "vendor").write_text(vendor + "\n")
        (ids / "product").write_text(product + "\n")
        if by_id_name:
            os.symlink("../" + event, str(self.by_id / by_id_name))

    def find(self, **kwargs):
        return input_reader.find_device(
            dev_input=self.dev, by_id_dir=self.by_id, sys_class_input=self.sysfs, **kwargs
        )

    def test_the_by_id_symlink_is_preferred(self):
        self.make_device("event4", "1a86", "5456",
                         by_id_name="usb-NT_USB_Keyboard-event-kbd")
        found = self.find()
        self.assertIsNotNone(found)
        self.assertTrue(str(found).endswith("usb-NT_USB_Keyboard-event-kbd"))

    def test_a_different_keyboard_is_not_taken(self):
        # The Pi also has a Logitech receiver on it. Grabbing that would take
        # the operator's keyboard away, which is a memorable way to fail.
        self.make_device("event5", "046d", "4023",
                         by_id_name="usb-Logitech_USB_Receiver-if01-event-kbd")
        self.assertIsNone(self.find())

    def test_the_right_device_is_picked_out_of_several(self):
        self.make_device("event5", "046d", "4023",
                         by_id_name="usb-Logitech_USB_Receiver-if01-event-kbd")
        self.make_device("event4", "1a86", "5456",
                         by_id_name="usb-NT_USB_Keyboard-event-kbd")
        found = self.find()
        self.assertTrue(str(found).endswith("usb-NT_USB_Keyboard-event-kbd"))

    def test_it_falls_back_to_scanning_event_nodes(self):
        self.make_device("event4", "1a86", "5456")  # no by-id symlink at all
        found = self.find()
        self.assertEqual(found, self.dev / "event4")

    def test_a_missing_by_id_directory_is_not_an_error(self):
        import shutil

        shutil.rmtree(self.by_id)
        self.make_device("event4", "1a86", "5456")
        self.assertEqual(self.find(), self.dev / "event4")

    def test_nothing_plugged_in_returns_none(self):
        self.assertIsNone(self.find())

    def test_the_vendor_and_product_are_the_scanners(self):
        self.assertEqual(input_reader.VENDOR_ID, "1a86")
        self.assertEqual(input_reader.PRODUCT_ID, "5456")


# --------------------------------------------------------------------------
# Never raising into the agent
# --------------------------------------------------------------------------


class TestFailureIsSilent(unittest.TestCase):
    def test_a_missing_device_never_raises_and_sets_an_error(self):
        reader = input_reader.ScannerReader(
            lambda code: None, device_path="/nonexistent/input/event99",
            grab=False, retry_s=0.01,
        )
        self.assertFalse(reader.run_once())  # returns, does not raise
        status = reader.status()
        self.assertFalse(status["active"])
        self.assertIsNotNone(status["error"])
        self.assertIn("event99", status["error"])

    def test_no_device_at_all_is_reported_not_raised(self):
        reader = input_reader.ScannerReader(lambda code: None, finder=lambda: None,
                                            grab=False, retry_s=0.01)
        self.assertFalse(reader.run_once())
        self.assertIsNotNone(reader.status()["error"])
        self.assertFalse(reader.status()["active"])

    def test_a_failing_grab_is_a_warning_not_a_stop(self):
        # A regular file cannot be grabbed; the scan must still be read.
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "events"
        path.write_bytes(type_text("SMPL-A1B2C3", suffix=input_reader.KEY_ENTER))
        scans: list[str] = []
        reader = input_reader.ScannerReader(scans.append, device_path=str(path),
                                            grab=True, retry_s=0.01)
        reader.run_once()
        self.assertEqual(scans, ["SMPL-A1B2C3"])
        self.assertIsNotNone(reader.status()["grab_error"])

    def test_a_callback_that_explodes_does_not_kill_the_reader(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "events"
        path.write_bytes(type_text("11", suffix=input_reader.KEY_ENTER)
                         + type_text("22", suffix=input_reader.KEY_ENTER))
        seen: list[str] = []

        def boom(code):
            seen.append(code)
            raise RuntimeError("the router blew up")

        reader = input_reader.ScannerReader(boom, device_path=str(path), grab=False,
                                            retry_s=0.01)
        reader.run_once()
        self.assertEqual(seen, ["11", "22"])

    def test_the_thread_retries_and_stops_cleanly(self):
        reader = input_reader.ScannerReader(lambda code: None, finder=lambda: None,
                                            grab=False, retry_s=0.01)
        reader.start()
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and reader.status()["error"] is None:
            time.sleep(0.02)
        self.assertIsNotNone(reader.status()["error"])
        reader.stop()
        reader.join(timeout=3.0)
        self.assertFalse(reader.is_alive())

    def test_a_replugged_scanner_recovers_without_a_restart(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "events"
        scans: list[str] = []
        state = {"present": False}

        def finder():
            return path if state["present"] else None

        reader = input_reader.ScannerReader(scans.append, finder=finder, grab=False,
                                            retry_s=0.01)
        self.assertFalse(reader.run_once())
        path.write_bytes(type_text("99", suffix=input_reader.KEY_ENTER))
        state["present"] = True
        self.assertTrue(reader.run_once())
        self.assertEqual(scans, ["99"])
        self.assertIsNone(reader.status()["error"])

    def test_status_is_json_shaped_for_health(self):
        import json

        reader = input_reader.ScannerReader(lambda code: None, finder=lambda: None,
                                            grab=False, retry_s=0.01)
        status = reader.status()
        json.dumps(status)
        self.assertEqual(set(("active", "device", "error")) - set(status), set())

    def test_it_logs_once_per_failure_state_not_once_per_retry(self):
        lines: list[str] = []
        reader = input_reader.ScannerReader(lambda code: None, finder=lambda: None,
                                            grab=False, retry_s=0.01,
                                            log=lines.append)
        for _ in range(5):
            reader.run_once()
        self.assertEqual(len(lines), 1, "the journal must not fill up with one line per retry")


# --------------------------------------------------------------------------
# Stdlib only
# --------------------------------------------------------------------------


class TestNoDependencies(unittest.TestCase):
    def test_the_module_does_not_import_evdev(self):
        source = (HERE.parent / "input_reader.py").read_text(encoding="utf-8")
        self.assertNotIn("import evdev", source)
        self.assertNotIn("from evdev", source)

    def test_it_imports_on_a_mac(self):
        # fcntl exists on macOS; the ioctl simply never succeeds there.
        self.assertTrue(hasattr(input_reader, "ScannerReader"))


# --------------------------------------------------------------------------
# The reader thread never does the agent's network calls (A5)
# --------------------------------------------------------------------------


class TestTheHandoff(unittest.TestCase):
    """A scan costs a resolve and a booking; the device does not wait for them.

    With SMPL unreachable the handler blocks for about twelve seconds. While
    it did so *on the reading thread*, nothing drained /dev/input — and a
    kernel buffer that overflows does not lose a whole barcode, it loses part
    of one, which is how two scans become a code that resolves to the wrong
    article.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def _file_of(self, *codes: str) -> Path:
        blob = b"".join(type_text(code, suffix=input_reader.KEY_ENTER) for code in codes)
        return write_events(self.root, "events", blob)

    def test_the_device_is_drained_while_the_handler_is_stuck(self):
        path = self._file_of("11", "22", "33", "44", "55")
        entered = threading.Event()
        release = threading.Event()
        handled: list[str] = []

        def slow(code: str) -> None:
            handled.append(code)
            entered.set()
            release.wait(10.0)

        reader = input_reader.ScannerReader(slow, device_path=str(path), grab=False,
                                            retry_s=0.01)
        self.addCleanup(release.set)
        self.addCleanup(reader.stop)
        thread = threading.Thread(target=reader.run_once, daemon=True)
        thread.start()

        self.assertTrue(entered.wait(5.0), "the handler was never called")
        deadline = time.monotonic() + 5.0
        while reader.status()["scans"] < 5 and time.monotonic() < deadline:
            time.sleep(0.01)
        # Every keystroke was read and decoded while the first scan is still
        # sitting inside the handler.
        self.assertEqual(reader.status()["scans"], 5)
        self.assertEqual(handled, ["11"])
        self.assertGreater(reader.status()["queued"], 0)

        release.set()
        thread.join(10.0)
        self.assertFalse(thread.is_alive())
        self.assertEqual(handled, ["11", "22", "33", "44", "55"])

    def test_the_queue_is_bounded_and_says_what_it_dropped(self):
        path = self._file_of(*["%02d" % index for index in range(20)])
        release = threading.Event()
        entered = threading.Event()

        def slow(code: str) -> None:
            entered.set()
            release.wait(10.0)

        reader = input_reader.ScannerReader(slow, device_path=str(path), grab=False,
                                            retry_s=0.01, queue_max=3)
        self.addCleanup(release.set)
        self.addCleanup(reader.stop)
        thread = threading.Thread(target=reader.run_once, daemon=True)
        thread.start()
        self.assertTrue(entered.wait(5.0))
        deadline = time.monotonic() + 5.0
        while reader.status()["scans"] < 20 and time.monotonic() < deadline:
            time.sleep(0.01)

        status = reader.status()
        self.assertEqual(status["scans"], 20, "the reader stopped reading")
        self.assertGreater(status["dropped"], 0)
        self.assertLessEqual(status["queued"], 3)
        release.set()
        thread.join(10.0)

    def test_status_still_json_shaped_with_the_new_counters(self):
        reader = input_reader.ScannerReader(lambda code: None, finder=lambda: None,
                                            grab=False, retry_s=0.01)
        json.dumps(reader.status())
        for key in ("scans", "queued", "dropped"):
            self.assertIn(key, reader.status())

    def test_a_handler_that_explodes_still_lets_the_next_scan_through(self):
        path = self._file_of("11", "22")
        seen: list[str] = []

        def boom(code: str) -> None:
            seen.append(code)
            raise RuntimeError("the router blew up")

        reader = input_reader.ScannerReader(boom, device_path=str(path), grab=False,
                                            retry_s=0.01)
        self.addCleanup(reader.stop)
        reader.run_once()
        self.assertEqual(seen, ["11", "22"])


# --------------------------------------------------------------------------
# The gap is measured on the kernel's clock, not on ours (A5)
# --------------------------------------------------------------------------


class TestEventTimestamps(unittest.TestCase):
    def test_iter_events_decodes_the_timeval(self):
        blob = input_reader.pack_event(1757, 500000, input_reader.EV_KEY, 30, 1)
        at, typ, code, value = list(input_reader.iter_events(blob))[0]
        self.assertAlmostEqual(at, 1757.5, places=6)
        self.assertEqual((typ, code, value), (input_reader.EV_KEY, 30, 1))

    def test_a_slow_agent_cannot_split_one_barcode_in_two(self):
        # The clock jumps ten seconds every time it is asked — a process that
        # was descheduled between keystrokes. The events themselves are 200 µs
        # apart, so the barcode is one barcode.
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        blob = b""
        for index, char in enumerate("SMPL-A1B2C3"):
            code, needs_shift = input_reader.keycode_for(char)
            usec = index * 200
            blob += (shifted(code, 0) if needs_shift else tap(code, 0, usec))
        blob += tap(input_reader.KEY_ENTER, 0, 3000)
        path = write_events(Path(tmp.name), "events", blob)

        ticks = [0.0]

        def lurching_clock() -> float:
            ticks[0] += 10.0
            return ticks[0]

        scans: list[str] = []
        reader = input_reader.ScannerReader(scans.append, device_path=str(path),
                                            grab=False, retry_s=0.01, gap_s=1.5,
                                            clock=lurching_clock)
        self.addCleanup(reader.stop)
        reader.run_once()
        self.assertEqual(scans, ["SMPL-A1B2C3"])

    def test_a_real_pause_between_keys_still_splits_the_buffer(self):
        # Same guard, still doing its job: half of one barcode glued to half
        # of another resolves to the wrong article, which is worse than a scan
        # that simply failed.
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        blob = (tap(input_reader.KEY_4, 0, 0)
                + tap(input_reader.KEY_7, 9, 0)          # nine seconds later
                + tap(input_reader.KEY_ENTER, 9, 1000))
        path = write_events(Path(tmp.name), "events", blob)
        scans: list[str] = []
        reader = input_reader.ScannerReader(scans.append, device_path=str(path),
                                            grab=False, retry_s=0.01, gap_s=1.5)
        self.addCleanup(reader.stop)
        reader.run_once()
        self.assertEqual(scans, ["7"])


if __name__ == "__main__":
    unittest.main()
