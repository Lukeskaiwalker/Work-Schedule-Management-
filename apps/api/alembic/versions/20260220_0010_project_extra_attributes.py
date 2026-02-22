"""add project extra attributes json

Revision ID: 20260220_0010
Revises: 20260220_0009
Create Date: 2026-02-20 23:05:00
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20260220_0010"
down_revision = "20260220_0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column("extra_attributes", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )
    op.alter_column("projects", "extra_attributes", server_default=None)


def downgrade() -> None:
    op.drop_column("projects", "extra_attributes")
