"""Unpack a construction box into the task that will consume it.

Linking a box to a task used to be a pure association: it recorded which crate
was going out and nothing else, so the person on site still had no list of what
was in it. These functions make the link carry its contents.

Deliberately *copies* rather than referencing the box lines. A crate gets
repacked for the next job, and a finished task must still say what it actually
had — the same reason box items snapshot their own identity instead of joining
to the article. It also means the task's list can be corrected on site without
editing a crate that has already left the workshop.

Linking moves no stock. Stock moves when the box itself is handed over
(services/werkstatt_boxes.py) and when the task is completed: by then the
report has said what was fitted, the fitted part is written off and the rest
goes back on the shelf (:func:`settle_task_materials`). Selecting a box on a
task is still a statement of intent, not a movement.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import (
    Task,
    TaskMaterial,
    WerkstattArticle,
    WerkstattConstructionBox,
    WerkstattConstructionBoxItem,
)
from app.services.werkstatt_boxes import release_box_after_task
from app.services.werkstatt_movements import MovementError, apply_movement


def box_lines(db: Session, box_id: int) -> list[WerkstattConstructionBoxItem]:
    """Everything currently packed in a box, in a stable display order."""
    return list(
        db.scalars(
            select(WerkstattConstructionBoxItem)
            .where(WerkstattConstructionBoxItem.box_id == box_id)
            .order_by(WerkstattConstructionBoxItem.id)
        ).all()
    )


def task_materials(db: Session, task_id: int) -> list[TaskMaterial]:
    """The task's material lines, box-sourced and hand-added alike."""
    return list(
        db.scalars(
            select(TaskMaterial)
            .where(TaskMaterial.task_id == task_id)
            .order_by(TaskMaterial.id)
        ).all()
    )


def import_box_into_task(
    db: Session, *, task: Task, box: WerkstattConstructionBox, user_id: int | None
) -> int:
    """Copy the box's contents onto the task. Returns how many lines were added.

    Idempotent per box: re-running for a box whose lines are already on the
    task adds nothing. A task can be patched for unrelated reasons while the
    same box stays selected, and each of those saves must not deepen the list.
    """
    already = {
        material.source_box_item_id
        for material in task_materials(db, task.id)
        if material.source_box_id == box.id and material.source_box_item_id is not None
    }

    added = 0
    for line in box_lines(db, box.id):
        if line.id in already:
            continue
        db.add(
            TaskMaterial(
                task_id=task.id,
                source_box_id=box.id,
                source_box_item_id=line.id,
                article_id=line.article_id,
                item_name=line.item_name,
                article_no=line.article_no,
                ean=line.ean,
                unit=line.unit,
                quantity=line.quantity,
                # Nobody has reported usage yet, and that is not the same as
                # reporting none.
                quantity_used=None,
                added_by=user_id,
            )
        )
        added += 1
    if added:
        db.flush()
    return added


def remove_box_from_task(db: Session, *, task_id: int, box_id: int) -> int:
    """Drop the lines a given box put on a task. Returns how many were removed.

    Keyed on ``source_box_id`` so that picking the wrong crate and correcting
    it leaves behind exactly what was there before — hand-added lines survive,
    and lines from a *different* box (a task can be re-pointed) are untouched.

    Lines that already carry a reported ``quantity_used`` or have been settled
    are kept: by then they are a record of what was fitted, not a packing
    suggestion, and deleting them would discard the only structured account
    of the job.
    """
    removed = 0
    for material in task_materials(db, task_id):
        if material.source_box_id != box_id:
            continue
        if material.quantity_used is not None or material.settled_at is not None:
            continue
        db.delete(material)
        removed += 1
    if removed:
        db.flush()
    return removed


# ── Reported usage ───────────────────────────────────────────────────────────


def _reported_quantity(raw: object) -> int | None:
    """A report's ``qty`` as a whole number, or None if it does not say one.

    Report rows are free text ("6", "6,0", "ca. 6" — the last one is not a
    number and is left alone rather than guessed at).
    """
    if isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        return max(0, int(round(raw)))
    text = str(raw or "").strip().replace(",", ".")
    if not text:
        return None
    try:
        return max(0, int(round(float(text))))
    except ValueError:
        return None


def record_reported_usage(
    db: Session, *, source_task_id: int | None, rows: list[dict]
) -> int:
    """Write a report's consumed-material rows back onto the task's lines.

    Only rows that carry a ``task_material_id`` count — those were prefilled
    from the task, so the report is talking about the crate. A hand-typed row
    says nothing about the crate and is ignored. When at least one row refers
    to the task, every line of that task that the report does *not* mention is
    recorded as unused (``quantity_used = 0``): the person on site deleted it
    from the list because it went back in the crate. Settled lines are never
    touched — their stock has been booked.

    Returns the number of lines updated. Caller commits.
    """
    referenced: dict[int, int] = {}
    for row in rows:
        material_id = row.get("task_material_id")
        if isinstance(material_id, bool) or not isinstance(material_id, int):
            continue
        quantity = _reported_quantity(row.get("qty"))
        if quantity is None:
            continue
        referenced[material_id] = quantity
    if not referenced:
        return 0

    mentioned = db.scalars(select(TaskMaterial).where(TaskMaterial.id.in_(referenced))).all()
    task_ids = {material.task_id for material in mentioned}
    if source_task_id is not None:
        task_ids &= {source_task_id}
    if len(task_ids) != 1:
        return 0
    (task_id,) = task_ids

    updated = 0
    for line in task_materials(db, task_id):
        if line.settled_at is not None:
            continue
        line.quantity_used = referenced.get(line.id, 0)
        db.add(line)
        updated += 1
    if updated:
        db.flush()
    return updated


# ── Settlement on completion ─────────────────────────────────────────────────


@dataclass(frozen=True)
class Settlement:
    """What completing a task did to the crate and the shelf."""

    box_id: int
    box_number: str | None
    settled_lines: int
    written_off: int
    returned: int
    failed: tuple[str, ...]

    def as_details(self) -> dict:
        return {
            "box_id": self.box_id,
            "box_number": self.box_number,
            "settled_lines": self.settled_lines,
            "written_off": self.written_off,
            "returned": self.returned,
            "failed": list(self.failed),
        }


def settle_task_materials(db: Session, *, task: Task, user_id: int) -> Settlement | None:
    """Book the crate's contents when its task is completed, then free the crate.

    For every unsettled line the linked box put on the task: what the report
    says was fitted is written off (``correction`` — the item was already
    ``out`` since handover), the rest is put back on the shelf (``return``).
    Without a report the whole line counts as fitted; a report claiming more
    than was packed is capped, because stock that never left cannot be written
    off. The crate is then emptied, set to ``offen`` and unassigned, and the
    task lets go of it — the lines stay on the task as the record.

    Only a handed-over crate (``zugewiesen``) is settled: one still in the
    workshop has nothing checked out, so completing the task leaves it, and
    the link, untouched. Returns None in that case.

    A ledger refusal on one line (someone corrected the shelf count in the
    meantime) is recorded on the line and does not stop the task from being
    completed — the site is finished whether or not the arithmetic agrees.
    Caller commits.
    """
    box_id = task.construction_box_id
    if box_id is None:
        return None
    box = db.get(WerkstattConstructionBox, box_id)
    if box is None or (box.status or "offen") != "zugewiesen":
        return None

    now = utcnow()
    lines = [
        line
        for line in task_materials(db, task.id)
        if line.source_box_id == box.id and line.settled_at is None
    ]
    written_off = returned = 0
    failed: list[str] = []
    for line in lines:
        packed = max(0, int(line.quantity or 0))
        used = packed if line.quantity_used is None else min(max(0, int(line.quantity_used)), packed)
        remainder = packed - used
        article = db.get(WerkstattArticle, line.article_id) if line.article_id is not None else None
        if article is not None:
            try:
                if used:
                    apply_movement(
                        db,
                        article=article,
                        movement_type="correction",
                        quantity=used,
                        user_id=user_id,
                        project_id=task.project_id,
                        construction_box_id=box.id,
                        notes=f"Verbraucht, Aufgabe #{task.id}: {task.title}",
                    )
                    written_off += 1
                if remainder:
                    apply_movement(
                        db,
                        article=article,
                        movement_type="return",
                        quantity=remainder,
                        user_id=user_id,
                        project_id=task.project_id,
                        construction_box_id=box.id,
                        notes=f"Rest aus Baustellenkiste {box.box_number}, Aufgabe #{task.id}",
                    )
                    returned += 1
            except MovementError as exc:
                failed.append(line.item_name)
                note = f"Lagerbuchung fehlgeschlagen: {exc}"
                line.notes = f"{line.notes.rstrip()}\n{note}" if line.notes else note
        line.settled_at = now
        db.add(line)

    release_box_after_task(db, box, now=now)
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
    )
