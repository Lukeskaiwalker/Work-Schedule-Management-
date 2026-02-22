from __future__ import annotations
"""add chat thread icons, creators and unread read-state tracking

Revision ID: 20260220_0008
Revises: 20260219_0007
Create Date: 2026-02-20
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "20260220_0008"
down_revision: Union[str, Sequence[str], None] = "20260219_0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("chat_threads", sa.Column("created_by", sa.Integer(), nullable=True))
    op.add_column("chat_threads", sa.Column("icon_stored_path", sa.String(length=500), nullable=True))
    op.add_column("chat_threads", sa.Column("icon_content_type", sa.String(length=128), nullable=True))
    op.add_column("chat_threads", sa.Column("icon_updated_at", sa.DateTime(), nullable=True))
    op.add_column("chat_threads", sa.Column("updated_at", sa.DateTime(), nullable=True))

    op.create_index("ix_chat_threads_created_by", "chat_threads", ["created_by"], unique=False)
    op.create_foreign_key(
        "fk_chat_threads_created_by_users",
        "chat_threads",
        "users",
        ["created_by"],
        ["id"],
        ondelete="SET NULL",
    )

    op.execute(
        """
        UPDATE chat_threads
        SET created_by = (
            SELECT id FROM users ORDER BY id ASC LIMIT 1
        )
        WHERE created_by IS NULL
        """
    )

    op.create_table(
        "chat_thread_reads",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("thread_id", sa.Integer(), sa.ForeignKey("chat_threads.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("last_read_message_id", sa.Integer(), nullable=True),
        sa.Column("last_read_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint("thread_id", "user_id", name="uq_chat_thread_read"),
    )
    op.create_index("ix_chat_thread_reads_thread_id", "chat_thread_reads", ["thread_id"], unique=False)
    op.create_index("ix_chat_thread_reads_user_id", "chat_thread_reads", ["user_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_chat_thread_reads_user_id", table_name="chat_thread_reads")
    op.drop_index("ix_chat_thread_reads_thread_id", table_name="chat_thread_reads")
    op.drop_table("chat_thread_reads")

    op.drop_constraint("fk_chat_threads_created_by_users", "chat_threads", type_="foreignkey")
    op.drop_index("ix_chat_threads_created_by", table_name="chat_threads")
    op.drop_column("chat_threads", "updated_at")
    op.drop_column("chat_threads", "icon_updated_at")
    op.drop_column("chat_threads", "icon_content_type")
    op.drop_column("chat_threads", "icon_stored_path")
    op.drop_column("chat_threads", "created_by")
