"""A simulated WAGO 258-5101 (GoDEX EZPL over TCP 9100) for the calibration tests.

Nothing in the test suite talks to the real printer. This threaded TCP server
on 127.0.0.1 speaks just enough EZPL for the calibration code: it keeps the
setup values a real printer keeps (``^Q ^W ^G ^H ^S ^E ^C ^P``,
``^XSET,SENSING``), answers ``~S,STATUS`` and ``^XGET,CONFIG`` (the probe
reply of 13.10.2026 with the current values substituted), runs a scripted
auto-sense on ``~S,SENSOR`` and records every byte and every printed job.
Like the real printer it keeps a connection open after replying, so the
client must end a read on the reply's own terminator.

Unverified printer behaviour is a switch here, so a test can ask "what if":
``q_write_updates_qd`` (a ``^Q`` write echoes into ``^QD``),
``requires_immediate`` (STATUS only after ``^XSET,IMMEDIATE,1`` — SMPL never
sends it, so this proves the button fallback), ``sense_sensor_after``
(``~S,SENSOR`` replaces the sensor SMPL set), and so on.
"""

from __future__ import annotations

import re
import socket
import threading
import time
from pathlib import Path

FIXTURE = Path(__file__).parent / "fixtures" / "ezpl_config_258_5101.txt"

SEE_THROUGH_LINE = "See.:0.1 1.7 1.0 [1.6_58]"
REFLECTIVE_LINE = "Reflective Volt:2.4 3.1 3.9(1.4_1.1)"


class FakeEzplPrinter:
    """Threaded TCP server on 127.0.0.1:0 that speaks enough EZPL for the calibration code."""

    def __init__(self) -> None:
        self.host = "127.0.0.1"
        self._lock = threading.Lock()
        self._received: list[bytearray] = []
        self._active = 0
        self.max_concurrent = 0
        # printer state (initialised from the probe fixture)
        self.status_code = "00"
        self.pending = 0
        self.stored_q = "97,2"
        self.stored_w = "34"
        self.h, self.s, self.e = "12", "2", "0"
        self.row_offset = "-19"
        self.sensor = "see_through"
        self.sensing: str | None = None
        self.qd: tuple[int, int] | None = (1164, 30)
        self.copies = 1
        self.multiplier = 1  # ^P
        self.immediate = False
        # scripting
        self.sense_busy_polls = 2
        self.sense_result_qd: tuple[int, int] | None = (1164, 30)
        self.sense_rewrites_q = True
        self.sense_final_code = "00"
        self.sense_sensor_after: str | None = None
        self.silent: set[str] = set()
        self.requires_immediate = False
        self.q_write_updates_qd = False
        self.status_override: list[str] = []
        self.truncate_config = False
        self.split_reply = False
        self.push_error: str | None = None
        self.refuse = False
        self.reply_delay_s = 0.0  # before a STATUS reply and before a print job
        # records
        self.jobs_printed: list[list[str]] = []
        self.pieces_printed: list[int] = []
        self.sense_runs = 0
        self._busy_left = 0
        self._sense_running = False
        self._server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server.bind((self.host, 0))
        self._server.listen(16)
        self.port = self._server.getsockname()[1]
        self._stopped = False
        self._thread = threading.Thread(target=self._accept_loop, daemon=True)
        self._thread.start()

    # ── lifecycle ──────────────────────────────────────────────────────────

    def stop(self) -> None:
        self._stopped = True
        try:
            self._server.close()
        except OSError:
            pass

    def make_unreachable(self) -> None:
        """Close the listening socket: every connect is refused."""
        self.refuse = True
        self.stop()

    @property
    def received(self) -> list[bytes]:
        with self._lock:
            return [bytes(chunk) for chunk in self._received]

    def received_text(self) -> str:
        return b"".join(self.received).decode("latin-1")

    def received_lines(self) -> list[str]:
        return [line for line in self.received_text().replace("\r\n", "\n").split("\n") if line]

    # ── server ─────────────────────────────────────────────────────────────

    def _accept_loop(self) -> None:
        while not self._stopped:
            try:
                conn, _ = self._server.accept()
            except OSError:
                return
            with self._lock:
                record = bytearray()
                self._received.append(record)
                self._active += 1
                self.max_concurrent = max(self.max_concurrent, self._active)
            threading.Thread(target=self._serve, args=(conn, record), daemon=True).start()

    def _serve(self, conn: socket.socket, record: bytearray) -> None:
        buffer = b""
        state: dict = {"job": None}  # a ^L … E job is per connection
        try:
            conn.settimeout(10)
            while True:
                try:
                    chunk = conn.recv(65536)
                except OSError:
                    break
                if not chunk:
                    break
                with self._lock:
                    record.extend(chunk)
                buffer += chunk
                buffer = self._consume(conn, buffer, state)
        finally:
            with self._lock:
                self._active -= 1
            try:
                conn.close()
            except OSError:
                pass

    def _consume(self, conn: socket.socket, buffer: bytes, state: dict) -> bytes:
        """Handle every complete line; binary ``~EB`` downloads are skipped by length."""
        while b"\r\n" in buffer:
            line_bytes, rest = buffer.split(b"\r\n", 1)
            line = line_bytes.decode("latin-1")
            download = re.match(r"^~EB,[^,]+,(\d+)$", line)
            if download:
                size = int(download.group(1))
                if len(rest) < size + 2:
                    return buffer  # wait for the rest of the image
                buffer = rest[size + 2:]
                continue
            buffer = rest
            self._line(conn, line, state)
        return buffer

    def _send(self, conn: socket.socket, text: str) -> None:
        payload = text.encode("latin-1")
        if self.push_error:
            payload = f"{self.push_error}\r\n".encode() + payload
        try:
            if self.split_reply and len(payload) > 4:
                half = len(payload) // 2
                conn.sendall(payload[:half])
                time.sleep(0.05)
                conn.sendall(payload[half:])
            else:
                conn.sendall(payload)
        except OSError:
            pass

    # ── EZPL ───────────────────────────────────────────────────────────────

    def _line(self, conn: socket.socket, line: str, state: dict) -> None:
        job = state["job"]
        if job is not None:
            job.append(line)
            if line == "E":
                with self._lock:
                    self.jobs_printed.append(job)
                    self.pieces_printed.append(self.copies * self.multiplier)
                state["job"] = None
            return
        if line == "^L":
            if self.reply_delay_s:
                time.sleep(self.reply_delay_s)
            state["job"] = []
            return
        if line == "~S,STATUS":
            if "STATUS" in self.silent or (self.requires_immediate and not self.immediate):
                return
            if self.reply_delay_s:
                time.sleep(self.reply_delay_s)
            self._send(conn, f"{self._status_code()},{self.pending:05d}\r\n")
            return
        if line == "^XGET,CONFIG":
            if "CONFIG" not in self.silent:
                self._send(conn, self.config_text())
            return
        if line == "~S,SENSOR":
            self._start_sense()
            return
        self._setup(line)

    def _setup(self, line: str) -> None:
        if match := re.match(r"^\^Q(\d+),(\d+)(?:,(\d+)([+-]))?$", line):
            length, second, third, sign = match.groups()
            self.stored_q = f"{length},{second},{third}{sign}" if third else f"{length},{second}"
            if self.q_write_updates_qd:
                self.qd = (int(length) * 12, int(second) * 12)
        elif match := re.match(r"^\^W(\d+)$", line):
            self.stored_w = match.group(1)
        elif line in ("^G0", "^G1"):
            self.sensor = "reflective" if line == "^G0" else "see_through"
        elif match := re.match(r"^\^H(\d+)$", line):
            self.h = match.group(1)
        elif match := re.match(r"^\^S(\d+)$", line):
            self.s = match.group(1)
        elif match := re.match(r"^\^E(\d+)$", line):
            self.e = match.group(1)
        elif match := re.match(r"^\^C(\d+)$", line):
            self.copies = int(match.group(1))
        elif match := re.match(r"^\^P(\d+)$", line):
            self.multiplier = int(match.group(1))
        elif match := re.match(r"^\^XSET,SENSING,(\d)$", line):
            self.sensing = match.group(1)
        elif line == "^XSET,IMMEDIATE,1":
            self.immediate = True

    def press_calibration_button(self) -> None:
        """The operator holds the button on the back: the sense runs at once."""
        with self._lock:
            self.sense_runs += 1
            self._finish_sense()

    def _start_sense(self) -> None:
        self.sense_runs += 1
        self._sense_running = True
        self._busy_left = self.sense_busy_polls
        if self._busy_left <= 0:
            self._finish_sense()

    def _finish_sense(self) -> None:
        self._sense_running = False
        self.qd = self.sense_result_qd
        if self.sense_rewrites_q and self.qd is not None:
            self.stored_q = f"{self.qd[0] // 12},{self.qd[1] // 12}"
        if self.sense_sensor_after:
            self.sensor = self.sense_sensor_after
        self.status_code = self.sense_final_code

    def _status_code(self) -> str:
        if self.status_override:
            return self.status_override.pop(0)
        if self._sense_running:
            if self._busy_left > 0:
                self._busy_left -= 1
                return "60"
            self._finish_sense()
        return self.status_code

    def config_text(self) -> str:
        lines = FIXTURE.read_text(encoding="latin-1").replace("\r\n", "\n").split("\n")
        out: list[str] = []
        for line in lines:
            if line.startswith("^S") and "~Q" in line:
                line = f"^S{self.s} ^H{self.h} ^R000 ~R255 ~Q{self.row_offset}"
            elif line.startswith("^W"):
                line = f"^W{self.stored_w} ^Q{self.stored_q} ^E{self.e}"
            elif line.startswith("See.") or line.startswith("Reflective"):
                line = SEE_THROUGH_LINE if self.sensor == "see_through" else REFLECTIVE_LINE
            elif line.startswith("^QD"):
                if self.qd is None:
                    continue
                line = f"^QD{self.qd[0]},{self.qd[1]}  ^Q{self.qd[0] / 12:.1f},{self.qd[1] / 12:.1f}"
            elif line.startswith("Label+Gap"):
                if self.qd is None:
                    continue
                line = f"Label+Gap = {self.qd[0] + self.qd[1]} Dots"
            elif self.truncate_config and line in ("--------", "---"):
                continue
            out.append(line)
        while out and out[-1] == "":
            out.pop()
        return "\r\n".join(out) + "\r\n"

    def raw_job(self, lines: list[str]) -> None:
        """Send a job as another client (WAGO software) would — for ^C/^P tests."""
        printed = len(self.jobs_printed)
        with socket.create_connection((self.host, self.port), timeout=5) as conn:
            conn.sendall(("\r\n".join(lines) + "\r\n").encode("latin-1"))
        self.wait_for_jobs(printed + 1)

    def wait_for_jobs(self, count: int, timeout: float = 3.0) -> None:
        """Until ``count`` jobs were printed (sends are fire-and-forget)."""
        self._wait(lambda: len(self.jobs_printed) >= count, timeout)

    def wait_for_connections(self, count: int, timeout: float = 3.0) -> None:
        """Until ``count`` connections were accepted and every one is handled."""
        self._wait(lambda: len(self._received) >= count and self._active == 0, timeout)

    def wait_idle(self, timeout: float = 3.0) -> None:
        """Until no connection is open (only meaningful once all were accepted)."""
        self._wait(lambda: self._active == 0, timeout)

    def _wait(self, condition, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._lock:
                if condition():
                    return
            time.sleep(0.01)
        raise AssertionError("fake printer: condition not reached in time")


def configure_fake(client, admin_token: str, fake: FakeEzplPrinter) -> dict:
    """Point the runtime printer address at the fake."""
    response = client.patch(
        "/api/admin/settings/label-printer",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={"host": fake.host, "port": fake.port},
    )
    assert response.status_code == 200, response.text
    return response.json()
