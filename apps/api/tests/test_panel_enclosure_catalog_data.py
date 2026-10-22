"""The built-in Hager univers Z catalogue (docs/PANEL_ENCLOSURE.md §3.1, §3.2, §3.5).

Two kinds of guard live here:

* the data says what §3.2 says — the table is restated below in a compact
  notation, so a typo in the data module (a rail key, a zone height, a
  wiring cross-section) is caught by a second, independent spelling of it;
* the shipped record (``tests/fixtures/enclosure_catalog_shipped.json``)
  holds every built-in code ever shipped with the facts stored boards rely
  on. A board placed today must still resolve its codes, rails and fittings
  after any later edit of the data module, so a built-in may never vanish,
  never lose or rename a key, and never change its size while boards use it.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from app.schemas.panel_enclosure import (
    MAX_FITTINGS_PER_MODULE,
    MAX_METERS_PER_MODULE,
    MAX_RAILS_PER_MODULE,
    EnclosureSpec,
    ModuleSpec,
)
from app.schemas.schaltplan import PanelRow
from app.services.panel_enclosure_catalog import (
    builtin_catalog,
    fitting_kinds,
    frozen_fields,
    rail_keys,
)
from app.services.panel_enclosure_catalog_data import BUILTIN_ENCLOSURES, BUILTIN_MODULES
from app.services.panel_enclosure_layout import default_rail_label
from app.services.schaltplan_layout import DEVICE_KINDS

SHIPPED = Path(__file__).resolve().parent / "fixtures" / "enclosure_catalog_shipped.json"

CABINETS = {
    # code: (height, width, fields, units per field, door leaves, verified)
    "ZB32S": (1100, 550, 2, 7, 1, True),
    "ZB33S": (1100, 800, 3, 7, 2, True),
    "ZB34S": (1100, 1050, 4, 7, 2, True),
    "ZB35S": (1100, 1300, 5, 7, 2, True),
    "ZB52S": (1400, 550, 2, 9, 1, True),
    "ZB53S": (1400, 800, 3, 9, 2, False),
    "ZB54S": (1400, 1050, 4, 9, 2, True),
    "ZB55S": (1400, 1300, 5, 9, 2, True),
}

# §3.2 in a compact spelling: "TYPE first-last rail,rail" per zone, top to
# bottom; "*" marks a busbar rail, "(6)" a 6-PLE rail, "a..b" a numbered run.
E1050 = "AAR 0-1 aar1,aar2 | RFZ 2 rfz | ZF 3-4 | NAR 5-6 nar*"
P1050 = "AAR 0-1 aar1,aar2 | ZF 2-4 | NAR 5-6 nar*"
E1350 = "VF 0-1 vf1,vf2 | AAR 2-3 aar1,aar2 | RFZ 4 rfz | ZF 5-6 | NAR 7-8 nar*"
BUSBAR, BKE, PE_N, RJ45 = {"busbar": None}, {"bke": None}, {"pe_n": None}, {"rj45": None}

MODULES = {
    # code: (family, field height, zones, (meter places, meter type) | None, mm², {fitting: device kind})
    "ZH3EL27": ("meter_ehz", 1050, E1050, (1, "ehz"), 10, BUSBAR | BKE),
    "ZH3EL22": ("meter_ehz", 1050, E1050, (2, "ehz"), None, BUSBAR | BKE),
    "ZH3EL16": ("meter_ehz", 1050, E1050, (1, "ehz"), 16, BUSBAR | BKE | {"hlak": "hlak"}),
    "ZH3EH16": ("meter_ehz", 1050, E1050, (1, "ehz"), None, BUSBAR | BKE | {"hs": "hauptschalter", "hlak": "hlak"}),
    "ZH33X7": ("meter_3p", 1050, P1050, (1, "3punkt"), None, BUSBAR),
    "ZH31X7NT": ("meter_3p", 1050, P1050, (1, "3punkt"), 10, BUSBAR | {"trenn": "hauptschalter"}),
    "ZU37KS": ("distribution", 1050, "VT 0-6 r1..r7", None, None, PE_N),
    "ZU37RK": ("distribution", 1050, "VT 0-6 r1..r7", None, None, {}),
    "ZU37VT5APZ2": ("distribution_apz", 1050, "VT 0-4 r1..r5 | APZ 5-6 apz(6)", None, None, RJ45),
    "ZU37VT4APZ2": ("distribution_apz", 1050, "VT 0-3 r1..r4 | RFZ 4 rfz | APZ 5-6 apz(6)", None, None, RJ45),
    "ZH3ES5": ("busbar", 1050, "SAS 0-1 sas* | VT 2-6 r1..r5", None, None, BUSBAR | PE_N),
    "ZH33SAR2": ("communication", 1050, "APZ 0-1 apz(6) | RFZ 2-4 rfz1..rfz3 | SAS 5-6 sas*", None, None, BUSBAR),
    "ZH5EL27": ("meter_ehz", 1350, E1350, (1, "ehz"), None, BUSBAR | BKE),
    "ZH5EL22": ("meter_ehz", 1350, E1350, (2, "ehz"), None, BUSBAR | BKE),
    "ZH5EL16": ("meter_ehz", 1350, E1350, (1, "ehz"), 16, BUSBAR | BKE | {"hlak": "hlak"}),
    "ZH53X3": ("meter_3p", 1350, "AAR 0-1 aar1,aar2 | ZF 2-6 | NAR 7-8 nar*", (2, "3punkt"), None, BUSBAR),
    "ZU59KS": ("distribution", 1350, "VT 0-8 r1..r9", None, None, PE_N),
    "ZU59RK": ("distribution", 1350, "VT 0-8 r1..r9", None, None, {}),
    "ZU59VT7APZ2": ("distribution_apz", 1350, "VT 0-6 r1..r7 | APZ 7-8 apz(6)", None, None, RJ45),
    "ZH53XS": ("busbar", 1350, "SAS 0-1 sas* | VT 2-8 r1..r7", None, None, BUSBAR | PE_N),
    "ZH55SAR2": ("communication", 1350, "APZ 0-1 apz(6) | RFZ 2-6 rfz1..rfz5 | SAS 7-8 sas*", None, None, BUSBAR),
    "ZY150RFZ": ("communication", None, "RFZ 0 rfz", None, None, {}),
    "ZU62A": ("cover", None, "COVER 0", None, None, {}),
    "ZU79A": ("cover", None, "COVER 0-1", None, None, {}),
    "ZU93A": ("cover", None, "COVER 0-2", None, None, {}),
}


def _expand(rails: str) -> list[tuple[str, int, str]]:
    """'r1..r3' / 'aar1,aar2' / 'nar*' / 'apz(6)' → [(key, ple, mount)]."""
    out: list[tuple[str, int, str]] = []
    for token in rails.split(","):
        ple = 6 if token.endswith("(6)") else 12
        mount = "busbar" if token.endswith("*") else "rail"
        token = token.removesuffix("(6)").removesuffix("*")
        run = re.fullmatch(r"([a-z]+)(\d+)\.\.\1(\d+)", token)
        keys = [f"{run.group(1)}{i}" for i in range(int(run.group(2)), int(run.group(3)) + 1)] if run else [token]
        out.extend((key, ple, mount) for key in keys)
    return out


def _zones(notation: str) -> list[tuple[str, int, int, list[tuple[str, int, int, str]]]]:
    """→ [(type, unit, units, [(rail key, rail unit, ple, mount)])], top to bottom."""
    zones = []
    for part in notation.split(" | "):
        fields = part.split(" ")
        kind, span = fields[0], fields[1]
        first, _, last = span.partition("-")
        unit, units = int(first), int(last or first) - int(first) + 1
        rails = _expand(fields[2]) if len(fields) > 2 else []
        zones.append((kind, unit, units, [(key, index, ple, mount) for index, (key, ple, mount) in enumerate(rails)]))
    return zones


def _spec_zones(spec: dict) -> list[tuple[str, int, int, list[tuple[str, int, int, str]]]]:
    return [
        (zone["type"], zone["unit"], zone["units"],
         [(rail["key"], rail["unit"], rail["ple"], rail["mount"]) for rail in zone["rails"]])
        for zone in sorted(spec["zones"], key=lambda zone: zone["unit"])
    ]


# ── cabinets ─────────────────────────────────────────────────────────────────


def test_exactly_the_eight_cabinets_of_d5_ship() -> None:
    catalog = builtin_catalog()
    codes = [code for code, entry in catalog.entries.items() if entry.entry_type == "enclosure"]
    assert codes == list(CABINETS)
    assert [spec["code"] for spec in BUILTIN_ENCLOSURES] == list(CABINETS)


@pytest.mark.parametrize("code", list(CABINETS))
def test_each_cabinet_matches_the_table_and_its_raster(code: str) -> None:
    height, width, fields, units, leaves, verified = CABINETS[code]
    spec = builtin_catalog().enclosure(code)
    assert spec is not None
    assert (spec["height_mm"], spec["width_mm"], spec["depth_mm"]) == (height, width, 205)
    assert (spec["fields"], spec["units_per_field"], spec["door_leaves"]) == (fields, units, leaves)
    assert (spec["ip"], spec["door"], spec["mounting"]) == ("IP44", "Klappgriff mit Vorreiber", "surface")
    assert (spec["manufacturer"], spec["series"], spec["article_no"]) == ("Hager", "univers Z", code)
    # The data test, not the validator, holds the Hager arithmetic: admins may
    # model a cabinet that is not a Hager one (§3.1).
    assert spec["width_mm"] == 2 * spec["margin_mm"] + spec["fields"] * spec["field_width_mm"]
    assert spec["units_per_field"] * spec["unit_mm"] == spec["height_mm"] - 2 * spec["margin_mm"]
    assert spec["verified"] is verified
    assert "Raster 150 mm / 12 PLE laut ZU59XS-Datenblatt (125 mm nicht ausgeschlossen)" in spec["unverified"]
    assert "Innenrand 25 mm aus dem Außenmaß abgeleitet" in spec["unverified"]
    assert f"Türflügel ({leaves}) angenommen" in spec["unverified"]
    assert spec["source_url"].startswith("https://")
    assert spec["accessories"] == []


def test_the_one_cabinet_read_from_a_search_summary_ships_unverified() -> None:
    spec = builtin_catalog().enclosure("ZB53S")
    assert spec["verified"] is False
    assert "Seite nicht geöffnet; Werte aus Suchzusammenfassung, 27 Reihen abgeleitet" in spec["unverified"]


# ── modules ──────────────────────────────────────────────────────────────────


def test_exactly_the_modules_of_the_table_ship() -> None:
    catalog = builtin_catalog()
    codes = [code for code, entry in catalog.entries.items() if entry.entry_type == "module"]
    assert codes == list(MODULES)
    assert [spec["code"] for spec in BUILTIN_MODULES] == list(MODULES)


@pytest.mark.parametrize("code", list(MODULES))
def test_each_module_matches_the_table(code: str) -> None:
    family, field_height, zones, meters, mm2, fittings = MODULES[code]
    spec = builtin_catalog().module(code)
    assert spec is not None
    assert (spec["family"], spec["field_height_mm"], spec["wiring_mm2"]) == (family, field_height, mm2)
    assert (spec["manufacturer"], spec["series"], spec["article_no"]) == ("Hager", "univers Z", code)
    assert _spec_zones(spec) == _zones(zones)
    expected_height = {1050: 7, 1350: 9}.get(field_height) or sum(units for _, _, units, _ in _zones(zones))
    assert (spec["width_fields"], spec["height_units"]) == (1, expected_height)
    places = [(zone["meter_places"], zone["meter_type"]) for zone in spec["zones"] if zone["type"] == "ZF"]
    assert places == ([meters] if meters else [])
    assert fitting_kinds(spec) == fittings
    assert spec["accessories"] == []
    assert spec["source_url"].startswith("https://")


def test_meter_fields_are_unverified_and_name_their_stack() -> None:
    for code, (family, *_rest) in MODULES.items():
        spec = builtin_catalog().module(code)
        if family not in ("meter_ehz", "meter_3p"):
            continue
        assert spec["verified"] is False, code
        assert "Tipp 44" in spec["unverified"][0], code
        cover = spec["free_place_cover"]
        expected = "KU40XXE" if family == "meter_ehz" else "T95L"
        assert (cover["article_no"], cover["qty"], cover["verified"]) == (expected, 1, False), code
        if spec["wiring_mm2"] is None:
            assert "Feldverdrahtung (mm²) nicht angegeben" in spec["unverified"], code


def test_every_busbar_zone_position_is_flagged_as_derived() -> None:
    for code in MODULES:
        spec = builtin_catalog().module(code)
        if any(zone["type"] == "SAS" for zone in spec["zones"]):
            assert spec["verified"] is False, code
            assert "Lage der Sammelschienenzone aus Rechnung abgeleitet" in spec["unverified"], code


def test_the_unverified_facts_of_section_3_2_are_flagged() -> None:
    catalog = builtin_catalog()
    eh16 = catalog.module("ZH3EH16")
    assert eh16["name"] == "Komplettfeld eHZ, 1 Zählerplatz, Hauptschalter, HLAK, 1050 mm"
    assert eh16["unverified"] == [
        "Feldaufbau (AAR oben, RfZ, eHZ, NAR unten) aus Hager Tipp 44 abgeleitet",
        "Hauptschalter: Typ/Bemessungsstrom unbekannt",
        "HLAK 3-polig und 4 PLE breit angenommen",
        "Feldverdrahtung (mm²) nicht angegeben",
    ]
    assert eh16["source_url"] == "https://hager.com/de/katalog/?artnr=ZH3EH16"
    hs, hlak = (next(f for f in eh16["fittings"] if f["key"] == key) for key in ("hs", "hlak"))
    assert hs["device"] == {"kind": "hauptschalter", "rail": "aar1", "te": 3, "poles": 3, "rating": "", "width_mm": None}
    assert (hs["removable"], hs["verified"], hs["note"]) == (True, False, "Typ und Bemessungsstrom nennt Hager nicht")
    assert hlak["device"]["kind"] == "hlak" and hlak["device"]["rail"] == "aar2" and hlak["device"]["poles"] == 3
    assert (hlak["removable"], hlak["verified"]) == (True, False)
    # The 3-pole HLAK of ZH3EL16 comes from Hager; the ZH5EL16 one is carried over.
    el16 = next(f for f in catalog.module("ZH3EL16")["fittings"] if f["key"] == "hlak")
    assert el16["device"]["poles"] == 3
    el5 = next(f for f in catalog.module("ZH5EL16")["fittings"] if f["key"] == "hlak")
    assert el5["verified"] is False and "aus ZH3EL16 übertragen" in el5["note"]
    trenn = next(f for f in catalog.module("ZH31X7NT")["fittings"] if f["key"] == "trenn")
    assert trenn["verified"] is False and "Trennvorrichtung von Hager nicht benannt" in trenn["note"]
    assert catalog.module("ZU37VT4APZ2")["verified"] is False
    for cover in ("ZU62A", "ZU79A", "ZU93A"):
        assert "als Füllung ohne Einbausatz angenommen" in catalog.module(cover)["unverified"]


def test_every_built_in_spec_passes_its_own_validator() -> None:
    for spec in BUILTIN_ENCLOSURES:
        assert EnclosureSpec.model_validate(spec).model_dump() == builtin_catalog().enclosure(spec["code"])
    for spec in BUILTIN_MODULES:
        assert ModuleSpec.model_validate(spec).model_dump() == builtin_catalog().module(spec["code"])


def test_built_in_keys_are_unique_and_fittings_name_real_device_kinds() -> None:
    for spec in BUILTIN_MODULES:
        keys = rail_keys(spec)
        assert len(keys) == len(set(keys)), spec["code"]
        fitting_keys = [fitting["key"] for fitting in spec["fittings"]]
        assert len(fitting_keys) == len(set(fitting_keys)), spec["code"]
        for fitting in spec["fittings"]:
            if fitting["device"] is not None:
                assert fitting["device"]["kind"] in DEVICE_KINDS
                assert fitting["device"]["rail"] in keys
                assert fitting["removable"] is True


def test_every_built_in_fits_what_one_board_can_store() -> None:
    """A placed module must save: its rails, meter places, fittings and the
    labels its rail rows get stay inside the document schema (§2.2, §15)."""
    for spec in BUILTIN_MODULES:
        validated = builtin_catalog().module(spec["code"])
        zones = validated["zones"]
        assert len(rail_keys(validated)) <= MAX_RAILS_PER_MODULE, spec["code"]
        assert sum(zone["meter_places"] for zone in zones) <= MAX_METERS_PER_MODULE, spec["code"]
        assert len(validated["fittings"]) <= MAX_FITTINGS_PER_MODULE, spec["code"]
        for zone in zones:
            for position, _rail in enumerate(zone["rails"], start=1):
                for field in range(10 - validated["width_fields"] + 1):
                    label = default_rail_label({"field": field}, zone, position)
                    PanelRow(id="r", label=label)  # raises past 64 characters


def test_a_long_zone_label_still_gives_a_storable_row_label() -> None:
    zone = {"type": "VT", "field": 2, "label": "Unterverteilung Obergeschoss Wohnung links, Stromkreise Küche + Bad",
            "rails": [{"key": "r1"}, {"key": "r2"}]}
    label = default_rail_label({"field": 9}, zone, 2)
    assert len(label) == 64
    assert label.startswith("F12 · Unterverteilung Obergeschoss")


def test_unverified_entries_say_what_is_unchecked() -> None:
    for spec in [*BUILTIN_ENCLOSURES, *BUILTIN_MODULES]:
        validated = builtin_catalog().entries[spec["code"]].spec
        if validated["verified"] is False:
            assert validated["unverified"], spec["code"]
        assert all(0 < len(text) <= 200 for text in validated["unverified"]), spec["code"]


def test_busbar_rails_where_the_rules_need_them() -> None:
    for spec in BUILTIN_MODULES:
        for zone in spec["zones"]:
            if zone["type"] == "SAS":
                assert [rail.get("mount") for rail in zone["rails"]] == ["busbar"], spec["code"]
        if spec["family"] in ("meter_ehz", "meter_3p"):
            nar = [zone for zone in spec["zones"] if zone["type"] == "NAR"]
            assert len(nar) == 1, spec["code"]
            assert any(rail.get("mount") == "busbar" for rail in nar[0]["rails"]), spec["code"]


def test_no_prices_and_no_eans_in_the_data() -> None:
    text = json.dumps([*BUILTIN_ENCLOSURES, *BUILTIN_MODULES], ensure_ascii=False)
    assert "EUR" not in text and "€" not in text
    assert not re.search(r"\b\d{13}\b", text)


# ── the shipped record (§3.5 rule 3) ─────────────────────────────────────────


def _shipped() -> dict:
    return json.loads(SHIPPED.read_text(encoding="utf-8"))


def _record(entry_type: str, spec: dict) -> dict:
    return {
        "entry_type": entry_type,
        "frozen": frozen_fields(entry_type, spec),
        "rail_keys": sorted(rail_keys(spec)),
        "fittings": fitting_kinds(spec),
    }


def test_every_built_in_is_recorded_as_shipped() -> None:
    """A new built-in goes into the record in the same PR; this prints its line."""
    record = _shipped()["codes"]
    for code, entry in builtin_catalog().entries.items():
        assert code in record, f"add to {SHIPPED.name}: " + json.dumps({code: _record(entry.entry_type, entry.spec)})


def test_no_shipped_built_in_ever_disappears_or_breaks_its_keys() -> None:
    catalog = builtin_catalog()
    for code, shipped in _shipped()["codes"].items():
        entry = catalog.entries.get(code)
        assert entry is not None and entry.source == "builtin", f"{code} was shipped and must stay built in"
        assert entry.entry_type == shipped["entry_type"], code
        current = _record(entry.entry_type, entry.spec)
        missing = set(shipped["rail_keys"]) - set(current["rail_keys"])
        assert not missing, f"{code}: rail keys {sorted(missing)} vanished — retire them instead"
        for key, kind in shipped["fittings"].items():
            assert key in current["fittings"], f"{code}: fitting {key} vanished — retire it instead"
            assert current["fittings"][key] == kind, f"{code}: fitting {key} changed its device kind"


def test_frozen_fields_of_shipped_built_ins_are_unchanged() -> None:
    """Size, family and meter places are what stored boards were laid out with.
    A deliberate change edits the record in the same PR, which says why the
    boards that use the code stay correct."""
    catalog = builtin_catalog()
    for code, shipped in _shipped()["codes"].items():
        entry = catalog.entries[code]
        assert frozen_fields(entry.entry_type, entry.spec) == shipped["frozen"], code

