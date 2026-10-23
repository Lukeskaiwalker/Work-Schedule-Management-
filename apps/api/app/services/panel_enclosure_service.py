"""What the plan routes need from the cabinet layer, in one place.

docs/PANEL_ENCLOSURE.md §2.2, §5, §7, §13. Kept out of
``routers/workflow_schaltplan.py`` so that file stays a plan router (and
under 800 lines): the detail findings, the write-path code check, the copy
that forgets meter numbers, and the Aufbau PDF are each one call from there.
So is the board's WAGO view (docs/PANEL_ENCLOSURE_R2.md §3.1, §5.1): on a
cabinet board the legend, the Stückliste, the label print and the Plan PDF
number the terminals with the same skip set, and every Stückliste carries
the rail parts. Each reads the board through ``readable_blocks`` (D14): a
stored cabinet block the types refuse is left out everywhere, not only on
the screen.

The catalogue is loaded only for a board that has a cabinet: a legacy board
must cost exactly what it cost before (one query fewer per detail read).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.customer import Customer
from app.models.entities import Project
from app.models.schaltplan import PanelPlan
from app.services import schaltplan_material
from app.services.panel_enclosure_catalog import EnclosureCatalog, assert_known_codes, load_catalog
from app.services.panel_enclosure_layout import dicts, enclosure_of
from app.services.panel_enclosure_pdf import build_aufbau_pdf
from app.services.panel_enclosure_readable import INVALID_BLOCK, readable_blocks, readable_document
from app.services.panel_enclosure_rules import enclosure_findings
from app.services.panel_enclosure_terminals import (
    BoardTerminals,
    board_terminals,
    place_terminals,
    terminal_rail_parts,
    terminal_skip,
)
from app.services.runtime_settings import get_company_settings
from app.services.schaltplan_terminals import derive_terminals

NO_CABINET = "Für diesen Verteiler ist kein Schrank geplant."

__all__ = [
    "INVALID_BLOCK", "NO_CABINET", "TerminalView", "assert_known_codes", "aufbau_pdf", "board_terminal_skip",
    "detail_findings", "readable_blocks", "readable_document", "terminal_view", "without_meter_numbers",
]


@dataclass(frozen=True)
class TerminalView:
    """A board's WAGO terminals as every plan route reads them (R2 §3.1, §5.1).

    ``skip`` and ``groups`` give every caller the same X numbers; the
    Stückliste is ``terminal_bom(groups, extra=rail_parts)``, equal to the
    Materialliste's terminal lines. Without a cabinet: no skip, no rail
    parts, the groups as before — and no catalogue read.
    """

    skip: frozenset[str]
    groups: tuple[dict[str, Any], ...]
    rail_parts: Mapping[str, int] = field(default_factory=dict)
    catalog: EnclosureCatalog | None = None
    terms: BoardTerminals | None = None
    placement: Mapping[str, Any] | None = None


def terminal_view(db: Session, document: Any) -> TerminalView:
    """The board's terminals, placed once; the catalogue is loaded only for a
    cabinet. A stored block the types refuse is left out, as on the screen."""
    document = readable_blocks(document)
    if enclosure_of(document) is None:
        return TerminalView(frozenset(), tuple(derive_terminals(document)))
    catalog = load_catalog(db)
    terms = board_terminals(document, catalog)
    placement = place_terminals(document, catalog, terms)
    return TerminalView(terms.skip, terms.groups, terminal_rail_parts(placement), catalog, terms, placement)


def board_terminal_skip(db: Session, document: Any) -> frozenset[str]:
    """The devices that get no Reihenklemme on this board (R2 §3.1); empty
    without a cabinet, and with a stored block the types refuse."""
    document = readable_blocks(document)
    if enclosure_of(document) is None:
        return frozenset()
    return terminal_skip(document, load_catalog(db))


def detail_findings(db: Session, document: Any, view: TerminalView | None = None) -> list[dict[str, str]]:
    """The cabinet findings appended to ``validate_document``'s; [] without a cabinet.
    ``view``: the board's ``terminal_view``, so nothing is placed twice."""
    if enclosure_of(document) is None:
        return []
    if view is None or view.catalog is None:
        return enclosure_findings(document, load_catalog(db))
    return enclosure_findings(document, view.catalog, view.terms, view.placement)


def without_meter_numbers(document: Any) -> Any:
    """A copy of the board whose meters keep place and label but no number.

    A meter number identifies one physical meter (§2.1); a duplicated board
    is a second cabinet with meters of its own. Everything else is shared,
    unchanged, with the source document — nothing is mutated.
    """
    enclosure = enclosure_of(document)
    if enclosure is None:
        return document
    modules = enclosure.get("modules")
    if not isinstance(modules, list):
        return document
    cleared = [
        {**module, "meters": [{**meter, "number": ""} for meter in dicts(module.get("meters"))]}
        if isinstance(module, dict) and isinstance(module.get("meters"), list) else module
        for module in modules
    ]
    return {**document, "enclosure": {**enclosure, "modules": cleared}}


def aufbau_pdf(db: Session, plan: PanelPlan) -> bytes:
    """The Aufbau sheet, the WAGO close-up pages (R2 §7.3) and the Materialliste
    pages (§13); 409 without a cabinet — also when the stored block is one the
    types refuse, which the Schrank tab and the Materialliste leave out (D14)."""
    document = plan.document or {}
    if enclosure_of(readable_blocks(document)) is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=NO_CABINET)
    catalog = load_catalog(db)
    terms = board_terminals(document, catalog)
    placement = place_terminals(document, catalog, terms)
    customer = db.get(Customer, plan.customer_id)
    project = db.get(Project, plan.project_id) if plan.project_id else None
    return build_aufbau_pdf(
        plan=plan,
        catalog=catalog,
        material=schaltplan_material.panel_material(db, plan, catalog),
        findings=enclosure_findings(document, catalog, terms, placement),
        customer_name=getattr(customer, "name", None),
        project_label=f"{project.project_number} · {project.name}" if project is not None else None,
        company_name=get_company_settings(db).get("company_name"),
        terms=terms,
        placement=placement,
    )
