"""Link a task to a real construction box

Adds ``tasks.construction_box_id`` — the task's link to a
``werkstatt_construction_boxes`` row, chosen from a picker in the task form.

Deliberately does NOT touch ``tasks.storage_box_number``. That column holds
free-typed crate numbers with no constraint beyond ``ge=1`` (the integration
suite stores 7 and 9), so adding validation or repurposing it would break live
data. The two coexist: the server mirrors a linked box's rack ``slot`` into
``storage_box_number`` so every existing reader of that field stays correct.

Also deliberately does NOT backfill historical tasks whose ``storage_box_number``
happens to fall in 1..8. Those numbers *probably* meant the rack, but "probably"
is not good enough to rewrite production history — confirmed with the product
owner on 2026-08-06. If that changes, the backfill is a later migration:

    UPDATE tasks SET construction_box_id = (
        SELECT b.id FROM werkstatt_construction_boxes b
        WHERE b.slot = tasks.storage_box_number
    )
    WHERE tasks.storage_box_number BETWEEN 1 AND 8
      AND tasks.construction_box_id IS NULL;

NOTE: the SQLite test path builds its schema with ``Base.metadata.create_all``
(tests/conftest.py), so this migration only ever runs against Postgres and is
never exercised by the test suite. Review it by hand.

Revision ID: 20260807_0061
Revises: 20260806_0060
Create Date: 2026-08-07 00:00:00.000000
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260807_0061"
down_revision: Union[str, Sequence[str], None] = "20260806_0060"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("construction_box_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_tasks_construction_box_id",
        "tasks",
        "werkstatt_construction_boxes",
        ["construction_box_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_tasks_construction_box_id", "tasks", ["construction_box_id"])


def downgrade() -> None:
    op.drop_index("ix_tasks_construction_box_id", table_name="tasks")
    op.drop_constraint("fk_tasks_construction_box_id", "tasks", type_="foreignkey")
    op.drop_column("tasks", "construction_box_id")
