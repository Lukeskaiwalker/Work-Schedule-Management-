"""chat restricted participants by role

Revision ID: 20260226_0029
Revises: 20260226_0028
Create Date: 2026-02-26 22:55:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260226_0029"
down_revision: Union[str, Sequence[str], None] = "20260226_0028"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "chat_thread_participant_roles",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("thread_id", sa.Integer(), sa.ForeignKey("chat_threads.id", ondelete="CASCADE"), nullable=False),
        sa.Column("role", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("thread_id", "role", name="uq_chat_thread_participant_role"),
    )
    op.create_index(
        "ix_chat_thread_participant_roles_thread_id",
        "chat_thread_participant_roles",
        ["thread_id"],
        unique=False,
    )
    op.create_index(
        "ix_chat_thread_participant_roles_role",
        "chat_thread_participant_roles",
        ["role"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_chat_thread_participant_roles_role", table_name="chat_thread_participant_roles")
    op.drop_index("ix_chat_thread_participant_roles_thread_id", table_name="chat_thread_participant_roles")
    op.drop_table("chat_thread_participant_roles")
