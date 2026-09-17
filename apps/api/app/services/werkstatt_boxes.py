"""Construction box (Baustellenkiste) lifecycle + stock semantics.

Two responsibilities live here so the routers stay thin:

1. **The status FSM.** ``offen → gepackt → zugewiesen → zurueck`` with a couple
   of reverse edges, mirroring the shape of ``werkstatt_orders.transition_order``.

   ``gepackt`` is where a crate *waits*: packed, already assigned to a
   customer, standing in the workshop until somebody carries it out. That is
   why sealing it requires a customer and at least one line, why its contents
   stay editable (only ``zugewiesen`` freezes them), and why the way back to
   ``offen`` clears the customer — "Zuweisung aufheben" is the only thing that
   edge can honestly mean.

2. **Stock movements.** Packing deliberately does NOT touch stock — a packed
   crate is still standing in the workshop, so what is in it is still stock on
   hand, and writing to the append-only ledger on every add/remove/qty-edit
   would be pure churn. Stock moves exactly twice:

     * on HANDOVER     → ``checkout`` per stocked line (article-backed only)
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
    # Still packing → can be sealed for the customer it is going to.
    "offen": {"gepackt"},
    # Packed and waiting → carried out to the customer, or un-assigned.
    "gepackt": {"zugewiesen", "offen"},
    # With the customer → comes back.
    "zugewiesen": {"zurueck"},
    # Returned → may be re-opened and packed again for the next job.
    "zurueck": {"offen"},
}

# The German the packer reads when a crate cannot be sealed yet. One constant
# per rule so the router, the station and the FSM all refuse in one voice.
NO_CUSTOMER_DETAIL = (
    "Die Kiste braucht einen Kunden, bevor sie gepackt werden kann."
)
NO_ITEMS_DETAIL = (
    "Die Kiste ist leer — erst Positionen einpacken, dann zuweisen."
)
NOT_PACKED_DETAIL = (
    "Nur eine gepackte Kiste kann mitgenommen werden."
)
PACKED_EMPTY_DETAIL = (
    "Eine gepackte Kiste kann nicht geleert werden — erst die Zuweisung aufheben."
)

# What the workshop calls each status, for the refusal below. The status codes
# themselves are German-ish but not German; a packer reading an error wants the
# word that is on their screen.
_STATUS_TEXT = {
    "offen": "Offen",
    "gepackt": "Gepackt",
    "zugewiesen": "Beim Kunden",
    "zurueck": "Zurück",
}

# The one edge people actually walk into: a crate that came back unopened has
# to be re-opened before it can be packed again. Naming the button is the
# difference between a dead end and a next step.
_TRANSITION_HINTS = {
    ("zurueck", "gepackt"): " Die Kiste zuerst mit „Erneut öffnen“ freigeben.",
}


def assert_transition_allowed(current: str, target: str) -> None:
    if current == target:
        return
    allowed = ALLOWED_TRANSITIONS.get(current, set())
    if target not in allowed:
        hint = _TRANSITION_HINTS.get((current, target), "")
        raise HTTPException(
            status_code=400,
            detail=(
                f"Kistenstatus „{_STATUS_TEXT.get(current, current)}“ kann nicht direkt "
                f"auf „{_STATUS_TEXT.get(target, target)}“ wechseln.{hint}"
            ),
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
    station_id: int | None = None,
    note_prefix: str | None = None,
) -> int:
    """Apply ``movement_type`` for every stocked line in the box.

    Returns the number of lines that moved. A MovementError (e.g. checking out
    more than is available) is surfaced as a 400 naming the offending article so
    the packer can fix it, rather than half-applying the box.

    ``station_id`` and ``note_prefix`` exist for the one caller that is a
    device: a handover booked at the wall screen must stay tellable from the
    same handover booked by the administrator whose name it borrows. Stamped
    here rather than by that caller because it is this function that knows
    which rows it just wrote, and ``apply_movement`` — the shared ledger
    implementation every path runs — deliberately knows nothing about stations.
    """
    moved = 0
    for line in _stocked_lines(db, box.id):
        article = db.get(WerkstattArticle, line.article_id)
        if article is None:
            continue
        note = f"Baustellenkiste {box.box_number}"
        try:
            movement = apply_movement(
                db,
                article=article,
                movement_type=movement_type,
                quantity=int(line.quantity or 0) or 1,
                user_id=user_id,
                project_id=box.project_id,
                construction_box_id=box.id,
                notes=f"{note_prefix} — {note}" if note_prefix else note,
            )
        except MovementError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if station_id is not None:
            movement.station_id = station_id
            db.add(movement)
        moved += 1
    return moved


def box_line_count(db: Session, box_id: int) -> int:
    """How many lines are packed in a box. Used by the "can it be sealed" rule."""
    return int(
        db.scalar(
            select(func.count(WerkstattConstructionBoxItem.id)).where(
                WerkstattConstructionBoxItem.box_id == box_id
            )
        )
        or 0
    )


def release_box_after_task(
    db: Session,
    box: WerkstattConstructionBox,
    *,
    now: datetime | None = None,
) -> int:
    """Empty a handed-over crate and put it back on the rack, unassigned.

    Called by the task settlement (services/task_materials.py) once every line
    has been split into "fitted" and "back on the shelf" and those movements
    are booked. Deliberately *not* an edge of :func:`transition_box`: the FSM's
    ``zurueck`` returns every line in full, which is right for a crate that
    comes back unopened and wrong once the settlement has already returned
    the remainder — going through it would put the fitted part back on the
    shelf a second time. Caller commits. Returns the number of lines removed.
    """
    stamp = now or utcnow()
    lines = list(
        db.scalars(
            select(WerkstattConstructionBoxItem).where(
                WerkstattConstructionBoxItem.box_id == box.id
            )
        ).all()
    )
    for line in lines:
        db.delete(line)
    box.status = "offen"
    box.customer_id = None
    box.project_id = None
    box.packed_at = None
    box.returned_at = stamp
    box.updated_at = stamp
    db.add(box)
    db.flush()
    return len(lines)


def pack_box(
    db: Session,
    box: WerkstattConstructionBox,
    *,
    user_id: int,
) -> WerkstattConstructionBox:
    """Seal a crate: packed, assigned, standing ready in the workshop.

    A thin name over the FSM edge, kept because "pack" is what the router and
    the workshop call it. Both rules — a customer, and something in it — are
    enforced on the edge itself, so a caller that drives ``/status`` straight
    to ``gepackt`` is held to them too.

    Caller sets the customer first and commits afterwards.
    """
    return transition_box(db, box, target_status="gepackt", user_id=user_id)


def transition_box(
    db: Session,
    box: WerkstattConstructionBox,
    *,
    target_status: str,
    user_id: int,
    station_id: int | None = None,
    note_prefix: str | None = None,
    allow_empty: bool = False,
) -> WerkstattConstructionBox:
    """Move a box through its lifecycle, emitting stock movements where required.

    Caller commits. Timestamps are set here so every path records them the same
    way regardless of which endpoint drove the change.

    ``station_id``/``note_prefix`` mark the movements as written by a wall
    screen; see :func:`_emit_box_movements`.

    ``allow_empty`` lifts the "a sealed crate has something in it" rule for the
    single caller that legitimately passes *through* ``gepackt``: the one-step
    ``POST /assign``, which is handing a crate over right now and makes no
    claim about a crate standing ready on the rack.
    """
    if target_status not in BOX_STATUSES:
        raise HTTPException(status_code=400, detail=f"Unknown box status: {target_status!r}")

    current = box.status or "offen"
    assert_transition_allowed(current, target_status)
    if current == target_status:
        return box

    now = utcnow()
    if target_status == "gepackt":
        # Sealing is a promise about a crate: it belongs to somebody and there
        # is something in it. Both checked on the edge rather than in the
        # router so the station, ``POST /status`` and any later caller are held
        # to the same rule — "Gepackt – bereit" is read off a rack, off the
        # wall screen and by the station's handover, and an empty crate is
        # ready for nobody.
        if box.customer_id is None:
            raise HTTPException(status_code=400, detail=NO_CUSTOMER_DETAIL)
        if not allow_empty and box_line_count(db, box.id) == 0:
            raise HTTPException(status_code=400, detail=NO_ITEMS_DETAIL)
        box.packed_at = now
    elif target_status == "zugewiesen":
        if box.customer_id is None:
            raise HTTPException(status_code=400, detail=NO_CUSTOMER_DETAIL)
        _emit_box_movements(
            db,
            box,
            movement_type="checkout",
            user_id=user_id,
            station_id=station_id,
            note_prefix=note_prefix,
        )
        box.assigned_at = now
        box.returned_at = None
    elif target_status == "zurueck":
        _emit_box_movements(
            db,
            box,
            movement_type="return",
            user_id=user_id,
            station_id=station_id,
            note_prefix=note_prefix,
        )
        box.returned_at = now
    elif target_status == "offen":
        # Re-opening clears the seal timestamp; stock was already unwound by
        # the return transition (or never moved, coming back from ``gepackt``).
        box.packed_at = None
        if current == "gepackt":
            # "Zuweisung aufheben". A packed crate is packed FOR somebody, so
            # taking it back to the packing bench with the customer still on it
            # would leave a crate that claims to be reserved and is not — and
            # the office would have no way to tell the two apart. The contents
            # stay: this undoes the assignment, not the packing.
            box.customer_id = None
            box.project_id = None

    box.status = target_status
    box.updated_at = now
    db.add(box)
    return box
