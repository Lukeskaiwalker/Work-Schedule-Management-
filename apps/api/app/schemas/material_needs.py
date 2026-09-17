"""Payloads for the Projekt-Bedarfe bulk actions and the order hand-off.

Separate from ``schemas/materials.py`` (which describes one need) because
these describe operations over MANY needs, and because the order hand-off
response embeds ``WerkstattOrderOut`` — an import the per-row schemas have no
reason to carry.

The response of the hand-off is deliberately three lists rather than a count:
the modal has to show what it did NOT do, per row and with a reason, or the
office is back to comparing two screens by hand.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.werkstatt import WerkstattOrderOut

# Why a selected need did not become an order line. The web maps each to a
# German sentence (utils/materials.ts::needSkipReasonLabel) — keep the two
# in step.
MaterialNeedSkipReason = Literal[
    "already_ordered",
    "completed",
    "no_catalog_item",
    "no_supplier",
    "other_supplier",
]


class MaterialNeedBulkUpdate(BaseModel):
    """Set a status and/or a note on many needs at once.

    The 500 ceiling is not a performance guard — it is the size beyond which
    "I selected everything" was almost certainly a mistake, and one round trip
    should not be able to rewrite a year of needs.
    """

    ids: list[int] = Field(min_length=1, max_length=500)
    status: str | None = Field(default=None, min_length=1, max_length=32)
    notes: str | None = None


class MaterialNeedBulkDelete(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=500)


class MaterialNeedBulkDeleteResult(BaseModel):
    deleted: int = 0


class MaterialNeedOrderRequest(BaseModel):
    """Turn selected needs into order lines.

    ``supplier_id`` narrows the selection to one supplier's needs; ``order_id``
    appends to an existing draft (whose supplier then IS the filter). Given
    neither, every supplier in the selection gets its own draft.
    """

    need_ids: list[int] = Field(min_length=1, max_length=500)
    supplier_id: int | None = None
    order_id: int | None = None
    title: str | None = Field(default=None, max_length=255)


class MaterialNeedOrderAdded(BaseModel):
    need_id: int
    order_id: int
    line_id: int
    # German, ready to render: "Menge '2,5' auf 3 aufgerundet – bitte prüfen".
    # None when the quantity carried over exactly.
    quantity_warning: str | None = None


class MaterialNeedOrderSkipped(BaseModel):
    need_id: int
    reason: MaterialNeedSkipReason
    # The order it already sits on, when that is why it was skipped.
    order_number: str | None = None


class MaterialNeedOrderResult(BaseModel):
    orders: list[WerkstattOrderOut] = Field(default_factory=list)
    added: list[MaterialNeedOrderAdded] = Field(default_factory=list)
    skipped: list[MaterialNeedOrderSkipped] = Field(default_factory=list)
    created_at: datetime | None = None
