"""werkstatt locations: availability status

The Lagerorte screen has always shown a status per location — "Geöffnet" for a
hall, "Unterwegs" / "In Werkstatt" for a vehicle — but it was mock-only data
with no column behind it. Wiring that screen to the real API without this would
have silently deleted a field the workshop already reads, and a van's status is
exactly the thing you want to know now that machines can be booked onto one.

Nullable on purpose: a shelf has no status of its own, it inherits its hall's.

Revision ID: 20260811_0065
Revises: 20260811_0064
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260811_0065"
down_revision: Union[str, Sequence[str], None] = "20260811_0064"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "werkstatt_locations",
        sa.Column("status", sa.String(length=32), nullable=True),
    )
    # Backfill the sensible default for what already exists, so every location
    # reads as usable rather than as "no status" the moment the screen goes
    # live. Vehicles start in the workshop; everything else starts open.
    op.execute(
        "UPDATE werkstatt_locations SET status = 'in_workshop' "
        "WHERE location_type = 'vehicle' AND status IS NULL"
    )
    op.execute(
        "UPDATE werkstatt_locations SET status = 'open' "
        "WHERE location_type IN ('hall', 'external') AND status IS NULL"
    )


def downgrade() -> None:
    op.drop_column("werkstatt_locations", "status")
