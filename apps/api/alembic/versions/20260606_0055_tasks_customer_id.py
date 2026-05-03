"""tasks: add customer_id + relax project_id NOT NULL

The user requested customer-scoped tasks ("for calls n stuff") that
don't require a project. This migration:

  1. Adds a nullable customer_id FK on tasks (CASCADE when the
     customer is deleted — same semantics as project_id, since a
     task without its anchor record is orphan data).
  2. Drops the NOT NULL constraint on project_id so a task can be
     customer-only.
  3. Adds a CHECK constraint requiring at least one of
     (project_id, customer_id) to be non-null. Tasks must be anchored
     to *something* — neither is data we want.

Both columns are kept independent rather than collapsing them into a
"target_id + target_type" polymorphic key because the existing schema
already uses project_id heavily across the codebase, and the
double-FK form lets a single task be linked to both (a customer task
that's also project-scoped — e.g. "Call John about project X").

Backfill is not required because all existing rows already have
project_id set (the column was NOT NULL prior to this migration), so
the new CHECK constraint is satisfied for every legacy row without
any additional work.

Revision ID: 20260606_0055
Revises: 20260605_0054
Create Date: 2026-05-03 19:00:00.000000
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260606_0055"
down_revision: Union[str, Sequence[str], None] = "20260605_0054"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Add the new customer_id column.
    op.add_column(
        "tasks",
        sa.Column("customer_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_tasks_customer_id",
        source_table="tasks",
        referent_table="customers",
        local_cols=["customer_id"],
        remote_cols=["id"],
        ondelete="CASCADE",
    )
    op.create_index(
        "ix_tasks_customer_id",
        "tasks",
        ["customer_id"],
    )

    # 2. Make project_id nullable. Use batch_alter_table so SQLite
    #    (test environment) can recreate the table — Postgres will run
    #    the ALTER directly.
    with op.batch_alter_table("tasks") as batch_op:
        batch_op.alter_column(
            "project_id",
            existing_type=sa.Integer(),
            nullable=True,
        )

    # 3. Add the at-least-one anchor CHECK constraint. Operators can
    #    still see this value via ALTER TABLE ... DROP CONSTRAINT in an
    #    emergency, but the application layer rejects it earlier.
    op.create_check_constraint(
        "ck_tasks_project_or_customer",
        "tasks",
        "project_id IS NOT NULL OR customer_id IS NOT NULL",
    )


def downgrade() -> None:
    op.drop_constraint("ck_tasks_project_or_customer", "tasks", type_="check")
    with op.batch_alter_table("tasks") as batch_op:
        batch_op.alter_column(
            "project_id",
            existing_type=sa.Integer(),
            nullable=False,
        )
    op.drop_index("ix_tasks_customer_id", table_name="tasks")
    op.drop_constraint("fk_tasks_customer_id", "tasks", type_="foreignkey")
    op.drop_column("tasks", "customer_id")
