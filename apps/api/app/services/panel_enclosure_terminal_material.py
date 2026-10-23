"""The WAGO share of a cabinet board's Materialliste (docs/PANEL_ENCLOSURE_R2.md §5).

On a board with a cabinet the terminals come from the placement, not from a
plain derivation:

* **Terminal lines**: ``terminal_bom`` over the groups derived WITH the
  board's skip set (``board_terminals``), so a circuit on an AAR, NAR, RfZ or
  APZ rail no longer counts, plus the rail parts the placement needs (one end
  plate per terminal rail that holds a strip, matching its last terminal
  block). They sort into ``TERMINAL_PART_ORDER`` with the terminals. A strip
  without place still counts its terminals (they must be bought) but adds
  no rail part: it has no rail. No end stops (owner, 2026-10-22).
* **U84T**: one rail-insulation set per terminal rail that holds a strip and
  is not insulated ab Werk (the RK fields' served spec carries the fitting
  ``u84t``). An admin who listed U84T as a module accessory meant the same
  physical sets, so the line takes the larger of the two counts, never the
  sum, and the derived label.
* **Matching**: the U84T line is matched by mapping, then the EAN of the
  owner-named article, then the article number "U84T" (a code constant here,
  not catalogue data: C§3.2 "no EANs in the catalogue" stands).

The detail route's terminal BOM is the same ``terminal_bom(…, extra=…)``, so
the Klemmen tab, the Klemmenliste PDF and the Materialliste agree.
"""

from __future__ import annotations

from typing import Any, Mapping

# Module references, not names: the list, the cabinet lines and this module
# import each other, and a module reference resolves at call time.
from app.services import panel_enclosure_material as enclosure_material
from app.services import schaltplan_material as material
from app.services.panel_enclosure_catalog import EnclosureCatalog
from app.services.panel_enclosure_terminals import (
    BoardTerminals,
    board_terminals,
    insulation_sets,
    place_terminals,
    terminal_rail_parts,
)
from app.services.schaltplan_terminals import terminal_bom

U84T_ARTICLE_NO = "U84T"
U84T_KEY = f"accessory:{U84T_ARTICLE_NO}"
#: Hager U84T, "Isolierstück univ. Z, mit Schrauben, Satz = 2 St." (hager.com).
U84T_RAIL_SET_EAN = "4010330552465"
U84T_LABEL = "Isolierstück univ. Z, mit Schrauben, Satz=2 St."
U84T_DETAIL = "Hutschienen-Isolierung je Klemmen-Hutschiene · Hager U84T"


def board_placement(document: Any, catalog: EnclosureCatalog, terms: BoardTerminals | None = None,
                    placement: Mapping[str, Any] | None = None) -> tuple[BoardTerminals, Mapping[str, Any]]:
    """(terms, placement): the ones given, else derived once."""
    terms = board_terminals(document, catalog) if terms is None else terms
    return terms, (place_terminals(document, catalog, terms) if placement is None else placement)


def terminal_lines(document: Any, catalog: EnclosureCatalog, terms: BoardTerminals | None = None,
                   placement: Mapping[str, Any] | None = None) -> list[material.PlannedLine]:
    """One ``part:{id}`` line per WAGO part: the terminals and the rail parts."""
    terms, placement = board_placement(document, catalog, terms, placement)
    return [
        material.PlannedLine(f"part:{row['part_id']}", material.LINE_TERMINAL, str(row["part_no"]), str(row["name"]),
                             int(row["count"]))
        for row in terminal_bom(terms.groups, extra=terminal_rail_parts(placement))
    ]


def u84t_line(admin_qty: int, rail_sets: int) -> material.PlannedLine | None:
    """The U84T line: ``max(admin accessories, derived sets)``; None when both are 0."""
    planned = max(int(admin_qty), int(rail_sets))
    if planned <= 0:
        return None
    return material.PlannedLine(U84T_KEY, material.LINE_ENCLOSURE, U84T_LABEL, U84T_DETAIL, planned)


def u84t_planned(document: Any, catalog: EnclosureCatalog, placement: Mapping[str, Any]) -> int:
    """How many U84T sets the board's list plans: ``max(admin, insulation_sets)``."""
    admin = enclosure_material.accessory_quantities(document, catalog).get(U84T_ARTICLE_NO, 0)
    return max(admin, insulation_sets(placement))


def line_eans(document: Any, catalog: EnclosureCatalog, placement: Mapping[str, Any]) -> dict[str, str]:
    """line key → the EAN its automatic match tries first; only for a planned U84T line."""
    return {U84T_KEY: U84T_RAIL_SET_EAN} if u84t_planned(document, catalog, placement) > 0 else {}
