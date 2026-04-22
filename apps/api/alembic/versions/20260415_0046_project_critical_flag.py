"""add critical flag + audit columns to projects

Revision ID: 20260415_0046
Revises: 20260410_0045
Create Date: 2026-04-15 00:00:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260415_0046"
down_revision: Union[str, Sequence[str], None] = "20260410_0045"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Use batch_alter_table so SQLite (used locally for previews) can add columns
    # with a FK + index in one pass. Postgres just sees the individual ops.
    with op.batch_alter_table("projects", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column("is_critical", sa.Boolean(), nullable=False, server_default=sa.false())
        )
        batch_op.add_column(sa.Column("critical_since", sa.DateTime(), nullable=True))
        batch_op.add_column(sa.Column("critical_set_by_user_id", sa.Integer(), nullable=True))
        batch_op.create_foreign_key(
            "fk_projects_critical_set_by_user_id",
            "users",
            ["critical_set_by_user_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch_op.create_index(
            "ix_projects_critical_set_by_user_id",
            ["critical_set_by_user_id"],
        )
    # Drop server_default once the backfill (false for every existing row) is
    # applied — the app owns the default going forward.
    with op.batch_alter_table("projects", schema=None) as batch_op:
        batch_op.alter_column("is_critical", server_default=None)


def downgrade() -> None:
    with op.batch_alter_table("projects", schema=None) as batch_op:
        batch_op.drop_index("ix_projects_critical_set_by_user_id")
        batch_op.drop_constraint("fk_projects_critical_set_by_user_id", type_="foreignkey")
        batch_op.drop_column("critical_set_by_user_id")
        batch_op.drop_column("critical_since")
        batch_op.drop_column("is_critical")
