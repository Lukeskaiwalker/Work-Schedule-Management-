"""add construction report processing queue

Revision ID: 20260224_0025
Revises: 20260224_0024
Create Date: 2026-02-24 23:20:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260224_0025"
down_revision: Union[str, Sequence[str], None] = "20260224_0024"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "construction_reports",
        sa.Column("telegram_mode", sa.String(length=16), nullable=False, server_default="stub"),
    )
    op.add_column(
        "construction_reports",
        sa.Column("processing_status", sa.String(length=32), nullable=False, server_default="queued"),
    )
    op.add_column("construction_reports", sa.Column("processing_error", sa.Text(), nullable=True))
    op.add_column("construction_reports", sa.Column("processed_at", sa.DateTime(), nullable=True))
    op.add_column("construction_reports", sa.Column("pdf_file_name", sa.String(length=255), nullable=True))
    op.create_index(
        op.f("ix_construction_reports_processing_status"),
        "construction_reports",
        ["processing_status"],
        unique=False,
    )
    op.execute(
        "UPDATE construction_reports SET processing_status = 'completed', "
        "processed_at = COALESCE(processed_at, created_at), telegram_mode = COALESCE(telegram_mode, 'stub')"
    )

    op.create_table(
        "construction_report_jobs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("construction_report_id", sa.Integer(), nullable=False),
        sa.Column("send_telegram", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="queued"),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="3"),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["construction_report_id"], ["construction_reports.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("construction_report_id", name="uq_construction_report_job_report"),
    )
    op.create_index(
        op.f("ix_construction_report_jobs_construction_report_id"),
        "construction_report_jobs",
        ["construction_report_id"],
        unique=False,
    )
    op.create_index(op.f("ix_construction_report_jobs_status"), "construction_report_jobs", ["status"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_construction_report_jobs_status"), table_name="construction_report_jobs")
    op.drop_index(op.f("ix_construction_report_jobs_construction_report_id"), table_name="construction_report_jobs")
    op.drop_table("construction_report_jobs")

    op.drop_index(op.f("ix_construction_reports_processing_status"), table_name="construction_reports")
    op.drop_column("construction_reports", "pdf_file_name")
    op.drop_column("construction_reports", "processed_at")
    op.drop_column("construction_reports", "processing_error")
    op.drop_column("construction_reports", "processing_status")
    op.drop_column("construction_reports", "telegram_mode")
