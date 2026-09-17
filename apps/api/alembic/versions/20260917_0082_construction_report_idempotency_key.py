"""Let a construction-report upload be retried without creating the report twice.

A report submitted from a phone on a construction site can lose its response:
the server created the row, queued the PDF and stored the photos, but the
network dropped before the phone heard back. The client only sees "Network
request failed" and cannot tell that state apart from "nothing happened", so
until now it could not retry — a retry after a lost response would have filed
the report a second time.

``idempotency_key`` is the client-generated token that makes the retry safe.
The client mints one per submission attempt and sends it as the
``Idempotency-Key`` header; the API stores it on the report it created and
answers every later request carrying the same key from the same user with the
original report instead of a new one.

The unique index on ``(user_id, idempotency_key)`` is what makes this hold
under concurrency: a retry that arrives while the first request is still
running collides on the index instead of slipping past a SELECT, and the API
then replays the winner. Nullable, and NULLs are distinct in both Postgres and
SQLite, so the far larger population of reports without a key — every existing
row, every caller that does not send the header — is untouched by the index.

Revision ID: 20260917_0082
Revises: 20260912_0081
Create Date: 2026-09-17
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260917_0082"
down_revision: Union[str, Sequence[str], None] = "20260912_0081"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

INDEX_NAME = "ix_construction_reports_user_idempotency_key"


def upgrade() -> None:
    op.add_column(
        "construction_reports",
        sa.Column("idempotency_key", sa.String(length=64), nullable=True),
    )
    op.create_index(
        INDEX_NAME,
        "construction_reports",
        ["user_id", "idempotency_key"],
        unique=True,
    )


def downgrade() -> None:
    # The index goes first: SQLite refuses to drop a column an index still
    # references, and Postgres would drop it implicitly anyway.
    op.drop_index(INDEX_NAME, table_name="construction_reports")
    op.drop_column("construction_reports", "idempotency_key")
