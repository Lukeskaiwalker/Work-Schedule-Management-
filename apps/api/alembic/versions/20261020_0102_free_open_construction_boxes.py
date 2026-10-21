"""werkstatt_construction_boxes: an open crate belongs to nobody

The box FSM cleared the customer and project only on ``gepackt → offen``
("Zuweisung aufheben"). The other way back, ``zugewiesen → zurueck → offen``
("Kiste zurückbuchen", then "Erneut öffnen"), kept them, so a crate stood on
the rack as ``offen`` while still naming its last customer. Every other
customer's task form then hid it as somebody else's crate, and the customer
it named still saw it as a current box. Production held two such rows when
this was written: K7 (customer 18) and BK-2026-0001 (customer 90).

Every transition to ``offen`` now clears both, as the task settlement's
``release_box_after_task`` always did. This migration frees the rows the old
edge left behind. Data only — no schema change.

Downgrade is a no-op: the cleared owners are not recorded anywhere, and
putting them back would only restore the bug.

Revision ID: 20261020_0102
Revises: 20261010_0101
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20261020_0102"
down_revision: Union[str, Sequence[str], None] = "20261010_0101"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.get_bind().execute(
        sa.text(
            "UPDATE werkstatt_construction_boxes SET customer_id = NULL, project_id = NULL "
            "WHERE status = 'offen' AND (customer_id IS NOT NULL OR project_id IS NOT NULL)"
        )
    )


def downgrade() -> None:
    # Nothing to undo: which customer an open crate wrongly kept was never
    # stored anywhere else, and restoring it would only restore the bug.
    pass
