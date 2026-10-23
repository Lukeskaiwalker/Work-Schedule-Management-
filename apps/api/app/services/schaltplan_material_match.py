"""Which shelf article a Materialliste line means (docs/PANEL_ENCLOSURE_R2.md §5.2).

Moved out of ``schaltplan_material`` (the 800-line cap) unchanged, and
re-exported from there, so every caller keeps importing it where it always
did. Round 2 adds one step, the manufacturer's EAN. A line is matched, in
this order:

1. an explicit mapping (``schaltplan_material_articles``, keyed by the
   line's key, global — "our B16 is SP-0152" holds for every board);
2. the EAN, when the line has one (``eans``; today only the U84T rail
   insulation set): exact equality on ``werkstatt_articles.ean``, which a
   partial unique index keeps to at most one article;
3. for a WAGO terminal part, the article whose name leads with the part
   number ("WAGO 2003-7641 - TOPJOB S …", the way the catalog names them),
   or whose supplier number is the bare part number;
4. for a cabinet line, its article number (``numbers``): the supplier
   number, else the whole token in the name (``match_articles_by_number``).

Archived and merged-away articles never match.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.entities import WerkstattArticle, WerkstattArticleSupplier
from app.models.schaltplan import PanelMaterialArticle
from app.services.panel_enclosure_catalog import match_articles_by_number
from app.services.schaltplan_terminal_rules import TERMINAL_PARTS
from app.services.werkstatt_article_labels import split_item_name

if TYPE_CHECKING:  # the list imports this module; its line type is only a hint here
    from app.services.schaltplan_material import PlannedLine

#: The kind of a WAGO part line (``schaltplan_material`` takes it from here).
LINE_TERMINAL = "terminal"
#: An EAN-13 is 13 digits; anything longer than a GTIN-14 names no article.
EAN_MAX_LENGTH = 14


def explicit_mappings(db: Session, keys: list[str]) -> dict[str, WerkstattArticle]:
    if not keys:
        return {}
    rows = db.execute(
        select(PanelMaterialArticle.part_key, WerkstattArticle)
        .join(WerkstattArticle, WerkstattArticle.id == PanelMaterialArticle.article_id)
        .where(PanelMaterialArticle.part_key.in_(keys))
    ).all()
    return {str(key): article for key, article in rows}


def match_articles_by_ean(db: Session, eans: list[str]) -> dict[str, WerkstattArticle]:
    """EAN → its live article, in one batched ``IN`` query on the indexed column.

    Exact equality only (no LIKE): an EAN is a code, not a name. Blank and
    over-long values are dropped before the query.
    """
    wanted = sorted({ean.strip() for ean in eans if isinstance(ean, str) and 0 < len(ean.strip()) <= EAN_MAX_LENGTH})
    if not wanted:
        return {}
    rows = db.scalars(
        select(WerkstattArticle)
        .where(
            WerkstattArticle.ean.in_(wanted),
            WerkstattArticle.is_archived.is_(False),
            WerkstattArticle.merged_into_id.is_(None),
        )
        .order_by(WerkstattArticle.id.asc())
    ).all()
    out: dict[str, WerkstattArticle] = {}
    for article in rows:
        out.setdefault(str(article.ean), article)
    return out


def auto_match_part(db: Session, part_no: str) -> WerkstattArticle | None:
    """The stock article for a WAGO part number, by the catalog's naming.

    "WAGO 2003-7641" matches an article named "WAGO 2003-7641 - TOPJOB S …"
    (the head before " - " is the part number) or one whose supplier number
    is the bare "2003-7641". Archived and merged-away articles never match.
    """
    cleaned = " ".join((part_no or "").split())
    if not cleaned:
        return None
    bare = cleaned.split(" ")[-1]
    candidates = db.scalars(
        select(WerkstattArticle)
        .where(
            WerkstattArticle.is_archived.is_(False),
            WerkstattArticle.merged_into_id.is_(None),
            func.lower(WerkstattArticle.item_name).like(f"%{bare.lower()}%"),
        )
        .order_by(WerkstattArticle.id.asc())
    ).all()
    for article in candidates:
        head, _ = split_item_name(article.item_name, article.manufacturer)
        if head.lower() == cleaned.lower() or head.lower().endswith(bare.lower()):
            return article
    for article in candidates:
        if article.item_name.lower().startswith(cleaned.lower()):
            return article
    supplier_row = db.execute(
        select(WerkstattArticle)
        .join(WerkstattArticleSupplier, WerkstattArticleSupplier.article_id == WerkstattArticle.id)
        .where(
            WerkstattArticleSupplier.supplier_article_no == bare,
            WerkstattArticle.is_archived.is_(False),
            WerkstattArticle.merged_into_id.is_(None),
        )
        .order_by(WerkstattArticle.id.asc())
    ).first()
    return supplier_row[0] if supplier_row is not None else None


def resolve_line_articles(
    db: Session, lines: list[PlannedLine], numbers: dict[str, str] | None = None, eans: dict[str, str] | None = None
) -> dict[str, tuple[WerkstattArticle, str]]:
    """key → (article, "mapping" | "auto") for every planned line that has one.

    ``numbers`` (line key → article number) is what the cabinet's lines are
    matched by when nobody mapped them; all of them in one batched lookup.
    ``eans`` (line key → EAN) comes before the number; also one lookup.
    """
    resolved: dict[str, tuple[WerkstattArticle, str]] = {}
    mapped = explicit_mappings(db, [line.key for line in lines])
    unmapped = [line.key for line in lines if line.key not in mapped]
    wanted_eans = {key: eans[key].strip() for key in unmapped if eans and isinstance(eans.get(key), str)}
    by_ean = match_articles_by_ean(db, list(wanted_eans.values()))
    wanted = {line.key: numbers[line.key].strip() for line in lines if numbers and line.key in numbers}
    matched = match_articles_by_number(
        db, [number for key, number in wanted.items() if key not in mapped and wanted_eans.get(key) not in by_ean]
    )
    for line in lines:
        article = mapped.get(line.key)
        if article is not None:
            resolved[line.key] = (article, "mapping")
            continue
        article = by_ean.get(wanted_eans.get(line.key, ""))
        if article is None and line.kind == LINE_TERMINAL:
            part = TERMINAL_PARTS.get(line.key.removeprefix("part:"))
            article = auto_match_part(db, part.part_no if part is not None else line.label)
        elif article is None:
            article = matched.get(wanted.get(line.key, ""))
        if article is not None:
            resolved[line.key] = (article, "auto")
    return resolved
