"""One unique structure per column where production kept two.

The models and the migration chain disagreed in 41 places (measured
2026-10-06: a fresh PostgreSQL 16 migrated to 0096, compared with
``alembic.autogenerate.compare_metadata``; production's catalog is identical
to that fresh database, all 690 index and constraint definitions). 28 were
the models' fault and are fixed there -- index names, a unique index declared
as a constraint, partial uniques and trigram indexes that lived only in
migrations. The remaining 13 are production's: five columns carry their
uniqueness twice.

* ``user_action_tokens.token_hash``, ``werkstatt_article_units.unit_number``,
  ``werkstatt_articles.article_number``, ``werkstatt_orders.order_number``:
  a NON-unique ``ix_<table>_<column>`` plus a separate UNIQUE constraint --
  two indexes on one column, both maintained on every write. The models
  declare one unique index under the ``ix_`` name, so that is what each
  column becomes.
* ``material_catalog_items.external_key`` already has that unique index
  (``ix_material_catalog_items_external_key``) AND a unique constraint
  ``material_catalog_items_external_key_key`` -- the constraint is dropped.

Order inside each column: drop the non-unique index, create the unique one
under the same name, and only THEN drop the constraint. The constraint keeps
enforcing uniqueness, and its index keeps serving lookups, until the
replacement exists; PostgreSQL DDL is transactional, so a failure leaves the
column as it was. The unique indexes cannot fail on duplicates: the
constraints have guaranteed there are none.

No code refers to any of these names (no ``ON CONFLICT ON CONSTRAINT``, no
IntegrityError parsing by name). A duplicate now reports the ``ix_`` name.

Predicted effect: no row changes; five indexes fewer (the four constraint
indexes and the second unique index on external_key).

Revision ID: 20261006_0097
Revises: 20261005_0096
Create Date: 2026-10-06
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "20261006_0097"
down_revision: Union[str, Sequence[str], None] = "20261005_0096"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

#: (table, column, the unique constraint that duplicates its index)
_DOUBLED = (
    ("user_action_tokens", "token_hash", "user_action_tokens_token_hash_key"),
    ("werkstatt_article_units", "unit_number", "uq_werkstatt_article_units_unit_number"),
    ("werkstatt_articles", "article_number", "uq_werkstatt_articles_article_number"),
    ("werkstatt_orders", "order_number", "uq_werkstatt_orders_order_number"),
)

_CATALOG = "material_catalog_items"
_CATALOG_CONSTRAINT = "material_catalog_items_external_key_key"


def upgrade() -> None:
    for table, column, constraint in _DOUBLED:
        index = f"ix_{table}_{column}"
        op.drop_index(index, table_name=table)
        op.create_index(index, table, [column], unique=True)
        op.drop_constraint(constraint, table, type_="unique")
    op.drop_constraint(_CATALOG_CONSTRAINT, _CATALOG, type_="unique")


def downgrade() -> None:
    # The exact reverse, so a downgraded database is the 0096 one again.
    op.create_unique_constraint(_CATALOG_CONSTRAINT, _CATALOG, ["external_key"])
    for table, column, constraint in reversed(_DOUBLED):
        index = f"ix_{table}_{column}"
        op.create_unique_constraint(constraint, table, [column])
        op.drop_index(index, table_name=table)
        op.create_index(index, table, [column], unique=False)
