"""werkstatt: Inventur — stock-taking sessions and their counts

Counting is append-only inside an open session and touches no real stock;
only ``finalize`` writes ledger movements. These two tables hold the session
and its per-article counts. See app/models/werkstatt_inventory.py.

Revision ID: 20260825_0075
Revises: 20260824_0074
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260825_0075"
down_revision: Union[str, None] = "20260824_0074"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "werkstatt_inventory_sessions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("status", sa.String(length=16), server_default="open", nullable=False),
        sa.Column("location_id", sa.Integer(), nullable=True),
        sa.Column("started_by", sa.Integer(), nullable=True),
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("finalized_by", sa.Integer(), nullable=True),
        sa.Column("finalized_at", sa.DateTime(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["location_id"], ["werkstatt_locations.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["started_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["finalized_by"], ["users.id"], ondelete="SET NULL"),
    )
    op.create_index(
        "ix_werkstatt_inventory_sessions_status", "werkstatt_inventory_sessions", ["status"]
    )
    op.create_index(
        "ix_werkstatt_inventory_sessions_location_id",
        "werkstatt_inventory_sessions",
        ["location_id"],
    )
    op.create_index(
        "ix_werkstatt_inventory_sessions_started_by", "werkstatt_inventory_sessions", ["started_by"]
    )
    op.create_index(
        "ix_werkstatt_inventory_sessions_finalized_by",
        "werkstatt_inventory_sessions",
        ["finalized_by"],
    )

    op.create_table(
        "werkstatt_inventory_counts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("session_id", sa.Integer(), nullable=False),
        sa.Column("article_id", sa.Integer(), nullable=False),
        sa.Column("counted_qty", sa.Integer(), server_default="0", nullable=False),
        sa.Column("scan_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("expected_qty", sa.Integer(), nullable=True),
        sa.Column("first_counted_at", sa.DateTime(), nullable=False),
        sa.Column("last_counted_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(
            ["session_id"], ["werkstatt_inventory_sessions.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["article_id"], ["werkstatt_articles.id"], ondelete="CASCADE"),
        # The scan endpoint upserts on this: a repeated scan increments the
        # existing row instead of inserting a second line for the same article.
        sa.UniqueConstraint("session_id", "article_id", name="uq_inventory_count_session_article"),
    )
    op.create_index(
        "ix_werkstatt_inventory_counts_session_id", "werkstatt_inventory_counts", ["session_id"]
    )
    op.create_index(
        "ix_werkstatt_inventory_counts_article_id", "werkstatt_inventory_counts", ["article_id"]
    )


def downgrade() -> None:
    op.drop_table("werkstatt_inventory_counts")
    op.drop_table("werkstatt_inventory_sessions")
