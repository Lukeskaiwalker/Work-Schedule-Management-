"""What to do about the terminal findings: one sequential pass (R2 §4.2).

Twin of ``apps/web/src/utils/enclosureTerminalSuggest.ts``; pinned on
``enclosureFixtures.json`` (``terminal_suggestions``). The finding's sentence
comes out of the same pass as the action (``suggestion_pass``), so the text
and the button cannot disagree. ``taken`` (rails already named as a target)
carries through all steps:

1. **Vacate** (``relink_rows``), per field with reserved rows, ascending: the
   field's terminal-rail rows that hold real devices move together onto the
   first field (same field first, then by ``(|Δ|, index)``) with that many
   eligible rails, top → bottom; failing that, each row onto the first
   eligible rail anywhere, in the same order. Eligible: a non-reserved,
   non-retired VT rail without a row or with an empty one, not taken, whose
   PLE length holds the row.
2. **Hypothetical board**: if step 1 moved anything, the board is re-placed
   as if it were done, and every overflowing field says whether vacating
   alone would make its strips fit. No move is suggested anywhere then.
3. **Move a group** (``move_group``, only without a vacate), per overflowing
   field ascending: the first unplaced strip of the field's own (strips R6
   brought in are skipped) whose group has a head. The head and the group's
   circuits on the field's rails travel together (owner, 2026-10-22: an FI
   moves with its circuits) onto the shortest prefix of another field's
   eligible rails that takes them, fields by ``(|Δ|, index)``. A field is
   accepted only when a virtual move and a re-placement show fewer unplaced
   strips and no placed strip lost its place.
4. ``reset_order`` for an ignored manual order, ``remove_placeholders`` for
   the hand-placed "Reihenklemme N/PE" on terminal rails.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from dataclasses import field as dataclass_field
from typing import Any, Mapping, Sequence

from app.services.panel_enclosure_catalog import EnclosureCatalog
from app.services.panel_enclosure_geometry import mm_text
from app.services.panel_enclosure_layout import (
    enclosure_device_width_mm,
    enclosure_of,
    ident,
    physical_row_order,
    row_devices,
    rows_of,
)
from app.services.panel_enclosure_terminal_virtual import RailRef, fill_rails, virtual_move, virtual_relink, vt_rails
from app.services.panel_enclosure_terminals import (
    ORDER_IGNORED,
    PLACEHOLDER_KINDS,
    TOLERANCE_MM,
    BoardTerminals,
    board_terminals,
    device_fields,
    place_terminals,
)
from app.services.schaltplan_layout import build_topology
from app.services.schaltplan_terminal_rules import group_head_label

RULE_RAIL_DEVICES = "encl.terminal_rail_devices"
RULE_OVERFLOW = "encl.terminals_overflow"
RULE_ORDER_IGNORED = "encl.terminal_order_ignored"
RULE_PLACEHOLDERS = "encl.terminal_placeholders"

VACATE_NOWHERE = " Keine leere Hutschiene frei — Geräte einzeln wegziehen (gedrückt halten)."
VACATE_FIRST_FITS = " Zuerst die reservierten Hutschienen räumen (Vorschlag „umhängen“) — danach passen alle Klemmleisten."
MOVE_NONE = " Kein anderes Feld hat genug Platz — Verteilerfeld ergänzen oder bei einzelnen Stromkreisen „Reihenklemme“ abwählen."
MOVE_SUPPLY = " Stromkreise vor dem ersten Schutzgerät — einzeln in ein anderes Feld ziehen."


@dataclass(frozen=True)
class SuggestionPass:
    """The pass's actions, and the sentences their findings end with."""

    suggestions: tuple[dict[str, Any], ...] = ()
    row_sentences: Mapping[str, str] = dataclass_field(default_factory=dict)       # reserved row id → sentence
    overflow_sentences: Mapping[int, str] = dataclass_field(default_factory=dict)  # field → sentence


def join_and(items: Sequence[str]) -> str:
    """"a", "a und b", "a, b und c"."""
    if len(items) <= 1:
        return "".join(items)
    return f"{', '.join(items[:-1])} und {items[-1]}"


def is_placeholder(device: Mapping[str, Any]) -> bool:
    return str(device.get("kind") or "") in PLACEHOLDER_KINDS


def reserved_rows(document: Any, placement: Mapping[str, Any]) -> dict[int, list[dict[str, Any]]]:
    """field → the rows linked to its terminal rails, in rail order."""
    rows = {row["id"]: row for row in rows_of(document)}
    out: dict[int, list[dict[str, Any]]] = {}
    for field in placement.get("fields") or []:
        found = [rows[rail["rowId"]] for rail in field["rails"] if rail.get("rowId") in rows]
        if found:
            out[field["field"]] = found
    return out


def _real(row: Mapping[str, Any]) -> list[dict[str, Any]]:
    return [device for device in row_devices(row) if not is_placeholder(device)]


def _place_key(ref: RailRef) -> tuple[str, str]:
    return (ref.module_id, ref.key)


def _eligible(ref: RailRef, reserved: frozenset[tuple[str, str]], taken: frozenset[tuple[str, str]]) -> bool:
    return (_place_key(ref) not in reserved and _place_key(ref) not in taken and not ref.rail.get("retired")
            and not row_devices(ref.row))


def _holds(ref: RailRef, row: Mapping[str, Any]) -> bool:
    width = 0.0
    for device in row_devices(row):
        width += enclosure_device_width_mm(device, ref.rail)
    return width <= ref.capacity_mm + TOLERANCE_MM


@dataclass(frozen=True)
class _Context:
    """What every step reads; ``taken`` grows step by step as a new context."""

    document: Any
    catalog: EnclosureCatalog
    placement: Mapping[str, Any]
    vt: Mapping[int, Sequence[RailRef]]
    reserved: frozenset[tuple[str, str]]
    taken: frozenset[tuple[str, str]] = frozenset()

    def free(self, field: int) -> list[RailRef]:
        return [ref for ref in self.vt.get(field, []) if _eligible(ref, self.reserved, self.taken)]

    def taking(self, refs: Sequence[RailRef]) -> _Context:
        return replace(self, taken=self.taken | {_place_key(ref) for ref in refs})

    def by_distance(self, field: int, candidates: Sequence[int]) -> list[int]:
        return sorted(candidates, key=lambda m: (abs(m - field), m))


# ── 1. vacate ────────────────────────────────────────────────────────────────


def _vacate_targets(ctx: _Context, field: int,
                    rows: Sequence[Mapping[str, Any]]) -> tuple[list[RailRef | None], _Context]:
    order = ctx.by_distance(field, list(ctx.vt))
    for m in order:
        free = ctx.free(m)
        if len(free) >= len(rows) and all(_holds(free[k], row) for k, row in enumerate(rows)):
            return list(free[:len(rows)]), ctx.taking(free[:len(rows)])
    targets: list[RailRef | None] = []
    for row in rows:
        target = next((ref for m in order for ref in ctx.free(m) if _holds(ref, row)), None)
        if target is not None:
            ctx = ctx.taking([target])
        targets.append(target)
    return targets, ctx


def _vacate(ctx: _Context,
            rows_of_field: Mapping[int, list[dict[str, Any]]]) -> tuple[list[dict], dict[str, str], _Context]:
    suggestions: list[dict[str, Any]] = []
    sentences: dict[str, str] = {}
    for field in sorted(rows_of_field):
        rows = [row for row in rows_of_field[field] if _real(row)]
        if not rows:
            continue
        targets, ctx = _vacate_targets(ctx, field, rows)
        sentence = ""
        moves = [{"rowId": row["id"], "target": ref.target()} for row, ref in zip(rows, targets) if ref is not None]
        if moves:
            titles = join_and([move["target"]["title"] for move in moves])
            sentence = f" Vorschlag: {'Reihe' if len(moves) == 1 else 'Reihen'} auf {titles} umhängen."
            suggestions.append({"rule": RULE_RAIL_DEVICES, "field": field, "kind": "relink_rows",
                                "scopes": [move["rowId"] for move in moves], "moves": moves})
        for row, ref in zip(rows, targets):
            sentences[row["id"]] = sentence if ref is not None else VACATE_NOWHERE
    return suggestions, sentences, ctx


# ── 2. the hypothetical board ────────────────────────────────────────────────


def _after_vacate(ctx: _Context, moves: list[dict[str, Any]],
                  overflowing: Sequence[Mapping[str, Any]]) -> dict[int, str]:
    relinked = virtual_relink(ctx.document, ctx.catalog, moves)
    after = {field["field"]: field for field in place_terminals(relinked, ctx.catalog)["fields"]}
    sentences: dict[int, str] = {}
    for field in overflowing:
        again = after.get(field["field"])
        if again is None or not again["unplaced"]:
            sentences[field["field"]] = VACATE_FIRST_FITS
        else:
            missing = mm_text(again["missingMm"])
            sentences[field["field"]] = f" Zuerst die reservierten Hutschienen räumen — danach fehlen noch {missing} mm."
    return sentences


# ── 3. move a group ──────────────────────────────────────────────────────────


def _strip_groups(terms: BoardTerminals) -> dict[str, Mapping[str, Any]]:
    return {strip["strip_id"]: group for group in terms.groups for strip in group["strips"]}


def _group_devices(ctx: _Context, head: Mapping[str, Any], field: int) -> list[str]:
    """The head and its group's circuits on the field's rails, in reading order."""
    head_id = ident(head.get("id"))
    fields_of = device_fields(ctx.document, ctx.catalog)
    topology = build_topology(dict(ctx.document))
    group = next((g for g in topology["groups"]
                  if g["device"] is not None and ident(g["device"].get("id")) == head_id), None)
    members = {head_id} | {ident(child.get("id")) for child in (group or {}).get("children", [])
                           if fields_of.get(ident(child.get("id"))) == field}
    rows = {row["id"]: row for row in rows_of(ctx.document)}
    ordered: list[str] = []
    for row_id in physical_row_order(ctx.document, ctx.catalog):
        for device in row_devices(rows.get(row_id)):
            device_id = ident(device.get("id"))
            if device_id in members and device_id not in ordered:
                ordered.append(device_id)
    return ordered


def _counts(placement: Mapping[str, Any]) -> tuple[set[str], set[str]]:
    placed = {s["stripId"] for f in placement["fields"] for rail in f["rails"] for s in rail["strips"]}
    unplaced = {u["stripId"] for f in placement["fields"] for u in f["unplaced"]}
    return placed, unplaced


def _try_move(ctx: _Context, field: int, device_ids: list[str]) -> list[RailRef] | None:
    """The first other field's rails that take the group and really place more, or None."""
    devices_by_id = {ident(d.get("id")): d for row in rows_of(ctx.document) for d in row_devices(row)}
    devices = [devices_by_id[i] for i in device_ids if i in devices_by_id]
    placed, unplaced = _counts(ctx.placement)
    fields = [f["field"] for f in ctx.placement["fields"] if f["field"] != field]
    for m in ctx.by_distance(field, fields):
        free = ctx.free(m)
        assignment, complete = fill_rails(devices, free)
        if not complete or not assignment:
            continue
        targets = free[:max(assignment) + 1]
        moved = virtual_move(ctx.document, ctx.catalog, device_ids, [ref.target() for ref in targets])
        _, after = _counts(place_terminals(moved, ctx.catalog))
        if len(after) < len(unplaced) and not placed & after:
            return targets
    return None


def _move_groups(ctx: _Context, terms: BoardTerminals,
                 overflowing: Sequence[Mapping[str, Any]]) -> tuple[list[dict], dict[int, str]]:
    groups = _strip_groups(terms)
    elsewhere = {entry["stripId"] for entry in ctx.placement.get("elsewhere") or []}
    suggestions: list[dict[str, Any]] = []
    sentences: dict[int, str] = {}
    for field in overflowing:
        number = field["field"]
        own = [u["stripId"] for u in field["unplaced"] if u["stripId"] not in elsewhere and u["stripId"] in groups]
        headed = next((strip_id for strip_id in own if groups[strip_id].get("head_device") is not None), None)
        if headed is None:
            sentences[number] = MOVE_SUPPLY if own else MOVE_NONE
            continue
        head = groups[headed]["head_device"]
        device_ids = _group_devices(ctx, head, number)
        targets = _try_move(ctx, number, device_ids)
        if targets is None:
            sentences[number] = MOVE_NONE
            continue
        ctx = ctx.taking(targets)
        label = group_head_label({"device": head})
        circuits = len(device_ids) - 1
        titles = join_and([ref.title for ref in targets])
        sentences[number] = f" Vorschlag: {label} mit {circuits} Stromkreis(en) nach {titles} verschieben."
        suggestions.append({"rule": RULE_OVERFLOW, "field": number, "kind": "move_group",
                            "scope": field["rails"][0]["moduleId"], "headId": ident(head.get("id")),
                            "deviceIds": device_ids, "targets": [ref.target() for ref in targets]})
    return suggestions, sentences


# ── 4. order and placeholders ────────────────────────────────────────────────


def _tidy(placement: Mapping[str, Any], rows_of_field: Mapping[int, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for field in placement["fields"]:
        number = field["field"]
        if field["order"] == ORDER_IGNORED and field.get("orderModuleId"):
            out.append({"rule": RULE_ORDER_IGNORED, "field": number, "kind": "reset_order", "scope": field["orderModuleId"]})
        rows = [row for row in rows_of_field.get(number, []) if any(is_placeholder(d) for d in row_devices(row))]
        if rows:
            out.append({"rule": RULE_PLACEHOLDERS, "field": number, "kind": "remove_placeholders",
                        "scopes": [row["id"] for row in rows],
                        "deviceIds": [ident(d.get("id")) for row in rows for d in row_devices(row) if is_placeholder(d)]})
    return out


# ── entry points ─────────────────────────────────────────────────────────────


def suggestion_pass(document: Any, catalog: EnclosureCatalog, terms: BoardTerminals,
                    placement: Mapping[str, Any]) -> SuggestionPass:
    """The four steps in order (see the module doc)."""
    if enclosure_of(document) is None or not placement.get("fields"):
        return SuggestionPass()
    reserved = frozenset((rail["moduleId"], rail["railKey"]) for f in placement["fields"] for rail in f["rails"])
    ctx = _Context(document, catalog, placement, vt_rails(document, catalog), reserved)
    rows_of_field = reserved_rows(document, placement)
    vacates, row_sentences, ctx = _vacate(ctx, rows_of_field)
    overflowing = [field for field in placement["fields"] if field["unplaced"]]
    moves = [move for suggestion in vacates for move in suggestion["moves"]]
    if moves:
        moved, overflow_sentences = [], _after_vacate(ctx, moves, overflowing)
    else:
        moved, overflow_sentences = _move_groups(ctx, terms, overflowing)
    return SuggestionPass(tuple([*vacates, *moved, *_tidy(placement, rows_of_field)]), row_sentences, overflow_sentences)


def terminal_suggestions(document: Any, catalog: EnclosureCatalog, terms: BoardTerminals | None = None,
                         placement: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
    """Every suggestion of the board, in pass order (§4.2)."""
    if enclosure_of(document) is None:
        return []
    terms = board_terminals(document, catalog) if terms is None else terms
    placement = place_terminals(document, catalog, terms) if placement is None else placement
    return list(suggestion_pass(document, catalog, terms, placement).suggestions)

