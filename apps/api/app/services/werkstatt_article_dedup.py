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
    TaskMaterial,
    WerkstattArticle,
    WerkstattArticleSupplier,
    WerkstattArticleUnit,
    WerkstattConstructionBoxItem,
    WerkstattDuplicateDismissal,
    WerkstattInventoryCount,
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
    # English, for logs and the existing API contract.
    reason: str
    # The same fact in a form the UI can render in German without parsing
    # prose: "supplier_no" carries the shared number in `reason_detail`,
    # "name" carries nothing.
    reason_code: str = "name"
    reason_detail: str | None = None

    @property
    def pair_key(self) -> str:
        """Identity of the PAIR, independent of which side is offered first.

        The finder walks the article list in id order, so which of the two is
        "article" and which is "duplicate" depends on nothing a human can see.
        A dismissal keyed on that order would be undone by the next row
        somebody adds; keyed on this it holds.
        """
        return pair_key(self.article_id, self.duplicate_id)


def pair_key(left_id: int, right_id: int) -> str:
    low, high = sorted((int(left_id), int(right_id)))
    return f"{low}:{high}"


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
    units_moved: int = 0
    inventory_counts_moved: int = 0
    task_materials_moved: int = 0
    internal_code_moved: bool = False
    # Supplier numbers that could not travel as their own link row because the
    # survivor was already linked to that supplier, and were kept anyway.
    supplier_numbers_kept: tuple[str, ...] = ()
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

    Three things are excluded outright, each because offering them would waste
    the reviewer's attention on a question that already has an answer:

    * a consumable paired with a machine TYPE — one is counted, the other has
      individually labelled units with their own inspection dates, and merging
      them is never the right move;
    * a row that is already merged into another (it is archived and its ledger
      has moved, so it is not a candidate for anything);
    * a pair somebody has already dismissed.

    The comparison is O(n²) in Python, which is fine for the hundreds of
    articles a workshop holds and is why ``DUPLICATE_SCAN_MAX_ARTICLES`` caps
    it — but it used to run a *query* per pair to find shared supplier numbers,
    which at 400 articles is 80 000 round trips for one screen. The links are
    now fetched once, up front.
    """
    articles = list(
        db.scalars(
            select(WerkstattArticle)
            .where(
                WerkstattArticle.is_archived.is_(False),
                WerkstattArticle.merged_into_id.is_(None),
            )
            .order_by(WerkstattArticle.id.asc())
            .limit(DUPLICATE_SCAN_MAX_ARTICLES)
        ).all()
    )
    if len(articles) < 2:
        return []

    tokens_by_id = {article.id: _name_tokens(article.item_name) for article in articles}
    supplier_keys = _supplier_keys_by_article(db, [article.id for article in articles])
    dismissed = dismissed_pairs(db)
    candidates: list[DuplicateCandidate] = []

    for index, left in enumerate(articles):
        for right in articles[index + 1 :]:
            left_ean = (left.ean or "").strip()
            right_ean = (right.ean or "").strip()
            # Two known-different EANs are two different products, full stop.
            if left_ean and right_ean:
                continue
            # A drill type and a box of screws are not a merge candidate,
            # however alike a Datanorm made their names look.
            if bool(left.is_serialized) != bool(right.is_serialized):
                continue
            if pair_key(left.id, right.id) in dismissed:
                continue

            # A shared supplier article number is strong evidence: the same
            # wholesaler does not give one number to two different products.
            shared = supplier_keys.get(left.id, set()) & supplier_keys.get(right.id, set())
            if shared:
                candidates.append(
                    DuplicateCandidate(
                        article_id=left.id,
                        duplicate_id=right.id,
                        score=1.0,
                        reason=f"same supplier article number ({sorted(shared)[0][1]})",
                        reason_code="supplier_no",
                        reason_detail=sorted(shared)[0][1],
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
                        reason_code="name",
                    )
                )

    candidates.sort(key=lambda candidate: candidate.score, reverse=True)
    return candidates[:limit]


def _supplier_keys_by_article(
    db: Session, article_ids: list[int]
) -> dict[int, set[tuple[int, str]]]:
    """``{article_id: {(supplier_id, normalised number)}}`` in ONE query.

    Normalised through ``identifier_key`` so "26 190" and "26190" are the same
    number — which they are, on the supplier's invoice.
    """
    if not article_ids:
        return {}
    rows = db.execute(
        select(
            WerkstattArticleSupplier.article_id,
            WerkstattArticleSupplier.supplier_id,
            WerkstattArticleSupplier.supplier_article_no,
        ).where(WerkstattArticleSupplier.article_id.in_(article_ids))
    ).all()
    keys: dict[int, set[tuple[int, str]]] = {}
    for article_id, supplier_id, supplier_article_no in rows:
        key = identifier_key(supplier_article_no or "")
        if key:
            keys.setdefault(article_id, set()).add((supplier_id, key))
    return keys


# ── "Kein Duplikat" — judgements that have to stick ───────────────────────


def dismissed_pairs(db: Session) -> set[str]:
    """Every pair a human has already said no to, as ``pair_key`` strings."""
    rows = db.execute(
        select(
            WerkstattDuplicateDismissal.low_article_id,
            WerkstattDuplicateDismissal.high_article_id,
        )
    ).all()
    return {pair_key(low, high) for low, high in rows}


def dismiss_pair(
    db: Session, *, left_id: int, right_id: int, user_id: int | None
) -> WerkstattDuplicateDismissal:
    """Record that these two are different products. Idempotent, no commit."""
    low, high = sorted((int(left_id), int(right_id)))
    existing = db.scalars(
        select(WerkstattDuplicateDismissal).where(
            WerkstattDuplicateDismissal.low_article_id == low,
            WerkstattDuplicateDismissal.high_article_id == high,
        )
    ).first()
    if existing is not None:
        return existing
    row = WerkstattDuplicateDismissal(
        low_article_id=low, high_article_id=high, dismissed_by=user_id
    )
    db.add(row)
    db.flush()
    return row


def undismiss_pair(db: Session, *, left_id: int, right_id: int) -> bool:
    """Undo a dismissal, so the pair is offered again. True when one existed."""
    low, high = sorted((int(left_id), int(right_id)))
    row = db.scalars(
        select(WerkstattDuplicateDismissal).where(
            WerkstattDuplicateDismissal.low_article_id == low,
            WerkstattDuplicateDismissal.high_article_id == high,
        )
    ).first()
    if row is None:
        return False
    db.delete(row)
    db.flush()
    return True


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

    Repoints every foreign key that names an article, then recomputes the
    survivor's stock from the moved ledger rather than adding the two snapshots
    together — the counters are derived values and the ledger is the truth.

    "Every" is the word that changed. Movements, order lines and box items were
    moved; machine units, stock-take counts and task material lines were not,
    so merging a serialized article orphaned its machines, and a stock-take in
    progress silently counted against a row that no longer received stock.
    A half-merge is worse than no merge: it leaves the data in a state nobody
    designed and nobody can see.

    The duplicate is retired rather than deleted (the ledger references it with
    ondelete=RESTRICT and its number is on a printed label) and
    ``merged_into_id`` is set, which is what makes that label keep working —
    see ``werkstatt_scan._follow_merge``.
    """
    if survivor.id == duplicate.id:
        raise ValueError("Cannot merge an article into itself")
    if survivor.merged_into_id is not None:
        # One hop, enforced here. A chain would make the scan cascade a graph
        # walk and would let a mistake be buried two merges deep. Merging the
        # other way round — to undo a wrong survivor choice — stays possible,
        # because the *duplicate* being merged already is allowed.
        raise ValueError("Survivor article has itself been merged")

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
    survivor_links_by_supplier = {
        link.supplier_id: link
        for link in db.scalars(
            select(WerkstattArticleSupplier).where(
                WerkstattArticleSupplier.article_id == survivor.id
            )
        ).all()
    }
    moved_links = 0
    skipped_links = 0
    numbers_kept: list[str] = []
    for link in duplicate_links:
        if link.supplier_id in survivor_supplier_ids:
            # (article_id, supplier_id) is unique, so this link cannot move as
            # a row — but its NUMBER must not evaporate. The confirmation says
            # supplier article numbers are carried across, and a wholesaler
            # legitimately has two numbers for one product (26190 and its newer
            # Datanorm spelling 26191): the next order to that supplier used to
            # go out under whichever one happened to be on the survivor, with
            # nothing on screen saying the other had just been deleted.
            kept = _keep_supplier_number(
                db,
                survivor_link=survivor_links_by_supplier.get(link.supplier_id),
                duplicate_link=link,
                duplicate_number=duplicate.article_number,
            )
            if kept:
                numbers_kept.append(kept)
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

    # The in-house barcode is the one field where the duplicate's value is
    # physically on a shelf. Carrying it over means the sticker keeps scanning
    # straight to the survivor rather than through the merge pointer — and the
    # column is unique, so the duplicate must let go of it first.
    internal_code_moved = False
    if not survivor.internal_code and duplicate.internal_code:
        carried = duplicate.internal_code
        duplicate.internal_code = None
        db.flush()
        survivor.internal_code = carried
        internal_code_moved = True

    # A merge may not quietly turn a machine type into a consumable: the units
    # are about to point at the survivor and they need a type that expects them.
    if duplicate.is_serialized and not survivor.is_serialized:
        survivor.is_serialized = True
        filled.append("is_serialized")

    db.flush()

    # ── Repoint the ledger and every other referencing row ──
    movements_moved = _repoint(db, WerkstattMovement, duplicate.id, survivor.id)
    order_lines_moved = _repoint(db, WerkstattOrderLine, duplicate.id, survivor.id)
    box_items_moved = _repoint(db, WerkstattConstructionBoxItem, duplicate.id, survivor.id)
    units_moved = _repoint(db, WerkstattArticleUnit, duplicate.id, survivor.id)
    task_materials_moved = _repoint(db, TaskMaterial, duplicate.id, survivor.id)
    counts_moved = _merge_inventory_counts(db, duplicate.id, survivor.id)

    # Retire rather than delete: the movement ledger is an audit trail and the
    # duplicate's article number may appear on printed labels already.
    duplicate.is_archived = True
    duplicate.merged_into_id = survivor.id
    duplicate.stock_total = 0
    duplicate.stock_available = 0
    duplicate.stock_out = 0
    duplicate.stock_repair = 0
    db.flush()

    # Every pointer stays ONE hop. A row merged into this duplicate earlier
    # now points at an archived, zero-stock row, and its printed label would
    # resolve there — the exact failure `merged_into_id` exists to prevent.
    # Forwarding them costs one UPDATE and keeps `_follow_merge`'s single
    # documented hop honest without turning the scan cascade into a graph walk.
    db.execute(
        update(WerkstattArticle)
        .where(
            WerkstattArticle.merged_into_id == duplicate.id,
            WerkstattArticle.id != survivor.id,
        )
        .values(merged_into_id=survivor.id)
    )
    db.flush()

    # A pair that has been merged can never be a candidate again, and a
    # dismissal naming a row that no longer stands on its own is noise.
    _drop_dismissals_for(db, duplicate.id)

    recompute_article_stock(db, survivor)

    return MergeResult(
        survivor_id=survivor.id,
        merged_id=duplicate.id,
        supplier_links_moved=moved_links,
        supplier_links_skipped=skipped_links,
        movements_moved=movements_moved,
        order_lines_moved=order_lines_moved,
        box_items_moved=box_items_moved,
        units_moved=units_moved,
        inventory_counts_moved=counts_moved,
        task_materials_moved=task_materials_moved,
        internal_code_moved=internal_code_moved,
        supplier_numbers_kept=tuple(numbers_kept),
        fields_filled=tuple(filled),
    )


def _keep_supplier_number(
    db: Session,
    *,
    survivor_link: WerkstattArticleSupplier | None,
    duplicate_link: WerkstattArticleSupplier,
    duplicate_number: str,
) -> str | None:
    """Retire the duplicate's link, preserving the NUMBER it carried.

    Three cases, and only the last one needs prose. The survivor's link may
    have no number at all — then it simply adopts this one. The two numbers may
    be the same number written differently ("26 190" and "26190" are one number
    on the invoice) — then nothing is lost by dropping it. Otherwise they are
    two genuine numbers for one product, the link row cannot hold both, and the
    survivor's own number is the one with any curated pricing behind it — so
    the duplicate's is written onto that link's notes, where an order clerk
    looking at the supplier can still find it.
    """
    number = (duplicate_link.supplier_article_no or "").strip()
    # The duplicate's row goes first, and its DELETE is flushed before anything
    # is written: (supplier_id, supplier_article_no) is partial-unique, so
    # adopting the number while the old row still holds it would trip the index
    # inside the merge's own transaction.
    db.delete(duplicate_link)
    db.flush()
    if survivor_link is None or not number:
        return None
    existing = (survivor_link.supplier_article_no or "").strip()
    if not existing:
        survivor_link.supplier_article_no = number
        db.add(survivor_link)
        return number
    if identifier_key(existing) == identifier_key(number):
        return None
    note = f"Weitere Artikelnummer bei diesem Lieferanten: {number} (aus {duplicate_number})"
    if note not in (survivor_link.notes or ""):
        survivor_link.notes = "\n".join(
            part for part in ((survivor_link.notes or "").strip(), note) if part
        )
        db.add(survivor_link)
    return number


def _repoint(db: Session, model, duplicate_id: int, survivor_id: int) -> int:
    """Move every row of *model* from the duplicate onto the survivor."""
    result = db.execute(
        update(model)
        .where(model.article_id == duplicate_id)
        .values(article_id=survivor_id)
    ).rowcount
    return int(result or 0)


def _merge_inventory_counts(db: Session, duplicate_id: int, survivor_id: int) -> int:
    """Move stock-take counts, adding into the survivor's row where one exists.

    ``(session_id, article_id)`` is unique — one line per article per session —
    so a blind UPDATE breaks the moment a stock-take counted both rows, which
    is exactly the situation that makes somebody merge them. The counted
    quantities are added instead: the person walked the shelf once and found
    both bins, and the session's job is to report what is there.
    """
    duplicate_counts = list(
        db.scalars(
            select(WerkstattInventoryCount).where(
                WerkstattInventoryCount.article_id == duplicate_id
            )
        ).all()
    )
    if not duplicate_counts:
        return 0
    survivor_by_session = {
        row.session_id: row
        for row in db.scalars(
            select(WerkstattInventoryCount).where(
                WerkstattInventoryCount.article_id == survivor_id,
                WerkstattInventoryCount.session_id.in_(
                    [row.session_id for row in duplicate_counts]
                ),
            )
        ).all()
    }
    moved = 0
    for row in duplicate_counts:
        target = survivor_by_session.get(row.session_id)
        if target is None:
            row.article_id = survivor_id
            db.add(row)
        else:
            target.counted_qty = int(target.counted_qty or 0) + int(row.counted_qty or 0)
            target.scan_count = int(target.scan_count or 0) + int(row.scan_count or 0)
            target.last_counted_at = max(target.last_counted_at, row.last_counted_at)
            db.add(target)
            db.delete(row)
        moved += 1
    db.flush()
    return moved


def _drop_dismissals_for(db: Session, article_id: int) -> None:
    for row in db.scalars(
        select(WerkstattDuplicateDismissal).where(
            (WerkstattDuplicateDismissal.low_article_id == article_id)
            | (WerkstattDuplicateDismissal.high_article_id == article_id)
        )
    ).all():
        db.delete(row)
    db.flush()
