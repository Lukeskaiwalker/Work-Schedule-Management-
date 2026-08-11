"""Generate unique machine numbers like "M-0001".

Mirrors `werkstatt_article_numbers` deliberately: same scan-max-and-increment
approach, same module-level lock, same reliance on the UNIQUE constraint as the
real backstop. Two allocators that behave differently would be a trap for
whoever maintains them next.

The number matters more here than for articles. It is printed on the label stuck
to the machine and is the only thing the scanner reads, so it has to be unique
workshop-wide and stable for the life of the machine — never reused, even after
a machine is retired, or an old label would resolve to somebody else's drill.
"""

from __future__ import annotations

import re
import threading

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import WerkstattArticleUnit

UNIT_PREFIX = "M-"
UNIT_PATTERN = re.compile(r"^M-(\d+)$")
_UNIT_PAD_WIDTH = 4

_allocator_lock = threading.Lock()


def next_unit_number(db: Session) -> str:
    """Return the next free `M-XXXX` machine number.

    Scans ALL units including archived and retired ones. That is the point:
    numbers are never recycled, so a label found in a van three years from now
    can still be traced to the machine it was printed for.
    """
    with _allocator_lock:
        rows = db.scalars(
            select(WerkstattArticleUnit.unit_number).where(
                WerkstattArticleUnit.unit_number.like(f"{UNIT_PREFIX}%")
            )
        ).all()

        highest = 0
        for raw in rows:
            match = UNIT_PATTERN.match(str(raw or ""))
            if not match:
                continue
            value = int(match.group(1))
            if value > highest:
                highest = value

        return f"{UNIT_PREFIX}{highest + 1:0{_UNIT_PAD_WIDTH}d}"


def normalize_scanned_code(raw: str) -> str:
    """Canonicalise a scanned string before matching it against a unit number.

    Hardware scanners and hand-typed entries disagree about case and padding —
    "m-1", "M-0001" and " M-0001 " all mean the same machine to the person
    holding it, and refusing two of the three would be perceived as the scanner
    being broken.
    """
    cleaned = (raw or "").strip().upper()
    match = re.match(r"^M-?(\d+)$", cleaned)
    if not match:
        return cleaned
    return f"{UNIT_PREFIX}{int(match.group(1)):0{_UNIT_PAD_WIDTH}d}"
