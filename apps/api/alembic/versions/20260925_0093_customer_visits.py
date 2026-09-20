"""The Kundenbesuch becomes a feed with an optional project link.

0092 gave the customer one write-up (``visit_summary`` / ``visit_date`` /
``visit_by_user_id``), overwritten on every edit and printed at the head of
every Projektbericht of the customer. A customer is visited more than once
— a returning customer for a new job — and a write-up is often about one
project, not the customer as such. So the write-up moves into
``customer_visits``: one row per visit, an optional ``project_id`` that
must be one of the customer's projects, and the report of a project opens
with the rows linked to it plus the unlinked ones.

The existing write-up becomes the first entry (unlinked, dated as before,
with the same visitor), and the three columns go — one place for the
visit, not two.

Revision ID: 20260925_0093
Revises: 20260924_0092
Create Date: 2026-09-25
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260925_0093"
down_revision: Union[str, Sequence[str], None] = "20260924_0092"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

VISIT_FK = "fk_customers_visit_by_user_id_users"


def upgrade() -> None:
    op.create_table(
        "customer_visits",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("customer_id", sa.Integer(), sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id", ondelete="SET NULL"), nullable=True),
        sa.Column("visit_date", sa.Date(), nullable=True),
        sa.Column("visit_by_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_customer_visits_customer_id", "customer_visits", ["customer_id"])
    op.create_index("ix_customer_visits_project_id", "customer_visits", ["project_id"])
    op.create_index("ix_customer_visits_visit_by_user_id", "customer_visits", ["visit_by_user_id"])
    op.create_index("ix_customer_visits_created_at", "customer_visits", ["created_at"])

    # The one write-up a customer had becomes the feed's first entry —
    # portable SQL, as the same statement runs on PostgreSQL in production
    # and on a developer's SQLite file.
    op.execute(
        sa.text(
            "INSERT INTO customer_visits "
            "(customer_id, project_id, visit_date, visit_by_user_id, summary, created_at, updated_at) "
            "SELECT id, NULL, visit_date, visit_by_user_id, visit_summary, "
            "COALESCE(updated_at, created_at), COALESCE(updated_at, created_at) "
            "FROM customers "
            "WHERE visit_summary IS NOT NULL AND TRIM(visit_summary) <> ''"
        )
    )

    with op.batch_alter_table("customers") as batch:
        batch.drop_constraint(VISIT_FK, type_="foreignkey")
        batch.drop_column("visit_by_user_id")
        batch.drop_column("visit_date")
        batch.drop_column("visit_summary")


def downgrade() -> None:
    with op.batch_alter_table("customers") as batch:
        batch.add_column(sa.Column("visit_summary", sa.Text(), nullable=True))
        batch.add_column(sa.Column("visit_date", sa.Date(), nullable=True))
        batch.add_column(sa.Column("visit_by_user_id", sa.Integer(), nullable=True))
        batch.create_foreign_key(VISIT_FK, "users", ["visit_by_user_id"], ["id"], ondelete="SET NULL")

    # The single write-up of the old shape is the newest entry of the feed;
    # the others have no place to go back to.
    for column, source in (
        ("visit_summary", "summary"),
        ("visit_date", "visit_date"),
        ("visit_by_user_id", "visit_by_user_id"),
    ):
        op.execute(
            sa.text(
                f"UPDATE customers SET {column} = ("
                f"SELECT v.{source} FROM customer_visits v WHERE v.customer_id = customers.id "
                "ORDER BY v.created_at DESC, v.id DESC LIMIT 1)"
            )
        )

    op.drop_index("ix_customer_visits_created_at", table_name="customer_visits")
    op.drop_index("ix_customer_visits_visit_by_user_id", table_name="customer_visits")
    op.drop_index("ix_customer_visits_project_id", table_name="customer_visits")
    op.drop_index("ix_customer_visits_customer_id", table_name="customer_visits")
    op.drop_table("customer_visits")
