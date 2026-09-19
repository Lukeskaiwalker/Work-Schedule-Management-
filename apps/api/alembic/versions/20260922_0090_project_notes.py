"""Project note feed.

The "Interne Notiz" on the project overview was one text field that the
office overwrote several times a day, so the history was gone the moment
it was written and nobody could say who had noted what, or when.
``project_notes`` turns it into a feed: one row per posting, with author
and time, read newest-first like a chat.

The old text is not thrown away: every project whose ``description`` holds
a note gets that text as its first entry, dated with the project's last
update and without an author (there is no way to know one). The
``description`` column stays as it is — nothing else reads it as a note
any more, and dropping a column with data in it is not this migration's
decision to make.

Revision ID: 20260922_0090
Revises: 20260921_0089
Create Date: 2026-09-22
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260922_0090"
down_revision: Union[str, Sequence[str], None] = "20260921_0089"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "project_notes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("author_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_project_notes_project_id", "project_notes", ["project_id"])
    op.create_index("ix_project_notes_author_user_id", "project_notes", ["author_user_id"])
    op.create_index("ix_project_notes_created_at", "project_notes", ["created_at"])
    # Carry the existing note over as the first entry of the feed. Portable
    # SQL on purpose: this runs on PostgreSQL in production and on the SQLite
    # file a developer keeps locally.
    op.execute(
        sa.text(
            "INSERT INTO project_notes (project_id, author_user_id, body, created_at) "
            "SELECT id, NULL, description, COALESCE(last_updated_at, created_at) "
            "FROM projects "
            "WHERE description IS NOT NULL AND TRIM(description) <> ''"
        )
    )


def downgrade() -> None:
    op.drop_index("ix_project_notes_created_at", table_name="project_notes")
    op.drop_index("ix_project_notes_author_user_id", table_name="project_notes")
    op.drop_index("ix_project_notes_project_id", table_name="project_notes")
    op.drop_table("project_notes")
