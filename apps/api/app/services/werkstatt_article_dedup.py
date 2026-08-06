"""Folding duplicate articles and supplier rows into one canonical article.

Running more than one supplier's Datanorm produces two kinds of duplicate, and
they need opposite treatment:

**Catalog duplicates (automatic).** Supplier A and supplier B both list the
same physical product, so ``material_catalog_items`` holds one row per
supplier. These are not really duplicates to be deleted — each row is the
authentic record of what *that* wholesaler calls the article and charges for
it. The right move is to attach every one of them to a single
``WerkstattArticle`` as a ``WerkstattArticleSupplier`` link, so one article
carries supplier A's article number *and* supplier B's. EAN is a global product
identifier, so matching on an exact EAN is deterministic and safe to automate.

**Article duplicates (reviewed).** Two ``werkstatt_articles`` rows for the same
physical item. Note this can only happen when at least one of them has no EAN —
migration 0047 puts a partial-unique index on ``ean WHERE ean IS NOT NULL``, so
the database already prevents same-EAN article duplicates. Without an EAN there
is no identifier to prove two rows are the same product, only a name that looks
alike, so these are surfaced as candidates for a human to confirm rather than
merged automatically.

Merging is deliberately **archive, not delete**: ``werkstatt_movements`` and
``werkstatt_order_lines`` reference articles with ``ondelete=RESTRICT`` because
they are an audit ledger. The merge repoints those rows onto the survivor and
retires the duplicate, so history stays intact and traceable.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.models.entities import (
    MaterialCatalogItem,
    WerkstattArticle,
    WerkstattArticleSupplier,
    WerkstattConstructionBoxItem,
    WerkstattMovement,
    WerkstattOrderLine,
)
from app.services.search_matching import identifier_key, normalize_query
from app.services.werkstatt_movements import recompute_article_stock

# A workshop inventory is small (hundreds to low thousands of articles) — very
# unlike the Datanorm catalog. Scanning it in Python keeps the candidate search
# portable across PostgreSQL and the SQLite test database. The cap stops a
# pathological inventory from turning the review screen into a slow query.
DUPLICATE_SCAN_MAX_ARTICLES = 5000

# Share of name tokens two articles must have in common to be offered as a
# merge candidate. Tuned to catch "Schuko Steckdose weiss" vs
# "Schuko-Steckdose weiß" without pairing every cable with every other cable.
NAME_OVERLAP_THRESHOLD = 0.7


@dataclass(frozen=True)
class DuplicateCandidate:
    """Two articles that look like the same product, for a human to confirm."""

    article_id: int
    duplicate_id: int
    score: float
    reason: str


@dataclass(frozen=True)
class MergeResult:
    """What a merge actually moved — surfaced so the caller can report it."""

    survivor_id: int
    merged_id: int
    supplier_links_moved: int = 0
    supplier_links_skipped: int = 0
    movements_moved: int = 0
    order_lines_moved: int = 0
    box_items_moved: int = 0
    fields_filled: tuple[str, ...] = ()


def _name_tokens(value: str) -> set[str]:
    """Normalised token set for loose product-name comparison."""
    return {token for token in normalize_query(value).replace("-", " ").split(" ") if token}


def _overlap(left: set[str], right: set[str]) -> float:
    """Jaccard overlap. 1.0 means the same tokens in any order."""
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def catalog_duplicates_for_article(
    db: Session, article: WerkstattArticle
) -> list[MaterialCatalogItem]:
    """Datanorm rows describing this same article, across all suppliers.

    Matches on exact EAN only. An article without an EAN has no identifier
    strong enough to fold suppliers together automatically, so it returns
    nothing rather than guessing.
    """
    ean = (article.ean or "").strip()
    if not ean:
        return []
    return list(
        db.scalars(
            select(MaterialCatalogItem).where(
                MaterialCatalogItem.ean == ean,
                MaterialCatalogItem.supplier_id.is_not(None),
            )
        ).all()
    )


def link_catalog_duplicates(db: Session, article: WerkstattArticle) -> list[WerkstattArticleSupplier]:
    """Attach every same-EAN Datanorm row to this article as a supplier link.

    Idempotent: suppliers already linked are left alone, which matters because
    ``(article_id, supplier_id)`` is unique and because an existing link may
    carry hand-edited prices or lead times we must not clobber.

    Returns only the links actually created.
    """
    duplicates = catalog_duplicates_for_article(db, article)
    if not duplicates:
        return []

    linked_supplier_ids = set(
        db.scalars(
            select(WerkstattArticleSupplier.supplier_id).where(
                WerkstattArticleSupplier.article_id == article.id
            )
        ).all()
    )
    has_preferred = bool(linked_supplier_ids) and bool(
        db.scalar(
            select(WerkstattArticleSupplier.id).where(
                WerkstattArticleSupplier.article_id == article.id,
                WerkstattArticleSupplier.is_preferred.is_(True),
            )
        )
    )

    created: list[WerkstattArticleSupplier] = []
    for row in duplicates:
        if row.supplier_id in linked_supplier_ids:
            continue
        link = WerkstattArticleSupplier(
            article_id=article.id,
            supplier_id=row.supplier_id,
            supplier_article_no=(row.article_no or None),
            source_catalog_item_id=row.id,
            # First link on an article with none becomes the preferred one so
            # reorder flows always have a supplier to target.
            is_preferred=(not has_preferred and not created),
        )
        db.add(link)
        linked_supplier_ids.add(row.supplier_id)
        created.append(link)

    if created:
        db.flush()
    return created


def find_duplicate_candidates(
    db: Session, *, limit: int = 50
) -> list[DuplicateCandidate]:
    """Articles that look like the same product but cannot be proven so.

    Only pairs where at least one side lacks an EAN are worth reporting — when
    both have EANs the database has already guaranteed they differ, so they are
    genuinely different products no matter how alike the names read.
    """
    articles = list(
        db.scalars(
            select(WerkstattArticle)
            .where(WerkstattArticle.is_archived.is_(False))
            .order_by(WerkstattArticle.id.asc())
            .limit(DUPLICATE_SCAN_MAX_ARTICLES)
        ).all()
    )

    tokens_by_id = {article.id: _name_tokens(article.item_name) for article in articles}
    candidates: list[DuplicateCandidate] = []

    for index, left in enumerate(articles):
        for right in articles[index + 1 :]:
            left_ean = (left.ean or "").strip()
            right_ean = (right.ean or "").strip()
            # Two known-different EANs are two different products, full stop.
            if left_ean and right_ean:
                continue

            # A shared supplier article number is strong evidence: the same
            # wholesaler does not give one number to two different products.
            shared_supplier_no = _shared_supplier_article_no(db, left.id, right.id)
            if shared_supplier_no:
                candidates.append(
                    DuplicateCandidate(
                        article_id=left.id,
                        duplicate_id=right.id,
                        score=1.0,
                        reason=f"same supplier article number ({shared_supplier_no})",
                    )
                )
                continue

            score = _overlap(tokens_by_id[left.id], tokens_by_id[right.id])
            if score >= NAME_OVERLAP_THRESHOLD:
                candidates.append(
                    DuplicateCandidate(
                        article_id=left.id,
                        duplicate_id=right.id,
                        score=round(score, 3),
                        reason="near-identical name, no EAN to distinguish them",
                    )
                )

    candidates.sort(key=lambda candidate: candidate.score, reverse=True)
    return candidates[:limit]


def _shared_supplier_article_no(db: Session, left_id: int, right_id: int) -> str | None:
    """A supplier article number both articles carry, if any."""
    rows = db.execute(
        select(
            WerkstattArticleSupplier.article_id,
            WerkstattArticleSupplier.supplier_id,
            WerkstattArticleSupplier.supplier_article_no,
        ).where(WerkstattArticleSupplier.article_id.in_([left_id, right_id]))
    ).all()
    by_article: dict[int, set[tuple[int, str]]] = {left_id: set(), right_id: set()}
    for article_id, supplier_id, supplier_article_no in rows:
        key = identifier_key(supplier_article_no or "")
        if key:
            by_article[article_id].add((supplier_id, key))
    shared = by_article[left_id] & by_article[right_id]
    if not shared:
        return None
    return sorted(shared)[0][1]


# Fields copied from the duplicate onto the survivor when the survivor has
# nothing there. This is the "append data" half of a merge: a merge should
# never lose information the duplicate held.
_FILLABLE_FIELDS = (
    "ean",
    "manufacturer",
    "unit",
    "image_url",
    "image_source",
    "category_id",
    "location_id",
    "purchase_price_cents",
    "notes",
)


def merge_articles(
    db: Session, *, survivor: WerkstattArticle, duplicate: WerkstattArticle
) -> MergeResult:
    """Fold ``duplicate`` into ``survivor``, preserving every referencing row.

    Repoints all four foreign keys that reference ``werkstatt_articles``, then
    recomputes the survivor's stock from the moved ledger rather than adding
    the two snapshots together — the counters are derived values and the ledger
    is the source of truth.
    """
    if survivor.id == duplicate.id:
        raise ValueError("Cannot merge an article into itself")

    # ── Supplier links: union, keeping the survivor's own on conflict ──
    survivor_supplier_ids = set(
        db.scalars(
            select(WerkstattArticleSupplier.supplier_id).where(
                WerkstattArticleSupplier.article_id == survivor.id
            )
        ).all()
    )
    duplicate_links = list(
        db.scalars(
            select(WerkstattArticleSupplier).where(
                WerkstattArticleSupplier.article_id == duplicate.id
            )
        ).all()
    )
    moved_links = 0
    skipped_links = 0
    for link in duplicate_links:
        if link.supplier_id in survivor_supplier_ids:
            # (article_id, supplier_id) is unique and the survivor's link may
            # carry curated pricing — drop the duplicate's rather than clobber.
            db.delete(link)
            skipped_links += 1
            continue
        link.article_id = survivor.id
        # Preference belongs to the survivor's existing links, if it has any.
        if survivor_supplier_ids:
            link.is_preferred = False
        survivor_supplier_ids.add(link.supplier_id)
        moved_links += 1

    # ── Fill blanks on the survivor before the duplicate is retired ──
    filled: list[str] = []
    for field_name in _FILLABLE_FIELDS:
        if getattr(survivor, field_name, None):
            continue
        value = getattr(duplicate, field_name, None)
        if not value:
            continue
        if field_name == "ean":
            # EAN is partial-unique; clear it on the duplicate first so both
            # rows are never briefly holding the same value.
            duplicate.ean = None
            db.flush()
        setattr(survivor, field_name, value)
        filled.append(field_name)

    db.flush()

    # ── Repoint the ledger and every other referencing row ──
    movements_moved = db.execute(
        update(WerkstattMovement)
        .where(WerkstattMovement.article_id == duplicate.id)
        .values(article_id=survivor.id)
    ).rowcount
    order_lines_moved = db.execute(
        update(WerkstattOrderLine)
        .where(WerkstattOrderLine.article_id == duplicate.id)
        .values(article_id=survivor.id)
    ).rowcount
    box_items_moved = db.execute(
        update(WerkstattConstructionBoxItem)
        .where(WerkstattConstructionBoxItem.article_id == duplicate.id)
        .values(article_id=survivor.id)
    ).rowcount

    # Retire rather than delete: the movement ledger is an audit trail and the
    # duplicate's article number may appear on printed labels already.
    duplicate.is_archived = True
    duplicate.stock_total = 0
    duplicate.stock_available = 0
    duplicate.stock_out = 0
    duplicate.stock_repair = 0
    db.flush()

    recompute_article_stock(db, survivor)

    return MergeResult(
        survivor_id=survivor.id,
        merged_id=duplicate.id,
        supplier_links_moved=moved_links,
        supplier_links_skipped=skipped_links,
        movements_moved=int(movements_moved or 0),
        order_lines_moved=int(order_lines_moved or 0),
        box_items_moved=int(box_items_moved or 0),
        fields_filled=tuple(filled),
    )
