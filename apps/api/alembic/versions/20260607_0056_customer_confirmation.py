"""tasks: customer-confirmation columns + customers.language

Adds the v2.5.0 customer-confirmation feature. The operator can request
a confirmation per task (auto-checked for construction-type tasks).
The customer either clicks an email link (token-based public endpoint,
no auth) or the operator records a phone confirmation manually. The
status drives a colored dot indicator visible on every task surface.

Schema additions (all nullable, default null so legacy tasks are
unaffected — they implicitly land in "confirmation not requested"):

  tasks.customer_confirmation_status         "pending" | "confirmed" | "declined"
  tasks.customer_confirmation_at             DateTime  (set on confirmed | declined)
  tasks.customer_confirmation_method         "email" | "phone" | "manual"
  tasks.customer_confirmation_by_user_id     FK users.id (null when customer self-served)
  tasks.customer_confirmation_notes          Text (free-form, operator can add context)
  tasks.customer_confirmation_token          String (32-hex unique token for the email link)
  tasks.customer_confirmation_email_sent_at  DateTime (last email send timestamp)

Plus an index on customer_confirmation_token so the unauthenticated
public endpoint can resolve a token → task in one row lookup.

customers.language is added (nullable) to drive the email template's
language choice. Null falls back to "de" (the business is German).

Token expiry is computed at confirmation time from the task's due_date
(``today >= due_date`` → expired), so we don't carry a stored expiry
column that would drift on every due_date update.

Revision ID: 20260607_0056
Revises: 20260606_0055
Create Date: 2026-05-05 11:00:00.000000
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260607_0056"
down_revision: Union[str, Sequence[str], None] = "20260606_0055"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Tasks: confirmation columns (all nullable).
    op.add_column("tasks", sa.Column("customer_confirmation_status", sa.String(length=16), nullable=True))
    op.add_column("tasks", sa.Column("customer_confirmation_at", sa.DateTime(), nullable=True))
    op.add_column("tasks", sa.Column("customer_confirmation_method", sa.String(length=16), nullable=True))
    op.add_column(
        "tasks",
        sa.Column(
            "customer_confirmation_by_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column("tasks", sa.Column("customer_confirmation_notes", sa.Text(), nullable=True))
    op.add_column("tasks", sa.Column("customer_confirmation_token", sa.String(length=64), nullable=True))
    op.add_column("tasks", sa.Column("customer_confirmation_email_sent_at", sa.DateTime(), nullable=True))

    # Public-endpoint lookup index. UNIQUE because the token must
    # uniquely identify a single task; collisions are impossible with a
    # 32-hex random but the constraint is cheap insurance.
    op.create_index(
        "ix_tasks_customer_confirmation_token",
        "tasks",
        ["customer_confirmation_token"],
        unique=True,
    )

    # Customers: preferred email language. Null → German fallback.
    op.add_column("customers", sa.Column("language", sa.String(length=8), nullable=True))


def downgrade() -> None:
    op.drop_column("customers", "language")
    op.drop_index("ix_tasks_customer_confirmation_token", table_name="tasks")
    op.drop_column("tasks", "customer_confirmation_email_sent_at")
    op.drop_column("tasks", "customer_confirmation_token")
    op.drop_column("tasks", "customer_confirmation_notes")
    op.drop_column("tasks", "customer_confirmation_by_user_id")
    op.drop_column("tasks", "customer_confirmation_method")
    op.drop_column("tasks", "customer_confirmation_at")
    op.drop_column("tasks", "customer_confirmation_status")
