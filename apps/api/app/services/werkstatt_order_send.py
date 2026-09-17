"""What leaves the building, decided once.

Three endpoints send an order somewhere — the IDS hand-over, the CSV /
clipboard export and the reorder auto-send — and every one of them has to
answer the same two questions first: what does THIS supplier call each line,
and is every line expressible under the supplier's identifier policy? This
module answers them in one place so the drawer's preview, the 409 that blocks
a send and the document that finally goes out cannot disagree.

`prepare_order_for_send` runs the resolver (`ids_ean_resolver`) and the wire
policy (`ids_cart_builder.wire_identity`) over an order. `require_resolved`
turns an unexpressible line into the 409 the buyer clicks through with
"Trotzdem übergeben". `describe_resolution` is the read-only preview the
drawer shows as per-line badges.

Backfill is the caller's choice: the preview reads with ``backfill=False`` so
opening an order never writes a link; the send paths keep it on, as before.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import MaterialCatalogItem, WerkstattOrder, WerkstattSupplier
from app.routers._werkstatt_tablet_shared import load_order_full
from app.schemas.werkstatt import WerkstattOrderOut
from app.schemas.werkstatt_procurement import (
    OrderLineResolutionOut,
    OrderResolutionAlternativeOut,
    OrderResolutionOut,
)
from app.services.ids_cart_builder import (
    CartItem,
    OrderIdentifier,
    WireIdentity,
    cart_items_for_order_lines,
    wire_identity,
)
from app.services.ids_ean_resolver import Resolution, ResolutionReport

# How many "n weitere Treffer" rows the preview lists per line. Pack sizes
# and variants rarely run past a handful; a longer list is a search, not a
# choice.
ALTERNATIVES_LIMIT = 5

UNRESOLVED_CODE = "unresolved_lines"


@dataclass(frozen=True)
class SendPreparation:
    """Everything a send path needs about one order, computed once."""

    order: WerkstattOrder
    supplier: WerkstattSupplier
    identifier: OrderIdentifier
    channel: str
    full: WerkstattOrderOut
    items: list[CartItem]
    report: ResolutionReport
    identities: tuple[WireIdentity, ...]

    @property
    def unresolved_positions(self) -> tuple[int, ...]:
        """1-based positions the wire policy cannot express."""

        return tuple(
            position
            for position, identity in enumerate(self.identities, start=1)
            if identity.artno is None
        )

    @property
    def ready_count(self) -> int:
        return len(self.identities) - len(self.unresolved_positions)

    @property
    def warnings(self) -> tuple[str, ...]:
        """Caller-facing, one per line that needs a human, dropped lines first.

        Built from the identities — what actually goes on the wire — and not
        from the resolver's report: the two disagree exactly where it matters.
        Under `supplier_no_or_ean` a line the resolver could not number still
        travels, as its GTIN; the resolver would call it "kann nicht übergeben
        werden" while the cart carries it. So a position that travels gets
        only the policy's own note (the EAN fallback, a truncation) plus the
        resolver's ambiguity count, and a position that is dropped gets the
        resolver's richer message — it names the SP-number, the description
        and the EAN — with the policy's sentence as the fallback when the
        resolver had nothing to say.

        In `ean` mode the resolver's number hunt is beside the point — a line
        travels iff it has a GTIN — so only the policy's own sentences apply.
        """

        if self.identifier == "ean":
            return tuple(identity.warning for identity in self.identities if identity.warning)
        dropped: list[str] = []
        kept: list[str] = []
        for resolution, identity in zip(self.report.resolutions, self.identities, strict=True):
            resolver_notes = _resolver_notes(self.report, resolution)
            if identity.artno is None:
                if resolver_notes and not resolution.is_resolved:
                    dropped.extend(resolver_notes)
                elif identity.warning:
                    dropped.append(identity.warning)
                continue
            if identity.warning:
                kept.append(identity.warning)
            if resolution.is_resolved:
                kept.extend(resolver_notes)
        return (*dropped, *kept)


def prepare_order_for_send(
    db: Session, order: WerkstattOrder, *, backfill: bool
) -> SendPreparation:
    supplier = db.get(WerkstattSupplier, order.supplier_id)
    if supplier is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Lieferant nicht gefunden")
    identifier: OrderIdentifier = supplier.order_identifier  # type: ignore[assignment]
    full = load_order_full(db, order)
    items, report = cart_items_for_order_lines(
        db,
        supplier_id=order.supplier_id,
        lines=full.lines,
        supplier_name=supplier.name,
        backfill=backfill,
    )
    identities = tuple(
        wire_identity(item, identifier, position, channel=supplier.order_channel)
        for position, item in enumerate(items, start=1)
    )
    return SendPreparation(
        order=order,
        supplier=supplier,
        identifier=identifier,
        channel=supplier.order_channel,
        full=full,
        items=items,
        report=report,
        identities=identities,
    )


def unresolved_conflict(preparation: SendPreparation) -> HTTPException:
    """The 409 that blocks a send. The detail is structured, not prose, so the
    SPA can list the positions and offer the override without parsing."""

    count = len(preparation.unresolved_positions)
    noun = "Position" if count == 1 else "Positionen"
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "code": UNRESOLVED_CODE,
            "message": f"{count} {noun} ohne Lieferanten-Artikelnummer",
            "warnings": list(preparation.warnings),
            "unresolved_positions": list(preparation.unresolved_positions),
        },
    )


def _resolver_notes(report: ResolutionReport, resolution: Resolution) -> tuple[str, ...]:
    """The resolver's own sentences about ONE line, in its own words.

    A one-line report reuses `ResolutionReport.warnings` verbatim, so the text
    the buyer reads here is the text the resolver would have written — the
    "hat keine Artikelnummer für X …" advice for an unresolved line, the
    "n weitere Katalog-Treffer" note for an ambiguous one — without a second
    copy of either sentence to drift.
    """

    return ResolutionReport(
        supplier_id=report.supplier_id,
        resolutions=(resolution,),
        supplier_name=report.supplier_name,
    ).warnings()


def require_resolved(preparation: SendPreparation, *, allow_unresolved: bool) -> None:
    """Raise the 409 unless every line is expressible or the buyer overrode."""

    if allow_unresolved or not preparation.unresolved_positions:
        return
    raise unresolved_conflict(preparation)


# ──────────────────────────────────────────────────────────────────────────
# Read-only preview
# ──────────────────────────────────────────────────────────────────────────


def describe_resolution(db: Session, preparation: SendPreparation) -> OrderResolutionOut:
    alternatives = _alternatives_by_position(db, preparation)
    lines = [
        OrderLineResolutionOut(
            line_id=line.id,
            position=resolution.position,
            supplier_article_no=resolution.supplier_article_no,
            matched_by=resolution.matched_by,
            is_resolved=identity.artno is not None,
            ean=resolution.ean,
            catalog_item_id=resolution.catalog_item_id,
            ambiguous_alternatives=resolution.ambiguous_alternatives,
            alternatives=alternatives.get(resolution.position, []),
            will_send=identity.artno,
            warning=identity.warning,
        )
        for line, resolution, identity in zip(
            preparation.full.lines, preparation.report.resolutions, preparation.identities, strict=True
        )
    ]
    return OrderResolutionOut(
        order_id=preparation.order.id,
        supplier_id=preparation.supplier.id,
        identifier=preparation.identifier,
        channel=preparation.channel,
        line_count=len(lines),
        ready_count=preparation.ready_count,
        lines=lines,
        warnings=list(preparation.warnings),
    )


def _alternatives_by_position(
    db: Session, preparation: SendPreparation
) -> dict[int, list[OrderResolutionAlternativeOut]]:
    """The other Datanorm rows that matched an ambiguous line.

    Only lines the resolver flagged pay for a query, and the chosen rows are
    fetched in one go; a 40-line order with no ambiguity costs one query.
    """

    flagged = [
        resolution
        for resolution in preparation.report.resolutions
        if resolution.ambiguous_alternatives and resolution.catalog_item_id is not None
    ]
    if not flagged:
        return {}
    chosen_rows = {
        row.id: row
        for row in db.scalars(
            select(MaterialCatalogItem).where(
                MaterialCatalogItem.id.in_({r.catalog_item_id for r in flagged})
            )
        ).all()
    }
    found: dict[int, list[OrderResolutionAlternativeOut]] = {}
    for resolution in flagged:
        chosen = chosen_rows.get(resolution.catalog_item_id or -1)
        if chosen is None:
            continue
        found[resolution.position] = [
            OrderResolutionAlternativeOut(
                catalog_item_id=row.id, article_no=row.article_no, item_name=row.item_name
            )
            for row in _sibling_rows(db, preparation.supplier.id, chosen, resolution)
        ]
    return found


def _sibling_rows(
    db: Session, supplier_id: int, chosen: MaterialCatalogItem, resolution: Resolution
) -> list[MaterialCatalogItem]:
    """Rows that matched as well as ``chosen`` did, by the same key."""

    stmt = select(MaterialCatalogItem).where(
        MaterialCatalogItem.supplier_id == supplier_id,
        MaterialCatalogItem.id != chosen.id,
        MaterialCatalogItem.article_no.is_not(None),
        MaterialCatalogItem.article_no != "",
    )
    if resolution.matched_by == "catalog_ean" and chosen.ean:
        stmt = stmt.where(MaterialCatalogItem.ean.in_(_ean_spellings(chosen.ean)))
    else:
        stmt = stmt.where(MaterialCatalogItem.article_no == chosen.article_no)
    stmt = stmt.order_by(MaterialCatalogItem.article_no.asc(), MaterialCatalogItem.id.asc())
    return list(db.scalars(stmt.limit(ALTERNATIVES_LIMIT)).all())


def _ean_spellings(ean: str) -> tuple[str, ...]:
    """The leading-zero variants Datanorm files disagree about — the same
    set the resolver matched on, so the list agrees with its count."""

    digits = "".join(char for char in ean if char.isdigit())
    bare = digits.lstrip("0") or digits
    spellings = (digits, bare, bare.zfill(13), bare.zfill(14))
    return tuple(dict.fromkeys(s for s in spellings if s))
