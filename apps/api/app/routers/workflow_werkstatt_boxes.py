"""Construction boxes (Baustellenkisten) — CRUD, packing, assignment.

Two routers live here:

  * ``router``            — mounted under ``/api/werkstatt`` with the other
    Werkstatt personas. Boxes are genuinely cross-persona (a phone packs them,
    the desktop assigns them), so they sit next to the desktop composite rather
    than inside it.
  * ``customer_boxes_router`` — the customer-scoped read used by the customer
    page, mounted at the top level so the URL is ``/api/customers/{id}/boxes``.
    Mirrors how the customer-scoped construction-reports list is declared inside
    the reports router.

Gating follows the established Werkstatt convention (there is no
``werkstatt:view`` permission in this codebase — only ``werkstatt:manage``):
reads are authenticated-only so field staff can actually use them, mutations
require ``werkstatt:manage``. The one deliberate exception is packing (adding /
removing items), which is authenticated-only for the same reason the mobile
checkout/return endpoints are: the people packing crates are not admins.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user, require_permission
from app.core.time import utcnow
from app.models.entities import (
    Customer,
    Project,
    User,
    WerkstattConstructionBox,
    WerkstattConstructionBoxItem,
)
from app.schemas.werkstatt_boxes import (
    WerkstattBoxAssignPayload,
    WerkstattBoxCreate,
    WerkstattBoxItemCreate,
    WerkstattBoxItemOut,
    WerkstattBoxItemUpdate,
    WerkstattBoxLabelPrintOut,
    WerkstattBoxOut,
    WerkstattBoxSelectableOut,
    WerkstattBoxStatusPayload,
    WerkstattBoxUpdate,
    WerkstattItemSearchHit,
)
from app.services import werkstatt_box_labels, werkstatt_labels
from app.services.werkstatt_box_items import (
    add_item_to_box,
    ensure_box_unlocked,
    ensure_packed_box_keeps_content,
    remove_item_from_box,
)
from app.services.werkstatt_item_search import search_box_items
from app.services.werkstatt_boxes import (
    ensure_standard_boxes,
    next_box_number,
    pack_box,
    transition_box,
)

router = APIRouter(prefix="/werkstatt", tags=["werkstatt-boxes"])
customer_boxes_router = APIRouter(prefix="", tags=["werkstatt-boxes"])


# ── Serialisation ─────────────────────────────────────────────────────────────


def item_out(row: WerkstattConstructionBoxItem) -> WerkstattBoxItemOut:
    return WerkstattBoxItemOut(
        id=row.id,
        box_id=row.box_id,
        source=row.source,
        article_id=row.article_id,
        catalog_external_key=row.catalog_external_key,
        item_name=row.item_name,
        article_no=row.article_no,
        ean=row.ean,
        unit=row.unit,
        quantity=row.quantity,
        notes=row.notes,
    )


def box_out(db: Session, box: WerkstattConstructionBox, *, with_items: bool) -> WerkstattBoxOut:
    customer = db.get(Customer, box.customer_id) if box.customer_id is not None else None
    project = db.get(Project, box.project_id) if box.project_id is not None else None
    item_count = int(
        db.scalar(
            select(func.count(WerkstattConstructionBoxItem.id)).where(
                WerkstattConstructionBoxItem.box_id == box.id
            )
        )
        or 0
    )
    items: list[WerkstattBoxItemOut] = []
    if with_items:
        rows = db.scalars(
            select(WerkstattConstructionBoxItem)
            .where(WerkstattConstructionBoxItem.box_id == box.id)
            .order_by(WerkstattConstructionBoxItem.id.asc())
        ).all()
        items = [item_out(row) for row in rows]
    return WerkstattBoxOut(
        id=box.id,
        box_number=box.box_number,
        label=box.label,
        slot=box.slot,
        status=box.status,
        customer_id=box.customer_id,
        customer_name=customer.name if customer else None,
        project_id=box.project_id,
        project_name=project.name if project else None,
        item_count=item_count,
        packed_at=box.packed_at,
        assigned_at=box.assigned_at,
        returned_at=box.returned_at,
        notes=box.notes,
        created_at=box.created_at,
        items=items,
    )


def get_box_or_404(db: Session, box_id: int) -> WerkstattConstructionBox:
    box = db.get(WerkstattConstructionBox, box_id)
    if box is None:
        raise HTTPException(status_code=404, detail="Construction box not found")
    return box


# ── The scannable identity of a box ───────────────────────────────────────────

# What goes into the DataMatrix on the box's label. Prefixed rather than bare
# so a scanner reading "K3" off a crate cannot collide with an article number,
# and so the string is self-describing to anything that sees it later.
BOX_CODE_PREFIX = "KISTE-"


def box_code(box: WerkstattConstructionBox) -> str:
    """The string printed on the box's label, and reported as ``code``.

    One function rather than an f-string at each site: the printer and the
    station's box list have to agree exactly, and two literals in two files is
    how they would stop agreeing.
    """
    return f"{BOX_CODE_PREFIX}{box.box_number}"


# ── Boxes ─────────────────────────────────────────────────────────────────────


@router.get("/boxes", response_model=list[WerkstattBoxOut])
def list_boxes(
    status: str | None = None,
    customer_id: int | None = None,
    q: str | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # The eight fixed workshop boxes are seeded here rather than at startup so
    # they exist the first time anybody opens the tab — see ensure_standard_boxes.
    ensure_standard_boxes(db)

    stmt = select(WerkstattConstructionBox)
    if status:
        stmt = stmt.where(WerkstattConstructionBox.status == status)
    if customer_id is not None:
        stmt = stmt.where(WerkstattConstructionBox.customer_id == customer_id)
    if q and q.strip():
        needle = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(
                WerkstattConstructionBox.label.ilike(needle),
                WerkstattConstructionBox.box_number.ilike(needle),
            )
        )
    # Standard rack first, in rack order; ad-hoc boxes after, newest first.
    stmt = stmt.order_by(
        WerkstattConstructionBox.slot.is_(None),
        WerkstattConstructionBox.slot.asc(),
        WerkstattConstructionBox.created_at.desc(),
    ).limit(limit)
    return [box_out(db, row, with_items=False) for row in db.scalars(stmt).all()]


# NOTE: must stay ABOVE ``/boxes/{box_id}`` — FastAPI matches in declaration
# order, and "selectable" would otherwise be parsed as a box_id and 422.
@router.get("/boxes/selectable", response_model=list[WerkstattBoxSelectableOut])
def list_selectable_boxes(
    customer_id: int | None = None,
    include_box_id: int | None = None,
    q: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Boxes offered by the task form's box picker.

    Neither existing list answers this question. ``GET /boxes?customer_id=X``
    and ``GET /customers/{id}/boxes`` both match ``customer_id`` exactly, so at
    task-creation time — when the right crate is still sitting in the rack with
    ``customer_id IS NULL`` — they would return nothing. This one returns the
    customer's boxes AND the free rack in a single call, each row tagged with
    the group it belongs to so all three task forms label them identically.

    Rules:
      * ``zurueck`` is history and cannot be handed out without re-opening, so
        it is excluded — unless it is ``include_box_id`` (see below).
      * Boxes belonging to a DIFFERENT customer are physically at someone
        else's site. Picking one by accident is a real mistake, so they are
        hidden from browsing but remain reachable by explicit search.
      * ``include_box_id`` is always returned whatever its status or owner. The
        edit form needs it to render the box a task is already linked to, even
        after that crate was handed over or returned; without it the frontend's
        stale-selection guard would silently drop a real saved link.
    """
    # Same as list_boxes: the rack must exist the first time anyone looks.
    ensure_standard_boxes(db)

    needle = (q or "").strip()
    rows = list(db.scalars(select(WerkstattConstructionBox)).all())

    def keep(box: WerkstattConstructionBox) -> bool:
        if include_box_id is not None and box.id == include_box_id:
            return True
        if box.status == "zurueck":
            return False
        if needle:
            haystack = f"{box.box_number} {box.label}".lower()
            if needle.lower() not in haystack:
                return False
            return True
        # Browsing (no search): the customer's own boxes plus the free rack.
        return box.customer_id is None or box.customer_id == customer_id

    def group_of(box: WerkstattConstructionBox) -> str:
        if box.customer_id is None:
            return "free"
        if customer_id is not None and box.customer_id == customer_id:
            return "customer"
        return "other"

    kept = [row for row in rows if keep(row)]
    group_rank = {"customer": 0, "free": 1, "other": 2}
    kept.sort(
        key=lambda box: (
            group_rank[group_of(box)],
            box.slot is None,  # rack before ad-hoc
            box.slot if box.slot is not None else 0,
            -box.id,  # newest ad-hoc first
        )
    )
    kept = kept[:limit]
    if not kept:
        return []

    # Batched lookups — one query each, rather than box_out's per-row gets.
    box_ids = [box.id for box in kept]
    counts = dict(
        db.execute(
            select(
                WerkstattConstructionBoxItem.box_id,
                func.count(WerkstattConstructionBoxItem.id),
            )
            .where(WerkstattConstructionBoxItem.box_id.in_(box_ids))
            .group_by(WerkstattConstructionBoxItem.box_id)
        ).all()
    )
    customer_ids = {box.customer_id for box in kept if box.customer_id is not None}
    customer_names = (
        dict(
            db.execute(
                select(Customer.id, Customer.name).where(Customer.id.in_(customer_ids))
            ).all()
        )
        if customer_ids
        else {}
    )
    project_ids = {box.project_id for box in kept if box.project_id is not None}
    project_names = (
        dict(
            db.execute(select(Project.id, Project.name).where(Project.id.in_(project_ids))).all()
        )
        if project_ids
        else {}
    )

    return [
        WerkstattBoxSelectableOut(
            id=box.id,
            box_number=box.box_number,
            label=box.label,
            slot=box.slot,
            status=box.status,
            item_count=int(counts.get(box.id, 0)),
            customer_id=box.customer_id,
            customer_name=customer_names.get(box.customer_id),
            project_id=box.project_id,
            project_name=project_names.get(box.project_id),
            group=group_of(box),
        )
        for box in kept
    ]


@router.get("/boxes/{box_id}", response_model=WerkstattBoxOut)
def get_box(
    box_id: int,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return box_out(db, get_box_or_404(db, box_id), with_items=True)


@router.post("/boxes", response_model=WerkstattBoxOut)
def create_box(
    payload: WerkstattBoxCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    label = payload.label.strip()
    if not label:
        raise HTTPException(status_code=400, detail="label is required")
    if payload.customer_id is not None and db.get(Customer, payload.customer_id) is None:
        raise HTTPException(status_code=400, detail=f"Unknown customer id: {payload.customer_id}")

    box = WerkstattConstructionBox(
        box_number=next_box_number(db),
        label=label,
        status="offen",
        customer_id=payload.customer_id,
        project_id=payload.project_id,
        notes=payload.notes,
        created_by=current_user.id,
    )
    db.add(box)
    db.commit()
    db.refresh(box)
    return box_out(db, box, with_items=True)


@router.patch("/boxes/{box_id}", response_model=WerkstattBoxOut)
def update_box(
    box_id: int,
    payload: WerkstattBoxUpdate,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
):
    box = get_box_or_404(db, box_id)
    data = payload.model_dump(exclude_unset=True)
    for field in ("label", "notes", "project_id"):
        if field in data:
            setattr(box, field, data[field])
    box.updated_at = utcnow()
    db.add(box)
    db.commit()
    db.refresh(box)
    return box_out(db, box, with_items=True)


@router.delete("/boxes/{box_id}", status_code=204)
def delete_box(
    box_id: int,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
):
    box = get_box_or_404(db, box_id)
    if box.slot is not None:
        raise HTTPException(
            status_code=400,
            detail="Standard-Kisten sind fest — statt zu löschen bitte leeren.",
        )
    # Both states in which a crate is spoken for. ``gepackt`` was unreachable
    # as a resting state before this wave, so "handed over" used to cover every
    # crate that had a customer on it; it no longer does, and the crates the
    # settlement creates for a customer's leftovers are exactly the new shape.
    # Deleting one cascades its lines away and nulls the settlement's record of
    # where the rest went.
    if box.status in ("zugewiesen", "gepackt"):
        raise HTTPException(
            status_code=400,
            detail=(
                "Die Kiste ist einem Kunden zugewiesen — erst die Zuweisung aufheben "
                "oder die Kiste zurückbuchen."
            ),
        )
    db.delete(box)
    db.commit()


@router.post("/boxes/{box_id}/status", response_model=WerkstattBoxOut)
def set_box_status(
    box_id: int,
    payload: WerkstattBoxStatusPayload,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Drive the box lifecycle. Assignment/return emit stock movements."""
    box = get_box_or_404(db, box_id)
    transition_box(db, box, target_status=payload.status, user_id=current_user.id)
    db.commit()
    db.refresh(box)
    return box_out(db, box, with_items=True)


# The German a re-pack answers with. A sealed crate already holds one
# customer's material; quietly re-labelling it for somebody else would leave
# the rack, the wall screen and the station's handover all naming the wrong
# person over the right goods.
REPACK_OTHER_CUSTOMER_DETAIL = (
    "Die Kiste ist bereits für einen anderen Kunden gepackt — erst die Zuweisung aufheben."
)


def _apply_box_owner(
    db: Session, box: WerkstattConstructionBox, payload: WerkstattBoxAssignPayload
) -> bool:
    """Write the customer (and optional project) a crate is being packed for.

    Shared by ``/pack`` and the one-step ``/assign`` so the two cannot end up
    validating the pair differently — a project that belongs to somebody else
    is the one mistake that puts a crate on the wrong site.

    Returns whether anything actually changed, so the caller can stamp
    ``updated_at``: re-packing a crate for the customer it is already packed
    for is a no-op edge in the FSM, and a project moved on that call would
    otherwise be written with a timestamp that still points at the last change.
    """
    if db.get(Customer, payload.customer_id) is None:
        raise HTTPException(status_code=400, detail=f"Unknown customer id: {payload.customer_id}")
    if (
        box.status == "gepackt"
        and box.customer_id is not None
        and box.customer_id != payload.customer_id
    ):
        raise HTTPException(status_code=400, detail=REPACK_OTHER_CUSTOMER_DETAIL)
    changed = box.customer_id != payload.customer_id
    box.customer_id = payload.customer_id
    if payload.project_id is not None:
        project = db.get(Project, payload.project_id)
        if project is None:
            raise HTTPException(status_code=400, detail=f"Unknown project id: {payload.project_id}")
        if project.customer_id is not None and project.customer_id != payload.customer_id:
            raise HTTPException(
                status_code=400, detail="Das Projekt gehört nicht zum gewählten Kunden."
            )
        changed = changed or box.project_id != payload.project_id
        box.project_id = payload.project_id
    return changed


@router.post("/boxes/{box_id}/pack", response_model=WerkstattBoxOut)
def pack_box_for_customer(
    box_id: int,
    payload: WerkstattBoxAssignPayload,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Seal a crate for a customer — it stays in the workshop, stock untouched.

    The half of "Packen & zuweisen" that used to be impossible to stop at: the
    crate is spoken for and ready, but nothing has left the warehouse, because
    physically nothing has left the building. The checkout happens when
    somebody actually carries it out (``/status`` → ``zugewiesen``).

    Authenticated-only for the same reason packing is: the people who pack
    crates are not administrators.
    """
    box = get_box_or_404(db, box_id)
    if _apply_box_owner(db, box, payload):
        box.updated_at = utcnow()
    pack_box(db, box, user_id=current_user.id)
    db.commit()
    db.refresh(box)
    return box_out(db, box, with_items=True)


@router.post("/boxes/{box_id}/assign", response_model=WerkstattBoxOut)
def assign_box(
    box_id: int,
    payload: WerkstattBoxAssignPayload,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Assign a box to a customer and hand it over in one step.

    A compatibility endpoint: no client in this repository calls it any more
    (the Kisten page posts ``/pack`` and then ``/status``), and it is kept
    alive by one test because it is a published API shape and "it is going out
    right now" is still a real act with the checkout atomic to the assignment.
    New callers should use ``/pack`` followed by ``/status`` → ``zugewiesen``,
    which is the same journey with a state you can stop in.
    """
    box = get_box_or_404(db, box_id)
    if _apply_box_owner(db, box, payload):
        box.updated_at = utcnow()

    # A box straight from packing may still be "offen" — seal it first so the
    # FSM sees a legal edge. ``allow_empty`` because this call makes no claim
    # about a crate standing ready: it is going out now, and booking nothing
    # out of the warehouse is harmless.
    if box.status == "offen":
        transition_box(
            db, box, target_status="gepackt", user_id=current_user.id, allow_empty=True
        )
    transition_box(db, box, target_status="zugewiesen", user_id=current_user.id)
    db.commit()
    db.refresh(box)
    return box_out(db, box, with_items=True)


# ── Items ─────────────────────────────────────────────────────────────────────


@router.get("/boxes/{box_id}/items", response_model=list[WerkstattBoxItemOut])
def list_box_items(
    box_id: int,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    get_box_or_404(db, box_id)
    rows = db.scalars(
        select(WerkstattConstructionBoxItem)
        .where(WerkstattConstructionBoxItem.box_id == box_id)
        .order_by(WerkstattConstructionBoxItem.id.asc())
    ).all()
    return [item_out(row) for row in rows]


@router.post("/boxes/{box_id}/items", response_model=WerkstattBoxItemOut)
def add_box_item(
    box_id: int,
    payload: WerkstattBoxItemCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Add (or top up) a line in the box — see ``add_item_to_box``, which the
    station-scoped router runs too."""
    box = get_box_or_404(db, box_id)
    return item_out(add_item_to_box(db, box, payload, added_by=current_user.id))


@router.patch("/boxes/{box_id}/items/{item_id}", response_model=WerkstattBoxItemOut)
def update_box_item(
    box_id: int,
    item_id: int,
    payload: WerkstattBoxItemUpdate,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    box = get_box_or_404(db, box_id)
    ensure_box_unlocked(box)
    row = db.get(WerkstattConstructionBoxItem, item_id)
    if row is None or row.box_id != box_id:
        raise HTTPException(status_code=404, detail="Box item not found")

    data = payload.model_dump(exclude_unset=True)
    if "quantity" in data:
        if int(data["quantity"]) <= 0:
            raise HTTPException(status_code=400, detail="quantity must be positive")
        row.quantity = int(data["quantity"])
    for field in ("item_name", "unit", "notes"):
        if field in data:
            setattr(row, field, data[field])
    row.updated_at = utcnow()
    db.add(row)
    db.commit()
    db.refresh(row)
    return item_out(row)


@router.delete("/boxes/{box_id}/items/{item_id}", status_code=204)
def delete_box_item(
    box_id: int,
    item_id: int,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Remove a whole line — the ``quantity=None`` case of the shared
    ``remove_item_from_box``, which the station's box screen calls with a
    count because it takes items out one scan at a time."""
    box = get_box_or_404(db, box_id)
    remove_item_from_box(db, box, item_id, quantity=None)


@router.delete("/boxes/{box_id}/items", response_model=WerkstattBoxOut)
def clear_box_items(
    box_id: int,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Empty a box in one call.

    This exists mainly for the standard rack boxes, which are permanent and so
    can never be deleted — emptying is their equivalent of "throw it away", and
    doing it line-by-line from a phone would be one request per position.
    """
    box = get_box_or_404(db, box_id)
    ensure_box_unlocked(box)
    rows = db.scalars(
        select(WerkstattConstructionBoxItem).where(WerkstattConstructionBoxItem.box_id == box_id)
    ).all()
    ensure_packed_box_keeps_content(db, box, lines_removed=len(rows))
    for row in rows:
        db.delete(row)
    db.commit()
    db.refresh(box)
    return box_out(db, box, with_items=True)


# ── Label ─────────────────────────────────────────────────────────────────────


@router.post("/boxes/{box_id}/print-label", response_model=WerkstattBoxLabelPrintOut)
def print_box_label(
    box_id: int,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WerkstattBoxLabelPrintOut:
    """Print the sticker that makes a crate scannable.

    Authenticated rather than manage-only, and allowed on a handed-over box —
    the same reasoning as the article and machine labels: the person standing
    next to the unlabelled crate is rarely the person with manage rights, and
    the box most likely to have lost its sticker is the one out on a site. A
    label that is awkward to print is a crate that stays unscannable.

    Nothing is written. Unlike an article, a box already has an identity —
    ``box_number`` — so the printed code is derived rather than minted, and a
    failed print leaves nothing behind to clean up.
    """
    box = get_box_or_404(db, box_id)
    code = box_code(box)
    try:
        # Its own layout since 2026-09-24: the machine label's matrix anchor
        # and headline are sized for "M-0062", and a crate code is three
        # times as long (services/werkstatt_box_labels.py).
        printer = werkstatt_box_labels.print_box_label(
            db,
            werkstatt_box_labels.BoxLabelContent(code=code, box_number=box.box_number, label=box.label),
        )
    except werkstatt_labels.LabelFormatUnsupported as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except werkstatt_labels.LabelPrinterNotConfigured:
        raise HTTPException(status_code=503, detail="Kein Etikettendrucker konfiguriert")
    except werkstatt_labels.LabelPrinterUnreachable as exc:
        raise HTTPException(status_code=502, detail=f"Etikettendrucker nicht erreichbar ({exc})")

    return WerkstattBoxLabelPrintOut(
        box_id=box.id,
        box_number=box.box_number,
        code=code,
        printer=printer,
    )


# ── Customer-scoped read (customer page) ──────────────────────────────────────


@customer_boxes_router.get(
    "/customers/{customer_id}/boxes", response_model=list[WerkstattBoxOut]
)
def list_customer_boxes(
    customer_id: int,
    include_returned: bool = False,
    limit: int = Query(default=100, ge=1, le=500),
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Boxes belonging to a customer.

    Defaults to boxes currently with the customer; ``include_returned=true``
    adds the history, mirroring the customer-scoped reports endpoint's
    boolean-flag convention.
    """
    if db.get(Customer, customer_id) is None:
        raise HTTPException(status_code=404, detail="Customer not found")

    stmt = select(WerkstattConstructionBox).where(
        WerkstattConstructionBox.customer_id == customer_id
    )
    if not include_returned:
        stmt = stmt.where(WerkstattConstructionBox.status != "zurueck")
    stmt = stmt.order_by(
        WerkstattConstructionBox.assigned_at.desc().nullslast(),
        WerkstattConstructionBox.id.desc(),
    ).limit(limit)
    return [box_out(db, row, with_items=False) for row in db.scalars(stmt).all()]


# ── Unified item search (article DB + Datanorm catalog) ───────────────────────


@router.get("/item-search", response_model=list[WerkstattItemSearchHit])
def search_items(
    q: str = Query(..., min_length=1, description="Free text, article no or EAN"),
    limit: int = Query(default=20, ge=1, le=50),
    include_catalog: bool = True,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """One search across stocked articles AND the Datanorm catalog.

    The ranking — exact identifiers first, stocked before catalog — is
    load-bearing for the scanner and lives in
    ``services/werkstatt_item_search.py`` with the reasoning behind it.
    """
    return search_box_items(db, q=q, limit=limit, include_catalog=include_catalog)
