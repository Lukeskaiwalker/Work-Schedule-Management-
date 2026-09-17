"""GTIN (EAN/UPC) normalisation for scanned codes.

A barcode reaches us in more spellings than there are products. The same
Schuko socket is ``4012345678901`` on the Datanorm row, ``04012345678901``
after a GTIN-14 export, ``012345678905`` when an American-made tool carries a
UPC-A and the scanner emits twelve digits, and ``4012345678901 `` with a
trailing carriage return from a wedge that was configured years ago.

Two rules keep the rest of the system sane:

**We never rewrite what is stored.** ``werkstatt_articles.ean`` keeps exactly
the digits somebody entered or the wholesaler shipped. Normalising rows would
turn an EAN clash into a migration, and a 12-digit row that has always been
found by its own code would suddenly be findable only by its 13-digit twin.

**We search every spelling.** ``variants()`` returns the bounded set of codes
that mean the same product, so one indexed ``IN`` clause finds the row however
it was written down. That is the same idea as ``ids_ean_resolver._ean_variants``
and it is deliberately duplicated rather than imported: that module's variants
exist to match a *wholesaler's catalogue*, this one's to match *our shelf*, and
the two want to grow in different directions (this one adds the UPC-A → EAN-13
expansion, which would be wrong when talking to a German shop's article index).

The checksum matters for one decision only: whether a code is GTIN-shaped
enough to be worth an outbound HTTP call. A mistyped digit is not a product,
and asking a webshop about it costs a round trip and a cached miss.
"""

from __future__ import annotations

# The four GTIN lengths in the wild. GTIN-14 is the shipping-container form and
# carries a leading packaging digit; the trade item inside it is the last 13.
GTIN_LENGTHS = (8, 12, 13, 14)

# Guards every helper below: a scanned "code" can legitimately be an SP number,
# a crate code or a serial, and those must not be padded into fake GTINs.
MAX_CODE_LENGTH = 64


def normalize(code: str | None) -> str:
    """Trim a scanned code. Whitespace only — the value itself is untouched."""
    return (code or "").strip()


def digits_only(code: str | None) -> str:
    """The digits of *code*, in order. Empty when there are none."""
    return "".join(char for char in normalize(code) if char.isdigit())


def checksum_ok(code: str) -> bool:
    """Is *code* a GTIN whose check digit agrees with the rest of it?

    Modulo-10 with weights 3 and 1 alternating from the right, which is the
    same algorithm for EAN-8, UPC-A, EAN-13 and GTIN-14 — the weighting is
    anchored at the check digit, not at the start, so no per-length branch is
    needed.
    """
    if len(code) not in GTIN_LENGTHS or not code.isdigit():
        return False
    body, check = code[:-1], int(code[-1])
    total = 0
    for index, char in enumerate(reversed(body)):
        total += int(char) * (3 if index % 2 == 0 else 1)
    return (10 - total % 10) % 10 == check


def is_gtin(code: str | None) -> bool:
    """True when *code* is a plausible product barcode, checksum included.

    The gate for every outbound lookup. A hand-typed name, an SP number or a
    code with a fat-fingered digit answers False, so the provider cascade is
    never asked a question no product database can answer.
    """
    token = normalize(code)
    return bool(token) and token.isdigit() and checksum_ok(token)


def to_ean13(code: str | None) -> str | None:
    """The EAN-13 spelling of *code*, when it has one.

    UPC-A (12 digits) is an EAN-13 with a leading zero — the check digit is
    unchanged, which is why the padding is a pure rename rather than a new
    code. GTIN-14 carries a packaging indicator in front; dropping it yields
    the trade item, but only when what remains still checks out.
    """
    token = normalize(code)
    if not token.isdigit():
        return None
    if len(token) == 13:
        return token if checksum_ok(token) else None
    if len(token) == 12:
        padded = f"0{token}"
        return padded if checksum_ok(padded) else None
    if len(token) == 14:
        inner = token[1:]
        return inner if checksum_ok(inner) else None
    return None


def variants(code: str | None) -> tuple[str, ...]:
    """Every spelling of *code* worth a database lookup, most exact first.

    Always starts with the code exactly as scanned, so a non-GTIN (an SP
    number, a crate code, a nameplate serial) passes through untouched and
    every caller can use this helper unconditionally. Bounded at a handful of
    entries: this feeds an ``IN`` clause on an indexed column.
    """
    token = normalize(code)
    if not token or len(token) > MAX_CODE_LENGTH:
        return (token,) if token else ()

    found: list[str] = [token]

    def add(candidate: str | None) -> None:
        if candidate and candidate not in found:
            found.append(candidate)

    if not token.isdigit():
        return tuple(found)

    ean13 = to_ean13(token)
    add(ean13)
    if ean13:
        # The 12-digit original of a zero-padded UPC-A: rows imported from an
        # American supplier's file are stored exactly that short.
        if ean13.startswith("0"):
            add(ean13[1:])
        add(f"0{ean13}")
        add(f"00{ean13}")
    else:
        # Not a valid GTIN (a broken check digit, an 11-digit in-house code).
        # Leading zeros are still worth trying — a Datanorm row may carry the
        # same digits padded — but nothing is invented beyond that.
        stripped = token.lstrip("0")
        if stripped and stripped != token:
            add(stripped)
    return tuple(found)
