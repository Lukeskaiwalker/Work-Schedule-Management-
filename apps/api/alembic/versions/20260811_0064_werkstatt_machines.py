"""Werkstatt machines: individually tracked units of a catalogue article.

Adds `werkstatt_article_units` plus the two links that let an individual
machine be followed through the system:

  * `werkstatt_movements.unit_id` — the existing append-only ledger gains a
    per-machine dimension, so custody history ("who took it, did it come back")
    is answered from the same table as stock history rather than a parallel one.
  * `werkstatt_locations.customer_id` — an `external` location can name the
    customer whose site it is, making "what is still at Müller" a query.

Nothing existing changes shape: both new columns are nullable and every current
row keeps its meaning. Serialized and fungible stock coexist — an article opts
in through the `is_serialized` flag that has been on `werkstatt_articles` since
the original Werkstatt migration.

Revision ID: 20260811_0064
Revises: 20260808_0063
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260811_0064"
down_revision: Union[str, Sequence[str], None] = "20260808_0063"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "werkstatt_article_units",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("unit_number", sa.String(length=32), nullable=False),
        sa.Column(
            "article_id",
            sa.Integer(),
            sa.ForeignKey("werkstatt_articles.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        # Self-reference for sub-components (a charger that belongs to a drill).
        sa.Column(
            "parent_unit_id",
            sa.Integer(),
            sa.ForeignKey("werkstatt_article_units.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("serial_number", sa.String(length=120), nullable=True),
        sa.Column(
            "status", sa.String(length=32), nullable=False, server_default="verfuegbar"
        ),
        sa.Column(
            "current_location_id",
            sa.Integer(),
            sa.ForeignKey("werkstatt_locations.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "holder_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("booked_from", sa.DateTime(), nullable=True),
        sa.Column("booked_until", sa.DateTime(), nullable=True),
        sa.Column(
            "inspection_required", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
        sa.Column("inspection_interval_days", sa.Integer(), nullable=True),
        sa.Column("last_inspected_at", sa.DateTime(), nullable=True),
        sa.Column("next_inspection_due_at", sa.DateTime(), nullable=True),
        sa.Column("purchased_at", sa.DateTime(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("is_archived", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column(
            "created_by",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )

    # The scanner resolves a machine by this alone, so it has to be unique
    # workshop-wide — that constraint is what makes a scan unambiguous.
    op.create_unique_constraint(
        "uq_werkstatt_article_units_unit_number", "werkstatt_article_units", ["unit_number"]
    )
    op.create_index(
        "ix_werkstatt_article_units_unit_number", "werkstatt_article_units", ["unit_number"]
    )
    op.create_index(
        "ix_werkstatt_article_units_article_id", "werkstatt_article_units", ["article_id"]
    )
    op.create_index(
        "ix_werkstatt_article_units_parent_unit_id",
        "werkstatt_article_units",
        ["parent_unit_id"],
    )
    op.create_index(
        "ix_werkstatt_article_units_serial_number", "werkstatt_article_units", ["serial_number"]
    )
    op.create_index("ix_werkstatt_article_units_status", "werkstatt_article_units", ["status"])
    op.create_index(
        "ix_werkstatt_article_units_current_location_id",
        "werkstatt_article_units",
        ["current_location_id"],
    )
    op.create_index(
        "ix_werkstatt_article_units_holder_user_id",
        "werkstatt_article_units",
        ["holder_user_id"],
    )
    # Drives both the "overdue" list and the DGUV3 due list, which are the two
    # queries the Maschinen tab opens with.
    op.create_index(
        "ix_werkstatt_article_units_booked_until", "werkstatt_article_units", ["booked_until"]
    )
    op.create_index(
        "ix_werkstatt_article_units_next_inspection_due_at",
        "werkstatt_article_units",
        ["next_inspection_due_at"],
    )
    op.create_index(
        "ix_werkstatt_article_units_is_archived", "werkstatt_article_units", ["is_archived"]
    )
    op.create_index(
        "ix_werkstatt_article_units_created_by", "werkstatt_article_units", ["created_by"]
    )

    op.add_column(
        "werkstatt_movements", sa.Column("unit_id", sa.Integer(), nullable=True)
    )
    op.create_foreign_key(
        "fk_werkstatt_movements_unit_id",
        "werkstatt_movements",
        "werkstatt_article_units",
        ["unit_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_werkstatt_movements_unit_id", "werkstatt_movements", ["unit_id"])

    op.add_column(
        "werkstatt_locations", sa.Column("customer_id", sa.Integer(), nullable=True)
    )
    op.create_foreign_key(
        "fk_werkstatt_locations_customer_id",
        "werkstatt_locations",
        "customers",
        ["customer_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_werkstatt_locations_customer_id", "werkstatt_locations", ["customer_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_werkstatt_locations_customer_id", table_name="werkstatt_locations")
    op.drop_constraint(
        "fk_werkstatt_locations_customer_id", "werkstatt_locations", type_="foreignkey"
    )
    op.drop_column("werkstatt_locations", "customer_id")

    op.drop_index("ix_werkstatt_movements_unit_id", table_name="werkstatt_movements")
    op.drop_constraint(
        "fk_werkstatt_movements_unit_id", "werkstatt_movements", type_="foreignkey"
    )
    op.drop_column("werkstatt_movements", "unit_id")

    op.drop_table("werkstatt_article_units")
