"""Book a construction box's contents when the task that took it is finished.

The crate was checked out of the warehouse when it was handed over
(services/werkstatt_boxes.py). Completing the task is what closes that loop:
the report has said what was fitted, the fitted part is written off, and the
rest comes back into the workshop.

Split out of ``task_materials`` — which owns *linking* a crate to a task and
recording what a report said — because this is the other half of the story and
the two together outgrew one readable file. The seam is deliberate: everything
here writes to the ledger, nothing there does.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import (
    Customer,
    Task,
    TaskMaterial,
    WerkstattArticle,
    WerkstattConstructionBox,
    WerkstattConstructionBoxItem,
)
from app.services.task_materials import box_lines, task_materials
from app.services.werkstatt_boxes import next_box_number, release_box_after_task
from app.services.werkstatt_movements import MovementError, apply_movement


# ── Settlement on completion ─────────────────────────────────────────────────
#
# Completing a task closes the loop the handover opened: what the report says
# was fitted is written off, and the rest comes back into the workshop. The
# ledger is IDENTICAL for all three outcomes below — under the invariant "a
# crate standing in the workshop has nothing checked out", material that comes
# back into any crate in the workshop is stock on hand again, and the box
# tables say which crate it is sitting in. So the choice the person makes at
# completion changes where the rest lives, never what the ledger says.

#: What may happen to the part of a crate that was not used up.
REMAINDER_DISPOSITIONS: tuple[str, ...] = ("shelf", "same_box", "new_box")

#: German for the activity entry, in the order the dialog offers them.
_DISPOSITION_TEXT = {
    "shelf": "Rest eingelagert",
    "same_box": "Rest bleibt in Kiste {box_number}",
    "new_box": "Rest in neue Kiste {box_number}",
}


@dataclass(frozen=True)
class RemainderLine:
    """One position that is left over, ready to be written into a crate.

    Carries its own identity rather than a reference, exactly as a box item
    does: the rest of a job may outlive the article's name, and a crate has to
    keep reading the way it was packed.
    """

    box_item_id: int | None
    source: str
    article_id: int | None
    catalog_external_key: str | None
    item_name: str
    article_no: str | None
    ean: str | None
    unit: str | None
    quantity: int


@dataclass(frozen=True)
class SettlementLine:
    """One line of the settlement preview — what was packed, used and left."""

    id: int
    item_name: str
    unit: str | None
    quantity: int
    quantity_used: int | None
    remainder: int
    article_id: int | None

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "item_name": self.item_name,
            "unit": self.unit,
            "quantity": self.quantity,
            "quantity_used": self.quantity_used,
            "remainder": self.remainder,
            "article_id": self.article_id,
        }


@dataclass(frozen=True)
class SettlementPreview:
    """What completing this task is about to do to its crate.

    Read before the task is completed so the person can be asked where the
    rest should go. ``needs_decision`` is the whole point: it is false for the
    overwhelming majority of tasks (no crate, nothing left over), and the
    dialog only opens when it is true.
    """

    box: dict | None
    lines: tuple[SettlementLine, ...]
    remainder_total: int
    handover_pending: bool
    needs_decision: bool

    def as_dict(self) -> dict:
        return {
            "box": self.box,
            "lines": [line.as_dict() for line in self.lines],
            "remainder_total": self.remainder_total,
            "handover_pending": self.handover_pending,
            "needs_decision": self.needs_decision,
        }


@dataclass(frozen=True)
class Settlement:
    """What completing a task did to the crate and the shelf."""

    box_id: int
    box_number: str | None
    settled_lines: int
    written_off: int
    returned: int
    failed: tuple[str, ...]
    # Where the rest went, and into which crate (None for the shelf).
    disposition: str = "shelf"
    remainder_box_id: int | None = None
    remainder_box_number: str | None = None
    # True when the crate was still ``gepackt``: it went to site without
    # anybody booking the handover, so completion booked it.
    handover_booked: bool = False

    @property
    def remainder_text(self) -> str:
        """The German half-sentence the activity entry ends with."""
        template = _DISPOSITION_TEXT.get(self.disposition, _DISPOSITION_TEXT["shelf"])
        return template.format(box_number=self.remainder_box_number or "?")

    def as_details(self) -> dict:
        return {
            "box_id": self.box_id,
            "box_number": self.box_number,
            "settled_lines": self.settled_lines,
            "written_off": self.written_off,
            "returned": self.returned,
            "failed": list(self.failed),
            "disposition": self.disposition,
            "remainder_box_id": self.remainder_box_id,
            "remainder_box_number": self.remainder_box_number,
            "handover_booked": self.handover_booked,
        }


def _used_quantity(line: TaskMaterial, *, packed: int) -> int:
    """What this line says was fitted: the report's number, capped at ``packed``.

    No report at all means the whole line was fitted — that is the reading the
    workshop has always had, and it is the safe one: a crate nobody reported on
    is not evidence that anything came back.
    """
    if line.quantity_used is None:
        return packed
    return min(max(0, int(line.quantity_used)), packed)


def _settlement_lines(db: Session, *, task: Task, box_id: int) -> list[TaskMaterial]:
    """The task's unsettled lines that came from ``box_id``."""
    return [
        line
        for line in task_materials(db, task.id)
        if line.source_box_id == box_id and line.settled_at is None
    ]


@dataclass(frozen=True)
class _CappedLine:
    """A task's copy of one crate line, bounded by what the crate still holds."""

    line: TaskMaterial
    packed: int
    used: int
    remainder: int


def _capped_lines(db: Session, *, task: Task, box_id: int) -> list[_CappedLine]:
    """The task's unsettled lines, each capped at what the crate can still back.

    A task holds a COPY of the crate's contents, taken when the crate was
    linked, and the two drift in both directions: a ``gepackt`` crate stays
    editable, and two tasks of the same customer may each hold a copy of the
    same crate (``_validate_task_construction_box`` only refuses a crate owned
    by a *different* customer). Booking a line's own number would then write
    off — or hand back — material the crate no longer holds, and
    ``apply_movement`` clamps the resulting negative counter to zero without
    complaining (services/werkstatt_movements.py), so the missing stock would
    never surface anywhere.

    So the crate, not the task's copy of it, is the authority on what may be
    settled: every box line backs its own quantity exactly once, shared out
    over the task lines that came from it in id order. A line whose box row is
    gone entirely backs nothing — a crate that no longer holds it never
    carried it out.
    """
    remaining = {item.id: max(0, int(item.quantity or 0)) for item in box_lines(db, box_id)}
    capped: list[_CappedLine] = []
    for line in _settlement_lines(db, task=task, box_id=box_id):
        packed = max(0, int(line.quantity or 0))
        item_id = line.source_box_item_id
        if item_id is not None:
            packed = min(packed, remaining.get(item_id, 0))
            remaining[item_id] = remaining.get(item_id, 0) - packed
        used = _used_quantity(line, packed=packed)
        capped.append(_CappedLine(line=line, packed=packed, used=used, remainder=packed - used))
    return capped


def material_settlement_preview(db: Session, *, task: Task) -> SettlementPreview:
    """Describe the settlement a completion would perform. Writes nothing."""
    empty = SettlementPreview(
        box=None, lines=(), remainder_total=0, handover_pending=False, needs_decision=False
    )
    if task.construction_box_id is None:
        return empty
    box = db.get(WerkstattConstructionBox, task.construction_box_id)
    if box is None:
        return empty
    status = box.status or "offen"
    if status not in ("zugewiesen", "gepackt"):
        return empty

    customer = db.get(Customer, box.customer_id) if box.customer_id is not None else None
    # Capped exactly as the settlement will cap it, so the table in the dialog
    # is the table that gets booked. ``quantity_used`` stays null when nobody
    # reported (the dialog says so); a reported number is shown capped, so the
    # three columns always add up in front of the person deciding.
    lines = tuple(
        SettlementLine(
            id=capped.line.id,
            item_name=capped.line.item_name,
            unit=capped.line.unit,
            quantity=capped.packed,
            quantity_used=None if capped.line.quantity_used is None else capped.used,
            remainder=capped.remainder,
            article_id=capped.line.article_id,
        )
        for capped in _capped_lines(db, task=task, box_id=box.id)
    )
    remainder_total = sum(line.remainder for line in lines)
    return SettlementPreview(
        box={
            "id": box.id,
            "box_number": box.box_number,
            "label": box.label,
            "status": status,
            "customer_name": customer.name if customer is not None else None,
        },
        lines=lines,
        remainder_total=remainder_total,
        handover_pending=status == "gepackt",
        needs_decision=remainder_total > 0,
    )


def _book(
    db: Session,
    *,
    article: WerkstattArticle,
    movement_type: str,
    quantity: int,
    user_id: int,
    project_id: int | None,
    box_id: int,
    notes: str,
    line: TaskMaterial | None,
    failed: list[str],
    label: str,
) -> bool:
    """One ledger write that must not be able to stop a task from finishing.

    A refusal (somebody corrected the shelf count in the meantime) is recorded
    — on the line when there is one, in ``failed`` either way — and the job is
    still finished. The site is done whether or not the arithmetic agrees, and
    a task nobody can close is worse than a counter somebody has to fix.
    """
    try:
        apply_movement(
            db,
            article=article,
            movement_type=movement_type,
            quantity=quantity,
            user_id=user_id,
            project_id=project_id,
            construction_box_id=box_id,
            notes=notes,
        )
    except MovementError as exc:
        failed.append(label)
        if line is not None:
            note = f"Lagerbuchung fehlgeschlagen: {exc}"
            line.notes = f"{line.notes.rstrip()}\n{note}" if line.notes else note
        return False
    return True


def _book_pending_handover(
    db: Session,
    *,
    box: WerkstattConstructionBox,
    task: Task,
    user_id: int,
    now: datetime,
    failed: list[str],
) -> None:
    """Book the handover of a crate that went to site while still ``gepackt``.

    With ``gepackt`` a resting state, this is a common path rather than an
    exotic one: somebody carries a packed crate out without tapping anything.
    The ledger must end up exactly where it would have been had the handover
    been booked, so the checkout is written now, per stocked line, before the
    settlement unwinds it again.
    """
    for item in box_lines(db, box.id):
        if item.article_id is None:
            continue
        article = db.get(WerkstattArticle, item.article_id)
        if article is None:
            continue
        _book(
            db,
            article=article,
            movement_type="checkout",
            quantity=max(1, int(item.quantity or 0)),
            user_id=user_id,
            project_id=box.project_id,
            box_id=box.id,
            notes=(
                f"Übergabe nachgebucht bei Abschluss, Aufgabe #{task.id} "
                f"— Baustellenkiste {box.box_number}"
            ),
            line=None,
            failed=failed,
            label=item.item_name,
        )
    box.status = "zugewiesen"
    box.assigned_at = now
    box.returned_at = None
    db.add(box)


def _keep_in_box(
    db: Session,
    box: WerkstattConstructionBox,
    remainders: list[RemainderLine],
    *,
    now: datetime,
) -> None:
    """Leave the rest in this crate: it stays packed for the same customer.

    Existing lines are corrected down to what is left (and dropped when
    nothing is), because the crate must read as what it now holds — a line
    still claiming ten of something nobody can find is how a packing list
    stops being believed.
    """
    keep = {line.box_item_id: line.quantity for line in remainders if line.box_item_id is not None}
    for item in box_lines(db, box.id):
        quantity = keep.get(item.id, 0)
        if quantity <= 0:
            db.delete(item)
            continue
        item.quantity = quantity
        item.updated_at = now
        db.add(item)
    for line in remainders:
        if line.box_item_id is None:
            _add_remainder_item(db, box, line, now=now)
    db.flush()


def _add_remainder_item(
    db: Session, box: WerkstattConstructionBox, line: RemainderLine, *, now: datetime
) -> None:
    db.add(
        WerkstattConstructionBoxItem(
            box_id=box.id,
            source=line.source,
            article_id=line.article_id,
            catalog_external_key=line.catalog_external_key,
            item_name=line.item_name,
            article_no=line.article_no,
            ean=line.ean,
            unit=line.unit,
            quantity=line.quantity,
            created_at=now,
            updated_at=now,
        )
    )


def _move_to_new_box(
    db: Session,
    source: WerkstattConstructionBox,
    remainders: list[RemainderLine],
    *,
    label: str,
    user_id: int,
    now: datetime,
) -> WerkstattConstructionBox:
    """Put the rest into a fresh ad-hoc crate for the same customer.

    The job's own crate is usually a standard rack box that is needed again
    tomorrow, so "the rest stays packed" and "give the rack its crate back"
    are not the same wish — this is the second one.
    """
    box = WerkstattConstructionBox(
        box_number=next_box_number(db, now=now),
        label=label,
        status="gepackt",
        customer_id=source.customer_id,
        project_id=source.project_id,
        packed_at=now,
        created_by=user_id,
        created_at=now,
        updated_at=now,
    )
    db.add(box)
    db.flush()
    for line in remainders:
        _add_remainder_item(db, box, line, now=now)
    db.flush()
    return box


def _remainder_lines(
    db: Session,
    box: WerkstattConstructionBox,
    *,
    leftovers: dict[int, int],
    orphans: list[RemainderLine],
    unaccounted: dict[int, int],
) -> list[RemainderLine]:
    """Everything that is still physically in the crate after the settlement.

    Two sources, because a crate and the task's copy of it can differ: what the
    task's lines left over, plus whatever was packed into the crate *after* the
    task took its copy and that no line therefore accounts for.
    """
    lines: list[RemainderLine] = []
    for item in box_lines(db, box.id):
        quantity = leftovers.get(item.id, 0) + unaccounted.get(item.id, 0)
        if quantity <= 0:
            continue
        lines.append(
            RemainderLine(
                box_item_id=item.id,
                source=item.source,
                article_id=item.article_id,
                catalog_external_key=item.catalog_external_key,
                item_name=item.item_name,
                article_no=item.article_no,
                ean=item.ean,
                unit=item.unit,
                quantity=quantity,
            )
        )
    return lines + orphans


def settle_task_materials(
    db: Session,
    *,
    task: Task,
    user_id: int,
    disposition: str = "shelf",
    new_box_label: str | None = None,
) -> Settlement | None:
    """Book the crate's contents when its task is completed, then free the crate.

    For every unsettled line the linked box put on the task: what the report
    says was fitted is written off (``correction`` — the item was already
    ``out`` since handover), the rest is put back into the workshop
    (``return``). Without a report the whole line counts as fitted; a report
    claiming more than was packed is capped, because stock that never left
    cannot be written off — and "packed" means what the crate can still back
    (:func:`_capped_lines`), not what the task's copy of it claims.

    ``disposition`` says where the rest then sits — see
    :data:`REMAINDER_DISPOSITIONS`. It changes the crate, never the ledger:
    ``shelf`` empties the crate and puts it back on the rack, ``same_box``
    leaves the rest packed for the same customer, ``new_box`` moves it into a
    fresh crate and frees this one. The task lets go of the crate in every
    case — the lines stay on the task as the record.

    A crate still standing ``gepackt`` is settled too: with ``gepackt`` a
    resting state, "carried out without booking the handover" is an everyday
    path, and the handover is booked here so the ledger ends up where it
    belongs. A crate that is ``offen`` has nothing checked out and nobody has
    claimed it went anywhere, so it and the link are left alone (returns None).

    Caller commits.
    """
    box_id = task.construction_box_id
    if box_id is None:
        return None
    box = db.get(WerkstattConstructionBox, box_id)
    if box is None:
        return None
    status = box.status or "offen"
    if status not in ("zugewiesen", "gepackt"):
        return None
    if disposition not in REMAINDER_DISPOSITIONS:
        disposition = "shelf"

    now = utcnow()
    failed: list[str] = []
    handover_booked = status == "gepackt"
    if handover_booked:
        _book_pending_handover(
            db, box=box, task=task, user_id=user_id, now=now, failed=failed
        )

    capped_lines = _capped_lines(db, task=task, box_id=box.id)
    lines = [capped.line for capped in capped_lines]
    written_off = returned = 0
    leftovers: dict[int, int] = {}
    accounted: dict[int, int] = {}
    orphans: list[RemainderLine] = []
    for capped in capped_lines:
        line = capped.line
        packed, used, remainder = capped.packed, capped.used, capped.remainder
        article = db.get(WerkstattArticle, line.article_id) if line.article_id is not None else None
        if article is not None:
            if used and _book(
                db,
                article=article,
                movement_type="correction",
                quantity=used,
                user_id=user_id,
                project_id=task.project_id,
                box_id=box.id,
                notes=f"Verbraucht, Aufgabe #{task.id}: {task.title}",
                line=line,
                failed=failed,
                label=line.item_name,
            ):
                written_off += 1
            if remainder and _book(
                db,
                article=article,
                movement_type="return",
                quantity=remainder,
                user_id=user_id,
                project_id=task.project_id,
                box_id=box.id,
                notes=f"Rest aus Baustellenkiste {box.box_number}, Aufgabe #{task.id}",
                line=line,
                failed=failed,
                label=line.item_name,
            ):
                returned += 1
        item_id = line.source_box_item_id
        if item_id is not None:
            leftovers[item_id] = leftovers.get(item_id, 0) + remainder
            accounted[item_id] = accounted.get(item_id, 0) + packed
        elif remainder:
            orphans.append(
                RemainderLine(
                    box_item_id=None,
                    source="article" if line.article_id is not None else "manual",
                    article_id=line.article_id,
                    catalog_external_key=None,
                    item_name=line.item_name,
                    article_no=line.article_no,
                    ean=line.ean,
                    unit=line.unit,
                    quantity=remainder,
                )
            )
        line.settled_at = now
        db.add(line)

    unaccounted = _return_unaccounted(
        db, box=box, task=task, accounted=accounted, user_id=user_id, failed=failed
    )
    remainders = _remainder_lines(
        db, box, leftovers=leftovers, orphans=orphans, unaccounted=unaccounted
    )

    # Written straight onto the crate rather than through ``transition_box``,
    # for the same reason ``release_box_after_task`` is: the FSM has no
    # ``zugewiesen → gepackt`` edge, and it should not — outside a settlement
    # that edge would mean "un-hand-over a crate", which would return the
    # contents a second time. Here the settlement has already booked every
    # line back, so the crate genuinely is packed and standing in the
    # workshop again.
    remainder_box: WerkstattConstructionBox | None = None
    if disposition == "same_box" and remainders:
        _keep_in_box(db, box, remainders, now=now)
        box.status = "gepackt"
        box.packed_at = now
        box.returned_at = now
        box.updated_at = now
        db.add(box)
        remainder_box = box
    elif disposition == "new_box" and remainders:
        remainder_box = _move_to_new_box(
            db,
            box,
            remainders,
            label=(new_box_label or "").strip() or f"Rest {box.box_number}",
            user_id=user_id,
            now=now,
        )
        release_box_after_task(db, box, now=now)
    else:
        release_box_after_task(db, box, now=now)

    # What actually happened, which is not always what was asked for: a choice
    # with nothing left to put anywhere empties the crate, because an empty
    # crate is not a packed crate whatever the dialog said. The lines record
    # the outcome, never the intention.
    settled_disposition = "shelf" if remainder_box is None else disposition
    for line in lines:
        line.remainder_disposition = settled_disposition
        line.remainder_box_id = remainder_box.id if remainder_box is not None else None
        db.add(line)

    task.construction_box_id = None
    task.storage_box_number = None
    db.add(task)
    db.flush()
    return Settlement(
        box_id=box.id,
        box_number=box.box_number,
        settled_lines=len(lines),
        written_off=written_off,
        returned=returned,
        failed=tuple(failed),
        disposition=settled_disposition,
        remainder_box_id=remainder_box.id if remainder_box is not None else None,
        remainder_box_number=remainder_box.box_number if remainder_box is not None else None,
        handover_booked=handover_booked,
    )


def _return_unaccounted(
    db: Session,
    *,
    box: WerkstattConstructionBox,
    task: Task,
    accounted: dict[int, int],
    user_id: int,
    failed: list[str],
) -> dict[int, int]:
    """Give back what the crate holds and the task's lines never mentioned.

    A crate stays editable while it is packed, so something can be dropped in
    after the task took its copy of the contents. That part was checked out
    with the rest of the crate at handover and no line will ever write it off,
    so without this it would stay ``out`` forever — and, with the rest left in
    the crate, be counted twice. Nobody reported it as fitted, so it comes back
    in full. Returns the quantity per box line, for the crate's own contents.

    This is the one direction that needs a booking. The opposite drift — the
    task claiming MORE than the crate holds — is handled before anything is
    booked, by :func:`_capped_lines`, which is also what guarantees the
    subtraction below cannot go negative.
    """
    unaccounted: dict[int, int] = {}
    for item in box_lines(db, box.id):
        quantity = max(0, int(item.quantity or 0)) - accounted.get(item.id, 0)
        if quantity <= 0:
            continue
        unaccounted[item.id] = quantity
        if item.article_id is None:
            continue
        article = db.get(WerkstattArticle, item.article_id)
        if article is None:
            continue
        _book(
            db,
            article=article,
            movement_type="return",
            quantity=quantity,
            user_id=user_id,
            project_id=task.project_id,
            box_id=box.id,
            notes=(
                f"Nicht abgerechnete Position aus Baustellenkiste {box.box_number}, "
                f"Aufgabe #{task.id}"
            ),
            line=None,
            failed=failed,
            label=item.item_name,
        )
    return unaccounted
