"""Verteiler numbers, the Materialliste's article mapping, and the ledger's link to a board.

Three things one feature needs:

* ``panel_plans.panel_number`` — ``VT-0007``, printed as a DataMatrix on the
  Schrank-Etikett and scanned at the Regal station. The number is the row
  id, zero padded (``services/schaltplan_panel_numbers.py``), so existing
  boards get theirs from their ids and new boards continue the sequence.
* ``schaltplan_material_articles`` — which stock article a planned line of a
  board's Materialliste means (``device:mcb:1p:b16`` → SP-0152). Global, not
  per board.
* ``werkstatt_movements.panel_id`` — the board a ``consumption`` /
  ``consumption_undo`` ledger row was built into, so the board's list and the
  project's Material tab are sums over the ledger, not a second store.

Revision ID: 20260926_0094
Revises: 20260925_0093
Create Date: 2026-09-26
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260926_0094"
down_revision: Union[str, Sequence[str], None] = "20260925_0093"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

MOVEMENT_PANEL_FK = "fk_werkstatt_movements_panel_id_panel_plans"


def upgrade() -> None:
    # 1. The number: added nullable, filled from the id, then made NOT NULL
    #    and unique. Row by row rather than a dialect-specific lpad/printf:
    #    the same file runs on PostgreSQL in production and on SQLite in a
    #    developer's checkout, and there are a handful of boards, not
    #    thousands.
    with op.batch_alter_table("panel_plans") as batch:
        batch.add_column(sa.Column("panel_number", sa.String(length=16), nullable=True))

    bind = op.get_bind()
    ids = [row[0] for row in bind.execute(sa.text("SELECT id FROM panel_plans ORDER BY id")).fetchall()]
    for plan_id in ids:
        bind.execute(
            sa.text("UPDATE panel_plans SET panel_number = :number WHERE id = :id"),
            {"number": f"VT-{int(plan_id):04d}", "id": plan_id},
        )

    with op.batch_alter_table("panel_plans") as batch:
        batch.alter_column("panel_number", existing_type=sa.String(length=16), nullable=False)
    op.create_index("ix_panel_plans_panel_number", "panel_plans", ["panel_number"], unique=True)

    # 2. The mapping table.
    op.create_table(
        "schaltplan_material_articles",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("part_key", sa.String(length=120), nullable=False),
        sa.Column(
            "article_id",
            sa.Integer(),
            sa.ForeignKey("werkstatt_articles.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index(
        "ix_schaltplan_material_articles_part_key", "schaltplan_material_articles", ["part_key"], unique=True
    )
    op.create_index("ix_schaltplan_material_articles_article_id", "schaltplan_material_articles", ["article_id"])

    # 3. The ledger's link to the board.
    with op.batch_alter_table("werkstatt_movements") as batch:
        batch.add_column(sa.Column("panel_id", sa.Integer(), nullable=True))
        batch.create_foreign_key(MOVEMENT_PANEL_FK, "panel_plans", ["panel_id"], ["id"], ondelete="SET NULL")
    op.create_index("ix_werkstatt_movements_panel_id", "werkstatt_movements", ["panel_id"])


def downgrade() -> None:
    op.drop_index("ix_werkstatt_movements_panel_id", table_name="werkstatt_movements")
    with op.batch_alter_table("werkstatt_movements") as batch:
        batch.drop_constraint(MOVEMENT_PANEL_FK, type_="foreignkey")
        batch.drop_column("panel_id")

    op.drop_index("ix_schaltplan_material_articles_article_id", table_name="schaltplan_material_articles")
    op.drop_index("ix_schaltplan_material_articles_part_key", table_name="schaltplan_material_articles")
    op.drop_table("schaltplan_material_articles")

    op.drop_index("ix_panel_plans_panel_number", table_name="panel_plans")
    with op.batch_alter_table("panel_plans") as batch:
        batch.drop_column("panel_number")
