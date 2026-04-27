"""Customer model — first-class replacement for the denormalised
`projects.customer_*` columns.

A Customer aggregates contact data (name/address/contact/email/phone/tax_id)
that was previously copied onto every Project row. Projects keep a FK
(`customer_id`) plus their existing `customer_*` mirror columns as a cache
for legacy consumers (PDF/xlsx exports, weather resolver) — see
`workflow_projects.py` for the sync logic that keeps them in step.

Archiving is soft (`archived_at`); there is no hard delete. Deleting a
user only clears `created_by` (SET NULL), never the Customer itself.
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import Date, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.core.time import utcnow


class Customer(Base):
    __tablename__ = "customers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    address: Mapped[str | None] = mapped_column(String(500))
    contact_person: Mapped[str | None] = mapped_column(String(255))
    email: Mapped[str | None] = mapped_column(String(255))
    phone: Mapped[str | None] = mapped_column(String(128))
    tax_id: Mapped[str | None] = mapped_column(String(64))
    notes: Mapped[str | None] = mapped_column(Text)
    # Optional birthday for individual contacts. Calendar `date` (not
    # datetime) — purely informational, surfaced in the customer card so
    # field staff can wish a private customer happy birthday on visits.
    birthday: Mapped[date | None] = mapped_column(Date)
    # Marktakteur-Nummer from the German Marktstammdatenregister (MaStR),
    # used when the customer is the operator of a PV / energy installation.
    # Format example: "SEE901234567890" — registry IDs run up to ~15 chars
    # but the column is wider for safety against future format changes.
    marktakteur_nummer: Mapped[str | None] = mapped_column(String(64))
    archived_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, onupdate=utcnow, nullable=False
    )
