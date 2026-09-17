"""One search across stocked articles AND the Datanorm catalog.

Lifted out of ``routers/workflow_werkstatt_boxes.py`` unchanged: it is the
longest thing in that router by a wide margin, it is pure query-and-rank with
no HTTP in it, and the router had grown past the point where the packing rules
at the top could be found. The endpoint is now four lines that call this.

Identifier coverage matches the documented scan cascade
(``services/werkstatt_scan.py`` / WERKSTATT_CONTRACT.md §3.1): our own
SP-number, the EAN, and — importantly for scanning — the SUPPLIER's own
article number from ``werkstatt_article_suppliers``. A wholesaler like
Unielektro labels goods with their number, not ours, so without that join a
scan of their barcode would find nothing even though we stock the article.

Results are ranked EXACT-IDENTIFIER FIRST. That ordering is load-bearing: the
scanner auto-adds only an unambiguous exact hit, and a plain alphabetical
order could otherwise put an unrelated substring match on top and drop the
wrong article into a crate.

Stocked articles rank above catalog-only rows within the same match quality —
those are things actually in the van. Catalog matching deliberately goes
through the Werkstatt-scoped query rather than ``search_material_catalog``,
because that helper triggers a filesystem re-import which DELETES and rebuilds
``material_catalog_items`` — a read path must never wipe Datanorm imports.
"""
from __future__ import annotations

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.models.entities import (
    WerkstattArticle,
    WerkstattArticleSupplier,
    WerkstattSupplier,
)
from app.schemas.werkstatt_boxes import WerkstattItemSearchHit
from app.services.search_matching import (
    identifier_key,
    similarity_score,
    supports_trigram,
    token_matches_any,
    tokenize,
)


def search_box_items(
    db: Session, *, q: str, limit: int, include_catalog: bool
) -> list[WerkstattItemSearchHit]:
    """Rank what the packer just typed or scanned. See the module docstring."""
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
