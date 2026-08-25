"""scan station: device-authorization pairing + long-lived station tokens

Two tables behind the OAuth 2.0 device authorization grant (RFC 8628) that
lets the office Raspberry Pi (tools/label_agent) authenticate without anyone
typing a password on it. See app/models/station.py and
app/routers/workflow_station.py.

  stations
    One paired device. ``token_hash`` is sha256 hex of the raw bearer token —
    the raw value is never persisted, so a database dump cannot be replayed
    against the API. Until the device collects its token the column instead
    holds an ``unclaimed:<random>`` sentinel, which no sha256 digest can equal,
    so an approved-but-uncollected station exists in the list yet cannot
    authenticate. ``prefix`` is the first 20 characters of the raw token, kept
    for UI display only. A station is usable when ``revoked_at IS NULL`` and
    (``expires_at IS NULL OR expires_at > now()``); both are checked on every
    request, so a revoke bites immediately.

  station_pairings
    One in-flight pairing attempt. ``user_code`` is the short code shown on the
    device ("WXYZ-4821"), unique so an approving admin can never hit two rows.
    ``device_token_hash`` is sha256 of the 256-bit handle only the device holds
    — that, not the short code, is what proves "I am the device that asked".
    ``status`` walks pending → approved → claimed (or → denied) and never back.
    Expiry is deliberately NOT a status: it is derived from ``expires_at`` and
    the clock, so a missed sweep can never leave a stale code approvable.
    Approved/denied/claimed rows are retained as the audit trail for "who let
    this device in?".

Revision ID: 20260826_0076
Revises: 20260825_0075
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260826_0076"
down_revision: Union[str, None] = "20260825_0075"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "stations",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("token_hash", sa.String(length=128), nullable=False),
        sa.Column("prefix", sa.String(length=24), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("paired_from_ip", sa.String(length=64), nullable=True),
        sa.Column("agent_version", sa.String(length=64), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(), nullable=True),
        sa.Column(
            "hardware_status", sa.JSON(), nullable=False, server_default=sa.text("'{}'")
        ),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
        sa.Column("revoked_by", sa.Integer(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        # Stations outlive the admin who paired them: keep the row, drop the
        # attribution, exactly as the rest of this schema does.
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["revoked_by"], ["users.id"], ondelete="SET NULL"),
    )
    # Hash lookup runs on every station-authenticated request: unique (free
    # insurance against a collision that sha256 makes impossible anyway) and
    # indexed for O(1) auth.
    op.create_index("ix_stations_token_hash", "stations", ["token_hash"], unique=True)
    op.create_index("ix_stations_created_by", "stations", ["created_by"])
    op.create_index("ix_stations_revoked_by", "stations", ["revoked_by"])

    op.create_table(
        "station_pairings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_code", sa.String(length=16), nullable=False),
        sa.Column("device_token_hash", sa.String(length=128), nullable=False),
        sa.Column("status", sa.String(length=16), server_default="pending", nullable=False),
        sa.Column("device_hint", sa.String(length=128), nullable=True),
        sa.Column("agent_version", sa.String(length=64), nullable=True),
        sa.Column("requested_ip", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("last_polled_at", sa.DateTime(), nullable=True),
        sa.Column("poll_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("approved_at", sa.DateTime(), nullable=True),
        sa.Column("approved_by", sa.Integer(), nullable=True),
        sa.Column("denied_at", sa.DateTime(), nullable=True),
        sa.Column("denied_by", sa.Integer(), nullable=True),
        sa.Column("claimed_at", sa.DateTime(), nullable=True),
        sa.Column("station_id", sa.Integer(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["approved_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["denied_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["station_id"], ["stations.id"], ondelete="SET NULL"),
    )
    # Both lookups are on the request path: the admin approves by typed code,
    # the device polls by token hash. Unique on each — a code must resolve to
    # exactly one pairing, and two devices must never share a handle.
    op.create_index("ix_station_pairings_user_code", "station_pairings", ["user_code"], unique=True)
    op.create_index(
        "ix_station_pairings_device_token_hash",
        "station_pairings",
        ["device_token_hash"],
        unique=True,
    )
    op.create_index("ix_station_pairings_status", "station_pairings", ["status"])
    op.create_index("ix_station_pairings_approved_by", "station_pairings", ["approved_by"])
    op.create_index("ix_station_pairings_denied_by", "station_pairings", ["denied_by"])
    op.create_index("ix_station_pairings_station_id", "station_pairings", ["station_id"])


def downgrade() -> None:
    op.drop_table("station_pairings")
    op.drop_table("stations")
