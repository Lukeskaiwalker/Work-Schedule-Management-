"""Customer helpers shared by router + workflow_projects.

`match_or_create_customer` preserves the legacy API path where callers
still pass `customer_name`/`customer_address` instead of `customer_id`.
Uses the same `_normalize_key` dedupe rule as the migration backfill
and the import pipeline — three code paths, one rule.

`sync_project_from_customer` copies the five legacy fields from a
Customer onto a Project so downstream consumers (PDF, xlsx, weather)
keep working without a model-layer change.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import Customer, Project
from app.services.project_import import _normalize_key


def customer_match_key(name: str | None, address: str | None) -> str:
    """Identical to the migration's group key. Empty address collapses
    to the empty string so (name, None) still matches (name, '')."""
    return f"{_normalize_key(name or '')}|{_normalize_key(address or '')}"


def find_customer_by_name_address(
    db: Session, name: str, address: str | None
) -> Customer | None:
    """Return the Customer whose normalised (name, address) matches, or None.

    Linear scan over non-archived customers with a matching name prefix —
    dataset is small enough (thousands, not millions) that an ILIKE +
    Python-side compare is simpler than stashing a computed key column.
    """
    target_key = customer_match_key(name, address)
    candidates = db.scalars(
        select(Customer).where(
            Customer.archived_at.is_(None),
            Customer.name.ilike(name.strip()),
        )
    ).all()
    for row in candidates:
        if customer_match_key(row.name, row.address) == target_key:
            return row
    return None


def match_or_create_customer(
    db: Session,
    *,
    name: str,
    address: str | None,
    contact_person: str | None,
    email: str | None,
    phone: str | None,
    created_by: int | None,
) -> Customer:
    """Legacy-path bridge: find an existing Customer by normalised key, or
    create one. Does not overwrite existing contact fields on a match —
    the Customer is the source of truth."""
    clean_name = name.strip()
    if not clean_name:
        raise ValueError("name is required")
    clean_address = (address or "").strip() or None
    existing = find_customer_by_name_address(db, clean_name, clean_address)
    if existing is not None:
        return existing
    row = Customer(
        name=clean_name,
        address=clean_address,
        contact_person=(contact_person or None),
        email=(email or None),
        phone=(phone or None),
        created_by=created_by,
    )
    db.add(row)
    db.flush()
    return row


def sync_project_from_customer(project: Project, customer: Customer) -> None:
    """Mirror the Customer's five denormalised fields onto the Project.
    Caller must db.add/commit."""
    project.customer_id = customer.id
    project.customer_name = customer.name
    project.customer_address = customer.address
    project.customer_contact = customer.contact_person
    project.customer_email = customer.email
    project.customer_phone = customer.phone
