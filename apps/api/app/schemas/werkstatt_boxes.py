"""Pydantic schemas for construction boxes (Baustellenkisten).

Kept in its own module rather than appended to ``schemas/werkstatt.py``: that
file is fenced per-persona by WERKSTATT_CONTRACT.md and already ~750 lines, and
boxes are a cross-persona concept.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

BoxStatus = Literal["offen", "gepackt", "zugewiesen", "zurueck"]
BoxItemSource = Literal["article", "catalog", "manual"]


class WerkstattBoxItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    box_id: int
    source: str
    article_id: int | None = None
    catalog_external_key: str | None = None
    item_name: str
    article_no: str | None = None
    ean: str | None = None
    unit: str | None = None
    quantity: int
    notes: str | None = None


class WerkstattBoxOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    box_number: str
    label: str
    # 1..8 for the fixed workshop boxes, null for ad-hoc ones.
    slot: int | None = None
    status: str
    customer_id: int | None = None
    customer_name: str | None = None
    project_id: int | None = None
    project_name: str | None = None
    item_count: int = 0
    packed_at: datetime | None = None
    assigned_at: datetime | None = None
    returned_at: datetime | None = None
    notes: str | None = None
    created_at: datetime | None = None
    items: list[WerkstattBoxItemOut] = []


class WerkstattBoxCreate(BaseModel):
    label: str
    customer_id: int | None = None
    project_id: int | None = None
    notes: str | None = None


class WerkstattBoxUpdate(BaseModel):
    label: str | None = None
    project_id: int | None = None
    notes: str | None = None


class WerkstattBoxStatusPayload(BaseModel):
    status: BoxStatus


class WerkstattBoxAssignPayload(BaseModel):
    customer_id: int
    project_id: int | None = None


# Upper bound on every count that names a number of things in a crate. Same
# reasoning as ``schemas/station.STATION_MAX_QUANTITY``, and deliberately the
# same number: an integer wider than the column reaches ``db.flush()`` and
# comes back as an OverflowError/DataError, which is an unhandled 500 rather
# than a refusal a screen can render. The value is far past anything somebody
# standing at a crate — with a scanner or with a phone — can mean.
MAX_BOX_QUANTITY = 10_000


class WerkstattBoxItemCreate(BaseModel):
    """Add a line. Supply an ``article_id`` for stocked items, a
    ``catalog_external_key`` for Datanorm-only items, or just a name."""

    source: BoxItemSource | None = None
    article_id: int | None = None
    catalog_external_key: str | None = None
    item_name: str | None = None
    article_no: str | None = None
    ean: str | None = None
    unit: str | None = None
    # Bounded above, and deliberately not below. ``le`` is the half that was
    # missing here while both station bodies already had it: a value wider
    # than the column travelled all the way to ``db.flush()`` and came back as
    # an OverflowError/DataError — an unhandled 500 raised past the endpoint's
    # own error handling, with nothing rolled back. No ``ge``, because "<= 0"
    # is a rule ``add_item_to_box`` already owns and answers with a 400: a
    # cleared spinner must not mean one thing on the phone and another at the
    # wall.
    quantity: int = Field(default=1, le=MAX_BOX_QUANTITY)
    notes: str | None = None


class WerkstattBoxItemUpdate(BaseModel):
    item_name: str | None = None
    unit: str | None = None
    # Same bound as the create side, and for the same reason: correcting a
    # line writes the number straight into the column, so an unbounded one
    # crashes ``db.flush()`` exactly the way adding one did. ``None`` still
    # means "leave the count alone", and "<= 0" stays the router's 400.
    quantity: int | None = Field(default=None, le=MAX_BOX_QUANTITY)
    notes: str | None = None


# How a hit matched the query. Everything except "partial" is an exact match
# on a scannable identifier, which is what makes a scan safe to auto-add.
ItemMatchKind = Literal[
    "exact_internal_code",
    "exact_ean",
    "exact_article_no",
    "exact_supplier_no",
    "partial",
]


class WerkstattItemSearchHit(BaseModel):
    """One row in the unified article + Datanorm-catalog search."""

    source: BoxItemSource
    article_id: int | None = None
    catalog_external_key: str | None = None
    item_name: str
    article_no: str | None = None
    ean: str | None = None
    unit: str | None = None
    # Only meaningful for stocked articles; catalog hits render as "not in stock".
    stock_available: int | None = None
    match: ItemMatchKind = "partial"
    # Set when the hit came from a supplier's own article number — e.g. the
    # Unielektro number for an article we hold under our own SP-number.
    supplier_name: str | None = None
    supplier_article_no: str | None = None


class WerkstattBoxSelectableOut(BaseModel):
    """A box as offered by the task form's picker.

    Deliberately not ``WerkstattBoxOut``: it carries the server-computed
    ``group`` (so all three task forms sort and label identically without
    duplicating the merge logic), and it is built from batched queries rather
    than ``box_out``'s per-row lookups.
    """

    id: int
    box_number: str
    label: str
    slot: int | None = None
    status: str
    item_count: int = 0
    customer_id: int | None = None
    customer_name: str | None = None
    project_id: int | None = None
    project_name: str | None = None
    # customer = already belongs to the task's customer; free = in the rack,
    # unclaimed; other = at a different customer (search-only).
    group: Literal["customer", "free", "other"]


# ── Label ─────────────────────────────────────────────────────────────────────


class WerkstattBoxLabelPrintOut(BaseModel):
    """What was printed, so the UI can show the code now on the crate.

    Deliberately has no ``minted`` flag, unlike the article label: a box is
    born with a ``box_number``, so ``code`` is derived rather than allocated
    and a reprint is always the same sticker.
    """

    box_id: int
    box_number: str
    # "KISTE-<box_number>" — what the DataMatrix holds and what the station's
    # box list reports as ``code``.
    code: str
    printer: str


# ── Station-scoped views (the wall-mounted scan station) ──────────────────────


class WerkstattStationBoxOut(WerkstattBoxOut):
    """A box as the Pi's box screen sees it.

    Everything ``WerkstattBoxOut`` carries, plus three fields the station
    contract names:

    * ``code`` — "KISTE-<box_number>", what the crate's DataMatrix holds, so
      the screen can match a scan against the list it is already showing
      without knowing how box labels are formatted;
    * ``customer`` / ``project`` — the station contract's spelling of
      ``customer_name`` / ``project_name``. Duplicated rather than renamed
      because the web UI reads the ``_name`` pair and the wall screens read
      these; one of the two would otherwise have to be taught the other's
      vocabulary for no gain.

    Items are always included — the whole screen is "what is in which crate".
    """

    code: str
    customer: str | None = None
    project: str | None = None


class WerkstattStationBoxItemCreate(BaseModel):
    """Scan something into a box.

    ``code`` is what the scanner read; the server runs it through the same
    resolve cascade the phone uses. ``article_id`` is the pre-resolved form,
    for a screen that has already looked the article up. Exactly one of the
    two is required — a wall screen has nobody to type a name, so there is
    deliberately no free-text line here.
    """

    code: str | None = None
    article_id: int | None = None
    quantity: int = Field(default=1, ge=1, le=MAX_BOX_QUANTITY)


class WerkstattStationBoxItemRemove(BaseModel):
    """Take a counted amount off one line. See ``remove_item_from_box``.

    Bounded like the create side. Note that asking for *more than the line
    holds* is still fine and empties it — the screen's count can be one scan
    stale — so the bound is about the integer, not about the line.
    """

    item_id: int
    quantity: int = Field(default=1, ge=1, le=MAX_BOX_QUANTITY)


class WerkstattStationBoxItemRemoveOut(BaseModel):
    """How many were actually taken off — never more than the line held."""

    removed: int
