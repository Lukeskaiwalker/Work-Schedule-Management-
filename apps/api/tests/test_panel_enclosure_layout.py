"""Which rail a row hangs on, and in which order the rows feed (docs/PANEL_ENCLOSURE.md §2.3).

The electrical reading order is fixed by zone *type*, never by the order a
catalogue entry happens to list its zones in: RfZ/APZ rails first (the grid
operator's devices are fed before the SLS), then per module NAR → SAS → AAR
→ VF → VT → MM, rows outside the cabinet last. The TypeScript twin
(``enclosureLayout.ts``) is pinned on the same answers through
``apps/web/src/test/fixtures/enclosureFixtures.json``.
"""

from __future__ import annotations

import copy
import json

import pytest

from app.schemas.panel_enclosure import ModuleSpec
from app.services.panel_enclosure_catalog import CatalogEntry, EnclosureCatalog, builtin_catalog
from app.services.panel_enclosure_geometry import build_enclosure_scene
from app.services.panel_enclosure_layout import (
    enclosure_device_width_mm,
    linked_rows,
    module_fittings,
    physical_row_order,
    resolvable_rails,
    supplied_device_ids,
)
from scripts.write_enclosure_fixtures import (
    FIXTURE_PATH,
    build_fixtures,
    dev,
    document,
    ls,
    module,
    render,
    row,
    supplied,
)


def _fixtures() -> dict:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def _catalog_with(*specs: dict) -> EnclosureCatalog:
    entries = dict(builtin_catalog().entries)
    for raw in specs:
        spec = ModuleSpec.model_validate(raw).model_dump()
        entries[spec["code"]] = CatalogEntry(spec["code"], "module", spec, "custom", False)
    return EnclosureCatalog(entries)


# ── the shared fixture ───────────────────────────────────────────────────────


def test_the_committed_fixture_is_what_the_script_writes() -> None:
    """Change a rule, re-run ``scripts/write_enclosure_fixtures.py``, commit both."""
    assert FIXTURE_PATH.read_text(encoding="utf-8") == render(build_fixtures()), "re-run the script"


def test_order_matches_the_fixture_on_every_board() -> None:
    fixtures = _fixtures()
    catalog = EnclosureCatalog.from_out(fixtures["catalog"])
    assert set(fixtures["boards"]) == {
        "meter_dist_zb33s", "violations_zb34s", "removed_dangling_zb52s", "tall_zb54s", "cross_feed_zb33s",
    }
    for name, board in fixtures["boards"].items():
        assert physical_row_order(board["document"], catalog) == board["order"], name


# ── the reading order ────────────────────────────────────────────────────────


def _two_meter_fields() -> dict:
    """ZH5EL27 (VF, AAR, RfZ, ZF, NAR) next to ZU37VT4APZ2 (VT, RfZ, APZ), rows shuffled."""
    modules = [
        module("m1", "ZH5EL27", 0, {"vf1": "vf1", "aar1": "aar1", "rfz": "rfz1", "nar": "nar1"}),
        module("m2", "ZU37VT4APZ2", 1, {"r1": "vt1", "r2": "vt2", "rfz": "rfz2", "apz": "apz2"}),
    ]
    rows = [row(row_id, row_id, [dev(f"d-{row_id}", "blank")])
            for row_id in ("loose", "vt2", "aar1", "apz2", "nar1", "vt1", "rfz2", "vf1", "rfz1")]
    return document("ZB54S", modules, rows)


def test_rfz_and_apz_rails_come_first_then_each_module_by_zone_type() -> None:
    order = physical_row_order(_two_meter_fields(), builtin_catalog())
    assert order == ["rfz1", "rfz2", "apz2", "nar1", "aar1", "vf1", "vt1", "vt2", "loose"]


def test_zone_list_order_carries_no_meaning() -> None:
    spec = ModuleSpec.model_validate(builtin_catalog().module("ZH3EL27")).model_dump()
    reversed_spec = {**spec, "code": "ZX3EL27R", "article_no": "ZX3EL27R", "zones": list(reversed(spec["zones"]))}
    catalog = _catalog_with(reversed_spec)
    rails = {"nar": "nar", "aar1": "aar1", "aar2": "aar2", "rfz": "rfz"}
    rows = [row(key, key, []) for key in ("aar2", "nar", "rfz", "aar1")]
    for code in ("ZH3EL27", "ZX3EL27R"):
        doc = document("ZB33S", [module("m", "ZH3EL27", 0, rails, fittings=[])], rows)
        doc["enclosure"]["modules"][0]["code"] = code
        assert physical_row_order(doc, catalog) == ["rfz", "nar", "aar1", "aar2"], code


def test_every_zone_type_has_its_rank() -> None:
    """NAR 1, SAS 2, AAR 3, VF 4, VT 5, MM 6 — whatever order the spec lists them in."""
    zone_types = ["MM", "VT", "VF", "AAR", "SAS", "NAR", "APZ", "RFZ"]
    spec = {
        "code": "ZX8ALL", "article_no": "ZX8ALL", "name": "Testfeld alle Zonen", "family": "multimedia",
        "field_height_mm": None, "width_fields": 1, "height_units": 8, "verified": True,
        "zones": [
            {"key": kind.lower(), "type": kind, "unit": unit, "units": 1, "rails": [
                {"key": f"{kind.lower()}1", "unit": 0, "ple": 12,
                 "mount": "busbar" if kind in ("NAR", "SAS") else "rail"}]}
            for unit, kind in enumerate(zone_types)
        ],
    }
    rails = {f"{kind.lower()}1": kind.lower() for kind in zone_types}
    doc = document("ZB33S", [module("m", "ZX8ALL", 0, rails, fittings=[])], [row(k, k, []) for k in rails.values()])
    assert physical_row_order(doc, _catalog_with(spec)) == ["apz", "rfz", "nar", "sas", "aar", "vf", "vt", "mm"]


def test_modules_sort_by_field_then_unit_then_id() -> None:
    modules = [
        module("b", "ZU62A", 1, {}, unit=6),
        module("z", "ZY150RFZ", 1, {"rfz": "rfz-low"}, unit=5),
        module("a", "ZY150RFZ", 1, {"rfz": "rfz-high"}, unit=0),
        module("y", "ZY150RFZ", 0, {"rfz": "rfz-left"}, unit=6),
    ]
    rows = [row(key, key, []) for key in ("rfz-low", "rfz-high", "rfz-left")]
    order = physical_row_order(document("ZB33S", modules, rows), builtin_catalog())
    assert order == ["rfz-left", "rfz-high", "rfz-low"]


def test_the_order_is_idempotent() -> None:
    doc = _two_meter_fields()
    catalog = builtin_catalog()
    order = physical_row_order(doc, catalog)
    by_id = {r["id"]: r for r in doc["rows"]}
    reordered = {**doc, "rows": [by_id[row_id] for row_id in order]}
    assert physical_row_order(reordered, catalog) == order


# ── what counts as linked ────────────────────────────────────────────────────


def test_an_unknown_rail_key_or_code_leaves_the_row_outside_the_cabinet() -> None:
    modules = [
        module("m1", "ZU37KS", 0, {"r1": "a", "r99": "stale"}),
        module("m2", "ZX00GONE", 1, {"r1": "gone"}, fittings=[]),
    ]
    rows = [row(key, key, []) for key in ("stale", "gone", "a", "plain")]
    doc = document("ZB33S", modules, rows)
    assert linked_rows(doc, builtin_catalog()) == {"a": ("m1", "r1")}
    # Rows outside the cabinet keep their relative order, after the linked ones.
    assert physical_row_order(doc, builtin_catalog()) == ["a", "stale", "gone", "plain"]


def test_dangling_row_ids_link_nothing() -> None:
    doc = document("ZB33S", [module("m1", "ZU37KS", 0, {"r1": "nowhere", "r2": "b"})], [row("b", "b", [])])
    assert linked_rows(doc, builtin_catalog()) == {"b": ("m1", "r2")}


def test_retired_rails_are_still_resolvable() -> None:
    spec = {
        "code": "ZX2RET", "article_no": "ZX2RET", "name": "Test", "family": "distribution",
        "field_height_mm": None, "width_fields": 1, "height_units": 2, "verified": True,
        "zones": [{"key": "vt", "type": "VT", "unit": 0, "units": 2, "rails": [
            {"key": "r1", "unit": 0, "ple": 12}, {"key": "r2", "unit": 1, "ple": 12, "retired": True}]}],
    }
    catalog = _catalog_with(spec)
    rails = resolvable_rails({"code": "ZX2RET"}, catalog)
    assert sorted(rails) == ["r1", "r2"]
    assert rails["r2"][1]["retired"] is True
    doc = document("ZB33S", [module("m", "ZX2RET", 0, {"r2": "old"}, fittings=[])], [row("old", "old", [])])
    assert linked_rows(doc, catalog) == {"old": ("m", "r2")}


def test_a_retired_rail_is_drawn_only_while_its_row_holds_devices() -> None:
    spec = {
        "code": "ZX2RET", "article_no": "ZX2RET", "name": "Test", "family": "distribution",
        "field_height_mm": None, "width_fields": 1, "height_units": 2, "verified": True,
        "zones": [{"key": "vt", "type": "VT", "unit": 0, "units": 2, "rails": [
            {"key": "r1", "unit": 0, "ple": 12, "retired": True}, {"key": "r2", "unit": 1, "ple": 12, "retired": True}]}],
    }
    catalog = _catalog_with(spec)
    doc = document("ZB33S", [module("m", "ZX2RET", 0, {"r1": "empty", "r2": "full"}, fittings=[])],
                   [row("empty", "empty", []), row("full", "full", [ls("d1", "F1", "1", "x")])])
    rails = {box["id"]: box for box in build_enclosure_scene(doc, catalog)["boxes"] if box["kind"] == "rail"}
    assert list(rails) == ["rail:m:r2"]
    assert rails["rail:m:r2"]["flags"] == ["retired"]


def test_garbage_never_raises() -> None:
    catalog = builtin_catalog()
    for broken in (
        {}, {"rows": None}, {"rows": [None, 3, {"id": 7}]}, {"enclosure": "ZB33S", "rows": [{"id": "a"}]},
        {"enclosure": {"code": "ZB33S", "modules": "x"}, "rows": []},
        {"enclosure": {"code": "ZB33S", "modules": [None, {"id": "m", "code": 5, "rails": [1]},
                                                    {"id": "n", "code": "ZU37KS", "field": "x", "rails": {"r1": 3}}]},
         "rows": [{"id": "a", "devices": "x"}]},
    ):
        linked_rows(broken, catalog)
        physical_row_order(broken, catalog)
        supplied_device_ids(broken, catalog)
    assert physical_row_order({"rows": [{"id": "a"}, {"id": "b"}, {"id": "a"}]}, catalog) == ["a", "b"]


# ── device widths ────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("device", "mount", "width"),
    [
        (dev("d", "mcb"), "rail", 17.5),
        (dev("d", "rcd"), "rail", 70.0),
        (dev("d", "sls"), "rail", 52.5),
        (dev("d", "sls"), "busbar", 78.75),  # HTS335E, 4.5 PLE: a drawing default
        (dev("d", "sls", width_mm=81.0), "busbar", 81.0),
        (dev("d", "mcb", width_mm=18.0), "rail", 18.0),
        (dev("d", "mcb", te=None), "rail", 17.5),
    ],
)
def test_device_width_on_a_rail(device: dict, mount: str, width: float) -> None:
    assert enclosure_device_width_mm(device, {"mount": mount}) == width


# ── pre-fitted parts (§2.3) ──────────────────────────────────────────────────


def _hs_board(*claimants: dict, fittings: list | None = None, code: str = "ZH3EH16") -> dict:
    modules = [module("m", code, 0, {"aar1": "aar"}, fittings=fittings)]
    return document("ZB33S", modules, [row("aar", "aar", list(claimants))])


def test_only_the_first_claimant_counts_as_the_fitting() -> None:
    doc = _hs_board(
        dev("hs1", "hauptschalter", supplied_by=supplied("m", "hs")),
        dev("hs2", "hauptschalter", supplied_by=supplied("m", "hs")),
        dev("x", "hlak", supplied_by=supplied("m", "hlak")),
    )
    assert supplied_device_ids(doc, builtin_catalog()) == {"hs1", "x"}


def test_a_claim_needs_a_live_module_and_a_device_fitting() -> None:
    doc = _hs_board(
        dev("gone", "hauptschalter", supplied_by=supplied("nope", "hs")),
        dev("bar", "terminal", supplied_by=supplied("m", "busbar")),  # a fitting, but no device
        dev("odd", "mcb", supplied_by=supplied("m", "zz")),
    )
    assert supplied_device_ids(doc, builtin_catalog()) == set()


def test_the_snapshot_decides_even_for_an_unknown_code() -> None:
    snapshot = [{"key": "hs", "label": "Hauptschalter", "article_no": None, "device_kind": "hauptschalter",
                 "removable": True}]
    doc = _hs_board(dev("hs1", "hauptschalter", supplied_by=supplied("m", "hs")), fittings=snapshot, code="ZX00GONE")
    assert supplied_device_ids(doc, builtin_catalog()) == {"hs1"}


def test_a_module_without_a_snapshot_falls_back_to_the_catalogue() -> None:
    for hand_made in ({"code": "ZH3EH16"}, {"code": "ZH3EH16", "fittings": None}):
        fittings = module_fittings(hand_made, builtin_catalog())
        assert [(f["key"], f["device_kind"]) for f in fittings] == [
            ("busbar", None), ("bke", None), ("hs", "hauptschalter"), ("hlak", "hlak")]
    assert module_fittings({"code": "ZX00GONE"}, builtin_catalog()) == []
    snapshot = [{"key": "only", "label": "x", "article_no": None, "device_kind": None, "removable": False}]
    assert module_fittings({"code": "ZH3EH16", "fittings": snapshot}, builtin_catalog()) == snapshot


def test_an_empty_snapshot_stays_empty_when_the_catalogue_grows() -> None:
    """A module placed without fittings recorded ``[]``; a device fitting an
    admin adds later must not make a device on that board a pre-fitted part."""
    grown = _catalog_with({
        **builtin_catalog().module("ZU37RK"),
        "fittings": [{"key": "hs", "label": "Hauptschalter", "article_no": None, "removable": True, "verified": False,
                      "device": {"kind": "hauptschalter", "rail": "r1", "te": 3, "poles": 3}}],
    })
    placed = module("m", "ZU37RK", 0, {"r1": "v1"}, fittings=[])
    doc = document("ZB33S", [placed], [row("v1", "v1", [dev("q", "hauptschalter", supplied_by=supplied("m", "hs"))])])
    assert module_fittings(placed, grown) == []
    assert supplied_device_ids(doc, grown) == set()


def test_inputs_are_never_mutated() -> None:
    doc = _two_meter_fields()
    before = copy.deepcopy(doc)
    catalog = builtin_catalog()
    physical_row_order(doc, catalog)
    linked_rows(doc, catalog)
    supplied_device_ids(doc, catalog)
    build_enclosure_scene(doc, catalog, view="closed")
    assert doc == before
