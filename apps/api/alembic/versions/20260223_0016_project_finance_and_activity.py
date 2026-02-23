"""add project finance, project activities, and project last_updated_at

Revision ID: 20260223_0016
Revises: 20260222_0015
Create Date: 2026-02-23 09:10:00.000000
"""

from __future__ import annotations
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260223_0016"
down_revision: Union[str, Sequence[str], None] = "20260222_0015"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("projects", sa.Column("last_updated_at", sa.DateTime(), nullable=True))

    op.execute(
        """
        UPDATE projects
        SET last_updated_at = COALESCE(last_status_at, created_at, CURRENT_TIMESTAMP)
        WHERE last_updated_at IS NULL
        """
    )

    op.create_table(
        "project_finances",
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column("order_value_net", sa.Float(), nullable=True),
        sa.Column("down_payment_35", sa.Float(), nullable=True),
        sa.Column("main_components_50", sa.Float(), nullable=True),
        sa.Column("final_invoice_15", sa.Float(), nullable=True),
        sa.Column("planned_costs", sa.Float(), nullable=True),
        sa.Column("actual_costs", sa.Float(), nullable=True),
        sa.Column("contribution_margin", sa.Float(), nullable=True),
        sa.Column("updated_by", sa.Integer(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["updated_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("project_id"),
    )
    op.create_index("ix_project_finances_updated_by", "project_finances", ["updated_by"], unique=False)

    op.create_table(
        "project_activities",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column("actor_user_id", sa.Integer(), nullable=True),
        sa.Column("event_type", sa.String(length=64), nullable=False),
        sa.Column("message", sa.String(length=255), nullable=False),
        sa.Column("details", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["actor_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_project_activities_project_id", "project_activities", ["project_id"], unique=False)
    op.create_index("ix_project_activities_actor_user_id", "project_activities", ["actor_user_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_project_activities_actor_user_id", table_name="project_activities")
    op.drop_index("ix_project_activities_project_id", table_name="project_activities")
    op.drop_table("project_activities")

    op.drop_index("ix_project_finances_updated_by", table_name="project_finances")
    op.drop_table("project_finances")

    op.drop_column("projects", "last_updated_at")
