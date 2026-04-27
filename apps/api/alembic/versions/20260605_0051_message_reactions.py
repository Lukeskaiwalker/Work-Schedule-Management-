"""message_reactions table

Stores per-user emoji reactions on chat thread messages. The
(message_id, user_id, emoji) triple is unique so the same user can react
with multiple emojis to a message but not double-stack the same one.

Cascades from `messages.id` and `users.id` are ON DELETE CASCADE so
deleting a message or removing a user automatically tidies up their
reactions.

Revision ID: 20260605_0051
Revises: 20260605_0050
Create Date: 2026-06-05 00:30:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260605_0051"
down_revision: Union[str, Sequence[str], None] = "20260605_0050"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "message_reactions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "message_id",
            sa.Integer(),
            sa.ForeignKey("messages.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("emoji", sa.String(length=32), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "message_id", "user_id", "emoji", name="uq_message_reaction"
        ),
    )


def downgrade() -> None:
    op.drop_table("message_reactions")
