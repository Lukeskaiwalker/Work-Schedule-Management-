"""Verteilerpläne — panel schematics for Haupt- und Unterverteiler.

One row here is one distribution board (Verteiler): a Hauptverteiler, an
Unterverteiler, or a Zählerplatz. The board's contents live in a single JSON
document rather than child tables, the same idiom as ``ConstructionReport.
payload`` and ``TrainingWeekReport.days``.

Why one document instead of ``panel_rows`` + ``panel_devices`` tables:

* A Verteiler is edited and read as a whole. Nothing ever asks "every B16
  across all panels" — and if that report is ever wanted, it is a JSON scan
  over a few hundred rows, not a reason to normalise now.
* The editor autosaves the whole board on every change. A document write is
  one UPDATE; a normalised board would be a diff-and-reconcile across two
  child tables on every keystroke, on tablets with flaky site wifi.
* Device *order inside a rail* carries electrical meaning here (see
  ``services/schaltplan_layout.py`` — a device belongs to the last protective
  device before it). Order is intrinsic to a JSON array and needs a
  hand-maintained sort column in a child table.

Scoping and storage
-------------------
A panel always belongs to a **customer**, and optionally to one of that
customer's **projects**. That asymmetry is deliberate and matches how the
crew actually works: the Verteiler belongs to the building, which belongs to
the customer, and outlives any single project. When a panel is captured
during a job it gets the project too, so it shows up on that project; when an
electrician documents an existing board on a service call there may be no
project at all, and forcing one would push them to invent a fake project.

``fed_from_panel_id`` is the HV → UV link: an Unterverteiler points at the
board that feeds it. Self-referential FK, SET NULL on delete so removing a
main panel leaves its sub-panels intact (orphaned but readable) rather than
cascading away a building's whole documentation.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.core.time import utcnow


class PanelPlan(Base):
    __tablename__ = "panel_plans"
    __table_args__ = (
        # Two boards in the same building may not carry the same
        # Betriebsmittelkennzeichen ("UV1"). The designation is what gets
        # written on the door and referenced from every Stromkreis label, so a
        # duplicate is a wiring mistake waiting to happen. Scoped per customer,
        # not globally: every customer has their own "HV".
        UniqueConstraint("customer_id", "designation", name="uq_panel_plan_customer_designation"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    customer_id: Mapped[int] = mapped_column(
        ForeignKey("customers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Optional on purpose — see the module docstring. SET NULL so archiving or
    # deleting a project never destroys the building's panel documentation.
    project_id: Mapped[int | None] = mapped_column(
        ForeignKey("projects.id", ondelete="SET NULL"), index=True
    )

    # "Unterverteiler Werkstatt" — the human name.
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    # "UV1" / "HV" — the Betriebsmittelkennzeichen printed on the board.
    designation: Mapped[str] = mapped_column(String(32), nullable=False)
    # main | sub | meter
    panel_type: Mapped[str] = mapped_column(String(16), nullable=False, default="sub")
    # "Keller, Raum 0.3" — where the board physically hangs.
    location: Mapped[str | None] = mapped_column(String(255))

    fed_from_panel_id: Mapped[int | None] = mapped_column(
        ForeignKey("panel_plans.id", ondelete="SET NULL"), index=True
    )

    # draft | final. A final plan is the as-built documentation handed to the
    # customer; it stays editable (buildings change) but the status drives the
    # "Revision" marking on the PDF title block.
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="draft", index=True)
    # Bumped by the client on every meaningful save so the title block can
    # print "Rev. 3" the way a real Schaltplan does.
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    # {"version": 1, "supply": {...}, "rows": [...]} — see
    # services/schaltplan_layout.py for the full shape and its invariants.
    document: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)

    notes: Mapped[str | None] = mapped_column(Text)

    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, onupdate=utcnow, nullable=False
    )
