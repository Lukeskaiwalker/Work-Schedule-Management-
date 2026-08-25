"""Ausbildungsnachweise — the IHK weekly training reports apprentices must keep.

German apprentices (Auszubildende) are legally required (§ 13 BBiG) to keep a
training record, and the IHK will not admit them to the final exam without it.
The weekly form is a fixed shape: one sheet per calendar week with the
apprentice's name, training year, report number, per-day activities with
hours, and TWO signatures — apprentice and trainer (Ausbilder). Electronic
records and signatures are explicitly permitted since 2017.

One row here is one such weekly sheet.

Design notes:

* ``days`` is a JSON document, not a child table — the same idiom as
  ``ConstructionReport.payload``. A report is a document that is edited as a
  whole and rendered as a whole; nothing ever queries "all Tuesday entries
  across reports". Shape::

      [{"day": "2026-08-10",
        "entries": [{"text": "...", "hours": 8.0, "category": "betrieb"}]},
       ...]

  ``category`` mirrors the three columns of the IHK form: betriebliche
  Tätigkeit ("betrieb"), Unterweisung ("unterweisung"), Berufsschule
  ("schule").

* The status ladder is ``draft → submitted → signed``. Submitting is the
  apprentice signing; ``signed`` means the trainer countersigned. A signed
  report is immutable — it is the legal record the IHK inspects, and silently
  editable history would defeat its purpose. An apprentice may withdraw a
  ``submitted`` report back to draft (clearing their signature) as long as
  the trainer has not signed.

* ``report_number`` is a per-user sequence starting at 1, assigned at
  creation, because the IHK form carries a running "Nachweis Nr.". Gaps after
  deleting a draft are acceptable; renumbering issued reports is not.

* Signatures are stored as data-URL strings, exactly like the construction
  report's ``signature_customer`` / ``signature_smpl`` — same pad component
  on the frontend, same embedding path in the PDF.
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    Date,
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


class TrainingWeekReport(Base):
    __tablename__ = "training_week_reports"
    # One sheet per apprentice per week. The UNIQUE constraint is the guard
    # against the double-submit that would otherwise produce two "Nachweis
    # Nr. 12" for the same week.
    __table_args__ = (
        UniqueConstraint("user_id", "week_start", name="uq_training_report_user_week"),
        # The Nachweis-Nr. is printed on a legal record; a race in the
        # read-max-then-insert numbering must fail loudly here rather than
        # quietly minting two "Nr. 6" sheets.
        UniqueConstraint("user_id", "report_number", name="uq_training_report_user_number"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )

    # Always the MONDAY of the reported week; normalized server-side so the
    # unique constraint means what it says regardless of which day the client
    # happened to send.
    week_start: Mapped[date] = mapped_column(Date, nullable=False, index=True)

    report_number: Mapped[int] = mapped_column(Integer, nullable=False)
    # 1..5 — editable on the sheet like on the paper form. Prefilled from
    # users.training_started_on when that is set.
    ausbildungsjahr: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    # draft | submitted | signed
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="draft", index=True
    )

    days: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    remarks: Mapped[str | None] = mapped_column(Text)

    azubi_signature: Mapped[str | None] = mapped_column(Text)
    azubi_signed_at: Mapped[datetime | None] = mapped_column(DateTime)
    ausbilder_signature: Mapped[str | None] = mapped_column(Text)
    ausbilder_signed_at: Mapped[datetime | None] = mapped_column(DateTime)
    # Who countersigned. SET NULL — the record outlives the trainer's account.
    ausbilder_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, onupdate=utcnow, nullable=False
    )
