"""add project last_state and last_status_at

Revision ID: 20260221_0011
Revises: 20260220_0010
Create Date: 2026-02-21 00:05:00
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20260221_0011"
down_revision = "20260220_0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("projects", sa.Column("last_state", sa.Text(), nullable=True))
    op.add_column("projects", sa.Column("last_status_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column("projects", "last_status_at")
    op.drop_column("projects", "last_state")
