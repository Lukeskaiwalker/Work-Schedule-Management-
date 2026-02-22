from __future__ import annotations
"""allow construction reports without project

Revision ID: 20260219_0006
Revises: 20260219_0005
Create Date: 2026-02-19
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "20260219_0006"
down_revision: Union[str, Sequence[str], None] = "20260219_0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column(
        "construction_reports",
        "project_id",
        existing_type=sa.Integer(),
        nullable=True,
    )


def downgrade() -> None:
    op.execute("DELETE FROM construction_reports WHERE project_id IS NULL")
    op.alter_column(
        "construction_reports",
        "project_id",
        existing_type=sa.Integer(),
        nullable=False,
    )
