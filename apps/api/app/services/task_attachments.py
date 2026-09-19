"""Attachments seen from the task: the paperclip count and the rows.

The row itself is an ordinary ``Attachment`` in the task's project or
customer scope (docs/FILE_SCOPES.md); this module only answers the two
questions a task view asks — how many, and which — and takes the rows away
with the task. The count is batched on purpose: the task list renders dozens
of rows and a per-task query would turn one screen into dozens of round
trips, the same reason ``_task_materials_map`` is batched.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.entities import Attachment
from app.schemas.task import TaskOut

logger = logging.getLogger(__name__)


def attachment_counts(db: Session, task_ids: Iterable[int]) -> dict[int, int]:
    """``{task_id: files on it}`` in one grouped query. Tasks without files are
    absent from the result, so callers read it with ``.get(id, 0)``."""
    ids = sorted({int(task_id) for task_id in task_ids if task_id is not None})
    if not ids:
        return {}
    rows = db.execute(
        select(Attachment.task_id, func.count(Attachment.id))
        .where(Attachment.task_id.in_(ids))
        .group_by(Attachment.task_id)
    ).all()
    return {int(task_id): int(count) for task_id, count in rows}


def with_attachment_counts(db: Session, rows: list[TaskOut]) -> list[TaskOut]:
    """The same TaskOut rows with ``attachment_count`` filled from one query.

    Copies rather than mutation: the rows may already have been handed to a
    broadcast, and what was broadcast must stay what was broadcast.
    """
    counts = attachment_counts(db, [row.id for row in rows])
    return [row.model_copy(update={"attachment_count": counts.get(row.id, 0)}) for row in rows]


def list_task_attachments(db: Session, task_id: int) -> list[Attachment]:
    """The task's files, newest first — the order the attachments section shows."""
    return list(
        db.scalars(
            select(Attachment)
            .where(Attachment.task_id == task_id)
            .order_by(Attachment.created_at.desc(), Attachment.id.desc())
        ).all()
    )


def delete_task_attachment_rows(db: Session, task_id: int) -> list[str]:
    """Queue the task's attachment rows for deletion and hand back their
    stored paths, so the caller can unlink the bytes once the delete is
    committed. Nothing is flushed or committed here: the rows leave in the
    same transaction as the task, or not at all.
    """
    rows = list_task_attachments(db, task_id)
    for row in rows:
        db.delete(row)
    return [row.stored_path for row in rows]


def unlink_stored_files(stored_paths: Iterable[str]) -> None:
    """Best-effort: remove the encrypted bytes from disk after the DB commit.

    Same contract as ``delete_file``: the rows are already gone, so a file
    that cannot be removed is an orphan to log, never a reason to fail the
    request that deleted the task.
    """
    for stored_path in stored_paths:
        try:
            Path(stored_path).unlink(missing_ok=True)
        except OSError:
            logger.warning("Stored file %s survived its task's deletion", stored_path)
