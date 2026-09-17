"""The hand-over for a supplier who has no shop connection.

Most wholesalers' webshops have a quick-order box that takes "article number,
quantity" pasted in, and every one of them imports a CSV. For a supplier
configured with ``order_channel = manual`` that is the whole ordering path,
so it deserves the same care as the IDS cart: the numbers come from the same
resolver and the same identifier policy (`ids_cart_builder.wire_identity`),
which is what stops the CSV and the cart from ever disagreeing about a line.

Two renderings from one list of positions:

  CSV   ``Artikelnummer;Menge;Einheit;Bezeichnung[;EAN]`` — semicolons because
        that is what a German Excel writes and reads without a wizard, UTF-8
        because the descriptions carry umlauts. The EAN column exists only
        under a policy that transmits it; otherwise a shop importing "only
        the article number" would trip on the extra column.
  text  ``ArtNo<TAB>Qty`` per line, nothing else — the shape a quick-order
        box accepts from the clipboard.

Positions the policy cannot express are omitted from both and reported, so
the file is never quietly one line short.
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass
from typing import Sequence

from app.services.ids_cart_builder import CartItem, OrderIdentifier, wire_identity

CSV_HEADER = ("Artikelnummer", "Menge", "Einheit", "Bezeichnung")
CSV_DELIMITER = ";"


@dataclass(frozen=True)
class ExportedOrder:
    csv: str
    text: str
    warnings: tuple[str, ...]
    sent_positions: int
    dropped_positions: int


def _carries_ean(identifier: OrderIdentifier) -> bool:
    return identifier in ("both", "ean")


def build_order_csv(items: Sequence[CartItem], identifier: OrderIdentifier) -> str:
    """Positions the policy can express, as a spreadsheet-friendly CSV."""

    buffer = io.StringIO()
    writer = csv.writer(buffer, delimiter=CSV_DELIMITER, lineterminator="\n")
    header = (*CSV_HEADER, "EAN") if _carries_ean(identifier) else CSV_HEADER
    writer.writerow(header)
    for position, item in enumerate(items, start=1):
        identity = wire_identity(item, identifier, position)
        if identity.artno is None:
            continue
        row = [
            identity.artno,
            str(max(int(item.quantity), 1)),
            (item.unit or "").strip(),
            (item.description or "").strip(),
        ]
        if _carries_ean(identifier):
            row.append(identity.ean or "")
        writer.writerow(row)
    return buffer.getvalue().rstrip("\n")


def build_order_text(items: Sequence[CartItem], identifier: OrderIdentifier) -> str:
    """One ``ArtNo<TAB>Qty`` per position, for a shop's quick-order box."""

    lines = []
    for position, item in enumerate(items, start=1):
        identity = wire_identity(item, identifier, position)
        if identity.artno is None:
            continue
        lines.append(f"{identity.artno}\t{max(int(item.quantity), 1)}")
    return "\n".join(lines)


def export_order_items(
    items: Sequence[CartItem],
    identifier: OrderIdentifier,
    *,
    warnings: Sequence[str] | None = None,
    channel: str = "manual",
) -> ExportedOrder:
    """Both renderings plus what was left out.

    ``warnings`` is the send preparation's list (`SendPreparation.warnings`),
    already reconciled line by line between the resolver and the policy; it
    is passed through untouched. Without one — a caller with bare items and
    no resolver run — the policy's own sentences stand in. There is no
    second reconciliation here: an earlier version de-duplicated by parsing
    "Position n" out of each sentence, which kept the wrong one of two
    sentences about the same line.
    """

    identities = [
        wire_identity(item, identifier, pos, channel=channel)
        for pos, item in enumerate(items, start=1)
    ]
    dropped = sum(1 for identity in identities if identity.artno is None)
    if warnings is None:
        warnings = [identity.warning for identity in identities if identity.warning]
    return ExportedOrder(
        csv=build_order_csv(items, identifier),
        text=build_order_text(items, identifier),
        warnings=tuple(warnings),
        sent_positions=len(items) - dropped,
        dropped_positions=dropped,
    )
