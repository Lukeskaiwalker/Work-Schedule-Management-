"""Trigram indexes for catalog and Werkstatt article search

Search was doing a sequential scan per keystroke. Every predicate on both
search paths is a leading-wildcard match — ``LIKE '%term%'`` on
``material_catalog_items.search_text`` (a Text column with no index at all) and
``ILIKE '%term%'`` on the Werkstatt article/supplier columns. A leading
wildcard cannot use a B-tree, so the existing indexes on ``item_name`` and
``article_no`` were never consulted for search; with a Datanorm catalog of any
real size that is a full scan on every request.

``pg_trgm`` fixes both halves of the problem at once:

* a GIN index over trigrams makes ``LIKE '%…%'`` index-accelerated, and
* ``similarity()`` gives a real relevance score, which is what lets the query
  layer rank *before* it truncates and tolerate the spelling drift between
  Datanorm suppliers ("Schuko"/"Schucko", "3x1,5"/"3x1.5").

NOTE: the SQLite test path builds its schema with ``Base.metadata.create_all``
(tests/conftest.py), so this migration only ever runs against PostgreSQL.

Extension creation is best-effort on purpose. ``pg_trgm`` is a *trusted*
extension from PostgreSQL 13 onward, so the database owner can create it
without superuser — but a managed/hosted PostgreSQL may still withhold it. If
creation fails we skip the indexes and leave search working on plain LIKE:
``services/search_matching.supports_trigram()`` probes ``pg_extension`` at
runtime and degrades the query builder to match. A search that is slow is
recoverable; a deploy that cannot migrate is not.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260808_0062"
down_revision: Union[str, Sequence[str], None] = "20260807_0061"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (index name, table, expression indexed)
_TRIGRAM_INDEXES: tuple[tuple[str, str, str], ...] = (
    # The catalog's denormalised haystack: article no + name + unit +
    # manufacturer + EAN, already lowercased at import time.
    ("ix_material_catalog_items_search_text_trgm", "material_catalog_items", "search_text"),
    # Werkstatt stock. item-search matches these three directly.
    ("ix_werkstatt_articles_item_name_trgm", "werkstatt_articles", "item_name"),
    ("ix_werkstatt_articles_article_number_trgm", "werkstatt_articles", "article_number"),
    # A wholesaler labels goods with THEIR number, so scanning a supplier
    # barcode resolves through this column.
    (
        "ix_werkstatt_article_suppliers_supplier_article_no_trgm",
        "werkstatt_article_suppliers",
        "supplier_article_no",
    ),
)


def _trigram_available() -> bool:
    """Create pg_trgm if we're allowed to. Returns whether it is usable."""
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return False
    try:
        bind.execute(sa.text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
    except Exception:  # noqa: BLE001 - lack of privilege must not fail the deploy
        return False
    row = bind.execute(
        sa.text("SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'")
    ).first()
    return row is not None


def upgrade() -> None:
    if not _trigram_available():
        return
    bind = op.get_bind()
    for index_name, table_name, column_name in _TRIGRAM_INDEXES:
        # lower(col) matches how the query layer compares, so the index is
        # usable by both the LIKE predicate and the similarity() ordering.
        bind.execute(
            sa.text(
                f"CREATE INDEX IF NOT EXISTS {index_name} "
                f"ON {table_name} USING gin (lower({column_name}) gin_trgm_ops)"
            )
        )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    for index_name, _table_name, _column_name in _TRIGRAM_INDEXES:
        bind.execute(sa.text(f"DROP INDEX IF EXISTS {index_name}"))
    # Deliberately does NOT drop the pg_trgm extension: other objects may come
    # to depend on it, and dropping an extension another migration or a human
    # added is not this migration's call.
