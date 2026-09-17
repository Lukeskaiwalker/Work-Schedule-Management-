"""Remember which order a material need went into.

A Bedarf and a Bestellung were two unconnected lists: the office pushed a
need into the wholesaler's basket and the row stayed on "Bestellen" forever,
because nothing recorded that it had been ordered at all. The same need was
then ordered twice, or crossed off by hand and lost.

These three columns are that record. `werkstatt_order_line_id` is the precise
one — a line is what was actually bought — and `werkstatt_order_id` survives
the line being deleted so the row can still say where it went. Both are
SET NULL on delete: an order being cancelled must put its needs back on the
list, never take them with it.

`ordered_at` is stamped at hand-off, not derived from the order, so a need
that was moved between drafts still says when it left the Bedarfe view.

Revision ID: 20260919_0087
Revises: 20260919_0086
Create Date: 2026-09-19
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260919_0087"
down_revision: Union[str, Sequence[str], None] = "20260919_0086"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ORDER_FK = "fk_project_material_needs_werkstatt_order"
LINE_FK = "fk_project_material_needs_werkstatt_order_line"
ORDER_INDEX = "ix_project_material_needs_werkstatt_order_id"
LINE_INDEX = "ix_project_material_needs_werkstatt_order_line_id"


def upgrade() -> None:
    # batch mode: SQLite cannot add a foreign key in place, and the same code
    # runs against the SQLite file a developer keeps locally.
    with op.batch_alter_table("project_material_needs") as batch:
        batch.add_column(sa.Column("werkstatt_order_id", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("werkstatt_order_line_id", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("ordered_at", sa.DateTime(), nullable=True))
        batch.create_foreign_key(
            ORDER_FK, "werkstatt_orders", ["werkstatt_order_id"], ["id"], ondelete="SET NULL"
        )
        batch.create_foreign_key(
            LINE_FK,
            "werkstatt_order_lines",
            ["werkstatt_order_line_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch.create_index(ORDER_INDEX, ["werkstatt_order_id"])
        batch.create_index(LINE_INDEX, ["werkstatt_order_line_id"])


def downgrade() -> None:
    with op.batch_alter_table("project_material_needs") as batch:
        batch.drop_index(LINE_INDEX)
        batch.drop_index(ORDER_INDEX)
        batch.drop_constraint(LINE_FK, type_="foreignkey")
        batch.drop_constraint(ORDER_FK, type_="foreignkey")
        batch.drop_column("ordered_at")
        batch.drop_column("werkstatt_order_line_id")
        batch.drop_column("werkstatt_order_id")
