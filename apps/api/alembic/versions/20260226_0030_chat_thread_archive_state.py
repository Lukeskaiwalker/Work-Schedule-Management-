"""chat thread archive state

Revision ID: 20260226_0030
Revises: 20260226_0029
Create Date: 2026-02-26 23:30:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260226_0030"
down_revision: Union[str, Sequence[str], None] = "20260226_0029"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "chat_threads",
        sa.Column("status", sa.String(length=16), nullable=False, server_default=sa.text("'active'")),
    )
    op.add_column("chat_threads", sa.Column("archived_at", sa.DateTime(), nullable=True))
    op.add_column(
        "chat_threads",
        sa.Column("archived_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
    )
    op.create_index("ix_chat_threads_status", "chat_threads", ["status"], unique=False)
    op.create_index("ix_chat_threads_archived_by", "chat_threads", ["archived_by"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_chat_threads_archived_by", table_name="chat_threads")
    op.drop_index("ix_chat_threads_status", table_name="chat_threads")
    op.drop_column("chat_threads", "archived_by")
    op.drop_column("chat_threads", "archived_at")
    op.drop_column("chat_threads", "status")
