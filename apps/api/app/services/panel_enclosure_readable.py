"""The stored board as every read path sees it (docs/PANEL_ENCLOSURE.md D14).

Slice P stored ``enclosure`` and ``supplied_by`` as opaque JSON, so a board
may hold a block the feature's types refuse — written while P was live, or
after a rollback to it. Such a board must still open: the block is left out,
with one finding, and the next save drops it for good. Rows and devices stay.

"Left out" has to mean the same on every route. The detail route numbers the
WAGO terminals from the readable board, so the label print, the Plan PDF, the
Materialliste and the Aufbau PDF read that same board (``readable_blocks``);
otherwise the printed X numbers and the lists would disagree with the screen
until the next save (docs/PANEL_ENCLOSURE_R2.md §3.1, §5.1).

Kept apart from ``panel_enclosure_service`` so that ``schaltplan_material``,
which that service imports, can read the board the same way.
"""

from __future__ import annotations

from typing import Any

from pydantic import ValidationError

from app.schemas.panel_enclosure import DeviceSuppliedBy
from app.schemas.schaltplan import PanelDocument

INVALID_BLOCK = (
    "Schrankdaten fehlerhaft gespeichert — ausgeblendet und beim nächsten Speichern entfernt; "
    "Reihen und Geräte bleiben."
)

__all__ = ["INVALID_BLOCK", "readable_blocks", "readable_document"]


def readable_document(document: Any) -> tuple[Any, PanelDocument, list[dict[str, str]]]:
    """(the document to derive from, its typed form, findings) for the read path.

    The cabinet blocks that do not validate are left out, with one finding.
    Anything else that fails validation fails as it always did; this is no
    general repair.
    """
    try:
        return document, PanelDocument.model_validate(document), []
    except ValidationError:
        cleaned = readable_blocks(document)
        if cleaned is document:
            raise
    finding = {"level": "warn", "scope": "", "message": INVALID_BLOCK, "rule": "encl.invalid_block"}
    return cleaned, PanelDocument.model_validate(cleaned), [finding]


def readable_blocks(document: Any) -> Any:
    """A copy without the cabinet blocks that do not validate; the input itself when every one does.

    Never raises: it checks the cabinet block and each ``supplied_by`` claim
    on their own, not the whole document, so a route that never validated the
    board does not start refusing it.
    """
    if not isinstance(document, dict):
        return document
    out = document
    if document.get("enclosure") is not None and not _readable_enclosure(document["enclosure"]):
        out = {**out, "enclosure": None}
    rows = document.get("rows")
    if isinstance(rows, list):
        cleaned = [_row_without_bad_claims(row) for row in rows]
        if any(new is not old for new, old in zip(cleaned, rows)):
            out = {**out, "rows": cleaned}
    return out


def _row_without_bad_claims(row: Any) -> Any:
    if not isinstance(row, dict) or not isinstance(row.get("devices"), list):
        return row
    devices = [_device_without_bad_claim(device) for device in row["devices"]]
    return {**row, "devices": devices} if any(new is not old for new, old in zip(devices, row["devices"])) else row


def _device_without_bad_claim(device: Any) -> Any:
    if not isinstance(device, dict) or device.get("supplied_by") is None:
        return device
    try:
        DeviceSuppliedBy.model_validate(device["supplied_by"])
    except ValidationError:
        return {**device, "supplied_by": None}
    return device


def _readable_enclosure(enclosure: Any) -> bool:
    # Through the document, so the 64 KB ceiling (measured with defaults
    # filled in, unlike Slice P's raw measure) is part of the check.
    try:
        PanelDocument.model_validate({"enclosure": enclosure})
    except ValidationError:
        return False
    return True
