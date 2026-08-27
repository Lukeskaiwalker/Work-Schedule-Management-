"""Unpack a construction box into the task that will consume it.

Linking a box to a task used to be a pure association: it recorded which crate
was going out and nothing else, so the person on site still had no list of what
was in it. These functions make the link carry its contents.

Deliberately *copies* rather than referencing the box lines. A crate gets
repacked for the next job, and a finished task must still say what it actually
had — the same reason box items snapshot their own identity instead of joining
to the article. It also means the task's list can be corrected on site without
editing a crate that has already left the workshop.

No stock moves here. Stock moves when the box itself is assigned and returned
(services/werkstatt_boxes.py) and, later, when the task is completed and the
used quantities are known. Selecting a box on a task is still a statement of
intent, not a movement.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import (
    Task,
    TaskMaterial,
    WerkstattConstructionBox,
    WerkstattConstructionBoxItem,
)


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

    Lines that already carry a reported ``quantity_used`` are kept: by then
    they are a record of what was fitted, not a packing suggestion, and
    deleting them would discard the only structured account of the job.
    """
    removed = 0
    for material in task_materials(db, task_id):
        if material.source_box_id != box_id:
            continue
        if material.quantity_used is not None:
            continue
        db.delete(material)
        removed += 1
    if removed:
        db.flush()
    return removed
