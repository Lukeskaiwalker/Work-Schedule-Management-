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

from sqlalchemy import JSON, Date, DateTime, ForeignKey, Integer, String, Text
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
    # Preferred email language (v2.5.0+). Two-letter ISO code, currently
    # "de" or "en". Null defaults to "de" — the business is German and
    # customer-facing communications go out in German unless explicitly
    # marked otherwise (driven by the customer-confirmation email flow).
    language: Mapped[str | None] = mapped_column(String(8))
    # "company" or "private". The form used to treat every customer as a
    # person; a firm needs a company name AND a contact person, a private
    # customer only a name. Null = never chosen (rows from before the field).
    customer_type: Mapped[str | None] = mapped_column(String(16))
    # A second number: the office line and the phone that is actually
    # answered on site are rarely the same.
    mobile: Mapped[str | None] = mapped_column(String(128))
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


class CustomerNote(Base):
    """One entry of the customer's note feed — the customer-level twin of
    ``ProjectNote``: posted once, by someone, at a time. The single
    ``customers.notes`` text became the first entry (migration 0092)."""

    __tablename__ = "customer_notes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id", ondelete="CASCADE"), index=True, nullable=False)
    author_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False, index=True)


class CustomerVisit(Base):
    """One write-up of a visit at the customer — the Kundenbesuch feed.

    The visit used to be three columns on the customer (one write-up, over-
    written on every edit); migration 0093 made that write-up the first
    entry here. Each entry may name one of the customer's projects: a
    project's Projektbericht opens with the entries linked to it plus the
    unlinked ones, which are about the customer as such. ``visit_by_user_id``
    is who went — the poster unless the payload names someone else — and
    the one who may edit the entry besides a project manager.
    """

    __tablename__ = "customer_visits"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id", ondelete="CASCADE"), index=True, nullable=False)
    # SET NULL, not CASCADE: a deleted project leaves the write-up with the
    # customer, where it was made.
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"), index=True)
    visit_date: Mapped[date | None] = mapped_column(Date)
    visit_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


class CustomerActivity(Base):
    """A customer-level event for the customer's change log.

    The log used to be the union of the project logs only; what happens to
    the customer itself — a note, a change of Stammdaten, a customer-only
    task — had no row anywhere. Same shape as ``ProjectActivity`` so the
    two union cleanly in ``services/customer_activity``.
    """

    __tablename__ = "customer_activities"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id", ondelete="CASCADE"), index=True, nullable=False)
    actor_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    message: Mapped[str] = mapped_column(String(255), nullable=False)
    details: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False, index=True)
