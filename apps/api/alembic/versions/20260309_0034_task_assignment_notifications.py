"""add notifications table for personal task assignment alerts

Revision ID: 20260309_0034
Revises: 20260304_0033
Create Date: 2026-03-09 18:20:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260309_0034"
down_revision: Union[str, Sequence[str], None] = "20260304_0033"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _table_exists(name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return name in inspector.get_table_names()


def _index_names(table_name: str) -> set[str]:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return {idx["name"] for idx in inspector.get_indexes(table_name)}


def upgrade() -> None:
    if not _table_exists("notifications"):
        op.create_table(
            "notifications",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("user_id", sa.Integer(), nullable=False),
            sa.Column("actor_user_id", sa.Integer(), nullable=True),
            sa.Column("event_type", sa.String(length=64), nullable=False),
            sa.Column("entity_type", sa.String(length=32), nullable=False),
            sa.Column("entity_id", sa.Integer(), nullable=True),
            sa.Column("project_id", sa.Integer(), nullable=True),
            sa.Column("message", sa.String(length=255), nullable=False),
            sa.Column("read_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["actor_user_id"], ["users.id"], ondelete="SET NULL"),
            sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
        )

    existing_indexes = _index_names("notifications")
    expected_indexes: list[tuple[str, list[str]]] = [
        ("ix_notifications_actor_user_id", ["actor_user_id"]),
        ("ix_notifications_created_at", ["created_at"]),
        ("ix_notifications_project_id", ["project_id"]),
        ("ix_notifications_read_at", ["read_at"]),
        ("ix_notifications_user_id", ["user_id"]),
    ]
    for index_name, columns in expected_indexes:
        if index_name not in existing_indexes:
            op.create_index(index_name, "notifications", columns, unique=False)


def downgrade() -> None:
    if _table_exists("notifications"):
        op.drop_table("notifications")
