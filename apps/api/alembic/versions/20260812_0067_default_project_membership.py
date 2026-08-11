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

## Why the rows are flagged

`project_members.is_default` marks the rows this default hands out, as opposed
to the ones a human created on purpose. The two are otherwise the same row and
mean different things:

  - on the team by default → may open the job (address, access note, materials);
  - deliberately assigned    → actually involved in the job.

A couple of checks want the stronger statement. Project finances in particular
read through `assert_project_access(..., allow_default_membership=False)`, so
order values and contribution margins stay scoped to the people on the work —
exactly as they were before this default existed. Widening team membership was
the point; widening who can see the margin on every job in the company was not.

The flag is also what makes the downgrade honest: it can delete precisely the
rows it created and leave every deliberate assignment standing.

Revision ID: 20260812_0067
Revises: 20260812_0066
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260812_0067"
down_revision: Union[str, Sequence[str], None] = "20260812_0066"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # The column has to exist BEFORE the backfill runs. Adding it afterwards
    # would be useless: every row would default to false and there would be no
    # way left to tell which ones this migration had just created.
    #
    # Everything already in the table predates the default and is therefore
    # deliberate, so false is the correct value for existing rows.
    op.add_column(
        "project_members",
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.false()),
    )

    # `NOT EXISTS` rather than an upsert: the unique constraint on
    # (project_id, user_id) would reject duplicates anyway, but skipping them
    # here also protects the `can_manage=True` rows a project creator already
    # holds — an ON CONFLICT DO UPDATE would have flattened those to false.
    #
    # Active users only. A deactivated account was switched off on purpose;
    # handing it every project back is not a backfill, it is a regression.
    op.execute(
        """
        INSERT INTO project_members (project_id, user_id, can_manage, is_default)
        SELECT p.id, u.id, false, true
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
    # Now precise, because the flag says which rows were ours. Deliberate
    # assignments — including any the admin promoted out of the default by
    # adding somebody explicitly — have is_default = false and survive.
    op.execute("DELETE FROM project_members WHERE is_default = true")
    op.drop_column("project_members", "is_default")
