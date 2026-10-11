"""werkstatt_movements: machine inspections move no stock

A DGUV3 inspection of a machine (``werkstatt_machines.record_inspection``) was
written as a ``correction`` of quantity 1 against the machine's article. The
stock recompute sums every row of an article, so each inspection took one
machine off the type's ``stock_total`` and ``stock_out``. Since the ledger
refuses a ``correction`` past ``stock_out`` (2026-10-10), a real "verloren"
report after an inspection would be refused too.

New inspections write quantity 0 (an audit row, like the article
BG-Prüfung). This migration sets the old ones to 0 — they are exactly the
unit-level ``correction`` rows, nothing else writes one — and rebuilds the
four snapshot counters of the affected articles from the ledger, clamped at
zero like ``recompute_article_stock``.

The movement deltas are copied literally rather than imported from
``app.services.werkstatt_movements``: a migration must keep describing this
moment in history even after that module changes.

Downgrade is a no-op: putting the stock-moving rows back would only restore
the bug.

Revision ID: 20261010_0101
Revises: 20261010_0100
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20261010_0101"
down_revision: Union[str, Sequence[str], None] = "20261010_0100"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# counter → {movement_type: signed delta per unit}, as of 2026-10-10.
_DELTAS: dict[str, dict[str, int]] = {
    "total": {
        "intake": 1, "correction": -1, "inventory_plus": 1, "inventory_minus": -1,
        "consumption": -1, "consumption_undo": 1,
    },
    "available": {
        "checkout": -1, "return": 1, "intake": 1, "repair_back": 1, "inventory_plus": 1,
        "inventory_minus": -1, "consumption": -1, "consumption_undo": 1,
    },
    "out": {"checkout": 1, "return": -1, "correction": -1, "repair_out": -1},
    "repair": {"repair_out": 1, "repair_back": -1},
}
_COLUMN = {"total": "stock_total", "available": "stock_available", "out": "stock_out", "repair": "stock_repair"}


def _sum_sql(counter: str) -> str:
    branches = " ".join(
        f"WHEN m.movement_type = '{movement_type}' THEN m.quantity * ({delta})"
        for movement_type, delta in _DELTAS[counter].items()
    )
    return f"COALESCE((SELECT SUM(CASE {branches} ELSE 0 END) FROM werkstatt_movements m WHERE m.article_id = a.id), 0)"


def upgrade() -> None:
    bind = op.get_bind()
    affected = [
        row[0]
        for row in bind.execute(
            sa.text(
                "SELECT DISTINCT article_id FROM werkstatt_movements "
                "WHERE movement_type = 'correction' AND unit_id IS NOT NULL AND quantity <> 0"
            )
        )
    ]
    if not affected:
        return
    bind.execute(
        sa.text(
            "UPDATE werkstatt_movements SET quantity = 0 "
            "WHERE movement_type = 'correction' AND unit_id IS NOT NULL AND quantity <> 0"
        )
    )
    assignments = ", ".join(
        f"{column} = CASE WHEN {_sum_sql(counter)} < 0 THEN 0 ELSE {_sum_sql(counter)} END"
        for counter, column in _COLUMN.items()
    )
    bind.execute(
        sa.text(f"UPDATE werkstatt_articles a SET {assignments} WHERE a.id IN :ids").bindparams(
            sa.bindparam("ids", expanding=True)
        ),
        {"ids": affected},
    )


def downgrade() -> None:
    pass
