"""Customer-level files and task attachments.

Files used to hang off a project only: ``attachments.project_id`` plus one
``project_folders`` row per virtual folder. A customer with three jobs had
nowhere to keep what belongs to the customer rather than to one job — the
framework contract, the building's plans, the photo of the meter cabinet
that every project needs again.

``attachments.customer_id`` is that place, and ``customer_folders`` mirrors
``project_folders`` for it: same normalised ``a/b/c`` paths, same protected
``Verwaltung`` rule, so one set of helpers serves both scopes and the
customer folder is where the project folders "land in".

``attachments.task_id`` lets a task carry the plan or picture its assignee
needs. Such a row ALSO carries the task's project (or customer) and sits in
that scope's ``Aufgaben`` folder, which is what makes it visible in the file
browser and over WebDAV without a third tree.

Both new columns are SET NULL on delete, like the other anchors on this
table: losing the task must not lose the file, the row simply falls back to
its project or customer.

Revision ID: 20260921_0089
Revises: 20260920_0088
Create Date: 2026-09-21
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260921_0089"
down_revision: Union[str, Sequence[str], None] = "20260920_0088"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

CUSTOMER_FK = "fk_attachments_customer_id_customers"
TASK_FK = "fk_attachments_task_id_tasks"
CUSTOMER_INDEX = "ix_attachments_customer_id"
TASK_INDEX = "ix_attachments_task_id"
FOLDER_INDEX = "ix_customer_folders_customer_id"


def upgrade() -> None:
    # batch mode: SQLite cannot add a foreign key in place, and the same code
    # runs against the SQLite file a developer keeps locally.
    with op.batch_alter_table("attachments") as batch:
        batch.add_column(sa.Column("customer_id", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("task_id", sa.Integer(), nullable=True))
        batch.create_foreign_key(CUSTOMER_FK, "customers", ["customer_id"], ["id"], ondelete="SET NULL")
        batch.create_foreign_key(TASK_FK, "tasks", ["task_id"], ["id"], ondelete="SET NULL")
        batch.create_index(CUSTOMER_INDEX, ["customer_id"])
        batch.create_index(TASK_INDEX, ["task_id"])

    op.create_table(
        "customer_folders",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "customer_id",
            sa.Integer(),
            sa.ForeignKey("customers.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("path", sa.String(length=500), nullable=False),
        sa.Column("is_protected", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("customer_id", "path", name="uq_customer_folder_path"),
    )
    op.create_index(FOLDER_INDEX, "customer_folders", ["customer_id"])


def downgrade() -> None:
    op.drop_index(FOLDER_INDEX, table_name="customer_folders")
    op.drop_table("customer_folders")
    with op.batch_alter_table("attachments") as batch:
        batch.drop_index(TASK_INDEX)
        batch.drop_index(CUSTOMER_INDEX)
        batch.drop_constraint(TASK_FK, type_="foreignkey")
        batch.drop_constraint(CUSTOMER_FK, type_="foreignkey")
        batch.drop_column("task_id")
        batch.drop_column("customer_id")
