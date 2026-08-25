"""schaltplan: Verteilerpläne (panel schematics) for main and sub panels

One table. The board's rails, devices and circuits live in the ``document``
JSON column rather than in child tables — see ``app/models/schaltplan.py``
for why (the board is edited and read as a whole, and device *order* carries
the electrical topology, which a child table would need a hand-maintained
sort column to preserve).

The unique constraint on (customer_id, designation) is the real content of
this migration: two boards in one building may not both be called "UV1", and
that is a wiring hazard rather than a cosmetic clash.

Revision ID: 20260824_0074
Revises: 20260817_0073
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260824_0074"
down_revision: Union[str, Sequence[str], None] = "20260817_0073"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "panel_plans",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "customer_id",
            sa.Integer(),
            sa.ForeignKey("customers.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "project_id",
            sa.Integer(),
            sa.ForeignKey("projects.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("designation", sa.String(length=32), nullable=False),
        sa.Column("panel_type", sa.String(length=16), nullable=False, server_default="sub"),
        sa.Column("location", sa.String(length=255), nullable=True),
        sa.Column(
            "fed_from_panel_id",
            sa.Integer(),
            # Named FK: SQLite's batch mode needs the constraint name to
            # recreate a self-referential table, and every later ALTER on this
            # table would otherwise fail on SQLite dev databases.
            sa.ForeignKey("panel_plans.id", ondelete="SET NULL", name="fk_panel_plans_fed_from"),
            nullable=True,
        ),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="draft"),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("document", sa.JSON(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("updated_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("customer_id", "designation", name="uq_panel_plan_customer_designation"),
    )
    op.create_index("ix_panel_plans_customer_id", "panel_plans", ["customer_id"])
    op.create_index("ix_panel_plans_project_id", "panel_plans", ["project_id"])
    op.create_index("ix_panel_plans_fed_from_panel_id", "panel_plans", ["fed_from_panel_id"])
    op.create_index("ix_panel_plans_status", "panel_plans", ["status"])


def downgrade() -> None:
    op.drop_table("panel_plans")
