from __future__ import annotations
"""add wiki pages

Revision ID: 20260219_0005
Revises: 20260218_0004
Create Date: 2026-02-19
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "20260219_0005"
down_revision: Union[str, Sequence[str], None] = "20260218_0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "wiki_pages",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("slug", sa.String(length=255), nullable=False),
        sa.Column("category", sa.String(length=120), nullable=True),
        sa.Column("content", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("updated_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
    )
    op.create_index("ix_wiki_pages_slug", "wiki_pages", ["slug"], unique=True)
    op.create_index("ix_wiki_pages_created_by", "wiki_pages", ["created_by"], unique=False)
    op.create_index("ix_wiki_pages_updated_by", "wiki_pages", ["updated_by"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_wiki_pages_updated_by", table_name="wiki_pages")
    op.drop_index("ix_wiki_pages_created_by", table_name="wiki_pages")
    op.drop_index("ix_wiki_pages_slug", table_name="wiki_pages")
    op.drop_table("wiki_pages")
