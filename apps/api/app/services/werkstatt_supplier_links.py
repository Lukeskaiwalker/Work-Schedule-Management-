"""Writing what a supplier calls an article — and refusing it readably.

The supplier's own article number lives in exactly one place,
``werkstatt_article_suppliers.supplier_article_no``. Every search and scan
path reads it from there, so a path that knows the number and does not write
the link leaves an article nobody can find by the number on its box. "Mit
Katalog verknüpfen" was such a path: it pointed the article at a Datanorm row
and copied EAN, manufacturer and unit, but not the one number the wholesaler
prints.

``(supplier_id, supplier_article_no)`` is unique. Writing a number another
article already carries used to surface as a 500 from the database; it is a
duplicate article, and the person needs to be told WHICH one.
"""

from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import (
    MaterialCatalogItem,
    WerkstattArticle,
    WerkstattArticleSupplier,
    WerkstattSupplier,
)
from app.services import gtin
from app.services.werkstatt_article_dedup import link_catalog_duplicates
from app.services.werkstatt_article_search import identifier_search_key

logger = logging.getLogger(__name__)


class CatalogLinkRefused(ValueError):
    """Linking would give this article an identity another article owns.

    The message is German and safe to show.
    """


def clean_supplier_number(value: str | None) -> str | None:
    """Trimmed, or None for blank. The scan cascade compares the stripped
    scan against the stored value, so a stored ``"4711 "`` never matched."""
    return (value or "").strip() or None


def supplier_number_holder(
    db: Session, *, supplier_id: int, number: str | None, article_id: int
) -> WerkstattArticle | None:
    """The OTHER article that already carries *number* for this supplier."""
    if not number:
        return None
    return db.scalar(
        select(WerkstattArticle)
        .join(WerkstattArticleSupplier, WerkstattArticleSupplier.article_id == WerkstattArticle.id)
        .where(
            WerkstattArticleSupplier.supplier_id == supplier_id,
            WerkstattArticleSupplier.supplier_article_no == number,
            WerkstattArticleSupplier.article_id != article_id,
        )
    )


def supplier_number_clash_detail(holder: WerkstattArticle, *, supplier_name: str, number: str) -> str:
    """Why the number cannot go on this article, and where it already is."""
    if bool(holder.is_archived):
        return (
            f"Die Artikelnummer {number} von {supplier_name} gehört zum archivierten Artikel "
            f"{holder.article_number} „{holder.item_name}“ — dort reaktivieren oder die "
            "Nummer dort entfernen."
        )
    return (
        f"Die Artikelnummer {number} von {supplier_name} gehört bereits zu "
        f"{holder.article_number} „{holder.item_name}“ — diesen Artikel verwenden oder "
        "die beiden zusammenführen."
    )


def ean_clash_detail(clash: WerkstattArticle) -> str:
    """Why this EAN cannot be used, and what to do instead — in German.

    "EAN already in use by another article" is true and useless: the person is
    holding the product and has no way to find the row that already has it.
    Naming it turns a dead end into two clicks, and an ARCHIVED clash gets a
    different sentence because the fix is different — the row is there, it just
    has to be brought back rather than found.
    """
    if bool(clash.is_archived):
        return (
            f"Diese EAN gehört zum archivierten Artikel {clash.article_number} "
            f"„{clash.item_name}“ — bitte dort „Reaktivieren“ statt neu anlegen."
        )
    return (
        f"Diese EAN gehört bereits zu {clash.article_number} „{clash.item_name}“ — "
        "dort den Bestand anpassen."
    )


# ──────────────────────────────────────────────────────────────────────────
# "Mit Katalog verknüpfen"
# ──────────────────────────────────────────────────────────────────────────


def link_catalog_item(
    db: Session, article: WerkstattArticle, catalog_item: MaterialCatalogItem
) -> None:
    """Point *article* at a Datanorm row and record what that supplier calls it.

    No commit. Checks first, writes second: a refusal leaves nothing behind.

    1. ``source_catalog_item_id`` and the non-destructive backfill of EAN,
       manufacturer, unit and image (unchanged from before).
    2. The supplier link for the row's own supplier, upserted on the pair —
       see :func:`_upsert_catalog_link`. A row without a supplier (a
       filesystem import) has nobody to link and links nothing.
    3. The other suppliers' Datanorm rows with the same EAN, folded on as
       their links (``link_catalog_duplicates``), as creating from the
       catalogue already does.
    """
    supplier = (
        db.get(WerkstattSupplier, catalog_item.supplier_id)
        if catalog_item.supplier_id is not None
        else None
    )
    number = clean_supplier_number(catalog_item.article_no)
    if supplier is not None and number:
        holder = supplier_number_holder(
            db, supplier_id=supplier.id, number=number, article_id=article.id
        )
        if holder is not None:
            raise CatalogLinkRefused(
                supplier_number_clash_detail(holder, supplier_name=supplier.name, number=number)
            )
    ean = (catalog_item.ean or "").strip()
    if ean and not article.ean:
        # Every spelling, as article creation checks it: the row describes a
        # product somebody already stocked under that EAN, and this article
        # is its duplicate. Committing would trip the unique index anyway.
        clash = db.scalar(
            select(WerkstattArticle).where(
                WerkstattArticle.ean.in_(gtin.variants(ean)),
                WerkstattArticle.id != article.id,
            )
        )
        if clash is not None:
            raise CatalogLinkRefused(ean_clash_detail(clash))
        article.ean = ean

    article.source_catalog_item_id = catalog_item.id
    if not article.manufacturer and catalog_item.manufacturer:
        article.manufacturer = catalog_item.manufacturer
    if not article.unit and catalog_item.unit:
        article.unit = catalog_item.unit
    if not article.image_url and catalog_item.image_url:
        article.image_url = catalog_item.image_url
        article.image_source = "catalog"
        article.image_checked_at = utcnow()
    article.updated_at = utcnow()
    db.add(article)
    db.flush()

    if supplier is not None:
        _upsert_catalog_link(db, article, catalog_item, supplier_id=supplier.id, number=number)
    fold_same_ean_rows(db, article)


def _upsert_catalog_link(
    db: Session,
    article: WerkstattArticle,
    catalog_item: MaterialCatalogItem,
    *,
    supplier_id: int,
    number: str | None,
) -> None:
    """Create the link, or write the catalogue's number onto the existing one.

    A new link is preferred only when the article has no preferred link yet —
    the person's choice of whom to order from is not ours to change. An
    existing link adopts the catalogue's number (the person just said this
    Datanorm row IS this article); a genuinely different number it carried
    before is kept in the link's notes, the way a merge keeps one, so an
    order clerk can still find it.
    """
    link = db.scalar(
        select(WerkstattArticleSupplier).where(
            WerkstattArticleSupplier.article_id == article.id,
            WerkstattArticleSupplier.supplier_id == supplier_id,
        )
    )
    if link is None:
        has_preferred = db.scalar(
            select(WerkstattArticleSupplier.id).where(
                WerkstattArticleSupplier.article_id == article.id,
                WerkstattArticleSupplier.is_preferred.is_(True),
            )
        )
        db.add(
            WerkstattArticleSupplier(
                article_id=article.id,
                supplier_id=supplier_id,
                supplier_article_no=number,
                source_catalog_item_id=catalog_item.id,
                is_preferred=has_preferred is None,
            )
        )
        db.flush()
        return

    previous = clean_supplier_number(link.supplier_article_no)
    if number and previous and identifier_search_key(previous) != identifier_search_key(number):
        note = f"Frühere Artikelnummer bei diesem Lieferanten: {previous}"
        if note not in (link.notes or ""):
            link.notes = "\n".join(part for part in ((link.notes or "").strip(), note) if part)
    if number:
        link.supplier_article_no = number
    link.source_catalog_item_id = catalog_item.id
    link.updated_at = utcnow()
    db.add(link)
    db.flush()


def fold_same_ean_rows(db: Session, article: WerkstattArticle) -> None:
    """``link_catalog_duplicates`` inside a savepoint. No commit.

    It writes each same-EAN row's number as a new link, and one of those
    numbers can already sit on a third article (a duplicate created by hand
    without the EAN). That is the duplicate screen's problem, not a reason to
    fail what the person asked for — linking an article to the catalogue, or
    creating one from it at the desk or at the rack — so the fold is dropped
    as a whole and the reason logged.
    """
    try:
        with db.begin_nested():
            link_catalog_duplicates(db, article)
    except IntegrityError:
        logger.warning(
            "catalog fold: same-EAN fold skipped for article %s (ean %s): a supplier "
            "number is already linked to another article",
            article.id,
            article.ean,
            exc_info=True,
        )
