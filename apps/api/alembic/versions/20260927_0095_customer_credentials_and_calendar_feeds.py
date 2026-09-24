"""Zugangsdaten per customer and the per-user calendar subscription.

* ``customer_credentials`` — the installation's logins (inverter, wallbox,
  router, portal) kept with the customer, the secret Fernet-encrypted;
  showing one is an audited call (``models/customer.CustomerCredential``).
* ``calendar_feeds`` — one secret subscription token per user behind
  ``/api/calendar/<token>/feed.ics``, hashed for the lookup and encrypted
  for re-display (``models/calendar.CalendarFeed``).

Revision ID: 20260927_0095
Revises: 20260926_0094
Create Date: 2026-09-27
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260927_0095"
down_revision: Union[str, Sequence[str], None] = "20260926_0094"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "customer_credentials",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("customer_id", sa.Integer(), sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("label", sa.String(length=160), nullable=False),
        sa.Column("category", sa.String(length=24), nullable=False, server_default="other"),
        sa.Column("username", sa.String(length=255), nullable=True),
        sa.Column("secret_encrypted", sa.Text(), nullable=True),
        sa.Column("url", sa.String(length=500), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("updated_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("last_revealed_at", sa.DateTime(), nullable=True),
        sa.Column("last_revealed_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_customer_credentials_customer_id", "customer_credentials", ["customer_id"])

    op.create_table(
        "calendar_feeds",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("token_encrypted", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("last_fetched_at", sa.DateTime(), nullable=True),
        sa.Column("last_fetch_agent", sa.String(length=200), nullable=True),
        sa.Column("fetch_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index("ix_calendar_feeds_user_id", "calendar_feeds", ["user_id"], unique=True)
    op.create_index("ix_calendar_feeds_token_hash", "calendar_feeds", ["token_hash"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_calendar_feeds_token_hash", table_name="calendar_feeds")
    op.drop_index("ix_calendar_feeds_user_id", table_name="calendar_feeds")
    op.drop_table("calendar_feeds")
    op.drop_index("ix_customer_credentials_customer_id", table_name="customer_credentials")
    op.drop_table("customer_credentials")
