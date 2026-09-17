"""What may go into a crate, and what may come back out of it.

Lifted out of ``routers/workflow_werkstatt_boxes.py``: these are the rules,
not the routing, and two very different callers run them — the desktop's
Kisten page with a login, and the wall-mounted scan station with a device
token. Keeping them in the router that happens to declare the first of those
made "a handed-over box is frozen" look like a property of one endpoint
instead of a property of a crate.

Both functions commit: they are single-write operations whose callers have
nothing else in the transaction, and a scan at the wall that did not land
before the screen refreshed would be worse than a wide transaction.
"""
from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import (
    WerkstattArticle,
    WerkstattConstructionBox,
    WerkstattConstructionBoxItem,
)
from app.schemas.werkstatt_boxes import WerkstattBoxItemCreate
from app.services.werkstatt_boxes import PACKED_EMPTY_DETAIL, box_line_count


# The German a locked crate answers with. Next to its rule, like the sealing
# refusals in ``services/werkstatt_boxes.py``: the workshop reads these
# verbatim, on the desktop and on the wall screen.
BOX_LOCKED_DETAIL = (
    "Die Kiste ist beim Kunden — ihr Inhalt kann nicht mehr geändert werden."
)


def ensure_box_unlocked(box: WerkstattConstructionBox) -> None:
    """A box handed to a customer is a closed record. Refuse content changes."""
    if box.status == "zugewiesen":
        raise HTTPException(status_code=400, detail=BOX_LOCKED_DETAIL)


def ensure_packed_box_keeps_content(
    db: Session, box: WerkstattConstructionBox, *, lines_removed: int
) -> None:
    """A sealed crate may not be emptied — the same rule sealing it asserts.

    ``gepackt`` says *this crate is packed for that customer and ready to be
    carried out*, and three places believe it: the assign card, the wall
    screen's pulsing "Mitnehmen zu …", and the station's handover endpoint,
    which will happily flip an empty crate to ``zugewiesen`` with no movements
    at all. Checking only at sealing time left the claim standing over a crate
    whose last line had since been taken back out, one ``DELETE`` at a time.

    The way out is the assignment, not the contents: "Zuweisung aufheben"
    (``gepackt → offen``) hands the crate back to the packing bench with
    everything still in it.
    """
    if lines_removed <= 0:
        return
    if (box.status or "offen") != "gepackt":
        return
    if box_line_count(db, box.id) - lines_removed <= 0:
        raise HTTPException(status_code=400, detail=PACKED_EMPTY_DETAIL)


def add_item_to_box(
    db: Session,
    box: WerkstattConstructionBox,
    payload: WerkstattBoxItemCreate,
    *,
    added_by: int | None,
) -> WerkstattConstructionBoxItem:
    """Add (or top up) a line in the box.

    Identity is snapshotted at pack time. When an article is referenced its
    master data wins; otherwise we take what the caller scanned/typed. Adding
    the same article twice increments the existing line rather than creating a
    duplicate — on a phone, and on a wall screen, that is what a second scan
    means.

    ``added_by`` is nullable: a station has no user behind it, and inventing
    one to fill the column would be worse than leaving it empty (nothing about
    a packed line depends on knowing who scanned it).
    """
    ensure_box_unlocked(box)

    # NOT ``payload.quantity or 1``: that maps an explicit 0 to 1 before the
    # guard below can ever see it, so a cleared spinner or a scanner that
    # reported nothing silently packed one unit into the crate. Only a missing
    # value defaults.
    quantity = int(payload.quantity if payload.quantity is not None else 1)
    if quantity <= 0:
        raise HTTPException(status_code=400, detail="quantity must be positive")

    item_name = (payload.item_name or "").strip()
    article_no = payload.article_no
    ean = payload.ean
    unit = payload.unit
    source = payload.source or "manual"

    if payload.article_id is not None:
        article = db.get(WerkstattArticle, payload.article_id)
        if article is None:
            raise HTTPException(status_code=400, detail=f"Unknown article id: {payload.article_id}")
        source = "article"
        item_name = item_name or (article.item_name or "")
        article_no = article_no or article.article_number
        ean = ean or article.ean
        unit = unit or article.unit

    if not item_name:
        raise HTTPException(status_code=400, detail="item_name is required")

    # Merge a repeat scan of the same article into the existing line.
    if payload.article_id is not None:
        existing = db.scalars(
            select(WerkstattConstructionBoxItem).where(
                WerkstattConstructionBoxItem.box_id == box.id,
                WerkstattConstructionBoxItem.article_id == payload.article_id,
            )
        ).first()
        if existing is not None:
            existing.quantity = int(existing.quantity or 0) + quantity
            existing.updated_at = utcnow()
            db.add(existing)
            db.commit()
            db.refresh(existing)
            return existing

    row = WerkstattConstructionBoxItem(
        box_id=box.id,
        source=source,
        article_id=payload.article_id,
        catalog_external_key=payload.catalog_external_key,
        item_name=item_name,
        article_no=article_no,
        ean=ean,
        unit=unit,
        quantity=quantity,
        notes=payload.notes,
        added_by=added_by,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def remove_item_from_box(
    db: Session,
    box: WerkstattConstructionBox,
    item_id: int,
    *,
    quantity: int | None,
) -> int:
    """Take ``quantity`` off a line — ``None`` means the whole line. Returns
    how many were actually removed.

    Asking for more than the line holds empties it rather than failing: the
    screen doing the asking can be one scan out of date, and "take it out" is
    unambiguous either way.
    """
    ensure_box_unlocked(box)

    row = db.get(WerkstattConstructionBoxItem, item_id)
    if row is None or row.box_id != box.id:
        raise HTTPException(status_code=404, detail="Box item not found")

    held = int(row.quantity or 0)
    if quantity is None:
        # "The line goes" — unconditional, so a row that somehow holds zero is
        # still removable rather than being rejected by the positive check.
        ensure_packed_box_keeps_content(db, box, lines_removed=1)
        db.delete(row)
        db.commit()
        return held

    wanted = int(quantity)
    if wanted <= 0:
        raise HTTPException(status_code=400, detail="quantity must be positive")

    removed = min(wanted, held)
    if removed >= held:
        ensure_packed_box_keeps_content(db, box, lines_removed=1)
        db.delete(row)
    else:
        row.quantity = held - removed
        row.updated_at = utcnow()
        db.add(row)
    db.commit()
    return removed
