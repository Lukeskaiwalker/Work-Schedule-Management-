"""Mark the ledger rows a scan station booked.

``werkstatt_movements.user_id`` is NOT NULL and a wall-mounted Pi is not a
person, so a station borrows a name to book under — its owner, the
administrator who approved the pairing (see
``routers/workflow_station_werkstatt.resolve_station_user_id``). That is the
only honest attribution available, and it has a cost: without a column of its
own, a row booked by a device on the workshop wall is indistinguishable from
that administrator sitting at their desk booking it. ``notes`` carried a
"Regal-Station …" marker, but notes are caller-supplied free text — the device
could overwrite the marker, and anything a caller can erase is not evidence.

``station_id`` is the fact in a column: NULL for a person's booking, the
station's id for a device's, so "what did the rack screen do today" and "did a
human book this write-off" are both plain queries.

ON DELETE SET NULL, matching how the rest of this schema treats attribution:
unpairing or deleting a station must not delete or block ledger history, and a
movement that has lost its station is still a real movement. Indexed because
the only reason to store it is to filter on it.

NOTE: the SQLite test path builds its schema with ``Base.metadata.create_all``
(tests/conftest.py), so the Postgres branch below is what production runs and
the SQLite branch exists only so this file can be exercised forward and back on
a scratch database.

Revision ID: 20260910_0080
Revises: 20260827_0079
Create Date: 2026-09-10
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260910_0080"
down_revision: Union[str, Sequence[str], None] = "20260827_0079"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

FK_NAME = "fk_werkstatt_movements_station_id"
INDEX_NAME = "ix_werkstatt_movements_station_id"


def upgrade() -> None:
    if op.get_bind().dialect.name == "sqlite":
        # SQLite cannot ALTER a constraint into an existing table; batch mode
        # recreates it instead.
        with op.batch_alter_table("werkstatt_movements") as batch_op:
            batch_op.add_column(sa.Column("station_id", sa.Integer(), nullable=True))
            batch_op.create_foreign_key(
                FK_NAME, "stations", ["station_id"], ["id"], ondelete="SET NULL"
            )
    else:
        op.add_column("werkstatt_movements", sa.Column("station_id", sa.Integer(), nullable=True))
        op.create_foreign_key(
            FK_NAME,
            "werkstatt_movements",
            "stations",
            ["station_id"],
            ["id"],
            ondelete="SET NULL",
        )
    op.create_index(INDEX_NAME, "werkstatt_movements", ["station_id"])


def downgrade() -> None:
    # The index goes first either way: SQLite refuses to drop an indexed column.
    op.drop_index(INDEX_NAME, table_name="werkstatt_movements")
    if op.get_bind().dialect.name == "sqlite":
        # The recreated table simply has neither the column nor its constraint.
        with op.batch_alter_table("werkstatt_movements") as batch_op:
            batch_op.drop_column("station_id")
    else:
        op.drop_constraint(FK_NAME, "werkstatt_movements", type_="foreignkey")
        op.drop_column("werkstatt_movements", "station_id")
