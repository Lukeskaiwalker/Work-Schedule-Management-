"""What a Bautagesbericht actually asked the office to buy.

A report carries the same request twice: `materials_needed` as structured
rows (item / qty / unit / note) and `office_material_need` as the serialised
text the PDF prints — "NYM-J 5x6 - 25 m - ArtNr 11102138" — which is the only
one of the two that carries an article number (see
`apps/web/src/utils/reports.ts::serializeOfficeMaterialRows`).

Until now only the text was read, and only as a whole line: every report-born
need arrived with the quantity, unit and number crammed into `item` and no
catalogue link, which is why none of them could ever be ordered. This module
reads both and merges them — structure for the fields it has, the text for
the article number — so a need born on a building site is orderable in the
office without being retyped.

Pure functions over a payload plus (for the catalogue lookup) a session. No
routing, no activity logging: the caller owns both.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.entities import MaterialCatalogItem

# "ArtNr 11102138" / "ArtNo A-1001" — the tail the serialiser appends.
_ARTICLE_TAIL = re.compile(r"^art[\.\s]?(?:nr|no)\.?\s*[:\s]\s*(.+)$", re.IGNORECASE)
# "25 m", "2,5", "30 Stk" — a leading number optionally followed by a unit.
_QTY_UNIT = re.compile(r"^(\d+(?:[.,]\d+)?)\s*([^\d\s][^\s]{0,15}(?:\s[^\d\s][^\s]{0,15})?)?$")


@dataclass(frozen=True)
class ReportMaterialNeedRow:
    """One row the office has to act on. Immutable: built once, never patched."""

    item: str
    quantity: str | None = None
    unit: str | None = None
    article_no: str | None = None
    notes: str | None = None

    def dedupe_key(self) -> tuple[str, str, str, str]:
        # Item alone would drop a second, legitimately different quantity of
        # the same cable; the full tuple only drops a genuinely repeated line.
        return (
            self.item.strip().lower(),
            (self.quantity or "").strip().lower(),
            (self.unit or "").strip().lower(),
            (self.article_no or "").strip().lower(),
        )


def _clean(raw: object) -> str:
    text = str(raw or "").replace("\r", " ").replace("\n", " ").strip()
    if not text:
        return ""
    return re.sub(r"\s{2,}", " ", text)


def parse_office_material_line(line: str) -> ReportMaterialNeedRow | None:
    """One serialised line → its parts, read from the right.

    Reading from the right is what keeps an item that contains a dash — and
    "NYM-J 5x6, 25m ring" is a real one — in one piece: only a trailing
    segment that LOOKS like an article tail or a quantity is taken off.
    """

    cleaned = _clean(line).strip("-*• ")
    if not cleaned:
        return None

    segments = [segment.strip() for segment in cleaned.split(" - ")]
    article_no: str | None = None
    quantity: str | None = None
    unit: str | None = None

    if len(segments) > 1:
        tail = _ARTICLE_TAIL.match(segments[-1])
        if tail:
            article_no = tail.group(1).strip() or None
            segments = segments[:-1]

    if len(segments) > 1:
        qty_match = _QTY_UNIT.match(segments[-1])
        if qty_match:
            quantity = qty_match.group(1)
            unit = (qty_match.group(2) or "").strip() or None
            segments = segments[:-1]

    item = " - ".join(segment for segment in segments if segment).strip()
    if not item:
        return None
    return ReportMaterialNeedRow(
        item=item, quantity=quantity, unit=unit, article_no=article_no
    )


def parse_office_material_text(raw_value: object) -> list[ReportMaterialNeedRow]:
    """The whole `office_material_need` block, one row per non-empty line."""

    raw = str(raw_value or "").replace("\r", "\n")
    rows: list[ReportMaterialNeedRow] = []
    for line in raw.split("\n"):
        row = parse_office_material_line(line)
        if row is not None:
            rows.append(row)
    return rows


def _structured_rows(payload: dict) -> list[ReportMaterialNeedRow]:
    raw_rows = payload.get("materials_needed")
    if not isinstance(raw_rows, list):
        return []
    rows: list[ReportMaterialNeedRow] = []
    for raw in raw_rows:
        if not isinstance(raw, dict):
            continue
        item = _clean(raw.get("item"))
        if not item:
            continue
        rows.append(
            ReportMaterialNeedRow(
                item=item,
                quantity=_clean(raw.get("qty")) or None,
                unit=_clean(raw.get("unit")) or None,
                notes=_clean(raw.get("note")) or None,
            )
        )
    return rows


def _looks_like_article_number(value: str | None) -> bool:
    """One token containing a digit — "11102138", "UE-77", "A-1001"."""

    text = (value or "").strip()
    if not text or len(text) > 160 or re.search(r"\s", text):
        return False
    return any(char.isdigit() for char in text)


def _note_unless_article_number(notes: str | None, article_no: str | None) -> str | None:
    """Drop a "note" that is only the article number repeated.

    The report form's fourth Materialbedarf column is labelled ART.NR, and
    `App.tsx` serialises it as the payload's `note` — a deliberate old
    repurposing for the PDF's "Bemerkung" column that predates this parser.
    Read literally it would give every report-born need a bare number as its
    Notiz, printed again directly under the "Art.-Nr." it already shows and
    appended to every wholesaler order line. So: keep a note that says
    something, drop one that only repeats the number.
    """

    text = (notes or "").strip()
    if not text:
        return None
    if text.lower() == (article_no or "").strip().lower():
        return None
    return text


def _with_article_numbers(
    structured: list[ReportMaterialNeedRow], text_rows: list[ReportMaterialNeedRow]
) -> list[ReportMaterialNeedRow]:
    """Carry the article number the structured rows do not have.

    Matched by item text first (the two lists describe the same rows, but a
    fitter can reorder them between save and submit), then positionally for
    the leftovers.
    """

    by_item: dict[str, str] = {}
    for row in text_rows:
        if row.article_no:
            by_item.setdefault(row.item.strip().lower(), row.article_no)

    merged: list[ReportMaterialNeedRow] = []
    for index, row in enumerate(structured):
        article_no = by_item.get(row.item.strip().lower())
        if article_no is None and index < len(text_rows):
            candidate = text_rows[index]
            if candidate.item.strip().lower() == row.item.strip().lower():
                article_no = candidate.article_no
        # The web fills `note` from the ART.NR input, so a structured row can
        # carry the number in both fields even when the text half never
        # matched. Only a value SHAPED like an article number is taken —
        # one token, with a digit in it — so an older client's genuine
        # Bemerkung ("für Halle 2") is never promoted into the number column.
        if article_no is None and _looks_like_article_number(row.notes):
            article_no = (row.notes or "").strip()
        merged.append(
            ReportMaterialNeedRow(
                item=row.item,
                quantity=row.quantity,
                unit=row.unit,
                article_no=article_no,
                notes=_note_unless_article_number(row.notes, article_no),
            )
        )
    return merged


def report_material_need_rows(payload: dict) -> list[ReportMaterialNeedRow]:
    """Every need one report asks for, deduplicated, best source first."""

    text_rows = parse_office_material_text(payload.get("office_material_need"))
    structured = _structured_rows(payload)
    rows = _with_article_numbers(structured, text_rows) if structured else text_rows

    seen: set[tuple[str, str, str, str]] = set()
    unique: list[ReportMaterialNeedRow] = []
    for row in rows:
        key = row.dedupe_key()
        if key in seen:
            continue
        seen.add(key)
        unique.append(row)
    return unique


def match_catalog_item(db: Session, article_no: str | None) -> MaterialCatalogItem | None:
    """The single catalogue row with this article number, or nothing.

    Ambiguity is treated as no match on purpose: two wholesalers reuse each
    other's numbers freely, so picking one of several would order the wrong
    product with full confidence. The row keeps its `article_no` and the
    office re-links it by hand.
    """

    normalized = _clean(article_no)
    if not normalized:
        return None
    matches = list(
        db.scalars(
            select(MaterialCatalogItem)
            .where(func.lower(MaterialCatalogItem.article_no) == normalized.lower())
            .limit(2)
        ).all()
    )
    if len(matches) != 1:
        return None
    return matches[0]


# Exactly what the browser twin accepts (`parseQuantityText` in
# apps/web/src/utils/materials.ts): plain decimal digits, one optional dot.
# Decimal() alone is far more generous — it takes "1e3" (a thousand units on
# a wholesaler order the preview showed as 1), and "NaN"/"Infinity", which
# then blow up in the comparison and the ceil as a bare 500 instead of a
# German 4xx. The grammar is the contract; both sides hold to it.
_PLAIN_DECIMAL = re.compile(r"^[+-]?\d+(\.\d+)?$")


def parse_quantity_text(raw_value: object) -> Decimal | None:
    """A free-text quantity as a number, or None when it is not one.

    Handles the three ways a German keyboard writes 1 234,5 — "1234,5",
    "1.234,5" and "1,234.5" — because the same field is filled on a phone in
    a van and pasted from a wholesaler's page. Anything else — scientific
    notation, "NaN", "2.", ".5", prose — is not a quantity here, which is the
    answer the caller turns into a visible warning.
    """

    raw = str(raw_value or "").strip()
    if not raw:
        return None
    compact = raw.replace(" ", "")
    if "," in compact and "." in compact:
        if compact.rfind(",") > compact.rfind("."):
            compact = compact.replace(".", "").replace(",", ".")
        else:
            compact = compact.replace(",", "")
    elif "," in compact:
        compact = compact.replace(",", ".")
    if not _PLAIN_DECIMAL.match(compact):
        return None
    try:
        return Decimal(compact)
    except (InvalidOperation, ValueError):  # pragma: no cover — regex guards it
        return None


def order_quantity_for_need(raw_value: object) -> tuple[int, str | None]:
    """How many of this to order, and what the buyer has to double-check.

    A wholesaler basket takes whole units, but a fitter writes "2,5" for
    cable and "ca. 3 Ringe" for rings. Rounding UP is the safe direction —
    too much cable is a cost, too little is a second trip — but it is never
    silent: the warning is carried to the confirmation modal AND onto the
    order line, because the person who confirms is not always the person who
    reads the order.
    """

    raw = str(raw_value or "").strip()
    parsed = parse_quantity_text(raw)
    if parsed is None:
        if not raw:
            return 1, "Keine Menge angegeben – 1 angenommen, bitte prüfen"
        return 1, f"Menge '{raw}' nicht lesbar – 1 angenommen, bitte prüfen"
    if parsed <= 0:
        return 1, f"Menge '{raw}' ist nicht bestellbar – 1 angenommen, bitte prüfen"
    rounded = int(math.ceil(parsed))
    if Decimal(rounded) != parsed:
        return rounded, f"Menge '{raw}' auf {rounded} aufgerundet – bitte prüfen"
    return rounded, None
