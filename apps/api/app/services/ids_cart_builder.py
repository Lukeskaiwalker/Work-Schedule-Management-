"""Render an order into the wholesaler cart XML an IDS shop can read.

The return leg of the punchout: the user has assembled an order here — a cart
that came back from the shop, plus a template, plus whatever they added by
hand — and now wants it in the wholesaler's basket so they can check it out
with their own prices, stock and delivery options.

## What this deliberately does not do

It does not place an order. It fills a basket and hands the browser over. That
boundary is on purpose: prices, availability, minimum quantities and the
customer's own terms are the wholesaler's to apply, and an order placed
straight from our numbers would be binding on numbers that might be stale.
The human confirms in the shop.

## Shape

ITEK Warenkorb, per `warenkorb_senden_2_5.xsd` — root ``Warenkorb`` in the
namespace ``http://www.itek.de/Shop-Anbindung/Warenkorb/``, with
``elementFormDefault="qualified"`` so every element is in it.

This module previously emitted openTRANS/BMEcat vocabulary — ``<IDS>``,
``SHOPPING_CART``, ``SUPPLIER_AID``, ``QUANTITY`` — in no namespace at all. Not
one of those names occurs anywhere in the IDS specification or in any of its
four schemas. A shop looking for ``Warenkorb/Order/OrderItem`` found an ``<IDS>``
root and recognised zero positions, so the hand-over "succeeded" (our POST
returned 200) and the basket arrived empty. Nothing errored on either side.

The old docstring argued that symmetry with `ids_cart_parser` was "the main
defence against the shape being wrong". It was not a defence at all: the parser
strips namespaces and carries a deliberately wide alias table so it can read
many shops' dialects, including the invented one — so a round-trip test passed
against a document no shop could use. The real oracle is the schema, and
`tests/test_werkstatt_procurement.py` validates against it.

## What goes in a line, and what does not

Only three elements are mandatory per position: ``ArtNo``, ``Qty``, ``QU``. The
sequence order below is the schema's own ``xs:sequence`` and is not negotiable.

``OrderInfo`` is omitted entirely. It is optional, but ``ModeOfShipment`` is
mandatory *inside* it and we have nothing to put there — inventing a shipping
mode to satisfy a wrapper we do not need is how the field-name bugs started.

Prices are omitted too, though the schema permits them. The wholesaler reprices
every basket from the customer's own conditions, so ours would be overwritten at
best; and the prices we hold for anything imported before v2.9.14 are line
totals mis-stored as unit prices, which would hand the shop a cart overstating
metre-goods by their quantity.

## Where ArtNo comes from

``ArtNo`` must be the *supplier's own* number. The workshop scans EANs, so what
an order line carries is frequently not that, and a shop handed a GTIN drops
the position without saying so. ``cart_items_for_order_lines`` below runs
``ids_ean_resolver`` over the lines first and hands ``build_cart_xml`` numbers
the shop can act on; ``build_cart_xml`` itself stays pure and takes no session,
so the XML shape remains testable without a database.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Sequence
from xml.sax.saxutils import escape

from app.services.ids_ean_resolver import ResolutionReport, resolve_order_lines

if TYPE_CHECKING:  # pragma: no cover - typing only
    from sqlalchemy.orm import Session


@dataclass(frozen=True)
class CartItem:
    """One line on its way out. Mirrors the fields a shop can act on."""

    supplier_article_no: str | None
    description: str | None
    quantity: int
    unit: str | None = None
    ean: str | None = None
    unit_price_cents: int | None = None
    currency: str = "EUR"
    notes: str | None = None


@dataclass(frozen=True)
class BuiltCart:
    xml: str
    # Lines the shop will probably not be able to match. Surfaced rather than
    # dropped: the user should decide whether to fix the article number or send
    # the cart anyway and sort it out in the shop.
    warnings: tuple[str, ...] = field(default_factory=tuple)


def _tag(name: str, value: object | None) -> str:
    """One element, or nothing at all when there is no value.

    Empty elements are omitted rather than emitted blank — some shops treat
    `<EAN></EAN>` as "the EAN is the empty string" and fail the lookup, where
    an absent element correctly means "not supplied".
    """

    if value is None:
        return ""
    text = str(value).strip()
    if not text:
        return ""
    return f"<{name}>{escape(text)}</{name}>"


def _price(cents: int | None) -> str | None:
    """Cents → the dot-decimal string the XML carries.

    Always a dot, never a comma, regardless of the German locale everything
    else here is in: this is a machine-read field and the receiving parser is
    not obliged to share our locale guesswork.
    """

    if cents is None:
        return None
    return str((Decimal(cents) / 100).quantize(Decimal("0.01")))


IDS_NAMESPACE = "http://www.itek.de/Shop-Anbindung/Warenkorb/"

# Schema limits worth enforcing here rather than letting the shop discover them.
_ARTNO_MAX = 15  # tgNormalizedString15
_KURZTEXT_MAX = 100  # tgNormalizedString100
_REFITEM_MAX = 35  # tgNormalizedString35

# QU is mandatory, so a line with no unit still needs one. C62 is the UN/ECE
# Recommendation 20 code for "one", which is what a countable article is.
_DEFAULT_QU = "C62"


def _qty(quantity: int) -> str:
    """Quantity as the schema's tgDecimal_13_2.

    Two fraction digits are not decoration: the type declares them, and a shop
    validating strictly rejects a bare integer.
    """

    return str(Decimal(max(int(quantity), 1)).quantize(Decimal("0.01")))


def _ean(value: str | None) -> str | None:
    """An EAN only if it really is one.

    The schema types EAN as tgDecimal_13_0 — a *number*, not a string. Anything
    non-numeric makes the document invalid, and a GTIN with a leading zero
    cannot survive the field at all, so it is safer to omit than to mangle.
    """

    text = (value or "").strip()
    if not text.isdigit() or len(text) > 13:
        return None
    return text.lstrip("0") or None


def build_cart_xml(
    items: list[CartItem],
    *,
    reference: str,
    customer_number: str | None = None,
    ids_version: str = "2.5",
    charset: str = "UTF-8",
    now: datetime | None = None,
    warn_on_missing_article_no: bool = True,
) -> BuiltCart:
    """Render the cart as an ITEK Warenkorb document.

    ``reference`` is our order number. It has no home in the senden schema —
    the only free-text carriers live in ``OrderInfo``, which we omit — so it is
    kept in the signature for callers and deliberately not emitted.

    ``warn_on_missing_article_no`` is set False by
    ``cart_items_for_order_lines``, which has already reported those lines with
    the article number, name and EAN a buyer needs. The position is still
    dropped either way; only the duplicate, less informative warning goes.
    """

    warnings: list[str] = []
    rows: list[str] = []
    stamp = now or datetime.now()

    for index, item in enumerate(items, start=1):
        artno = (item.supplier_article_no or "").strip()
        if not artno:
            # ArtNo is mandatory. A position without one cannot be expressed at
            # all, and emitting it anyway would produce a document the shop
            # rejects wholesale — losing the entire cart rather than one line.
            if warn_on_missing_article_no:
                warnings.append(
                    f"Position {index} ({item.description or 'ohne Bezeichnung'}) hat keine "
                    "Lieferanten-Artikelnummer und kann nicht an den Shop übergeben werden"
                )
            continue
        if len(artno) > _ARTNO_MAX:
            warnings.append(
                f"Position {index}: Artikelnummer '{artno}' ist länger als "
                f"{_ARTNO_MAX} Zeichen und wurde gekürzt"
            )
            artno = artno[:_ARTNO_MAX]

        # Element order is the schema's xs:sequence and is not negotiable:
        # RefItems, EAN, ArtNo, Qty, QU, Kurztext.
        parts = [
            # "Positionsnummer des Handwerkers" — ours, so the shop can keep
            # line identity, which section 5.2 requires of it.
            f"      <RefItems><Customer>{escape(str(index)[:_REFITEM_MAX])}</Customer></RefItems>",
            f"      {_tag('EAN', _ean(item.ean))}",
            f"      {_tag('ArtNo', artno)}",
            f"      {_tag('Qty', _qty(item.quantity))}",
            f"      {_tag('QU', (item.unit or '').strip() or _DEFAULT_QU)}",
            f"      {_tag('Kurztext', (item.description or '')[:_KURZTEXT_MAX])}",
        ]
        body = "\n".join(line for line in parts if line.strip())
        rows.append(f"    <OrderItem>\n{body}\n    </OrderItem>")

    if not rows:
        warnings.append("Die Bestellung hat keine übergebbaren Positionen")

    items_xml = ("\n" + "\n".join(rows)) if rows else ""
    xml = (
        f'<?xml version="1.0" encoding="{charset}"?>\n'
        f'<Warenkorb xmlns="{IDS_NAMESPACE}">\n'
        "  <WarenkorbInfo>\n"
        f"    <Date>{stamp.strftime('%Y-%m-%d')}</Date>\n"
        f"    <Time>{stamp.strftime('%H:%M:%S')}</Time>\n"
        f"    <Version>{escape(ids_version)}</Version>\n"
        "  </WarenkorbInfo>\n"
        f"  <Order>{items_xml}\n"
        "  </Order>\n"
        "</Warenkorb>"
    )
    return BuiltCart(xml=xml, warnings=tuple(warnings))


def cart_items_for_order_lines(
    db: Session,
    *,
    supplier_id: int,
    lines: Sequence[object],
    supplier_name: str | None = None,
    backfill: bool = True,
) -> tuple[list[CartItem], ResolutionReport]:
    """Turn an order's lines into cart positions the shop can match.

    The single place the EAN→supplier-number translation is applied, so the
    ``/submit`` response and the hand-over page that follows it cannot disagree
    about what is in the basket — they used to build ``CartItem`` independently,
    and a divergence there would be invisible until the wholesaler's cart came
    up short.

    Every line produces a ``CartItem``, including unresolved ones. Dropping them
    here would shift every later ``RefItems/Customer`` position number, so
    "Position 3" in a warning would no longer be the third line of the order.
    ``build_cart_xml`` omits them from the XML; the returned report says which
    and why.
    """

    report = resolve_order_lines(
        db,
        supplier_id=supplier_id,
        lines=lines,
        supplier_name=supplier_name,
        backfill=backfill,
    )
    items = [
        CartItem(
            supplier_article_no=resolution.supplier_article_no,
            description=getattr(line, "article_name", None)
            or getattr(line, "description", None),
            quantity=getattr(line, "quantity_ordered", 1),
            unit=getattr(line, "unit", None),
            ean=getattr(line, "ean", None) or resolution.ean,
            unit_price_cents=getattr(line, "unit_price_cents", None),
            currency=getattr(line, "currency", None) or "EUR",
        )
        for line, resolution in zip(lines, report.resolutions, strict=True)
    ]
    return items, report


def encode_cart(xml: str, charset: str = "ISO-8859-1") -> bytes:
    """Encode for transport, replacing what the charset cannot carry.

    ``xmlcharrefreplace`` rather than ``ignore``: a Greek Ω in a description
    becomes ``&#937;``, which any XML reader resolves, instead of silently
    vanishing from the article text the wholesaler's picker reads.
    """

    try:
        return xml.encode(charset, errors="xmlcharrefreplace")
    except LookupError:
        return xml.encode("utf-8", errors="xmlcharrefreplace")
