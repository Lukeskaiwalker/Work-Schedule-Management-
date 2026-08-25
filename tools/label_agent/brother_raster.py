"""USB raster driver for the Brother P-touch Cube PT-P710BT (macOS / pyusb).

Every command byte below is taken from Brother's official
"Software Developer's Manual -- Raster Command Reference PT-E550W/P750W/P710BT",
version 1.02 (referred to below as [RCR] with a section or page number).
Nothing here is guessed; if a value has no citation it is a local policy choice
and says so.

Why raster-only
---------------
[RCR p.31, "ESC i a"] states plainly: "The PT-P710BT does not support ESC/P mode
and P-touch Template mode."  So there is no text/barcode firmware to lean on --
the host must rasterise everything and ship it dot by dot.  This module is the
transport for those dots; deciding *which* dots is the renderer's job.

Why nothing may be sent during printing
---------------------------------------
[RCR p.4, section 1 step (3)] "No command can be sent to the printer after the
print data is transmitted and until the completion of printing is confirmed.
Even the 'status information request' command cannot be sent during printing."
That is why `print_raster` builds the entire byte stream up front, writes it,
and then only *reads* until the printer reports completion.  Reading is fine --
the flow charts in [RCR section 5.1] show the host doing exactly that.

Why uncompressed raster
-----------------------
[RCR p.4] "In order to print at high speed when a USB port is used to send
uncompressed raster data, the Brother PT-XXXX starts printing when it starts to
receive print data, instead of waiting for a print command (concurrent
printing)."  Uncompressed also sidesteps a trap: the "zero raster graphics" (Z)
shortcut is documented as "Valid only when TIFF is selected as the compression
mode" [RCR p.7], so with compression off every single line -- blank ones
included -- must go out as a full 16-byte G transfer.
"""

from __future__ import annotations

import struct
import time
from dataclasses import dataclass

import usb.backend.libusb1
import usb.core
import usb.util

__all__ = [
    "VENDOR_ID",
    "PRODUCT_ID",
    "BYTES_PER_LINE",
    "TOTAL_PINS",
    "DEFAULT_TAPE_WIDTH_MM",
    "TAPE_GEOMETRY",
    "TapeGeometry",
    "PrinterError",
    "PrinterNotFound",
    "PrinterBusy",
    "PrinterStalled",
    "PrinterStatus",
    "find_printer",
    "BrotherPTouch",
]

# [RCR p.46, "Appendix A: USB Specifications"] Vendor ID 0x04F9,
# PT-P710BT product ID 0x20af.  Confirmed against ioreg on this machine.
VENDOR_ID = 0x04F9
PRODUCT_ID = 0x20AF

# [RCR p.20] "Total number of pins: 128pin", and every tape width uses
# "Number of bytes for raster graphics transfer" = 16.  128 bits / 8 = 16 bytes,
# always, regardless of how few of those pins the tape actually exposes.
TOTAL_PINS = 128
BYTES_PER_LINE = 16

# The printer is 180 dpi in both axes for normal printing [RCR p.13].
DPI = 180

# Length limits at 180x180 dpi [RCR p.18, "2.3.4 Maximum and minimum lengths"].
MAX_RASTER_LINES = 7086  # 1000 mm
MIN_RASTER_LINES = 31  # 4.4 mm -- the machine pads short labels to 24.5 mm anyway

# Feed / margin limits at 180x180 dpi [RCR p.17, "2.3.3 Feed amount"].
MIN_MARGIN_DOTS = 14  # 2 mm
MAX_MARGIN_DOTS = 900  # 127 mm
DEFAULT_MARGIN_DOTS = MIN_MARGIN_DOTS


@dataclass(frozen=True)
class TapeGeometry:
    """Pin layout of one raster line for a given tape width [RCR p.20].

    A raster line is 128 bits sent MSB-first, first byte first.  Per the pin
    diagram on [RCR p.20] the *first* byte sits on the right-margin side of the
    head and the *last* byte's LSB is pin 0 on the left-margin side.  So bit
    index 0 of the 128-bit buffer (MSB of byte 0) is the first right-margin pin,
    and the printable window starts at bit index `right_margin_pins`.

    This is surprising enough to be worth stating twice: the margins are *not*
    symmetric padding you can ignore -- data written into them is simply thrown
    away by the head, and data written at the wrong offset prints off-centre.
    """

    width_mm: int
    left_margin_pins: int
    print_pins: int
    right_margin_pins: int

    @property
    def print_offset_bits(self) -> int:
        """Bit index, within the 128-bit MSB-first line, of the first printable pin."""
        return self.right_margin_pins


# [RCR p.20, "TZe tape"] left margin / print area / right margin pin counts.
TAPE_GEOMETRY = {
    4: TapeGeometry(4, 52, 24, 52),  # 3.5 mm tape reports a media width of 4 mm
    6: TapeGeometry(6, 48, 32, 48),
    9: TapeGeometry(9, 39, 50, 39),
    12: TapeGeometry(12, 29, 70, 29),
    18: TapeGeometry(18, 8, 112, 8),
    24: TapeGeometry(24, 0, 128, 0),
}

# What this station is built around: 12 mm TZe, 84 dots of tape, 70 printable.
DEFAULT_TAPE_WIDTH_MM = 12

# ---------------------------------------------------------------------------
# Command bytes -- [RCR p.22, "3. Print Command List"] and [RCR section 4].
# ---------------------------------------------------------------------------

# NULL, 00h.  [RCR p.5] "Sends a 100-byte invalidate command, and then resets
# the printer to the receiving state."
CMD_INVALIDATE = b"\x00" * 100

# ESC @, 1B 40h -- "Initializes mode settings.  Also used to cancel printing."
CMD_INITIALIZE = b"\x1b\x40"

# ESC i S, 1B 69 53h -- status information request, reply fixed at 32 bytes.
# The manual footnotes this as unsupported on the PT-E550W/PT-P750W; the
# PT-P710BT (our device) *does* support it.
CMD_STATUS_REQUEST = b"\x1b\x69\x53"

# ESC i a {n1}, 1B 69 61h -- switch dynamic command mode.  n1: 0 = ESC/P,
# 1 = raster, 3 = P-touch Template.  "Be sure to switch to this mode." [RCR p.31]
CMD_RASTER_MODE = b"\x1b\x69\x61\x01"

# ESC i ! {n1}, 1B 69 21h -- automatic status notification.  0 = notify
# (default), 1 = do not notify [RCR p.31].  We keep notification ON: it is the
# only way to learn that printing finished, since we are forbidden from asking.
CMD_NOTIFY_ON = b"\x1b\x69\x21\x00"

# M {n}, 4Dh -- select compression mode.  0 = none, 2 = TIFF [RCR p.35].
CMD_COMPRESSION_NONE = b"\x4d\x00"

# G {n1}{n2}{d1..dk}, 47h -- raster graphics transfer, k = n1 + n2*256.
# "use the following value if no compression is specified [...] n=16" [RCR p.37].
_RASTER_TRANSFER_HEADER = b"\x47" + struct.pack("<H", BYTES_PER_LINE)

# FF, 0Ch -- "print command at the end of pages other than the last page".
# Control-Z, 1Ah -- "print command at the end of the last page" (feeds+cuts).
CMD_PRINT_NO_FEED = b"\x0c"
CMD_PRINT_WITH_FEED = b"\x1a"

# ESC i z valid-flag bits [RCR p.32].
PI_KIND = 0x02
PI_WIDTH = 0x04
PI_LENGTH = 0x08
PI_QUALITY = 0x40  # documented as "(Not used)"
PI_RECOVER = 0x80

# ESC i M bits [RCR p.33]: bit6 auto cut, bit7 mirror printing.
MODE_AUTO_CUT = 0x40
MODE_MIRROR = 0x80

# ESC i K bits [RCR p.33].  Note bit 3 is *inverted* naming: setting it means
# "No chain printing", i.e. feed and cut after the last label.  Clearing it
# gives chain printing, where several labels share one feed.
ADV_HALF_CUT = 0x04  # "Not used in PT-P710BT"
ADV_NO_CHAIN = 0x08
ADV_SPECIAL_TAPE_NO_CUT = 0x10
ADV_HIGH_RESOLUTION = 0x40  # 180x360 dpi; would need double-length raster data
ADV_NO_BUFFER_CLEAR = 0x80

# ESC i A ("cut each * labels") is deliberately absent: [RCR p.22 and p.34]
# "The PT-P710BT does not support this command."

_STATUS_LENGTH = 32  # "The size is fixed at 32 bytes." [RCR p.23]
_STATUS_HEAD_MARK = 0x80  # offset 0, "Print head mark: Fixed at 80h"
_STATUS_SIZE_MARK = 0x20  # offset 1, "Size: Fixed at 20h"

# Status type values [RCR p.28, table (5)].
ST_REPLY_TO_REQUEST = 0x00
ST_PRINTING_COMPLETED = 0x01
ST_ERROR_OCCURRED = 0x02
ST_TURNED_OFF = 0x04
ST_NOTIFICATION = 0x05
ST_PHASE_CHANGE = 0x06

# Error information 1, offset 8 [RCR p.26, table (1)].
_ERROR_1_BITS = (
    (0x01, "no tape"),
    (0x04, "cutter jam"),
    (0x08, "weak batteries"),
    (0x40, "high-voltage adapter"),
)

# Error information 2, offset 9 [RCR p.26, table (2)].
_ERROR_2_BITS = (
    (0x01, "wrong media width (loaded tape does not match the print information)"),
    (0x10, "cover open"),
    (0x20, "overheating"),
)

# Media type, offset 11 [RCR p.27, table (4)].
_MEDIA_TYPES = {
    0x00: None,  # no media
    0x01: "laminated tape",
    0x03: "non-laminated tape",
    0x11: "heat-shrink tube (HS 2:1)",
    0x17: "heat-shrink tube (HS 3:1)",
    0xFF: "incompatible tape",
}

# How long to wait for the "printing completed" status after the print command.
# Printing 1000 mm of tape is slow, and we may not send anything meanwhile, so
# this deliberately ignores the shorter per-transfer timeout.
_PRINT_COMPLETION_TIMEOUT_S = 60.0

# Bulk OUT is 64 bytes/packet [RCR p.46].  We hand libusb larger chunks and let
# it packetise, but not the whole job at once: with concurrent printing the
# printer stalls the endpoint while its buffer is full, and a single giant
# transfer would hit the timeout instead of simply blocking per chunk.
_WRITE_CHUNK_BYTES = 4096

# Where Homebrew puts libusb on Apple Silicon and on Intel macs.  ctypes'
# find_library() often misses these under the SIP-protected system python,
# so we fall back to explicit paths rather than failing to find a backend.
_LIBUSB_FALLBACK_PATHS = (
    "/opt/homebrew/lib/libusb-1.0.dylib",
    "/usr/local/lib/libusb-1.0.dylib",
    "/opt/homebrew/lib/libusb-1.0.0.dylib",
)


class PrinterError(Exception):
    """Any failure talking to, or reported by, the label printer."""


class PrinterNotFound(PrinterError):
    """No PT-P710BT is attached, or libusb cannot see it."""


class PrinterStalled(PrinterError):
    """A stalled endpoint was detected and reset. The operation should be retried."""


class PrinterBusy(PrinterError):
    """The device is attached but another process holds the interface."""


@dataclass(frozen=True)
class PrinterStatus:
    """Decoded 32-byte status reply [RCR pp.24-30]."""

    media_width_mm: int | None
    media_type: str | None
    error: str | None
    raw: bytes

    @property
    def status_type(self) -> int:
        return self.raw[18]

    @property
    def ok(self) -> bool:
        """True when tape is loaded and no error bit is set."""
        return self.error is None and self.media_width_mm is not None

    @property
    def geometry(self) -> TapeGeometry | None:
        """Pin layout for the loaded tape, or None if unknown/absent."""
        if self.media_width_mm is None:
            return None
        return TAPE_GEOMETRY.get(self.media_width_mm)


def _decode_status(raw: bytes) -> PrinterStatus:
    """Turn 32 raw bytes into a PrinterStatus, or raise if they are not one."""
    if len(raw) != _STATUS_LENGTH:
        raise PrinterError(
            "status reply was %d bytes, expected %d: %s"
            % (len(raw), _STATUS_LENGTH, raw.hex())
        )
    if raw[0] != _STATUS_HEAD_MARK or raw[1] != _STATUS_SIZE_MARK:
        # Out-of-sync stream is far more likely than a firmware bug here, so
        # say what we actually got instead of pretending we parsed it.
        raise PrinterError(
            "not a Brother status frame (expected 80h 20h, got %02Xh %02Xh): %s"
            % (raw[0], raw[1], raw.hex())
        )

    reasons = [name for mask, name in _ERROR_1_BITS if raw[8] & mask]
    reasons += [name for mask, name in _ERROR_2_BITS if raw[9] & mask]

    width_byte = raw[10]  # offset 10, "Media width" in mm [RCR p.27, table (3)]
    media_width_mm = width_byte if width_byte else None

    type_byte = raw[11]
    if type_byte in _MEDIA_TYPES:
        media_type = _MEDIA_TYPES[type_byte]
    else:
        media_type = "unknown media type (%02Xh)" % type_byte

    if type_byte == 0xFF:
        reasons.append("incompatible tape cassette")
    if media_width_mm is None and "no tape" not in reasons:
        reasons.append("no tape")
    elif media_width_mm is not None and media_width_mm not in TAPE_GEOMETRY:
        reasons.append("unsupported tape width (%d mm)" % media_width_mm)

    return PrinterStatus(
        media_width_mm=media_width_mm,
        media_type=media_type,
        error="; ".join(reasons) if reasons else None,
        raw=bytes(raw),
    )


def _backend():
    """Return a libusb1 backend, falling back to explicit Homebrew paths."""
    backend = usb.backend.libusb1.get_backend()
    if backend is not None:
        return backend
    for path in _LIBUSB_FALLBACK_PATHS:
        backend = usb.backend.libusb1.get_backend(find_library=lambda _p=path: _p)
        if backend is not None:
            return backend
    raise PrinterNotFound(
        "libusb backend not available; install it with `brew install libusb` "
        "(expected at %s)" % _LIBUSB_FALLBACK_PATHS[0]
    )


def _find_device():
    """Locate the PT-P710BT, or return None. Never claims anything."""
    return usb.core.find(idVendor=VENDOR_ID, idProduct=PRODUCT_ID, backend=_backend())


def find_printer() -> bool:
    """True if a PT-P710BT is present on USB."""
    try:
        return _find_device() is not None
    except PrinterNotFound:
        raise
    except usb.core.USBError:
        # Enumeration itself failed (permissions, backend hiccup).  Not finding
        # a printer and not being able to look are different things, but the
        # caller only asked "can I print?", and the answer is no either way.
        return False


def _build_print_information(
    *,
    raster_lines: int,
    media_type_byte: int,
    media_width_mm: int,
    first_page: bool,
) -> bytes:
    """ESC i z {n1..n10} -- print information command [RCR p.32].

    n1 mirrors what Brother's own driver emits in the manual's worked example
    (1Bh 69h 7Ah 84h ... = PI_RECOVER | PI_WIDTH): the width is declared so the
    printer itself refuses the job when the wrong cassette is loaded, and sets
    bit 0 of "Error information 2".  PI_KIND is left off because n2 is taken
    from the printer's own status reply, so validating it against itself would
    prove nothing.
    """
    valid_flags = PI_RECOVER | PI_WIDTH
    return b"\x1b\x69\x7a" + bytes(
        (
            valid_flags,  # n1
            media_type_byte,  # n2
            media_width_mm,  # n3, media width in mm
            0x00,  # n4, media length -- "normally 00h, regardless of the paper length"
        )
    ) + struct.pack("<I", raster_lines) + bytes(  # n5..n8, raster number
        (
            0x00 if first_page else 0x01,  # n9, starting page 0 / other pages 1
            0x00,  # n10, "Fixed at 0"
        )
    )


def _build_margin(dots: int) -> bytes:
    """ESC i d {n1}{n2} -- margin (feed) amount = n1 + n2*256 [RCR p.34]."""
    if not MIN_MARGIN_DOTS <= dots <= MAX_MARGIN_DOTS:
        raise ValueError(
            "margin must be %d-%d dots at 180 dpi, got %d"
            % (MIN_MARGIN_DOTS, MAX_MARGIN_DOTS, dots)
        )
    return b"\x1b\x69\x64" + struct.pack("<H", dots)


def _build_raster_payload(lines) -> bytes:
    """Concatenate G transfers for every line.  No Z shortcut -- see module docstring."""
    return b"".join(_RASTER_TRANSFER_HEADER + bytes(line) for line in lines)


class BrotherPTouch:
    """A single USB session with the PT-P710BT.

    One device, one interface, no reconnect logic: if something goes wrong the
    session is closed and the caller decides what to do.  Prefer the context
    manager so the interface is always released -- a leaked claim leaves the
    printer unusable to every other process until the process exits.
    """

    def __init__(self, timeout_ms: int = 10000) -> None:
        self._timeout_ms = int(timeout_ms)
        self._device = None
        self._interface = None
        self._ep_in = None
        self._ep_out = None
        self._detached_kernel_driver = False
        self._in_buffer = b""
        # Job bookkeeping: the initialisation commands are "specified only once
        # at the beginning of the job" [RCR p.5], while control codes repeat per
        # page.  A chain-printed page leaves the job open so the next page joins
        # the same tape feed.
        self._job_open = False
        self._page_index = 0
        # Filled from the printer's own status reply at job start, so the print
        # information command always declares the tape that is really loaded.
        self._media_type_byte = 0x00
        self._media_width_mm = DEFAULT_TAPE_WIDTH_MM

    # -- lifecycle ---------------------------------------------------------

    def __enter__(self) -> "BrotherPTouch":
        self.open()
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def open(self) -> None:
        if self._device is not None:
            return

        device = _find_device()
        if device is None:
            raise PrinterNotFound(
                "no Brother PT-P710BT on USB (looked for %04x:%04x)"
                % (VENDOR_ID, PRODUCT_ID)
            )

        # macOS binds its own USB printing-class driver to this device.  libusb
        # cannot detach it on Darwin -- the call raises NotImplementedError
        # rather than failing -- so treat it as best-effort and let the claim
        # below produce the real, actionable error.
        try:
            if device.is_kernel_driver_active(0):
                device.detach_kernel_driver(0)
                self._detached_kernel_driver = True
        except (NotImplementedError, usb.core.USBError):
            pass

        try:
            config = device.get_active_configuration()
        except usb.core.USBError:
            # Only reconfigure if the device is not already configured; calling
            # set_configuration unconditionally resets a device another process
            # may be mid-conversation with.
            try:
                device.set_configuration()
                config = device.get_active_configuration()
            except usb.core.USBError as exc:
                raise PrinterBusy("cannot configure the printer: %s" % exc) from exc

        interface = self._select_interface(config)
        ep_out, ep_in = self._select_endpoints(interface)

        try:
            usb.util.claim_interface(device, interface)
        except usb.core.USBError as exc:
            raise PrinterBusy(
                "the PT-P710BT is attached but busy (%s). Something else holds "
                "it -- typically a macOS/CUPS print queue or the P-touch Editor. "
                "Pause the queue in System Settings > Printers & Scanners, or "
                "quit the other application, then retry." % exc
            ) from exc

        self._device = device
        self._interface = interface
        self._ep_out = ep_out
        self._ep_in = ep_in
        self._in_buffer = b""
        self._job_open = False
        self._page_index = 0

    @staticmethod
    def _select_interface(config):
        """Prefer the printer-class interface; fall back to the only one there is.

        Endpoint addresses are never hardcoded: the manual names "End point 1"
        and "End point 2" but not their bEndpointAddress values, and those are
        firmware's business, not ours.
        """
        printer_class = 7  # USB printer device class
        interfaces = list(config)
        for interface in interfaces:
            if interface.bInterfaceClass == printer_class:
                return interface
        if interfaces:
            return interfaces[0]
        raise PrinterError("printer exposes no USB interfaces")

    @staticmethod
    def _select_endpoints(interface):
        """Find the bulk OUT and bulk IN endpoints by descriptor."""

        def matches(direction):
            def predicate(endpoint):
                return (
                    usb.util.endpoint_direction(endpoint.bEndpointAddress) == direction
                    and usb.util.endpoint_type(endpoint.bmAttributes)
                    == usb.util.ENDPOINT_TYPE_BULK
                )

            return predicate

        ep_out = usb.util.find_descriptor(
            interface, custom_match=matches(usb.util.ENDPOINT_OUT)
        )
        ep_in = usb.util.find_descriptor(
            interface, custom_match=matches(usb.util.ENDPOINT_IN)
        )
        if ep_out is None or ep_in is None:
            raise PrinterError(
                "printer interface %d has no bulk IN/OUT endpoint pair"
                % interface.bInterfaceNumber
            )
        return ep_out, ep_in

    def close(self) -> None:
        device, interface = self._device, self._interface
        self._device = self._interface = self._ep_in = self._ep_out = None
        self._in_buffer = b""
        self._job_open = False
        self._page_index = 0
        if device is None:
            return
        try:
            if interface is not None:
                usb.util.release_interface(device, interface)
            if self._detached_kernel_driver:
                device.attach_kernel_driver(0)
        except (NotImplementedError, usb.core.USBError):
            pass
        finally:
            self._detached_kernel_driver = False
            try:
                usb.util.dispose_resources(device)
            except usb.core.USBError:
                pass

    def _require_open(self):
        if self._device is None:
            raise PrinterError("printer session is not open; call open() first")
        return self._device

    # -- raw transport -----------------------------------------------------

    def _write(self, data: bytes) -> None:
        self._require_open()
        try:
            for offset in range(0, len(data), _WRITE_CHUNK_BYTES):
                chunk = data[offset : offset + _WRITE_CHUNK_BYTES]
                written = self._ep_out.write(chunk, self._timeout_ms)
                if written != len(chunk):
                    raise PrinterError(
                        "short write to printer: %d of %d bytes"
                        % (written, len(chunk))
                    )
        except usb.core.USBError as exc:
            raise PrinterError("USB write failed: %s" % exc) from exc

    def _read_raw(self, timeout_ms: int) -> bytes:
        """One bulk IN read. Returns b"" on timeout rather than raising."""
        try:
            data = self._ep_in.read(self._ep_in.wMaxPacketSize, timeout_ms)
        except usb.core.USBError as exc:
            # errno 110 / "Operation timed out" is the normal idle case; libusb
            # on macOS reports it inconsistently, so match on both.
            if exc.errno == 110 or "timeout" in str(exc).lower():
                return b""
            # errno 32 (EPIPE) is a STALLED endpoint. It survives closing and
            # reopening the handle and even restarting the process -- the halt
            # lives on the device -- so without recovery here a single
            # interrupted transfer bricks printing until someone unplugs the
            # printer. Observed in the field after a process was killed
            # mid-transfer. clear_halt is the documented fix but returns
            # "Entity not found" on macOS, so fall through to a device reset,
            # which does work. One attempt only: if the reset does not take,
            # the caller needs to see the real error rather than a hang.
            if exc.errno == 32 or "pipe" in str(exc).lower():
                if self._recover_stall():
                    raise PrinterStalled(
                        "USB endpoint had stalled; the device was reset. Retry the operation."
                    ) from exc
            raise PrinterError("USB read failed: %s" % exc) from exc
        return bytes(bytearray(data))

    def _recover_stall(self) -> bool:
        """Clear a stalled endpoint. Returns True if the device was reset."""

        for endpoint in (self._ep_out, self._ep_in):
            if endpoint is None:
                continue
            try:
                self._device.clear_halt(endpoint.bEndpointAddress)
            except Exception:  # noqa: BLE001 - macOS reports ENOENT here; reset is the real fix
                pass
        try:
            self._device.reset()
        except Exception:  # noqa: BLE001
            return False
        # The handle is invalid after a reset; drop it so the next call re-opens.
        self._invalidate_after_reset()
        return True

    def _invalidate_after_reset(self) -> None:
        try:
            usb.util.dispose_resources(self._device)
        except Exception:  # noqa: BLE001
            pass
        self._device = None
        self._ep_in = None
        self._ep_out = None

    def _read_status_frame(self, timeout_ms: int) -> PrinterStatus | None:
        """Read one 32-byte status frame, or None if nothing arrived in time.

        Frames are buffered because automatic status notification can deliver
        several back to back inside one 64-byte packet.
        """
        deadline = time.monotonic() + timeout_ms / 1000.0
        while len(self._in_buffer) < _STATUS_LENGTH:
            remaining_ms = int((deadline - time.monotonic()) * 1000)
            if remaining_ms <= 0:
                return None
            chunk = self._read_raw(min(remaining_ms, self._timeout_ms))
            if not chunk:
                continue
            self._in_buffer += chunk
        frame, self._in_buffer = (
            self._in_buffer[:_STATUS_LENGTH],
            self._in_buffer[_STATUS_LENGTH:],
        )
        return _decode_status(frame)

    def _drain_input(self) -> None:
        """Discard stale notifications so they are not mistaken for a reply."""
        self._in_buffer = b""
        while self._read_raw(50):
            pass

    # -- public operations -------------------------------------------------

    def status(self) -> PrinterStatus:
        """Send a status request and parse the 32-byte reply.

        Follows the documented opening sequence [RCR section 5.1]: invalidate,
        initialize, then ESC i S.  Never call this between sending print data
        and confirming completion -- see the module docstring.
        """
        self._require_open()
        # The invalidate below resets the printer, which cancels any chain-print
        # job left open by a previous page.  Drop the flag rather than let the
        # next page believe it is continuing a feed that no longer exists.
        self._job_open = False
        self._drain_input()
        self._write(CMD_INVALIDATE + CMD_INITIALIZE + CMD_STATUS_REQUEST)
        status = self._read_status_frame(self._timeout_ms)
        if status is None:
            raise PrinterError(
                "printer did not answer the status request within %d ms"
                % self._timeout_ms
            )
        return status

    def print_raster(self, lines: list[bytes], *, chain: bool = False) -> None:
        """Print one page of raster data.

        `lines` is a list of 16-byte scan lines (128 bits, MSB first).  Sends
        init, mode, raster data and the print command.  `chain=True` uses the
        chain-print terminator so several labels share one tape feed.

        The caller owns the bit layout: bit 0 of each line is the first
        right-margin pin, and only `TAPE_GEOMETRY[width].print_pins` bits
        starting at `print_offset_bits` reach the tape.  For 12 mm that is 70
        bits starting at bit 29.
        """
        self._validate_lines(lines)
        self._require_open()

        first_page = not self._job_open
        if first_page:
            # "Specified only once at the beginning of the job" [RCR p.5].
            self._drain_input()
            self._write(CMD_INVALIDATE + CMD_INITIALIZE)
            # Gate on real hardware state before committing tape.  Only done at
            # job start: mid-chain the printer is busy and must not be asked.
            status = self._check_ready()
            self._media_type_byte = status.raw[11]
            self._media_width_mm = status.media_width_mm
            self._page_index = 0

        stream = self._build_page(
            lines,
            chain=chain,
            first_page=self._page_index == 0,
        )

        # From here until completion, not one byte may go the other way.
        self._write(stream)
        self._job_open = chain
        self._page_index += 1
        self._await_completion()

    @staticmethod
    def _validate_lines(lines) -> None:
        if not isinstance(lines, (list, tuple)):
            raise ValueError(
                "lines must be a list of %d-byte scan lines, got %s"
                % (BYTES_PER_LINE, type(lines).__name__)
            )
        if not lines:
            raise ValueError("lines is empty; there is nothing to print")
        for index, line in enumerate(lines):
            if not isinstance(line, (bytes, bytearray)):
                raise ValueError(
                    "line %d is %s, expected bytes of length %d"
                    % (index, type(line).__name__, BYTES_PER_LINE)
                )
            if len(line) != BYTES_PER_LINE:
                raise ValueError(
                    "line %d is %d bytes, expected exactly %d "
                    "(a raster line is always 128 pins wide, whatever the tape width)"
                    % (index, len(line), BYTES_PER_LINE)
                )
        if len(lines) > MAX_RASTER_LINES:
            raise ValueError(
                "%d raster lines exceeds the %d-line (1000 mm) maximum at 180 dpi"
                % (len(lines), MAX_RASTER_LINES)
            )

    def _check_ready(self) -> PrinterStatus:
        """Ask for status and refuse to print unless the printer is happy."""
        self._write(CMD_STATUS_REQUEST)
        status = self._read_status_frame(self._timeout_ms)
        if status is None:
            raise PrinterError(
                "printer did not answer the pre-print status request within %d ms"
                % self._timeout_ms
            )
        if status.error is not None:
            raise PrinterError("printer not ready: %s" % status.error)
        if status.geometry is None:
            raise PrinterError(
                "printer reports an unusable tape (width=%r, type=%r)"
                % (status.media_width_mm, status.media_type)
            )
        return status

    def _build_page(self, lines, *, chain: bool, first_page: bool) -> bytes:
        """Control codes + raster data + terminator for one page [RCR p.5-7]."""
        # bit 3 set == "No chain printing" == feed and cut after the last label.
        advanced = 0x00 if chain else ADV_NO_CHAIN
        return b"".join(
            (
                CMD_RASTER_MODE,
                CMD_NOTIFY_ON,
                _build_print_information(
                    raster_lines=len(lines),
                    media_type_byte=self._media_type_byte,
                    media_width_mm=self._media_width_mm,
                    first_page=first_page,
                ),
                bytes((0x1B, 0x69, 0x4D, MODE_AUTO_CUT)),  # ESC i M, auto cut on
                bytes((0x1B, 0x69, 0x4B, advanced)),  # ESC i K
                _build_margin(DEFAULT_MARGIN_DOTS),
                CMD_COMPRESSION_NONE,
                _build_raster_payload(lines),
                CMD_PRINT_NO_FEED if chain else CMD_PRINT_WITH_FEED,
            )
        )

    def _await_completion(self) -> None:
        """Read status frames until printing finishes, an error arrives, or we give up.

        Phase-change frames stream in throughout printing and are ignored; the
        job is done at status type 01h ("Printing completed") [RCR p.28].
        """
        deadline = time.monotonic() + _PRINT_COMPLETION_TIMEOUT_S
        while time.monotonic() < deadline:
            remaining_ms = int((deadline - time.monotonic()) * 1000)
            status = self._read_status_frame(min(remaining_ms, self._timeout_ms))
            if status is None:
                continue
            if status.status_type == ST_ERROR_OCCURRED or status.error is not None:
                self._job_open = False
                raise PrinterError(
                    "printing failed: %s" % (status.error or "unspecified printer error")
                )
            if status.status_type == ST_TURNED_OFF:
                self._job_open = False
                raise PrinterError("printer turned off during printing")
            if status.status_type == ST_PRINTING_COMPLETED:
                return
        self._job_open = False
        raise PrinterError(
            "printer did not report completion within %.0f s"
            % _PRINT_COMPLETION_TIMEOUT_S
        )


if __name__ == "__main__":
    # Read-only smoke test.  It must never print a label: no raster data and no
    # print command are sent anywhere in this block.
    print("find_printer(): %s" % find_printer())
    if find_printer():
        try:
            with BrotherPTouch() as printer:
                print("status(): %r" % (printer.status(),))
        except PrinterError as error:
            print("status() failed: %s" % error)
