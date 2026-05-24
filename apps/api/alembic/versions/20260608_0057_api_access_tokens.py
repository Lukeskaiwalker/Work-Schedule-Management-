"""v2.5.23: per-user API access + personal access tokens (PATs)

Adds the two pieces of state needed for AI-agent-friendly programmatic
API access:

  1. ``users.api_access_enabled`` (bool, default false)

     A top-level gate, controlled by admins from the user-edit modal.
     Off by default — existing users cannot use the API outside the
     browser session until an admin flips this on. The flag is checked
     at request time, so revoking it immediately disables every PAT the
     user has minted (the tokens are not deleted — re-enabling restores
     access, which is the right thing if access was suspended
     temporarily).

  2. ``api_tokens`` table

     One row per minted token. We store only the SHA-256 hash of the
     raw token, never the token itself, so a DB dump cannot be replayed
     against the API. The first 12 characters of the raw token (the
     ``smpl_pat_`` prefix plus a few entropy chars) are kept in
     ``prefix`` so the UI can show a recognisable stub like
     ``smpl_pat_AbC…`` in the token list.

     Columns:
       id            PK
       user_id       FK users.id ON DELETE CASCADE — tokens follow the user
       name          human label, e.g. "Planning agent"
       token_hash    sha256 hex of the raw token (unique, indexed for O(1) lookup)
       prefix        first 12 chars of raw token, for UI display
       created_at    when minted
       last_used_at  best-effort timestamp updated by the auth dep (nullable)
       expires_at    optional expiry (90-day default at mint time, nullable for never)
       revoked_at    nullable — set on revoke; an unrevoked + unexpired token is active

Revision ID: 20260608_0057
Revises: 20260607_0056
Create Date: 2026-05-24 12:00:00.000000
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260608_0057"
down_revision: Union[str, Sequence[str], None] = "20260607_0056"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1) Per-user gate — default false so nobody picks up API access by
    # surprise on the first deploy.
    op.add_column(
        "users",
        sa.Column(
            "api_access_enabled",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
    )

    # 2) PAT registry.
    op.create_table(
        "api_tokens",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("token_hash", sa.String(length=128), nullable=False),
        sa.Column("prefix", sa.String(length=16), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("last_used_at", sa.DateTime(), nullable=True),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
    )
    # Hash lookup happens on every PAT-authenticated request — must be
    # unique (collisions are mathematically impossible with sha256 but
    # the constraint is free insurance) and indexed.
    op.create_index(
        "ix_api_tokens_token_hash",
        "api_tokens",
        ["token_hash"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_api_tokens_token_hash", table_name="api_tokens")
    op.drop_table("api_tokens")
    op.drop_column("users", "api_access_enabled")
