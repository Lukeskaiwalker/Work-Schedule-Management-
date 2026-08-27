"""Give an in-house barcode its own column on werkstatt_articles.

Half the stock could not be scanned. The stock-take station mints a code
("SMPL-XXXXXX") for anything that reaches the shelf without a manufacturer
barcode and prints it on a label, but the offline import deliberately refused
to store that string — correctly, because it was only ever offered the `ean`
column, and an invented code is not a GTIN. Having nowhere else to put it, the
import dropped it. The sticker on the shelf then matched no column in the
database, and every lookup answered "unknown article" for stock that was
plainly there.

The live tablet path made the opposite trade and wrote those codes into `ean`,
which scans but quietly asserts that a manufacturer assigned them.

So: a column that means what the value is. `internal_code` holds codes we
issued; `ean` goes back to meaning only what a manufacturer assigned. The
downgrade folds them back into `ean` rather than dropping them, since by then
they are the only link between a physical label and a row.

Not backfilled here. The codes exist on the labels and in the scanning
station's own database, not in production — recovering them is a one-off
reconciliation against that export, not something a migration can do.

Revision ID: 20260827_0077
Revises: 20260826_0076
Create Date: 2026-08-27
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260827_0077"
down_revision: Union[str, Sequence[str], None] = "20260826_0076"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "werkstatt_articles",
        sa.Column("internal_code", sa.String(length=64), nullable=True),
    )
    op.create_index(
        "ix_werkstatt_articles_internal_code",
        "werkstatt_articles",
        ["internal_code"],
    )
    # Unique only where present, mirroring how `ean` is indexed: two articles
    # may both lack an in-house code, but a printed label must identify one row.
    op.create_index(
        "uq_werkstatt_articles_internal_code",
        "werkstatt_articles",
        ["internal_code"],
        unique=True,
        postgresql_where=sa.text("internal_code IS NOT NULL"),
    )

    # Codes the live tablet path wrote into `ean` belong in the new column.
    # Guarded on the SMPL- prefix: that is the only shape this app mints, and
    # a genuine EAN is digits, so nothing manufacturer-assigned can be caught.
    op.execute(
        sa.text(
            """
            UPDATE werkstatt_articles
               SET internal_code = ean,
                   ean = NULL
             WHERE ean LIKE 'SMPL-%'
            """
        )
    )


def downgrade() -> None:
    # Fold the codes back rather than losing them: after this column exists,
    # it may be the only thing tying a printed label to a row.
    op.execute(
        sa.text(
            """
            UPDATE werkstatt_articles
               SET ean = internal_code
             WHERE internal_code IS NOT NULL
               AND ean IS NULL
            """
        )
    )
    op.drop_index("uq_werkstatt_articles_internal_code", table_name="werkstatt_articles")
    op.drop_index("ix_werkstatt_articles_internal_code", table_name="werkstatt_articles")
    op.drop_column("werkstatt_articles", "internal_code")
