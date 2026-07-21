"""TOTP two-factor authentication columns on users.

Adds opt-in TOTP MFA state:

  * ``users.mfa_enabled``        bool, default false — the enforcement gate.
  * ``users.mfa_secret``         encrypted base32 TOTP seed (nullable). Set
                                 during enrollment; may exist while
                                 mfa_enabled is still false (pending verify).
  * ``users.mfa_enrolled_at``    when MFA was verified/enabled (nullable).
  * ``users.mfa_recovery_codes`` JSON list of sha256-hashed single-use codes.

Off by default so existing users keep logging in with just a password until
they opt in from profile settings.

Revision ID: 20260713_0058
Revises: 20260608_0057
Create Date: 2026-07-13 00:00:00.000000
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260713_0058"
down_revision: Union[str, Sequence[str], None] = "20260608_0057"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "mfa_enabled",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
    )
    op.add_column("users", sa.Column("mfa_secret", sa.String(length=255), nullable=True))
    op.add_column("users", sa.Column("mfa_enrolled_at", sa.DateTime(), nullable=True))
    op.add_column("users", sa.Column("mfa_recovery_codes", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "mfa_recovery_codes")
    op.drop_column("users", "mfa_enrolled_at")
    op.drop_column("users", "mfa_secret")
    op.drop_column("users", "mfa_enabled")
