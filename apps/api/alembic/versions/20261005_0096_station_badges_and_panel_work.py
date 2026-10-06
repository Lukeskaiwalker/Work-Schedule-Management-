"""Personal station badges and the time a person spends on a Verteiler.

* ``station_badges`` -- one personal code per user (the DataMatrix on their
  badge), hashed for the lookup and encrypted for re-display, exactly like
  ``calendar_feeds`` (``models/station.StationBadge``). Scanning it at the rack
  stands in for tapping a name and clocks the person in and out of a board.
* ``panel_work_sessions`` -- who worked on which board from when to when
  (``models/schaltplan.PanelWorkSession``). Job costing for the Materialliste,
  not attendance; ``clock_entries`` is untouched. At most one open session per
  person, held by a partial unique index.

Two new tables, no data change: every existing row count stays as it was.
Badges are minted lazily, the first time somebody opens their own.

Revision ID: 20261005_0096
Revises: 20260927_0095
Create Date: 2026-10-05
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20261005_0096"
down_revision: Union[str, Sequence[str], None] = "20260927_0095"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "station_badges",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("code_encrypted", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("last_used_at", sa.DateTime(), nullable=True),
        sa.Column("use_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index("ix_station_badges_user_id", "station_badges", ["user_id"], unique=True)
    op.create_index("ix_station_badges_code_hash", "station_badges", ["code_hash"], unique=True)

    op.create_table(
        "panel_work_sessions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("panel_id", sa.Integer(), sa.ForeignKey("panel_plans.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("ended_at", sa.DateTime(), nullable=True),
        sa.Column("station_id", sa.Integer(), sa.ForeignKey("stations.id", ondelete="SET NULL"), nullable=True),
        sa.Column("ended_via", sa.String(length=16), nullable=True),
        sa.Column("ended_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_panel_work_sessions_panel_id", "panel_work_sessions", ["panel_id"])
    op.create_index("ix_panel_work_sessions_user_id", "panel_work_sessions", ["user_id"])
    op.create_index("ix_panel_work_sessions_ended_at", "panel_work_sessions", ["ended_at"])
    op.create_index("ix_panel_work_sessions_station_id", "panel_work_sessions", ["station_id"])
    # The rule "a person is on at most one board at a time" lives in the
    # database, so two stations scanning the same badge cannot both open one.
    op.create_index(
        "ux_panel_work_sessions_one_open_per_user",
        "panel_work_sessions",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("ended_at IS NULL"),
        sqlite_where=sa.text("ended_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("ux_panel_work_sessions_one_open_per_user", table_name="panel_work_sessions")
    op.drop_index("ix_panel_work_sessions_station_id", table_name="panel_work_sessions")
    op.drop_index("ix_panel_work_sessions_ended_at", table_name="panel_work_sessions")
    op.drop_index("ix_panel_work_sessions_user_id", table_name="panel_work_sessions")
    op.drop_index("ix_panel_work_sessions_panel_id", table_name="panel_work_sessions")
    op.drop_table("panel_work_sessions")
    op.drop_index("ix_station_badges_code_hash", table_name="station_badges")
    op.drop_index("ix_station_badges_user_id", table_name="station_badges")
    op.drop_table("station_badges")
