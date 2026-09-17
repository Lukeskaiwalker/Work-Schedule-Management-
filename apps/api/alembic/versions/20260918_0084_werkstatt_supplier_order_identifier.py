"""Let each supplier say which article identifier their shop wants.

The outbound IDS cart used to carry both the supplier's article number and
the EAN on every position. Unielektro — the one live shop — imports only its
own number, and a second wholesaler may want it the other way round. Neither
``werkstatt_suppliers`` nor the IDS connection had anywhere to say so, so the
choice was hard-coded in the cart builder.

``order_identifier`` moves it into data: ``supplier_no`` (the new default —
ArtNo only, EAN omitted), ``supplier_no_or_ean``, ``ean`` or ``both`` (the
old behaviour, one select away for a shop that turns out to need it). It
lives on the supplier rather than the connection because the same setting
drives the CSV/clipboard export of a supplier who has no connection at all.

``order_channel`` records how orders reach the supplier (``ids`` or
``manual``) so the order drawer can offer the right hand-over control without
reading the admin-only connection table.

Both columns get a server default so every existing supplier row is valid the
moment the column exists; the api container runs this on start. The default
channel is then corrected from the data that already says which suppliers are
shop suppliers: every supplier with an enabled ``werkstatt_ids_connections``
row becomes ``ids``. Without that step Unielektro — the one live connection —
would sit on "manual" until somebody edited the supplier, and the order dialog
would preselect whichever supplier sorts first.

Revision ID: 20260918_0084
Revises: 20260918_0083
Create Date: 2026-09-18
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260918_0084"
down_revision: Union[str, Sequence[str], None] = "20260918_0083"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # batch mode: SQLite cannot ALTER a column in place, and dropping one on
    # downgrade needs the table rebuilt. Postgres runs the same statements
    # directly.
    with op.batch_alter_table("werkstatt_suppliers") as batch:
        batch.add_column(
            sa.Column(
                "order_identifier",
                sa.String(length=16),
                nullable=False,
                server_default="supplier_no",
            )
        )
        batch.add_column(
            sa.Column(
                "order_channel",
                sa.String(length=16),
                nullable=False,
                server_default="manual",
            )
        )
    op.execute(_shop_suppliers_become_ids())


def _shop_suppliers_become_ids() -> sa.sql.Update:
    """``order_channel = 'ids'`` for every supplier with an enabled connection.

    Lightweight table constructs rather than the ORM models: a migration must
    describe the schema as it is at THIS revision, and the models move on.
    ``sa.true()`` renders as ``1`` on SQLite and ``true`` on Postgres, which is
    why the predicate is not a literal.
    """

    suppliers = sa.table(
        "werkstatt_suppliers",
        sa.column("id", sa.Integer),
        sa.column("order_channel", sa.String),
    )
    connections = sa.table(
        "werkstatt_ids_connections",
        sa.column("supplier_id", sa.Integer),
        sa.column("is_enabled", sa.Boolean),
    )
    enabled = sa.select(connections.c.supplier_id).where(connections.c.is_enabled == sa.true())
    return suppliers.update().where(suppliers.c.id.in_(enabled)).values(order_channel="ids")


def downgrade() -> None:
    with op.batch_alter_table("werkstatt_suppliers") as batch:
        batch.drop_column("order_channel")
        batch.drop_column("order_identifier")
