"""Inventur — stock-taking sessions and the counts inside them.

A stock-take is a *session*, not a series of edits. That distinction is the
whole design:

* while a session is open, counting is append-only and completely reversible.
  Nothing touches real stock, so a half-finished count on a Friday afternoon
  cannot corrupt Monday's picking;
* only ``finalize`` turns counts into ledger movements, in one transaction,
  and it records what the system *expected* alongside what was *counted* — so
  the variance stays auditable after the fact rather than being silently
  absorbed into the stock figure.

``scan_count`` is kept separate from ``counted_qty`` because the operator
enters quantity by scanning the same barcode repeatedly. They are normally
equal, but a hand-typed correction moves ``counted_qty`` alone, and keeping
both makes "did they scan 47 times or type 47?" answerable.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.core.time import utcnow


class WerkstattInventorySession(Base):
    __tablename__ = "werkstatt_inventory_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)

    # open | finalized | cancelled. Enforced in the app layer, like every other
    # status in this schema.
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="open", index=True)

    # Optional scope. A stock-take is usually "Halle 1", not the whole company.
    location_id: Mapped[int | None] = mapped_column(
        ForeignKey("werkstatt_locations.id", ondelete="SET NULL"), index=True
    )

    started_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    started_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    finalized_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    finalized_at: Mapped[datetime | None] = mapped_column(DateTime)

    notes: Mapped[str | None] = mapped_column(Text)

    # Provenance when the counts came off the office scan station rather than
    # from a live scan. The Pi keeps its own sessions by name; importing one
    # here records which station and which of its sessions fed this row, and
    # when. That is what lets the Scan-Station page say "Übernommen · <stamp>"
    # next to a Pi session and route a re-import into the same open inventory
    # instead of a second one. One link per inventory session: importing a
    # second Pi session into the same target repoints it to the latest.
    source_station_id: Mapped[int | None] = mapped_column(
        ForeignKey("stations.id", ondelete="SET NULL"), index=True
    )
    source_session_name: Mapped[str | None] = mapped_column(String(64))
    source_imported_at: Mapped[datetime | None] = mapped_column(DateTime)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, onupdate=utcnow, nullable=False
    )


class WerkstattInventoryCount(Base):
    __tablename__ = "werkstatt_inventory_counts"
    # One row per article per session. The scan endpoint upserts against this,
    # so a repeated scan increments rather than inserting a duplicate line.
    __table_args__ = (
        UniqueConstraint("session_id", "article_id", name="uq_inventory_count_session_article"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(
        ForeignKey("werkstatt_inventory_sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    article_id: Mapped[int] = mapped_column(
        ForeignKey("werkstatt_articles.id", ondelete="CASCADE"), nullable=False, index=True
    )

    counted_qty: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # How many scans produced that quantity. Diverges from counted_qty only
    # when someone types a correction.
    scan_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # What the snapshot said at finalize time. Written by finalize, not by
    # counting — recording it at scan time would capture a figure that later
    # movements invalidate before the session closes.
    expected_qty: Mapped[int | None] = mapped_column(Integer)

    first_counted_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    last_counted_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, onupdate=utcnow, nullable=False
    )
