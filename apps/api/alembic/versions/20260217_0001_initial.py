from __future__ import annotations
"""initial schema

Revision ID: 20260217_0001
Revises:
Create Date: 2026-02-17
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "20260217_0001"
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("password_hash", sa.String(length=255), nullable=False),
        sa.Column("full_name", sa.String(length=255), nullable=False),
        sa.Column("role", sa.String(length=32), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)
    op.create_index("ix_users_role", "users", ["role"], unique=False)

    op.create_table(
        "projects",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=64), nullable=False),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )

    op.create_table(
        "project_members",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("can_manage", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.UniqueConstraint("project_id", "user_id", name="uq_project_member"),
    )
    op.create_index("ix_project_members_project_id", "project_members", ["project_id"], unique=False)
    op.create_index("ix_project_members_user_id", "project_members", ["user_id"], unique=False)

    op.create_table(
        "tasks",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=64), nullable=False),
        sa.Column("due_date", sa.Date(), nullable=True),
        sa.Column("assignee_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("week_start", sa.Date(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_tasks_project_id", "tasks", ["project_id"], unique=False)
    op.create_index("ix_tasks_assignee_id", "tasks", ["assignee_id"], unique=False)
    op.create_index("ix_tasks_week_start", "tasks", ["week_start"], unique=False)

    op.create_table(
        "sites",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("address", sa.String(length=500), nullable=False),
    )
    op.create_index("ix_sites_project_id", "sites", ["project_id"], unique=False)

    op.create_table(
        "job_tickets",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("site_id", sa.Integer(), sa.ForeignKey("sites.id", ondelete="SET NULL"), nullable=True),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("site_address", sa.String(length=500), nullable=False),
        sa.Column("ticket_date", sa.Date(), nullable=False),
        sa.Column("assigned_crew", sa.JSON(), nullable=False),
        sa.Column("checklist", sa.JSON(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
    )
    op.create_index("ix_job_tickets_project_id", "job_tickets", ["project_id"], unique=False)
    op.create_index("ix_job_tickets_site_id", "job_tickets", ["site_id"], unique=False)

    op.create_table(
        "chat_threads",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("site_id", sa.Integer(), sa.ForeignKey("sites.id", ondelete="SET NULL"), nullable=True),
        sa.Column("name", sa.String(length=255), nullable=False),
    )
    op.create_index("ix_chat_threads_project_id", "chat_threads", ["project_id"], unique=False)
    op.create_index("ix_chat_threads_site_id", "chat_threads", ["site_id"], unique=False)

    op.create_table(
        "messages",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("thread_id", sa.Integer(), sa.ForeignKey("chat_threads.id", ondelete="CASCADE"), nullable=False),
        sa.Column("sender_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_messages_thread_id", "messages", ["thread_id"], unique=False)
    op.create_index("ix_messages_sender_id", "messages", ["sender_id"], unique=False)

    op.create_table(
        "construction_reports",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=False),
        sa.Column("report_date", sa.Date(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("telegram_sent", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_construction_reports_project_id", "construction_reports", ["project_id"], unique=False)
    op.create_index("ix_construction_reports_user_id", "construction_reports", ["user_id"], unique=False)

    op.create_table(
        "attachments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=True),
        sa.Column("site_id", sa.Integer(), sa.ForeignKey("sites.id", ondelete="SET NULL"), nullable=True),
        sa.Column("job_ticket_id", sa.Integer(), sa.ForeignKey("job_tickets.id", ondelete="SET NULL"), nullable=True),
        sa.Column("message_id", sa.Integer(), sa.ForeignKey("messages.id", ondelete="SET NULL"), nullable=True),
        sa.Column(
            "construction_report_id",
            sa.Integer(),
            sa.ForeignKey("construction_reports.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("uploaded_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=False),
        sa.Column("file_name", sa.String(length=255), nullable=False),
        sa.Column("content_type", sa.String(length=128), nullable=False),
        sa.Column("stored_path", sa.String(length=500), nullable=False),
        sa.Column("is_encrypted", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_attachments_project_id", "attachments", ["project_id"], unique=False)
    op.create_index("ix_attachments_site_id", "attachments", ["site_id"], unique=False)
    op.create_index("ix_attachments_job_ticket_id", "attachments", ["job_ticket_id"], unique=False)
    op.create_index("ix_attachments_message_id", "attachments", ["message_id"], unique=False)
    op.create_index(
        "ix_attachments_construction_report_id", "attachments", ["construction_report_id"], unique=False
    )
    op.create_index("ix_attachments_uploaded_by", "attachments", ["uploaded_by"], unique=False)
    op.create_index("ix_attachments_stored_path", "attachments", ["stored_path"], unique=True)

    op.create_table(
        "clock_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("clock_in", sa.DateTime(), nullable=False),
        sa.Column("clock_out", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_clock_entries_user_id", "clock_entries", ["user_id"], unique=False)

    op.create_table(
        "break_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("clock_entry_id", sa.Integer(), sa.ForeignKey("clock_entries.id", ondelete="CASCADE"), nullable=False),
        sa.Column("break_start", sa.DateTime(), nullable=False),
        sa.Column("break_end", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_break_entries_clock_entry_id", "break_entries", ["clock_entry_id"], unique=False)

    op.create_table(
        "audit_logs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("actor_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("action", sa.String(length=255), nullable=False),
        sa.Column("target_type", sa.String(length=128), nullable=False),
        sa.Column("target_id", sa.String(length=128), nullable=False),
        sa.Column("details", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_audit_logs_actor_user_id", "audit_logs", ["actor_user_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_audit_logs_actor_user_id", table_name="audit_logs")
    op.drop_table("audit_logs")
    op.drop_index("ix_break_entries_clock_entry_id", table_name="break_entries")
    op.drop_table("break_entries")
    op.drop_index("ix_clock_entries_user_id", table_name="clock_entries")
    op.drop_table("clock_entries")
    op.drop_index("ix_attachments_stored_path", table_name="attachments")
    op.drop_index("ix_attachments_uploaded_by", table_name="attachments")
    op.drop_index("ix_attachments_construction_report_id", table_name="attachments")
    op.drop_index("ix_attachments_message_id", table_name="attachments")
    op.drop_index("ix_attachments_job_ticket_id", table_name="attachments")
    op.drop_index("ix_attachments_site_id", table_name="attachments")
    op.drop_index("ix_attachments_project_id", table_name="attachments")
    op.drop_table("attachments")
    op.drop_index("ix_construction_reports_user_id", table_name="construction_reports")
    op.drop_index("ix_construction_reports_project_id", table_name="construction_reports")
    op.drop_table("construction_reports")
    op.drop_index("ix_messages_sender_id", table_name="messages")
    op.drop_index("ix_messages_thread_id", table_name="messages")
    op.drop_table("messages")
    op.drop_index("ix_chat_threads_site_id", table_name="chat_threads")
    op.drop_index("ix_chat_threads_project_id", table_name="chat_threads")
    op.drop_table("chat_threads")
    op.drop_index("ix_job_tickets_site_id", table_name="job_tickets")
    op.drop_index("ix_job_tickets_project_id", table_name="job_tickets")
    op.drop_table("job_tickets")
    op.drop_index("ix_sites_project_id", table_name="sites")
    op.drop_table("sites")
    op.drop_index("ix_tasks_week_start", table_name="tasks")
    op.drop_index("ix_tasks_assignee_id", table_name="tasks")
    op.drop_index("ix_tasks_project_id", table_name="tasks")
    op.drop_table("tasks")
    op.drop_index("ix_project_members_user_id", table_name="project_members")
    op.drop_index("ix_project_members_project_id", table_name="project_members")
    op.drop_table("project_members")
    op.drop_table("projects")
    op.drop_index("ix_users_role", table_name="users")
    op.drop_index("ix_users_email", table_name="users")
    op.drop_table("users")
