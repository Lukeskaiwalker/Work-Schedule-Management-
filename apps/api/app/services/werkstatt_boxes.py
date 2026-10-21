"""Construction box (Baustellenkiste) lifecycle + stock semantics.

Two responsibilities live here so the routers stay thin:

1. **The status FSM.** ``offen → gepackt → zugewiesen → zurueck`` with a couple
   of reverse edges, mirroring the shape of ``werkstatt_orders.transition_order``.

   ``gepackt`` is where a crate *waits*: packed, already assigned to a
   customer, standing in the workshop until somebody carries it out. That is
   why sealing it requires a customer and at least one line, and why its
   contents stay editable (only ``zugewiesen`` freezes them).

   ``offen`` is the other end: on the rack, nobody's. Every way back to it
   clears the customer and the project, whichever status it comes from — the
   same as :func:`release_box_after_task`, the settlement's way back.

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

import re
import threading
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import (
    AppSetting,
    Task,
    WerkstattArticle,
    WerkstattConstructionBox,
    WerkstattConstructionBoxItem,
)
from app.services.runtime_settings import set_runtime_setting
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
#
# A number is never issued twice. The crate's sticker encodes
# ``KISTE-<box_number>`` in its DataMatrix and stickers outlive crates, so if
# deleting the newest Sonderkiste let the next one take its number, an old
# sticker would scan as a different crate. "Highest existing + 1" forgets a
# deleted top number; a per-year high-water mark in ``app_settings`` does not.
# No migration: a year without a mark falls back to the numbers that exist,
# and deleting a crate records its number first (see retire_box_number), which
# covers crates created before the mark did.

_NUMBER_LOCK = threading.Lock()
_BOX_NUMBER_RE = re.compile(r"^BK-(\d{4})-(\d+)$")
BOX_NUMBER_HIGH_WATER_KEY = "werkstatt.box_number_high_water.{year}"


def _stored_high_water(db: Session, year: int) -> int:
    """The year's mark as the database holds it now, locked until the caller's
    transaction ends (off SQLite, which has no row locks).

    Every caller compares and then writes, and a plain ``db.get`` makes that a
    lost update twice over. It answers from the session's identity map when
    the row was read before; and on PostgreSQL (READ COMMITTED, two uvicorn
    workers) it returns the committed mark while another delete's higher one
    waits to commit — writing 3 over that 4 would let 0004 be issued again.
    ``FOR UPDATE`` makes the second reader wait and then read 4;
    ``populate_existing`` makes it act on that read, not on its old copy.
    ``_NUMBER_LOCK`` cannot do this: it is per process and released before the
    commit. A year without a row locks nothing — two first writes then collide
    on the primary key and one request fails, which issues nothing twice.
    """
    stmt = (
        select(AppSetting)
        .where(AppSetting.key == BOX_NUMBER_HIGH_WATER_KEY.format(year=year))
        .execution_options(populate_existing=True)
    )
    if str(db.bind.dialect.name if db.bind is not None else "").lower() != "sqlite":
        stmt = stmt.with_for_update()
    row = db.scalars(stmt).first()
    try:
        return int(row.value) if row is not None and row.value else 0
    except ValueError:
        return 0


def _raise_high_water(db: Session, year: int, seq: int) -> None:
    """Record ``seq`` as issued for ``year`` unless a higher one already is.

    Flushed at once: the session does not autoflush, so without it a second
    issue in the same transaction would read the old mark — and add a second
    ``app_settings`` row under the same key.
    """
    if seq <= _stored_high_water(db, year):
        return
    set_runtime_setting(db, BOX_NUMBER_HIGH_WATER_KEY.format(year=year), str(seq))
    db.flush()


def next_box_number(db: Session, *, now: datetime | None = None) -> str:
    """Issue ``BK-<year>-<seq>``, sequence resetting each year.

    ``max(highest existing, high-water mark) + 1``, and the mark is raised in
    the caller's transaction, so it commits with the crate that uses the number
    (or rolls back with it). Every creator — the Kisten page and the
    settlement's "Rest in neue Kiste" — goes through here, which is why the
    mark is written here rather than by each of them.

    The mark is read first: its row lock makes a create in the other worker
    wait until this one commits, so the highest number read next already
    includes that crate. The UNIQUE constraint on ``box_number`` stays the
    backstop (a year's first number has no row to lock yet); ``_NUMBER_LOCK``
    narrows the window between two creates in one process.
    """
    stamp = now or utcnow()
    prefix = f"BK-{stamp.year}-"
    # Before _NUMBER_LOCK, not under it: a thread holding the process lock
    # must not wait on a row lock, since the transaction it waits for could
    # need the process lock before it can commit.
    stored = _stored_high_water(db, stamp.year)
    with _NUMBER_LOCK:
        highest = db.scalar(
            select(func.max(WerkstattConstructionBox.box_number)).where(
                WerkstattConstructionBox.box_number.like(f"{prefix}%")
            )
        )
        highest_seq = 0
        if highest:
            try:
                highest_seq = int(str(highest).rsplit("-", 1)[-1])
            except ValueError:
                highest_seq = 0
        next_seq = max(highest_seq, stored) + 1
        _raise_high_water(db, stamp.year, next_seq)
        return f"{prefix}{next_seq:04d}"


def retire_box_number(db: Session, box_number: str) -> None:
    """Remember a crate's number before the crate is deleted.

    Raises the mark to ``max(mark, this number)`` in the caller's transaction.
    A crate that predates the mark (production's BK-2026-0001) has no row
    behind it, so without this its number would be free again the moment it
    was the highest one left. ``K1``…``K8`` never get here — standard crates
    cannot be deleted — and nothing else is issued in another shape.

    No ``_NUMBER_LOCK`` here: the mark's row lock is what keeps two deletes
    apart, and the caller already holds the crate's row lock, so waiting on
    the mark while holding the process lock would only stall other creates.
    """
    match = _BOX_NUMBER_RE.match(box_number or "")
    if match is None:
        return
    _raise_high_water(db, int(match.group(1)), int(match.group(2)))


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
        # And the owner, from either side. From ``gepackt`` this is "Zuweisung
        # aufheben"; from ``zurueck`` it is "Erneut öffnen", which used to keep
        # the last customer. That left open crates (K7 and BK-2026-0001 in
        # production) that every other customer's task form hid as somebody
        # else's, and that their old customer's page still listed as current.
        # The contents stay: this undoes the assignment, not the packing.
        box.customer_id = None
        box.project_id = None

    box.status = target_status
    box.updated_at = now
    db.add(box)
    return box


# ── Deleting a Sonderkiste ────────────────────────────────────────────────────
#
# The owner's rule of 2026-10-20: anyone signed in may delete a Sonderkiste —
# the same people who create one — but only an empty crate standing on the rack
# that no unfinished task still points at. Each condition is a guard against a
# delete that would lose something: lines are stock somebody will look for, a
# crate that is ``gepackt``/``zugewiesen`` is a customer's (the settlement's
# "Rest in neue Kiste" crates are born ``gepackt``, and deleting one would null
# the record of where the rest went), and an open task would keep showing a
# crate that no longer exists.

DELETABLE_BOX_STATUSES = ("offen", "zurueck")
STANDARD_BOX_DELETE_DETAIL = "Standard-Kisten sind fest — statt zu löschen bitte leeren."
SPOKEN_FOR_DELETE_DETAIL = (
    "Die Kiste ist einem Kunden zugewiesen — erst die Zuweisung aufheben "
    "oder die Kiste zurückbuchen."
)
NOT_EMPTY_DELETE_DETAIL = "Die Kiste ist nicht leer — erst leeren, dann löschen."
# "done" is the one finished value of ``tasks.status`` (routers/workflow_helpers
# TASK_STATUSES); everything else, the legacy stored "overdue" included, is a
# job somebody still means to do.
_TASK_DONE = "done"
_TASK_TITLES_SHOWN = 3


def _linked_open_tasks_detail(titles: list[str]) -> str:
    shown = ", ".join(f"„{title}“" for title in titles[:_TASK_TITLES_SHOWN])
    if len(titles) > _TASK_TITLES_SHOWN:
        shown += f" und {len(titles) - _TASK_TITLES_SHOWN} weitere"
    which = "einer offenen Aufgabe" if len(titles) == 1 else "offenen Aufgaben"
    return (
        f"Die Kiste ist noch mit {which} verknüpft ({shown}) — "
        "dort erst die Kiste entfernen."
    )


def _lock_box(db: Session, box_id: int) -> WerkstattConstructionBox | None:
    """Re-read the crate under a row lock, as ``load_article_for_update`` does.

    Packing a line takes a key-share lock on the crate (the item's foreign
    key), which conflicts with this one: a line added at the same moment
    either lands before the emptiness check sees the count, or waits and finds
    the crate gone — it is never cascaded away unseen. SQLite has no row locks;
    as with the article lock, only the guards are testable there.
    """
    stmt = (
        select(WerkstattConstructionBox)
        .where(WerkstattConstructionBox.id == box_id)
        .execution_options(populate_existing=True)
    )
    if str(db.bind.dialect.name if db.bind is not None else "").lower() != "sqlite":
        stmt = stmt.with_for_update()
    return db.scalars(stmt).first()


def delete_sonderkiste(db: Session, box: WerkstattConstructionBox) -> list[int]:
    """Delete an ad-hoc crate if the rule allows it, else a German 400.

    A finished task's link is dropped here rather than left to the foreign
    key: the outcome must not depend on the database enforcing it (SQLite only
    does on a connection that switched it on, and the app never does), and a
    dangling id on a task is exactly the stale pointer this rule exists to
    avoid. The ledger is left alone — its rows keep their notes
    ("Baustellenkiste BK-…"), and ``ON DELETE SET NULL`` clears their link on
    PostgreSQL; nothing but ``apply_movement`` writes it.

    The number is retired first, in the same transaction, so it is never
    issued again (see :func:`retire_box_number`). Caller commits. Returns the
    ids of the finished tasks that let go of the crate, for the audit entry.
    """
    locked = _lock_box(db, box.id)
    if locked is None:
        # Deleted by somebody else while this request waited for the lock.
        raise HTTPException(status_code=404, detail="Construction box not found")
    box = locked
    if box.slot is not None:
        raise HTTPException(status_code=400, detail=STANDARD_BOX_DELETE_DETAIL)
    if (box.status or "offen") not in DELETABLE_BOX_STATUSES:
        raise HTTPException(status_code=400, detail=SPOKEN_FOR_DELETE_DETAIL)
    if box_line_count(db, box.id) > 0:
        raise HTTPException(status_code=400, detail=NOT_EMPTY_DELETE_DETAIL)

    linked = list(
        db.scalars(
            select(Task).where(Task.construction_box_id == box.id).order_by(Task.id.asc())
        ).all()
    )
    still_open = [task.title for task in linked if task.status != _TASK_DONE]
    if still_open:
        raise HTTPException(status_code=400, detail=_linked_open_tasks_detail(still_open))

    unlinked_ids = [task.id for task in linked]
    if unlinked_ids:
        # Both columns, as _apply_task_construction_box writes them (an ad-hoc
        # crate has no slot, so the legacy mirror is already empty). A plain
        # UPDATE that sets ``updated_at`` to itself, like the foreign key would:
        # the ORM's onupdate would stamp it now, and the "my_all" view reads it
        # as the moment the status flipped — an old finished task would turn
        # up again under "Erledigt".
        db.execute(
            update(Task)
            .where(Task.id.in_(unlinked_ids))
            .values(
                construction_box_id=None,
                storage_box_number=None,
                updated_at=Task.updated_at,
            )
            .execution_options(synchronize_session=False)
        )
    retire_box_number(db, box.box_number)
    db.delete(box)
    return unlinked_ids
