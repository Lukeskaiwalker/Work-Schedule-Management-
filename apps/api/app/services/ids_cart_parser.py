"""Parse a wholesaler shopping cart into order lines.

Reads the XML an IDS-Connect shop POSTs back to our hook URL and produces a
list of prospective order lines. Pure functions over strings and bytes — no
database, no FastAPI — so the awkward cases can be tested as fixtures.

## Why this is tolerant rather than strict

IDS-Connect fixes the *handshake* far more tightly than it fixes the payload.
In practice the cart XML that comes back is some dialect of BMEcat/openTRANS
with German element names mixed in, and it differs per wholesaler and per shop
version. A strict parser written against one published example would reject a
real cart the first time a shop renamed ``ARTIKELNUMMER`` to ``ARTICLE_ID``,
and the user would have nothing to show for their shopping trip.

So the parser works structurally: find the repeated item-shaped elements
anywhere in the tree, then read each one through an alias table. Anything it
cannot make sense of becomes a *warning attached to the line*, not an
exception, and the caller shows the operator a preview before anything is
committed. A wrong guess is then visible and correctable rather than silent.

The raw payload is stored by the caller (`werkstatt_order_imports.raw_payload`)
so that when a real Unielektro cart lands and the guesses turn out wrong, the
fix is a change here plus a re-parse — not "please go shopping again".

## Security

`xml.etree.ElementTree` does not expand external entities, so XXE file
disclosure is not reachable. It *is* vulnerable to entity-expansion blowups
("billion laughs"), which require a DTD internal subset — so payloads carrying
a DOCTYPE are rejected outright before parsing, and the payload is size-capped
first. A cart has no legitimate reason to declare a doctype.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from xml.etree import ElementTree

# A cart is a shopping list, not a catalogue. Ten thousand lines would already
# be absurd; five megabytes is far past generous and keeps a hostile payload
# from being parsed at all.
MAX_PAYLOAD_BYTES = 5 * 1024 * 1024
MAX_LINES = 2000

# Charsets tried in order when the payload does not declare its own. IDS
# predates universal UTF-8 and most German shops still emit ISO-8859-1;
# cp1252 is the near-superset that rescues the ones that claim 8859-1 but use
# Windows quotes anyway.
FALLBACK_CHARSETS = ("utf-8", "cp1252", "iso-8859-1")

_XML_DECL_ENCODING = re.compile(
    rb"""<\?xml[^>]*?encoding\s*=\s*["']([A-Za-z0-9_\-.]+)["']""", re.IGNORECASE
)

# Element names that mean "one line of the cart". Matched case-insensitively
# with any namespace stripped.
ITEM_TAGS = frozenset(
    {
        "item",
        "artikel",
        "position",
        "order_item",
        "orderitem",
        "cart_item",
        "cartitem",
        "warenkorbposition",
        "basketitem",
        "basket_item",
        "product",
        "produkt",
        "pos",
        "line",
        "zeile",
    }
)

# Field aliases, most-specific first. The first alias found in an item wins,
# so ARTICLE_ID beats a generic ID.
FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "supplier_article_no": (
        "supplier_aid",
        "supplier_article_id",
        "supplier_pid",
        "article_id",
        "artikelnummer",
        "artikel_nr",
        "artnr",
        "art_nr",
        "bestellnummer",
        "item_no",
        "itemno",
        "article_number",
        "product_id",
        "matnr",
    ),
    "description": (
        "description_short",
        "artikelbezeichnung",
        "article_description",
        "bezeichnung",
        "kurztext",
        "description",
        "beschreibung",
        "item_name",
        "name",
        "text",
    ),
    "manufacturer": (
        "manufacturer_name",
        "manufacturer",
        "hersteller",
        "fabrikat",
    ),
    "ean": ("ean", "gtin", "international_aid", "ean_nr", "eannummer"),
    "quantity": (
        "order_quantity",
        "bestellmenge",
        "quantity",
        "menge",
        "anzahl",
        "qty",
        "stueckzahl",
    ),
    "unit": (
        "order_unit",
        "mengeneinheit",
        "quantity_unit",
        "einheit",
        "unit",
        "me",
    ),
    "unit_price": (
        "price_amount",
        "einzelpreis",
        "unit_price",
        "nettopreis",
        "net_price",
        "preis",
        "price",
    ),
    "currency": ("price_currency", "currency", "waehrung", "währung"),
    "notes": ("remark", "bemerkung", "long_description", "langtext", "hinweis"),
}

# Cart-level reference the shop gives us, so a re-import of the same basket is
# recognisable and a support call has something to quote.
REFERENCE_ALIASES = (
    "basket_id",
    "warenkorb_id",
    "warenkorbid",
    "transaktionsid",
    "transaction_id",
    "order_id",
    "bestellnummer",
    "vorgangsnummer",
    "reference",
)

# Values that mean "line total", not "unit price". Read only when no unit
# price is present, and then divided out — a cart that gives only the extended
# amount is common and dropping the price entirely would be worse.
LINE_TOTAL_ALIASES = ("price_line_amount", "gesamtpreis", "line_amount", "positionswert")


@dataclass(frozen=True)
class ParsedCartLine:
    """One prospective order line, plus everything we were unsure about."""

    position: int
    supplier_article_no: str | None = None
    description: str | None = None
    manufacturer: str | None = None
    ean: str | None = None
    quantity: int = 1
    # What the shop actually wrote, kept verbatim. When the quantity had to be
    # rounded, this is the evidence the operator needs to correct it.
    quantity_raw: str | None = None
    unit: str | None = None
    unit_price_cents: int | None = None
    currency: str = "EUR"
    notes: str | None = None
    warnings: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class ParsedCart:
    lines: tuple[ParsedCartLine, ...] = field(default_factory=tuple)
    external_reference: str | None = None
    currency: str = "EUR"
    warnings: tuple[str, ...] = field(default_factory=tuple)


class CartParseError(ValueError):
    """The payload could not be read at all. Distinct from a line-level warning."""


# ──────────────────────────────────────────────────────────────────────────
# Decoding
# ──────────────────────────────────────────────────────────────────────────


def decode_payload(raw: bytes, *, declared_charset: str | None = None) -> str:
    """Bytes → text, preferring what the document says about itself.

    Precedence: the XML declaration's own ``encoding=`` (the document is the
    best authority on its own bytes), then the charset configured for the
    connection, then the fallbacks. Getting this wrong is the classic cause of
    "Möller" arriving as "MÃ¶ller", so it is worth the ceremony.
    """

    if len(raw) > MAX_PAYLOAD_BYTES:
        raise CartParseError(
            f"Warenkorb ist zu groß ({len(raw)} Bytes, erlaubt sind {MAX_PAYLOAD_BYTES})"
        )

    candidates: list[str] = []
    match = _XML_DECL_ENCODING.search(raw[:512])
    if match:
        candidates.append(match.group(1).decode("ascii", errors="ignore"))
    if declared_charset:
        candidates.append(declared_charset)
    candidates.extend(FALLBACK_CHARSETS)

    seen: set[str] = set()
    for charset in candidates:
        key = charset.strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        try:
            return raw.decode(key)
        except (LookupError, UnicodeDecodeError):
            continue

    # latin-1 cannot fail — every byte is a code point. Reaching here means the
    # text will be mojibake, but a readable-ish import beats a hard failure the
    # operator cannot act on.
    return raw.decode("iso-8859-1", errors="replace")


# ──────────────────────────────────────────────────────────────────────────
# Number parsing
# ──────────────────────────────────────────────────────────────────────────


def parse_number(value: str) -> tuple[Decimal | None, str | None]:
    """Parse a German- or English-formatted number.

    Returns ``(value, warning)``.

    Rule: **the last separator is the decimal point**, everything else is
    grouping. That handles "1.234,56" and "1,234.56" and plain "12.5" the same
    way, without needing to know the shop's locale.

    The rule is ambiguous for a single separator followed by exactly three
    digits — "1.000" is one thousand to a German shop and one-point-oh to an
    English one. There is no way to tell from the string, so the value is
    parsed by the rule (as a decimal) and a warning is returned. The operator
    sees it in the import preview; guessing silently is how a cart of 1000
    cable ties becomes a cart of 1.
    """

    text = (value or "").strip()
    if not text:
        return None, None
    text = re.sub(r"[^\d,.\-]", "", text)
    if not text or text in {"-", ".", ","}:
        return None, None

    warning: str | None = None
    last_sep = max(text.rfind(","), text.rfind("."))
    if last_sep == -1:
        normalised = text
    else:
        decimals = text[last_sep + 1 :]
        integer_part = re.sub(r"[,.]", "", text[:last_sep])
        if len(decimals) == 3 and text.count(",") + text.count(".") == 1:
            warning = (
                f"'{value.strip()}' ist mehrdeutig — als {integer_part}.{decimals} "
                "gelesen, könnte aber auch die Tausendertrennung sein"
            )
        normalised = f"{integer_part}.{decimals}"

    try:
        return Decimal(normalised), warning
    except InvalidOperation:
        return None, f"'{value.strip()}' ist keine gültige Zahl"


def _quantity_from(value: str) -> tuple[int, Decimal | None, list[str]]:
    """Decimal quantity → whole units, rounded UP, with the loss reported.

    Rounding up rather than to nearest: under-ordering material means a second
    trip to the wholesaler, over-ordering means a spare in the van.

    The exact decimal is returned alongside the rounded integer because a
    caller deriving a unit price from a line total must divide by what the
    shop actually charged for, not by our rounded-up reinterpretation of it.
    """

    number, warning = parse_number(value)
    warnings = [warning] if warning else []
    if number is None or number <= 0:
        warnings.append(f"Menge '{value.strip()}' nicht lesbar — 1 angenommen")
        return 1, None, warnings
    ceiled = int(math.ceil(number))
    if Decimal(ceiled) != number:
        warnings.append(
            f"Menge {value.strip()} auf {ceiled} aufgerundet — "
            "Bestellungen führen nur ganze Einheiten"
        )
    return max(ceiled, 1), number, warnings


def _price_cents_from(value: str) -> tuple[int | None, list[str]]:
    number, warning = parse_number(value)
    warnings = [warning] if warning else []
    if number is None or number < 0:
        return None, warnings
    return int((number * 100).quantize(Decimal("1"))), warnings


# ──────────────────────────────────────────────────────────────────────────
# XML traversal
# ──────────────────────────────────────────────────────────────────────────


def _local_name(tag: object) -> str:
    """Strip any XML namespace and normalise case.

    Shops disagree about namespaces (some declare a BMEcat one, most declare
    none), and matching on the qualified name would make the alias tables
    depend on a detail that carries no meaning here.
    """

    if not isinstance(tag, str):
        return ""
    return tag.rsplit("}", 1)[-1].strip().lower()


def _collect_fields(element: ElementTree.Element) -> dict[str, str]:
    """Flatten an item subtree to ``{local_name: text}``.

    Descends through wrappers — a price is often at
    ``ARTICLE_PRICE/PRICE_AMOUNT`` rather than directly on the item — and keeps
    the FIRST value seen for each name, which is the shallowest and therefore
    the most likely to be the item's own rather than a nested detail's.

    Attributes are folded in under their own name too, because some shops put
    the article number in ``<ITEM id="...">``.
    """

    found: dict[str, str] = {}

    def visit(node: ElementTree.Element) -> None:
        for key, value in node.attrib.items():
            name = _local_name(key)
            if name and value and name not in found:
                found[name] = value.strip()
        for child in node:
            name = _local_name(child.tag)
            text = (child.text or "").strip()
            if name and text and name not in found:
                found[name] = text
            visit(child)

    visit(element)
    return found


def _first_alias(fields: dict[str, str], aliases: tuple[str, ...]) -> str | None:
    for alias in aliases:
        value = fields.get(alias)
        if value:
            return value
    return None


def _find_item_elements(root: ElementTree.Element) -> list[ElementTree.Element]:
    """Every element in the tree whose name means "cart line".

    Nested matches are dropped: a shop that wraps ``<POSITION>`` inside
    ``<ITEM>`` would otherwise yield the same line twice, once with the
    child's fields and once with the parent's flattened copy of them.
    """

    matches: list[ElementTree.Element] = []
    parents: dict[int, ElementTree.Element] = {}

    def visit(node: ElementTree.Element) -> None:
        for child in node:
            parents[id(child)] = node
            visit(child)

    visit(root)

    chosen: list[ElementTree.Element] = []
    for node in root.iter():
        if _local_name(node.tag) in ITEM_TAGS:
            matches.append(node)
    match_ids = {id(node) for node in matches}
    for node in matches:
        parent = parents.get(id(node))
        while parent is not None:
            if id(parent) in match_ids:
                break
            parent = parents.get(id(parent))
        else:
            chosen.append(node)
    return chosen


def parse_cart(text: str) -> ParsedCart:
    """Cart XML → prospective order lines.

    Raises ``CartParseError`` only when the payload is not usable XML at all.
    Everything softer — an unreadable quantity, a missing description, a
    fractional amount — is reported as a warning on the affected line.
    """

    stripped = (text or "").strip()
    if not stripped:
        raise CartParseError("Leerer Warenkorb empfangen")
    if "<!DOCTYPE" in stripped.upper():
        # Both XML entity attacks need a DOCTYPE, so refusing one closes both
        # completely rather than partially:
        #
        #   billion laughs / quadratic blowup — need custom entities, and an
        #     entity can only be declared in a DTD internal subset;
        #   XXE file disclosure — needs an external entity, likewise declared
        #     in a DTD (and separately unreachable, because ElementTree does
        #     not resolve external entities at all).
        #
        # With no DOCTYPE there is no way to declare an entity, so the parser
        # below has nothing left to expand. The whole document is scanned, not
        # just the prolog, so padding the front with megabytes of comments
        # cannot walk the declaration past the check. That over-rejects a cart
        # whose article text literally contains "<!DOCTYPE" — acceptable, and
        # the raw payload is kept either way.
        raise CartParseError("Warenkorb mit DOCTYPE wird aus Sicherheitsgründen abgelehnt")

    try:
        root = ElementTree.fromstring(stripped)
    except ElementTree.ParseError as exc:
        raise CartParseError(f"Warenkorb ist kein gültiges XML: {exc}") from exc

    header = _collect_fields(root)
    external_reference = _first_alias(header, REFERENCE_ALIASES)
    cart_currency = (_first_alias(header, FIELD_ALIASES["currency"]) or "EUR").upper()[:8]

    elements = _find_item_elements(root)
    cart_warnings: list[str] = []
    if len(elements) > MAX_LINES:
        cart_warnings.append(
            f"Warenkorb enthält {len(elements)} Positionen — nur die ersten "
            f"{MAX_LINES} wurden übernommen"
        )
        elements = elements[:MAX_LINES]

    lines: list[ParsedCartLine] = []
    for index, element in enumerate(elements, start=1):
        fields = _collect_fields(element)
        warnings: list[str] = []

        quantity_raw = _first_alias(fields, FIELD_ALIASES["quantity"])
        if quantity_raw is None:
            quantity = 1
            exact_quantity: Decimal | None = Decimal(1)
            quantity_warnings = ["Keine Menge im Warenkorb — 1 angenommen"]
        else:
            quantity, exact_quantity, quantity_warnings = _quantity_from(quantity_raw)
        warnings.extend(quantity_warnings)

        unit_price_cents: int | None = None
        price_raw = _first_alias(fields, FIELD_ALIASES["unit_price"])
        if price_raw is not None:
            unit_price_cents, price_warnings = _price_cents_from(price_raw)
            warnings.extend(price_warnings)
        else:
            total_raw = _first_alias(fields, LINE_TOTAL_ALIASES)
            if total_raw is not None:
                total_cents, price_warnings = _price_cents_from(total_raw)
                warnings.extend(price_warnings)
                # Divide by the quantity the shop PRICED, not by our rounded-up
                # one. A 31,25 € total for 2,5 packs is 12,50 € a pack; dividing
                # by the stored 3 would invent a 10,42 € unit price and then
                # quietly under-state the order by a third.
                divisor = exact_quantity if exact_quantity and exact_quantity > 0 else None
                if total_cents is not None and divisor is not None:
                    unit_price_cents = int(
                        (Decimal(total_cents) / divisor).quantize(Decimal("1"))
                    )
                    warnings.append(
                        "Kein Einzelpreis im Warenkorb — aus dem Positionswert errechnet"
                    )

        description = _first_alias(fields, FIELD_ALIASES["description"])
        supplier_article_no = _first_alias(fields, FIELD_ALIASES["supplier_article_no"])
        if not description and not supplier_article_no:
            warnings.append(
                "Position ohne Artikelnummer und ohne Bezeichnung — bitte prüfen"
            )

        lines.append(
            ParsedCartLine(
                position=index,
                supplier_article_no=_clip(supplier_article_no, 160),
                description=_clip(description, 500),
                manufacturer=_clip(_first_alias(fields, FIELD_ALIASES["manufacturer"]), 255),
                ean=_clip(_first_alias(fields, FIELD_ALIASES["ean"]), 64),
                quantity=quantity,
                quantity_raw=quantity_raw,
                unit=_clip(_first_alias(fields, FIELD_ALIASES["unit"]), 64),
                unit_price_cents=unit_price_cents,
                currency=(_first_alias(fields, FIELD_ALIASES["currency"]) or cart_currency)
                .upper()[:8],
                notes=_clip(_first_alias(fields, FIELD_ALIASES["notes"]), 2000),
                warnings=tuple(warnings),
            )
        )

    if not lines:
        cart_warnings.append(
            "Im Warenkorb wurde keine Position erkannt. Das Rohdokument ist "
            "gespeichert und kann nach Anpassung erneut eingelesen werden."
        )

    return ParsedCart(
        lines=tuple(lines),
        external_reference=_clip(external_reference, 128),
        currency=cart_currency,
        warnings=tuple(cart_warnings),
    )


def _clip(value: str | None, limit: int) -> str | None:
    """Trim to the column width. The database would raise; the operator would
    rather have a truncated description than a rejected cart."""

    if value is None:
        return None
    text = value.strip()
    return text[:limit] if text else None
