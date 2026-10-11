"""Partner portal: logins bound to a partner, projects handed to partners, their hours.

* ``users.partner_id`` -- set only on partner-portal logins (role
  ``external``). SET NULL so a vanished partner leaves an orphan login the
  portal refuses rather than deleting audit history with it.
* ``project_partners`` -- a project given to a partner as a whole, with the
  office's note for them. Same shape as ``task_partners``, plus the note.
* ``partner_time_entries`` -- hours a partner's crew reports on a task or a
  project (one day, N people, H hours each). Task SET NULL with the project
  copied in, so deleting a task keeps the hours on the project; a report
  taken back is marked (``deleted_at``), not erased.

No backfill: no existing user is a partner login, no project has been
handed to a partner yet, and nobody has reported partner hours.

Revision ID: 20261009_0098
Revises: 20261006_0097
Create Date: 2026-10-09 00:00:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261009_0098"
down_revision: Union[str, Sequence[str], None] = "20261006_0097"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "partner_id",
            sa.Integer(),
            sa.ForeignKey("partners.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index("ix_users_partner_id", "users", ["partner_id"])

    op.create_table(
        "project_partners",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column("partner_id", sa.Integer(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["partner_id"], ["partners.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "partner_id", name="uq_project_partner"),
    )
    op.create_index("ix_project_partners_project_id", "project_partners", ["project_id"])
    op.create_index("ix_project_partners_partner_id", "project_partners", ["partner_id"])

    op.create_table(
        "partner_time_entries",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("partner_id", sa.Integer(), nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=True),
        sa.Column("task_id", sa.Integer(), nullable=True),
        sa.Column("work_date", sa.Date(), nullable=False),
        sa.Column("workers", sa.Integer(), nullable=False),
        sa.Column("hours", sa.Float(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("reported_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(), nullable=True),
        sa.Column("deleted_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["partner_id"], ["partners.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["reported_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["deleted_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_partner_time_entries_partner_id", "partner_time_entries", ["partner_id"])
    op.create_index("ix_partner_time_entries_project_id", "partner_time_entries", ["project_id"])
    op.create_index("ix_partner_time_entries_task_id", "partner_time_entries", ["task_id"])


def downgrade() -> None:
    op.drop_index("ix_partner_time_entries_task_id", table_name="partner_time_entries")
    op.drop_index("ix_partner_time_entries_project_id", table_name="partner_time_entries")
    op.drop_index("ix_partner_time_entries_partner_id", table_name="partner_time_entries")
    op.drop_table("partner_time_entries")
    op.drop_index("ix_project_partners_partner_id", table_name="project_partners")
    op.drop_index("ix_project_partners_project_id", table_name="project_partners")
    op.drop_table("project_partners")
    op.drop_index("ix_users_partner_id", table_name="users")
    op.drop_column("users", "partner_id")
