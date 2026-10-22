"""app_settings.value: VARCHAR(2048) → TEXT, for the permission overrides

The per-user permission overrides are one JSON value, ``user_permissions``,
and filled 2048 characters at roughly 30-40 users with an override; the role
map, ``role_permissions``, is already about 1.8 KB with the defaults and
passes the limit once a few roles gain permissions. PostgreSQL then refused
the admin's save with a DataError. SQLite -- the test database -- does not
enforce a VARCHAR length, so only production could fail. Every other runtime
setting gains the same headroom.

PostgreSQL changes VARCHAR to TEXT without rewriting the table. The new
``permissions_revision`` row needs no migration: app.services.permission_store
creates it on the first save.

Slot and chain (2026-10-22): 0102-0104 are taken by branches in flight
(``20261020_0102`` on claude/customer-directory-fix; 0103 and 0104 reserved
for the dashboard and Verteiler-enclosure worktrees), so this is 0105. It
was written on ``20261010_0101``, the head production ran, so the security
fix could deploy on its own; release v2.14.42 ships it together with
``20261020_0102`` and re-points it onto that head. Whichever of the others
lands later must re-point its first migration's ``down_revision`` onto the
head it finds -- tests/test_alembic_single_head.py fails until it does.

claude/label-calibration's ``20261013_0102_app_settings_value_text`` makes
this same change. Merged after this one, it is redundant: drop it, or chain
it after this one, where it is a no-op (TEXT → TEXT).

Downgrade returns to VARCHAR(2048). It is lossy: PostgreSQL refuses the
conversion while a longer value exists, so shorten such values first.

Revision ID: 20261022_0105
Revises: 20261020_0102
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20261022_0105"
down_revision: Union[str, Sequence[str], None] = "20261020_0102"
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
