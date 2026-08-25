"""ausbildung: apprentice flag on users + weekly training reports

Two pieces that only make sense together:

* ``users.is_apprentice`` / ``users.training_started_on`` — who writes these
  reports at all, and since when (prefills the Ausbildungsjahr). Plain
  nullable/default-false columns, so every existing row is untouched in
  meaning: nobody is an apprentice until an admin says so.

* ``training_week_reports`` — one row per apprentice per calendar week, the
  digital IHK Ausbildungsnachweis. Per-day content lives in a JSON document
  (the ConstructionReport.payload idiom); signatures are data-URL strings.

Revision ID: 20260816_0072
Revises: 20260814_0071
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260816_0072"
down_revision: Union[str, Sequence[str], None] = "20260814_0071"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("is_apprentice", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column("users", sa.Column("training_started_on", sa.Date(), nullable=True))

    op.create_table(
        "training_week_reports",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("week_start", sa.Date(), nullable=False),
        sa.Column("report_number", sa.Integer(), nullable=False),
        sa.Column("ausbildungsjahr", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="draft"),
        sa.Column("days", sa.JSON(), nullable=False),
        sa.Column("remarks", sa.Text(), nullable=True),
        sa.Column("azubi_signature", sa.Text(), nullable=True),
        sa.Column("azubi_signed_at", sa.DateTime(), nullable=True),
        sa.Column("ausbilder_signature", sa.Text(), nullable=True),
        sa.Column("ausbilder_signed_at", sa.DateTime(), nullable=True),
        sa.Column(
            "ausbilder_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("user_id", "week_start", name="uq_training_report_user_week"),
        sa.UniqueConstraint("user_id", "report_number", name="uq_training_report_user_number"),
    )
    op.create_index("ix_training_week_reports_user_id", "training_week_reports", ["user_id"])
    op.create_index(
        "ix_training_week_reports_week_start", "training_week_reports", ["week_start"]
    )
    op.create_index("ix_training_week_reports_status", "training_week_reports", ["status"])
    op.create_index(
        "ix_training_week_reports_ausbilder_user_id",
        "training_week_reports",
        ["ausbilder_user_id"],
    )


def downgrade() -> None:
    op.drop_table("training_week_reports")
    with op.batch_alter_table("users") as batch:
        batch.drop_column("training_started_on")
        batch.drop_column("is_apprentice")
