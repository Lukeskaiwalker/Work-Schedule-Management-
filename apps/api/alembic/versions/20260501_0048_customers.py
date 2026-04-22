"""customers table + projects.customer_id FK with backfill

Phase 1 of de-denormalising customer data off `projects`:

  * Create `customers` (first-class customer entity).
  * Add nullable `projects.customer_id` FK (ON DELETE SET NULL).
  * Backfill: for each distinct (customer_name, customer_address) tuple
    on `projects`, create exactly one Customer row and point every
    matching project at it. Normalisation reuses
    `app.services.project_import._normalize_key` so the migration is
    bit-identical to the importer's dedupe.

The legacy `projects.customer_*` columns stay intact — they're now a
mirrored cache of the Customer, kept in sync by
`workflow_projects.py`. Removing them is phase 2.

Revision ID: 20260501_0048
Revises: 20260425_0047
Create Date: 2026-05-01 00:00:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from app.services.project_import import _normalize_key


revision: str = "20260501_0048"
down_revision: Union[str, Sequence[str], None] = "20260425_0047"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1) customers table ────────────────────────────────────────────────
    op.create_table(
        "customers",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("address", sa.String(length=500), nullable=True),
        sa.Column("contact_person", sa.String(length=255), nullable=True),
        sa.Column("email", sa.String(length=255), nullable=True),
        sa.Column("phone", sa.String(length=128), nullable=True),
        sa.Column("tax_id", sa.String(length=64), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("archived_at", sa.DateTime(), nullable=True),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_customers_name", "customers", ["name"])
    op.create_index("ix_customers_archived_at", "customers", ["archived_at"])

    # 2) projects.customer_id FK ────────────────────────────────────────
    # batch_alter_table so SQLite (used in tests) can add FK in one pass.
    with op.batch_alter_table("projects", schema=None) as batch_op:
        batch_op.add_column(sa.Column("customer_id", sa.Integer(), nullable=True))
        batch_op.create_foreign_key(
            "fk_projects_customer_id",
            "customers",
            ["customer_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch_op.create_index("ix_projects_customer_id", ["customer_id"])

    # 3) Backfill ───────────────────────────────────────────────────────
    _backfill_customers_from_projects()


def _backfill_customers_from_projects() -> None:
    """Group projects by normalised (customer_name, customer_address),
    insert one Customer per group, then link every project via customer_id.

    Uses `_normalize_key` from the importer to stay bit-identical with the
    runtime dedupe rule — if phase-2 ever drops the legacy columns, the
    same rule still applies for incoming legacy-API payloads.
    """
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT id, customer_name, customer_address, "
            "       customer_contact, customer_email, customer_phone "
            "FROM projects "
            "WHERE customer_name IS NOT NULL "
            "  AND TRIM(customer_name) <> ''"
        )
    ).fetchall()

    # group_key → {"name", "address", "contact", "email", "phone", "project_ids"}
    groups: dict[str, dict] = {}
    for row in rows:
        project_id = row[0]
        name = (row[1] or "").strip()
        if not name:
            continue
        address = (row[2] or "").strip() or None
        contact = (row[3] or "").strip() or None
        email = (row[4] or "").strip() or None
        phone = (row[5] or "").strip() or None

        key = f"{_normalize_key(name)}|{_normalize_key(address or '')}"
        bucket = groups.get(key)
        if bucket is None:
            groups[key] = {
                "name": name,
                "address": address,
                "contact": contact,
                "email": email,
                "phone": phone,
                "project_ids": [project_id],
            }
            continue
        # First-seen wins for each optional field.
        if bucket["address"] is None and address:
            bucket["address"] = address
        if bucket["contact"] is None and contact:
            bucket["contact"] = contact
        if bucket["email"] is None and email:
            bucket["email"] = email
        if bucket["phone"] is None and phone:
            bucket["phone"] = phone
        bucket["project_ids"].append(project_id)

    if not groups:
        return

    customers = sa.table(
        "customers",
        sa.column("id", sa.Integer),
        sa.column("name", sa.String),
        sa.column("address", sa.String),
        sa.column("contact_person", sa.String),
        sa.column("email", sa.String),
        sa.column("phone", sa.String),
        sa.column("created_at", sa.DateTime),
        sa.column("updated_at", sa.DateTime),
    )
    now = sa.func.now()

    for bucket in groups.values():
        result = bind.execute(
            customers.insert()
            .values(
                name=bucket["name"],
                address=bucket["address"],
                contact_person=bucket["contact"],
                email=bucket["email"],
                phone=bucket["phone"],
                created_at=now,
                updated_at=now,
            )
            .returning(customers.c.id)
            if bind.dialect.name == "postgresql"
            else customers.insert().values(
                name=bucket["name"],
                address=bucket["address"],
                contact_person=bucket["contact"],
                email=bucket["email"],
                phone=bucket["phone"],
                created_at=now,
                updated_at=now,
            )
        )
        if bind.dialect.name == "postgresql":
            new_id = result.scalar_one()
        else:
            new_id = result.inserted_primary_key[0]

        bind.execute(
            sa.text("UPDATE projects SET customer_id = :cid WHERE id IN :ids").bindparams(
                sa.bindparam("ids", expanding=True)
            ),
            {"cid": new_id, "ids": bucket["project_ids"]},
        )


def downgrade() -> None:
    with op.batch_alter_table("projects", schema=None) as batch_op:
        batch_op.drop_index("ix_projects_customer_id")
        batch_op.drop_constraint("fk_projects_customer_id", type_="foreignkey")
        batch_op.drop_column("customer_id")

    op.drop_index("ix_customers_archived_at", table_name="customers")
    op.drop_index("ix_customers_name", table_name="customers")
    op.drop_table("customers")
