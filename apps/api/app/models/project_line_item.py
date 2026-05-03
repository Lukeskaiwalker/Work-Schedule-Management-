"""ProjectLineItem — captures what was sold/ordered/delivered per project.

Designed during the v2.4.0 planning round. Key design decisions:

1. **Status is derived, not stored**. The `status` property below
   computes the current state ("offen" / "bestellt" / "vollständig
   im Lager" / etc.) from the five quantity columns. Single source of
   truth, no state-machine maintenance, no possible inconsistency
   between stored status and stored quantities.

2. **Hierarchical numbering preserved as flat data**. The AB has
   sections like ``01.01`` under section ``01 Baustelle``. We store
   the section name in ``section_title`` and the original numbering
   in ``position`` so every item is independently addressable while
   still letting the UI re-group by section for display.

3. **SKUs are extracted from descriptions when identifiable**. The
   description from the AB usually embeds a manufacturer SKU
   ("WINAICO WST-485BD/X54-B2 Solarmodul"). When the LLM can spot the
   SKU pattern it goes in ``sku``; the original description stays
   intact so nothing is lost.

4. **Supplier link is optional and informational only**. An item may
   have a supplier hint from extraction (or from the operator's
   manual entry) but the absence of a link is fine — line items are
   project-scoped, not supplier-scoped.

5. **Audit trail per item** distinguishes manual entries from
   LLM-extracted ones. ``extracted_by_model`` records which model
   produced the row; ``source_doc_filename`` ties it back to the
   original PDF so an operator can always trace "where did this come
   from?".
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.core.time import utcnow


# Sentinel-ish constants — keep status-derivation logic here so callers
# all use the same vocabulary and nothing drifts. The v2.4.0 plan
# enumerated 7 status values; if we ever want more, add them here.
STATUS_OFFEN = "offen"
STATUS_TEILBESTELLT = "teilbestellt"
STATUS_BESTELLT = "bestellt"
STATUS_TEILGELIEFERT = "teilgeliefert"
STATUS_VOLLSTAENDIG_IM_LAGER = "vollstaendig_im_lager"
STATUS_TEILWEISE_AUF_BAUSTELLE = "teilweise_auf_baustelle"
STATUS_VOLLSTAENDIG_AUF_BAUSTELLE = "vollstaendig_auf_baustelle"


class ProjectLineItem(Base):
    __tablename__ = "project_line_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )

    # ── classification ──────────────────────────────────────────────
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    """One of "material" / "leistung" / "sonstige". String rather than
    Enum so we can adjust without a migration."""

    # ── core fields ─────────────────────────────────────────────────
    section_title: Mapped[str | None] = mapped_column(String(255))
    position: Mapped[str | None] = mapped_column(String(32))
    description: Mapped[str] = mapped_column(Text, nullable=False)

    # ── identifiers ─────────────────────────────────────────────────
    sku: Mapped[str | None] = mapped_column(String(255))
    manufacturer: Mapped[str | None] = mapped_column(String(128))

    # ── quantities ──────────────────────────────────────────────────
    # All Numeric(12, 2) — supports values up to 999,999,999.99 with
    # 2 decimal places. Plenty for cable-meters or panel counts.
    quantity_required: Mapped[Decimal] = mapped_column(
        Numeric(12, 2), nullable=False
    )
    quantity_ordered: Mapped[Decimal] = mapped_column(
        Numeric(12, 2), nullable=False, default=Decimal("0")
    )
    quantity_delivered: Mapped[Decimal] = mapped_column(
        Numeric(12, 2), nullable=False, default=Decimal("0")
    )
    quantity_at_site: Mapped[Decimal] = mapped_column(
        Numeric(12, 2), nullable=False, default=Decimal("0")
    )
    quantity_reserved: Mapped[Decimal] = mapped_column(
        Numeric(12, 2), nullable=False, default=Decimal("0")
    )
    unit: Mapped[str | None] = mapped_column(String(32))

    # ── pricing (AB only) ────────────────────────────────────────────
    unit_price_eur: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    total_price_eur: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))

    # ── linkage ──────────────────────────────────────────────────────
    supplier_id: Mapped[int | None] = mapped_column(
        ForeignKey("werkstatt_suppliers.id", ondelete="SET NULL"), index=True
    )

    # ── extraction audit trail ──────────────────────────────────────
    source_doc_type: Mapped[str | None] = mapped_column(String(64))
    """One of "auftragsbestaetigung" / "bestellbestaetigung" /
    "lieferschein" / "manuell" / null."""
    source_doc_filename: Mapped[str | None] = mapped_column(String(500))
    extracted_by_model: Mapped[str | None] = mapped_column(String(128))
    """e.g. "gpt-4o-mini" or null when manually entered."""
    extraction_confidence: Mapped[Decimal | None] = mapped_column(Numeric(4, 2))
    """0.00–1.00 — LLM's per-item confidence score (null for manual)."""
    notes: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    # ── audit ────────────────────────────────────────────────────────
    created_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, onupdate=utcnow, nullable=False
    )

    @property
    def status(self) -> str:
        """Derive the human-readable status from the quantity columns.

        Priority order matches the v2.4.0 design discussion: site-state
        beats lager-state beats order-state. All thresholds are
        ``>=`` against ``quantity_required`` so a partial-but-equal
        delivery (rare but possible: required=10, delivered=10, but
        the operator hasn't moved any to site yet) reports
        "vollstaendig_im_lager", not "vollstaendig_auf_baustelle".
        """
        req = self.quantity_required or Decimal("0")
        ord_ = self.quantity_ordered or Decimal("0")
        dlv = self.quantity_delivered or Decimal("0")
        site = self.quantity_at_site or Decimal("0")

        if req <= 0:
            # Defensive: an item with zero/negative required-qty is a
            # data bug; "offen" is the least-misleading thing to show.
            return STATUS_OFFEN
        if site >= req:
            return STATUS_VOLLSTAENDIG_AUF_BAUSTELLE
        if site > 0:
            return STATUS_TEILWEISE_AUF_BAUSTELLE
        if dlv >= req:
            return STATUS_VOLLSTAENDIG_IM_LAGER
        if dlv > 0:
            return STATUS_TEILGELIEFERT
        if ord_ >= req:
            return STATUS_BESTELLT
        if ord_ > 0:
            return STATUS_TEILBESTELLT
        return STATUS_OFFEN

    @property
    def quantity_missing(self) -> Decimal:
        """How many units are still 'unaccounted for' — neither at site
        nor delivered nor on order. Useful for the "what's left to
        order?" report. Always >= 0 (we don't return negative even if
        ordered exceeds required, e.g. due to over-ordering)."""
        req = self.quantity_required or Decimal("0")
        ord_ = self.quantity_ordered or Decimal("0")
        return max(Decimal("0"), req - ord_)
