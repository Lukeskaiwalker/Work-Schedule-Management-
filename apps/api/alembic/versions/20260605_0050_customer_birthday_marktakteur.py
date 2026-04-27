"""customer.birthday + customer.marktakteur_nummer

Adds two optional columns to the `customers` table:

  * `birthday`            — calendar Date for individual contacts
  * `marktakteur_nummer`  — String(64) carrying the Marktstammdatenregister
                            ID for customers that operate a PV / energy
                            installation.

Both columns are nullable; no backfill needed.

Revision ID: 20260605_0050
Revises: 20260505_0049
Create Date: 2026-06-05 00:00:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260605_0050"
down_revision: Union[str, Sequence[str], None] = "20260505_0049"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "customers",
        sa.Column("birthday", sa.Date(), nullable=True),
    )
    op.add_column(
        "customers",
        sa.Column("marktakteur_nummer", sa.String(length=64), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("customers", "marktakteur_nummer")
    op.drop_column("customers", "birthday")
