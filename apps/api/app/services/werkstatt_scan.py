"""Werkstatt scan-resolution cascade.

Owned by Mobile BE (used only by ``workflow_werkstatt_mobile``).

Given a raw scanned ``code`` (a machine label, EAN, SP-Nummer, supplier article
number, or Datanorm catalog identifier), resolve it via the cascade defined in
``WERKSTATT_CONTRACT.md §3.1``:

    1. werkstatt_article_units.unit_number == code     → machine (machine_number)
    2. werkstatt_articles.article_number == code       → werkstatt_article (sp)
   2b. werkstatt_articles.internal_code == code        → werkstatt_article (internal_code)
    3. werkstatt_articles.ean == code                  → werkstatt_article (ean)
    4. werkstatt_article_suppliers.supplier_article_no == code
                                                       → werkstatt_article (supplier_no)
    5. werkstatt_article_units.serial_number == code   → machine (serial_number)
    6. material_catalog_items.ean == code              → catalog_match (catalog_ean)
                                                         (may return multiple)
    7. material_catalog_items.article_no == code       → catalog_match (catalog_article_no)
                                                         (may return multiple)
    8. supplier_article_no in another case, then without the separators
       `` -./`` — only when exactly ONE article answers
                                                       → werkstatt_article (supplier_no)
    9. Otherwise                                       → not_found

The two machine steps sit at opposite ends on purpose.

Step 1 is our own label, stuck on exactly one physical object — if it resolves
there is nothing more specific to find, so it wins outright. It is gated on the
``M-<digits>`` shape, which cannot collide with an EAN or an SP-number, so the
overwhelmingly common article scan costs no extra query.

Step 5 is the MANUFACTURER's nameplate serial, which is an arbitrary string we
did not issue and cannot pattern-match. Putting it after the article steps
means every article scan resolves exactly as it did before machines existed —
a serial can only claim a code nothing else wanted.

Step 8 is the only comparison that is not exact, and it is last for the same
reason step 5 is late: a loose spelling may only claim a code that no exact
step wanted. Inside step 4 it would let ``12345678`` on a box of cable ties
beat the nameplate serial ``1234-5678`` of a drill — and at the rack a machine
is lookup-only while an article hit books stock out.

Ordering is load-bearing — the FE relies on it, and it's documented in the
contract. Do not rearrange without bumping the contract.
"""

from __future__ import annotations

from sqlalchemy import ColumnElement, func, select
from sqlalchemy.orm import Session

from app.models.entities import (
    MaterialCatalogItem,
    WerkstattArticle,
    WerkstattArticleSupplier,
    WerkstattArticleUnit,
    WerkstattCategory,
    WerkstattLocation,
    WerkstattSupplier,
)
from app.schemas.werkstatt import (
    MaterialCatalogItemLiteOut,
    ScanResolveCatalog,
    ScanResolveMachine,
    ScanResolveNotFound,
    ScanResolveResult,
    ScanResolveWerkstatt,
    WerkstattArticleOut,
    WerkstattStockStatus,
)
from app.services.werkstatt_article_search import identifier_column_key, identifier_search_key
from app.services.werkstatt_machine_view import machine_out_with_components
from app.services.werkstatt_unit_numbers import UNIT_PATTERN, normalize_scanned_code


# ──────────────────────────────────────────────────────────────────────────
# Public entry point
# ──────────────────────────────────────────────────────────────────────────


def _follow_merge(db: Session, article: WerkstattArticle) -> WerkstattArticle:
    """The article this row was merged into, or the row itself.

    A merge archives the duplicate and moves its ledger onto the survivor, but
    the duplicate's SP-number is already printed on a label stuck to a shelf.
    Without this hop that label resolves to an archived row holding no stock —
    the scanner would say "0 verfügbar" about a full bin.

    Exactly ONE hop, because ``merge_articles`` refuses to merge into an
    article that is itself merged. That refusal is what makes a loop
    impossible here, so this needs no visited-set and no depth limit; if the
    invariant were ever broken the worst case is that one label points at an
    archived row again, which is where we started.

    ``matched_by`` is deliberately NOT changed: the question "how did this code
    resolve" is about the code, and it resolved by SP-number whether or not the
    row it named has since been folded into another.
    """
    if article.merged_into_id is None or article.merged_into_id == article.id:
        return article
    survivor = db.get(WerkstattArticle, article.merged_into_id)
    return survivor if survivor is not None else article


def resolve_scan(db: Session, code: str) -> ScanResolveResult:
    """Run the scan cascade and return a ``ScanResolveResult``.

    An empty / whitespace-only code resolves to ``not_found`` (with the
    original string preserved). All DB lookups use the normalised (stripped)
    value but the returned ``code`` for ``not_found`` is the raw input so
    the FE can echo exactly what was scanned.
    """

    raw = code or ""
    normalised = raw.strip()
    if not normalised:
        return ScanResolveNotFound(code=raw)

    # 1. Our own machine label. Gated on the M-<digits> shape so a plain EAN
    #    scan does not pay for this lookup, and canonicalised first because a
    #    hardware scanner, a hand-typed "m-1" and the printed "M-0001" all mean
    #    the same drill to the person holding it.
    if UNIT_PATTERN.match(normalize_scanned_code(normalised)):
        unit = db.scalars(
            select(WerkstattArticleUnit).where(
                WerkstattArticleUnit.unit_number == normalize_scanned_code(normalised)
            )
        ).first()
        if unit is not None:
            return ScanResolveMachine(
                machine=machine_out_with_components(db, unit),
                matched_by="machine_number",
            )

    # 2. werkstatt_articles.article_number == code
    article = db.scalars(
        select(WerkstattArticle).where(WerkstattArticle.article_number == normalised)
    ).first()
    if article is not None:
        return ScanResolveWerkstatt(
            article=_article_out(db, _follow_merge(db, article)),
            matched_by="sp",
        )

    # 2b. werkstatt_articles.internal_code == code — the barcode we printed
    #     ourselves for stock that arrived without a manufacturer one. Ahead of
    #     `ean` because it is unambiguously ours: a code in this column was
    #     issued by this app, so a hit here cannot be a coincidental collision
    #     with somebody's GTIN.
    article = db.scalars(
        select(WerkstattArticle).where(WerkstattArticle.internal_code == normalised)
    ).first()
    if article is not None:
        return ScanResolveWerkstatt(
            article=_article_out(db, _follow_merge(db, article)),
            matched_by="internal_code",
        )

    # 3. werkstatt_articles.ean == code
    article = db.scalars(
        select(WerkstattArticle).where(WerkstattArticle.ean == normalised)
    ).first()
    if article is not None:
        return ScanResolveWerkstatt(
            article=_article_out(db, _follow_merge(db, article)),
            matched_by="ean",
        )

    # 4. werkstatt_article_suppliers.supplier_article_no == code, exactly.
    #    The case- and punctuation-tolerant spellings wait for step 8.
    supplier_hit = _supplier_article_hit(db, _exact_supplier_article_id(db, normalised))
    if supplier_hit is not None:
        return supplier_hit

    # 5. The manufacturer's nameplate serial. Only reached once every article
    #    lookup has passed, so recording a serial can never change how an
    #    existing article barcode resolves. Archived units are excluded: a
    #    retired machine's serial should not hijack a live scan.
    unit = db.scalars(
        select(WerkstattArticleUnit)
        .where(
            WerkstattArticleUnit.serial_number == normalised,
            WerkstattArticleUnit.is_archived.is_(False),
        )
        .order_by(WerkstattArticleUnit.unit_number.asc())
    ).first()
    if unit is not None:
        return ScanResolveMachine(
            machine=machine_out_with_components(db, unit),
            matched_by="serial_number",
        )

    # 6. material_catalog_items.ean == code — return ALL rows
    catalog_rows = list(
        db.scalars(
            select(MaterialCatalogItem)
            .where(MaterialCatalogItem.ean == normalised)
            .order_by(MaterialCatalogItem.id.asc())
        ).all()
    )
    if catalog_rows:
        return ScanResolveCatalog(
            catalog_items=_catalog_items_out(db, catalog_rows),
            matched_by="catalog_ean",
        )

    # 7. material_catalog_items.article_no == code — return ALL rows
    catalog_rows = list(
        db.scalars(
            select(MaterialCatalogItem)
            .where(MaterialCatalogItem.article_no == normalised)
            .order_by(MaterialCatalogItem.id.asc())
        ).all()
    )
    if catalog_rows:
        return ScanResolveCatalog(
            catalog_items=_catalog_items_out(db, catalog_rows),
            matched_by="catalog_article_no",
        )

    # 8. The supplier number again, in another case or without separators.
    #    Only now, once every exact comparison above has missed: a looser
    #    spelling must never outrank a serial or a catalog row that carries
    #    the code exactly.
    supplier_hit = _supplier_article_hit(db, _loose_supplier_article_id(db, normalised))
    if supplier_hit is not None:
        return supplier_hit

    # 9. Not found — echo the raw code unchanged.
    return ScanResolveNotFound(code=raw)


# ──────────────────────────────────────────────────────────────────────────
# Steps 4 and 8 — the supplier's own number
# ──────────────────────────────────────────────────────────────────────────


def _supplier_article_hit(db: Session, article_id: int | None) -> ScanResolveWerkstatt | None:
    """The scan answer for an article found by its supplier number."""
    if article_id is None:
        return None
    article = db.get(WerkstattArticle, article_id)
    if article is None:
        return None
    return ScanResolveWerkstatt(
        article=_article_out(db, _follow_merge(db, article)),
        matched_by="supplier_no",
    )


def _exact_supplier_article_id(db: Session, code: str) -> int | None:
    """Step 4: the article whose supplier link carries exactly *code*.

    The exact answer stands even when a looser spelling would name other
    articles too: two wholesalers may use ``ab-1`` and ``AB-1`` for
    different products, and the label that says ``ab-1`` means the first.
    If links from different articles share the exact number (only possible
    across suppliers) the winner is deterministic, by article_number ASC.
    """
    return db.scalars(
        select(WerkstattArticleSupplier.article_id)
        .join(WerkstattArticle, WerkstattArticle.id == WerkstattArticleSupplier.article_id)
        .where(WerkstattArticleSupplier.supplier_article_no == code)
        .order_by(WerkstattArticle.article_number.asc(), WerkstattArticleSupplier.id.asc())
    ).first()


def _loose_supplier_article_id(db: Session, code: str) -> int | None:
    """Step 8: the one article whose supplier number is *code* spelled loosely.

    Two fallbacks, because what reaches us is rarely what the Datanorm
    stores: the rack's reader uppercases every letter, and a label prints
    ``1234-567`` where the file says ``1234567``. Each only answers when
    exactly ONE article matches — a looser comparison that names two
    articles is a coin toss, and a scan that books stock must not guess.
    """
    folded = _linked_articles(
        db, func.lower(WerkstattArticleSupplier.supplier_article_no) == code.lower()
    )
    if folded:
        # Several articles: stop. The key below is looser still, so it could
        # only match the same ones and more.
        return folded[0] if len(folded) == 1 else None

    key = identifier_search_key(code)
    if not key:
        return None
    keyed = _linked_articles(
        db, identifier_column_key(WerkstattArticleSupplier.supplier_article_no) == key
    )
    return keyed[0] if len(keyed) == 1 else None


def _linked_articles(db: Session, condition: ColumnElement[bool]) -> list[int]:
    """Up to two distinct articles with a supplier link satisfying *condition*.

    Two is enough to tell "exactly one" from "ambiguous".
    """
    return list(
        db.scalars(
            select(WerkstattArticleSupplier.article_id).where(condition).distinct().limit(2)
        ).all()
    )


# ──────────────────────────────────────────────────────────────────────────
# Internal projections
# ──────────────────────────────────────────────────────────────────────────


def _stock_status(article: WerkstattArticle) -> WerkstattStockStatus:
    """Compute the canonical ``WerkstattStockStatus`` from an article's
    snapshot counters.

    Rules (kept in sync with ``apps/web/src/types/werkstatt.ts``):
      - ``is_archived``                                       → ``unavailable``
      - ``stock_total == 0``                                   → ``empty``
      - ``stock_available == 0 and stock_out > 0``             → ``out``
      - ``stock_available <= stock_min`` (and > 0 or min>0)   → ``low``
      - otherwise                                             → ``available``
    """

    if bool(article.is_archived):
        return "unavailable"
    total = int(article.stock_total or 0)
    available = int(article.stock_available or 0)
    stock_out = int(article.stock_out or 0)
    stock_min = int(article.stock_min or 0)
    if total <= 0:
        return "empty"
    if available <= 0 and stock_out > 0:
        return "out"
    if stock_min > 0 and available <= stock_min:
        return "low"
    if available <= 0:
        return "empty"
    return "available"


def _article_out(db: Session, article: WerkstattArticle) -> WerkstattArticleOut:
    """Minimal ``WerkstattArticleOut`` projection used by scan results.

    The scan result intentionally does not hydrate the full ``suppliers``
    list — the mobile persona shows a compact card and deep-links into
    the article detail view where Desktop BE hydrates the rest. We return
    an empty suppliers list here to keep this service self-contained.
    """

    category_name: str | None = None
    if article.category_id is not None:
        cat = db.get(WerkstattCategory, article.category_id)
        category_name = cat.name if cat else None

    location_name: str | None = None
    if article.location_id is not None:
        loc = db.get(WerkstattLocation, article.location_id)
        location_name = loc.name if loc else None

    return WerkstattArticleOut(
        id=article.id,
        article_number=article.article_number,
        ean=article.ean,
        item_name=article.item_name,
        manufacturer=article.manufacturer,
        category_id=article.category_id,
        category_name=category_name,
        location_id=article.location_id,
        location_name=location_name,
        unit=article.unit,
        image_url=article.image_url,
        image_source=article.image_source,  # type: ignore[arg-type]
        image_checked_at=article.image_checked_at,
        source_catalog_item_id=article.source_catalog_item_id,
        stock_total=int(article.stock_total or 0),
        stock_available=int(article.stock_available or 0),
        stock_out=int(article.stock_out or 0),
        stock_repair=int(article.stock_repair or 0),
        stock_min=int(article.stock_min or 0),
        stock_status=_stock_status(article),
        is_serialized=bool(article.is_serialized),
        bg_inspection_required=bool(article.bg_inspection_required),
        bg_inspection_interval_days=article.bg_inspection_interval_days,
        last_bg_inspected_at=article.last_bg_inspected_at,
        next_bg_due_at=article.next_bg_due_at,
        purchase_price_cents=article.purchase_price_cents,
        currency=article.currency or "EUR",
        notes=article.notes,
        is_archived=bool(article.is_archived),
        suppliers=[],
        next_expected_delivery_at=None,
        created_at=article.created_at,
        updated_at=article.updated_at,
    )


def _catalog_items_out(
    db: Session,
    rows: list[MaterialCatalogItem],
) -> list[MaterialCatalogItemLiteOut]:
    """Project catalog rows to the lite schema, batching the supplier join."""

    supplier_ids = {r.supplier_id for r in rows if r.supplier_id is not None}
    supplier_names: dict[int, str] = {}
    if supplier_ids:
        for supplier in db.scalars(
            select(WerkstattSupplier).where(WerkstattSupplier.id.in_(supplier_ids))
        ).all():
            supplier_names[supplier.id] = supplier.name

    return [
        MaterialCatalogItemLiteOut(
            id=row.id,
            external_key=row.external_key,
            supplier_id=row.supplier_id,
            supplier_name=supplier_names.get(row.supplier_id) if row.supplier_id else None,
            article_no=row.article_no,
            item_name=row.item_name,
            ean=row.ean,
            manufacturer=row.manufacturer,
            unit=row.unit,
            price_text=row.price_text,
            image_url=row.image_url,
        )
        for row in rows
    ]
