"""The WAGO terminal findings of a cabinet board (R2 §4.1).

Twin of ``apps/web/src/utils/enclosureTerminalRules.ts``; pinned on
``enclosureFixtures.json`` through ``findings``. ``enclosure_findings``
(``panel_enclosure_rules``) calls ``terminal_findings`` with the board's
precomputed terminals and placement and sorts the result with the rest.

Ten rules, in ``TERMINAL_RULE_ORDER``. Decisions both twins keep:

* "Feld n" is the 0-based field + 1; ``{mm}`` uses ``mm_text``;
* ``encl.terminals`` counts every terminal of the field's placed strips
  (end clamps included, plates not) and sums ``usedMm`` / ``capacityMm``
  over both terminal rails;
* ``encl.terminals_overflow`` is info while ``TERMINAL_RAIL_USABLE_VERIFIED``
  is false and says which usable length it assumed;
* ``encl.terminals_split`` and ``encl.terminals_head_field`` name the field
  a strip's terminals go to — its home field, or for a strip R6 sent on, the
  field it was sent to (the N feed wire runs to where the terminals are);
* ``{Xlist}``: X labels in strip order joined with ", ", at most four, then
  `` und {k} weitere``.

The trailing sentence of the overflow and reserved-rail findings comes from
``panel_enclosure_terminal_suggest.suggestion_pass``, the same pass that
makes the action. Never raises: a finding must not take a board's page down.
"""

from __future__ import annotations

import logging
from typing import Any, Iterator, Mapping, Sequence

from app.services import panel_enclosure_terminals as terminals
from app.services.panel_enclosure_catalog import EnclosureCatalog
from app.services.panel_enclosure_geometry import mm_text
from app.services.panel_enclosure_layout import (
    enclosure_of,
    ident,
    linked_rows,
    resolvable_rails,
    row_devices,
    rows_of,
    text,
    zone_label,
)
from app.services.panel_enclosure_terminal_suggest import SuggestionPass, is_placeholder, join_and, suggestion_pass
from app.services.panel_enclosure_terminals import BoardTerminals, board_terminals, device_fields, place_terminals
from app.services.schaltplan_layout import DEVICE_CATALOG
from app.services.schaltplan_terminal_rules import OUTGOING_PART_IDS, group_head_label, has_terminal
from app.services.schaltplan_terminals import STRIP_KIND_LEISTE

logger = logging.getLogger(__name__)

TERMINAL_RULE_ORDER: tuple[str, ...] = (
    "encl.terminals", "encl.terminals_overflow", "encl.terminal_order_ignored", "encl.terminal_rail_devices",
    "encl.terminal_placeholders", "encl.terminals_elsewhere", "encl.terminals_no_field", "encl.terminals_split",
    "encl.terminals_head_field", "encl.terminals_zone",
)
XLIST_MAX = 4

Finding = dict[str, str]


def _finding(rule: str, level: str, scope: str, message: str) -> Finding:
    return {"level": level, "scope": scope, "message": message, "rule": rule}


def _xlist(labels: Sequence[str]) -> str:
    shown = ", ".join(labels[:XLIST_MAX])
    return f"{shown} und {len(labels) - XLIST_MAX} weitere" if len(labels) > XLIST_MAX else shown


def _bmk(device: Mapping[str, Any]) -> str:
    entry = DEVICE_CATALOG.get(str(device.get("kind") or ""))
    return text(device.get("designation")) or (str(entry["short"]) if entry is not None else text(device.get("kind")) or "?")


def _row_name(row: Mapping[str, Any]) -> str:
    return text(row.get("label")) or str(row.get("id"))


class _Board:
    """What the ten checks read, computed once."""

    def __init__(self, document: Any, catalog: EnclosureCatalog, terms: BoardTerminals,
                 placement: Mapping[str, Any]) -> None:
        self.document = document
        self.catalog = catalog
        self.placement = placement
        self.fields: list[Mapping[str, Any]] = list(placement.get("fields") or [])
        self.rows = {row["id"]: row for row in rows_of(document)}
        self.strips = {strip["strip_id"]: (group, strip) for group in terms.groups for strip in group["strips"]}
        self.numbers = {strip_id: int(strip["strip_no"]) for strip_id, (_, strip) in self.strips.items()}
        self.fields_of = device_fields(document, catalog)
        self.skip = terms.skip
        self.target: dict[str, int] = {}  # strip id → the field its terminals go to
        for field in self.fields:
            for rail in field["rails"]:
                for strip in rail["strips"]:
                    self.target[strip["stripId"]] = field["field"]
            for strip in field["unplaced"]:
                self.target[strip["stripId"]] = field["field"]

    def x_label(self, strip_id: str) -> str:
        entry = self.strips.get(strip_id)
        return str(entry[1]["x_label"]) if entry is not None else strip_id

    def terminal_rows(self) -> Iterator[Mapping[str, Any]]:
        for field in self.fields:
            for rail in field["rails"]:
                row = self.rows.get(rail.get("rowId")) if rail.get("rowId") else None
                if row is not None:
                    yield row


def _placed(board: _Board, pass_: SuggestionPass) -> Iterator[Finding]:
    for field in board.fields:
        placed = [strip["stripId"] for rail in field["rails"] for strip in rail["strips"]]
        if not placed:
            continue
        count = sum(len(board.strips[strip_id][1]["terminals"]) for strip_id in placed if strip_id in board.strips)
        used = cap = 0.0
        for rail in field["rails"]:
            used += rail["usedMm"]
            cap += rail["capacityMm"]
        yield _finding("encl.terminals", "info", "",
                       f"Feld {field['field'] + 1}: {count} Reihenklemmen auf den oberen Hutschienen, "
                       f"{mm_text(used)} von {mm_text(cap)} mm belegt.")


def _overflow(board: _Board, pass_: SuggestionPass) -> Iterator[Finding]:
    verified = terminals.TERMINAL_RAIL_USABLE_VERIFIED
    assumed = "" if verified else f", Nutzlänge {mm_text(terminals.TERMINAL_RAIL_USABLE_MM)} mm je Hutschiene angenommen"
    for field in board.fields:
        if not field["unplaced"] or not field["rails"]:
            continue
        yield _finding("encl.terminals_overflow", "warn" if verified else "info", field["rails"][0]["moduleId"],
                       f"Feld {field['field'] + 1}: {len(field['unplaced'])} Klemmleiste(n) passen nicht auf die zwei "
                       f"oberen Hutschienen ({mm_text(field['missingMm'])} mm ohne Platz{assumed}) — eine dritte "
                       "Hutschiene wird nicht belegt." + pass_.overflow_sentences.get(field["field"], ""))


def _order_ignored(board: _Board, pass_: SuggestionPass) -> Iterator[Finding]:
    for field in board.fields:
        if field["order"] == terminals.ORDER_IGNORED:
            yield _finding("encl.terminal_order_ignored", "info", str(field.get("orderModuleId") or ""),
                           f"Feld {field['field'] + 1}: Die manuelle Aufteilung der Klemmleisten passt nicht mehr — "
                           "automatisch verteilt.")


def _rail_devices(board: _Board, pass_: SuggestionPass) -> Iterator[Finding]:
    for row in board.terminal_rows():
        count = sum(1 for device in row_devices(row) if not is_placeholder(device))
        if count:
            yield _finding("encl.terminal_rail_devices", "warn", row["id"],
                           f"{_row_name(row)}: Hutschiene ist für Reihenklemmen reserviert — {count} Gerät(e) tiefer "
                           "setzen." + pass_.row_sentences.get(row["id"], ""))


def _placeholders(board: _Board, pass_: SuggestionPass) -> Iterator[Finding]:
    for row in board.terminal_rows():
        count = sum(1 for device in row_devices(row) if is_placeholder(device))
        if count:
            yield _finding("encl.terminal_placeholders", "info", row["id"],
                           f"{_row_name(row)}: {count} Platzhalter-Reihenklemme(n) — Reihenklemmen werden jetzt aus "
                           "den Stromkreisen abgeleitet.")


def _elsewhere(board: _Board, pass_: SuggestionPass) -> Iterator[Finding]:
    by_home: dict[int, list[Mapping[str, Any]]] = {}
    for entry in board.placement.get("elsewhere") or []:
        by_home.setdefault(int(entry["homeField"]), []).append(entry)
    for home in sorted(by_home):
        entries = by_home[home]
        labels = [board.x_label(entry["stripId"]) for entry in entries]
        yield _finding("encl.terminals_elsewhere", "info", "",
                       f"Feld {home + 1} hat keine Hutschienen für Reihenklemmen — {_xlist(labels)} in Feld "
                       f"{int(entries[0]['field']) + 1}.")


def _no_field(board: _Board, pass_: SuggestionPass) -> Iterator[Finding]:
    strip_ids = [*(board.placement.get("outside") or []), *(board.placement.get("noRails") or [])]
    if strip_ids:
        ordered = sorted(dict.fromkeys(strip_ids), key=lambda strip_id: (board.numbers.get(strip_id, 0), strip_id))
        yield _finding("encl.terminals_no_field", "info", "",
                       f"{_xlist([board.x_label(s) for s in ordered])}: kein Platz für Reihenklemmen — Stromkreise "
                       "nicht in einem Verteilerfeld.")


def _leisten(board: _Board) -> Iterator[tuple[str, Mapping[str, Any], Mapping[str, Any], int]]:
    """(strip id, group, strip, target field) of every Leiste that goes to a field, in strip order."""
    for strip_id, (group, strip) in sorted(board.strips.items(), key=lambda item: board.numbers[item[0]]):
        if strip["kind"] == STRIP_KIND_LEISTE and strip_id in board.target:
            yield strip_id, group, strip, board.target[strip_id]


def _split(board: _Board, pass_: SuggestionPass) -> Iterator[Finding]:
    for _, group, strip, target in _leisten(board):
        fields = sorted({board.fields_of[t["device_id"]] for t in strip["terminals"]
                         if t["part_id"] in OUTGOING_PART_IDS and t.get("device_id") in board.fields_of})
        if len(fields) >= 2:
            head = group_head_label({"device": group.get("head_device")})
            yield _finding("encl.terminals_split", "info", "",
                           f"{strip['x_label']} ({head}): Stromkreise in Feld {join_and([str(f + 1) for f in fields])} — "
                           f"Reihenklemmen in Feld {target + 1}.")


def _head_field(board: _Board, pass_: SuggestionPass) -> Iterator[Finding]:
    for _, group, strip, target in _leisten(board):
        head = group.get("head_device")
        head_field = board.fields_of.get(ident(head.get("id"))) if isinstance(head, Mapping) else None
        if head_field is not None and head_field != target:
            yield _finding("encl.terminals_head_field", "info", "",
                           f"{strip['x_label']} ({group_head_label({'device': head})}): Schutzgerät in Feld "
                           f"{head_field + 1}, Klemmen in Feld {target + 1} — N-Zuleitung über die Feldgrenze.")


def _zone(board: _Board, pass_: SuggestionPass) -> Iterator[Finding]:
    if not board.skip:
        return
    zones: dict[str, Mapping[str, Any]] = {}
    rails_of: dict[str, dict[str, tuple[dict, dict]]] = {}
    enclosure = enclosure_of(board.document) or {}
    modules = {ident(m.get("id")): m for m in enclosure.get("modules") or [] if isinstance(m, dict)}
    for row_id, (module_id, key) in linked_rows(board.document, board.catalog).items():
        if module_id not in rails_of:
            rails_of[module_id] = resolvable_rails(modules.get(module_id, {}), board.catalog)
        if key in rails_of[module_id]:
            zones[row_id] = rails_of[module_id][key][0]
    for row_id, row in board.rows.items():
        zone = zones.get(row_id)
        for device in row_devices(row):
            if zone is not None and ident(device.get("id")) in board.skip and has_terminal(device):
                yield _finding("encl.terminals_zone", "info", ident(device.get("id")),
                               f"{_bmk(device)}: im {zone_label(zone)} — keine Reihenklemme (nur in Verteilerfeldern).")


_CHECKS = (_placed, _overflow, _order_ignored, _rail_devices, _placeholders, _elsewhere, _no_field, _split,
           _head_field, _zone)


def terminal_findings(document: Any, catalog: EnclosureCatalog, terms: BoardTerminals | None = None,
                      placement: Mapping[str, Any] | None = None) -> list[Finding]:
    """The terminal findings of a cabinet board, in check order; [] without a cabinet. Never raises."""
    try:
        if enclosure_of(document) is None:
            return []
        terms = board_terminals(document, catalog) if terms is None else terms
        placement = place_terminals(document, catalog, terms) if placement is None else placement
        board = _Board(document, catalog, terms, placement)
        pass_ = suggestion_pass(document, catalog, terms, placement)
        return [finding for check in _CHECKS for finding in check(board, pass_)]
    except Exception:  # noqa: BLE001 — a finding must never take a board's page down
        # Last resort only: the readers are tolerant by construction, and the
        # tests assert this line is never reached on garbage documents.
        logger.exception("terminal findings failed for a board; showing none")
        return []
