"""The ten WAGO terminal findings of a cabinet board (R2 §4.1) and the
sentences the suggestion pass (§4.2) appends to them.

Each rule is shown firing with its exact German text and staying silent on
the compliant reference board. The sentence a finding ends with comes from
the same pass that makes the suggestion, so text and action cannot disagree.
Owner answers of 2026-10-22: no end stops; the 210 mm usable length stays an
unverified assumption, so "passt nicht" is info until the flag is flipped.
"""

from __future__ import annotations

import copy
import logging

import pytest

from app.services import panel_enclosure_terminals
from app.services.panel_enclosure_catalog import builtin_catalog
from app.services.panel_enclosure_rules import RULE_ORDER, enclosure_findings
from app.services.panel_enclosure_terminal_rules import TERMINAL_RULE_ORDER, terminal_findings
from app.services.panel_enclosure_terminals import board_terminals, place_terminals
from scripts.write_enclosure_fixtures import (
    document,
    fi,
    ls,
    meter_dist_zb33s,
    module,
    row,
    tall_zb54s,
    terminals_overflow_zb32s,
    terminals_rk_zb53s,
    terminals_zb34s,
)
from tests.panel_enclosure_terminal_boards import (
    elsewhere_first_zb53s,
    full_field_zb32s,
    half_vacate_zb32s,
    lost_place_zb32s,
    scattered_vacate_zb33s,
    spill_zb53s,
    still_short_zb32s,
    supply_overflow_zb32s,
)

CATALOG = builtin_catalog()
ASSUMED = ", Nutzlänge 210 mm je Hutschiene angenommen"
NO_THIRD = " — eine dritte Hutschiene wird nicht belegt."


def _rule(doc: dict, rule: str) -> list[tuple[str, str, str]]:
    return sorted((f["level"], f["scope"], f["message"]) for f in terminal_findings(doc, CATALOG) if f["rule"] == rule)


def _messages(doc: dict, rule: str) -> list[str]:
    return [message for _, _, message in _rule(doc, rule)]


def test_the_ten_rules_replace_the_old_one_in_the_rule_order() -> None:
    assert TERMINAL_RULE_ORDER == (
        "encl.terminals", "encl.terminals_overflow", "encl.terminal_order_ignored", "encl.terminal_rail_devices",
        "encl.terminal_placeholders", "encl.terminals_elsewhere", "encl.terminals_no_field", "encl.terminals_split",
        "encl.terminals_head_field", "encl.terminals_zone")
    start = RULE_ORDER.index("encl.terminals")
    assert RULE_ORDER[start:start + 10] == TERMINAL_RULE_ORDER
    # Round 4 put its rules between encl.meter_place_invalid and these (R4 §4).
    assert RULE_ORDER[start - 1] == "encl.pen_split" and RULE_ORDER[start + 10] == "vde.nar_sls"


def test_the_compliant_board_only_states_its_terminals() -> None:
    findings = terminal_findings(meter_dist_zb33s(), CATALOG)
    assert sorted((f["level"], f["rule"], f["message"]) for f in findings) == [
        ("info", "encl.terminals", "Feld 2: 4 Reihenklemmen auf den oberen Hutschienen, 30,7 von 420 mm belegt."),
        ("info", "encl.terminals", "Feld 3: 3 Reihenklemmen auf den oberen Hutschienen, 25,5 von 420 mm belegt."),
    ]
    assert all(set(f) == {"level", "scope", "message", "rule"} and f["scope"] == "" for f in findings)


def test_the_old_not_drawn_copy_is_gone() -> None:
    for make in (meter_dist_zb33s, terminals_zb34s, terminals_rk_zb53s, terminals_overflow_zb32s):
        assert not any("nicht gezeichnet" in f["message"] for f in enclosure_findings(make(), CATALOG))


def test_the_owner_board_states_its_fields_and_waits_for_the_vacate() -> None:
    doc = terminals_zb34s()
    assert _messages(doc, "encl.terminals") == [
        "Feld 2: 29 Reihenklemmen auf den oberen Hutschienen, 372,2 von 420 mm belegt.",
        "Feld 4: 57 Reihenklemmen auf den oberen Hutschienen, 377,7 von 420 mm belegt.",
    ]
    # Vacating first makes everything fit: no move-circuits advice meanwhile (R17).
    assert _rule(doc, "encl.terminals_overflow") == [(
        "info", "mod-k",
        f"Feld 2: 3 Klemmleiste(n) passen nicht auf die zwei oberen Hutschienen (183,3 mm ohne Platz{ASSUMED}){NO_THIRD}"
        " Zuerst die reservierten Hutschienen räumen (Vorschlag „umhängen“) — danach passen alle Klemmleisten.")]
    vacate = " Vorschlag: Reihen auf F3 · Verteiler 3 und F3 · Verteiler 4 umhängen."
    assert _rule(doc, "encl.terminal_rail_devices") == [
        ("warn", "row-old1", "F2 · Verteiler 1: Hutschiene ist für Reihenklemmen reserviert — 5 Gerät(e) tiefer setzen." + vacate),
        ("warn", "row-old2", "F2 · Verteiler 2: Hutschiene ist für Reihenklemmen reserviert — 3 Gerät(e) tiefer setzen." + vacate),
    ]
    assert _rule(doc, "encl.terminal_placeholders") == [(
        "info", "row-old2",
        "F2 · Verteiler 2: 1 Platzhalter-Reihenklemme(n) — Reihenklemmen werden jetzt aus den Stromkreisen abgeleitet.")]
    assert _rule(doc, "encl.terminals_zone") == [
        ("info", "dev-aar-ls1", "F0.1: im AAR — keine Reihenklemme (nur in Verteilerfeldern).")]
    for rule in ("encl.terminal_order_ignored", "encl.terminals_elsewhere", "encl.terminals_no_field",
                 "encl.terminals_split", "encl.terminals_head_field"):
        assert _rule(doc, rule) == [], rule


def test_the_overflow_turns_into_a_warning_once_the_length_is_measured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(panel_enclosure_terminals, "TERMINAL_RAIL_USABLE_VERIFIED", True)
    [(level, _, message)] = _rule(terminals_overflow_zb32s(), "encl.terminals_overflow")
    assert level == "warn" and "Nutzlänge" not in message
    assert message.startswith("Feld 1: 1 Klemmleiste(n) passen nicht auf die zwei oberen Hutschienen (71,5 mm ohne Platz)")


def test_the_rk_board_names_order_elsewhere_split_and_head_field() -> None:
    doc = terminals_rk_zb53s()
    assert _rule(doc, "encl.terminal_order_ignored") == [(
        "info", "mod-r", "Feld 2: Die manuelle Aufteilung der Klemmleisten passt nicht mehr — automatisch verteilt.")]
    assert _rule(doc, "encl.terminals_elsewhere") == [
        ("info", "", "Feld 1 hat keine Hutschienen für Reihenklemmen — X1 in Feld 2.")]
    assert _rule(doc, "encl.terminals_split") == [
        ("info", "", "X7 (F5): Stromkreise in Feld 2 und 3 — Reihenklemmen in Feld 3.")]
    # The N feed crosses a field boundary wherever the terminals sit: F6's
    # pinned circuits, and F1's strip that R6 sent to the next field.
    assert _rule(doc, "encl.terminals_head_field") == [
        ("info", "", "X1 (F1): Schutzgerät in Feld 1, Klemmen in Feld 2 — N-Zuleitung über die Feldgrenze."),
        ("info", "", "X5 (F6): Schutzgerät in Feld 2, Klemmen in Feld 3 — N-Zuleitung über die Feldgrenze."),
    ]
    assert _messages(doc, "encl.terminals") == [
        "Feld 2: 39 Reihenklemmen auf den oberen Hutschienen, 231,7 von 420 mm belegt.",
        "Feld 3: 14 Reihenklemmen auf den oberen Hutschienen, 126 von 420 mm belegt.",
    ]
    assert _rule(doc, "encl.terminals_zone") == [] and _rule(doc, "encl.terminals_overflow") == []


def test_split_lists_three_fields_with_commas_and_und() -> None:
    doc = terminals_rk_zb53s()
    rows = {r["id"]: r for r in doc["rows"]}
    rows["row-x-sas"]["devices"].append(ls("dev-f5-9", "F5.9", "99", "Carport", terminal_block=True, parent_id="dev-f5"))
    rows["row-m-vf1"]["devices"].append(ls("dev-f5-8", "F5.8", "98", "Keller", terminal_block=True, parent_id="dev-f5"))
    # Feld 1 counts, though it has no terminal rails: one of F5's circuits lies there.
    assert _messages(doc, "encl.terminals_split") == ["X7 (F5): Stromkreise in Feld 1, 2 und 3 — Reihenklemmen in Feld 3."]


def test_strips_without_any_field_are_listed_at_most_four_then_the_rest_counted() -> None:
    outside = [row("row-x", "Reihe 9", [
        fi(f"dev-g{n}", f"F{n}") if k == 0 else ls(f"dev-g{n}-{k}", f"F{n}.{k}", "", "x", terminal_block=True)
        for n in range(1, 7) for k in range(2)])]
    doc = document("ZB32S", [module("mod-a", "ZU37KS", 0, {})], outside)
    assert _rule(doc, "encl.terminals_no_field") == [
        ("info", "", "X1, X2, X3, X4 und 2 weitere: kein Platz für Reihenklemmen — Stromkreise nicht in einem Verteilerfeld.")]
    # A cabinet without any Verteilerfeld: the VF group has a home, but no field has terminal rails.
    meter_only = document("ZB32S", [module("mod-m", "ZH3EL27", 0, {"aar1": "row-a"})], [
        row("row-a", "F1 · AAR 1", [fi("dev-f1", "F1"), ls("dev-l1", "F1.1", "1", "x", terminal_block=True)])])
    assert _rule(meter_only, "encl.terminals_no_field") == []
    assert _rule(meter_only, "encl.terminals_zone") == [
        ("info", "dev-l1", "F1.1: im AAR — keine Reihenklemme (nur in Verteilerfeldern).")]


def test_no_rails_anywhere_is_named_like_no_field() -> None:
    doc = document("ZB54S", [module("mod-m", "ZH5EL27", 0, {"vf1": "row-v"})], [
        row("row-v", "F1 · Verteilerfeld 1", [fi("dev-f1", "F1"), ls("dev-l1", "F1.1", "1", "x", terminal_block=True)])])
    assert _messages(doc, "encl.terminals_no_field") == [
        "X1: kein Platz für Reihenklemmen — Stromkreise nicht in einem Verteilerfeld."]
    assert _rule(doc, "encl.terminals_elsewhere") == []


def test_the_tall_board_sends_its_vf_strip_over_and_flags_its_old_row() -> None:
    doc = tall_zb54s()
    assert _messages(doc, "encl.terminals_elsewhere") == ["Feld 1 hat keine Hutschienen für Reihenklemmen — X1 in Feld 3."]
    assert _rule(doc, "encl.terminal_rail_devices") == [(
        "warn", "row-s-r1", "F3 · Verteiler 1: Hutschiene ist für Reihenklemmen reserviert — 3 Gerät(e) tiefer setzen."
        " Vorschlag: Reihe auf F3 · Verteiler 3 umhängen.")]


# ── sentences of the suggestion pass ─────────────────────────────────────────


def test_a_reserved_row_with_nowhere_to_go() -> None:
    nowhere = " Keine leere Hutschiene frei — Geräte einzeln wegziehen (gedrückt halten)."
    assert _messages(full_field_zb32s(), "encl.terminal_rail_devices") == [
        "F1 · Verteiler 1: Hutschiene ist für Reihenklemmen reserviert — 1 Gerät(e) tiefer setzen." + nowhere,
        "F1 · Verteiler 2: Hutschiene ist für Reihenklemmen reserviert — 1 Gerät(e) tiefer setzen." + nowhere,
    ]


def test_a_vacate_spread_over_two_fields_and_one_left_without_a_rail() -> None:
    reserved = "Hutschiene ist für Reihenklemmen reserviert — 1 Gerät(e) tiefer setzen."
    both = " Vorschlag: Reihen auf F2 · Verteiler 7 und F3 · Verteiler 7 umhängen."
    assert _messages(scattered_vacate_zb33s(), "encl.terminal_rail_devices") == [
        f"F1 · Verteiler 1: {reserved}{both}", f"F1 · Verteiler 2: {reserved}{both}"]
    assert _messages(half_vacate_zb32s(), "encl.terminal_rail_devices") == [
        f"F1 · Verteiler 1: {reserved} Vorschlag: Reihe auf F2 · Verteiler 7 umhängen.",
        f"F1 · Verteiler 2: {reserved} Keine leere Hutschiene frei — Geräte einzeln wegziehen (gedrückt halten).",
    ]


def test_vacating_first_but_still_short() -> None:
    assert _messages(still_short_zb32s(), "encl.terminals_overflow") == [
        f"Feld 1: 1 Klemmleiste(n) passen nicht auf die zwei oberen Hutschienen (71,5 mm ohne Platz{ASSUMED}){NO_THIRD}"
        " Zuerst die reservierten Hutschienen räumen — danach fehlen noch 71,5 mm."]


def test_move_circuits_accepted() -> None:
    assert _rule(terminals_overflow_zb32s(), "encl.terminals_overflow") == [(
        "info", "mod-o",
        f"Feld 1: 1 Klemmleiste(n) passen nicht auf die zwei oberen Hutschienen (71,5 mm ohne Platz{ASSUMED}){NO_THIRD}"
        " Vorschlag: F5 mit 10 Stromkreis(en) nach F2 · Verteiler 3 verschieben.")]


def test_move_circuits_over_two_rails_skipping_the_strip_r6_brought_in() -> None:
    [message] = _messages(elsewhere_first_zb53s(), "encl.terminals_overflow")
    assert message == (
        f"Feld 2: 2 Klemmleiste(n) passen nicht auf die zwei oberen Hutschienen (210,6 mm ohne Platz{ASSUMED}){NO_THIRD}"
        " Vorschlag: F6 mit 11 Stromkreis(en) nach F3 · Verteiler 3 und F3 · Verteiler 4 verschieben.")


def test_move_circuits_of_a_run_that_spills_over_the_field_line() -> None:
    """Checked on a board pinned like the real op's (C§2.4), not refused."""
    [message] = _messages(spill_zb53s(), "encl.terminals_overflow")
    assert message.endswith(" Vorschlag: F5 mit 10 Stromkreis(en) nach F2 · Verteiler 4 verschieben.")


def test_move_circuits_with_no_other_field() -> None:
    doc = terminals_overflow_zb32s()
    doc["enclosure"]["modules"] = [m for m in doc["enclosure"]["modules"] if m["id"] != "mod-e"]
    [message] = _messages(doc, "encl.terminals_overflow")
    assert message.endswith(
        " Kein anderes Feld hat genug Platz — Verteilerfeld ergänzen oder bei einzelnen Stromkreisen „Reihenklemme“ abwählen.")


def test_no_other_field_also_when_the_only_candidate_would_cost_a_placed_strip_its_place() -> None:
    assert _messages(lost_place_zb32s(), "encl.terminals_overflow") == [
        f"Feld 1: 2 Klemmleiste(n) passen nicht auf die zwei oberen Hutschienen (163,8 mm ohne Platz{ASSUMED}){NO_THIRD}"
        " Kein anderes Feld hat genug Platz — Verteilerfeld ergänzen oder bei einzelnen Stromkreisen „Reihenklemme“ abwählen."]


def test_move_circuits_of_the_supply_group() -> None:
    [message] = _messages(supply_overflow_zb32s(), "encl.terminals_overflow")
    assert message == (
        f"Feld 1: 1 Klemmleiste(n) passen nicht auf die zwei oberen Hutschienen (213,2 mm ohne Platz{ASSUMED}){NO_THIRD}"
        " Stromkreise vor dem ersten Schutzgerät — einzeln in ein anderes Feld ziehen.")


# ── robustness and the entry point ───────────────────────────────────────────


def test_precomputed_terms_and_placement_give_the_same_findings() -> None:
    doc = terminals_rk_zb53s()
    terms = board_terminals(doc, CATALOG)
    placement = place_terminals(doc, CATALOG, terms)
    assert terminal_findings(doc, CATALOG, terms, placement) == terminal_findings(doc, CATALOG)
    assert enclosure_findings(doc, CATALOG, terms, placement) == enclosure_findings(doc, CATALOG)


def test_a_board_without_a_cabinet_has_no_terminal_findings() -> None:
    assert terminal_findings({**terminals_zb34s(), "enclosure": None}, CATALOG) == []


@pytest.mark.parametrize(
    "broken",
    [
        {},
        {"enclosure": {"code": "ZB33S", "modules": "x"}, "rows": "y"},
        {"enclosure": {"code": "ZB33S", "modules": [None, {"id": "m", "code": "ZU37KS", "rails": {"r1": "r"},
                                                           "terminal_order": {"0": {"strips": [1, None]}}}]},
         "rows": [None, {"id": "r", "devices": [None, {"kind": "mcb", "terminal_block": True, "poles": "x"}]}]},
    ],
)
def test_garbage_never_raises(broken: dict, caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.ERROR):
        assert isinstance(terminal_findings(copy.deepcopy(broken), CATALOG), list)
    assert caplog.records == []


@pytest.mark.parametrize("junk", [{"a": 1}, [None], ["row-x"]], ids=["dict", "list", "list of text"])
def test_rail_values_that_are_no_text_never_cost_the_findings(junk: object, caplog: pytest.LogCaptureFixture) -> None:
    """A stored block may carry anything under ``rails`` (Slice P, a rollback).
    The vacate (owner board) and the move (overflow board) read past it, as
    the TS twin does: the same findings as without it, and nothing logged."""
    for make in (terminals_zb34s, terminals_overflow_zb32s):
        clean = make()
        doc = copy.deepcopy(clean)
        doc["enclosure"]["modules"][0]["rails"]["zz9"] = junk
        with caplog.at_level(logging.ERROR):
            assert terminal_findings(doc, CATALOG) == terminal_findings(clean, CATALOG) != [], make.__name__
    assert caplog.records == []


def test_inputs_are_never_mutated() -> None:
    for make in (terminals_zb34s, terminals_rk_zb53s, terminals_overflow_zb32s):
        doc = make()
        before = copy.deepcopy(doc)
        terminal_findings(doc, CATALOG)
        assert doc == before
