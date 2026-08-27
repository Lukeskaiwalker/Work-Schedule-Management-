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
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.services.search_matching import (
    identifier_key,
    similarity_score,
    supports_trigram,
    token_matches_any,
    tokenize,
)

from app.core.db import get_db
from app.core.deps import get_current_user, require_permission
from app.core.time import utcnow
from app.models.entities import (
    Customer,
    Project,
    User,
    WerkstattArticle,
    WerkstattArticleSupplier,
    WerkstattConstructionBox,
    WerkstattConstructionBoxItem,
    WerkstattSupplier,
)
from app.schemas.werkstatt_boxes import (
    WerkstattBoxAssignPayload,
    WerkstattBoxCreate,
    WerkstattBoxItemCreate,
    WerkstattBoxItemOut,
    WerkstattBoxItemUpdate,
    WerkstattBoxOut,
    WerkstattBoxSelectableOut,
    WerkstattBoxStatusPayload,
    WerkstattBoxUpdate,
    WerkstattItemSearchHit,
)
from app.services.werkstatt_boxes import (
    ensure_standard_boxes,
    next_box_number,
    transition_box,
)

router = APIRouter(prefix="/werkstatt", tags=["werkstatt-boxes"])
customer_boxes_router = APIRouter(prefix="", tags=["werkstatt-boxes"])


# ── Serialisation ─────────────────────────────────────────────────────────────


def _item_out(row: WerkstattConstructionBoxItem) -> WerkstattBoxItemOut:
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


def _box_out(db: Session, box: WerkstattConstructionBox, *, with_items: bool) -> WerkstattBoxOut:
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
        items = [_item_out(row) for row in rows]
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


def _get_box_or_404(db: Session, box_id: int) -> WerkstattConstructionBox:
    box = db.get(WerkstattConstructionBox, box_id)
    if box is None:
        raise HTTPException(status_code=404, detail="Construction box not found")
    return box


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
    return [_box_out(db, row, with_items=False) for row in db.scalars(stmt).all()]


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

    # Batched lookups — one query each, rather than _box_out's per-row gets.
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
    return _box_out(db, _get_box_or_404(db, box_id), with_items=True)


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
    return _box_out(db, box, with_items=True)


@router.patch("/boxes/{box_id}", response_model=WerkstattBoxOut)
def update_box(
    box_id: int,
    payload: WerkstattBoxUpdate,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
):
    box = _get_box_or_404(db, box_id)
    data = payload.model_dump(exclude_unset=True)
    for field in ("label", "notes", "project_id"):
        if field in data:
            setattr(box, field, data[field])
    box.updated_at = utcnow()
    db.add(box)
    db.commit()
    db.refresh(box)
    return _box_out(db, box, with_items=True)


@router.delete("/boxes/{box_id}", status_code=204)
def delete_box(
    box_id: int,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
):
    box = _get_box_or_404(db, box_id)
    if box.slot is not None:
        raise HTTPException(
            status_code=400,
            detail="Standard boxes are permanent — empty it instead of deleting it",
        )
    if box.status == "zugewiesen":
        raise HTTPException(
            status_code=400, detail="Cannot delete a box that is currently handed over"
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
    box = _get_box_or_404(db, box_id)
    transition_box(db, box, target_status=payload.status, user_id=current_user.id)
    db.commit()
    db.refresh(box)
    return _box_out(db, box, with_items=True)


@router.post("/boxes/{box_id}/assign", response_model=WerkstattBoxOut)
def assign_box(
    box_id: int,
    payload: WerkstattBoxAssignPayload,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Assign a packed box to a customer and hand it over in one step.

    Setting the customer and moving to ``zugewiesen`` together is what the UI
    actually does, and it keeps the stock checkout atomic with the assignment.
    """
    box = _get_box_or_404(db, box_id)
    if db.get(Customer, payload.customer_id) is None:
        raise HTTPException(status_code=400, detail=f"Unknown customer id: {payload.customer_id}")
    box.customer_id = payload.customer_id
    if payload.project_id is not None:
        project = db.get(Project, payload.project_id)
        if project is None:
            raise HTTPException(status_code=400, detail=f"Unknown project id: {payload.project_id}")
        if project.customer_id is not None and project.customer_id != payload.customer_id:
            raise HTTPException(
                status_code=400, detail="Project does not belong to the selected customer"
            )
        box.project_id = payload.project_id

    # A box straight from packing may still be "offen" — seal it first so the
    # FSM sees a legal edge.
    if box.status == "offen":
        transition_box(db, box, target_status="gepackt", user_id=current_user.id)
    transition_box(db, box, target_status="zugewiesen", user_id=current_user.id)
    db.commit()
    db.refresh(box)
    return _box_out(db, box, with_items=True)


# ── Items ─────────────────────────────────────────────────────────────────────


@router.get("/boxes/{box_id}/items", response_model=list[WerkstattBoxItemOut])
def list_box_items(
    box_id: int,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_box_or_404(db, box_id)
    rows = db.scalars(
        select(WerkstattConstructionBoxItem)
        .where(WerkstattConstructionBoxItem.box_id == box_id)
        .order_by(WerkstattConstructionBoxItem.id.asc())
    ).all()
    return [_item_out(row) for row in rows]


@router.post("/boxes/{box_id}/items", response_model=WerkstattBoxItemOut)
def add_box_item(
    box_id: int,
    payload: WerkstattBoxItemCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Add (or top up) a line in the box.

    Identity is snapshotted at pack time. When an article is referenced its
    master data wins; otherwise we take what the caller scanned/typed. Adding
    the same article twice increments the existing line rather than creating a
    duplicate — on a phone that is what a second scan means.
    """
    box = _get_box_or_404(db, box_id)
    if box.status == "zugewiesen":
        raise HTTPException(
            status_code=400, detail="Cannot change the contents of a box that is handed over"
        )

    quantity = int(payload.quantity or 1)
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
                WerkstattConstructionBoxItem.box_id == box_id,
                WerkstattConstructionBoxItem.article_id == payload.article_id,
            )
        ).first()
        if existing is not None:
            existing.quantity = int(existing.quantity or 0) + quantity
            existing.updated_at = utcnow()
            db.add(existing)
            db.commit()
            db.refresh(existing)
            return _item_out(existing)

    row = WerkstattConstructionBoxItem(
        box_id=box_id,
        source=source,
        article_id=payload.article_id,
        catalog_external_key=payload.catalog_external_key,
        item_name=item_name,
        article_no=article_no,
        ean=ean,
        unit=unit,
        quantity=quantity,
        notes=payload.notes,
        added_by=current_user.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _item_out(row)


@router.patch("/boxes/{box_id}/items/{item_id}", response_model=WerkstattBoxItemOut)
def update_box_item(
    box_id: int,
    item_id: int,
    payload: WerkstattBoxItemUpdate,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    box = _get_box_or_404(db, box_id)
    if box.status == "zugewiesen":
        raise HTTPException(
            status_code=400, detail="Cannot change the contents of a box that is handed over"
        )
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
    return _item_out(row)


@router.delete("/boxes/{box_id}/items/{item_id}", status_code=204)
def delete_box_item(
    box_id: int,
    item_id: int,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    box = _get_box_or_404(db, box_id)
    if box.status == "zugewiesen":
        raise HTTPException(
            status_code=400, detail="Cannot change the contents of a box that is handed over"
        )
    row = db.get(WerkstattConstructionBoxItem, item_id)
    if row is None or row.box_id != box_id:
        raise HTTPException(status_code=404, detail="Box item not found")
    db.delete(row)
    db.commit()


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
    box = _get_box_or_404(db, box_id)
    if box.status == "zugewiesen":
        raise HTTPException(
            status_code=400, detail="Cannot change the contents of a box that is handed over"
        )
    rows = db.scalars(
        select(WerkstattConstructionBoxItem).where(WerkstattConstructionBoxItem.box_id == box_id)
    ).all()
    for row in rows:
        db.delete(row)
    db.commit()
    db.refresh(box)
    return _box_out(db, box, with_items=True)


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
    return [_box_out(db, row, with_items=False) for row in db.scalars(stmt).all()]


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

    Identifier coverage matches the documented scan cascade
    (``services/werkstatt_scan.py`` / WERKSTATT_CONTRACT.md §3.1): our own
    SP-number, the EAN, and — importantly for scanning — the SUPPLIER's own
    article number from ``werkstatt_article_suppliers``. A wholesaler like
    Unielektro labels goods with their number, not ours, so without that join a
    scan of their barcode would find nothing even though we stock the article.

    Results are ranked EXACT-IDENTIFIER FIRST. That ordering is load-bearing:
    the scanner auto-adds only an unambiguous exact hit, and a plain
    alphabetical order could otherwise put an unrelated substring match on top
    and drop the wrong article into a crate.

    Stocked articles rank above catalog-only rows within the same match quality
    — those are things actually in the van. Catalog matching deliberately goes
    through the Werkstatt-scoped query rather than ``search_material_catalog``,
    because that helper triggers a filesystem re-import which DELETES and
    rebuilds ``material_catalog_items`` — a read path must never wipe Datanorm
    imports.
    """
    term = q.strip()
    folded = term.casefold()
    folded_key = identifier_key(term)
    tokens = tokenize(term)
    trigram = supports_trigram(db)
    hits: list[WerkstattItemSearchHit] = []

    # ``min_length=1`` still admits a query of pure whitespace, which tokenises
    # to nothing. Matching everything in that case would drop an arbitrary
    # article at position 0 — and the scanner reads position 0.
    if not tokens:
        return hits

    # Ranking happens in Python below, across both sources. Truncating each
    # query to `limit` first would let the best row fall out of the candidate
    # set before it was ever ranked — so fetch wider here and cut to `limit`
    # only after sorting.
    candidate_limit = min(max(limit * 5, limit), 200)

    def exact(value: str | None) -> bool:
        """Identifier equality, tolerant of punctuation drift.

        A wholesaler prints ``1234-567`` where our Datanorm row stores
        ``1234567``; both name the same article, so a scan of either must still
        count as an exact hit. Falls back to plain casefolded equality when the
        term has no alphanumerics to normalise.
        """
        if value is None:
            return False
        if value.casefold() == folded:
            return True
        return bool(folded_key) and identifier_key(value) == folded_key

    # Articles reachable through a supplier's own article number.
    supplier_stmt = (
        select(
            WerkstattArticleSupplier.article_id,
            WerkstattArticleSupplier.supplier_article_no,
            WerkstattSupplier.name,
        )
        .join(WerkstattSupplier, WerkstattSupplier.id == WerkstattArticleSupplier.supplier_id)
    )
    for token in tokens:
        supplier_stmt = supplier_stmt.where(
            token_matches_any([WerkstattArticleSupplier.supplier_article_no], token)
        )
    supplier_links = db.execute(supplier_stmt.limit(candidate_limit)).all()
    supplier_by_article: dict[int, tuple[str | None, str | None]] = {
        row[0]: (row[2], row[1]) for row in supplier_links
    }

    # Every token must appear in at least one of the article's own fields.
    # Previously the whole query string was one contiguous ILIKE, so
    # "NYM 3x1,5" could not match a stored "NYM-J 3x1,5".
    article_columns = [
        WerkstattArticle.item_name,
        WerkstattArticle.article_number,
        WerkstattArticle.ean,
        # The barcode we printed ourselves. Without it, scanning an in-house
        # label into a Kiste found nothing for stock that was plainly on the
        # shelf — the code is on the sticker and in no searched column.
        WerkstattArticle.internal_code,
    ]
    token_clauses = [token_matches_any(article_columns, token) for token in tokens]
    article_stmt = select(WerkstattArticle).where(
        WerkstattArticle.is_archived.is_(False),
        or_(
            and_(*token_clauses),
            WerkstattArticle.id.in_(list(supplier_by_article.keys()) or [-1]),
        ),
    )
    articles = db.scalars(
        article_stmt.order_by(
            similarity_score(WerkstattArticle.item_name, term, enabled=trigram).desc(),
            WerkstattArticle.item_name.asc(),
        ).limit(candidate_limit)
    ).all()
    for article in articles:
        supplier_name, supplier_article_no = supplier_by_article.get(article.id, (None, None))
        if exact(article.internal_code):
            # Ranked first: a code in this column was issued by this app, so a
            # hit is ours by construction and cannot be a coincidental
            # collision with a manufacturer's GTIN.
            match = "exact_internal_code"
        elif exact(article.ean):
            match = "exact_ean"
        elif exact(article.article_number):
            match = "exact_article_no"
        elif exact(supplier_article_no):
            match = "exact_supplier_no"
        else:
            match = "partial"
        hits.append(
            WerkstattItemSearchHit(
                source="article",
                article_id=article.id,
                item_name=article.item_name,
                article_no=article.article_number,
                ean=article.ean,
                unit=article.unit,
                stock_available=int(article.stock_available or 0),
                match=match,
                supplier_name=supplier_name,
                supplier_article_no=supplier_article_no,
            )
        )

    if include_catalog and len(hits) < limit:
        from app.models.entities import MaterialCatalogItem

        seen_eans = {h.ean for h in hits if h.ean}
        catalog_columns = [
            MaterialCatalogItem.item_name,
            MaterialCatalogItem.article_no,
            MaterialCatalogItem.ean,
        ]
        catalog_stmt = select(MaterialCatalogItem)
        for token in tokens:
            catalog_stmt = catalog_stmt.where(token_matches_any(catalog_columns, token))
        catalog_rows = db.scalars(
            catalog_stmt.order_by(
                similarity_score(MaterialCatalogItem.item_name, term, enabled=trigram).desc(),
                MaterialCatalogItem.item_name.asc(),
            ).limit(candidate_limit)
        ).all()
        for row in catalog_rows:
            # A catalog row already stocked as an article would be a confusing
            # duplicate; the article hit above already covers it.
            if row.ean and row.ean in seen_eans:
                continue
            if exact(row.ean):
                match = "exact_ean"
            elif exact(row.article_no):
                match = "exact_article_no"
            else:
                match = "partial"
            hits.append(
                WerkstattItemSearchHit(
                    source="catalog",
                    catalog_external_key=row.external_key,
                    item_name=row.item_name,
                    article_no=row.article_no,
                    ean=row.ean,
                    unit=row.unit,
                    stock_available=None,
                    match=match,
                )
            )

    # Exact identifier hits first, stocked before catalog, then by name. The
    # scanner reads position 0, so this ordering is what stops a substring
    # match on an unrelated article from being dropped into a crate.
    match_rank = {
        # Our own printed code outranks even an EAN: it exists only because we
        # issued it, so it identifies exactly one row by construction.
        "exact_internal_code": 0,
        "exact_ean": 1,
        "exact_supplier_no": 2,
        "exact_article_no": 3,
        "partial": 4,
    }
    hits.sort(
        key=lambda hit: (
            match_rank.get(hit.match, 4),
            0 if hit.source == "article" else 1,
            hit.item_name.casefold(),
        )
    )
    return hits[:limit]
