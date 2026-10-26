"""Cabinet preparation: supply kit, infeed, joints, network lead, §14a wiring (docs/PANEL_ENCLOSURE_R4.md §3.3–§3.5).

The TypeScript twin (``enclosurePrep.ts``) is pinned on the same answers
through ``enclosureFixtures.json`` (``prep`` per board, ``prep_parse``).
"""

from __future__ import annotations

import copy
import json

import pytest

from app.schemas.panel_enclosure import EnclosureSpec, parse_prep
from app.services.panel_enclosure_catalog import CatalogEntry, EnclosureCatalog, builtin_catalog
from app.services.panel_enclosure_control_block import default_control_block
from app.services.panel_enclosure_prep import (
    HAGER_NETWORK_TABLE,
    busbar_runs,
    busbar_zones,
    cabinet_prep,
    joint_pairs,
    make_run,
    parse_infeed,
    wire_dm,
)
from scripts.write_enclosure_fixtures import (
    BOARDS,
    FIXTURE_PATH,
    PREP_PARSE_CASES,
    busbar_gap_zb34s,
    control_3p_zb53s,
    control_ehz_zb33s,
    dev,
    document,
    ls,
    module,
    reserve_zb33s,
    row,
)

CATALOG = builtin_catalog()


def _fixture() -> dict:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def _doc(cabinet: str, modules: list[dict], rows: list[dict] | None = None, **extra: object) -> dict:
    return document(cabinet, modules, rows or [], **extra)


def _items(prep: dict) -> list[tuple[str, int]]:
    return [(item["key"], item["qty"]) for item in prep["items"]]


def _item(prep: dict, key: str) -> dict:
    return next(item for item in prep["items"] if item["key"] == key)


def _prep(doc: dict, catalog: EnclosureCatalog = CATALOG) -> dict:
    out = cabinet_prep(doc, catalog)
    assert out is not None
    return out


# ── the fixture and the overrides parser ─────────────────────────────────────


def test_the_fixture_pins_every_board_s_prep_and_the_override_table() -> None:
    fixture = _fixture()
    catalog = EnclosureCatalog.from_out(fixture["catalog"])
    for name, make in BOARDS.items():
        assert fixture["boards"][name]["prep"] == cabinet_prep(make(), catalog), name
    assert [entry["output"] for entry in fixture["prep_parse"]] == [parse_prep(case) for case in PREP_PARSE_CASES]


def test_parse_prep_is_lenient() -> None:
    assert parse_prep(None) is None and parse_prep("auto") is None
    assert parse_prep({}) == {"supply": "auto", "infeed": "auto", "joints": "auto", "network": "auto", "network_m": None}
    assert parse_prep({"supply": "sa", "infeed": "K96F", "joints": "on", "network": True, "network_m": 0.3}) == {
        "supply": "auto", "infeed": "auto", "joints": "auto", "network": "auto", "network_m": None}
    assert parse_prep({"supply": "SI", "network_m": 2.25}) == {
        "supply": "SI", "infeed": "auto", "joints": "auto", "network": "auto", "network_m": 2.3}


def test_an_unknown_cabinet_has_no_prep_and_a_board_without_meters_none_of_it() -> None:
    assert cabinet_prep(_doc("ZB33S", []) | {"enclosure": {"code": "ZX00GONE", "modules": []}}, CATALOG) is None
    assert cabinet_prep({"rows": []}, CATALOG) is None
    empty = _prep(_doc("ZB33S", [module("m-v", "ZU37KS", 0, {})]))
    assert empty == {"items": [], "runs": [], "infeed": None, "overrides": {
        "supply": "auto", "infeed": "auto", "joints": "auto", "network": "auto", "network_m": None}}


def test_the_prep_never_mutates_the_document() -> None:
    for make in BOARDS.values():
        doc = make()
        before = copy.deepcopy(doc)
        cabinet_prep(doc, CATALOG)
        assert doc == before


# ── the four round-4 boards, item by item ────────────────────────────────────


def test_the_ehz_board() -> None:
    prep = _prep(control_ehz_zb33s())
    assert _items(prep) == [
        ("accessory:ZY3N2SA", 1), ("accessory:K96ESA5", 1), ("accessory:ZZ55SAVE", 1), ("accessory:ZZ45WAN100", 1),
        ("part:249-116", 2), ("part:2002-1671", 6), ("part:2002-1692", 1),
        *[(f"wire:h07vk:2.5:{c}", 1) for c in ("braun", "schwarz", "grau", "rot", "violett", "weiß")],
        ("prep:luesterklemme", 1),
    ]
    assert [item["group"] for item in prep["items"][:5]] == ["supply", "busbar", "busbar", "network", "control"]
    network = _item(prep, "accessory:ZZ45WAN100")
    assert network["reason"] == "APZ (Feld 3) → RfZ über dem Zähler (Feld 1) · Länge nach Hager-Bestelltabelle"
    assert network["label"] == "Patch-Leitung RJ45 Cat 5e, spannungsfest, 1 m" and network["verified"] is True
    assert _item(prep, "accessory:ZZ55SAVE")["reason"] == "1 Feldübergang: Feld 1–2"
    assert _item(prep, "wire:h07vk:2.5:braun")["reason"] == "UNSM · Klemmleiste → RfZ · ≈ 1 m je Ader"
    assert _item(prep, "wire:h07vk:2.5:braun")["unit"] == "m"
    assert _item(prep, "prep:luesterklemme")["label"] == "Lüsterklemme 6-polig (von 12-poliger Leiste)"
    assert _item(prep, "prep:luesterklemme")["reason"] == "Gegenstück am RfZ Feld 1"
    assert _item(prep, "part:2002-1671")["reason"] == "§14a-Steuersignal-Klemmleiste, Feld 1 · F1 · AAR 1"
    assert [run["kind"] for run in prep["runs"]] == ["supply", "supply", "network", "control"]
    control = prep["runs"][-1]
    assert control == {"kind": "control", "from": [232.9, 100.0], "to": [150.0, 400.0],
                       "points": [[232.9, 100.0], [232.9, 400.0], [150.0, 400.0]], "label": "6 × H07V-K 2,5 mm²",
                       "lengthMm": 382.9}


def test_the_three_point_board() -> None:
    prep = _prep(control_3p_zb53s())
    assert _items(prep) == [
        ("accessory:ZY5N2SA", 1), ("accessory:K96F", 5), ("accessory:ZZ45WAN150", 1),
        ("part:249-116", 2), ("part:2002-1671", 5), ("part:2002-1692", 1),
        ("wire:h07vk:2.5:braun", 3), ("wire:h07vk:2.5:schwarz", 2), ("wire:h07vk:2.5:grau", 2),
        ("wire:h07vk:2.5:violett", 2), ("prep:luesterklemme", 1),
    ]
    assert _item(prep, "accessory:K96F")["reason"] == "Zuleitung 50 mm² > 25 mm²: eine Klemme je Leiter"
    assert _item(prep, "accessory:K96F")["verified"] is False
    assert _item(prep, "wire:h07vk:2.5:braun")["reason"] == "UNSM, Stve · Klemmleiste → APZ · ≈ 1,2 m je Ader"
    assert _item(prep, "accessory:ZY5N2SA")["verified"] is True  # ZY5 is a 3-Punkt kit
    assert prep["infeed"] == {"mm2": 50.0, "cores": 5, "aluminium": False, "article": "K96F", "assumed": False}
    assert "accessory:ZZ55SAVE" not in dict(_items(prep))  # customer busbar beside the NAR: no joint


def test_the_gap_board() -> None:
    prep = _prep(busbar_gap_zb34s())
    assert _items(prep) == [("accessory:ZY3N2LS", 1), ("accessory:K96ESA5", 2), ("accessory:ZZ45WAN150", 0)]
    supply = _item(prep, "accessory:ZY3N2LS")
    assert supply["label"] == "Bestückungspaket Spannungsversorgung APZ/RfZ, Sammelschienen-LS 6 A, Bauhöhe 1100 mm"
    assert supply["reason"] == ("Spannungsversorgung SMGW/Steuerbox: LS 6 A im NAR von Feld 1, Leitungen zum RfZ Feld 1 "
                                "und APZ Feld 4")
    assert supply["override"] == "LS"
    infeed = _item(prep, "accessory:K96ESA5")
    assert infeed["reason"] == "Querschnitt unbekannt — angenommen · Feld 3: eigene Einspeisung"
    network = _item(prep, "accessory:ZZ45WAN150")
    assert (network["suppressed"], network["override"]) == (True, "off")
    assert [run["kind"] for run in prep["runs"]] == ["supply", "supply"]  # no network run while off
    assert prep["overrides"] == {"supply": "LS", "infeed": "auto", "joints": "auto", "network": "off", "network_m": None}


def test_the_reserve_board() -> None:
    prep = _prep(reserve_zb33s())
    keys = dict(_items(prep))
    assert (keys["accessory:K96F"], keys["prep:pen_split"], keys["accessory:ZZ55SAVE"]) == (4, 1, 1)
    pen = _item(prep, "prep:pen_split")
    assert pen["label"] == "PEN-Aufteilung im NAR (z. B. Hager N75B / ZM35PE)" and pen["articleNo"] is None
    assert _item(prep, "part:2002-1671")["reason"] == "§14a-Steuersignal-Klemmleiste, Feld 2 · F2 · AAR 1"


# ── (a) Spannungsversorgung ──────────────────────────────────────────────────


def _ehz_board(*, supply_prep: str | None = None, cabinet: str = "ZB33S", rows: list[dict] | None = None,
               rails: dict | None = None, apz: bool = True) -> dict:
    modules = [module("m-e", "ZH3EL27", 0, rails or {})]
    if apz:
        modules.append(module("m-a", "ZU37VT5APZ2", 1, {}))
    return _doc(cabinet, modules, rows, prep={"supply": supply_prep} if supply_prep else None)


@pytest.mark.parametrize(("choice", "article", "part"), [
    (None, "ZY3N2SA", "SABO 1,6 A"), ("SA", "ZY3N2SA", "SABO 1,6 A"), ("LS", "ZY3N2LS", "Sammelschienen-LS 6 A"),
    ("SI", "ZY3R2SI", "Sicherungsbox 1 A im RfZ"),
])
def test_supply_variants(choice: str | None, article: str, part: str) -> None:
    prep = _prep(_ehz_board(supply_prep=choice))
    supply = prep["items"][0]
    assert (supply["key"], supply["qty"], supply["group"], supply["override"]) == (
        f"accessory:{article}", 1, "supply", choice or "auto")
    assert supply["label"] == f"Bestückungspaket Spannungsversorgung APZ/RfZ, {part}, Bauhöhe 1100 mm"
    labels = [run["label"] for run in prep["runs"] if run["kind"] == "supply"]
    device = {"ZY3N2SA": "SABO 1,6 A", "ZY3N2LS": "LS 6 A", "ZY3R2SI": "Sicherungsbox 1 A"}[article]
    assert labels == [f"{article} · {device} → RfZ", f"{article} · {device} → APZ"]


def test_the_sabo_reason_names_the_vnb_caveat_and_si_its_place() -> None:
    sa = _prep(_ehz_board())["items"][0]["reason"]
    assert sa == ("Spannungsversorgung SMGW/Steuerbox: SABO 1,6 A im NAR von Feld 1, Leitungen zum RfZ Feld 1 und APZ "
                  "Feld 2 · VNB muss die SABO zulassen (sonst ZY3N2LS / ZY3R2SI)")
    si = _prep(_ehz_board(supply_prep="SI"))["items"][0]["reason"]
    assert si == ("Spannungsversorgung SMGW/Steuerbox: Sicherungsbox 1 A im RfZ, Abgriff im NAR von Feld 1, "
                  "Leitungen zum RfZ Feld 1 und APZ Feld 2")


def test_supply_off_is_struck_through_and_draws_no_runs() -> None:
    prep = _prep(_ehz_board(supply_prep="off"))
    supply = prep["items"][0]
    assert (supply["key"], supply["qty"], supply["suppressed"], supply["override"]) == (
        "accessory:ZY3N2SA", 0, True, "off")
    assert not [run for run in prep["runs"] if run["kind"] == "supply"]


def test_one_lead_without_an_apz_and_a_1400_ehz_kit_is_unverified() -> None:
    prep = _prep(_ehz_board(apz=False))
    assert prep["items"][0]["key"] == "accessory:ZY3N1SA"
    assert prep["items"][0]["label"] == "Bestückungspaket Spannungsversorgung RfZ, SABO 1,6 A, Bauhöhe 1100 mm"
    tall = _prep(_doc("ZB53S", [module("m-e", "ZH5EL27", 0, {})]))
    assert (tall["items"][0]["key"], tall["items"][0]["verified"]) == ("accessory:ZY5N1SA", False)
    three = _prep(_doc("ZB53S", [module("m-p", "ZH53X3", 0, {})]))
    assert (three["items"][0]["key"], three["items"][0]["verified"]) == ("accessory:ZY5N1SA", True)
    assert three["items"][0]["reason"].startswith(
        "Spannungsversorgung SMGW/Steuerbox: SABO 1,6 A im NAR von Feld 1, Leitungen zum Zählerplatz Feld 1")


def test_a_three_point_cabinet_feeds_the_rfz_of_a_communication_field_first() -> None:
    doc = _doc("ZB33S", [module("m-p", "ZH33X7", 0, {}), module("m-c", "ZH33SAR2", 1, {})])
    assert "Leitungen zum RfZ Feld 2 und APZ Feld 2" in _prep(doc)["items"][0]["reason"]


def test_an_existing_small_tap_suppresses_the_kit_in_auto_only() -> None:
    rows = [row("r-rfz", "F1 · RfZ", [ls("d-tap", "F9", "9", "SMGW", rating="B6")])]
    prep = _prep(_ehz_board(rows=rows, rails={"rfz": "r-rfz"}))
    supply = prep["items"][0]
    assert (supply["suppressed"], supply["qty"], supply["reason"]) == (
        True, 0, "Spannungsabgriff bereits geplant (F9, F1 · RfZ)")
    assert not [run for run in prep["runs"] if run["kind"] == "supply"]
    forced = _prep(_ehz_board(rows=rows, rails={"rfz": "r-rfz"}, supply_prep="SA"))
    assert forced["items"][0]["suppressed"] is False
    big = [row("r-rfz", "F1 · RfZ", [ls("d-tap", "F9", "9", "SMGW", rating="B16")])]
    assert _prep(_ehz_board(rows=big, rails={"rfz": "r-rfz"}))["items"][0]["suppressed"] is False


def test_a_tap_on_the_nar_counts_and_one_on_another_meter_field_s_nar_does_not() -> None:
    rows = [row("r-nar", "F2 · NAR", [ls("d-tap", "F8", "8", "SMGW", rating="B10")])]
    doc = _doc("ZB33S", [module("m-e", "ZH3EL27", 0, {}), module("m-f", "ZH3EL27", 1, {"nar": "r-nar"})], rows)
    assert _prep(doc)["items"][0]["suppressed"] is False
    own = _doc("ZB33S", [module("m-e", "ZH3EL27", 0, {"nar": "r-nar"})], rows)
    assert _prep(own)["items"][0]["reason"] == "Spannungsabgriff bereits geplant (F8, F1 · NAR)"


def _cabinet_catalog(height: int, units: int) -> EnclosureCatalog:
    raw = {"code": "ZX9TEST", "article_no": "ZX9TEST", "name": "Testschrank", "height_mm": height,
           "width_mm": 800, "depth_mm": 205, "fields": 3, "door_leaves": 2, "units_per_field": units,
           "ip": "IP44", "door": "Test", "verified": True}
    spec = EnclosureSpec.model_validate(raw).model_dump()
    return EnclosureCatalog({**CATALOG.entries, "ZX9TEST": CatalogEntry("ZX9TEST", "enclosure", spec, "custom", False)})


def test_a_cabinet_height_without_a_hager_kit_gets_no_item() -> None:
    catalog = _cabinet_catalog(1250, 8)
    prep = _prep(_doc("ZB33S", [module("m-e", "ZH3EL27", 0, {})]) | {
        "enclosure": {"code": "ZX9TEST", "modules": [module("m-e", "ZH3EL27", 0, {})]}}, catalog)
    assert not [item for item in prep["items"] if item["group"] == "supply"]


# ── (b) Einspeisung ──────────────────────────────────────────────────────────


@pytest.mark.parametrize(("incoming", "choice", "article", "qty", "reason"), [
    ("NYY-J 5x16 mm²", None, "K96ESA5", 1, "Zuleitung 16 mm² ≤ 25 mm²"),
    ("NYY-J 5x25", None, "K96ESA5", 1, "Zuleitung 25 mm² ≤ 25 mm²"),
    ("", None, "K96ESA5", 1, "Querschnitt unbekannt — angenommen"),
    ("NYY-J 5x50", None, "K96F", 5, "Zuleitung 50 mm² > 25 mm²: eine Klemme je Leiter"),
    ("NYY-J 4x95", None, "K96H", 4, "Zuleitung 95 mm² > 25 mm²: eine Klemme je Leiter"),
    ("NYY-J 4x120", None, "K96K", 4, "Zuleitung 120 mm² > 25 mm²: eine Klemme je Leiter"),
    ("NYY-J 5x185", None, "KS18D", 5, "Zuleitung 185 mm² > 25 mm²: eine Klemme je Leiter"),
    ("NYCWY 3x35/16", None, "K96F", 4, "Zuleitung 35 mm² > 25 mm²: eine Klemme je Leiter"),
    ("NYY 3x35", None, "K96F", 5, "Zuleitung 35 mm² > 25 mm²: eine Klemme je Leiter"),
    ("NAYY-J 4x50", None, "K96N", 4, "Zuleitung 50 mm² Al > 25 mm²: eine Klemme je Leiter"),
    ("NAYY-J 4x150", None, "KS18D", 4, "Zuleitung 150 mm² Al > 25 mm²: eine Klemme je Leiter"),
    ("NAYY-J 4x16", None, "K96N", 4, "Zuleitung 16 mm² Al: eine Klemme je Leiter"),
    ("NAYY-J", None, "K96N", 5, "Zuleitung Al, Querschnitt unbekannt: eine Klemme je Leiter"),
    ("NYY-J 5x50", "K96ESA5", "K96ESA5", 1, "Einspeiseadapter manuell gewählt · Zuleitung 50 mm²"),
    ("", "K96ESA5", "K96ESA5", 1, "Einspeiseadapter manuell gewählt"),
    ("NYY-J 5x16", "clamps", "K96F", 5, "Zuleitung 16 mm²: eine Klemme je Leiter"),
    ("", "clamps", "K96F", 5, "Querschnitt unbekannt: eine Klemme je Leiter"),
])
def test_the_infeed_matrix(incoming: str, choice: str | None, article: str, qty: int, reason: str) -> None:
    doc = _doc("ZB33S", [module("m-e", "ZH3EL27", 0, {})], supply={"incoming": incoming},
               prep={"infeed": choice} if choice else None)
    infeed = next(item for item in _prep(doc)["items"] if item["group"] == "busbar")
    assert (infeed["articleNo"], infeed["qty"], infeed["reason"]) == (article, qty, reason)
    assert infeed["verified"] is (article == "K96ESA5")
    assert infeed["override"] == (choice or "auto")


def test_above_185_mm2_no_clamp_fits_and_off_keeps_the_auto_article() -> None:
    doc = _doc("ZB33S", [module("m-e", "ZH3EL27", 0, {})], supply={"incoming": "NYY-J 4x240"})
    prep = _prep(doc)
    assert [item["key"] for item in prep["items"] if item["group"] == "busbar"] == ["prep:pen_split"]  # 4 cores
    assert prep["infeed"] == {"mm2": 240.0, "cores": 4, "aluminium": False, "article": None, "assumed": False}
    off = _prep(_doc("ZB33S", [module("m-e", "ZH3EL27", 0, {})], prep={"infeed": "off"}))
    infeed = next(item for item in off["items"] if item["group"] == "busbar")
    assert (infeed["articleNo"], infeed["qty"], infeed["suppressed"]) == ("K96ESA5", 0, True)
    assert off["infeed"]["assumed"] is False


def test_the_assumed_flag_is_only_the_automatic_guess() -> None:
    unknown = {"incoming": "Hausanschluss"}
    auto = _prep(_doc("ZB33S", [module("m-e", "ZH3EL27", 0, {})], supply=unknown))
    assert auto["infeed"] == {"mm2": None, "cores": None, "aluminium": False, "article": "K96ESA5", "assumed": True}
    forced = _prep(_doc("ZB33S", [module("m-e", "ZH3EL27", 0, {})], supply=unknown, prep={"infeed": "K96ESA5"}))
    assert forced["infeed"]["assumed"] is False


def test_parse_infeed_is_the_shared_cable_parser() -> None:
    assert parse_infeed("NYY-J 5x16 mm²") == {"mm2": 16.0, "cores": 5, "aluminium": False}


def test_the_pen_split_needs_tn_c_s_and_four_cores() -> None:
    four = {"incoming": "NYY-J 4x16"}
    assert "prep:pen_split" in dict(_items(_prep(_doc("ZB33S", [module("m-e", "ZH3EL27", 0, {})], supply=four))))
    for supply in ({"incoming": "NYY-J 5x16"}, {"incoming": "NYY-J 4x16", "system": "TT"}, {"incoming": ""}):
        doc = _doc("ZB33S", [module("m-e", "ZH3EL27", 0, {})], supply=supply)
        assert "prep:pen_split" not in dict(_items(_prep(doc))), supply


# ── busbar zones, roles, joints ──────────────────────────────────────────────


def test_roles_main_for_nar_communication_and_an_sls_on_the_sas() -> None:
    rows = [row("r-sas", "F3 · Sammelschienen", [dev("d-q", "sls", designation="Q5", rating="E35")])]
    doc = _doc("ZB33S", [module("m-e", "ZH3EL27", 0, {}), module("m-c", "ZH33SAR2", 1, {}),
                         module("m-s", "ZH3ES5", 2, {"sas": "r-sas"})], rows)
    assert [(z.field, z.placed.zone["type"], z.role) for z in busbar_zones(doc, CATALOG)] == [
        (0, "NAR", "main"), (1, "SAS", "main"), (2, "SAS", "main")]
    plain = _doc("ZB33S", [module("m-e", "ZH3EL27", 0, {}), module("m-s", "ZH3ES5", 1, {})])
    assert [z.role for z in busbar_zones(plain, CATALOG)] == ["main", "customer"]


def test_joints_connect_same_role_neighbours_at_the_same_height_only() -> None:
    rows = [row("r-sas", "F2 · Sammelschienen", [dev("d-q", "sls", designation="Q5", rating="E35")])]
    main = _doc("ZB33S", [module("m-e", "ZH3EL27", 0, {}), module("m-s", "ZH3ES5", 1, {"sas": "r-sas"})], rows)
    assert joint_pairs(busbar_zones(main, CATALOG)) == [("main", 0, 1)]
    assert _item(_prep(main), "accessory:ZZ55SAVE")["qty"] == 1
    customer = _doc("ZB33S", [module("m-e", "ZH3EL27", 0, {}), module("m-s", "ZH3ES5", 1, {})])
    assert joint_pairs(busbar_zones(customer, CATALOG)) == []
    two_customers = _doc("ZB33S", [module("m-a", "ZH3ES5", 0, {}), module("m-b", "ZH3ES5", 1, {})])
    assert joint_pairs(busbar_zones(two_customers, CATALOG)) == [("customer", 0, 1)]
    prep = _prep(two_customers)
    assert _items(prep) == [("accessory:ZZ55SAVE", 1)]  # no main zone: no infeed, no carrier: no kit
    mismatch = _doc("ZB54S", [module("m-e", "ZH3EL27", 0, {}), module("m-f", "ZH5EL27", 1, {})])
    assert joint_pairs(busbar_zones(mismatch, CATALOG)) == []


def test_runs_count_infeeds_and_joints_list_their_fields() -> None:
    doc = _doc("ZB35S", [module(f"m-{i}", "ZH3EL27", i, {}) for i in (0, 1, 3, 4)])
    zones = busbar_zones(doc, CATALOG)
    assert [[z.field for z in run] for run in busbar_runs(zones, "main")] == [[0, 1], [3, 4]]
    prep = _prep(doc)
    assert _item(prep, "accessory:ZZ55SAVE")["reason"] == "2 Feldübergänge: Feld 1–2, Feld 4–5"
    assert _item(prep, "accessory:K96ESA5")["qty"] == 2
    assert _item(prep, "accessory:K96ESA5")["reason"].endswith(" · Feld 4: eigene Einspeisung")
    off = _prep(_doc("ZB35S", [module(f"m-{i}", "ZH3EL27", i, {}) for i in (0, 1)], prep={"joints": "off"}))
    joint = _item(off, "accessory:ZZ55SAVE")
    assert (joint["qty"], joint["suppressed"], joint["override"]) == (0, True, "off")


# ── (d) Netzwerkleitung ──────────────────────────────────────────────────────

_APZ_MODULE = {("1100", "bottom"): "ZU37VT5APZ2", ("1100", "top"): "ZH33SAR2",
               ("1400", "bottom"): "ZU59VT7APZ2", ("1400", "top"): "ZH55SAR2"}
_CARRIER = {("meter_ehz", 1100): ("ZH3EL27", "ZB35S"), ("meter_3p", 1100): ("ZH33X7", "ZB35S"),
            ("meter_3p", 1400): ("ZH53X3", "ZB55S")}


@pytest.mark.parametrize("key", list(HAGER_NETWORK_TABLE))
@pytest.mark.parametrize("between", [0, 1, 2, 3])
def test_every_cell_of_the_hager_network_table(key: tuple[str, int, str], between: int) -> None:
    family, height, position = key
    carrier, cabinet = _CARRIER[(family, height)]
    doc = _doc(cabinet, [module("m-z", carrier, 0, {}), module("m-a", _APZ_MODULE[(str(height), position)],
                                                             between + 1, {})])
    lead = next(item for item in _prep(doc)["items"] if item["group"] == "network")
    expected = HAGER_NETWORK_TABLE[key][between]
    assert (lead["articleNo"], lead["verified"]) == (expected, True), (key, between)
    assert lead["reason"].endswith(" · Länge nach Hager-Bestelltabelle")


def test_the_table_values_are_hager_s() -> None:
    assert HAGER_NETWORK_TABLE == {
        ("meter_ehz", 1100, "bottom"): ("ZZ45WAN100", "ZZ45WAN100", "ZZ45WAN150", "ZZ45WAN200"),
        ("meter_ehz", 1100, "top"): ("ZZ45WAN040", "ZZ45WAN100", "ZZ45WAN100", "ZZ45WAN150"),
        ("meter_3p", 1100, "bottom"): ("ZZ45WAN100", "ZZ45WAN100", "ZZ45WAN150", "ZZ45WAN200"),
        ("meter_3p", 1100, "top"): ("ZZ45WAN100", "ZZ45WAN150", "ZZ45WAN150", "ZZ45WAN200"),
        ("meter_3p", 1400, "bottom"): ("ZZ45WAN100", "ZZ45WAN150", "ZZ45WAN200", "ZZ45WAN200"),
        ("meter_3p", 1400, "top"): ("ZZ45WAN100", "ZZ45WAN150", "ZZ45WAN150", "ZZ45WAN200"),
    }


def test_an_ehz_1400_cabinet_measures_the_lead_on_the_drawing() -> None:
    doc = _doc("ZB55S", [module("m-z", "ZH5EL27", 0, {}), module("m-a", "ZU59VT7APZ2", 1, {})])
    prep = _prep(doc)
    lead = next(item for item in prep["items"] if item["group"] == "network")
    assert (lead["articleNo"], lead["verified"]) == ("ZZ45WAN100", False)
    assert lead["reason"] == "APZ (Feld 2) → RfZ über dem Zähler (Feld 1) · ≈ 0,7 m gemessen"
    network = next(run for run in prep["runs"] if run["kind"] == "network")
    assert (network["from"], network["to"], network["lengthMm"]) == ([400.0, 1150.0], [150.0, 700.0], 700.0)


def test_a_three_point_lead_off_the_table_adds_the_hager_reserve() -> None:
    catalog = _cabinet_catalog(1250, 8)
    modules = [module("m-p", "ZH33X7", 0, {}), module("m-a", "ZU37VT5APZ2", 1, {})]
    doc = _doc("ZB33S", modules) | {"enclosure": {"code": "ZX9TEST", "modules": modules}}
    lead = next(item for item in _prep(doc, catalog)["items"] if item["group"] == "network")
    assert lead["articleNo"] == "ZZ45WAN100"  # 550 mm + 300 mm reserve
    assert lead["reason"] == "APZ (Feld 2) → Zählerplatz (Feld 1) · ≈ 0,6 m gemessen"


def test_a_stored_lead_length_picks_the_lead_and_past_five_metres_the_longest() -> None:
    base = [module("m-z", "ZH3EL27", 0, {}), module("m-a", "ZU37VT5APZ2", 1, {})]
    stored = _prep(_doc("ZB33S", base, prep={"network_m": 1.5}))
    lead = next(item for item in stored["items"] if item["group"] == "network")
    assert (lead["articleNo"], lead["verified"]) == ("ZZ45WAN150", True)
    assert lead["reason"] == "APZ (Feld 2) → RfZ über dem Zähler (Feld 1) · Länge 1,5 m vorgegeben"
    long = _prep(_doc("ZB33S", base, prep={"network_m": 6}))
    lead = next(item for item in long["items"] if item["group"] == "network")
    assert lead["articleNo"] == "ZZ45WAN500" and lead["reason"].endswith(" · länger als 5 m")
    assert lead["label"] == "Patch-Leitung RJ45 Cat 5e, spannungsfest, 5 m"


def test_no_apz_no_network_lead() -> None:
    assert not [i for i in _prep(_ehz_board(apz=False))["items"] if i["group"] == "network"]


# ── (e) the §14a wiring and the runs ─────────────────────────────────────────


def test_wire_decimetres() -> None:
    assert wire_dm(None, 382.9) == 10  # ⌈3,829⌉ = 4 dm + 3 reserve → 7 → 10 (0,5 m steps)
    assert wire_dm(None, 300.0) == 10
    assert wire_dm(None, 700.1) == 15
    assert wire_dm(None, 0.0) == 5
    assert wire_dm(1.2, 999.0) == 12  # a stored length wins
    assert wire_dm(2.3, 0.0) == 23


def test_planned_wire_metres_are_whole_metres_per_colour() -> None:
    block = {**default_control_block(), "terminals": [
        {"id": "t1", "label": "", "color": "braun"}, {"id": "t2", "label": "60%", "color": "braun"},
        {"id": "t3", "label": "30%", "color": "braun"}], "wire_mm2": 1.5, "wire_length_m": 1.3}
    doc = _doc("ZB33S", [module("m-z", "ZH3EH16", 0, {})], control_block=block)
    prep = _prep(doc)
    wire = _item(prep, "wire:h07vk:1.5:braun")
    assert (wire["qty"], wire["label"]) == (4, "Aderleitung H07V-K 1 × 1,5 mm² braun")  # ⌈3 × 1,3⌉
    assert wire["reason"] == "Klemme 1, 60%, 30% · Klemmleiste → RfZ · ≈ 1,3 m je Ader"
    assert _item(prep, "prep:luesterklemme")["label"] == "Lüsterklemme 3-polig (von 12-poliger Leiste)"
    assert prep["runs"][-1]["label"] == "3 × H07V-K 1,5 mm²"


def test_without_a_control_target_only_the_block_parts_are_listed() -> None:
    doc = _doc("ZB33S", [module("m-p", "ZH33X7", 0, {})], control_block=default_control_block())
    prep = _prep(doc)
    assert [key for key, _ in _items(prep) if key.startswith(("part:", "wire:", "prep:lu"))] == [
        "part:249-116", "part:2002-1671", "part:2002-1692"]
    assert not [run for run in prep["runs"] if run["kind"] == "control"]


def test_a_removed_block_lists_nothing() -> None:
    doc = _doc("ZB33S", [module("m-z", "ZH3EH16", 0, {})], control_block={**default_control_block(), "off": True})
    assert not [item for item in _prep(doc)["items"] if item["group"] == "control"]


def test_runs_go_vertical_first_and_measure_the_unrounded_points() -> None:
    run = make_run("control", (10.04, 20.0), (30.0, 80.06), "x")
    assert run["points"] == [[10.0, 20.0], [10.0, 80.1], [30.0, 80.1]]
    assert run["lengthMm"] == 80.0  # 19,96 + 60,06 = 80,02
    straight = make_run("network", (10.0, 20.0), (10.0, 80.0), "y")
    assert straight["points"] == [[10.0, 20.0], [10.0, 80.0]]
    flat = make_run("supply", (10.0, 20.0), (50.0, 20.0), "z")
    assert flat["points"] == [[10.0, 20.0], [50.0, 20.0]]
    assert list(run) == ["kind", "from", "to", "points", "label", "lengthMm"]


def test_every_item_has_the_same_keys() -> None:
    for make in BOARDS.values():
        for item in (cabinet_prep(make(), CATALOG) or {"items": []})["items"]:
            assert list(item) == ["key", "articleNo", "label", "qty", "unit", "reason", "verified", "group",
                                  "override", "suppressed"]
            assert item["unit"] in ("Stk", "m") and isinstance(item["qty"], int)
