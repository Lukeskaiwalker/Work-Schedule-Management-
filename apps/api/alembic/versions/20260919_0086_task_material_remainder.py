"""Record what happened to the material a finished job did not use up.

Completing a task always booked the unused rest back onto the shelf and wiped
the crate. That is one of three things a workshop actually does with it — the
rest often stays in the same crate for the next visit, or moves into a fresh
crate for the same customer — and nothing recorded which of the three it was.

Two columns on the task's material lines carry that answer: the choice the
person made at completion, and the crate the rest ended up in (NULL when it
went back to the rack). They sit on ``task_materials`` rather than on the task
because the line is the thing that was settled, and a line is already the
record of what was fitted.

Revision ID: 20260919_0086
Revises: 20260918_0085
Create Date: 2026-09-19
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260919_0086"
down_revision: Union[str, Sequence[str], None] = "20260918_0085"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

REMAINDER_FK = "fk_task_materials_remainder_box"
REMAINDER_INDEX = "ix_task_materials_remainder_box_id"


def upgrade() -> None:
    # batch mode: SQLite cannot add a foreign key in place, and the same code
    # runs against the SQLite file a developer keeps locally.
    with op.batch_alter_table("task_materials") as batch:
        batch.add_column(
            sa.Column("remainder_disposition", sa.String(length=16), nullable=True)
        )
        batch.add_column(sa.Column("remainder_box_id", sa.Integer(), nullable=True))
        batch.create_foreign_key(
            REMAINDER_FK,
            "werkstatt_construction_boxes",
            ["remainder_box_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch.create_index(REMAINDER_INDEX, ["remainder_box_id"])


def downgrade() -> None:
    with op.batch_alter_table("task_materials") as batch:
        batch.drop_index(REMAINDER_INDEX)
        batch.drop_constraint(REMAINDER_FK, type_="foreignkey")
        batch.drop_column("remainder_box_id")
        batch.drop_column("remainder_disposition")
