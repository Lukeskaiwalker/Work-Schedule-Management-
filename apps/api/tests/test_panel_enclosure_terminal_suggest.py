"""The suggestions behind the terminal findings (R2 §4.2) and the virtual
document transforms they are checked with (``panel_enclosure_terminal_virtual``).

One sequential pass: vacate the reserved rails first, re-place the board as
if that were done, and only then — never while a vacate is pending — offer
to move a whole group (owner, 2026-10-22: an FI travels with its circuits)
into another field, accepted only when a virtual move really places more.
Python writes the result into ``enclosureFixtures.json``
(``terminal_suggestions``); the TS twin ``enclosureTerminalSuggest.ts`` must
give the same, and the real ops must give the virtual placement.
"""

from __future__ import annotations

import copy
import json

from app.services.panel_enclosure_catalog import EnclosureCatalog, builtin_catalog
from app.services.panel_enclosure_layout import linked_rows, physical_row_order
from app.services.panel_enclosure_terminal_suggest import terminal_suggestions
from app.services.panel_enclosure_terminal_virtual import fill_rails, virtual_move, virtual_relink, vt_rails
from app.services.panel_enclosure_terminals import board_terminals, place_terminals
from scripts.write_enclosure_fixtures import (
    FIXTURE_PATH,
    meter_dist_zb33s,
    terminals_overflow_zb32s,
    terminals_rk_zb53s,
    terminals_zb34s,
)
from tests.panel_enclosure_terminal_boards import (
    elsewhere_first_zb53s,
    full_field_zb32s,
    half_vacate_zb32s,
    lost_place_zb32s,
    run_over_r2_zb32s,
    scattered_vacate_zb33s,
    spill_zb53s,
    still_short_zb32s,
    supply_overflow_zb32s,
    two_vacates_zb33s,
)

CATALOG = builtin_catalog()


def _suggest(doc: dict) -> list[dict]:
    terms = board_terminals(doc, CATALOG)
    return terminal_suggestions(doc, CATALOG, terms, place_terminals(doc, CATALOG, terms))


def _target(module_id: str, rail: str, title: str, field: int) -> dict:
    return {"moduleId": module_id, "railKey": rail, "title": title, "field": field}


def _unplaced(doc: dict) -> list[str]:
    return [u["stripId"] for f in place_terminals(doc, CATALOG)["fields"] for u in f["unplaced"]]


def test_suggestions_match_the_fixture_on_every_board() -> None:
    fixtures = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    catalog = EnclosureCatalog.from_out(fixtures["catalog"])
    for name, board in fixtures["boards"].items():
        doc = board["document"]
        terms = board_terminals(doc, catalog)
        assert terminal_suggestions(doc, catalog, terms, place_terminals(doc, catalog, terms)) == board["terminal_suggestions"], name


def test_the_compliant_board_needs_nothing() -> None:
    assert _suggest(meter_dist_zb33s()) == []


def test_the_owner_board_vacates_both_rows_together_and_drops_its_placeholder() -> None:
    assert _suggest(terminals_zb34s()) == [
        {"rule": "encl.terminal_rail_devices", "field": 1, "kind": "relink_rows", "scopes": ["row-old1", "row-old2"],
         "moves": [{"rowId": "row-old1", "target": _target("mod-rk", "r3", "F3 · Verteiler 3", 2)},
                   {"rowId": "row-old2", "target": _target("mod-rk", "r4", "F3 · Verteiler 4", 2)}]},
        {"rule": "encl.terminal_placeholders", "field": 1, "kind": "remove_placeholders", "scopes": ["row-old2"],
         "deviceIds": ["dev-pl1"]},
    ]


def test_the_vacate_really_makes_the_owner_board_fit() -> None:
    doc = terminals_zb34s()
    [vacate, _] = _suggest(doc)
    relinked = virtual_relink(doc, CATALOG, vacate["moves"])
    assert _unplaced(relinked) == []
    assert linked_rows(relinked, CATALOG)["row-old1"] == ("mod-rk", "r3")
    assert linked_rows(relinked, CATALOG)["row-old2"] == ("mod-rk", "r4")
    # The rows now sit where the cabinet puts them, after field 1's.
    assert [r["id"] for r in relinked["rows"]] == physical_row_order(relinked, CATALOG)
    assert [r["id"] for r in relinked["rows"]].index("row-old1") > [r["id"] for r in relinked["rows"]].index("row-k7")


def test_the_rk_board_resets_its_ignored_order() -> None:
    assert _suggest(terminals_rk_zb53s()) == [
        {"rule": "encl.terminal_order_ignored", "field": 1, "kind": "reset_order", "scope": "mod-r"}]


def test_a_whole_group_moves_into_the_next_field_validated_virtually() -> None:
    doc = terminals_overflow_zb32s()
    [move] = _suggest(doc)
    assert move == {
        "rule": "encl.terminals_overflow", "field": 0, "kind": "move_group", "scope": "mod-o", "headId": "dev-f5",
        "deviceIds": ["dev-f5", *[f"dev-f5-{k}" for k in range(1, 11)]],
        "targets": [_target("mod-e", "r3", "F2 · Verteiler 3", 1)],
    }
    assert _unplaced(virtual_move(doc, CATALOG, move["deviceIds"], move["targets"])) == []


def test_a_group_spans_two_empty_rails_and_the_strip_r6_brought_in_is_never_the_one_moved() -> None:
    doc = elsewhere_first_zb53s()
    assert _unplaced(doc) == ["dev-f1:leiste", "dev-f6:leiste"]
    [move] = _suggest(doc)
    assert move["headId"] == "dev-f6" and move["scope"] == "mod-d" and move["field"] == 1
    assert move["deviceIds"] == ["dev-f6", *[f"dev-f6-{k}" for k in range(1, 12)]]
    assert move["targets"] == [_target("mod-x", "r3", "F3 · Verteiler 3", 2), _target("mod-x", "r4", "F3 · Verteiler 4", 2)]
    moved = virtual_move(doc, CATALOG, move["deviceIds"], move["targets"])
    assert _unplaced(moved) == ["dev-f1:leiste"]
    rows = {r["id"]: r for r in moved["rows"]}
    by_rail = {rail: row_id for row_id, rail in linked_rows(moved, CATALOG).items()}
    # Filled in order, never reordered: FI + 10 LS take 210 mm, the 11th LS goes on.
    assert [d["id"] for d in rows[by_rail[("mod-x", "r3")]]["devices"]] == move["deviceIds"][:11]
    assert [d["id"] for d in rows[by_rail[("mod-x", "r4")]]["devices"]] == move["deviceIds"][11:]


def test_a_run_that_spills_over_the_field_line_still_moves_its_group() -> None:
    """The virtual move pins what the real op pins (C§2.4): the two LS of F5
    on field 1's r3 stay with F5, so the move places every strip."""
    doc = spill_zb53s()
    assert _unplaced(doc) == ["dev-f5:leiste"]
    [move] = _suggest(doc)
    assert move == {
        "rule": "encl.terminals_overflow", "field": 0, "kind": "move_group", "scope": "mod-a", "headId": "dev-f5",
        "deviceIds": ["dev-f5", *[f"dev-f5-{k}" for k in range(1, 11)]],
        "targets": [_target("mod-b", "r4", "F2 · Verteiler 4", 1)],
    }
    moved = virtual_move(doc, CATALOG, move["deviceIds"], move["targets"])
    assert _unplaced(moved) == []
    devices = {d["id"]: d for r in moved["rows"] for d in r["devices"]}
    assert [devices[f"dev-f5-{k}"]["parent_id"] for k in (11, 12)] == ["dev-f5", "dev-f5"]
    assert [devices[f"dev-f5-{k}"]["parent_id"] for k in range(1, 11)] == [None] * 10


def test_a_move_that_places_more_but_costs_a_placed_strip_its_place_is_refused() -> None:
    doc = lost_place_zb32s()
    assert _unplaced(doc) == ["dev-g:leiste", "dev-b:leiste"]
    # What the refused candidate would do: field 0 fits, field 1 loses a Block it did not have to hold before.
    ids = ["dev-g", "dev-g-b1", "dev-g-b2", *[f"dev-g-{k}" for k in range(1, 15)]]
    moved = virtual_move(doc, CATALOG, ids, [{"moduleId": "mod-m", "railKey": "r6"}, {"moduleId": "mod-m", "railKey": "r7"}])
    assert _unplaced(moved) == ["dev-g-b2:block"]
    assert _suggest(doc) == []


def test_no_move_while_a_vacate_is_pending() -> None:
    kinds = [s["kind"] for s in _suggest(still_short_zb32s())]
    assert kinds == ["relink_rows"]


def test_no_suggestion_without_a_place_or_without_a_head() -> None:
    assert _suggest(full_field_zb32s()) == []
    assert _suggest(supply_overflow_zb32s()) == []
    doc = terminals_overflow_zb32s()
    doc["enclosure"]["modules"] = [m for m in doc["enclosure"]["modules"] if m["id"] != "mod-e"]
    assert _suggest(doc) == []


def test_vacate_targets_never_repeat_a_rail() -> None:
    suggestions = _suggest(two_vacates_zb33s())
    assert [(s["field"], s["moves"]) for s in suggestions] == [
        (0, [{"rowId": "row-a1", "target": _target("mod-c", "r3", "F3 · Verteiler 3", 2)}]),
        (1, [{"rowId": "row-b1", "target": _target("mod-c", "r4", "F3 · Verteiler 4", 2)}]),
    ]


def test_without_a_field_for_all_rows_each_row_takes_the_nearest_free_rail() -> None:
    # Fields 1 and 2 have one free rail each (field 2's with an empty row):
    # no single field takes both rows, so each takes the nearest on its own.
    assert _suggest(scattered_vacate_zb33s()) == [
        {"rule": "encl.terminal_rail_devices", "field": 0, "kind": "relink_rows", "scopes": ["row-a1", "row-a2"],
         "moves": [{"rowId": "row-a1", "target": _target("mod-b", "r7", "F2 · Verteiler 7", 1)},
                   {"rowId": "row-a2", "target": _target("mod-c", "r7", "F3 · Verteiler 7", 2)}]}]


def test_a_row_without_a_free_rail_is_left_out_of_the_vacate() -> None:
    assert _suggest(half_vacate_zb32s()) == [
        {"rule": "encl.terminal_rail_devices", "field": 0, "kind": "relink_rows", "scopes": ["row-a1"],
         "moves": [{"rowId": "row-a1", "target": _target("mod-b", "r7", "F2 · Verteiler 7", 1)}]}]


# ── the virtual transforms ───────────────────────────────────────────────────


def test_virtual_move_creates_the_target_row_at_its_physical_place_and_pins_like_the_real_op() -> None:
    doc = terminals_overflow_zb32s()
    ids = ["dev-f5", "dev-f5-1"]
    moved = virtual_move(doc, CATALOG, ids, [{"moduleId": "mod-e", "railKey": "r3"}])
    links = linked_rows(moved, CATALOG)
    [new_row] = [r for r in moved["rows"] if links.get(r["id"]) == ("mod-e", "r3")]
    assert new_row["label"] == "F2 · Verteiler 3" and new_row["slots"] == 12
    assert [d["id"] for d in new_row["devices"]] == ids
    assert [d["parent_id"] for d in new_row["devices"]] == [None, None]
    assert [r["id"] for r in moved["rows"]] == physical_row_order(moved, CATALOG)
    old = next(r for r in moved["rows"] if r["id"] == "row-o7")
    assert [d["id"] for d in old["devices"]] == [f"dev-f5-{k}" for k in range(2, 11)]
    # Left behind F4 by position, they keep F5 as the real op's finish does.
    assert [d["parent_id"] for d in old["devices"]] == ["dev-f5"] * 9


def test_virtual_relink_pins_a_run_that_continued_from_the_moved_row() -> None:
    doc = run_over_r2_zb32s()
    [vacate] = _suggest(doc)
    assert vacate["moves"] == [{"rowId": "row-a2", "target": _target("mod-a", "r4", "F1 · Verteiler 4", 0)}]
    relinked = virtual_relink(doc, CATALOG, vacate["moves"])
    assert [r["id"] for r in relinked["rows"]] == ["row-a3", "row-a2"]
    devices = {d["id"]: d for r in relinked["rows"] for d in r["devices"]}
    assert [devices[f"dev-f1-{k}"]["parent_id"] for k in range(1, 7)] == [None] * 4 + ["dev-f1"] * 2
    assert [devices[f"dev-f2-{k}"]["parent_id"] for k in range(1, 4)] == [None] * 3


def test_rail_values_that_are_no_text_read_like_the_clean_board() -> None:
    """A stored block may carry anything under ``rails`` (Slice P, a rollback):
    the vacate and the move transforms leave such entries alone, as the twin does."""
    for make in (terminals_zb34s, terminals_overflow_zb32s):
        clean = make()
        for junk in ({"a": 1}, [None], ["row-x"]):
            doc = copy.deepcopy(clean)
            doc["enclosure"]["modules"][0]["rails"]["zz9"] = junk
            assert _suggest(doc) == _suggest(clean) != [], (make.__name__, junk)


def test_virtual_transforms_never_mutate_and_ignore_what_they_cannot_resolve() -> None:
    doc = terminals_zb34s()
    before = copy.deepcopy(doc)
    virtual_relink(doc, CATALOG, [{"rowId": "row-old1", "target": {"moduleId": "mod-rk", "railKey": "r3"}},
                                  {"rowId": "nope", "target": {"moduleId": "mod-rk", "railKey": "r4"}},
                                  {"rowId": "row-old2", "target": {"moduleId": "gone", "railKey": "r4"}}])
    virtual_move(doc, CATALOG, ["dev-f2", "nope"], [{"moduleId": "mod-rk", "railKey": "r5"}, {"moduleId": "x", "railKey": "y"}])
    assert doc == before
    assert virtual_move(doc, CATALOG, [], [{"moduleId": "mod-rk", "railKey": "r5"}])["rows"] == doc["rows"]
    unchanged = virtual_relink(doc, CATALOG, [{"rowId": "nope", "target": {"moduleId": "mod-rk", "railKey": "r4"}}])
    assert linked_rows(unchanged, CATALOG) == linked_rows(doc, CATALOG)


def test_fill_rails_never_reorders_and_says_when_the_rails_are_too_short() -> None:
    doc = terminals_overflow_zb32s()
    [r3] = [ref for ref in vt_rails(doc, CATALOG)[1] if ref.key == "r3"]
    group = [d for r in doc["rows"] if r["id"] == "row-o7" for d in r["devices"]]
    assert fill_rails(group, [r3]) == ([0] * 11, True)  # 2-TE FI + 10 LS = 210 mm
    extra = [*group, {**group[-1], "id": "dev-x"}]
    assert fill_rails(extra, [r3]) == ([0] * 12, False)  # the 12th breaker overfills the last rail
    assert fill_rails([], []) == ([], True) and fill_rails(group, []) == ([], False)


def test_virtual_move_onto_a_rail_with_an_empty_row_fills_that_row() -> None:
    doc = scattered_vacate_zb33s()
    moved = virtual_move(doc, CATALOG, ["dev-a1"], [{"moduleId": "mod-c", "railKey": "r7"}])
    rows = {r["id"]: r for r in moved["rows"]}
    assert [d["id"] for d in rows["row-c7"]["devices"]] == ["dev-a1"] and rows["row-a1"]["devices"] == []
    assert len(moved["rows"]) == len(doc["rows"])


def test_virtual_move_never_reuses_a_row_id_and_skips_targets_that_are_no_rails() -> None:
    doc = terminals_overflow_zb32s()
    doc["rows"].append({"id": "virtual:mod-e:r3", "label": "alt", "slots": 12, "devices": []})
    moved = virtual_move(doc, CATALOG, ["dev-f5"], [None, {"moduleId": "mod-e", "railKey": "r3"}])
    [new_row] = [r for r in moved["rows"] if linked_rows(moved, CATALOG).get(r["id"]) == ("mod-e", "r3")]
    assert new_row["id"] == "virtual:mod-e:r3'" and [d["id"] for d in new_row["devices"]] == ["dev-f5"]
