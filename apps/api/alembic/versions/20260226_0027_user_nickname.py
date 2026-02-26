"""add optional user nickname with uniqueness

Revision ID: 20260226_0027
Revises: 20260225_0026
Create Date: 2026-02-26 11:00:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260226_0027"
down_revision: Union[str, Sequence[str], None] = "20260225_0026"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("nickname", sa.String(length=64), nullable=True))
    op.add_column("users", sa.Column("nickname_normalized", sa.String(length=64), nullable=True))
    op.add_column("users", sa.Column("nickname_set_at", sa.DateTime(), nullable=True))
    op.create_index("ix_users_nickname_normalized", "users", ["nickname_normalized"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_users_nickname_normalized", table_name="users")
    op.drop_column("users", "nickname_set_at")
    op.drop_column("users", "nickname_normalized")
    op.drop_column("users", "nickname")
