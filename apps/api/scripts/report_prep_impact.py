"""What round 4's cabinet preparation changes on the stored boards (docs/PANEL_ENCLOSURE_R4.md §6, §13).

Read-only, for the deploy session, run in the staged image before the swap:

    cd apps/api
    PYTHONPATH=. python scripts/report_prep_impact.py

The preparation (supply kit, infeed, busbar joints, network lead, the §14a
block, its wires and Lüsterklemme) is derived, so it appears on every cabinet
board, built ones included (R4-4); the owner reads these counts first.

It prints counts, article numbers and catalogue codes, and nothing else:
never a board, customer, project, line or article name. The repo is public
and the output lands in deploy notes. It reads the documents, the ledger's
consumption rows and the hand-added Materialliste lines; their texts and
articles are only compared with article numbers, never printed. It runs its
transaction READ ONLY on PostgreSQL and rolls it back at the end.

Counted:

* boards, the readable boards with a cabinet, and the unreadable ones;
* per derived article (the Hager or WAGO number; a wire or ``prep:`` line by
  its key): the cabinet boards that gain its line, and of those the boards
  that already have booked material (a built board: the line shows "offen");
* hand-added Materialliste lines on a board for a part that board now
  derives, and their boards: each doubles the article, and the derived line
  takes its bookings. A line counts when its text names the article number
  (a whole token) or its article is the one the derived line resolves to;
* boards with a meter field but no §14a block: they get the info
  "§14a-Klemmleiste anlegen" (R4-2);
* catalogue rows for ZH3ES5, ZH3ES5RK, ZH53XS and ZH53XSRK: the Sammel-
  schienenzone moved to the bottom (R4-9) in the built-ins only, never in an
  override or a custom row.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence

API_ROOT = Path(__file__).resolve().parents[1]
if str(API_ROOT) not in sys.path:  # run as a plain script from apps/api
    sys.path.insert(0, str(API_ROOT))

from sqlalchemy import select, text  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.models.entities import WerkstattArticle  # noqa: E402
from app.models.schaltplan import PanelCatalogEntry, PanelMaterialManualLine, PanelPlan  # noqa: E402
from app.services import panel_enclosure_prep_material as prep_material  # noqa: E402
from app.services import schaltplan_material as material  # noqa: E402
from app.services.panel_enclosure_catalog import EnclosureCatalog, load_catalog  # noqa: E402
from app.services.panel_enclosure_control_block import control_carrier, stored_block  # noqa: E402
from app.services.panel_enclosure_layout import enclosure_of  # noqa: E402
from app.services.panel_enclosure_readable import readable_blocks  # noqa: E402

#: The codes whose Sammelschienenzone round 4 moved to the bottom (R4-9).
REPORT_CODES: tuple[str, ...] = ("ZH3ES5", "ZH3ES5RK", "ZH53XS", "ZH53XSRK")

ManualLines = list[tuple[PanelMaterialManualLine, WerkstattArticle | None]]


def _article(item: Mapping[str, Any]) -> str:
    """What the report calls an item: its article number, else its line key."""
    return str(item.get("articleNo") or item["key"])


def _board(document: Any, catalog: EnclosureCatalog) -> tuple[tuple[dict[str, Any], ...], bool]:
    """(the items the board's list gains, "a meter field but no block"); raises on an unreadable board."""
    if not isinstance(document, dict) or not isinstance(document.get("rows", []), list):
        raise ValueError("unreadable document")
    readable = readable_blocks(document)  # what the Materialliste reads (D14)
    items = prep_material.prep_items(readable, catalog)
    missing = control_carrier(readable, catalog) is not None and stored_block(readable) is None
    return items, missing


def _manual_text(line: PanelMaterialManualLine, article: WerkstattArticle | None) -> str:
    """What a hand-added line says: its label, and its article's name, number and EAN."""
    fields = (line.label, *((article.item_name, article.article_number, article.ean) if article else ()))
    return " ".join(str(field) for field in fields if field).lower()


def _names(text_value: str, number: str) -> bool:
    """``number`` as a whole token: "K96F" is not in "K96FX"."""
    return re.search(rf"(?<![0-9a-z]){re.escape(number.lower())}(?![0-9a-z])", text_value) is not None


def _doubled_manual_lines(db: Session, items: Sequence[Mapping[str, Any]], manual: ManualLines) -> int:
    """Hand-added lines naming a part the board's list now derives (read-only, like the Materialliste)."""
    if not manual or not items:
        return 0
    lines = [prep_material.item_line(item) for item in items]
    numbers = prep_material.prep_article_numbers(items)
    resolved = material.resolve_line_articles(db, lines, numbers, {})
    article_ids = {article.id for article, _source in resolved.values()}
    return sum(1 for line, article in manual
               if line.article_id in article_ids
               or any(_names(_manual_text(line, article), number) for number in numbers.values()))


def _manual_lines_by_board(db: Session) -> dict[int, ManualLines]:
    rows = db.execute(
        select(PanelMaterialManualLine, WerkstattArticle)
        .outerjoin(WerkstattArticle, WerkstattArticle.id == PanelMaterialManualLine.article_id)
        .order_by(PanelMaterialManualLine.id.asc())
    ).all()
    out: dict[int, ManualLines] = {}
    for line, article in rows:
        out.setdefault(int(line.panel_id), []).append((line, article))
    return out


def _has_bookings(db: Session, plan_id: int) -> bool:
    """Net consumption left on the board: a booking fully undone shows nothing."""
    return any(entry.net > 0 for entry in material.consumed_by_article(db, plan_id).values())


def _article_counts(gains: Sequence[tuple[tuple[str, ...], bool]]) -> dict[str, dict[str, int]]:
    """article → {boards gaining it, of those booked}, by article; ``gains``: (articles, booked) per board."""
    names = sorted({name for articles, _ in gains for name in articles})
    return {name: {"boards": sum(1 for articles, _ in gains if name in articles),
                   "booked": sum(1 for articles, booked in gains if booked and name in articles)}
            for name in names}


def impact_report(db: Session) -> dict[str, Any]:
    """The counts of the module doc, read in one read-only transaction that is rolled back."""
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("SET TRANSACTION READ ONLY"))
    try:
        catalog = load_catalog(db)
        out: dict[str, Any] = {"boards": 0, "cabinet_boards": 0, "unreadable_boards": 0,
                               "boards_with_manual_lines_for_prep": 0, "manual_lines_for_prep": 0,
                               "boards_without_control_block": 0}
        gains: list[tuple[tuple[str, ...], bool]] = []
        manual = _manual_lines_by_board(db)
        for plan_id, document in db.execute(select(PanelPlan.id, PanelPlan.document).order_by(PanelPlan.id.asc())):
            out["boards"] += 1
            if not isinstance(document, dict) or enclosure_of(document) is None:
                continue
            try:
                items, missing = _board(document, catalog)
                doubled = _doubled_manual_lines(db, items, manual.get(int(plan_id), []))
            except Exception:  # noqa: BLE001 — a broken board is counted, never fatal to the report
                out["unreadable_boards"] += 1
                continue
            out["cabinet_boards"] += 1
            out["boards_without_control_block"] += int(missing)
            out["boards_with_manual_lines_for_prep"] += int(doubled > 0)
            out["manual_lines_for_prep"] += doubled
            names = tuple(dict.fromkeys(_article(item) for item in items))
            gains.append((names, bool(names) and _has_bookings(db, int(plan_id))))
        out["articles"] = _article_counts(gains)
        codes = db.scalars(select(PanelCatalogEntry.code).where(PanelCatalogEntry.code.in_(REPORT_CODES)))
        out["catalog_rows"] = sorted({str(code) for code in codes})
        return out
    finally:
        db.rollback()


def render(report: Mapping[str, Any]) -> str:
    """The report as the deploy notes quote it: German, counts, article numbers and codes only."""
    articles = [f"  {name}: {entry['boards']} (davon {entry['booked']} mit gebuchtem Material)"
                for name, entry in report["articles"].items()] or ["  keine"]
    return "\n".join((
        "Runde 4 — Zählerschrank-Vorbereitung: Auswirkung (nur Zählungen)",
        f"Pläne: {report['boards']}",
        f"Schrankpläne: {report['cabinet_boards']}",
        f"Unlesbare Pläne: {report['unreadable_boards']}",
        "Neue abgeleitete Zeilen je Artikel (Schrankpläne):",
        *articles,
        "Schrankpläne mit Handzeilen für jetzt abgeleitete Teile — vor dem nächsten Kommissionieren löschen"
        f" oder kürzen: {report['boards_with_manual_lines_for_prep']} ({report['manual_lines_for_prep']} Zeilen)",
        f"Schrankpläne mit Zählerfeld ohne §14a-Klemmleiste: {report['boards_without_control_block']}",
        f"Katalogzeilen zu {', '.join(REPORT_CODES)} (Sammelschienenzone unten gilt dort nicht — anpassen oder"
        f" zurücksetzen): {', '.join(report['catalog_rows']) or 'keine'}",
    ))


def main() -> int:
    from app.core.db import SessionLocal

    with SessionLocal() as db:
        print(render(impact_report(db)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
