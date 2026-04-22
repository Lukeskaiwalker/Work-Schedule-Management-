"""Generate unique Werkstatt article numbers like "SP-0001".

The sequence is derived from the highest existing `article_number` on
`werkstatt_articles` that matches the `SP-\\d+` pattern. A module-level lock
serialises concurrent allocations within a single process so two callers in
the same worker can't pick the same number between SELECT and INSERT.

The caller is still responsible for the surrounding DB transaction — this
service only computes the next string. The UNIQUE constraint on
`article_number` is the true correctness backstop.
"""

from __future__ import annotations

import re
import threading

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import WerkstattArticle

SP_PREFIX = "SP-"
SP_PATTERN = re.compile(r"^SP-(\d+)$")
_SP_PAD_WIDTH = 4

_allocator_lock = threading.Lock()


def next_article_number(db: Session) -> str:
    """Return the next free `SP-XXXX` article number.

    Scans the existing `werkstatt_articles.article_number` column for rows
    matching the `SP-\\d+` pattern, parses the integer suffix, and returns
    `max + 1` zero-padded to 4 digits (grows beyond 4 naturally).
    """
    with _allocator_lock:
        rows = db.scalars(
            select(WerkstattArticle.article_number).where(
                WerkstattArticle.article_number.like("SP-%")
            )
        ).all()
        highest = 0
        for raw in rows:
            match = SP_PATTERN.match(str(raw or ""))
            if not match:
                continue
            try:
                value = int(match.group(1))
            except ValueError:
                continue
            if value > highest:
                highest = value
        next_value = highest + 1
        return f"{SP_PREFIX}{next_value:0{_SP_PAD_WIDTH}d}"
