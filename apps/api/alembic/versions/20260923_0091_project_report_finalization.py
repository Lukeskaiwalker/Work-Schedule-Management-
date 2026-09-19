"""Where the finalized Projektbericht lives.

The project report is rendered live from the project's data while the
project runs — Stammdaten, tasks, the note feed, the construction reports,
materials, files — so "appending" is nothing to do: the next preview simply
shows everything there is. When the project is marked abgeschlossen or
archived, the rendering of that moment is stored as a PDF in the project's
Berichte folder, and these two columns say when and which file.

Revision ID: 20260923_0091
Revises: 20260922_0090
Create Date: 2026-09-23
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260923_0091"
down_revision: Union[str, Sequence[str], None] = "20260922_0090"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

FK = "fk_projects_report_attachment_id"
INDEX = "ix_projects_report_attachment_id"


def upgrade() -> None:
    # batch mode: SQLite cannot add a foreign key in place, and the same code
    # runs against the SQLite file a developer keeps locally.
    with op.batch_alter_table("projects") as batch:
        batch.add_column(sa.Column("report_finalized_at", sa.DateTime(), nullable=True))
        batch.add_column(sa.Column("report_attachment_id", sa.Integer(), nullable=True))
        batch.create_foreign_key(FK, "attachments", ["report_attachment_id"], ["id"], ondelete="SET NULL")
        batch.create_index(INDEX, ["report_attachment_id"])


def downgrade() -> None:
    with op.batch_alter_table("projects") as batch:
        batch.drop_index(INDEX)
        batch.drop_constraint(FK, type_="foreignkey")
        batch.drop_column("report_attachment_id")
        batch.drop_column("report_finalized_at")
