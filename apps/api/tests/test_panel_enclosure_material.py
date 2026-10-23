"""The Materialliste of a board in a cabinet (docs/PANEL_ENCLOSURE.md §6).

What must hold on the planned side: a board without a cabinet lists exactly
what it listed before; a cabinet board starts with the cabinet, its modules
(counted) and their accessories, blind plates for reserve meter places
included; a part that came pre-fitted in a module is counted by the module,
never again as a device; a fitting taken out shows as its own "aus Modul
entfernt → ins Lager" line while the module line stays as bought; the
fitting facts come from the snapshot in the board, so a later catalogue edit
cannot rewrite the list; meters are never material. Article matching is the
whole-token match on the article number, and the mapping takes the new line
keys — a return's key only from the Werkstatt.

The salvage bookings, the station and the project tab are in
``test_panel_enclosure_salvage.py``. Every name and number here is invented;
only the Hager codes are real, because the built-in catalogue ships them.
"""

from __future__ import annotations

import copy
from dataclasses import replace
from types import MappingProxyType

from fastapi.testclient import TestClient

from app.services.panel_enclosure_catalog import EnclosureCatalog, builtin_catalog
from app.services.panel_enclosure_material import (
    line_article_numbers,
    module_fittings,
    removed_fittings,
    supplied_device_ids,
)
from app.services.panel_enclosure_terminals import place_terminals
from app.services.schaltplan_material import planned_lines
from app.services.schaltplan_terminals import derive_terminals, terminal_bom
from scripts.write_enclosure_fixtures import meter_dist_zb33s, terminals_rk_zb53s, terminals_zb34s
from tests.panel_enclosure_helpers import article, auth, cabinet_document, create_panel, device, employee

MAPPING = "/api/schaltplan/material/mapping"


def _keys(lines) -> list[str]:
    return [line.key for line in lines]


def _by_key(lines) -> dict:
    return {line.key: line for line in lines}


def _without_hs(document: dict) -> dict:
    """The board after somebody deleted the pre-fitted Hauptschalter."""
    out = copy.deepcopy(document)
    out["rows"][1]["devices"] = []
    return out


def _catalog_with(code: str, **changes) -> EnclosureCatalog:
    """The built-in catalogue with one spec edited, the way an admin override would."""
    base = builtin_catalog()
    spec = copy.deepcopy(base.entries[code].spec)
    spec.update(changes)
    entries = dict(base.entries)
    entries[code] = replace(entries[code], spec=spec, source="override")
    return EnclosureCatalog(MappingProxyType(entries))


def _material(client: TestClient, token: str, panel_id: int) -> dict:
    resp = client.get(f"/api/schaltplan/panels/{panel_id}/material", headers=auth(token))
    assert resp.status_code == 200, resp.text
    return resp.json()


def _line(body: dict, key: str) -> dict:
    return next(line for line in body["lines"] if line["key"] == key)


# ── Golden: boards without a cabinet ─────────────────────────────────────────


def test_a_board_without_a_cabinet_lists_what_it_listed_before() -> None:
    legacy = cabinet_document()
    legacy["enclosure"] = None
    bare = copy.deepcopy(legacy)
    del bare["enclosure"]
    for row in bare["rows"]:
        for item in row["devices"]:
            del item["supplied_by"]

    lines = planned_lines(bare)
    assert planned_lines(legacy) == lines
    assert planned_lines(legacy, builtin_catalog()) == lines
    # Without a cabinet nothing is pre-fitted: the HS that names a module
    # instance is an ordinary device, and nothing is "removed".
    assert "device:hauptschalter:3p:" in _keys(lines)
    assert all(line.kind in ("device", "terminal") for line in lines)


# ── Cabinet, modules, accessories ────────────────────────────────────────────


def test_the_cabinet_and_its_modules_lead_the_list_and_supplied_parts_are_not_devices() -> None:
    document = cabinet_document()
    lines = planned_lines(document, builtin_catalog())
    by_key = _by_key(lines)

    assert _keys(lines)[:3] == ["enclosure:ZB33S", "module:ZH3EH16", "module:ZU37KS"]
    cabinet = by_key["enclosure:ZB33S"]
    assert (cabinet.kind, cabinet.planned) == ("enclosure", 1)
    assert cabinet.label == "Zählerschrank univers Z, 1100 × 800 × 205 mm, IP44, 3 Felder"
    assert cabinet.detail == "Hager ZB33S · 1100 × 800 × 205 mm · 3 Felder"
    meter_field = by_key["module:ZH3EH16"]
    assert (meter_field.kind, meter_field.planned) == ("enclosure", 1)
    assert meter_field.label == "Komplettfeld eHZ, 1 Zählerplatz, Hauptschalter, HLAK, 1050 mm"
    assert meter_field.detail == "Hager ZH3EH16 · 1 Feld · 1050 mm"

    # The HS came with the meter field: the module line counts it.
    assert "device:hauptschalter:3p:" not in by_key
    assert supplied_device_ids(document, builtin_catalog()) == {"dev-q1"}
    # The rest of the devices are listed exactly as without a cabinet.
    legacy = copy.deepcopy(document)
    legacy["enclosure"] = None
    legacy["rows"][1]["devices"] = []
    assert [line for line in lines if line.kind == "device"] == planned_lines(legacy)
    # The occupied meter place is no material (D7), and nothing was taken out.
    assert all(line.kind in ("enclosure", "device") for line in lines)


def test_modules_are_counted_in_placement_order_and_reserve_places_get_a_blind_plate() -> None:
    document = {
        "version": 1, "rows": [], "terminal_labels": {},
        "enclosure": {"code": "ZB33S", "modules": [
            {"id": "m1", "code": "ZU37KS", "field": 2, "unit": 0},
            {"id": "m2", "code": "ZH3EL22", "field": 0, "unit": 0, "meters": [{"place": 0, "number": "", "label": ""}]},
            # Place 3 does not exist on a two-place field: ignored, both stay free.
            {"id": "m3", "code": "ZH3EL22", "field": 1, "unit": 0, "meters": [{"place": 3, "number": "", "label": ""}]},
        ]},
    }
    lines = planned_lines(document, builtin_catalog())
    assert _keys(lines) == ["enclosure:ZB33S", "module:ZU37KS", "module:ZH3EL22", "accessory:KU40XXE"]
    by_key = _by_key(lines)
    assert by_key["module:ZH3EL22"].planned == 2
    cover = by_key["accessory:KU40XXE"]
    assert (cover.kind, cover.planned) == ("enclosure", 3)
    assert cover.label == "Blindabdeckung freier eHZ-Zählerplatz"
    assert cover.detail == "Blindabdeckung freier Zählerplatz · Hager KU40XXE · ungeprüft"


def test_accessories_of_the_cabinet_and_its_modules_add_up() -> None:
    catalog = _catalog_with(
        "ZB33S", accessories=[{"article_no": "ZZ55SAVE", "label": "Feldverbinder", "qty": 2, "verified": True}]
    )
    module_spec = copy.deepcopy(catalog.entries["ZU37KS"].spec)
    module_spec["accessories"] = [
        {"article_no": "ZZ55SAVE", "label": "Feldverbinder", "qty": 1, "verified": True},
        {"article_no": "VZ00APZ", "label": "APZ-Sockel", "qty": 1, "verified": False},
    ]
    entries = dict(catalog.entries)
    entries["ZU37KS"] = replace(entries["ZU37KS"], spec=module_spec)
    catalog = EnclosureCatalog(MappingProxyType(entries))
    document = {
        "version": 1, "rows": [], "terminal_labels": {},
        "enclosure": {"code": "ZB33S", "modules": [
            {"id": "m1", "code": "ZU37KS", "field": 0, "unit": 0},
            {"id": "m2", "code": "ZU37KS", "field": 1, "unit": 0},
        ]},
    }
    lines = _by_key(planned_lines(document, catalog))
    assert lines["accessory:ZZ55SAVE"].planned == 4
    assert lines["accessory:ZZ55SAVE"].detail == "Zubehör · Hager ZZ55SAVE"
    assert lines["accessory:VZ00APZ"].planned == 2
    assert lines["accessory:VZ00APZ"].detail == "Zubehör · Hager VZ00APZ · ungeprüft"
    assert line_article_numbers(document, catalog)["accessory:VZ00APZ"] == "VZ00APZ"


def test_an_unknown_module_is_listed_by_code_and_its_supplied_hs_is_still_skipped() -> None:
    document = cabinet_document()
    document["enclosure"]["modules"][0]["code"] = "ZX00GONE"
    lines = _by_key(planned_lines(document, builtin_catalog()))
    unknown = lines["module:ZX00GONE"]
    assert (unknown.label, unknown.planned) == ("Modul ZX00GONE (unbekannt)", 1)
    # The snapshot still says the HS is the module's: not a device line.
    assert "device:hauptschalter:3p:" not in lines
    # No spec, so no meter places and no blind plate guessed.
    assert not any(key.startswith("accessory:") for key in lines)
    assert "module:ZX00GONE" not in line_article_numbers(document, builtin_catalog())


def test_a_din_rail_meter_is_a_zwischenzaehler_on_cabinet_boards_only() -> None:
    document = cabinet_document()
    document["rows"][2]["devices"].append(device("dev-p1", "meter", designation="P1"))
    on_cabinet = [line for line in planned_lines(document, builtin_catalog()) if line.key.startswith("device:meter:")]
    assert [line.label for line in on_cabinet] == ["Zwischenzähler (Hutschiene)"]

    document["enclosure"] = None
    legacy = [line for line in planned_lines(document) if line.key.startswith("device:meter:")]
    assert [line.label for line in legacy] == ["Zähler / eHZ"]


# ── Pre-fitted parts: supplied, removed, second claimant ─────────────────────


def test_a_deleted_hs_becomes_a_removed_line_and_the_module_stays_as_bought() -> None:
    document = _without_hs(cabinet_document())
    lines = planned_lines(document, builtin_catalog())
    by_key = _by_key(lines)
    removed = by_key["removed:ZH3EH16:hs"]
    assert (removed.kind, removed.label, removed.planned) == ("removed", "Hauptschalter", 1)
    assert removed.detail == "aus Modul entfernt → ins Lager · ZH3EH16"
    assert by_key["module:ZH3EH16"].planned == 1
    assert "device:hauptschalter:3p:" not in by_key
    # Removed lines come after the devices (and terminals).
    assert _keys(lines)[-1] == "removed:ZH3EH16:hs"
    assert [(item.module_id, item.fitting_key) for item in removed_fittings(document, builtin_catalog())] == [
        ("mod-a", "hs")
    ]


def _fittings_with(code: str, **changes: dict) -> list[dict]:
    """The built-in fittings of ``code`` with some of them corrected, the way an admin would."""
    fittings = copy.deepcopy(builtin_catalog().module(code)["fittings"])
    for fitting in fittings:
        fitting.update(changes.get(fitting["key"], {}))
    return fittings


def test_a_removable_part_without_a_device_is_removed_by_its_key_and_a_fixed_one_never() -> None:
    # No built-in part without a device is removable, so this catalogue is an
    # admin's: the BKE-I of the meter field can come out, the busbar never.
    catalog = _catalog_with("ZH3EH16", fittings=_fittings_with("ZH3EH16", bke={"removable": True, "article_no": "ZX45BKE"}))
    document = cabinet_document()
    module = document["enclosure"]["modules"][0]
    module["fittings"].append(
        {"key": "bke", "label": "BKE-I Zählerplatz", "article_no": None, "device_kind": None, "removable": True}
    )
    module["removed_fittings"] = ["bke", "busbar"]  # the busbar is fixed: ignored
    lines = _by_key(planned_lines(document, catalog))
    assert [key for key in lines if key.startswith("removed:")] == ["removed:ZH3EH16:bke"]
    assert lines["removed:ZH3EH16:bke"].label == "BKE-I Zählerplatz"
    # The number the stock match looks for is the catalogue's, never the snapshot's.
    assert line_article_numbers(document, catalog)["removed:ZH3EH16:bke"] == "ZX45BKE"


def test_a_snapshot_can_neither_free_a_fixed_part_nor_name_its_article() -> None:
    """Any fitter writes the snapshot (it is part of the board). What a return
    books into stock is decided by the catalogue (admins) and the mapping
    (the Werkstatt) only — otherwise a crafted board names the article."""
    document = cabinet_document()
    distribution = document["enclosure"]["modules"][1]  # ZU37KS: its PE/N block is fixed
    distribution["fittings"] = [
        {"key": "pe_n", "label": "Hauptschalter 63 A", "article_no": "ZX-TEUER-1", "device_kind": None, "removable": True}
    ]
    distribution["removed_fittings"] = ["pe_n"]
    assert removed_fittings(document, builtin_catalog()) == []
    assert not any(key.startswith("removed:") for key in line_article_numbers(document, builtin_catalog()))

    # The RJ45 socket has a real article number; marking it removable changes nothing either.
    document["enclosure"]["modules"].append({
        "id": "mod-c", "code": "ZU37VT5APZ2", "field": 2, "unit": 0, "rails": {},
        "fittings": [{"key": "rj45", "label": "RJ45-Buchse", "article_no": "ZZ45WAN2PP", "device_kind": None,
                      "removable": True}],
        "removed_fittings": ["rj45"],
    })
    assert removed_fittings(document, builtin_catalog()) == []

    # A part that really comes out keeps the snapshot's label and count, but not its number.
    taken_out = _without_hs(cabinet_document())
    taken_out["enclosure"]["modules"][0]["fittings"][0]["article_no"] = "ZX-TEUER-1"
    assert "removed:ZH3EH16:hs" not in line_article_numbers(taken_out, builtin_catalog())  # HS article unknown (Q1)
    corrected = _catalog_with("ZH3EH16", fittings=_fittings_with("ZH3EH16", hs={"article_no": "ZX363N"}))
    assert line_article_numbers(taken_out, corrected)["removed:ZH3EH16:hs"] == "ZX363N"
    assert planned_lines(taken_out, corrected) == planned_lines(taken_out, builtin_catalog())


def test_only_the_first_claimant_is_the_fitting_and_a_dangling_claim_is_a_device() -> None:
    document = cabinet_document()
    document["rows"][1]["devices"].append(
        device("dev-q2", "hauptschalter", designation="Q2", supplied_by={"module": "mod-a", "part": "hs"})
    )
    document["rows"][2]["devices"].append(
        device("dev-q3", "hauptschalter", designation="Q3", supplied_by={"module": "mod-gone", "part": "hs"})
    )
    lines = _by_key(planned_lines(document, builtin_catalog()))
    assert lines["device:hauptschalter:3p:"].planned == 2
    assert supplied_device_ids(document, builtin_catalog()) == {"dev-q1"}
    assert not any(key.startswith("removed:") for key in lines)


def test_the_snapshot_decides_so_a_catalogue_edit_leaves_the_list_alone() -> None:
    document = _without_hs(cabinet_document())
    before = planned_lines(document, builtin_catalog())

    fittings = copy.deepcopy(builtin_catalog().module("ZH3EH16")["fittings"])
    for fitting in fittings:
        if fitting["key"] == "hs":
            fitting["label"] = "Hauptschalter 63 A (korrigiert)"
            fitting["article_no"] = "ZX363N"
    fittings.append({"key": "spd", "label": "Überspannungsschutz", "article_no": None, "removable": True,
                     "device": {"kind": "spd", "rail": "aar2", "te": 4, "poles": 4, "rating": "", "width_mm": None},
                     "verified": False, "note": "", "retired": False})
    edited = _catalog_with("ZH3EH16", fittings=fittings)
    assert planned_lines(document, edited) == before
    # The module's snapshot has no HLAK either: the live catalogue's would be "removed".
    assert [fitting["key"] for fitting in module_fittings(document["enclosure"]["modules"][0], edited)] == ["hs", "busbar"]


def test_an_empty_snapshot_is_a_snapshot_so_a_fitting_added_later_changes_nothing() -> None:
    """ZU37RK ships without fittings, so its placement stores ``fittings: []``.
    That is the board's record of "nothing came pre-fitted", not a missing
    snapshot: a device fitting an admin adds later must not turn up on the
    board as a part taken out (stock from nowhere at the next return)."""
    document = cabinet_document()
    document["enclosure"]["modules"].append(
        {"id": "mod-r", "code": "ZU37RK", "field": 2, "unit": 0, "rails": {}, "fittings": [], "removed_fittings": []}
    )
    before = planned_lines(document, builtin_catalog())
    hs = {"key": "hs", "label": "Hauptschalter", "article_no": "ZX363N", "removable": True, "verified": False,
          "note": "", "retired": False,
          "device": {"kind": "hauptschalter", "rail": "r1", "te": 3, "poles": 3, "rating": "", "width_mm": None}}
    edited = _catalog_with("ZU37RK", fittings=[hs])
    assert module_fittings(document["enclosure"]["modules"][2], edited) == []
    assert removed_fittings(document, edited) == []
    assert planned_lines(document, edited) == before


def test_a_module_without_a_snapshot_falls_back_to_the_catalogue() -> None:
    # A hand-made module: no "fittings" key at all, or null — never an empty list.
    for module in ({"id": "m1", "code": "ZH3EH16", "field": 0, "unit": 0},
                   {"id": "m1", "code": "ZH3EH16", "field": 0, "unit": 0, "fittings": None}):
        keys = [(fitting["key"], fitting["device_kind"]) for fitting in module_fittings(module, builtin_catalog())]
        assert keys == [("busbar", None), ("bke", None), ("hs", "hauptschalter"), ("hlak", "hlak")]
        assert module_fittings({**module, "code": "ZX00GONE"}, builtin_catalog()) == []


# ── The list over the API: articles and mappings ─────────────────────────────


def test_the_cabinet_finds_its_article_by_a_whole_token_and_a_longer_code_never_matches(
    client: TestClient, admin_token: str
) -> None:
    cabinet = article("Hager ZB33S – Zählerschrank univers Z 3-feldig", stock=2, manufacturer="Hager")
    article("Hager ZH3EH16N Komplettfeld", stock=1, manufacturer="Hager")
    panel = create_panel(client, admin_token, cabinet_document())
    body = _material(client, admin_token, panel["id"])

    line = _line(body, "enclosure:ZB33S")
    assert (line["article"]["id"], line["article_source"]) == (cabinet, "auto")
    assert line["article"]["stock_available"] == 2
    assert _line(body, "module:ZH3EH16")["article"] is None
    assert [line["kind"] for line in body["lines"][:3]] == ["enclosure"] * 3


def test_the_mapping_takes_the_new_keys_and_a_return_only_from_the_werkstatt(
    client: TestClient, admin_token: str
) -> None:
    fitter = employee(client, admin_token, "monteur.material@example.com")
    panel = create_panel(client, admin_token, _without_hs(cabinet_document()))
    hs = article("Hauptschalter 3-polig 63 A (Testartikel)", stock=0)
    plate = article("Blindabdeckung (Testartikel)", stock=0)

    for key in ("enclosure:ZB33S", "module:ZU37KS", "accessory:KU40XXE"):
        resp = client.put(MAPPING, headers=auth(fitter), json={"key": key, "article_id": plate})
        assert resp.status_code == 200, (key, resp.text)

    refused = client.put(MAPPING, headers=auth(fitter), json={"key": "removed:ZH3EH16:hs", "article_id": hs})
    assert refused.status_code == 403
    assert refused.json()["detail"] == "Rückläufe ordnet die Werkstatt zu."
    forget = client.put(MAPPING, headers=auth(fitter), json={"key": "removed:ZH3EH16:hs", "article_id": None})
    assert forget.status_code == 403

    for key in ("article:5", "salvage:5", "terminal:x"):
        assert client.put(MAPPING, headers=auth(admin_token), json={"key": key, "article_id": hs}).status_code == 400

    mapped = client.put(MAPPING, headers=auth(admin_token), json={"key": "removed:ZH3EH16:hs", "article_id": hs})
    assert mapped.status_code == 200, mapped.text
    body = _material(client, admin_token, panel["id"])
    line = _line(body, "removed:ZH3EH16:hs")
    assert (line["article"]["id"], line["article_source"], line["status"]) == (hs, "mapping", "open")
    assert _line(body, "module:ZU37KS")["article_source"] == "mapping"


def test_consumption_never_ticks_a_removed_line_and_shows_as_not_planned(client: TestClient, admin_token: str) -> None:
    panel = create_panel(client, admin_token, _without_hs(cabinet_document()))
    hs = article("Hauptschalter 3-polig 63 A (Testartikel)", stock=3)
    assert client.put(
        MAPPING, headers=auth(admin_token), json={"key": "removed:ZH3EH16:hs", "article_id": hs}
    ).status_code == 200

    booked = client.post(
        f"/api/schaltplan/panels/{panel['id']}/material/book", headers=auth(admin_token),
        json={"article_id": hs, "quantity": 1},
    )
    assert booked.status_code == 200, booked.text
    body = booked.json()
    assert (_line(body, "removed:ZH3EH16:hs")["scanned"], _line(body, "removed:ZH3EH16:hs")["status"]) == (0, "open")
    extra = _line(body, f"article:{hs}")
    assert (extra["kind"], extra["scanned"], extra["detail"]) == ("extra", 1, "nicht geplant")
    # Returns are not picks: the removed line stays out of every picking total
    # (the extra counts as scanned, as any unplanned booking does).
    assert (body["planned_total"], body["scanned_total"], body["open_lines"]) == (6, 1, 6)
    assert body["returns_open"] == 1


# ── Round 2: WAGO terminals on the cabinet's rails (docs/PANEL_ENCLOSURE_R2.md §5) ──

U84T = "accessory:U84T"
U84T_LABEL = "Isolierstück univ. Z, mit Schrauben, Satz=2 St."
U84T_DETAIL = "Hutschienen-Isolierung je Klemmen-Hutschiene · Hager U84T"
U84T_EAN = "4010330552465"
RAIL_PART_KEYS = ("part:2003-7692", "part:2016-7691", "part:249-116")


def _terminal_lines(lines) -> list[tuple[str, int]]:
    return [(line.key, line.planned) for line in lines if line.kind == "terminal"]


def _bom_lines(rows) -> list[tuple[str, int]]:
    return [(f"part:{row['part_id']}", row["count"]) for row in rows]


def test_a_legacy_board_with_terminals_lists_exactly_its_old_terminal_lines() -> None:
    document = terminals_zb34s()
    document["enclosure"] = None
    lines = planned_lines(document)
    # The old derivation: no skip set, no rail parts, no U84T.
    assert _terminal_lines(lines) == _bom_lines(terminal_bom(derive_terminals(document)))
    assert not any(line.key in (U84T, *RAIL_PART_KEYS) for line in lines)


def test_u84t_is_one_set_per_terminal_rail_holding_a_strip_among_the_accessories() -> None:
    lines = planned_lines(meter_dist_zb33s(), builtin_catalog())
    by_key = _by_key(lines)
    u84t = by_key[U84T]
    # Fields 2 and 3 each hold one strip on their top terminal rail.
    assert (u84t.kind, u84t.label, u84t.detail, u84t.planned) == ("enclosure", U84T_LABEL, U84T_DETAIL, 2)
    keys = _keys(lines)
    first_device = next(index for index, line in enumerate(lines) if line.kind == "device")
    assert keys.index("module:ZU37VT5APZ2") < keys.index(U84T) < first_device
    assert line_article_numbers(meter_dist_zb33s(), builtin_catalog())[U84T] == "U84T"


def test_rk_fields_need_no_u84t_and_no_strip_means_no_u84t_and_no_plate() -> None:
    assert U84T not in _by_key(planned_lines(terminals_rk_zb53s(), builtin_catalog()))
    # The empty ZU37RK adds nothing; fields 2 and 4 hold strips on both terminal rails.
    assert _by_key(planned_lines(terminals_zb34s(), builtin_catalog()))[U84T].planned == 4
    keys = _keys(planned_lines(cabinet_document(), builtin_catalog()))
    assert not any(key in keys for key in (U84T, *RAIL_PART_KEYS))


def test_an_admin_u84t_accessory_means_the_same_sets_so_the_larger_count_wins() -> None:
    def catalog_with_admin_u84t(qty: int) -> EnclosureCatalog:
        accessory = {"article_no": "U84T", "label": "Isolierung (Admin)", "qty": qty, "verified": False}
        return _catalog_with("ZU37KS", accessories=[accessory])

    for qty, expected in ((1, 2), (5, 5)):
        lines = planned_lines(meter_dist_zb33s(), catalog_with_admin_u84t(qty))
        u84t = [line for line in lines if line.key == U84T]
        assert [(line.label, line.detail, line.planned) for line in u84t] == [(U84T_LABEL, U84T_DETAIL, expected)]


def test_each_terminal_rail_gets_the_end_plate_of_its_last_terminal_block_and_no_end_stop() -> None:
    lines = _by_key(planned_lines(terminals_rk_zb53s(), builtin_catalog()))
    orange, grey = lines["part:2003-7692"], lines["part:2016-7691"]
    assert (orange.kind, orange.label, orange.detail, orange.planned) == (
        "terminal", "WAGO 2003-7692", "Abschluss- und Zwischenplatte, 0,8 mm, orange", 2)
    # Field 3's rail ends in the wallbox Block: a 2016-76xx terminal, the grey plate.
    assert (grey.kind, grey.label, grey.detail, grey.planned) == (
        "terminal", "WAGO 2016-7691", "Abschlussplatte, 1 mm, grau", 1)
    assert "part:249-116" not in lines  # owner, 2026-10-22: no end stops
    assert [key for key in lines if key.startswith("part:")] == [
        "part:2003-7641", "part:2003-7692", "part:2009-305", "part:2016-7601", "part:2016-7604", "part:2016-7607",
        "part:2016-7691", "part:2016-7714",
    ]


def test_an_aar_circuit_with_terminal_block_is_not_counted_and_unplaced_strips_are() -> None:
    document = terminals_zb34s()
    lines = _by_key(planned_lines(document, builtin_catalog()))
    unskipped = dict(_bom_lines(terminal_bom(derive_terminals(document))))
    # F0.1 sits on the AAR: its 2003-7641 is gone from the list.
    assert lines["part:2003-7641"].planned == unskipped["part:2003-7641"] - 1
    placement = place_terminals(document, builtin_catalog())
    assert [entry["xLabel"] for field in placement["fields"] for entry in field["unplaced"]] == ["X4", "X5", "X6"]
    # X4–X6 have no place but must be bought: all eleven FI feeds are counted.
    assert lines["part:2016-7714"].planned == 11
    # Plates only for rails that hold a strip: field 2 r1/r2, field 4 r2 (orange) and r1 (ends in the Block).
    assert (lines["part:2003-7692"].planned, lines["part:2016-7691"].planned) == (3, 1)


def test_the_u84t_line_finds_its_article_by_ean_before_a_name_match(client: TestClient, admin_token: str) -> None:
    by_name = article("Hager U84T Isolierstück univ. Z (Testartikel)", stock=1)
    by_ean = article("Isolierstück Satz 2 Stück (Testartikel)", stock=4, ean=U84T_EAN)
    panel = create_panel(client, admin_token, meter_dist_zb33s())
    line = _line(_material(client, admin_token, panel["id"]), U84T)
    assert (line["article"]["id"], line["article_source"], line["planned"]) == (by_ean, "auto", 2)
    assert by_name != by_ean


def test_a_mapping_beats_the_ean_and_u84tx_never_matches(client: TestClient, admin_token: str) -> None:
    article("Hager U84TX Sonderteil (Testartikel)", stock=1)
    panel = create_panel(client, admin_token, meter_dist_zb33s())
    assert _line(_material(client, admin_token, panel["id"]), U84T)["article"] is None

    article("Isolierstück mit EAN (Testartikel)", stock=1, ean=U84T_EAN)
    mapped = article("Isolierung, wie die Werkstatt sie nennt (Testartikel)", stock=1)
    resp = client.put(MAPPING, headers=auth(admin_token), json={"key": U84T, "article_id": mapped})
    assert resp.status_code == 200, resp.text
    line = _line(_material(client, admin_token, panel["id"]), U84T)
    assert (line["article"]["id"], line["article_source"]) == (mapped, "mapping")


def test_consumption_ticks_an_end_plate_line(client: TestClient, admin_token: str) -> None:
    plate = article("WAGO 2003-7692 - Abschlussplatte orange (Testartikel)", stock=10)
    panel = create_panel(client, admin_token, meter_dist_zb33s())
    booked = client.post(
        f"/api/schaltplan/panels/{panel['id']}/material/book", headers=auth(admin_token),
        json={"article_id": plate, "quantity": 1},
    )
    assert booked.status_code == 200, booked.text
    line = _line(booked.json(), "part:2003-7692")
    assert (line["article"]["id"], line["planned"], line["scanned"], line["status"]) == (plate, 2, 1, "open")
