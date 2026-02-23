"""add project_material_needs table

Revision ID: 20260224_0023
Revises: 20260224_0022
Create Date: 2026-02-24 15:10:00.000000
"""

from __future__ import annotations
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260224_0023"
down_revision: Union[str, Sequence[str], None] = "20260224_0022"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "project_material_needs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column("construction_report_id", sa.Integer(), nullable=True),
        sa.Column("item", sa.String(length=500), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="order"),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("updated_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["construction_report_id"], ["construction_reports.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["updated_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_project_material_needs_project_id"), "project_material_needs", ["project_id"], unique=False)
    op.create_index(
        op.f("ix_project_material_needs_construction_report_id"),
        "project_material_needs",
        ["construction_report_id"],
        unique=False,
    )
    op.create_index(op.f("ix_project_material_needs_status"), "project_material_needs", ["status"], unique=False)
    op.create_index(op.f("ix_project_material_needs_created_by"), "project_material_needs", ["created_by"], unique=False)
    op.create_index(op.f("ix_project_material_needs_updated_by"), "project_material_needs", ["updated_by"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_project_material_needs_updated_by"), table_name="project_material_needs")
    op.drop_index(op.f("ix_project_material_needs_created_by"), table_name="project_material_needs")
    op.drop_index(op.f("ix_project_material_needs_status"), table_name="project_material_needs")
    op.drop_index(op.f("ix_project_material_needs_construction_report_id"), table_name="project_material_needs")
    op.drop_index(op.f("ix_project_material_needs_project_id"), table_name="project_material_needs")
    op.drop_table("project_material_needs")
