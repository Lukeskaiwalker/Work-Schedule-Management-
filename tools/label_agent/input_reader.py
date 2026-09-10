"""The USB barcode scanner, read straight off /dev/input, stdlib only.

The scanner is an HID keyboard. Until now it typed into a browser page, which
works only while that page has focus — and a kiosk with two screens and no
keyboard has no reliable answer to "which window is focused right now". So the
agent reads the device itself and takes an exclusive grab, which both removes
the focus question and stops barcodes leaking into whatever else is on screen.

There is no python3-evdev on the Pi and the virtualenv is built without system
site packages, so this decodes ``struct input_event`` by hand:

    struct input_event { struct timeval time; __u16 type, code; __s32 value; }

which is ``struct.calcsize("llHHi")`` — 16 bytes on a 32-bit userland, 24 on a
64-bit one. It is computed, never hardcoded: getting it wrong does not crash,
it silently yields garbage codes, which is the worst failure mode available.
(Verified on the Pi, aarch64 Linux 6.12: 24.)

The keymap is deliberately tiny. A barcode alphabet is digits, capitals, and a
handful of punctuation; this is not a keyboard driver and should never grow
into one. Letters are accepted with *or* without shift, because our internal
code alphabet is uppercase-only and some wedges simply do not send the shift.

**The scanner speaks German, and this is measured, not assumed.** Captured
read-only from /dev/input/event4 on the office Pi on 2026-09-10, from USB
1a86:5456 "NT USB Keyboard" (a 2D imager that read a machine DataMatrix and an
SMPL code label). Two real scans, with the keycodes the kernel reported:

    label 'M-0062'       keycodes [50, 53, 11, 11, 7, 3]        terminator ENTER (28)
    label 'SMPL-RPJN7H'  keycodes [31, 50, 25, 38, 53, 19, 25, 36, 49, 8, 35]

Decoded with a US table those come out as ``M/0062`` and ``SMPL/RPJN7H``: the
labels say **hyphen**, so **keycode 53 is "-", not "/"**. That is the German
layout, confirmed against the Pi's own XKB data (/usr/share/X11/xkb/symbols/de
against .../us):

    evdev 53 (<AB10>): de = minus   us/gb = slash
    evdev 21 (<AD06>): de = z       us/gb = y
    evdev 44 (<AB01>): de = y       us/gb = z

The Y/Z half of that is what makes it worth spelling out. ``CODE_ALPHABET``
(apps/api/app/services/werkstatt_internal_codes.py) is
"0123456789ABCDEFGHJKLMNPQRSTUVWXYZ" — it contains **both** Y and Z, and 14 of
the 55 coded articles in production carry one, so a US table silently
mis-resolves about a quarter of every article scan. Nothing about that shows up
as an error; it shows up as "SMPL does not know this code".

So the table below is German, and the layout is a *setting* rather than a fact:
a replacement scanner may be configured for US, and ``SCANNER_LAYOUT`` (agent
flag ``--scanner-layout``, env ``SCANNER_LAYOUT``) picks the table. Only the
characters our codes can contain are in either table — digits, A-Z, "-", ".",
"/", space, and the "+"/"_" the keypad and shift already reached. Everything
else a German keyboard produces on those keys (ß, ü, ö, ä, ^, #, ´) is absent
on purpose: an unmapped key is dropped, never guessed.

One deliberate hole, in both tables: the *shifted* digit row is not decoded.
On the German layout Shift+7 is "/" and Shift+8 is "(", and no code we mint
contains either — while a wedge that holds shift across a whole numeric
barcode is a real thing, and turning its "7" into "/" would corrupt an EAN.
A scanner that really must send "/" has the keypad slash (evdev 98), which is
in both tables.

Everything here is optional. The reader runs in a daemon thread, never raises
into the agent, logs once per failure state rather than once per retry, and
re-opens the device every few seconds forever — so a scanner unplugged at
lunchtime is working again a few seconds after it is plugged back in, with
nobody restarting anything.

**The reading thread never does the agent's work.** A scan handed to the
router costs a resolve and a booking — two network calls, up to twelve
seconds with SMPL unreachable — and for all of that time the device is not
being drained. The kernel's input buffer is small; keystrokes pile up and
come out as two barcodes glued together, which resolves to the wrong article.
So a decoded scan goes onto a bounded queue and a second thread does the
talking, while this one goes straight back to reading.

For the same reason the inter-key gap is measured on the *kernel's* timestamp
rather than on when this process got round to looking: every event carries a
timeval, and using it means a busy agent cannot make a whole barcode look
like two.
"""

from __future__ import annotations

import fcntl
import queue
import select
import struct
import threading
import time
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, Tuple

__all__ = [
    "ScannerReader",
    "ScanDecoder",
    "find_device",
    "keycode_for",
    "keys_for",
    "shifted_for",
    "resolve_layout",
    "pack_event",
    "LAYOUTS",
    "SCANNER_LAYOUT",
    "EVENT_FORMAT",
    "EVENT_SIZE",
    "EVIOCGRAB",
    "VENDOR_ID",
    "PRODUCT_ID",
]

# The scanner on the office Pi. Confirmed from sysfs:
#   /sys/class/input/event4/device/id/{vendor,product} = 1a86 / 5456
#   /dev/input/by-id/usb-NT_USB_Keyboard-event-kbd -> ../event4
# The same box also has a Logitech receiver (046d:4023) on event5, and
# grabbing *that* would take the operator's keyboard away — which is why the
# match is on ids and not on "the first thing that looks like a keyboard".
VENDOR_ID = "1a86"
PRODUCT_ID = "5456"

EVENT_FORMAT = "llHHi"
EVENT_SIZE = struct.calcsize(EVENT_FORMAT)

EV_SYN = 0x00
EV_KEY = 0x01
EV_MSC = 0x04

# _IOW('E', 0x90, int): direction 01, size 4, type 'E' (0x45), number 0x90.
EVIOCGRAB = 0x40044590

DEFAULT_RETRY_S = 5.0
DEFAULT_GAP_S = 1.5
DEFAULT_MAX_LEN = 256
READ_BATCH = 64
SELECT_TIMEOUT_S = 0.5
# Deep enough that a slow SMPL never costs a scan, shallow enough that the
# scans waiting in it are still worth booking when it comes back. Sixty-four
# scans is more than anybody pulls the trigger for in twelve seconds.
DEFAULT_QUEUE_MAX = 64
# How long run_once waits for the handoff to finish before it returns.
DEFAULT_DRAIN_S = 5.0

KEY_TAB = 15
KEY_ENTER = 28
KEY_KPENTER = 96
KEY_LEFTSHIFT = 42
KEY_RIGHTSHIFT = 54
KEY_MINUS = 12
KEY_A = 30
KEY_4 = 5
KEY_5 = 6
KEY_7 = 8
KEY_8 = 9
KEY_F1 = 59
KEY_KP0 = 82
KEY_KP4 = 75
KEY_KP7 = 71

TERMINATORS = frozenset((KEY_ENTER, KEY_KPENTER, KEY_TAB))
SHIFT_KEYS = frozenset((KEY_LEFTSHIFT, KEY_RIGHTSHIFT))

# The numeric keypad is not laid out by the keyboard layout — a keypad key
# means its own digit on every one of them — so both tables share it. Some
# wedges are configured to send digits from here rather than from the top row.
_KEYPAD: Dict[int, str] = {
    71: "7", 72: "8", 73: "9", 74: "-", 75: "4", 76: "5", 77: "6", 78: "+",
    79: "1", 80: "2", 81: "3", 82: "0", 83: ".", 98: "/",
}

# The top digit row, likewise identical on both layouts.
_DIGITS: Dict[int, str] = {
    2: "1", 3: "2", 4: "3", 5: "4", 6: "5", 7: "6", 8: "7", 9: "8", 10: "9", 11: "0",
}

#: The whole alphabet a barcode can contain on a **German** scanner, and
#: nothing else. QWERTZ: evdev 21 is Z and evdev 44 is Y. Evdev 53 (<AB10>) is
#: the hyphen — the measured fact at the top of this file. Evdev 12 (<AE11>) is
#: "ß" here, not "-", so it is absent rather than mapped to a hyphen it does
#: not mean.
_DE_KEYS: Dict[int, str] = {
    **_DIGITS,
    16: "Q", 17: "W", 18: "E", 19: "R", 20: "T", 21: "Z", 22: "U", 23: "I", 24: "O",
    25: "P", 27: "+",
    30: "A", 31: "S", 32: "D", 33: "F", 34: "G", 35: "H", 36: "J", 37: "K", 38: "L",
    44: "Y", 45: "X", 46: "C", 47: "V", 48: "B", 49: "N", 50: "M",
    52: ".", 53: "-", 57: " ",
    **_KEYPAD,
}

#: The same alphabet on a US scanner, kept for a replacement device that is
#: configured the other way. QWERTY, and the hyphen back on evdev 12.
_US_KEYS: Dict[int, str] = {
    **_DIGITS,
    12: "-",
    16: "Q", 17: "W", 18: "E", 19: "R", 20: "T", 21: "Y", 22: "U", 23: "I", 24: "O",
    25: "P",
    30: "A", 31: "S", 32: "D", 33: "F", 34: "G", 35: "H", 36: "J", 37: "K", 38: "L",
    44: "Z", 45: "X", 46: "C", 47: "V", 48: "B", 49: "N", 50: "M",
    52: ".", 53: "/", 57: " ",
    **_KEYPAD,
}

# Shift changes exactly one character we care about, and it is on a different
# key per layout: the underscore lives above the German hyphen (<AB10>, evdev
# 53) and above the US one (<AE11>, evdev 12). Digits stay digits — see the
# note in the module docstring.
_DE_SHIFTED: Dict[int, str] = {53: "_"}
_US_SHIFTED: Dict[int, str] = {KEY_MINUS: "_"}

#: Which table to decode with. "de" is what the office Pi's scanner sends;
#: "us" is here because a replacement may be configured differently. Threaded
#: in from the agent config (``--scanner-layout`` / ``SCANNER_LAYOUT``).
SCANNER_LAYOUT = "de"

LAYOUTS: Dict[str, Dict[int, str]] = {"de": _DE_KEYS, "us": _US_KEYS}
SHIFTED_LAYOUTS: Dict[str, Dict[int, str]] = {"de": _DE_SHIFTED, "us": _US_SHIFTED}

#: The default tables, under the names the rest of the agent already uses.
KEYS: Dict[int, str] = LAYOUTS[SCANNER_LAYOUT]
SHIFTED: Dict[int, str] = SHIFTED_LAYOUTS[SCANNER_LAYOUT]


def resolve_layout(name: str) -> str:
    """A layout name we have a table for. A typo is the default, never a crash.

    A misspelled setting must not be the reason a workshop has no scanner, so
    this normalises rather than validates; ``ScannerReader`` reports the name
    it actually settled on in :meth:`~ScannerReader.status`.
    """
    text = (name or "").strip().lower()
    return text if text in LAYOUTS else SCANNER_LAYOUT


def keys_for(layout: str = SCANNER_LAYOUT) -> Dict[int, str]:
    return LAYOUTS[resolve_layout(layout)]


def shifted_for(layout: str = SCANNER_LAYOUT) -> Dict[int, str]:
    return SHIFTED_LAYOUTS[resolve_layout(layout)]


def _reverse(keys: Dict[int, str], shifted: Dict[int, str]) -> Dict[str, Tuple[int, bool]]:
    table: Dict[str, Tuple[int, bool]] = {}
    for code, char in keys.items():
        table.setdefault(char, (code, char.isalpha()))
    for code, char in shifted.items():
        table.setdefault(char, (code, True))
    return table


_CHAR_TO_KEY: Dict[str, Dict[str, Tuple[int, bool]]] = {
    name: _reverse(LAYOUTS[name], SHIFTED_LAYOUTS[name]) for name in LAYOUTS
}


def keycode_for(char: str, layout: str = SCANNER_LAYOUT) -> Tuple[Optional[int], bool]:
    """``(keycode, needs_shift)`` for one character, for tests and fixtures."""
    table = _CHAR_TO_KEY[resolve_layout(layout)]
    return table.get((char or "").upper(), (None, False))


def pack_event(sec: int, usec: int, typ: int, code: int, value: int) -> bytes:
    """One ``struct input_event`` — the exact bytes the kernel writes."""
    return struct.pack(EVENT_FORMAT, sec, usec, typ, code, value)


def iter_events(blob: bytes) -> Iterable[Tuple[float, int, int, int]]:
    """Decode whole events from a byte string; a partial tail is dropped.

    Yields ``(at, type, code, value)``. ``at`` is the kernel's own timeval in
    seconds — the moment the key was pressed, not the moment this process read
    it, which is the only one of the two that says anything about the scanner.
    """
    for offset in range(0, len(blob) - EVENT_SIZE + 1, EVENT_SIZE):
        sec, usec, typ, code, value = struct.unpack(
            EVENT_FORMAT, blob[offset:offset + EVENT_SIZE]
        )
        yield sec + usec / 1000000.0, typ, code, value


# --------------------------------------------------------------------------
# Decoding
# --------------------------------------------------------------------------


class ScanDecoder:
    """Keystrokes in, whole barcodes out.

    A scan is committed on Enter, keypad Enter or Tab — the three suffixes a
    HID wedge can be configured to send. A buffer that has sat untouched for
    longer than the inter-key gap is thrown away rather than glued to the next
    scan: half of one barcode joined to half of another is a code that resolves
    to the wrong article, which is far worse than a scan that simply failed.

    ``layout`` picks which keycode table the scancodes are read through; see
    the module docstring for why the default is German and how that was
    measured rather than assumed.
    """

    def __init__(self, *, clock: Callable[[], float] = time.monotonic,
                 gap_s: float = DEFAULT_GAP_S, max_len: int = DEFAULT_MAX_LEN,
                 layout: str = SCANNER_LAYOUT) -> None:
        self._clock = clock
        self.gap_s = float(gap_s)
        self.max_len = int(max_len)
        self.layout = resolve_layout(layout)
        self._keys = keys_for(self.layout)
        self._shifted = shifted_for(self.layout)
        self._chars: List[str] = []
        self._shift = False
        self._last_at: Optional[float] = None

    @property
    def buffered(self) -> str:
        return "".join(self._chars)

    def reset(self) -> None:
        self._chars = []
        self._shift = False
        self._last_at = None

    def feed(self, code: int, value: int, at: Optional[float] = None) -> Optional[str]:
        """One key event. Returns a completed barcode, or None."""
        if value == 2:  # autorepeat: a scanner never means it
            return None
        now = self._clock() if at is None else at

        if code in SHIFT_KEYS:
            if value in (0, 1):
                self._shift = value == 1
            return None
        if value != 1:
            return None

        if self._last_at is not None and (now - self._last_at) > self.gap_s:
            self._chars = []
        self._last_at = now

        if code in TERMINATORS:
            text = "".join(self._chars)
            self._chars = []
            self._last_at = None
            return text or None

        char = self._shifted.get(code) if self._shift else None
        if char is None:
            char = self._keys.get(code)
        if char is None:
            return None  # not in the barcode alphabet: dropped, never guessed
        if len(self._chars) < self.max_len:
            self._chars.append(char)
        return None


# --------------------------------------------------------------------------
# Finding the device
# --------------------------------------------------------------------------


def _read_id(sys_class_input: Path, event_name: str) -> Optional[Tuple[str, str]]:
    base = Path(sys_class_input) / event_name / "device" / "id"
    try:
        vendor = (base / "vendor").read_text(encoding="utf-8").strip().lower()
        product = (base / "product").read_text(encoding="utf-8").strip().lower()
    except (OSError, UnicodeDecodeError):
        return None
    if not vendor or not product:
        return None
    return vendor, product


def _glob(directory: Path, pattern: str) -> List[Path]:
    try:
        return sorted(Path(directory).glob(pattern))
    except OSError:
        return []


def find_device(*, vendor: str = VENDOR_ID, product: str = PRODUCT_ID,
                dev_input: Path = Path("/dev/input"),
                by_id_dir: Optional[Path] = None,
                sys_class_input: Path = Path("/sys/class/input")) -> Optional[Path]:
    """The scanner's event node, matched by USB vendor and product.

    The ``by-id`` symlink is preferred because it is stable across a replug
    while ``eventN`` is not — the number changes if the scanner is plugged in
    after something else. When udev has not made one (or /dev/input/by-id does
    not exist at all), the event nodes are scanned directly.
    """
    dev_input = Path(dev_input)
    by_id_dir = Path(by_id_dir) if by_id_dir is not None else dev_input / "by-id"
    wanted = (vendor.lower(), product.lower())

    for link in _glob(by_id_dir, "*-event-kbd"):
        try:
            target = Path(link).resolve()
        except OSError:
            continue
        if _read_id(sys_class_input, target.name) == wanted:
            return link

    for node in _glob(dev_input, "event*"):
        if _read_id(sys_class_input, node.name) == wanted:
            return node
    return None


# --------------------------------------------------------------------------
# The reader
# --------------------------------------------------------------------------


class ScannerReader:
    """Owns the scanner: one daemon thread, one grab, one callback.

    The contract with the rest of the agent is entirely one-way. Nothing here
    raises into a request handler, nothing here blocks a scan path, and the
    only thing the agent asks of it is :meth:`status`.
    """

    def __init__(self, on_scan: Callable[[str], None], *,
                 device_path: str = "", finder: Optional[Callable[[], Optional[Path]]] = None,
                 vendor: str = VENDOR_ID, product: str = PRODUCT_ID,
                 grab: bool = True, retry_s: float = DEFAULT_RETRY_S,
                 gap_s: float = DEFAULT_GAP_S, max_len: int = DEFAULT_MAX_LEN,
                 queue_max: int = DEFAULT_QUEUE_MAX, drain_s: float = DEFAULT_DRAIN_S,
                 layout: str = SCANNER_LAYOUT,
                 clock: Callable[[], float] = time.monotonic,
                 log: Optional[Callable[[str], None]] = None) -> None:
        self._on_scan = on_scan
        self.vendor = vendor
        self.product = product
        self.grab = bool(grab)
        self.retry_s = float(retry_s)
        self.gap_s = float(gap_s)
        self.max_len = int(max_len)
        self.layout = resolve_layout(layout)
        self.drain_s = float(drain_s)
        self._clock = clock
        self._log = log
        if device_path:
            self._finder: Callable[[], Optional[Path]] = lambda: Path(device_path)
        elif finder is not None:
            self._finder = finder
        else:
            self._finder = lambda: find_device(vendor=self.vendor, product=self.product)

        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._active = False
        self._device: Optional[str] = None
        self._error: Optional[str] = None
        self._grab_error: Optional[str] = None
        self._logged: Optional[str] = None
        self._scans = 0

        # The handoff. The reading thread only ever puts; a second thread does
        # everything that can block, so an unreachable SMPL costs booked scans
        # and never costs keystrokes.
        self._queue: "queue.Queue[str]" = queue.Queue(maxsize=max(1, int(queue_max)))
        self._worker: Optional[threading.Thread] = None
        self._worker_lock = threading.Lock()
        self._idle = threading.Condition()
        self._pending = 0
        self._dropped = 0

    def set_device(self, device_path: str) -> None:
        """Pin the reader to one node, overriding the vendor/product search."""
        path = Path(device_path)
        self._finder = lambda: path

    # -- lifecycle --------------------------------------------------------

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._ensure_worker()
        self._thread = threading.Thread(target=self._loop, name="scanner-reader", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def join(self, timeout: Optional[float] = None) -> None:
        thread = self._thread
        if thread is not None:
            thread.join(timeout)
        worker = self._worker
        if worker is not None:
            worker.join(timeout)

    def drain(self, timeout: Optional[float] = None) -> bool:
        """Wait for every queued scan to be handled. True when none is left.

        Used by ``run_once`` and by tests; never by the decode loop, which is
        the whole point of the queue.
        """
        deadline = time.monotonic() + (self.drain_s if timeout is None else float(timeout))
        with self._idle:
            while self._pending > 0:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._idle.wait(remaining)
            return True

    def is_alive(self) -> bool:
        thread = self._thread
        return bool(thread is not None and thread.is_alive())

    def status(self) -> Dict[str, object]:
        # The queue depth, not the depth plus the one inside the handler:
        # "queued" answers "how far behind is the booking", and the scan being
        # booked right now is not behind.
        queued = self._queue.qsize()
        with self._lock:
            return {
                "active": self._active,
                "device": self._device,
                "error": self._error,
                "grab_error": self._grab_error,
                "scans": self._scans,
                "queued": queued,
                "dropped": self._dropped,
                "layout": self.layout,
                "vendor_product": "%s:%s" % (self.vendor, self.product),
            }

    # -- the loop ---------------------------------------------------------

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.run_once()
            except Exception as exc:  # noqa: BLE001 - a reader must never die
                self._fail("%s: %s" % (type(exc).__name__, exc))
            if self._stop.wait(self.retry_s):
                return

    def run_once(self) -> bool:
        """One open-grab-read cycle. Returns False on any failure; never raises."""
        path = self._locate()
        if path is None:
            self._fail("no scanner found (USB %s:%s is not plugged in)"
                       % (self.vendor, self.product))
            return False
        try:
            handle = open(str(path), "rb", buffering=0)
        except OSError as exc:
            self._fail("cannot open %s: %s" % (path, exc))
            return False

        self._take_grab(handle, path)
        self._succeed(str(path))
        self._ensure_worker()
        try:
            self._pump(handle)
        except OSError as exc:
            self._fail("read failed on %s: %s" % (path, exc))
            return False
        finally:
            with self._lock:
                self._active = False
            self._release(handle)
            # The device is gone; waiting for the handoff here costs nothing
            # and means a caller that drives one cycle by hand sees every
            # scan delivered by the time it returns.
            self.drain()
        return True

    def _locate(self) -> Optional[Path]:
        try:
            found = self._finder()
        except Exception as exc:  # noqa: BLE001 - a broken finder is a missing scanner
            self._fail("device lookup failed: %s: %s" % (type(exc).__name__, exc))
            return None
        return Path(found) if found else None

    def _take_grab(self, handle, path: Path) -> None:
        if not self.grab:
            with self._lock:
                self._grab_error = None
            return
        try:
            fcntl.ioctl(handle.fileno(), EVIOCGRAB, 1)
        except (OSError, ValueError) as exc:
            # Not fatal: without the grab the scan is still read, it is just
            # also delivered to whatever else is listening.
            with self._lock:
                self._grab_error = "%s (barcodes may also reach other windows)" % exc
            return
        with self._lock:
            self._grab_error = None

    def _release(self, handle) -> None:
        if self.grab:
            try:
                fcntl.ioctl(handle.fileno(), EVIOCGRAB, 0)
            except (OSError, ValueError):
                pass
        try:
            handle.close()
        except OSError:
            pass

    def _pump(self, handle) -> None:
        decoder = ScanDecoder(clock=self._clock, gap_s=self.gap_s, max_len=self.max_len,
                              layout=self.layout)
        buffer = b""
        while not self._stop.is_set():
            try:
                ready, _, _ = select.select([handle], [], [], SELECT_TIMEOUT_S)
            except (OSError, ValueError):
                return
            if not ready:
                continue
            chunk = handle.read(EVENT_SIZE * READ_BATCH)
            if not chunk:
                return  # EOF: the device went away, or the fixture ran out
            buffer += chunk
            usable = len(buffer) - (len(buffer) % EVENT_SIZE)
            for at, typ, code, value in iter_events(buffer[:usable]):
                if typ != EV_KEY:
                    continue
                # The kernel's timestamp, not ours: the gap guard is about the
                # scanner's typing speed, and a busy agent must not be able to
                # make one barcode look like two.
                scanned = decoder.feed(code, value, at)
                if scanned:
                    self._emit(scanned)
            buffer = buffer[usable:]

    # -- the handoff ------------------------------------------------------

    def _emit(self, code: str) -> None:
        """Queue a scan. Never calls the handler on the reading thread."""
        with self._lock:
            self._scans += 1
        self._ensure_worker()
        with self._idle:
            try:
                self._queue.put_nowait(code)
            except queue.Full:
                with self._lock:
                    self._dropped += 1
                    dropped = self._dropped
                self._note("scan queue full, dropped %s (%d total)" % (code, dropped))
                return
            self._pending += 1

    def _ensure_worker(self) -> None:
        with self._worker_lock:
            if self._worker is not None and self._worker.is_alive():
                return
            self._worker = threading.Thread(target=self._dispatch_loop,
                                            name="scanner-dispatch", daemon=True)
            self._worker.start()

    def _dispatch_loop(self) -> None:
        """Do the talking. Blocking here is safe; blocking in _pump is not."""
        while True:
            try:
                code = self._queue.get(timeout=SELECT_TIMEOUT_S)
            except queue.Empty:
                if self._stop.is_set():
                    return
                continue
            try:
                self._on_scan(code)
            except Exception as exc:  # noqa: BLE001 - the router is not this thread's problem
                self._note("scan handler failed: %s: %s" % (type(exc).__name__, exc))
            finally:
                with self._idle:
                    self._pending -= 1
                    if self._pending <= 0:
                        self._idle.notify_all()

    # -- status bookkeeping -----------------------------------------------

    def _fail(self, message: str) -> None:
        with self._lock:
            self._active = False
            self._error = message
            changed = self._logged != message
            if changed:
                self._logged = message
        if changed:
            self._note("scanner unavailable: %s" % message)

    def _succeed(self, device: str) -> None:
        with self._lock:
            recovered = self._error is not None or self._logged is not None
            self._active = True
            self._device = device
            self._error = None
            self._logged = None
        if recovered:
            self._note("scanner ready on %s" % device)

    def _note(self, message: str) -> None:
        if self._log is not None:
            try:
                self._log(message)
            except Exception:  # noqa: BLE001
                pass
