"""chat visibility restrictions with user/group participants

Revision ID: 20260226_0028
Revises: 20260226_0027
Create Date: 2026-02-26 20:30:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260226_0028"
down_revision: Union[str, Sequence[str], None] = "20260226_0027"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "chat_threads",
        sa.Column("visibility", sa.String(length=16), nullable=False, server_default=sa.text("'public'")),
    )
    op.create_index("ix_chat_threads_visibility", "chat_threads", ["visibility"], unique=False)

    op.create_table(
        "employee_groups",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_employee_groups_name", "employee_groups", ["name"], unique=True)
    op.create_index("ix_employee_groups_created_by", "employee_groups", ["created_by"], unique=False)

    op.create_table(
        "employee_group_members",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("group_id", sa.Integer(), sa.ForeignKey("employee_groups.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("group_id", "user_id", name="uq_employee_group_member"),
    )
    op.create_index("ix_employee_group_members_group_id", "employee_group_members", ["group_id"], unique=False)
    op.create_index("ix_employee_group_members_user_id", "employee_group_members", ["user_id"], unique=False)

    op.create_table(
        "chat_thread_participant_users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("thread_id", sa.Integer(), sa.ForeignKey("chat_threads.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("thread_id", "user_id", name="uq_chat_thread_participant_user"),
    )
    op.create_index(
        "ix_chat_thread_participant_users_thread_id",
        "chat_thread_participant_users",
        ["thread_id"],
        unique=False,
    )
    op.create_index("ix_chat_thread_participant_users_user_id", "chat_thread_participant_users", ["user_id"], unique=False)

    op.create_table(
        "chat_thread_participant_groups",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("thread_id", sa.Integer(), sa.ForeignKey("chat_threads.id", ondelete="CASCADE"), nullable=False),
        sa.Column("group_id", sa.Integer(), sa.ForeignKey("employee_groups.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("thread_id", "group_id", name="uq_chat_thread_participant_group"),
    )
    op.create_index(
        "ix_chat_thread_participant_groups_thread_id",
        "chat_thread_participant_groups",
        ["thread_id"],
        unique=False,
    )
    op.create_index(
        "ix_chat_thread_participant_groups_group_id",
        "chat_thread_participant_groups",
        ["group_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_chat_thread_participant_groups_group_id", table_name="chat_thread_participant_groups")
    op.drop_index("ix_chat_thread_participant_groups_thread_id", table_name="chat_thread_participant_groups")
    op.drop_table("chat_thread_participant_groups")

    op.drop_index("ix_chat_thread_participant_users_user_id", table_name="chat_thread_participant_users")
    op.drop_index("ix_chat_thread_participant_users_thread_id", table_name="chat_thread_participant_users")
    op.drop_table("chat_thread_participant_users")

    op.drop_index("ix_employee_group_members_user_id", table_name="employee_group_members")
    op.drop_index("ix_employee_group_members_group_id", table_name="employee_group_members")
    op.drop_table("employee_group_members")

    op.drop_index("ix_employee_groups_created_by", table_name="employee_groups")
    op.drop_index("ix_employee_groups_name", table_name="employee_groups")
    op.drop_table("employee_groups")

    op.drop_index("ix_chat_threads_visibility", table_name="chat_threads")
    op.drop_column("chat_threads", "visibility")
