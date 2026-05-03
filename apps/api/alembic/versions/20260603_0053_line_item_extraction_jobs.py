"""line_item_extraction_jobs table

Async job rows for v2.4.0 LLM-assisted line-item extraction. The worker
in ``app/services/line_item_extraction.py`` claims rows here, calls
OpenAI Structured Outputs, and persists the parsed array on
``extracted_items_json`` for operator review. The actual
``project_line_items`` rows are only created on a separate confirm step
(iteration 3) so the operator can edit before persisting.

Foreign keys:
  - project_id → projects.id   (CASCADE on project delete; abandoned
    extraction jobs go away with their project)
  - created_by → users.id      (SET NULL on user delete)

No backfill: net-new feature.

Revision ID: 20260603_0053
Revises: 20260601_0052
Create Date: 2026-05-03 13:00:00.000000
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260603_0053"
down_revision: Union[str, Sequence[str], None] = "20260601_0052"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "line_item_extraction_jobs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "project_id",
            sa.Integer(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        # ── what to extract ────────────────────────────────────────────
        sa.Column("doc_type", sa.String(length=64), nullable=False),
        sa.Column("source_kind", sa.String(length=32), nullable=False),
        sa.Column("source_filename", sa.String(length=500), nullable=True),
        sa.Column("source_stored_path", sa.String(length=500), nullable=True),
        sa.Column("source_text", sa.Text(), nullable=True),
        # ── FSM ────────────────────────────────────────────────────────
        sa.Column(
            "status",
            sa.String(length=32),
            nullable=False,
            server_default="queued",
            index=True,
        ),
        sa.Column(
            "attempt_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "max_attempts",
            sa.Integer(),
            nullable=False,
            server_default="2",
        ),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        # ── extraction output ─────────────────────────────────────────
        sa.Column(
            "extracted_items_json",
            sa.JSON(),
            nullable=False,
            server_default="[]",
        ),
        sa.Column(
            "extracted_items_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column("extracted_by_model", sa.String(length=128), nullable=True),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        # ── confirmation ──────────────────────────────────────────────
        sa.Column("confirmed_at", sa.DateTime(), nullable=True),
        # ── audit ─────────────────────────────────────────────────────
        sa.Column(
            "created_by",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )


def downgrade() -> None:
    op.drop_table("line_item_extraction_jobs")
