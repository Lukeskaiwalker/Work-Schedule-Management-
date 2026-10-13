"""Which EZPL lines the calibration code may send — an allow-list.

The calibration sends commands that change printer state (sensor, label
size) and one that feeds paper (``~S,SENSOR``). Everything else in EZPL that
could print a self-test page (``~V``), reset to factory defaults (``^Z``),
rotate the output (``~R``), shift every print (``~Q``), wipe the buffer or
switch the printer's reply behaviour for every client (``^XSET,IMMEDIATE``)
must be impossible to reach from here, whatever a profile or a user typed.
So every line of a calibration send must fully match one pattern below; a
miss is a programming error (HTTP 500), never a user error — user text is
mapped into the AT character class before it gets here.

Normal print jobs do not pass through this check (they carry ``~EB``,
``XRB``, ``Y`` …); their header is pinned by golden tests instead.
"""

from __future__ import annotations

import re

from app.services.werkstatt_label_errors import DisallowedPrinterCommand

ALLOWED_LINE_PATTERNS: tuple[str, ...] = (
    r"\^G[012]",
    r"\^XSET,SENSING,[012]",
    r"\^Q\d{1,3},\d{1,2}",
    r"\^Q\d{1,3},\d{1,2},\d{1,2}[+-]",
    r"\^W\d{1,2}",
    r"\^H\d{1,2}",
    r"\^S[2-4]",
    r"\^E\d{1,2}",
    r"\^C\d{1,2}",
    r"\^P1",
    r"\^L",
    r"E",
    r"Lo,\d{1,4},\d{1,4},\d{1,4},\d{1,4}",
    r"AT,\d{1,4},\d{1,4},\d{1,3},\d{1,3},0,1E,0,0,[\x20-\x5D\x5F-\x7D]{1,40}",
    r"~S,SENSOR",
)
# ASCII: ``\d`` must not accept other scripts' digits.
_ALLOWED = tuple(re.compile(pattern, re.ASCII) for pattern in ALLOWED_LINE_PATTERNS)

# No builder may ever emit a line starting with one of these (pinned by a
# test over every builder). ``^XSET,`` other than ``^XSET,SENSING,`` is
# checked separately.
NEVER_SEND_PREFIXES: tuple[str, ...] = (
    "~V", "~T", "~X", "~Z", "^Z", "~R", "^R", "~Q", "~S,DUMP", "~S,FEED",
    "~S,CANCEL", "~S,BUFCLR", "~S,PAUSE", "~M", "^M", "^B", "^A", "^N", "~EB",
    "^XSET,IMMEDIATE",
)


def is_allowed(line: str) -> bool:
    return any(pattern.fullmatch(line) for pattern in _ALLOWED)


def assert_allowed(lines: list[str]) -> None:
    """Raise ``DisallowedPrinterCommand`` unless EVERY line is allowed."""
    for line in lines:
        if not is_allowed(line):
            raise DisallowedPrinterCommand(f"EZPL line not allowed for calibration: {line!r}")
