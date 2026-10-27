"""The cabinet preparation on the Materialliste (docs/PANEL_ENCLOSURE_R4.md §6).

What must hold: a cabinet board lists what ``cabinet_prep`` derives —
Spannungsversorgung kit, infeed part, busbar joints, network lead, the §14a
block, its wires and the Lüsterklemme — as ``enclosure`` lines after the
accessories and before the devices, in the derivation's order; an item an
override switched off gets no line; a Hager article an admin also lists as
an accessory is one line at the admin's slot (the larger count, the derived
words); ``accessory:``/``part:`` lines find their article by number, while
``wire:``/``prep:`` lines wait for a mapping, which the route now accepts.

Every board here is invented; only the Hager and WAGO codes are real.
"""

from __future__ import annotations

import copy
from dataclasses import replace
from types import MappingProxyType

import pytest
from fastapi.testclient import TestClient

from app.schemas.panel_enclosure import EnclosureSpec
from app.services.panel_enclosure_catalog import EnclosureCatalog, builtin_catalog
from app.services.panel_enclosure_material import line_article_numbers
from app.services.panel_enclosure_prep import cabinet_prep
from app.services.panel_enclosure_prep_material import (
    item_detail,
    prep_article_numbers,
    prep_items,
    prep_planned_lines,
)
from app.services.schaltplan_material import planned_lines
from scripts.write_enclosure_fixtures import (
    busbar_gap_zb34s,
    control_3p_zb53s,
    control_ehz_zb33s,
    meter_dist_zb33s,
    reserve_zb33s,
    terminals_zb34s,
)
from tests.panel_enclosure_helpers import article, auth, create_panel, employee

CATALOG = builtin_catalog()
MAPPING = "/api/schaltplan/material/mapping"
REFUSED = ("Nur geplante Positionen (Gerät, Klemme, Schrank, Modul, Zubehör, Aderleitung, Schrankvorbereitung, "
           "Rücklauf) können zugeordnet werden.")
JOINT = "accessory:ZZ55SAVE"
JOINT_LABEL = "Sammelschienenverbinder Feld/Feld, 5-polig, 12×5 mm, 250 A"


def _keys(lines) -> list[str]:
    return [line.key for line in lines]


def _by_key(lines) -> dict:
    return {line.key: line for line in lines}


def _active_keys(document: dict, catalog: EnclosureCatalog = CATALOG) -> list[str]:
    prep = cabinet_prep(document, catalog)
    assert prep is not None
    return [item["key"] for item in prep["items"] if item["qty"] > 0]


def _catalog_with(code: str, **changes) -> EnclosureCatalog:
    """The built-in catalogue with one spec edited, the way an admin override would."""
    spec = copy.deepcopy(CATALOG.entries[code].spec)
    spec.update(changes)
    entries = dict(CATALOG.entries)
    entries[code] = replace(entries[code], spec=spec, source="override")
    return EnclosureCatalog(MappingProxyType(entries))


def _admin_accessory(number: str, qty: int, label: str = "Feldverbinder (Admin)", cabinet: str = "ZB33S"
                     ) -> EnclosureCatalog:
    return _catalog_with(cabinet, accessories=[{"article_no": number, "label": label, "qty": qty, "verified": True}])


# ── Where the lines go ───────────────────────────────────────────────────────


def test_prep_lines_follow_the_accessories_and_lead_the_devices_in_derivation_order() -> None:
    document = control_ehz_zb33s()
    lines = planned_lines(document, CATALOG)
    keys = _keys(lines)
    expected = _active_keys(document)
    assert expected[:4] == ["accessory:ZY3N2SA", "accessory:K96ESA5", JOINT, "accessory:ZZ45WAN100"]
    start = keys.index(expected[0])
    assert keys[start:start + len(expected)] == expected
    # Right behind the accessories (U84T is the last of them) and right before the first device.
    assert keys[start - 1] == "accessory:U84T"
    assert lines[start + len(expected)].kind == "device"
    assert all(line.kind == "enclosure" for line in lines[start:start + len(expected)])
    assert len(keys) == len(set(keys))  # never two lines with one key


def test_each_line_carries_the_item_s_label_count_and_reason() -> None:
    lines = _by_key(planned_lines(control_ehz_zb33s(), CATALOG))
    wire = lines["wire:h07vk:2.5:braun"]
    assert (wire.kind, wire.label, wire.planned) == ("enclosure", "Aderleitung H07V-K 1 × 2,5 mm² braun", 1)
    assert wire.detail == "UNSM · Klemmleiste → RfZ · ≈ 1 m je Ader · Meter · ungeprüft"
    terminal = lines["part:2002-1671"]
    assert (terminal.label, terminal.planned) == ("WAGO 2002-1671 2-Leiter-Trenn- und Messklemme", 6)
    assert terminal.detail == "§14a-Steuersignal-Klemmleiste, Feld 1 · F1 · AAR 1"
    assert (lines["part:249-116"].planned, lines["part:2002-1692"].planned) == (2, 1)
    assert (lines[JOINT].label, lines[JOINT].detail, lines[JOINT].planned) == (
        JOINT_LABEL, "1 Feldübergang: Feld 1–2", 1)
    assert lines["prep:luesterklemme"].detail == "Gegenstück am RfZ Feld 1 · ungeprüft"
    assert lines["prep:luesterklemme"].label == "Lüsterklemme 6-polig (von 12-poliger Leiste)"


def test_wire_metres_add_up_per_colour_and_a_stored_length_wins() -> None:
    lines = _by_key(planned_lines(control_3p_zb53s(), CATALOG))
    # 1,2 m stored; braun carries UNSM and Stve: ceil(2 × 1,2) = 3 m.
    braun = lines["wire:h07vk:2.5:braun"]
    assert (braun.planned, braun.detail) == (3, "UNSM, Stve · Klemmleiste → APZ · ≈ 1,2 m je Ader · Meter · ungeprüft")
    assert lines["wire:h07vk:2.5:schwarz"].planned == 2
    assert "wire:h07vk:2.5:rot" not in lines  # "0%" was removed with its colour
    assert lines["accessory:K96F"].planned == 5
    assert lines["accessory:K96F"].detail.endswith(" · ungeprüft")


def test_an_item_switched_off_gets_no_line_and_the_pen_split_is_mapping_only() -> None:
    gap = _by_key(planned_lines(busbar_gap_zb34s(), CATALOG))
    assert not any(key.startswith("accessory:ZZ45WAN") for key in gap)  # network: off
    assert gap["accessory:K96ESA5"].planned == 2  # two main runs, one infeed each
    assert gap["accessory:ZY3N2LS"].planned == 1  # supply: LS
    reserve = _by_key(planned_lines(reserve_zb33s(), CATALOG))
    pen = reserve["prep:pen_split"]
    assert (pen.label, pen.planned) == ("PEN-Aufteilung im NAR (z. B. Hager N75B / ZM35PE)", 1)
    assert pen.detail == "Zuleitung 4-adrig im TN-C-S-System · PEN im NAR von Feld 1 aufteilen · ungeprüft"
    assert "prep:pen_split" not in line_article_numbers(reserve_zb33s(), CATALOG)


def test_details_add_the_metre_and_unchecked_notes_in_that_order() -> None:
    base = {"key": "wire:h07vk:1.5:rot", "articleNo": None, "label": "x", "qty": 2, "unit": "m", "reason": "R",
            "verified": False, "group": "control", "override": None, "suppressed": False}
    assert item_detail(base) == "R · Meter · ungeprüft"
    assert item_detail({**base, "unit": "Stk"}) == "R · ungeprüft"
    assert item_detail({**base, "unit": "Stk", "verified": True}) == "R"


def test_a_board_without_a_known_cabinet_gets_no_prep_line() -> None:
    legacy = meter_dist_zb33s()
    legacy["enclosure"] = None
    assert prep_items(legacy, CATALOG) == ()
    unknown = meter_dist_zb33s()
    unknown["enclosure"]["code"] = "ZX00CAB"
    assert prep_items(unknown, CATALOG) == ()
    assert not any(key.startswith(("wire:", "prep:", "part:2002-")) for key in _keys(planned_lines(unknown, CATALOG)))


def test_the_pure_helpers_never_touch_their_input() -> None:
    document = control_ehz_zb33s()
    frozen = copy.deepcopy(document)
    items = prep_items(document, CATALOG)
    assert document == frozen
    before = copy.deepcopy(items)
    prep_planned_lines(items, {"ZZ55SAVE"})
    prep_article_numbers(items)
    assert items == before


# ── An admin accessory naming a derived article ──────────────────────────────


def test_an_admin_accessory_for_a_derived_article_is_one_line_at_the_admin_slot() -> None:
    for qty, expected in ((1, 1), (3, 3)):
        lines = planned_lines(control_ehz_zb33s(), _admin_accessory("ZZ55SAVE", qty))
        keys = _keys(lines)
        assert keys.count(JOINT) == 1
        # The cabinet's accessory comes first among the accessories: its slot, not the prep block's.
        assert keys.index(JOINT) < keys.index("accessory:U84T") < keys.index("accessory:ZY3N2SA")
        joint = _by_key(lines)[JOINT]
        assert (joint.label, joint.detail, joint.planned) == (JOINT_LABEL, "1 Feldübergang: Feld 1–2", expected)


@pytest.mark.parametrize("typed", ["ZZ55SAVE", "zz55save", " Zz55Save "])
def test_an_admin_accessory_typed_in_any_case_is_still_one_line(typed: str) -> None:
    """The catalogue stores article numbers upper-cased, as it does codes: an
    iPad's "Zz55save" would otherwise double the connector and split its bookings."""
    raw = {**copy.deepcopy(CATALOG.entries["ZB33S"].spec),
           "accessories": [{"article_no": typed, "label": "Feldverbinder (Admin)", "qty": 1, "verified": True}]}
    spec = EnclosureSpec.model_validate(raw).model_dump()
    entries = dict(CATALOG.entries)
    entries["ZB33S"] = replace(entries["ZB33S"], spec=spec, source="override")
    catalog = EnclosureCatalog(MappingProxyType(entries))
    lines = planned_lines(control_ehz_zb33s(), catalog)
    assert [line.key for line in lines if line.key.lower() == JOINT.lower()] == [JOINT]
    assert _by_key(lines)[JOINT].planned == 1
    accessories = [n for n in line_article_numbers(control_ehz_zb33s(), catalog) if n.startswith("accessory:")]
    assert accessories and all(n == n.upper().replace("ACCESSORY:", "accessory:") for n in accessories)


def test_an_admin_accessory_the_board_has_switched_off_stays_the_admin_s_line() -> None:
    catalog = _admin_accessory("ZZ45WAN150", 2, label="Patchkabel (Admin)", cabinet="ZB34S")
    lines = planned_lines(busbar_gap_zb34s(), catalog)
    lead = [line for line in lines if line.key == "accessory:ZZ45WAN150"]
    assert [(line.label, line.detail, line.planned) for line in lead] == [
        ("Patchkabel (Admin)", "Zubehör · Hager ZZ45WAN150", 2)]


def test_an_admin_accessory_without_a_derived_twin_is_left_alone() -> None:
    catalog = _admin_accessory("VZ00APZ", 1, label="APZ-Sockel", cabinet="ZB34S")
    lines = _by_key(planned_lines(terminals_zb34s(), catalog))
    assert (lines["accessory:VZ00APZ"].label, lines["accessory:VZ00APZ"].planned) == ("APZ-Sockel", 1)


# ── Article numbers ──────────────────────────────────────────────────────────


def test_hager_and_wago_lines_look_for_their_number_and_wires_wait_for_a_mapping() -> None:
    numbers = line_article_numbers(control_ehz_zb33s(), CATALOG)
    for key, number in (("accessory:ZY3N2SA", "ZY3N2SA"), ("accessory:K96ESA5", "K96ESA5"), (JOINT, "ZZ55SAVE"),
                        ("accessory:ZZ45WAN100", "ZZ45WAN100"), ("part:249-116", "249-116"),
                        ("part:2002-1671", "2002-1671"), ("part:2002-1692", "2002-1692")):
        assert numbers[key] == number, key
    assert not any(key.startswith(("wire:", "prep:")) for key in numbers)
    # A switched-off item has no line, so nothing to match.
    assert "accessory:ZZ45WAN150" not in line_article_numbers(busbar_gap_zb34s(), CATALOG)


# ── Over the API ─────────────────────────────────────────────────────────────


def _material(client: TestClient, token: str, panel_id: int) -> dict:
    resp = client.get(f"/api/schaltplan/panels/{panel_id}/material", headers=auth(token))
    assert resp.status_code == 200, resp.text
    return resp.json()


def _line(body: dict, key: str) -> dict:
    return next(line for line in body["lines"] if line["key"] == key)


def test_wago_and_hager_articles_match_by_number_and_a_longer_code_never(client: TestClient, admin_token: str) -> None:
    clamp = article("WAGO 249-116 Endklammer (Testartikel)", stock=20, manufacturer="WAGO")
    adapter = article("Hager K96ESA5 Einspeiseadapter (Testartikel)", stock=2, manufacturer="Hager")
    article("Hager ZZ55SAVEX Sonderteil (Testartikel)", stock=1, manufacturer="Hager")
    panel = create_panel(client, admin_token, control_ehz_zb33s())
    body = _material(client, admin_token, panel["id"])
    end_stop = _line(body, "part:249-116")
    assert (end_stop["article"]["id"], end_stop["article_source"]) == (clamp, "auto")
    assert _line(body, "accessory:K96ESA5")["article"]["id"] == adapter
    assert _line(body, JOINT)["article"] is None
    assert _line(body, "wire:h07vk:2.5:braun")["article"] is None


def test_a_fitter_maps_wire_and_prep_lines_and_bookings_tick_them(client: TestClient, admin_token: str) -> None:
    fitter = employee(client, admin_token, "monteur.vorbereitung@example.com")
    panel = create_panel(client, admin_token, control_ehz_zb33s())
    wire = article("Aderleitung H07V-K 2,5 mm² braun (Testartikel)", stock=100)
    block = article("Lüsterklemme 12-polig (Testartikel)", stock=10)
    for key, article_id in (("wire:h07vk:2.5:braun", wire), ("prep:luesterklemme", block)):
        resp = client.put(MAPPING, headers=auth(fitter), json={"key": key, "article_id": article_id})
        assert resp.status_code == 200, (key, resp.text)

    booked = client.post(f"/api/schaltplan/panels/{panel['id']}/material/book", headers=auth(admin_token),
                         json={"article_id": wire, "quantity": 1})
    assert booked.status_code == 200, booked.text
    line = _line(booked.json(), "wire:h07vk:2.5:braun")
    assert (line["article"]["id"], line["article_source"]) == (wire, "mapping")
    assert (line["scanned"], line["status"]) == (1, "done")
    assert _line(booked.json(), "prep:luesterklemme")["article_source"] == "mapping"


def test_an_unknown_prefix_is_refused_with_the_list_of_what_can_be_mapped(client: TestClient, admin_token: str) -> None:
    target = article("Irgendein Teil (Testartikel)", stock=0)
    for key in ("kabel:h07vk", "article:5", "salvage:5"):
        resp = client.put(MAPPING, headers=auth(admin_token), json={"key": key, "article_id": target})
        assert resp.status_code == 400, key
        assert resp.json()["detail"] == REFUSED
