"""Construction box (Baustellenkiste) lifecycle + stock semantics.

Two responsibilities live here so the routers stay thin:

1. **The status FSM.** ``offen → gepackt → zugewiesen → zurueck`` with a couple
   of reverse edges, mirroring the shape of ``werkstatt_orders.transition_order``.

2. **Stock movements.** Packing deliberately does NOT touch stock — a
   half-packed box is a picking list, and writing to the append-only ledger on
   every add/remove/qty-edit would be pure churn. Stock moves exactly twice:

     * on ASSIGNMENT   → ``checkout`` per stocked line (article-backed only)
     * on RETURN       → ``return``   per stocked line

   Catalog- and manual-sourced lines never move stock: the workshop does not
   hold them, so there is nothing to decrement.
"""
from __future__ import annotations

import threading
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import (
    WerkstattArticle,
    WerkstattConstructionBox,
    WerkstattConstructionBoxItem,
)
from app.services.werkstatt_movements import MovementError, apply_movement

# ── Status FSM ────────────────────────────────────────────────────────────────

BOX_STATUSES = ("offen", "gepackt", "zugewiesen", "zurueck")

ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    # Still packing → can be sealed.
    "offen": {"gepackt"},
    # Sealed → handed to a customer, or re-opened to correct the contents.
    "gepackt": {"zugewiesen", "offen"},
    # With the customer → comes back.
    "zugewiesen": {"zurueck"},
    # Returned → may be re-opened and packed again for the next job.
    "zurueck": {"offen"},
}


def assert_transition_allowed(current: str, target: str) -> None:
    if current == target:
        return
    allowed = ALLOWED_TRANSITIONS.get(current, set())
    if target not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot change box status from '{current}' to '{target}'",
        )


# ── Standard rack ─────────────────────────────────────────────────────────────

# The workshop has eight physical boxes that always exist and are re-used job
# after job — they are not created and thrown away like ad-hoc crates. They are
# identified by their rack position (``slot``), which is also what is painted on
# the crate, so "Kiste 3" means the same thing to the office and to the van.
#
# Only the count and the numbering live here. The *geometry* of the rack (which
# slots are the tall ones) is presentation and lives in the frontend, next to
# the grid that draws it.
STANDARD_BOX_SLOTS: tuple[int, ...] = (1, 2, 3, 4, 5, 6, 7, 8)


def standard_box_number(slot: int) -> str:
    """``K1`` … ``K8`` — deliberately NOT the ``BK-<year>-<seq>`` ad-hoc scheme.

    A standard box is a permanent object, so a year-scoped running number would
    be actively misleading on it.
    """
    return f"K{slot}"


def ensure_standard_boxes(db: Session) -> int:
    """Create any missing standard boxes. Idempotent; returns how many it added.

    Called lazily from the box list endpoint rather than at startup because the
    test suite truncates every table between tests — seeding on read is the one
    place guaranteed to run before anybody can look at the rack, and it
    self-heals if a row is ever removed directly in the database.
    """
    existing = set(
        db.scalars(
            select(WerkstattConstructionBox.slot).where(
                WerkstattConstructionBox.slot.is_not(None)
            )
        ).all()
    )
    missing = [slot for slot in STANDARD_BOX_SLOTS if slot not in existing]
    if not missing:
        return 0

    for slot in missing:
        db.add(
            WerkstattConstructionBox(
                box_number=standard_box_number(slot),
                label=f"Kiste {slot}",
                slot=slot,
                status="offen",
                created_by=None,
            )
        )
    db.commit()
    return len(missing)


# ── Box numbering ─────────────────────────────────────────────────────────────

_NUMBER_LOCK = threading.Lock()


def next_box_number(db: Session, *, now: datetime | None = None) -> str:
    """Generate ``BK-<year>-<seq>``, sequence resetting each year.

    The UNIQUE constraint on ``box_number`` is the real backstop; the lock just
    narrows the window between two concurrent creates in one process.
    """
    stamp = now or utcnow()
    prefix = f"BK-{stamp.year}-"
    with _NUMBER_LOCK:
        highest = db.scalar(
            select(func.max(WerkstattConstructionBox.box_number)).where(
                WerkstattConstructionBox.box_number.like(f"{prefix}%")
            )
        )
        next_seq = 1
        if highest:
            try:
                next_seq = int(str(highest).rsplit("-", 1)[-1]) + 1
            except ValueError:
                next_seq = 1
        return f"{prefix}{next_seq:04d}"


# ── Stock emission ────────────────────────────────────────────────────────────


def _stocked_lines(db: Session, box_id: int) -> list[WerkstattConstructionBoxItem]:
    """Box lines that map to a real stocked article (the only ones that move stock)."""
    return list(
        db.scalars(
            select(WerkstattConstructionBoxItem).where(
                WerkstattConstructionBoxItem.box_id == box_id,
                WerkstattConstructionBoxItem.article_id.is_not(None),
            )
        ).all()
    )


def _emit_box_movements(
    db: Session,
    box: WerkstattConstructionBox,
    *,
    movement_type: str,
    user_id: int,
) -> int:
    """Apply ``movement_type`` for every stocked line in the box.

    Returns the number of lines that moved. A MovementError (e.g. checking out
    more than is available) is surfaced as a 400 naming the offending article so
    the packer can fix it, rather than half-applying the box.
    """
    moved = 0
    for line in _stocked_lines(db, box.id):
        article = db.get(WerkstattArticle, line.article_id)
        if article is None:
            continue
        try:
            apply_movement(
                db,
                article=article,
                movement_type=movement_type,
                quantity=int(line.quantity or 0) or 1,
                user_id=user_id,
                project_id=box.project_id,
                construction_box_id=box.id,
                notes=f"Baustellenkiste {box.box_number}",
            )
        except MovementError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        moved += 1
    return moved


def transition_box(
    db: Session,
    box: WerkstattConstructionBox,
    *,
    target_status: str,
    user_id: int,
) -> WerkstattConstructionBox:
    """Move a box through its lifecycle, emitting stock movements where required.

    Caller commits. Timestamps are set here so every path records them the same
    way regardless of which endpoint drove the change.
    """
    if target_status not in BOX_STATUSES:
        raise HTTPException(status_code=400, detail=f"Unknown box status: {target_status!r}")

    current = box.status or "offen"
    assert_transition_allowed(current, target_status)
    if current == target_status:
        return box

    now = utcnow()
    if target_status == "gepackt":
        box.packed_at = now
    elif target_status == "zugewiesen":
        if box.customer_id is None:
            raise HTTPException(
                status_code=400,
                detail="A box must be assigned to a customer before it can be handed over",
            )
        _emit_box_movements(db, box, movement_type="checkout", user_id=user_id)
        box.assigned_at = now
        box.returned_at = None
    elif target_status == "zurueck":
        _emit_box_movements(db, box, movement_type="return", user_id=user_id)
        box.returned_at = now
    elif target_status == "offen":
        # Re-opening a returned/sealed box clears the seal timestamp; stock was
        # already unwound by the return transition.
        box.packed_at = None

    box.status = target_status
    box.updated_at = now
    db.add(box)
    return box
