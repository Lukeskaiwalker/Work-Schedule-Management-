"""add project class templates and assignments

Revision ID: 20260224_0019
Revises: 20260223_0018
Create Date: 2026-02-24 00:25:00.000000
"""

from __future__ import annotations
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260224_0019"
down_revision: Union[str, Sequence[str], None] = "20260223_0018"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "project_class_templates",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("materials_required", sa.Text(), nullable=True),
        sa.Column("tools_required", sa.Text(), nullable=True),
        sa.Column("task_templates", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_project_class_templates_name", "project_class_templates", ["name"], unique=True)
    op.create_index("ix_project_class_templates_created_by", "project_class_templates", ["created_by"], unique=False)
    op.alter_column("project_class_templates", "task_templates", server_default=None)

    op.create_table(
        "project_class_assignments",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column("class_template_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["class_template_id"], ["project_class_templates.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "class_template_id", name="uq_project_class_assignment"),
    )
    op.create_index("ix_project_class_assignments_project_id", "project_class_assignments", ["project_id"], unique=False)
    op.create_index(
        "ix_project_class_assignments_class_template_id",
        "project_class_assignments",
        ["class_template_id"],
        unique=False,
    )

    op.add_column("tasks", sa.Column("class_template_id", sa.Integer(), nullable=True))
    op.create_index("ix_tasks_class_template_id", "tasks", ["class_template_id"], unique=False)
    op.create_foreign_key(
        "fk_tasks_class_template_id_project_class_templates",
        "tasks",
        "project_class_templates",
        ["class_template_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_tasks_class_template_id_project_class_templates", "tasks", type_="foreignkey")
    op.drop_index("ix_tasks_class_template_id", table_name="tasks")
    op.drop_column("tasks", "class_template_id")

    op.drop_index("ix_project_class_assignments_class_template_id", table_name="project_class_assignments")
    op.drop_index("ix_project_class_assignments_project_id", table_name="project_class_assignments")
    op.drop_table("project_class_assignments")

    op.drop_index("ix_project_class_templates_created_by", table_name="project_class_templates")
    op.drop_index("ix_project_class_templates_name", table_name="project_class_templates")
    op.drop_table("project_class_templates")
