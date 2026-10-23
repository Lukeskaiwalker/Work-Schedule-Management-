"""What round 2's WAGO placement changes on the stored boards (docs/PANEL_ENCLOSURE_R2.md §16).

Read-only, for the deploy session, run on production before the swap:

    cd apps/api
    PYTHONPATH=. python scripts/report_terminal_impact.py

It prints counts, plus the Hager catalogue codes that have a row of their
own, and nothing else: never a board, customer, project or device name. The
repo is public and the output lands in deploy notes. It reads the documents,
the ledger's consumption rows and the hand-added Materialliste lines; their
labels and articles are only compared with part numbers, never printed. It
runs its transaction READ ONLY on PostgreSQL and rolls it back at the end.

Counted:

* boards, and of them the readable boards with a cabinet;
* cabinet boards with devices on a now-reserved terminal rail, and those
  rows (a hand-placed "Reihenklemme N/PE" placeholder does not count): each
  gets ``encl.terminal_rail_devices`` with a suggestion, never a move;
* boards whose terminal numbering changes because an AAR, NAR, RfZ or APZ
  circuit had ``terminal_block``: their printed strips may need a reprint;
* RK placements: modules whose served spec has the fitting ``u84t``;
* catalogue rows for the RK codes and the four new codes (an override, or a
  custom row that became one): the owner keeps or resets each;
* unreadable boards: a document the derivations cannot read;
* hand-added Materialliste lines for a part round 2 now derives on that
  board (an end plate 2003-7692 / 2016-7691, a U84T set), and their boards:
  each doubles the article, and its booked pieces move to the derived line
  (review UPG-1). The owner deletes or shortens them before the next pick;
* renumbered boards that already have booked material: they plan fewer WAGO
  parts now, so the booked ones show "zu viel" or "nicht geplant" — the
  terminals are in the board, the bookings stay (review UPG-2).
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Mapping

API_ROOT = Path(__file__).resolve().parents[1]
if str(API_ROOT) not in sys.path:  # run as a plain script from apps/api
    sys.path.insert(0, str(API_ROOT))

from sqlalchemy import select, text  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.models.entities import WerkstattArticle  # noqa: E402
from app.models.schaltplan import PanelCatalogEntry, PanelMaterialManualLine, PanelPlan  # noqa: E402
from app.services import panel_enclosure_material as enclosure_material  # noqa: E402
from app.services import schaltplan_material as material  # noqa: E402
from app.services import panel_enclosure_terminal_material as terminal_material  # noqa: E402
from app.services.panel_enclosure_catalog import EnclosureCatalog, load_catalog  # noqa: E402
from app.services.panel_enclosure_layout import (  # noqa: E402
    dicts,
    enclosure_of,
    module_spec,
    modules_of,
    row_devices,
    rows_of,
)
from app.services.panel_enclosure_readable import readable_blocks  # noqa: E402
from app.services.panel_enclosure_terminals import (  # noqa: E402
    INSULATED_RAILS_FITTING,
    PLACEHOLDER_KINDS,
    board_terminals,
    terminal_rails,
)
from app.services.schaltplan_terminals import derive_terminals  # noqa: E402

#: ZU37RK/ZU59RK and the four codes round 2 adds (R15).
REPORT_CODES: tuple[str, ...] = ("ZU37RK", "ZU59RK", "ZU37V5RKAPZ2", "ZU59V7RKAPZ2", "ZH3ES5RK", "ZH53XSRK")
#: The lines round 2 derives that a v2.15.0 cabinet board could only get by
#: hand (review UPG-1): line key → what a hand-added line naming it contains.
NEW_LINE_TOKENS: dict[str, tuple[str, ...]] = {
    "part:2003-7692": ("2003-7692",),
    "part:2016-7691": ("2016-7691",),
    terminal_material.U84T_KEY: (terminal_material.U84T_ARTICLE_NO.lower(), terminal_material.U84T_RAIL_SET_EAN),
}

ManualLines = list[tuple[PanelMaterialManualLine, WerkstattArticle | None]]


def _numbering(groups: Any) -> list[tuple[str, str, tuple[str, ...]]]:
    """What a printed strip shows: strip id, X label and every marker."""
    return [(str(strip["strip_id"]), str(strip["x_label"]), tuple(str(t["label"]) for t in strip["terminals"]))
            for group in groups for strip in group["strips"]]


def _insulated(spec: Mapping[str, Any] | None) -> bool:
    return spec is not None and any(
        fitting.get("key") == INSULATED_RAILS_FITTING and not fitting.get("retired")
        for fitting in dicts(spec.get("fittings")))


def _reserved_rows(document: Any, catalog: EnclosureCatalog) -> int:
    rows = {row["id"]: row for row in rows_of(document)}
    return sum(
        1 for rails in terminal_rails(document, catalog).values() for rail in rails
        if rail.row_id and any(str(device.get("kind") or "") not in PLACEHOLDER_KINDS
                               for device in row_devices(rows.get(rail.row_id)))
    )


def _board(document: Any, catalog: EnclosureCatalog) -> dict[str, int]:
    """One cabinet board's counts; raises on a document the derivations cannot read."""
    if not isinstance(document, dict) or not isinstance(document.get("rows", []), list):
        raise ValueError("unreadable document")
    reserved = _reserved_rows(document, catalog)
    renumbered = _numbering(derive_terminals(document)) != _numbering(board_terminals(document, catalog).groups)
    rk = sum(1 for module in modules_of(document) if _insulated(module_spec(module, catalog)))
    return {"reserved_rows": reserved, "renumbered": int(renumbered), "rk": rk}


def _manual_text(line: PanelMaterialManualLine, article: WerkstattArticle | None) -> str:
    """What a hand-added line says: its label, and its article's name, number and EAN."""
    fields = (line.label, *((article.item_name, article.article_number, article.ean) if article else ()))
    return " ".join(str(field) for field in fields if field).lower()


def _doubled_manual_lines(db: Session, document: Any, catalog: EnclosureCatalog, manual: ManualLines) -> int:
    """Hand-added lines naming a part the board's list now derives (review UPG-1).

    A line counts when its article is the one the derived line resolves to
    (it would take that line's bookings), or when its text names the part
    (it doubles the planned total). Read-only, like the Materialliste.
    """
    if not manual:
        return 0
    readable = readable_blocks(document)  # what the Materialliste reads (D14)
    if not enclosure_material.has_enclosure(readable):
        return 0
    terms, placement = terminal_material.board_placement(readable, catalog)
    planned = material.planned_lines(readable, catalog, terms=terms, placement=placement)
    new_lines = [line for line in planned if line.key in NEW_LINE_TOKENS]
    if not new_lines:
        return 0
    resolved = material.resolve_line_articles(
        db, new_lines, enclosure_material.line_article_numbers(readable, catalog),
        terminal_material.line_eans(readable, catalog, placement))
    article_ids = {article.id for article, _source in resolved.values()}
    tokens = [token for line in new_lines for token in NEW_LINE_TOKENS[line.key]]
    return sum(1 for line, article in manual
               if line.article_id in article_ids or any(token in _manual_text(line, article) for token in tokens))


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
    """Net consumption left on the board: a booking fully undone shows no "zu viel"."""
    return any(entry.net > 0 for entry in material.consumed_by_article(db, plan_id).values())


def impact_report(db: Session) -> dict[str, Any]:
    """The counts of §16, read in one read-only transaction that is rolled back."""
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("SET TRANSACTION READ ONLY"))
    try:
        catalog = load_catalog(db)
        out: dict[str, Any] = {
            "boards": 0, "cabinet_boards": 0, "boards_with_devices_on_terminal_rails": 0,
            "rows_with_devices_on_terminal_rails": 0, "boards_renumbered": 0, "rk_placements": 0,
            "unreadable_boards": 0, "boards_with_manual_lines_for_new_parts": 0, "manual_lines_for_new_parts": 0,
            "boards_renumbered_with_bookings": 0,
        }
        manual = _manual_lines_by_board(db)
        for plan_id, document in db.execute(select(PanelPlan.id, PanelPlan.document).order_by(PanelPlan.id.asc())):
            out["boards"] += 1
            if not isinstance(document, dict) or enclosure_of(document) is None:
                continue
            try:
                counts = _board(document, catalog)
                doubled = _doubled_manual_lines(db, document, catalog, manual.get(int(plan_id), []))
            except Exception:  # noqa: BLE001 — a broken board is counted, never fatal to the report
                out["unreadable_boards"] += 1
                continue
            out["boards_with_manual_lines_for_new_parts"] += int(doubled > 0)
            out["manual_lines_for_new_parts"] += doubled
            out["boards_renumbered_with_bookings"] += int(bool(counts["renumbered"]) and _has_bookings(db, int(plan_id)))
            out["cabinet_boards"] += 1
            out["boards_with_devices_on_terminal_rails"] += int(counts["reserved_rows"] > 0)
            out["rows_with_devices_on_terminal_rails"] += counts["reserved_rows"]
            out["boards_renumbered"] += counts["renumbered"]
            out["rk_placements"] += counts["rk"]
        codes = db.scalars(select(PanelCatalogEntry.code).where(PanelCatalogEntry.code.in_(REPORT_CODES)))
        out["catalog_rows"] = sorted({str(code) for code in codes})
        return out
    finally:
        db.rollback()


def render(report: Mapping[str, Any]) -> str:
    """The report as the deploy notes quote it: German, counts and catalogue codes only."""
    codes = ", ".join(report["catalog_rows"]) or "keine"
    return "\n".join((
        "Runde 2 — WAGO-Reihenklemmen im Schrank: Auswirkung (nur Zählungen)",
        f"Pläne: {report['boards']}",
        f"Schrankpläne: {report['cabinet_boards']}",
        f"Schrankpläne mit Geräten auf den reservierten Hutschienen: {report['boards_with_devices_on_terminal_rails']}"
        f" ({report['rows_with_devices_on_terminal_rails']} Reihen)",
        f"Schrankpläne mit neuer Klemmennummerierung (Klemmen neu drucken): {report['boards_renumbered']}",
        f"RK-Felder (U84T ab Werk): {report['rk_placements']}",
        f"Unlesbare Pläne: {report['unreadable_boards']}",
        "Schrankpläne mit Handzeilen für jetzt abgeleitete Teile (Endplatte, U84T) — vor dem nächsten"
        f" Kommissionieren löschen oder kürzen: {report['boards_with_manual_lines_for_new_parts']}"
        f" ({report['manual_lines_for_new_parts']} Zeilen)",
        "Neu nummerierte Schrankpläne mit gebuchtem Material — WAGO „zu viel“/„nicht geplant“ dort"
        f" nicht zurückbuchen: {report['boards_renumbered_with_bookings']}",
        f"Katalogzeilen zu RK- und neuen Codes (behalten oder zurücksetzen): {codes}",
    ))


def main() -> int:
    from app.core.db import SessionLocal

    with SessionLocal() as db:
        print(render(impact_report(db)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
