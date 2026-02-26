"""add per-project construction report numbers

Revision ID: 20260225_0026
Revises: 20260224_0025
Create Date: 2026-02-25 10:15:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260225_0026"
down_revision: Union[str, Sequence[str], None] = "20260224_0025"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("construction_reports", sa.Column("report_number", sa.Integer(), nullable=True))

    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT id, project_id FROM construction_reports "
            "WHERE project_id IS NOT NULL "
            "ORDER BY project_id ASC, id ASC"
        )
    ).fetchall()
    current_project_id: int | None = None
    current_number = 0
    for row in rows:
        row_id = int(row[0])
        project_id = int(row[1])
        if project_id != current_project_id:
            current_project_id = project_id
            current_number = 1
        else:
            current_number += 1
        bind.execute(
            sa.text("UPDATE construction_reports SET report_number = :report_number WHERE id = :row_id"),
            {"report_number": current_number, "row_id": row_id},
        )

    op.create_unique_constraint(
        "uq_construction_report_project_number",
        "construction_reports",
        ["project_id", "report_number"],
    )


def downgrade() -> None:
    op.drop_constraint("uq_construction_report_project_number", "construction_reports", type_="unique")
    op.drop_column("construction_reports", "report_number")
