"""every active user is a member of every project

Backfills `project_members` so the new default — everyone sees every project —
applies to the data that already exists. New projects and new users get their
memberships from `services/project_membership.py` at creation time.

## Why this runs exactly once

The temptation is to re-sync on every boot. That would be wrong: it would
silently undo every deliberate removal an admin makes, turning "remove this
person from that project" into an action that appears to work and quietly
reverts. A one-off backfill plus create-time hooks keeps the default broad
while leaving manual scoping meaningful.

## Reversibility

The downgrade is a no-op, and deliberately so. These rows are indistinguishable
from memberships somebody added by hand — same table, same shape, nothing
marking them as backfilled — so an automated undo would delete real
assignments alongside its own. Removing broad access is a decision for the
admin screens, not for a schema rollback.

Revision ID: 20260812_0067
Revises: 20260812_0066
"""

from typing import Sequence, Union

from alembic import op

revision: str = "20260812_0067"
down_revision: Union[str, Sequence[str], None] = "20260812_0066"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # `NOT EXISTS` rather than an upsert: the unique constraint on
    # (project_id, user_id) would reject duplicates anyway, but skipping them
    # here also protects the `can_manage=True` rows a project creator already
    # holds — an ON CONFLICT DO UPDATE would have flattened those to false.
    #
    # Active users only. A deactivated account was switched off on purpose;
    # handing it every project back is not a backfill, it is a regression.
    op.execute(
        """
        INSERT INTO project_members (project_id, user_id, can_manage)
        SELECT p.id, u.id, false
        FROM projects AS p
        CROSS JOIN users AS u
        WHERE u.is_active = true
          AND NOT EXISTS (
              SELECT 1 FROM project_members AS m
              WHERE m.project_id = p.id AND m.user_id = u.id
          )
        """
    )


def downgrade() -> None:
    # Intentionally empty — see the module docstring.
    pass
