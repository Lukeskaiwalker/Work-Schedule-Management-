"""Give the Scan-Station page a Pi it can actually reach, and remember imports.

Until now the api knew a station only by its token: it could hear the Pi's
heartbeat but had no way to call back, because the request IP is the office
router (hairpin NAT) and nothing stored where the agent listens. Every button
on the Scan-Station page therefore ended in "Schnittstelle noch nicht
verfügbar". The agent now reports its own LAN address on every heartbeat and
the api stores it — validated to a private address first — next to an
admin-typed override for the day the Pi lives on another subnet.

The three ``source_*`` columns on ``werkstatt_inventory_sessions`` are the
other half: a count session that lives on the Pi is imported into a Werkstatt
inventory, and without recording which station and which Pi session fed the
row, the page cannot say "Übernommen" or route a re-import into the same open
inventory rather than a second one.

Revision ID: 20260918_0085
Revises: 20260918_0084
Create Date: 2026-09-18
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260918_0085"
down_revision: Union[str, Sequence[str], None] = "20260918_0084"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SOURCE_FK = "fk_werkstatt_inventory_sessions_source_station"
SOURCE_INDEX = "ix_werkstatt_inventory_sessions_source_station_id"


def upgrade() -> None:
    # batch mode throughout: SQLite cannot add a foreign key in place, and the
    # same code has to run against the SQLite file a developer keeps locally.
    with op.batch_alter_table("stations") as batch:
        batch.add_column(sa.Column("location", sa.String(length=128), nullable=True))
        batch.add_column(sa.Column("agent_host", sa.String(length=64), nullable=True))
        batch.add_column(sa.Column("agent_port", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("agent_url_override", sa.String(length=200), nullable=True))
        batch.add_column(sa.Column("uptime_seconds", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("session_count", sa.Integer(), nullable=True))

    with op.batch_alter_table("werkstatt_inventory_sessions") as batch:
        batch.add_column(sa.Column("source_station_id", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("source_session_name", sa.String(length=64), nullable=True))
        batch.add_column(sa.Column("source_imported_at", sa.DateTime(), nullable=True))
        batch.create_foreign_key(
            SOURCE_FK, "stations", ["source_station_id"], ["id"], ondelete="SET NULL"
        )
        batch.create_index(SOURCE_INDEX, ["source_station_id"])


def downgrade() -> None:
    with op.batch_alter_table("werkstatt_inventory_sessions") as batch:
        batch.drop_index(SOURCE_INDEX)
        batch.drop_constraint(SOURCE_FK, type_="foreignkey")
        batch.drop_column("source_imported_at")
        batch.drop_column("source_session_name")
        batch.drop_column("source_station_id")

    with op.batch_alter_table("stations") as batch:
        batch.drop_column("session_count")
        batch.drop_column("uptime_seconds")
        batch.drop_column("agent_url_override")
        batch.drop_column("agent_port")
        batch.drop_column("agent_host")
        batch.drop_column("location")
