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
comes back into the workshop — that half lives in
``services/task_material_settlement.py``. Selecting a box on a task is still a
statement of intent, not a movement.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from decimal import ROUND_HALF_EVEN, Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.limits import INT32_MAX, MAX_STOCK_QUANTITY
from app.models.entities import (
    Task,
    TaskMaterial,
    WerkstattConstructionBox,
    WerkstattConstructionBoxItem,
)
from app.services.material_need_rows import parse_quantity_text


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


# A number half-typed on a phone keyboard: "6," / "6." (the decimals never
# came) and ",5" / ".5" (the leading zero never did). ``float()`` read these,
# so reports kept them; the shared grammar does not, on purpose — the order
# hand-off and its browser twin call them unreadable — so they are completed
# here, for report rows only, and only in this exact shape: "1.234," stays
# unreadable rather than turning into 1.
_TRAILING_SEPARATOR = re.compile(r"^([+-]?\d+)[.,]$")
_LEADING_SEPARATOR = re.compile(r"^([+-]?)([.,]\d+)$")


def _complete_half_typed(text: str) -> str:
    trailing = _TRAILING_SEPARATOR.match(text)
    if trailing:
        return trailing.group(1)
    leading = _LEADING_SEPARATOR.match(text)
    if leading:
        return f"{leading.group(1)}0{leading.group(2)}"
    return text


def parse_report_quantity(raw: object) -> Decimal | None:
    """A report row's free-text ``qty`` as a number, or None if it is not one.

    Read with the app's one quantity grammar (``parse_quantity_text``: digits,
    a decimal comma or dot, thousands separators — "6", "6,0", "1.234,5"), so
    a row reads the same in the project's material summary as in the task's
    usage write-back, plus the half-typed "6," / ",5" that ``float()`` always
    took (``_complete_half_typed``). Scientific notation, "inf" and "nan" are
    not quantities: ``float()`` used to accept them, and "1e20" then
    overflowed the int4 ``quantity_used`` column (a 500 for the whole report)
    while "inf" raised OverflowError before the database was reached.

    A number whose magnitude exceeds ``MAX_STOCK_QUANTITY`` — a scanned EAN in
    the quantity field, a stray row of nines — is not a believable quantity
    either, and is treated exactly like "ca. 6": not a number.
    """
    if isinstance(raw, bool):
        return None
    text = str(raw) if isinstance(raw, (int, float)) else str(raw or "")
    parsed = parse_quantity_text(_complete_half_typed(text.strip()))
    if parsed is None or abs(parsed) > MAX_STOCK_QUANTITY:
        return None
    return parsed


def _reported_quantity(raw: object) -> int | None:
    """A report's ``qty`` as a whole number of pieces, or None if it says none.

    None means the row does not say how many were fitted — "ca. 6" has always
    had that answer — and ``record_reported_usage`` leaves its line as it
    was. A negative number counts as nothing fitted; a fraction rounds half to
    even, as ``round()`` always did.
    """
    parsed = parse_report_quantity(raw)
    if parsed is None:
        return None
    if parsed <= 0:
        return 0
    return int(parsed.to_integral_value(rounding=ROUND_HALF_EVEN))


def _task_material_id(raw: object) -> int | None:
    """A row's ``task_material_id`` when it can name a line, else None.

    An id outside the int4 range cannot belong to any row, and must not reach
    the query either: SQLite refuses to bind an integer that wide.
    """
    if isinstance(raw, bool) or not isinstance(raw, int):
        return None
    if not 1 <= raw <= INT32_MAX:
        return None
    return raw


def _report_speaks_for(
    task: Task,
    *,
    project_id: int | None,
    customer_id: int | None,
    may_report_on_customer_task: Callable[[Task], bool],
) -> bool:
    """Whether a report anchored to this project/customer may write the task's crate.

    The line ids come from the request body, so they prove nothing: the
    report's own anchor decides. A project report speaks for the tasks of
    that project, whose access the report route has already checked. A report
    without a project speaks only for a customer-only task — never for a
    project's crate, which has a project report for that — and only one its
    author could complete (``may_report_on_customer_task``), of the customer
    the report names when it names one.
    """
    if project_id is not None:
        return task.project_id == project_id
    if task.project_id is not None:
        return False
    if customer_id is not None and task.customer_id != customer_id:
        return False
    return may_report_on_customer_task(task)


def record_reported_usage(
    db: Session,
    *,
    project_id: int | None,
    customer_id: int | None,
    source_task_id: int | None,
    rows: list[dict],
    may_report_on_customer_task: Callable[[Task], bool],
) -> int:
    """Write a report's consumed-material rows back onto the task's lines.

    Only rows that carry a ``task_material_id`` count — those were prefilled
    from the task, so the report is talking about the crate. A hand-typed row
    says nothing about the crate and is ignored. When at least one row refers
    to the task, every line of that task that the report does *not* mention is
    recorded as unused (``quantity_used = 0``): the person on site deleted it
    from the list because it went back in the crate.

    ``project_id`` / ``customer_id`` are the report's own anchor, and only a
    task the report speaks for is written (``_report_speaks_for``); ids naming
    any other task's lines are ignored like hand-typed rows, and the report
    is still filed. ``may_report_on_customer_task`` answers, for a report
    without a project, whether its author could complete that customer-only
    task themselves.

    A row that names a line but whose ``qty`` is not a quantity
    (``parse_report_quantity``: "ca. 6", "inf", a scanned EAN) still mentions
    that line and still refers to the task, but does not say how many were
    fitted: its line keeps whatever it had (``None`` — settled as fully
    fitted — or an earlier report's number). Writing 0 there would book the
    whole line back to the shelf although the fitter kept the row. When the
    same line has a readable row too, the readable one counts. Settled lines
    are never touched — their stock has been booked.

    Returns the number of lines updated. Caller commits.
    """
    referenced: dict[int, int] = {}
    unreadable: set[int] = set()
    for row in rows:
        material_id = _task_material_id(row.get("task_material_id"))
        if material_id is None:
            continue
        quantity = _reported_quantity(row.get("qty"))
        if quantity is None:
            unreadable.add(material_id)
            continue
        referenced[material_id] = quantity
    unreadable -= referenced.keys()
    mentioned_ids = referenced.keys() | unreadable
    if not mentioned_ids:
        return 0

    mentioned = db.scalars(select(TaskMaterial).where(TaskMaterial.id.in_(sorted(mentioned_ids)))).all()
    task_ids = {material.task_id for material in mentioned}
    if source_task_id is not None:
        task_ids &= {source_task_id}
    if len(task_ids) != 1:
        return 0
    (task_id,) = task_ids
    task = db.get(Task, task_id)
    if task is None or not _report_speaks_for(
        task,
        project_id=project_id,
        customer_id=customer_id,
        may_report_on_customer_task=may_report_on_customer_task,
    ):
        return 0

    updated = 0
    for line in task_materials(db, task_id):
        if line.settled_at is not None or line.id in unreadable:
            continue
        line.quantity_used = referenced.get(line.id, 0)
        db.add(line)
        updated += 1
    if updated:
        db.flush()
    return updated
