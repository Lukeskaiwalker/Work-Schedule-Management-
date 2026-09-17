"""What is this code? — the cascade behind "Neuer Artikel" and Wareneingang.

``resolve_scan`` answers "which of OUR rows is this", which is the right
question for a scanner pointed at a shelf. It is the wrong question for
somebody holding a product SMPL has never seen: the honest answer there is
"nothing", and until now that was where the trail ended — a dead end in the
create dialog and a dead end on the wall screen, both leaving a person to type
nine fields or give up.

This module extends the cascade by one step. Ours first, always:

1. **existing** — an article, a machine label or a nameplate serial. Stop.
   Creating a second row for something already stocked is the duplicate this
   whole feature is meant to stop making.
2. **catalog** — a Datanorm row from a supplier we buy from. Their identity,
   their article number, their EAN: better than anything a scrape can offer,
   and it comes with a supplier link for free.
3. **external** — the public webshop (and, when configured, a GTIN database).
   A *suggestion*, never a fact: shown to a human who can correct it.
4. **none** — nothing anywhere. Said plainly, with why.

Two properties the callers depend on:

**A merged duplicate resolves to its survivor.** Old labels stay valid; see
``werkstatt_scan._follow_merge``.

**An external miss is as cacheable as a hit.** The rack scans the same unknown
code once per delivery, and without the cached miss each of those is a fresh
scrape inside a request handler on a two-worker container.
"""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import and_, delete, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import (
    WerkstattArticle,
    WerkstattEanLookup,
)
from app.schemas.werkstatt import (
    MaterialCatalogItemLiteOut,
    WerkstattArticleLookupCatalog,
    WerkstattArticleLookupExisting,
    WerkstattArticleLookupExternal,
    WerkstattArticleLookupNone,
    WerkstattArticleLookupOut,
    WerkstattCatalogGroupOut,
    WerkstattExternalHitOut,
)
from app.services import gtin
from app.services.ean_lookup import EanLookupHit, external_lookup_enabled, lookup_external
from app.services.werkstatt_scan import _article_out, resolve_scan

# A product's name does not change; a month is a conservative reading of that.
HIT_TTL = timedelta(days=30)
# A miss can be undone at any moment by the shop adding the article, so it is
# only allowed to suppress the retries that happen while one delivery is being
# unpacked — not tomorrow's.
MISS_TTL = timedelta(hours=24)


def lookup_code(
    db: Session,
    code: str,
    *,
    allow_external: bool = True,
) -> WerkstattArticleLookupOut:
    """Resolve *code* against our rows, then the catalogue, then the world.

    Never raises for a code it cannot place: ``none`` is a first-class answer,
    and every caller has something useful to do with it (offer an empty form,
    offer a keyboard, or say so on a wall screen).

    Does not commit. A cache row may be flushed; the caller owns the
    transaction, because the station path creates an article in the same one.
    """
    raw = gtin.normalize(code)
    if not raw:
        return WerkstattArticleLookupNone(code=code or "", external_skipped="not_a_gtin")

    own = _lookup_ours(db, raw)
    if own is not None:
        return own

    if not allow_external:
        # NOT "disabled": the caller asked for a cheap internal answer (the
        # scan handler on the Bestand page runs on every scan). Telling the
        # workshop "Die Webshop-Suche ist abgeschaltet" would send somebody to
        # edit .env over a decision this process made one line ago.
        return WerkstattArticleLookupNone(code=raw, external_skipped="not_requested")
    if not gtin.is_gtin(raw):
        # Not a barcode: an SP number typed with a typo, a crate code, a
        # nameplate serial. No product database can answer it, so asking is
        # a round trip spent to learn what arithmetic already knew.
        return WerkstattArticleLookupNone(code=raw, external_skipped="not_a_gtin")
    if not external_lookup_enabled():
        return WerkstattArticleLookupNone(code=raw, external_skipped="disabled")

    hit = _external_with_cache(db, raw)
    if hit is None:
        return WerkstattArticleLookupNone(code=raw)
    return WerkstattArticleLookupExternal(code=raw, hit=hit)


# ──────────────────────────────────────────────────────────────────────────
# Our own rows and the wholesaler's catalogue
# ──────────────────────────────────────────────────────────────────────────


def _lookup_ours(
    db: Session, code: str
) -> WerkstattArticleLookupExisting | WerkstattArticleLookupCatalog | None:
    """``resolve_scan`` over every spelling of the code — our shelf first.

    The variants exist because the same product is written down differently by
    the scanner, the Datanorm and whoever typed the row: a UPC-A off an
    imported tool, its zero-padded EAN-13 twin from the wholesaler's file. One
    of them is on the shelf; which one is not the operator's problem.

    Two passes, not one. ``resolve_scan`` runs its own cascade per code, so
    walking the variants and taking the first non-empty answer means a
    CATALOGUE match on the scanned spelling beats an ARTICLE match on another
    spelling — and the dialog then offers to create something already stocked,
    which is the duplicate this whole feature exists to stop making. "Ours
    first, always" has to hold across the variants, not only inside one.
    """
    variants = gtin.variants(code)

    for variant in variants:
        resolved = resolve_scan(db, variant)
        if resolved.kind == "werkstatt_article":
            return WerkstattArticleLookupExisting(
                code=code,
                article=resolved.article,
                matched_by=resolved.matched_by,
                via_merged_article_number=_merged_from(db, variant, resolved.article.id),
            )
        if resolved.kind == "machine":
            article = db.get(WerkstattArticle, resolved.machine.article_id)
            if article is None:
                continue
            return WerkstattArticleLookupExisting(
                code=code,
                article=_article_out(db, article),
                matched_by=resolved.matched_by,
                machine_number=resolved.machine.unit_number,
            )

    for variant in variants:
        resolved = resolve_scan(db, variant)
        if resolved.kind == "catalog_match":
            return WerkstattArticleLookupCatalog(
                code=code,
                groups=_group_catalog(resolved.catalog_items),
                matched_by=resolved.matched_by,
            )
    return None


def _merged_from(db: Session, code: str, survivor_id: int) -> str | None:
    """The article number of the merged row this code is printed on, if any.

    Only asked once a hit is in hand, and only for the exact spelling that
    hit, so the cost is one indexed lookup on a path that already did several.
    The answer is what lets the dialog say "SP-0012 wurde nach SP-0007
    zusammengeführt" instead of showing a number that is not on the sticker.
    """
    merged = db.scalars(
        select(WerkstattArticle).where(
            WerkstattArticle.merged_into_id == survivor_id,
            WerkstattArticle.id != survivor_id,
        )
    ).all()
    for row in merged:
        if code in {row.article_number, row.internal_code, row.ean}:
            return row.article_number
    # A supplier number or an EAN carried over by the merge resolves through
    # the survivor's own columns, which is indistinguishable from a normal hit
    # and needs no explanation.
    return None


def _group_catalog(rows: list[MaterialCatalogItemLiteOut]) -> list[WerkstattCatalogGroupOut]:
    """Fold catalogue rows by EAN — one product, several suppliers.

    Same shape ``GET /werkstatt/catalog/search`` returns, so the picker in the
    create dialog renders a scanned hit and a typed search with one component.
    """
    groups: list[WerkstattCatalogGroupOut] = []
    by_ean: dict[str, WerkstattCatalogGroupOut] = {}
    for row in rows:
        key = (row.ean or "").strip()
        if key and key in by_ean:
            by_ean[key].suppliers.append(row)
            continue
        group = WerkstattCatalogGroupOut(ean=key or None, hero=row, suppliers=[row])
        groups.append(group)
        if key:
            by_ean[key] = group
    return groups


# ──────────────────────────────────────────────────────────────────────────
# The world outside, with its answers remembered
# ──────────────────────────────────────────────────────────────────────────


def _external_with_cache(db: Session, code: str) -> WerkstattExternalHitOut | None:
    key = gtin.to_ean13(code) or gtin.digits_only(code)
    if not key:
        return None

    cached = db.get(WerkstattEanLookup, key)
    now = utcnow()
    if cached is not None and not _cache_expired(cached, now):
        if cached.miss:
            return None
        return WerkstattExternalHitOut(
            item_name=cached.item_name or "",
            ean=key,
            manufacturer=cached.manufacturer,
            unit=cached.unit,
            image_url=cached.image_url,
            source=cached.provider or "cache",
            source_url=cached.source_url,
            fetched_at=cached.fetched_at,
        )

    hit = lookup_external(code)
    row = _store_cache(db, key, hit, row=cached, now=now)
    if hit is None:
        return None
    return WerkstattExternalHitOut(
        item_name=hit.item_name,
        ean=key,
        manufacturer=hit.manufacturer,
        unit=hit.unit,
        image_url=hit.image_url,
        source=hit.source,
        source_url=hit.source_url,
        fetched_at=row.fetched_at,
    )


def _cache_expired(row: WerkstattEanLookup, now) -> bool:
    age = now - row.fetched_at
    return age > (MISS_TTL if row.miss else HIT_TTL)


def _prune_expired_cache(db: Session, now) -> None:
    """Drop rows nothing will ever read again, on the way past.

    Every GTIN-shaped code that reaches the external step writes a row, hit or
    miss, and the endpoint needs no manage permission — so a camera left
    pointing at a shelf of barcodes, or a client walking valid check digits,
    grows this table for ever inside the database the backups carry. Expired
    rows are re-fetched on their next read anyway, so deleting them costs
    nothing and bounds the table at what is actually in use.

    Only on an INSERT: refreshing an existing row is the common path (the same
    delivery scanned twice) and must stay a single UPDATE.
    """
    db.execute(
        delete(WerkstattEanLookup).where(
            or_(
                and_(
                    WerkstattEanLookup.miss.is_(True),
                    WerkstattEanLookup.fetched_at < now - MISS_TTL,
                ),
                and_(
                    WerkstattEanLookup.miss.is_(False),
                    WerkstattEanLookup.fetched_at < now - HIT_TTL,
                ),
            )
        )
    )


def _store_cache(
    db: Session,
    key: str,
    hit: EanLookupHit | None,
    *,
    row: WerkstattEanLookup | None,
    now,
) -> WerkstattEanLookup:
    """Write what we just learned, including that we learned nothing.

    Inside a SAVEPOINT because two people can scan the same unknown code at
    the same moment — the rack and the desk, during the same delivery — and
    both would try to INSERT the same primary key. Losing that race is not an
    error worth failing a lookup over (the other request wrote the same facts),
    but an unhandled IntegrityError would roll back the WHOLE transaction,
    which on the station path is an article and its intake movement.
    """
    if row is None:
        row = WerkstattEanLookup(ean=key)
        _prune_expired_cache(db, now)
    row.provider = hit.source if hit else None
    row.miss = hit is None
    row.item_name = hit.item_name if hit else None
    row.manufacturer = hit.manufacturer if hit else None
    row.unit = hit.unit if hit else None
    row.image_url = hit.image_url if hit else None
    row.source_url = hit.source_url if hit else None
    row.fetched_at = now
    try:
        with db.begin_nested():
            db.add(row)
            db.flush()
    except IntegrityError:
        # Somebody else cached it first. Their row says the same thing.
        existing = db.get(WerkstattEanLookup, key)
        if existing is not None:
            return existing
    return row


# ──────────────────────────────────────────────────────────────────────────
# Turning a suggestion into a row
# ──────────────────────────────────────────────────────────────────────────


def external_hit_note(hit_source: str) -> str:
    """The German sentence stamped on an article born from a suggestion.

    On the row rather than in a log, because the question it answers — "who
    decided this thing is called that?" — is asked months later by somebody
    looking at the article, not at a log file.
    """
    return f"Angelegt per EAN-Suche ({hit_source})"


def build_article_from_external_hit(
    db: Session,
    *,
    hit: WerkstattExternalHitOut,
    user_id: int,
    stock_min: int = 0,
    category_id: int | None = None,
    location_id: int | None = None,
    notes: str | None = None,
) -> WerkstattArticle:
    """Create a consumable from a scraped suggestion. No commit, no stock.

    Mirrors ``build_article_from_catalog_item``: it does not commit (the
    station stamps ``station_id`` on the opening movement in the same
    transaction) and it does not book the opening quantity — the caller
    decides what arrived.

    Never serialized. A machine is a thing with its own label, its own
    inspection dates and its own history; nothing a webshop can tell us
    justifies creating one, and the wrong answer here would silently put a
    tool type into the consumables list.
    """
    from app.services.werkstatt_article_numbers import next_article_number

    combined = "\n".join(part for part in (notes, external_hit_note(hit.source)) if part)
    article = WerkstattArticle(
        article_number=next_article_number(db),
        ean=hit.ean,
        item_name=hit.item_name,
        manufacturer=hit.manufacturer,
        category_id=category_id,
        location_id=location_id,
        unit=hit.unit,
        image_url=hit.image_url,
        image_source="external" if hit.image_url else None,
        image_checked_at=utcnow() if hit.image_url else None,
        # Counters start at zero and are derived from the ledger; an opening
        # quantity is booked as a movement by the caller. Setting them here
        # would be undone by the first recompute.
        stock_total=0,
        stock_available=0,
        stock_out=0,
        stock_repair=0,
        stock_min=stock_min,
        is_serialized=False,
        currency="EUR",
        notes=combined or None,
        created_by=user_id,
    )
    db.add(article)
    db.flush()
    return article
