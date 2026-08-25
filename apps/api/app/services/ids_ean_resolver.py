"""What does THIS wholesaler call the thing we just scanned?

The workshop scans EAN barcodes, because that is what is printed on the box.
The wholesaler's shop has never heard of an EAN in its article-number field:
IDS-Connect matches a cart position on ``ArtNo``, which is the *supplier's own*
number. Hand it a GTIN and the position does not error — it is quietly not
recognised, the basket comes up one line short, and nobody finds out until the
van is loaded. That silence is the whole reason this module exists.

We already hold everything needed to do the translation locally. Datanorm is
the wholesaler's own catalogue: ~1.07 M ``material_catalog_items`` rows, ~977 k
of them carrying an EAN, each row tying that EAN to the article number the same
wholesaler wants back. Resolving against it is one indexed lookup.

## The cascade

    0. the line's own ``supplier_article_no`` snapshot
    1. ``werkstatt_article_suppliers.supplier_article_no`` for article+supplier
    2. this supplier's Datanorm row matching an EAN we hold
    3. this supplier's Datanorm row matching a number we hold
    4. (extension point — a live SupplierLookup; nothing ships one)
    5. unresolved → reported, never silently dropped

Each step is justified where it is implemented. Two properties of the whole:

**Everything is scoped to one supplier.** Two wholesalers reuse each other's
article numbers freely, so an unscoped catalogue match would confidently order
the wrong product — the trap ``werkstatt_order_composition.resolve_article``
documents. Only the EAN is a global identifier, and it is used to *find* the
supplier's row, never as the answer.

**Nothing is invented.** A step that cannot prove its answer declines and the
line is reported. A missing line costs a phone call; a plausible-looking wrong
one costs a return and a second delivery day.

## Why there is no webshop lookup here

The obvious fourth move — search Unielektro's site for the EAN and scrape the
article id — is deliberately not implemented, and ``SupplierLookup`` below is
the whole of the accommodation:

  * the local catalogue already answers ~977 k EANs offline, so a network call
    would fire mainly for products the wholesaler does not carry — where it
    cannot help either;
  * result markup is not an interface. When it changes the failure is a *wrong*
    number scraped from a neighbouring card: the exact failure this module
    exists to prevent;
  * it would run unauthenticated against a partner's site once per line per
    submission, spending somebody else's rate limit;
  * submission is interactive, so a slow shop becomes a timeout the buyer
    cannot act on.

Added later, it belongs behind ``SupplierLookup``, after step 3, writing back
through the same backfill so the second order never makes the call.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol, Sequence

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.models.entities import (
    MaterialCatalogItem,
    WerkstattArticle,
    WerkstattArticleSupplier,
)
from app.services.search_matching import identifier_key

MatchedBy = Literal[
    "line_snapshot",
    "supplier_link",
    "catalog_ean",
    "catalog_article_no",
    "supplier_lookup",
    "unresolved",
]

# GTIN-13 and GTIN-14 are the shapes a retail scanner emits. Deliberately NOT
# 8 or 12 digits: real wholesaler article numbers are routinely 8 digits
# (Unielektro's "11102138", "01004771"), and doubting those would throw away
# article numbers that work — a worse outcome than the bug being fixed.
_GTIN_LENGTHS = (13, 14)


class SupplierLookup(Protocol):
    """Extension point: ask the supplier directly what they call this article.

    Intentionally unimplemented — see the module docstring. An implementation
    must be **last resort** (only after step 3), **fail-soft** (return ``None``,
    never raise, when the shop is slow or its markup changed, so a submission
    still completes) and **specific** (a number only when the supplier
    identified exactly one article — an ambiguous scrape is how the wrong
    product gets ordered). Its answers are written back through the same
    backfill, so the call happens once per article, not once per order.
    """

    def find_supplier_article_no(
        self, *, supplier_id: int, ean: str | None, description: str | None
    ) -> str | None:  # pragma: no cover - protocol declaration
        ...


@dataclass(frozen=True)
class OrderLineRef:
    """What the resolver needs about one line, and nothing more.

    Deliberately neither ``WerkstattOrderLine`` nor ``WerkstattOrderLineOut``:
    the submit endpoint holds schema objects, other callers hold ORM rows, and
    ``from_line`` reads whichever it is handed.
    """

    position: int
    article_id: int | None = None
    article_number: str | None = None
    description: str | None = None
    ean: str | None = None
    supplier_article_no: str | None = None
    manufacturer: str | None = None

    @classmethod
    def from_line(cls, position: int, line: object) -> "OrderLineRef":
        """Adapt an order line of either shape.

        ``WerkstattOrderLineOut`` calls the display name ``article_name`` and
        resolves it from the stocked article; the ORM row calls it
        ``description``. Both are read so a caller never has to convert.
        """

        return cls(
            position=position,
            article_id=getattr(line, "article_id", None),
            article_number=getattr(line, "article_number", None),
            description=(
                getattr(line, "article_name", None) or getattr(line, "description", None)
            ),
            ean=getattr(line, "ean", None),
            supplier_article_no=getattr(line, "supplier_article_no", None),
            manufacturer=getattr(line, "manufacturer", None),
        )


@dataclass(frozen=True)
class Resolution:
    """The answer for one line, plus enough context to act when there is none."""

    position: int
    supplier_article_no: str | None
    matched_by: MatchedBy
    article_id: int | None = None
    article_number: str | None = None
    description: str | None = None
    ean: str | None = None
    catalog_item_id: int | None = None
    # Other Datanorm rows that matched equally well. >0 means we picked one;
    # the buyer should know, because pack size and variant hide here.
    ambiguous_alternatives: int = 0
    # Field names written back to our own records by this resolution.
    backfilled: tuple[str, ...] = ()

    @property
    def is_resolved(self) -> bool:
        return bool(self.supplier_article_no)

    def label(self) -> str:
        """Number, name and EAN — all three, because each fails alone: the
        SP-number means nothing at the shelf, the name is ambiguous across
        variants, and a free line has no number at all.
        """

        parts = [part for part in (self.article_number, self.description) if part]
        head = " · ".join(parts) if parts else "ohne Bezeichnung"
        if self.ean:
            head = f"{head}, EAN {self.ean}"
        return head


@dataclass(frozen=True)
class ResolutionReport:
    """Every line's answer, in the order the lines were given."""

    supplier_id: int
    resolutions: tuple[Resolution, ...]
    supplier_name: str | None = None

    @property
    def unresolved(self) -> tuple[Resolution, ...]:
        return tuple(item for item in self.resolutions if not item.is_resolved)

    @property
    def backfilled(self) -> tuple[Resolution, ...]:
        return tuple(item for item in self.resolutions if item.backfilled)

    def warnings(self) -> tuple[str, ...]:
        """German, caller-facing, one per line that needs a human. Unresolved
        first — those are the ones that will be missing from the basket, and a
        skimmed list should lead with what costs a delivery.
        """

        supplier = self.supplier_name or "diesem Lieferanten"
        messages = [
            f"Position {item.position} ({item.label()}) hat keine Artikelnummer für "
            f"{supplier} — die Position kann nicht übergeben werden. Bitte die "
            "Lieferanten-Artikelnummer am Artikel hinterlegen oder den Datanorm-"
            "Katalog aktualisieren."
            for item in self.unresolved
        ]
        messages.extend(
            f"Position {item.position} ({item.label()}): {item.ambiguous_alternatives} "
            f"weitere Katalog-Treffer, übergeben wird "
            f"{item.supplier_article_no}"
            for item in self.resolutions
            if item.is_resolved and item.ambiguous_alternatives
        )
        return tuple(messages)


@dataclass(frozen=True)
class _Ctx:
    """Per-call constants, resolved once instead of per line."""

    db: Session
    supplier_id: int
    supplier_has_catalog: bool
    backfill: bool
    lookup: SupplierLookup | None


# ──────────────────────────────────────────────────────────────────────────
# Public entry points
# ──────────────────────────────────────────────────────────────────────────


def resolve_order_lines(
    db: Session,
    *,
    supplier_id: int,
    lines: Sequence[object],
    supplier_name: str | None = None,
    backfill: bool = True,
    lookup: SupplierLookup | None = None,
) -> ResolutionReport:
    """Resolve every line of an order against one supplier.

    Positions are 1-based and follow the order of ``lines``, so they match the
    ``RefItems/Customer`` numbers ``ids_cart_builder`` emits and a warning about
    "Position 3" points at the third line of the cart.

    Backfill writes are flushed, never committed — the caller owns the
    transaction, and on the submit path that commit already exists.
    """

    ctx = _Ctx(
        db=db,
        supplier_id=supplier_id,
        supplier_has_catalog=_supplier_has_catalog(db, supplier_id),
        backfill=backfill,
        lookup=lookup,
    )
    resolutions = tuple(
        _resolve(ctx, OrderLineRef.from_line(position, line))
        for position, line in enumerate(lines, start=1)
    )
    return ResolutionReport(
        supplier_id=supplier_id,
        supplier_name=supplier_name,
        resolutions=resolutions,
    )


def resolve_line(
    db: Session,
    *,
    supplier_id: int,
    ref: OrderLineRef,
    backfill: bool = True,
    lookup: SupplierLookup | None = None,
) -> Resolution:
    """Resolve a single line. The one-shot form of ``resolve_order_lines``."""

    ctx = _Ctx(
        db=db,
        supplier_id=supplier_id,
        supplier_has_catalog=_supplier_has_catalog(db, supplier_id),
        backfill=backfill,
        lookup=lookup,
    )
    return _resolve(ctx, ref)


# ──────────────────────────────────────────────────────────────────────────
# The cascade
# ──────────────────────────────────────────────────────────────────────────


def _resolve(ctx: _Ctx, ref: OrderLineRef) -> Resolution:
    article = (
        ctx.db.get(WerkstattArticle, ref.article_id) if ref.article_id is not None else None
    )
    eans = _ean_candidates(ref, article)

    # ── 0. What the line already says ────────────────────────────────────
    # The snapshot is what we ordered; every other step is only what we
    # currently believe. It wins for the same reason `_order_line_out` prefers
    # it: a cart that came back from the shop carries the shop's own number,
    # and re-deriving it would silently rewrite the order.
    #
    # Except when the snapshot is a scanned barcode wearing an article
    # number's hat, which is the entire reported bug.
    snapshot = _clean(ref.supplier_article_no)
    if snapshot and not _snapshot_is_really_a_barcode(ctx, snapshot, eans):
        return _resolved(ref, article, snapshot, "line_snapshot")

    # ── 1. The number we recorded for this article at this supplier ──────
    # The authoritative local answer: somebody (an import, a fold, an earlier
    # run of this resolver) already established what this wholesaler calls it,
    # and `(article_id, supplier_id)` is unique so there is exactly one.
    if article is not None:
        link = ctx.db.scalar(
            select(WerkstattArticleSupplier).where(
                WerkstattArticleSupplier.article_id == article.id,
                WerkstattArticleSupplier.supplier_id == ctx.supplier_id,
            )
        )
        linked_no = _clean(link.supplier_article_no) if link is not None else None
        if linked_no:
            return _resolved(ref, article, linked_no, "supplier_link")

    # ── 2. This supplier's Datanorm, found by EAN ────────────────────────
    # The step the workshop actually needs. An EAN is a global product
    # identifier, so finding the supplier's row by it is deterministic —
    # and the row's `article_no` is, by construction, exactly what the
    # supplier's shop expects back.
    row, others = _catalog_row_by_ean(ctx, eans)
    if row is not None:
        written = _record(ctx, article, row, eans)
        return _resolved(
            ref,
            article,
            _clean(row.article_no),
            "catalog_ean",
            catalog_item_id=row.id,
            ambiguous=others,
            backfilled=written,
        )

    # ── 3. This supplier's Datanorm, found by a number we hold ───────────
    # Weaker than the EAN and treated as such: a match is discarded when the
    # catalogue row carries an EAN that contradicts ours (see `_contradicts`).
    row, others = _catalog_row_by_number(ctx, ref, article, eans)
    if row is not None:
        written = _record(ctx, article, row, eans)
        return _resolved(
            ref,
            article,
            _clean(row.article_no),
            "catalog_article_no",
            catalog_item_id=row.id,
            ambiguous=others,
            backfilled=written,
        )

    # ── 4. Extension point: ask the supplier ─────────────────────────────
    # Reached only once every local answer has failed. Nothing ships an
    # implementation; see the module docstring.
    if ctx.lookup is not None:
        found = _clean(
            ctx.lookup.find_supplier_article_no(
                supplier_id=ctx.supplier_id,
                ean=eans[0] if eans else None,
                description=ref.description,
            )
        )
        if found:
            written = _remember_supplier_article_no(ctx, article, found, catalog_item_id=None)
            return _resolved(
                ref, article, found, "supplier_lookup", backfilled=written
            )

    # ── 5. Unresolved ────────────────────────────────────────────────────
    # Returned, not raised and not dropped. `ids_cart_builder` omits the
    # position (ArtNo is mandatory, so an empty one would invalidate the whole
    # document and cost the buyer the entire cart), and the caller surfaces
    # this row so the omission is visible.
    return _resolved(ref, article, None, "unresolved")


def _resolved(
    ref: OrderLineRef,
    article: WerkstattArticle | None,
    supplier_article_no: str | None,
    matched_by: MatchedBy,
    *,
    catalog_item_id: int | None = None,
    ambiguous: int = 0,
    backfilled: tuple[str, ...] = (),
) -> Resolution:
    """Assemble the answer, filling identification from the article we loaded."""

    return Resolution(
        position=ref.position,
        supplier_article_no=supplier_article_no,
        matched_by=matched_by,
        article_id=ref.article_id,
        article_number=ref.article_number or (article.article_number if article else None),
        description=ref.description or (article.item_name if article else None),
        ean=_clean(ref.ean) or (_clean(article.ean) if article else None),
        catalog_item_id=catalog_item_id,
        ambiguous_alternatives=ambiguous,
        backfilled=backfilled,
    )


# ──────────────────────────────────────────────────────────────────────────
# Catalogue lookups
# ──────────────────────────────────────────────────────────────────────────


def _catalog_row_by_ean(
    ctx: _Ctx, eans: tuple[str, ...]
) -> tuple[MaterialCatalogItem | None, int]:
    """This supplier's Datanorm row for any EAN we hold, plus how many others
    matched.

    Rows with no article number are excluded in SQL rather than filtered after,
    so a blank-numbered row cannot mask a usable sibling.
    """

    if not eans:
        return None, 0
    variants = _ean_variants(eans)
    if not variants:
        return None, 0
    rows = list(
        ctx.db.scalars(
            select(MaterialCatalogItem)
            .where(
                MaterialCatalogItem.supplier_id == ctx.supplier_id,
                MaterialCatalogItem.ean.in_(variants),
                MaterialCatalogItem.article_no.is_not(None),
                MaterialCatalogItem.article_no != "",
            )
            .order_by(MaterialCatalogItem.article_no.asc(), MaterialCatalogItem.id.asc())
        ).all()
    )
    if not rows:
        return None, 0
    return rows[0], len(rows) - 1


def _catalog_row_by_number(
    ctx: _Ctx,
    ref: OrderLineRef,
    article: WerkstattArticle | None,
    eans: tuple[str, ...],
) -> tuple[MaterialCatalogItem | None, int]:
    """This supplier's Datanorm row for a number we already hold.

    Candidates, each worth one slot in a single indexed IN clause: the Datanorm
    row this article came from (usually another supplier's, whose number is
    often the manufacturer's own and reappears unchanged elsewhere); what our
    other suppliers call it; and our own ``SP-`` number, which practically never
    hits but rides along free and is all a workshop that adopted its
    wholesaler's numbering would have.

    Every hit is then checked against the EANs we hold: a row whose EAN
    contradicts ours is a *different product* sharing a number, which is exactly
    how cross-supplier number reuse orders the wrong thing.
    """

    candidates = _number_candidates(ctx, ref, article)
    if not candidates:
        return None, 0
    rows = list(
        ctx.db.scalars(
            select(MaterialCatalogItem)
            .where(
                MaterialCatalogItem.supplier_id == ctx.supplier_id,
                MaterialCatalogItem.article_no.in_(candidates),
            )
            .order_by(MaterialCatalogItem.article_no.asc(), MaterialCatalogItem.id.asc())
        ).all()
    )
    usable = [row for row in rows if _clean(row.article_no) and not _contradicts(row, eans)]
    if not usable:
        return None, 0
    return usable[0], len(usable) - 1


def _number_candidates(
    ctx: _Ctx, ref: OrderLineRef, article: WerkstattArticle | None
) -> tuple[str, ...]:
    """Numbers we hold that are worth trying against this supplier's catalogue."""

    found: list[str] = []

    def offer(value: str | None) -> None:
        text = _clean(value)
        if text and text not in found:
            found.append(text)

    if article is not None:
        if article.source_catalog_item_id is not None:
            source = ctx.db.get(MaterialCatalogItem, article.source_catalog_item_id)
            if source is not None:
                offer(source.article_no)
        for other in ctx.db.scalars(
            select(WerkstattArticleSupplier)
            .where(
                WerkstattArticleSupplier.article_id == article.id,
                WerkstattArticleSupplier.supplier_id != ctx.supplier_id,
            )
            .order_by(WerkstattArticleSupplier.id.asc())
        ).all():
            offer(other.supplier_article_no)
        offer(article.article_number)

    offer(ref.article_number)
    return tuple(found)


def _contradicts(row: MaterialCatalogItem, eans: tuple[str, ...]) -> bool:
    """True when the catalogue row is provably a different product.

    Only when both sides carry an EAN. Silence is not disagreement: most of a
    workshop's articles have no EAN at all, and refusing every such match would
    make step 3 useless for exactly the lines that need it most.
    """

    row_ean = _clean(row.ean)
    if not row_ean or not eans:
        return False
    known = {identifier_key(value).lstrip("0") for value in eans}
    return identifier_key(row_ean).lstrip("0") not in known


# ──────────────────────────────────────────────────────────────────────────
# Backfill — the point of doing this once
# ──────────────────────────────────────────────────────────────────────────


def _record(
    ctx: _Ctx,
    article: WerkstattArticle | None,
    row: MaterialCatalogItem,
    eans: tuple[str, ...],
) -> tuple[str, ...]:
    """Write what the catalogue just taught us back onto our own records.

    Two directions, both idempotent and both strictly fill-if-empty: the
    supplier's number onto ``werkstatt_article_suppliers``, so the next order
    resolves at step 1 without touching the 1 M-row catalogue; and the
    catalogue's EAN onto ``werkstatt_articles.ean`` when we had none, so the
    next *scan* of the box resolves to this article at all.

    An existing non-empty value is never overwritten — it is hand-curated or
    snapshotted from a real order, and a Datanorm import does not outrank it.

    The whole write sits in a savepoint: a failed backfill must cost nothing,
    because the cart is the job and the buyer is standing in front of it.
    """

    if not ctx.backfill or article is None:
        return ()
    try:
        with ctx.db.begin_nested():
            written = list(
                _remember_supplier_article_no(
                    ctx,
                    article,
                    _clean(row.article_no),
                    catalog_item_id=row.id,
                    inside_savepoint=True,
                )
            )
            if _remember_ean(ctx, article, _clean(row.ean), eans):
                written.append("article.ean")
            return tuple(written)
    except SQLAlchemyError:
        # Deliberately swallowed and reported as "nothing was written". The
        # resolution itself still stands — it was read from the catalogue, not
        # from anything this block writes.
        return ()


def _remember_supplier_article_no(
    ctx: _Ctx,
    article: WerkstattArticle | None,
    supplier_article_no: str | None,
    *,
    catalog_item_id: int | None,
    inside_savepoint: bool = False,
) -> tuple[str, ...]:
    """Create or complete the article↔supplier link. Never overwrites."""

    if not ctx.backfill or article is None or not supplier_article_no:
        return ()

    def write() -> tuple[str, ...]:
        link = ctx.db.scalar(
            select(WerkstattArticleSupplier).where(
                WerkstattArticleSupplier.article_id == article.id,
                WerkstattArticleSupplier.supplier_id == ctx.supplier_id,
            )
        )
        if link is None:
            # First supplier on an article becomes the preferred one, matching
            # `werkstatt_article_dedup.link_catalog_duplicates`, so the reorder
            # flow always has somewhere to send the order.
            has_any = ctx.db.scalar(
                select(WerkstattArticleSupplier.id).where(
                    WerkstattArticleSupplier.article_id == article.id
                )
            )
            ctx.db.add(
                WerkstattArticleSupplier(
                    article_id=article.id,
                    supplier_id=ctx.supplier_id,
                    supplier_article_no=supplier_article_no,
                    source_catalog_item_id=catalog_item_id,
                    is_preferred=has_any is None,
                )
            )
            ctx.db.flush()
            return ("article_supplier.created",)

        written: list[str] = []
        if not _clean(link.supplier_article_no):
            link.supplier_article_no = supplier_article_no
            written.append("article_supplier.supplier_article_no")
        if link.source_catalog_item_id is None and catalog_item_id is not None:
            link.source_catalog_item_id = catalog_item_id
            written.append("article_supplier.source_catalog_item_id")
        if written:
            ctx.db.add(link)
            ctx.db.flush()
        return tuple(written)

    if inside_savepoint:
        return write()
    try:
        with ctx.db.begin_nested():
            return write()
    except SQLAlchemyError:
        return ()


def _remember_ean(
    ctx: _Ctx,
    article: WerkstattArticle,
    catalog_ean: str | None,
    eans: tuple[str, ...],
) -> bool:
    """Fill in ``WerkstattArticle.ean`` from the catalogue when we had none.

    ``ean`` is partial-unique WHERE NOT NULL (migration 0047), so the value is
    checked against every other article first. Without the pre-check a collision
    would raise on ``flush`` and roll back the whole savepoint, losing the
    supplier-number half of the backfill with it.
    """

    if not catalog_ean or _clean(article.ean):
        return False
    if eans and identifier_key(catalog_ean).lstrip("0") not in {
        identifier_key(value).lstrip("0") for value in eans
    }:
        # The line said one thing and the catalogue another. Writing either
        # onto the article would be a guess; leave it for a human.
        return False
    taken = ctx.db.scalar(
        select(WerkstattArticle.id).where(
            WerkstattArticle.ean == catalog_ean,
            WerkstattArticle.id != article.id,
        )
    )
    if taken is not None:
        return False
    article.ean = catalog_ean
    ctx.db.add(article)
    ctx.db.flush()
    return True


# ──────────────────────────────────────────────────────────────────────────
# Small helpers
# ──────────────────────────────────────────────────────────────────────────


def _clean(value: str | None) -> str | None:
    text = (value or "").strip()
    return text or None


def _supplier_has_catalog(db: Session, supplier_id: int) -> bool:
    """Has this supplier's Datanorm ever been imported?

    Without one, there is nothing to check a suspicious-looking article number
    against, so the line's own snapshot is accepted unconditionally. A supplier
    we know nothing about must not be a reason to drop lines.
    """

    return (
        db.scalar(
            select(MaterialCatalogItem.id)
            .where(MaterialCatalogItem.supplier_id == supplier_id)
            .limit(1)
        )
        is not None
    )


def _ean_candidates(
    ref: OrderLineRef, article: WerkstattArticle | None
) -> tuple[str, ...]:
    """Every EAN this line could be identified by, best first.

    The line's snapshot leads — it is what was scanned for THIS order — then the
    stocked article's. A GTIN-shaped ``supplier_article_no`` comes last: a
    scanner filling the article-number field is the reported bug, and the value
    is still a perfectly good EAN.
    """

    found: list[str] = []
    for value in (
        _clean(ref.ean),
        _clean(article.ean) if article is not None else None,
        _gtin_shaped(_clean(ref.supplier_article_no)),
    ):
        if value and value not in found:
            found.append(value)
    return tuple(found)


def _gtin_shaped(value: str | None) -> str | None:
    if value and value.isdigit() and len(value) in _GTIN_LENGTHS:
        return value
    return None


def _ean_variants(eans: Sequence[str]) -> tuple[str, ...]:
    """Spellings of an EAN worth matching in the catalogue.

    Datanorm files disagree about leading zeros — the same GTIN appears as
    ``4012345678901``, ``04012345678901`` (GTIN-14) and occasionally stripped.
    A bounded set of variants in one indexed IN clause costs nothing and is the
    difference between a hit and a dropped line.
    """

    found: list[str] = []
    for ean in eans:
        digits = "".join(char for char in ean if char.isdigit())
        if not digits:
            continue
        bare = digits.lstrip("0") or digits
        for variant in (digits, bare, bare.zfill(13), bare.zfill(14)):
            if variant and variant not in found:
                found.append(variant)
    return tuple(found)


def _snapshot_is_really_a_barcode(
    ctx: _Ctx, snapshot: str, eans: tuple[str, ...]
) -> bool:
    """Is this "article number" actually the barcode somebody scanned?

    Two ways to tell, cheapest first: it repeats an EAN the line already carries
    (no query, no doubt); or it is GTIN-13/14 shaped and this supplier's
    imported Datanorm does not list it as an article number.

    The second is the one that bites — the buyer scans a box, the code lands in
    the article-number field, nothing else on the line records the EAN, and the
    position vanishes from the basket without a word. One indexed lookup, paid
    only for GTIN-shaped values, turns that into a hit at step 2.

    With no Datanorm for this supplier we cannot check, so we do not doubt:
    dropping a line on suspicion is worse than sending a number the shop
    rejects visibly.
    """

    key = identifier_key(snapshot).lstrip("0")
    if key and any(identifier_key(value).lstrip("0") == key for value in eans if value != snapshot):
        return True
    if not _gtin_shaped(snapshot) or not ctx.supplier_has_catalog:
        return False
    known = ctx.db.scalar(
        select(MaterialCatalogItem.id)
        .where(
            MaterialCatalogItem.supplier_id == ctx.supplier_id,
            MaterialCatalogItem.article_no == snapshot,
        )
        .limit(1)
    )
    return known is None
