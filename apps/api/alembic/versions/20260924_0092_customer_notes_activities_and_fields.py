"""Customers that work like projects: note feed, change log, firm vs person.

Four things the customer page lacked next to the project page:

* ``customer_notes`` — the note feed (the single ``customers.notes`` text
  becomes the first entry, author unknown, dated with the row's last
  update), exactly like ``project_notes`` did for projects in 0090.
* ``customer_activities`` — customer-level events for the change log,
  which so far was only the union of the project logs.
* ``customers.customer_type`` / ``mobile`` — the form treated every
  customer as a private person and knew one phone number.
* ``customers.visit_summary`` / ``visit_date`` / ``visit_by_user_id`` —
  what the first visit to a new customer found, printed at the head of
  the Projektbericht.

Revision ID: 20260924_0092
Revises: 20260923_0091
Create Date: 2026-09-24
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260924_0092"
down_revision: Union[str, Sequence[str], None] = "20260923_0091"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

VISIT_FK = "fk_customers_visit_by_user_id_users"


def upgrade() -> None:
    with op.batch_alter_table("customers") as batch:
        batch.add_column(sa.Column("customer_type", sa.String(length=16), nullable=True))
        batch.add_column(sa.Column("mobile", sa.String(length=128), nullable=True))
        batch.add_column(sa.Column("visit_summary", sa.Text(), nullable=True))
        batch.add_column(sa.Column("visit_date", sa.Date(), nullable=True))
        batch.add_column(sa.Column("visit_by_user_id", sa.Integer(), nullable=True))
        batch.create_foreign_key(VISIT_FK, "users", ["visit_by_user_id"], ["id"], ondelete="SET NULL")

    op.create_table(
        "customer_notes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("customer_id", sa.Integer(), sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("author_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_customer_notes_customer_id", "customer_notes", ["customer_id"])
    op.create_index("ix_customer_notes_author_user_id", "customer_notes", ["author_user_id"])
    op.create_index("ix_customer_notes_created_at", "customer_notes", ["created_at"])

    op.create_table(
        "customer_activities",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("customer_id", sa.Integer(), sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("actor_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("event_type", sa.String(length=64), nullable=False),
        sa.Column("message", sa.String(length=255), nullable=False),
        sa.Column("details", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_customer_activities_customer_id", "customer_activities", ["customer_id"])
    op.create_index("ix_customer_activities_actor_user_id", "customer_activities", ["actor_user_id"])
    op.create_index("ix_customer_activities_created_at", "customer_activities", ["created_at"])

    # The old note becomes the first entry of the feed — portable SQL, as
    # the same statement runs on PostgreSQL in production and on a
    # developer's SQLite file.
    op.execute(
        sa.text(
            "INSERT INTO customer_notes (customer_id, author_user_id, body, created_at) "
            "SELECT id, NULL, notes, COALESCE(updated_at, created_at) "
            "FROM customers "
            "WHERE notes IS NOT NULL AND TRIM(notes) <> ''"
        )
    )


def downgrade() -> None:
    op.drop_index("ix_customer_activities_created_at", table_name="customer_activities")
    op.drop_index("ix_customer_activities_actor_user_id", table_name="customer_activities")
    op.drop_index("ix_customer_activities_customer_id", table_name="customer_activities")
    op.drop_table("customer_activities")
    op.drop_index("ix_customer_notes_created_at", table_name="customer_notes")
    op.drop_index("ix_customer_notes_author_user_id", table_name="customer_notes")
    op.drop_index("ix_customer_notes_customer_id", table_name="customer_notes")
    op.drop_table("customer_notes")
    with op.batch_alter_table("customers") as batch:
        batch.drop_constraint(VISIT_FK, type_="foreignkey")
        batch.drop_column("visit_by_user_id")
        batch.drop_column("visit_date")
        batch.drop_column("visit_summary")
        batch.drop_column("mobile")
        batch.drop_column("customer_type")
