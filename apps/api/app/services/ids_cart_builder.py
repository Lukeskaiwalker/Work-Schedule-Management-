"""Render an order back into wholesaler cart XML.

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

The emitted document is the same dialect `ids_cart_parser` reads, so a cart
survives a round trip through both. That symmetry is the main defence against
the shape being wrong — a payload we cannot read back is one we should not be
sending.

This is the piece most likely to need adjusting once Unielektro's IDS-Datenblatt
is to hand, because unlike the form fields (which are configuration) the XML
skeleton lives here in code. It is small and self-contained for exactly that
reason.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from xml.sax.saxutils import escape


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


def build_cart_xml(
    items: list[CartItem],
    *,
    reference: str,
    customer_number: str | None = None,
    ids_version: str = "2.5",
    charset: str = "ISO-8859-1",
) -> BuiltCart:
    """Render the cart. ``reference`` is our order number, echoed by the shop."""

    warnings: list[str] = []
    rows: list[str] = []

    for index, item in enumerate(items, start=1):
        if not item.supplier_article_no and not item.ean:
            warnings.append(
                f"Position {index} ({item.description or 'ohne Bezeichnung'}) hat weder "
                "Lieferanten-Artikelnummer noch EAN — der Shop kann sie evtl. nicht zuordnen"
            )
        rows.append(
            "      <ITEM>\n"
            f"        {_tag('SUPPLIER_AID', item.supplier_article_no)}\n"
            f"        {_tag('INTERNATIONAL_AID', item.ean)}\n"
            f"        {_tag('DESCRIPTION_SHORT', item.description)}\n"
            f"        {_tag('QUANTITY', max(int(item.quantity), 1))}\n"
            f"        {_tag('ORDER_UNIT', item.unit)}\n"
            f"        {_tag('PRICE_AMOUNT', _price(item.unit_price_cents))}\n"
            f"        {_tag('PRICE_CURRENCY', item.currency or 'EUR')}\n"
            f"        {_tag('REMARK', item.notes)}\n"
            "      </ITEM>"
        )

    if not rows:
        warnings.append("Die Bestellung hat keine Positionen")

    body = "\n".join(rows)
    xml = (
        f'<?xml version="1.0" encoding="{charset}"?>\n'
        f'<IDS VERSION="{escape(ids_version)}">\n'
        "  <SHOPPING_CART>\n"
        "    <CART_HEADER>\n"
        f"      {_tag('CUSTOMER_NO', customer_number)}\n"
        f"      {_tag('REFERENCE', reference)}\n"
        "    </CART_HEADER>\n"
        "    <ITEM_LIST>\n"
        f"{body}\n"
        "    </ITEM_LIST>\n"
        "  </SHOPPING_CART>\n"
        "</IDS>"
    )
    return BuiltCart(xml=xml, warnings=tuple(warnings))


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
