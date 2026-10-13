"""One printer connection at a time, across every uvicorn worker.

The printer answers queries on the same port it prints from. A STATUS poll
racing a print job on a second socket would interleave with it in ways the
manual does not describe, and two jobs from two workers could interleave
their lines. An ``fcntl.flock`` on a file in the container's /tmp — shared by
all workers — serialises them; the lock is held around exactly one
connection, never across database work (see ``werkstatt_label_session``).
"""

from __future__ import annotations

import fcntl
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from app.services.werkstatt_label_errors import LabelPrinterIoBusy

IO_LOCK_TIMEOUT_S = 8.0
IO_LOCK_POLL_S = 0.05
# Read at call time, so tests can point it into their tmp_path.
LOCK_PATH = Path(tempfile.gettempdir()) / "smpl-werkstatt-label-printer.lock"

BUSY_MESSAGE = "Drucker ist gerade mit einem anderen Auftrag beschäftigt – bitte gleich erneut versuchen"


@contextmanager
def printer_io_lock(timeout_s: float | None = None) -> Iterator[None]:
    """Hold the printer for one connection; ``LabelPrinterIoBusy`` on timeout."""
    limit = IO_LOCK_TIMEOUT_S if timeout_s is None else timeout_s
    deadline = time.monotonic() + limit
    with open(LOCK_PATH, "a+") as handle:
        while True:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise LabelPrinterIoBusy(BUSY_MESSAGE) from None
                time.sleep(IO_LOCK_POLL_S)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
