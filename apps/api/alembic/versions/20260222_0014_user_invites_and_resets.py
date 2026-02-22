"""add user invite/reset tracking and action tokens

Revision ID: 20260222_0014
Revises: 20260222_0013
Create Date: 2026-02-22 20:40:00.000000
"""

from __future__ import annotations
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "20260222_0014"
down_revision: Union[str, Sequence[str], None] = "20260222_0013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("invite_sent_at", sa.DateTime(), nullable=True))
    op.add_column("users", sa.Column("invite_accepted_at", sa.DateTime(), nullable=True))
    op.add_column("users", sa.Column("password_reset_sent_at", sa.DateTime(), nullable=True))

    op.create_table(
        "user_action_tokens",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("purpose", sa.String(length=32), nullable=False),
        sa.Column("token_hash", sa.String(length=128), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("used_at", sa.DateTime(), nullable=True),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token_hash"),
    )
    op.create_index("ix_user_action_tokens_user_id", "user_action_tokens", ["user_id"], unique=False)
    op.create_index("ix_user_action_tokens_purpose", "user_action_tokens", ["purpose"], unique=False)
    op.create_index("ix_user_action_tokens_token_hash", "user_action_tokens", ["token_hash"], unique=False)
    op.create_index("ix_user_action_tokens_created_by", "user_action_tokens", ["created_by"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_user_action_tokens_created_by", table_name="user_action_tokens")
    op.drop_index("ix_user_action_tokens_token_hash", table_name="user_action_tokens")
    op.drop_index("ix_user_action_tokens_purpose", table_name="user_action_tokens")
    op.drop_index("ix_user_action_tokens_user_id", table_name="user_action_tokens")
    op.drop_table("user_action_tokens")

    op.drop_column("users", "password_reset_sent_at")
    op.drop_column("users", "invite_accepted_at")
    op.drop_column("users", "invite_sent_at")
