from __future__ import annotations
"""add project folders and absence management tables

Revision ID: 20260222_0013
Revises: 20260221_0012
Create Date: 2026-02-22 03:30:00
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


# revision identifiers, used by Alembic.
revision: str = "20260222_0013"
down_revision: Union[str, Sequence[str], None] = "20260221_0012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("attachments", sa.Column("folder_path", sa.String(length=500), nullable=False, server_default=""))
    op.alter_column("attachments", "folder_path", server_default=None)

    op.create_table(
        "project_folders",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column("path", sa.String(length=500), nullable=False),
        sa.Column("is_protected", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "path", name="uq_project_folder_path"),
    )
    op.create_index("ix_project_folders_project_id", "project_folders", ["project_id"], unique=False)

    op.create_table(
        "vacation_requests",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("reviewed_by", sa.Integer(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["reviewed_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_vacation_requests_user_id", "vacation_requests", ["user_id"], unique=False)
    op.create_index("ix_vacation_requests_status", "vacation_requests", ["status"], unique=False)
    op.create_index("ix_vacation_requests_reviewed_by", "vacation_requests", ["reviewed_by"], unique=False)

    op.create_table(
        "school_absences",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=False),
        sa.Column("recurrence_weekday", sa.Integer(), nullable=True),
        sa.Column("recurrence_until", sa.Date(), nullable=True),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_school_absences_user_id", "school_absences", ["user_id"], unique=False)
    op.create_index("ix_school_absences_created_by", "school_absences", ["created_by"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_school_absences_created_by", table_name="school_absences")
    op.drop_index("ix_school_absences_user_id", table_name="school_absences")
    op.drop_table("school_absences")

    op.drop_index("ix_vacation_requests_reviewed_by", table_name="vacation_requests")
    op.drop_index("ix_vacation_requests_status", table_name="vacation_requests")
    op.drop_index("ix_vacation_requests_user_id", table_name="vacation_requests")
    op.drop_table("vacation_requests")

    op.drop_index("ix_project_folders_project_id", table_name="project_folders")
    op.drop_table("project_folders")

    op.drop_column("attachments", "folder_path")
