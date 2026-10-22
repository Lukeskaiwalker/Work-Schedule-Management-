"""Write the shared cabinet fixture the TypeScript twins are pinned on.

    cd apps/api
    PYTHONPATH=. python scripts/write_enclosure_fixtures.py

Writes ``apps/web/src/test/fixtures/enclosureFixtures.json``
(docs/PANEL_ENCLOSURE.md §14):

    {"catalog": <EnclosureCatalogOut subset>,
     "boards": {name: {"document", "order", "scene_open", "scene_closed", "findings"}}}

The layout, the geometry and the findings exist twice — here in Python for the
PDF and the panel detail, in ``apps/web/src/utils/enclosure*.ts`` for the
editor — and D8 wants one picture, not two. So Python computes every answer
once, this file records it, and both test suites demand it back:
``tests/test_panel_enclosure_{layout,geometry,rules}.py`` and the web parity
tests. A rule changed on one side only turns one of them red. After a
deliberate change, re-run this script and commit the JSON with the change.

The boards are invented (the repo is public); only the Hager codes are real,
because they are what the built-in catalogue ships. Each board's purpose:

* ``meter_dist_zb33s`` — the compliant reference: ZH3EH16 with its HS fed by
  an SLS on the NAR, ZU37KS rows that each start with an FI, ZU37VT5APZ2 with
  its APZ at the bottom. Zero warn findings.
* ``violations_zb34s`` — one board breaking every placement rule it can:
  SLS E50 on 10 mm², Neozed and FI on the NAR, four AAR circuits with a B20
  and a contactor, LS B16 on the RfZ, a ZH3EL22 with two meters and one SLS,
  a 3-Punkt without HS or SLS, and a custom module with its APZ in the middle
  and two retired rails (one empty, one still holding a breaker).
* ``removed_dangling_zb52s`` — what a board looks like after edits: the HS
  deleted, a non-removable key in ``removed_fittings``, dangling
  ``supplied_by``, an unknown module code, a row behind an unknown rail key,
  an overflowing rail, an unlinked legacy row with a DIN-rail meter, an
  out-of-range meter place and a free one; the 1050 mm module in a 1350 mm
  field also trips the height rule.
* ``tall_zb54s`` — 1350 mm fields: ZH5EL27, ZH53X3 (Doppelstock, two meters,
  one SLS on its NAR), ZH53XS whose SAS carries the SLS credited to the
  adjacent meter field, ZU62A and a gap. (ZU59KS, also named in §14, cannot
  fit: four 9-unit modules fill all four fields; ZH53XS carries the 1350 mm
  distribution rails and the PE/N block in its place.)
* ``cross_feed_zb33s`` — rows stored out of physical order, and the first
  rail of field 2 (0-based, "Feld 3") holding LS that hang positionally off
  FI F1 in field 0; field 1 empty. The base of the TS feed-preservation tests.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

API_ROOT = Path(__file__).resolve().parents[1]
if str(API_ROOT) not in sys.path:  # run as a plain script from apps/api
    sys.path.insert(0, str(API_ROOT))

from app.schemas.panel_enclosure import CatalogEntryOut, ModuleSpec  # noqa: E402
from app.schemas.schaltplan import PanelDocument  # noqa: E402
from app.services.panel_enclosure_catalog import EnclosureCatalog, builtin_catalog  # noqa: E402
from app.services.panel_enclosure_geometry import build_enclosure_scene  # noqa: E402
from app.services.panel_enclosure_layout import physical_row_order  # noqa: E402
from app.services.panel_enclosure_rules import enclosure_findings  # noqa: E402
from app.services.schaltplan_layout import DEVICE_CATALOG  # noqa: E402

FIXTURE_PATH = API_ROOT.parent / "web" / "src" / "test" / "fixtures" / "enclosureFixtures.json"

CUSTOM_APZ_MIDDLE = "ZX37APZM"
CATALOG_CODES = (
    "ZB33S", "ZB34S", "ZB52S", "ZB54S",
    "ZH3EH16", "ZU37KS", "ZU37VT5APZ2", "ZH3EL27", "ZH3EL22", "ZH33X7",
    "ZH5EL27", "ZH53X3", "ZH53XS", "ZU62A",
)

# ── Catalogue subset ─────────────────────────────────────────────────────────


def custom_apz_middle_spec() -> dict[str, Any]:
    """An admin's field with the APZ between two rail blocks (vde.apz_position),
    and two retired rails: r3 empty (not drawn), r5 still holding a breaker."""

    def rail(key: str, unit: int, *, ple: int = 12, retired: bool = False) -> dict[str, Any]:
        return {"key": key, "unit": unit, "ple": ple, "mount": "rail", "retired": retired}

    raw = {
        "code": CUSTOM_APZ_MIDDLE, "article_no": CUSTOM_APZ_MIDDLE,
        "name": "Testfeld Verteiler mit APZ in der Mitte", "family": "distribution_apz",
        "field_height_mm": 1050, "width_fields": 1, "height_units": 7,
        "zones": [
            {"key": "vt_top", "type": "VT", "unit": 0, "units": 3,
             "rails": [rail("r1", 0), rail("r2", 1), rail("r3", 2, retired=True)]},
            {"key": "apz", "type": "APZ", "unit": 3, "units": 2, "sealable": True, "rails": [rail("apz", 0, ple=6)]},
            {"key": "vt_bottom", "type": "VT", "unit": 5, "units": 2,
             "rails": [rail("r4", 0), rail("r5", 1, retired=True)]},
        ],
        "fittings": [], "accessories": [], "verified": True,
    }
    return ModuleSpec.model_validate(raw).model_dump()


def catalog_payload() -> dict[str, Any]:
    """The entries the boards use, in the API's own shape (``CatalogEntryOut``)."""
    builtins = builtin_catalog()
    enclosures: list[dict[str, Any]] = []
    modules: list[dict[str, Any]] = []
    for code in CATALOG_CODES:
        entry = builtins.entry(code)
        assert entry is not None, code
        out = CatalogEntryOut(code=code, entry_type=entry.entry_type, source="builtin", archived=False,
                              invalid=False, spec=entry.spec)
        (enclosures if entry.entry_type == "enclosure" else modules).append(out.model_dump(mode="json"))
    custom = CatalogEntryOut(code=CUSTOM_APZ_MIDDLE, entry_type="module", source="custom", archived=False,
                             invalid=False, spec=custom_apz_middle_spec())
    modules.append(custom.model_dump(mode="json"))
    return {"enclosures": enclosures, "modules": modules, "can_manage": False, "uncatalogued": []}


# ── Document builders ────────────────────────────────────────────────────────


def dev(device_id: str, kind: str, **overrides: Any) -> dict[str, Any]:
    """A device as the editor sends it (``makeDevice`` in schaltplanDevices.ts)."""
    entry = DEVICE_CATALOG[kind]
    out: dict[str, Any] = {
        "id": device_id, "kind": kind, "te": entry["te"], "poles": entry["poles"],
        "designation": "", "circuit": "", "label": "", "room": "", "rating": "",
        "residual_current": "", "rcd_type": "", "cable": "", "phase": "-", "parent_id": None,
        "feeds_following": False, "terminal_block": False, "note": "", "width_mm": None,
        "supplied_by": None,
    }
    out.update(overrides)
    return out


def fi(device_id: str, bmk: str, **overrides: Any) -> dict[str, Any]:
    return dev(device_id, "rcd", designation=bmk, rating="40 A", residual_current="30 mA", rcd_type="A", **overrides)


def ls(device_id: str, bmk: str, circuit: str, label: str, rating: str = "B16", **overrides: Any) -> dict[str, Any]:
    return dev(device_id, "mcb", designation=bmk, circuit=circuit, label=label, rating=rating,
               cable="NYM-J 3x2,5 mm²", **overrides)


def row(row_id: str, label: str, devices: list[dict[str, Any]], slots: int = 12) -> dict[str, Any]:
    return {"id": row_id, "label": label, "slots": slots, "devices": devices}


def supplied(module_id: str, part: str) -> dict[str, str]:
    return {"module": module_id, "part": part}


def snapshot(code: str) -> list[dict[str, Any]]:
    """The fittings ``placeModule`` snapshots: every non-retired catalogue fitting."""
    spec = builtin_catalog().module(code)
    assert spec is not None, code
    return [
        {"key": f["key"], "label": f["label"], "article_no": f["article_no"],
         "device_kind": f["device"]["kind"] if f["device"] else None, "removable": f["removable"]}
        for f in spec["fittings"] if not f["retired"]
    ]


def module(module_id: str, code: str, field: int, rails: dict[str, str], *, unit: int = 0, label: str = "",
           meters: list[dict[str, Any]] | None = None, removed: list[str] | None = None,
           fittings: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {
        "id": module_id, "code": code, "field": field, "unit": unit, "label": label, "rails": rails,
        "fittings": snapshot(code) if fittings is None else fittings,
        "removed_fittings": removed or [], "meters": meters or [],
    }


def meter(place: int, number: str = "", label: str = "") -> dict[str, Any]:
    return {"place": place, "number": number, "label": label}


def document(cabinet: str, modules: list[dict[str, Any]], rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Validated and dumped: the exact shape a stored board has."""
    raw = {
        "version": 1,
        "supply": {"system": "TN-C-S", "voltage": "400/230 V", "incoming": "NYY-J 5x16 mm²",
                   "fuse": "NH 63 A", "meter_number": "", "note": ""},
        "rows": rows,
        "terminal_labels": {},
        "enclosure": {"code": cabinet, "modules": modules},
    }
    return PanelDocument.model_validate(raw).model_dump(mode="json")


# ── The five boards ──────────────────────────────────────────────────────────


def meter_dist_zb33s() -> dict[str, Any]:
    modules = [
        module("mod-z", "ZH3EH16", 0, {"nar": "row-nar", "aar1": "row-aar1", "aar2": "row-aar2"},
               label="Allgemein", meters=[meter(0, "1XYZ0000000001", "Allgemein")]),
        module("mod-v", "ZU37KS", 1, {"r1": "row-v1", "r2": "row-v2"}),
        module("mod-a", "ZU37VT5APZ2", 2, {"r1": "row-a1"}),
    ]
    rows = [
        row("row-nar", "F1 · NAR", [dev("dev-q0", "sls", designation="Q0", rating="E35")]),
        row("row-aar1", "F1 · AAR 1", [
            dev("dev-q1", "hauptschalter", designation="Q1", parent_id="dev-q0", supplied_by=supplied("mod-z", "hs"))]),
        row("row-aar2", "F1 · AAR 2", [dev("dev-x0", "hlak", designation="X0", supplied_by=supplied("mod-z", "hlak"))]),
        row("row-v1", "F2 · Verteiler 1", [
            fi("dev-f1", "F1", parent_id="dev-q1"),
            ls("dev-f1-1", "F1.1", "1", "Licht EG", room="Flur", terminal_block=True),
            ls("dev-f1-2", "F1.2", "2", "Steckdosen EG", room="Wohnen", terminal_block=True)]),
        row("row-v2", "F2 · Verteiler 2", [
            fi("dev-f2", "F2", parent_id="dev-q1"),
            ls("dev-f2-1", "F2.1", "3", "Küche", room="Küche"),
            ls("dev-f2-2", "F2.2", "4", "Bad", room="Bad")]),
        row("row-a1", "F3 · Verteiler 1", [
            fi("dev-f3", "F3", parent_id="dev-q1"),
            ls("dev-f3-1", "F3.1", "5", "Garage", room="Garage", terminal_block=True)]),
    ]
    return document("ZB33S", modules, rows)


def violations_zb34s() -> dict[str, Any]:
    modules = [
        module("mod-e", "ZH3EL27", 0,
               {"rfz": "row-e-rfz", "nar": "row-e-nar", "aar1": "row-e-aar1", "aar2": "row-e-aar2"},
               meters=[meter(0, "1XYZ0000000010")]),
        module("mod-d", "ZH3EL22", 1, {"nar": "row-d-nar"},
               meters=[meter(0, "1XYZ0000000011", "WE 1"), meter(1, "1XYZ0000000012", "WE 2")]),
        module("mod-p", "ZH33X7", 2, {}, meters=[meter(0)]),
        module("mod-c", CUSTOM_APZ_MIDDLE, 3, {"r1": "row-c1", "r5": "row-c5"}, fittings=[]),
    ]
    rows = [
        row("row-e-rfz", "F1 · RfZ", [ls("dev-r1", "F9", "9", "Steuerung")]),
        row("row-e-nar", "F1 · NAR", [
            dev("dev-e-q0", "sls", designation="Q0", rating="E50"),
            dev("dev-e-f0", "fuse", designation="F0", rating="35 A", label="Neozed"),
            fi("dev-e-fi", "F1")]),
        row("row-e-aar1", "F1 · AAR 1", [ls("dev-a1", "F1.1", "1", "Licht"), ls("dev-a2", "F1.2", "2", "Steckdosen")]),
        row("row-e-aar2", "F1 · AAR 2", [
            ls("dev-a3", "F1.3", "3", "Herd", rating="B20"),
            dev("dev-k1", "contactor", designation="K1", circuit="4", label="Heizstab", rating="20 A")]),
        row("row-d-nar", "F2 · NAR", [dev("dev-d-q0", "sls", designation="Q10", rating="E35")]),
        row("row-c1", "F4 · Verteiler 1", [fi("dev-c-fi", "F5"), ls("dev-c1", "F5.1", "5", "Werkstatt")]),
        row("row-c5", "F4 · Verteiler 5", [ls("dev-c2", "F5.2", "6", "Außenlicht")]),
    ]
    return document("ZB34S", modules, rows)


def removed_dangling_zb52s() -> dict[str, Any]:
    modules = [
        # The HS (aar1) was deleted, so the module names no aar1 row any more.
        module("mod-h", "ZH3EH16", 0,
               {"nar": "row-h-nar", "aar2": "row-h-aar2", "aar9": "row-stale"},
               removed=["bke"], meters=[meter(3, "1XYZ0000000099")]),
        module("mod-u", "ZX99GONE", 1, {"r1": "row-u1"}, fittings=[]),
    ]
    rows = [
        row("row-h-nar", "F1 · NAR", [dev("dev-q0", "sls", designation="Q0", rating="E35")]),
        row("row-h-aar2", "F1 · AAR 2", [
            dev("dev-x0", "hlak", designation="X0", supplied_by=supplied("mod-h", "hlak")),
            dev("dev-s1", "spd", designation="F11"), dev("dev-s2", "spd", designation="F12"),
            dev("dev-s3", "spd", designation="F13")], slots=16),
        row("row-stale", "Reihe alt AAR", [
            ls("dev-l9", "F7", "7", "Keller", rating="B10", supplied_by=supplied("mod-gone", "hs"))]),
        row("row-u1", "F2 · Verteiler 1", [fi("dev-f2", "F2"), ls("dev-f2-1", "F2.1", "8", "Dach")]),
        row("row-old", "Reihe 1", [
            dev("dev-m1", "meter", designation="P1"),
            dev("dev-t1", "terminal", designation="X9", supplied_by=supplied("mod-h", "busbar"))]),
    ]
    return document("ZB52S", modules, rows)


def tall_zb54s() -> dict[str, Any]:
    modules = [
        module("mod-m", "ZH5EL27", 0, {"nar": "row-m-nar", "vf1": "row-m-vf1"},
               meters=[meter(0, "1XYZ0000000021", "WE 1")]),
        module("mod-t", "ZH53X3", 1, {"nar": "row-t-nar", "aar1": "row-t-aar1", "aar2": "row-t-aar2"},
               meters=[meter(0, "1XYZ0000000022", "WP"), meter(1)]),
        module("mod-s", "ZH53XS", 2, {"sas": "row-s-sas", "r1": "row-s-r1"}),
        module("mod-c", "ZU62A", 3, {}),
    ]
    rows = [
        row("row-m-nar", "F1 · NAR", [dev("dev-m-q0", "sls", designation="Q0", rating="E35")]),
        row("row-m-vf1", "F1 · Verteilerfeld 1", [
            fi("dev-m-fi", "F1", parent_id="dev-m-q0"),
            ls("dev-m1", "F1.1", "1", "Licht", terminal_block=True)]),
        row("row-t-nar", "F2 · NAR", [dev("dev-t-q0", "sls", designation="Q10", rating="E35")]),
        row("row-t-aar1", "F2 · AAR 1", [dev("dev-t-q1", "hauptschalter", designation="Q11", parent_id="dev-t-q0")]),
        row("row-t-aar2", "F2 · AAR 2", [dev("dev-t-q2", "hauptschalter", designation="Q12", parent_id="dev-t-q0")]),
        row("row-s-sas", "F3 · Sammelschienen", [dev("dev-s-q0", "sls", designation="Q20", rating="E50")]),
        row("row-s-r1", "F3 · Verteiler 1", [
            fi("dev-s-fi", "F3", parent_id="dev-s-q0"),
            ls("dev-s1", "F3.1", "2", "Wärmepumpe Steuerung", terminal_block=True),
            ls("dev-s2", "F3.2", "3", "Heizung", terminal_block=True)]),
    ]
    return document("ZB54S", modules, rows)


def cross_feed_zb33s() -> dict[str, Any]:
    modules = [
        module("mod-l", "ZU37KS", 0, {"r1": "row-l1", "r2": "row-l2"}),
        module("mod-r", "ZU37KS", 2, {"r1": "row-r1", "r2": "row-r2"}),
    ]
    rows = [
        row("row-l1", "F1 · Verteiler 1", [fi("dev-f1", "F1"), ls("dev-l1", "F1.1", "1", "Licht")]),
        # Stored before row-l2, though physically it is the first rail of Feld 3.
        row("row-r1", "F3 · Verteiler 1", [ls("dev-r1", "F1.3", "3", "Garten"), ls("dev-r2", "F1.4", "4", "Carport")]),
        row("row-l2", "F1 · Verteiler 2", [ls("dev-l2", "F1.2", "2", "Steckdosen")]),
        row("row-r2", "F3 · Verteiler 2", [fi("dev-f2", "F2"), ls("dev-r3", "F2.1", "5", "Sauna")]),
    ]
    return document("ZB33S", modules, rows)


BOARDS = {
    "meter_dist_zb33s": meter_dist_zb33s,
    "violations_zb34s": violations_zb34s,
    "removed_dangling_zb52s": removed_dangling_zb52s,
    "tall_zb54s": tall_zb54s,
    "cross_feed_zb33s": cross_feed_zb33s,
}


# ── Output ───────────────────────────────────────────────────────────────────


def board_answers(document: dict[str, Any], catalog: EnclosureCatalog) -> dict[str, Any]:
    """Everything the twins must agree on for one board."""
    return {
        "order": physical_row_order(document, catalog),
        "scene_open": build_enclosure_scene(document, catalog, view="open"),
        "scene_closed": build_enclosure_scene(document, catalog, view="closed"),
        "findings": enclosure_findings(document, catalog),
    }


def build_fixtures() -> dict[str, Any]:
    payload = catalog_payload()
    # Read back through the API shape, as the web client does.
    catalog = EnclosureCatalog.from_out(payload)
    boards = {}
    for name, make in BOARDS.items():
        doc = make()
        boards[name] = {"document": doc, **board_answers(doc, catalog)}
    return {"catalog": payload, "boards": boards}


def render(fixtures: dict[str, Any]) -> str:
    return json.dumps(fixtures, ensure_ascii=False, indent=1) + "\n"


def main() -> int:
    FIXTURE_PATH.write_text(render(build_fixtures()), encoding="utf-8")
    print(f"wrote {FIXTURE_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
