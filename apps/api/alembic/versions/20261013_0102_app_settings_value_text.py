"""app_settings.value: VARCHAR(2048) → TEXT

The label printer's runtime settings outgrew 2048 characters. One calibration
record is about 1 KB of JSON, four full custom profiles plus builtin
overrides pass 2 KB, and the calibration lock carries a profile snapshot,
poll codes and a verify snapshot (docs/LABEL_PRINTER_CALIBRATION.md §3.1).
SQLite — the test database — does not enforce a VARCHAR length, so only
production would have failed, with a DataError on save. Every other runtime
setting gains the same headroom.

Downgrade returns to VARCHAR(2048). It is lossy: PostgreSQL refuses the
conversion while a longer value exists, so shorten or delete such values
(the label printer state and lock keys) before downgrading.

Revision ID: 20261013_0102
Revises: 20261010_0101
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20261013_0102"
down_revision: Union[str, Sequence[str], None] = "20261010_0101"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column(
        "app_settings",
        "value",
        existing_type=sa.String(length=2048),
        type_=sa.Text(),
        existing_nullable=False,
    )


def downgrade() -> None:
    op.alter_column(
        "app_settings",
        "value",
        existing_type=sa.Text(),
        type_=sa.String(length=2048),
        existing_nullable=False,
    )
