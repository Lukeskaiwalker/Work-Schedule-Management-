"""add task start time and materials fields

Revision ID: 20260221_0012
Revises: 20260221_0011
Create Date: 2026-02-21 01:00:00
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20260221_0012"
down_revision = "20260221_0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("materials_required", sa.Text(), nullable=True))
    op.add_column("tasks", sa.Column("storage_box_number", sa.Integer(), nullable=True))
    op.add_column("tasks", sa.Column("start_time", sa.Time(), nullable=True))


def downgrade() -> None:
    op.drop_column("tasks", "start_time")
    op.drop_column("tasks", "storage_box_number")
    op.drop_column("tasks", "materials_required")
