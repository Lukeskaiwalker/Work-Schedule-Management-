"""Article lookup cache, duplicate dismissals, and a survivor pointer.

Three changes, one feature: creating a stock article for something nobody has
stocked before, and cleaning up the duplicates that years without that feature
produced.

``werkstatt_ean_lookups`` caches what an external source said about a GTIN —
hit *and* miss. The miss is the half that matters: the rack station scans the
same unknown code every time another box of it arrives, and without a cached
miss each scan is a fresh outbound scrape inside a request handler.

``werkstatt_duplicate_dismissals`` remembers the pairs a human has already
judged not to be duplicates, stored as an ordered pair (low, high) so the
answer holds whichever way round the finder offers them next time.

``werkstatt_movements.client_request_id`` is the scan station's retry token:
the Pi and the api disagree about what a timeout means, and without it a
delivery the server booked while the wall said "nicht angelegt" gets booked a
second time when the operator scans again.

``werkstatt_articles.merged_into_id`` is what makes a merge non-destructive
from the shelf's point of view: the duplicate row stays (the ledger references
it, and its SP-number is on a printed label), and the scan cascade follows this
pointer so the old sticker resolves to the surviving article.

Revision ID: 20260920_0088
Revises: 20260919_0087
Create Date: 2026-09-20
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260920_0088"
down_revision: Union[str, Sequence[str], None] = "20260919_0087"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

MERGED_FK = "fk_werkstatt_articles_merged_into"
MERGED_INDEX = "ix_werkstatt_articles_merged_into_id"
REQUEST_ID_INDEX = "ix_werkstatt_movements_client_request_id"


def upgrade() -> None:
    op.create_table(
        "werkstatt_ean_lookups",
        # The EAN-13 spelling of the code, so a UPC-A scan and its zero-padded
        # twin share one row rather than scraping twice for one product.
        sa.Column("ean", sa.String(length=32), primary_key=True),
        sa.Column("provider", sa.String(length=64), nullable=True),
        sa.Column("miss", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("item_name", sa.String(length=500), nullable=True),
        sa.Column("manufacturer", sa.String(length=255), nullable=True),
        sa.Column("unit", sa.String(length=64), nullable=True),
        sa.Column("image_url", sa.String(length=1000), nullable=True),
        sa.Column("source_url", sa.String(length=1000), nullable=True),
        sa.Column("fetched_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_werkstatt_ean_lookups_miss", "werkstatt_ean_lookups", ["miss"])

    op.create_table(
        "werkstatt_duplicate_dismissals",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("low_article_id", sa.Integer(), nullable=False),
        sa.Column("high_article_id", sa.Integer(), nullable=False),
        sa.Column("dismissed_by", sa.Integer(), nullable=True),
        sa.Column("dismissed_at", sa.DateTime(), nullable=False),
        # CASCADE: a dismissal is a statement about two rows. If either is
        # deleted the statement has no subject left to be about.
        sa.ForeignKeyConstraint(
            ["low_article_id"], ["werkstatt_articles.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["high_article_id"], ["werkstatt_articles.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["dismissed_by"], ["users.id"], ondelete="SET NULL"),
        sa.UniqueConstraint("low_article_id", "high_article_id", name="uq_wdd_pair"),
    )
    op.create_index(
        "ix_werkstatt_duplicate_dismissals_low",
        "werkstatt_duplicate_dismissals",
        ["low_article_id"],
    )
    op.create_index(
        "ix_werkstatt_duplicate_dismissals_high",
        "werkstatt_duplicate_dismissals",
        ["high_article_id"],
    )
    op.create_index(
        "ix_werkstatt_duplicate_dismissals_by",
        "werkstatt_duplicate_dismissals",
        ["dismissed_by"],
    )

    # batch mode: SQLite cannot add a foreign key in place, and the same code
    # runs against the SQLite file a developer keeps locally.
    with op.batch_alter_table("werkstatt_articles") as batch:
        batch.add_column(sa.Column("merged_into_id", sa.Integer(), nullable=True))
        batch.create_foreign_key(
            MERGED_FK, "werkstatt_articles", ["merged_into_id"], ["id"], ondelete="SET NULL"
        )
        batch.create_index(MERGED_INDEX, ["merged_into_id"])

    # The station's retry token. Unique so a Wareneingang that timed out on the
    # Pi and was scanned again replays its own answer rather than booking the
    # delivery a second time; nullable because every other caller books once
    # and has nothing to replay.
    with op.batch_alter_table("werkstatt_movements") as batch:
        batch.add_column(sa.Column("client_request_id", sa.String(length=64), nullable=True))
        batch.create_index(REQUEST_ID_INDEX, ["client_request_id"], unique=True)


def downgrade() -> None:
    with op.batch_alter_table("werkstatt_movements") as batch:
        batch.drop_index(REQUEST_ID_INDEX)
        batch.drop_column("client_request_id")

    with op.batch_alter_table("werkstatt_articles") as batch:
        batch.drop_index(MERGED_INDEX)
        batch.drop_constraint(MERGED_FK, type_="foreignkey")
        batch.drop_column("merged_into_id")

    op.drop_index(
        "ix_werkstatt_duplicate_dismissals_by", table_name="werkstatt_duplicate_dismissals"
    )
    op.drop_index(
        "ix_werkstatt_duplicate_dismissals_high", table_name="werkstatt_duplicate_dismissals"
    )
    op.drop_index(
        "ix_werkstatt_duplicate_dismissals_low", table_name="werkstatt_duplicate_dismissals"
    )
    op.drop_table("werkstatt_duplicate_dismissals")

    op.drop_index("ix_werkstatt_ean_lookups_miss", table_name="werkstatt_ean_lookups")
    op.drop_table("werkstatt_ean_lookups")
