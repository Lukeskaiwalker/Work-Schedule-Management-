"""The Verteiler number: ``VT-0007``.

A board gets its number the moment it is planned and keeps it for life —
it is what the DataMatrix on the Schrank-Etikett holds and what the Regal
station scans to open the board's Materialliste. The number IS the row id,
zero padded: unique by construction, minted in the same transaction as the
row, safe across the two production workers without a lock, and never
handed out twice (PostgreSQL never reuses a sequence value, so a deleted
board's number stays a gap). Gaps are fine — it is an internal id, not a
count. The migration that introduced the column numbered the existing
boards the same way, so "board 7" and "VT-0007" are one thing.

The prefix is ``VT`` (Verteiler — the word the UI uses), which no other code
family starts with: ``M-`` machines, ``SP-`` articles, ``SMPL-`` shelf codes,
``KISTE-`` crates, ``BK-``/``BST-``/``VRL-`` box and order numbers. The
scanner reads ``V`` and ``T`` the same on a German and a US layout, so the
Y/Z ambiguity the shelf codes carry does not apply here.
"""

from __future__ import annotations

import re
import secrets

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.schaltplan import PanelPlan

PANEL_PREFIX = "VT-"
PANEL_PATTERN = re.compile(r"^VT-(\d+)$")
_PAD_WIDTH = 4
_LOOSE_PATTERN = re.compile(r"^VT-?0*(\d+)$")


def format_panel_number(value: int) -> str:
    return f"{PANEL_PREFIX}{value:0{_PAD_WIDTH}d}"


def provisional_panel_number() -> str:
    """A placeholder that satisfies NOT NULL + UNIQUE until the row has an id.

    Never reaches a reader: ``assign_panel_number`` replaces it inside the
    same transaction, and a failed transaction rolls both away.
    """
    return f"~{secrets.token_hex(6)}"


def assign_panel_number(db: Session, plan: PanelPlan) -> str:
    """Flush the new row so it has an id, then write its number from that id."""
    if plan.panel_number is None:
        plan.panel_number = provisional_panel_number()
    db.add(plan)
    db.flush()
    plan.panel_number = format_panel_number(int(plan.id))
    db.flush()
    return plan.panel_number


def normalize_panel_code(raw: str) -> str:
    """``" vt-7 "`` and ``"VT0007"`` both mean ``VT-0007``; anything else is
    returned stripped and upper-cased so a lookup simply misses."""
    cleaned = (raw or "").strip().upper()
    match = _LOOSE_PATTERN.match(cleaned)
    if not match:
        return cleaned
    return format_panel_number(int(match.group(1)))


def is_panel_code(raw: str) -> bool:
    return bool(_LOOSE_PATTERN.match((raw or "").strip().upper()))


def find_panel_by_code(db: Session, raw: str) -> PanelPlan | None:
    code = normalize_panel_code(raw)
    if not PANEL_PATTERN.match(code):
        return None
    return db.scalars(select(PanelPlan).where(PanelPlan.panel_number == code)).first()
