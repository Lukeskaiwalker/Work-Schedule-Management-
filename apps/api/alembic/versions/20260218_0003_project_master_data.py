from __future__ import annotations
"""project master data fields

Revision ID: 20260218_0003
Revises: 20260218_0002
Create Date: 2026-02-18
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "20260218_0003"
down_revision: Union[str, Sequence[str], None] = "20260218_0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("projects", sa.Column("project_number", sa.String(length=64), nullable=True))
    op.add_column("projects", sa.Column("customer_name", sa.String(length=255), nullable=True))
    op.add_column("projects", sa.Column("customer_address", sa.String(length=500), nullable=True))
    op.add_column("projects", sa.Column("customer_contact", sa.String(length=255), nullable=True))
    op.add_column("projects", sa.Column("customer_email", sa.String(length=255), nullable=True))
    op.add_column("projects", sa.Column("customer_phone", sa.String(length=128), nullable=True))

    op.execute("UPDATE projects SET project_number = CAST(id AS TEXT) WHERE project_number IS NULL")
    op.alter_column("projects", "project_number", existing_type=sa.String(length=64), nullable=False)
    op.create_index("ix_projects_project_number", "projects", ["project_number"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_projects_project_number", table_name="projects")
    op.drop_column("projects", "customer_phone")
    op.drop_column("projects", "customer_email")
    op.drop_column("projects", "customer_contact")
    op.drop_column("projects", "customer_address")
    op.drop_column("projects", "customer_name")
    op.drop_column("projects", "project_number")
