"""partners + task_partners tables

Creates the two tables backing the new Partner (external contractor)
feature:

  * `partners`       — first-class contractor entity (name/address/
                       contact/email/phone/trade/tax_id/notes).
                       Soft-archive via `archived_at`, no hard delete.
  * `task_partners`  — join table between `tasks` and `partners`,
                       modelled identically to `task_assignments` so
                       the router sync logic is a mirror.

No backfill: this is net-new, no legacy data to migrate.

Revision ID: 20260505_0049
Revises: 20260501_0048
Create Date: 2026-05-05 00:00:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260505_0049"
down_revision: Union[str, Sequence[str], None] = "20260501_0048"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1) partners ───────────────────────────────────────────────────────
    op.create_table(
        "partners",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("contact_person", sa.String(length=255), nullable=True),
        sa.Column("email", sa.String(length=255), nullable=True),
        sa.Column("phone", sa.String(length=128), nullable=True),
        sa.Column("address", sa.String(length=500), nullable=True),
        sa.Column("trade", sa.String(length=128), nullable=True),
        sa.Column("tax_id", sa.String(length=64), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("archived_at", sa.DateTime(), nullable=True),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_partners_name", "partners", ["name"])
    op.create_index("ix_partners_trade", "partners", ["trade"])
    op.create_index("ix_partners_archived_at", "partners", ["archived_at"])

    # 2) task_partners ──────────────────────────────────────────────────
    op.create_table(
        "task_partners",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("task_id", sa.Integer(), nullable=False),
        sa.Column("partner_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["partner_id"], ["partners.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("task_id", "partner_id", name="uq_task_partner"),
    )
    op.create_index("ix_task_partners_task_id", "task_partners", ["task_id"])
    op.create_index("ix_task_partners_partner_id", "task_partners", ["partner_id"])


def downgrade() -> None:
    op.drop_index("ix_task_partners_partner_id", table_name="task_partners")
    op.drop_index("ix_task_partners_task_id", table_name="task_partners")
    op.drop_table("task_partners")

    op.drop_index("ix_partners_archived_at", table_name="partners")
    op.drop_index("ix_partners_trade", table_name="partners")
    op.drop_index("ix_partners_name", table_name="partners")
    op.drop_table("partners")
