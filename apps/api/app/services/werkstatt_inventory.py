"""Inventur — counting logic.

The design constraint that shapes everything here is the operator's: counting
is repetitive warehouse work, so **a scan must never stop the flow**. Every
resolvable code is absorbed in one request and answers "counted, you now have
N" — including codes that do not correspond to an article yet, which are
created from the Datanorm catalog on the spot rather than bounced back as a
question. The only code that can interrupt is one nothing in the system has
ever seen, and even then the operator is asked for a name once and never again.

Counting writes to ``werkstatt_inventory_counts`` only. Real stock does not
move until ``finalize_session``.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import (
    MaterialCatalogItem,
    User,
    WerkstattArticle,
    WerkstattInventoryCount,
    WerkstattInventorySession,
)
from app.services.werkstatt_article_numbers import next_article_number
from app.services.werkstatt_movements import apply_movement
from app.services.werkstatt_scan import resolve_scan


@dataclass(frozen=True)
class ScanOutcome:
    """What a single scan did. ``status`` drives the UI's one-line feedback."""

    # counted        — resolved and incremented, nothing to ask
    # created        — a new article was minted from the catalog, then counted
    # needs_name     — nothing in the system knows this code
    # session_closed — the session is no longer open
    status: str
    article: WerkstattArticle | None = None
    counted_qty: int = 0
    code: str = ""
    created_from_catalog: bool = False


def _open_session(db: Session, session_id: int) -> WerkstattInventorySession | None:
    session = db.get(WerkstattInventorySession, session_id)
    if session is None or session.status != "open":
        return None
    return session


def _bump(db: Session, session_id: int, article: WerkstattArticle, by: int = 1) -> int:
    """Increment (or create) this article's count row. Returns the new total."""

    row = db.scalar(
        select(WerkstattInventoryCount).where(
            WerkstattInventoryCount.session_id == session_id,
            WerkstattInventoryCount.article_id == article.id,
        )
    )
    now = utcnow()
    if row is None:
        row = WerkstattInventoryCount(
            session_id=session_id,
            article_id=article.id,
            counted_qty=by,
            scan_count=1,
            first_counted_at=now,
            last_counted_at=now,
        )
        db.add(row)
    else:
        row.counted_qty += by
        row.scan_count += 1
        row.last_counted_at = now
        db.add(row)
    db.flush()
    return int(row.counted_qty)


def _article_from_catalog(db: Session, item: MaterialCatalogItem, user: User) -> WerkstattArticle:
    """Mint an article from a Datanorm row so a scan never has to stop.

    Opening stock is deliberately zero: the session's own count is the truth
    we are establishing, and seeding a quantity here would be double-counted
    by finalize.
    """

    article = WerkstattArticle(
        article_number=next_article_number(db),
        ean=(item.ean or None),
        # MaterialCatalogItem.item_name, NOT .name — the attribute does not
        # exist and every catalog-matched import died on it. The tests missed
        # this because they never built a real catalog row.
        item_name=item.item_name or (item.ean or "Unbenannter Artikel"),
        manufacturer=item.manufacturer,
        unit=item.unit,
        image_url=item.image_url,
        image_source=("catalog" if item.image_url else None),
        source_catalog_item_id=item.id,
        stock_total=0,
        stock_available=0,
        stock_out=0,
        stock_repair=0,
        stock_min=0,
        currency="EUR",
        created_by=user.id,
    )
    db.add(article)
    db.flush()
    return article


def scan_into_session(db: Session, *, session_id: int, code: str, user: User) -> ScanOutcome:
    """Absorb one scan. One request, one answer, no round trips."""

    session = _open_session(db, session_id)
    if session is None:
        return ScanOutcome(status="session_closed", code=code)

    result = resolve_scan(db, code)
    kind = getattr(result, "kind", "not_found")

    if kind == "werkstatt_article":
        article = db.get(WerkstattArticle, result.article.id)
        if article is not None:
            return ScanOutcome(
                status="counted", article=article, counted_qty=_bump(db, session_id, article), code=code
            )

    if kind == "catalog_match" and result.catalog_items:
        # Several suppliers can carry the same EAN. They are the same physical
        # product, so any row identifies it; take the first and let the
        # existing catalog-duplicate linking sort suppliers out later.
        item = db.get(MaterialCatalogItem, result.catalog_items[0].id)
        if item is not None:
            article = _article_from_catalog(db, item, user)
            return ScanOutcome(
                status="created",
                article=article,
                counted_qty=_bump(db, session_id, article),
                code=code,
                created_from_catalog=True,
            )

    # Machines resolve to a unit, not a stock article — counting them here
    # would be meaningless, so they are treated as unknown for this purpose.
    return ScanOutcome(status="needs_name", code=code)


@dataclass(frozen=True)
class ImportRow:
    code: str
    item_name: str
    counted_qty: int
    scan_count: int = 0


def import_counts(
    db: Session,
    *,
    session: WerkstattInventorySession,
    rows: list[ImportRow],
    user: User,
) -> dict:
    """Fold an offline count (from the local label agent) into a session.

    Quantities are SET, not added, so re-importing the same export is safe —
    a half-finished upload that gets retried must not double the stock-take.

    Each code goes through the same cascade a live scan does, so an offline
    session lands on exactly the articles a live one would have hit:
    known article -> Datanorm catalog row -> otherwise a new article named by
    whoever did the counting.
    """

    matched = from_catalog = created = 0
    unresolved: list[str] = []
    skipped: list[str] = []

    for row in rows:
        code = (row.code or "").strip()
        if not code or row.counted_qty <= 0:
            # A zero row means "scanned, then undone" — the agent has no way to
            # say "I counted zero because the shelf is empty", which is a
            # different and meaningful claim. Reported rather than dropped in
            # silence, so a real empty shelf is not mistaken for a mis-scan.
            if code:
                skipped.append(code)
            continue

        article: WerkstattArticle | None = None
        result = resolve_scan(db, code)
        kind = getattr(result, "kind", "not_found")

        if kind == "werkstatt_article":
            article = db.get(WerkstattArticle, result.article.id)
            if article is not None:
                matched += 1
        elif kind == "catalog_match" and result.catalog_items:
            item = db.get(MaterialCatalogItem, result.catalog_items[0].id)
            if item is not None:
                article = _article_from_catalog(db, item, user)
                from_catalog += 1

        if article is None:
            name = (row.item_name or "").strip() or code
            article = WerkstattArticle(
                article_number=next_article_number(db),
                # Only adopt the code as an EAN when it plausibly IS one. The
                # agent mints SMPL-xxxxxx codes for items that had no barcode,
                # and writing those into the EAN column would make them look
                # like manufacturer barcodes to every later lookup.
                ean=code if code.isdigit() and 8 <= len(code) <= 14 else None,
                item_name=name[:500],
                stock_total=0,
                stock_available=0,
                stock_out=0,
                stock_repair=0,
                stock_min=0,
                currency="EUR",
                created_by=user.id,
            )
            db.add(article)
            db.flush()
            created += 1
            if not code.isdigit():
                unresolved.append(code)

        existing = db.scalar(
            select(WerkstattInventoryCount).where(
                WerkstattInventoryCount.session_id == session.id,
                WerkstattInventoryCount.article_id == article.id,
            )
        )
        now = utcnow()
        if existing is None:
            db.add(
                WerkstattInventoryCount(
                    session_id=session.id,
                    article_id=article.id,
                    counted_qty=int(row.counted_qty),
                    scan_count=int(row.scan_count or 0),
                    first_counted_at=now,
                    last_counted_at=now,
                )
            )
        else:
            existing.counted_qty = int(row.counted_qty)
            existing.scan_count = int(row.scan_count or 0)
            existing.last_counted_at = now
            db.add(existing)

    db.commit()
    return {
        "rows": len(rows),
        "matched_existing": matched,
        "created_from_catalog": from_catalog,
        "created_new": created,
        "codes_without_barcode": unresolved[:50],
        "skipped_zero_qty": skipped[:50],
    }


def finalize_session(db: Session, *, session: WerkstattInventorySession, user: User) -> dict:
    """Turn counts into ledger movements, in one transaction.

    Each counted article gets ONE movement for the difference between what was
    counted and what the snapshot says is on the shelf. ``stock_available`` is
    the comparison basis, not ``stock_total``: a shelf count cannot see items
    that are checked out or away for repair, so reconciling against the total
    would book their absence as shrinkage.
    """

    rows = list(
        db.scalars(
            select(WerkstattInventoryCount).where(
                WerkstattInventoryCount.session_id == session.id
            )
        ).all()
    )

    adjusted = unchanged = 0
    total_plus = total_minus = 0
    for row in rows:
        article = db.get(WerkstattArticle, row.article_id)
        if article is None:
            continue
        expected = int(article.stock_available or 0)
        row.expected_qty = expected
        db.add(row)

        delta = int(row.counted_qty) - expected
        if delta == 0:
            unchanged += 1
            continue
        apply_movement(
            db,
            article=article,
            movement_type="inventory_plus" if delta > 0 else "inventory_minus",
            quantity=abs(delta),
            user_id=user.id,
            notes=f"Inventur: {session.name}",
        )
        adjusted += 1
        if delta > 0:
            total_plus += delta
        else:
            total_minus += -delta

    session.status = "finalized"
    session.finalized_by = user.id
    session.finalized_at = utcnow()
    db.add(session)
    db.commit()

    return {
        "counted_articles": len(rows),
        "adjusted": adjusted,
        "unchanged": unchanged,
        "units_added": total_plus,
        "units_removed": total_minus,
    }
