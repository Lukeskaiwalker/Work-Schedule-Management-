"""werkstatt procurement: wholesaler punchout (IDS-Connect) + order composition

Three things at once, because they only make sense together:

1.  Orders learn what they are FOR (task/project), where they came FROM
    (`source`, `external_reference`), whether they are a reusable template,
    and where they went if merged away.
2.  Order lines stop requiring a stocked article. A wholesaler cart is mostly
    job material we buy and consume; forcing an inventory row for each would
    wreck the stock figures for the things we actually count. Lines gain
    snapshot columns so a catalog-less line is still a complete purchasing
    record.
3.  New tables for the punchout itself: the per-supplier connection, the
    short-lived browser hand-over sessions, and an audit row per inbound cart
    that keeps the raw payload.

The `article_id` change is the risky one: it drops a NOT NULL. That direction
is safe on existing data (every current row has a value) but the downgrade is
not — it can only restore the constraint if no free lines have been written
yet, so it deletes them first and says so.

Revision ID: 20260812_0066
Revises: 20260811_0065
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260812_0066"
down_revision: Union[str, Sequence[str], None] = "20260811_0065"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. Orders: purpose, provenance, templates, merge ────────────────
    with op.batch_alter_table("werkstatt_orders") as batch:
        batch.add_column(sa.Column("title", sa.String(length=255), nullable=True))
        batch.add_column(
            sa.Column(
                "is_template",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            )
        )
        batch.add_column(sa.Column("template_name", sa.String(length=255), nullable=True))
        batch.add_column(sa.Column("task_id", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("project_id", sa.Integer(), nullable=True))
        batch.add_column(
            sa.Column(
                "source",
                sa.String(length=32),
                nullable=False,
                server_default="manual",
            )
        )
        batch.add_column(sa.Column("external_reference", sa.String(length=128), nullable=True))
        batch.add_column(sa.Column("merged_into_order_id", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("merged_at", sa.DateTime(), nullable=True))
        batch.add_column(sa.Column("submitted_at", sa.DateTime(), nullable=True))

        batch.create_foreign_key(
            "fk_werkstatt_orders_task", "tasks", ["task_id"], ["id"], ondelete="SET NULL"
        )
        batch.create_foreign_key(
            "fk_werkstatt_orders_project",
            "projects",
            ["project_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch.create_foreign_key(
            "fk_werkstatt_orders_merged_into",
            "werkstatt_orders",
            ["merged_into_order_id"],
            ["id"],
            ondelete="SET NULL",
        )

    op.create_index("ix_werkstatt_orders_is_template", "werkstatt_orders", ["is_template"])
    op.create_index("ix_werkstatt_orders_task_id", "werkstatt_orders", ["task_id"])
    op.create_index("ix_werkstatt_orders_project_id", "werkstatt_orders", ["project_id"])
    op.create_index("ix_werkstatt_orders_source", "werkstatt_orders", ["source"])
    op.create_index(
        "ix_werkstatt_orders_merged_into_order_id",
        "werkstatt_orders",
        ["merged_into_order_id"],
    )

    # ── 2. The punchout tables ──────────────────────────────────────────
    # Created before the order-line changes because a line references an
    # import row.
    op.create_table(
        "werkstatt_ids_connections",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "supplier_id",
            sa.Integer(),
            sa.ForeignKey("werkstatt_suppliers.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("is_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("entry_url", sa.String(length=1000), nullable=False, server_default=""),
        sa.Column("http_method", sa.String(length=8), nullable=False, server_default="POST"),
        sa.Column("ids_version", sa.String(length=16), nullable=False, server_default="2.5"),
        sa.Column("charset", sa.String(length=32), nullable=False, server_default="ISO-8859-1"),
        sa.Column("username", sa.String(length=255), nullable=True),
        sa.Column("password_encrypted", sa.Text(), nullable=True),
        sa.Column("customer_number", sa.String(length=64), nullable=True),
        sa.Column("fetch_field_map", sa.JSON(), nullable=False),
        sa.Column("submit_field_map", sa.JSON(), nullable=False),
        sa.Column("cart_field_names", sa.JSON(), nullable=False),
        sa.Column("hook_base_url", sa.String(length=500), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "created_by",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    # One connection per supplier — a supplier either has a shop or does not.
    op.create_index(
        "ix_werkstatt_ids_connections_supplier_id",
        "werkstatt_ids_connections",
        ["supplier_id"],
        unique=True,
    )
    op.create_index(
        "ix_werkstatt_ids_connections_created_by",
        "werkstatt_ids_connections",
        ["created_by"],
    )

    op.create_table(
        "werkstatt_ids_sessions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("token", sa.String(length=64), nullable=False),
        sa.Column(
            "connection_id",
            sa.Integer(),
            sa.ForeignKey("werkstatt_ids_connections.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("direction", sa.String(length=16), nullable=False, server_default="fetch"),
        sa.Column(
            "order_id",
            sa.Integer(),
            sa.ForeignKey("werkstatt_orders.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="pending"),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("opened_at", sa.DateTime(), nullable=True),
        sa.Column("returned_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    # Unique: the hook URL resolves a token to exactly one session in one hit.
    op.create_index(
        "ix_werkstatt_ids_sessions_token", "werkstatt_ids_sessions", ["token"], unique=True
    )
    op.create_index(
        "ix_werkstatt_ids_sessions_connection_id",
        "werkstatt_ids_sessions",
        ["connection_id"],
    )
    op.create_index("ix_werkstatt_ids_sessions_user_id", "werkstatt_ids_sessions", ["user_id"])
    op.create_index("ix_werkstatt_ids_sessions_order_id", "werkstatt_ids_sessions", ["order_id"])
    op.create_index("ix_werkstatt_ids_sessions_status", "werkstatt_ids_sessions", ["status"])
    # Drives the expiry sweep.
    op.create_index(
        "ix_werkstatt_ids_sessions_expires_at", "werkstatt_ids_sessions", ["expires_at"]
    )

    op.create_table(
        "werkstatt_order_imports",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "supplier_id",
            sa.Integer(),
            sa.ForeignKey("werkstatt_suppliers.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "connection_id",
            sa.Integer(),
            sa.ForeignKey("werkstatt_ids_connections.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "session_id",
            sa.Integer(),
            sa.ForeignKey("werkstatt_ids_sessions.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("source", sa.String(length=32), nullable=False, server_default="ids_cart"),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="received"),
        sa.Column("content_type", sa.String(length=255), nullable=True),
        sa.Column("raw_payload", sa.Text(), nullable=True),
        sa.Column("external_reference", sa.String(length=128), nullable=True),
        sa.Column("parsed_line_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column(
            "order_id",
            sa.Integer(),
            sa.ForeignKey("werkstatt_orders.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_by",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index(
        "ix_werkstatt_order_imports_supplier_id", "werkstatt_order_imports", ["supplier_id"]
    )
    op.create_index(
        "ix_werkstatt_order_imports_connection_id", "werkstatt_order_imports", ["connection_id"]
    )
    op.create_index(
        "ix_werkstatt_order_imports_session_id", "werkstatt_order_imports", ["session_id"]
    )
    op.create_index("ix_werkstatt_order_imports_status", "werkstatt_order_imports", ["status"])
    op.create_index("ix_werkstatt_order_imports_order_id", "werkstatt_order_imports", ["order_id"])
    op.create_index(
        "ix_werkstatt_order_imports_created_by", "werkstatt_order_imports", ["created_by"]
    )
    op.create_index(
        "ix_werkstatt_order_imports_created_at", "werkstatt_order_imports", ["created_at"]
    )

    # ── 3. Order lines: free (catalog-less) lines ───────────────────────
    with op.batch_alter_table("werkstatt_order_lines") as batch:
        batch.alter_column(
            "article_id", existing_type=sa.Integer(), nullable=True
        )
        batch.add_column(sa.Column("supplier_article_no", sa.String(length=160), nullable=True))
        batch.add_column(sa.Column("description", sa.String(length=500), nullable=True))
        batch.add_column(sa.Column("manufacturer", sa.String(length=255), nullable=True))
        batch.add_column(sa.Column("ean", sa.String(length=64), nullable=True))
        batch.add_column(sa.Column("unit", sa.String(length=64), nullable=True))
        batch.add_column(sa.Column("source_import_id", sa.Integer(), nullable=True))
        batch.create_foreign_key(
            "fk_werkstatt_order_lines_source_import",
            "werkstatt_order_imports",
            ["source_import_id"],
            ["id"],
            ondelete="SET NULL",
        )

    op.create_index(
        "ix_werkstatt_order_lines_supplier_article_no",
        "werkstatt_order_lines",
        ["supplier_article_no"],
    )
    op.create_index("ix_werkstatt_order_lines_ean", "werkstatt_order_lines", ["ean"])
    op.create_index(
        "ix_werkstatt_order_lines_source_import_id",
        "werkstatt_order_lines",
        ["source_import_id"],
    )

    # Backfill the snapshot for what already exists, so old and new lines
    # render through the same code path instead of the UI needing a fallback
    # join only for pre-migration rows.
    op.execute(
        """
        UPDATE werkstatt_order_lines AS l
        SET description = a.item_name,
            manufacturer = a.manufacturer,
            ean = a.ean,
            unit = a.unit
        FROM werkstatt_articles AS a
        WHERE l.article_id = a.id AND l.description IS NULL
        """
        if op.get_bind().dialect.name == "postgresql"
        else """
        UPDATE werkstatt_order_lines
        SET description = (
                SELECT item_name FROM werkstatt_articles
                WHERE werkstatt_articles.id = werkstatt_order_lines.article_id
            ),
            manufacturer = (
                SELECT manufacturer FROM werkstatt_articles
                WHERE werkstatt_articles.id = werkstatt_order_lines.article_id
            ),
            ean = (
                SELECT ean FROM werkstatt_articles
                WHERE werkstatt_articles.id = werkstatt_order_lines.article_id
            ),
            unit = (
                SELECT unit FROM werkstatt_articles
                WHERE werkstatt_articles.id = werkstatt_order_lines.article_id
            )
        WHERE article_id IS NOT NULL AND description IS NULL
        """
    )


def downgrade() -> None:
    # Free lines cannot survive the NOT NULL coming back, and neither can the
    # orders made of them. Drop them explicitly rather than letting the ALTER
    # fail halfway with a constraint violation and no explanation.
    op.execute("DELETE FROM werkstatt_order_lines WHERE article_id IS NULL")
    op.execute("DELETE FROM werkstatt_orders WHERE is_template = true")

    op.drop_index("ix_werkstatt_order_lines_source_import_id", "werkstatt_order_lines")
    op.drop_index("ix_werkstatt_order_lines_ean", "werkstatt_order_lines")
    op.drop_index("ix_werkstatt_order_lines_supplier_article_no", "werkstatt_order_lines")
    with op.batch_alter_table("werkstatt_order_lines") as batch:
        batch.drop_constraint("fk_werkstatt_order_lines_source_import", type_="foreignkey")
        batch.drop_column("source_import_id")
        batch.drop_column("unit")
        batch.drop_column("ean")
        batch.drop_column("manufacturer")
        batch.drop_column("description")
        batch.drop_column("supplier_article_no")
        batch.alter_column("article_id", existing_type=sa.Integer(), nullable=False)

    op.drop_table("werkstatt_order_imports")
    op.drop_table("werkstatt_ids_sessions")
    op.drop_table("werkstatt_ids_connections")

    op.drop_index("ix_werkstatt_orders_merged_into_order_id", "werkstatt_orders")
    op.drop_index("ix_werkstatt_orders_source", "werkstatt_orders")
    op.drop_index("ix_werkstatt_orders_project_id", "werkstatt_orders")
    op.drop_index("ix_werkstatt_orders_task_id", "werkstatt_orders")
    op.drop_index("ix_werkstatt_orders_is_template", "werkstatt_orders")
    with op.batch_alter_table("werkstatt_orders") as batch:
        batch.drop_constraint("fk_werkstatt_orders_merged_into", type_="foreignkey")
        batch.drop_constraint("fk_werkstatt_orders_project", type_="foreignkey")
        batch.drop_constraint("fk_werkstatt_orders_task", type_="foreignkey")
        batch.drop_column("submitted_at")
        batch.drop_column("merged_at")
        batch.drop_column("merged_into_order_id")
        batch.drop_column("external_reference")
        batch.drop_column("source")
        batch.drop_column("project_id")
        batch.drop_column("task_id")
        batch.drop_column("template_name")
        batch.drop_column("is_template")
        batch.drop_column("title")
