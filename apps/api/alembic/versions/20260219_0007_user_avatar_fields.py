from __future__ import annotations
"""add user avatar metadata fields

Revision ID: 20260219_0007
Revises: 20260219_0006
Create Date: 2026-02-19
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "20260219_0007"
down_revision: Union[str, Sequence[str], None] = "20260219_0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("avatar_stored_path", sa.String(length=500), nullable=True))
    op.add_column("users", sa.Column("avatar_content_type", sa.String(length=128), nullable=True))
    op.add_column("users", sa.Column("avatar_updated_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "avatar_updated_at")
    op.drop_column("users", "avatar_content_type")
    op.drop_column("users", "avatar_stored_path")
