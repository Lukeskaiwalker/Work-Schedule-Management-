"""The invented boards of the shared cabinet fixture, and their builders.

Moved out of ``write_enclosure_fixtures.py`` (docs/PANEL_ENCLOSURE_R2.md §11,
§14.1) so the writer stays a writer and this file stays under the size cap.
The writer re-exports every name here; tests import either.

The boards are invented (the repo is public); only the Hager codes are real,
because they are what the built-in catalogue ships. Each board's purpose:

* ``meter_dist_zb33s`` — the compliant reference: ZH3EH16 with its HS fed by
  an SLS on the NAR, ZU37KS rows that each start with an FI, ZU37VT5APZ2 with
  its APZ at the bottom. Zero warn findings. Round 2 moved its distribution
  rows from r1/r2 to r3/r4 (and the APZ field's row from r1 to r3): the top
  two VT rails of every Verteilerfeld now carry the WAGO terminals (R2), so
  a compliant board keeps them free. Its strips land on r1.
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
* ``terminals_zb34s`` — the owner's back-compat board (R2 §3.6): an AAR LS
  with ``terminal_block`` (skipped); a ZU37KS whose r1/r2 still hold F1's
  breakers and a hand-placed "Reihenklemme N/PE" (X1 on r1, X2–X3 on r2,
  X4–X6 without place); an empty, insulated ZU37RK; and a ZU37KS with 2-TE
  FIs where next-fit leaves the Block X10 over and first-fit puts it back
  onto rail 1 (no end stops since the owner's 2026-10-22 answer, so the
  groups are FI + 10 LS, not the addendum's FI + 9 LS).
* ``terminals_rk_zb53s`` — three 1350 mm fields: a ZH5EL27 whose VF group
  has no terminal rails of its own (placed in field 1), a ZU59RK with a
  Leiste under a Hauptschalter (no FI) and a stored strip order whose rail-2
  split no longer fits (a stale id, F3 grew), and a ZH53XSRK with a wallbox
  Block on its SAS, a group split over two fields and a group whose FI sits
  in the field before its circuits.
* ``terminals_overflow_zb32s`` — five FI + 10 LS groups (71.5 mm Leisten) in
  one ZU37KS: two per terminal rail, X5 without place; the next field empty.
* ``three_point_zb53s`` — round 3's current 3-Punkt kits: VF over AAR over one
  place (ZH53W9SNT, ZH50D53ST) and a Doppelstock (ZH53X3T) with a free place,
  their Trennvorrichtungen and HLAK as placed pre-fitted parts.
"""

from __future__ import annotations

from typing import Any

from app.schemas.panel_enclosure import ModuleSpec
from app.schemas.schaltplan import PanelDocument
from app.services.panel_enclosure_catalog import builtin_catalog
from app.services.schaltplan_layout import DEVICE_CATALOG

CUSTOM_APZ_MIDDLE = "ZX37APZM"


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


def ls_run(group: str, bmk: str, numbers: range, first_circuit: int, **overrides: Any) -> list[dict[str, Any]]:
    """LS ``{bmk}.k`` for every k in ``numbers``, each on a Reihenklemme;
    circuit numbers count up from ``first_circuit``."""
    return [
        ls(f"dev-{group}-{k}", f"{bmk}.{k}", str(first_circuit + i), f"Stromkreis {first_circuit + i}",
           terminal_block=True, **overrides)
        for i, k in enumerate(numbers)
    ]


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
           fittings: list[dict[str, Any]] | None = None,
           terminal_order: dict[str, Any] | None = None) -> dict[str, Any]:
    out = {
        "id": module_id, "code": code, "field": field, "unit": unit, "label": label, "rails": rails,
        "fittings": snapshot(code) if fittings is None else fittings,
        "removed_fittings": removed or [], "meters": meters or [],
    }
    if terminal_order is not None:
        out["terminal_order"] = terminal_order
    return out


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


# ── The shipped boards ───────────────────────────────────────────────────────


def meter_dist_zb33s() -> dict[str, Any]:
    modules = [
        module("mod-z", "ZH3EH16", 0, {"nar": "row-nar", "aar1": "row-aar1", "aar2": "row-aar2"},
               label="Allgemein", meters=[meter(0, "1XYZ0000000001", "Allgemein")]),
        # r1/r2 are the field's terminal rails (R2): the MCB rows start at r3.
        module("mod-v", "ZU37KS", 1, {"r3": "row-v1", "r4": "row-v2"}),
        module("mod-a", "ZU37VT5APZ2", 2, {"r3": "row-a1"}),
    ]
    rows = [
        row("row-nar", "F1 · NAR", [dev("dev-q0", "sls", designation="Q0", rating="E35")]),
        row("row-aar1", "F1 · AAR 1", [
            dev("dev-q1", "hauptschalter", designation="Q1", parent_id="dev-q0", supplied_by=supplied("mod-z", "hs"))]),
        row("row-aar2", "F1 · AAR 2", [dev("dev-x0", "hlak", designation="X0", supplied_by=supplied("mod-z", "hlak"))]),
        row("row-v1", "F2 · Verteiler 3", [
            fi("dev-f1", "F1", parent_id="dev-q1"),
            ls("dev-f1-1", "F1.1", "1", "Licht EG", room="Flur", terminal_block=True),
            ls("dev-f1-2", "F1.2", "2", "Steckdosen EG", room="Wohnen", terminal_block=True)]),
        row("row-v2", "F2 · Verteiler 4", [
            fi("dev-f2", "F2", parent_id="dev-q1"),
            ls("dev-f2-1", "F2.1", "3", "Küche", room="Küche"),
            ls("dev-f2-2", "F2.2", "4", "Bad", room="Bad")]),
        row("row-a1", "F3 · Verteiler 3", [
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


# ── Round 2: the WAGO terminal boards (docs/PANEL_ENCLOSURE_R2.md §14.1) ─────


def terminals_zb34s() -> dict[str, Any]:
    modules = [
        module("mod-z", "ZH3EH16", 0, {"nar": "row-z-nar", "aar1": "row-z-aar1", "aar2": "row-z-aar2"},
               label="Allgemein", meters=[meter(0, "1XYZ0000000031", "Allgemein")]),
        module("mod-k", "ZU37KS", 1, {"r1": "row-old1", "r2": "row-old2", **{f"r{r}": f"row-k{r}" for r in range(3, 8)}}),
        module("mod-rk", "ZU37RK", 2, {}),
        module("mod-w", "ZU37KS", 3, {f"r{r}": f"row-w{r}" for r in range(3, 8)}),
    ]
    feed = {"parent_id": "dev-q1"}
    rows = [
        row("row-z-nar", "F1 · NAR", [dev("dev-q0", "sls", designation="Q0", rating="E35")]),
        row("row-z-aar1", "F1 · AAR 1", [
            dev("dev-q1", "hauptschalter", designation="Q1", parent_id="dev-q0", supplied_by=supplied("mod-z", "hs"))]),
        row("row-z-aar2", "F1 · AAR 2", [
            dev("dev-x0", "hlak", designation="X0", supplied_by=supplied("mod-z", "hlak")),
            ls("dev-aar-ls1", "F0.1", "1", "Steuerung SMGW", terminal_block=True)]),
        # Placed before R2 reserved r1/r2: F1 and four LS (140 mm), then three
        # LS and the hand-placed strip space that pre-R2 boards needed.
        row("row-old1", "F2 · Verteiler 1", [fi("dev-f1", "F1", **feed), *ls_run("f1", "F1", range(1, 5), 2)]),
        row("row-old2", "F2 · Verteiler 2", [
            *ls_run("f1", "F1", range(5, 8), 6), dev("dev-pl1", "terminal", label="Reihenklemme N/PE")]),
        *[
            row(f"row-k{rail}", f"F2 · Verteiler {rail}",
                [fi(f"dev-f{group}", f"F{group}", **feed), *ls_run(f"f{group}", f"F{group}", range(1, 9), circuit)])
            for rail, group, circuit in ((3, 2, 9), (4, 3, 17), (5, 4, 25), (6, 5, 33), (7, 6, 41))
        ],
        # 2-TE FIs: X7, X8, X9 = FI + 10 LS (71.5 mm), X10 = F9's 3-pole B20
        # Block, X11, X12 = FI + 6 LS (50.7 mm).
        row("row-w3", "F4 · Verteiler 3", [fi("dev-f7", "F7", te=2, **feed), *ls_run("f7", "F7", range(1, 11), 49)]),
        row("row-w4", "F4 · Verteiler 4", [fi("dev-f8", "F8", te=2, **feed), *ls_run("f8", "F8", range(1, 11), 59)]),
        row("row-w5", "F4 · Verteiler 5", [fi("dev-f9", "F9", te=2, **feed), *ls_run("f9", "F9", range(1, 11), 69)]),
        row("row-w6", "F4 · Verteiler 6", [
            ls("dev-f9-11", "F9.11", "79", "Durchlauferhitzer", rating="B20", poles=3, te=3, terminal_block=True),
            fi("dev-f10", "F10", te=2, **feed), *ls_run("f10", "F10", range(1, 7), 80)]),
        row("row-w7", "F4 · Verteiler 7", [fi("dev-f11", "F11", te=2, **feed), *ls_run("f11", "F11", range(1, 7), 86)]),
    ]
    return document("ZB34S", modules, rows)


def terminals_rk_zb53s() -> dict[str, Any]:
    stored_order = {"0": {"strips": ["dev-f3:leiste", "dev-gone:leiste", "dev-f4:leiste", "dev-q2:leiste"],
                          "rail2_from": "dev-q2:leiste"}}
    modules = [
        module("mod-m", "ZH5EL27", 0, {"nar": "row-m-nar", "vf1": "row-m-vf1"},
               meters=[meter(0, "1XYZ0000000041", "WE 1")]),
        module("mod-r", "ZU59RK", 1, {f"r{r}": f"row-r{r}" for r in range(3, 8)}, terminal_order=stored_order),
        module("mod-x", "ZH53XSRK", 2, {"sas": "row-x-sas", "r3": "row-x3"}),
    ]
    rows = [
        row("row-m-nar", "F1 · NAR", [dev("dev-q0", "sls", designation="Q0", rating="E35")]),
        # The VF of a meter field has no terminal rails: X1 goes to field 1 (R6).
        row("row-m-vf1", "F1 · Verteilerfeld 1", [fi("dev-f1", "F1", parent_id="dev-q0"), *ls_run("f1", "F1", range(1, 3), 1)]),
        # LS straight under a Hauptschalter: a Leiste without feed and end clamp.
        row("row-r3", "F2 · Verteiler 3", [
            dev("dev-q2", "hauptschalter", designation="Q2", parent_id="dev-q0"), *ls_run("q2", "F2", range(1, 4), 3)]),
        # F3 grew to 20 LS since the order was stored, so its rail-2 split no longer fits.
        row("row-r4", "F2 · Verteiler 4", [fi("dev-f3", "F3", parent_id="dev-q2"), *ls_run("f3", "F3", range(1, 9), 6)]),
        row("row-r5", "F2 · Verteiler 5", ls_run("f3", "F3", range(9, 21), 14)),
        row("row-r6", "F2 · Verteiler 6", [fi("dev-f4", "F4", parent_id="dev-q2"), *ls_run("f4", "F4", range(1, 9), 26)]),
        # F5.3 is pinned to F5 in field 2; F6 feeds only circuits pinned in field 2.
        row("row-r7", "F2 · Verteiler 7", [
            ls("dev-f5-3", "F5.3", "34", "Stromkreis 34", terminal_block=True, parent_id="dev-f5"),
            fi("dev-f6", "F6", parent_id="dev-q2")]),
        # The SAS of a Verteilerfeld keeps its WAGO (R3): the wallbox gets its Block.
        row("row-x-sas", "F3 · Sammelschienen", [
            dev("dev-q20", "sls", designation="Q20", rating="E50"),
            dev("dev-w1", "wallbox", designation="F7", circuit="35", label="Wallbox Carport", rating="C32",
                terminal_block=True)]),
        row("row-x3", "F3 · Verteiler 3", [
            fi("dev-f5", "F5", parent_id="dev-q20"), *ls_run("f5", "F5", range(1, 3), 36),
            *ls_run("f6", "F6", range(1, 3), 38, parent_id="dev-f6")]),
    ]
    return document("ZB53S", modules, rows)


def terminals_overflow_zb32s() -> dict[str, Any]:
    modules = [
        module("mod-o", "ZU37KS", 0, {f"r{r}": f"row-o{r}" for r in range(3, 8)}),
        module("mod-e", "ZU37KS", 1, {}),
    ]
    rows = [
        row(f"row-o{rail}", f"F1 · Verteiler {rail}",
            [fi(f"dev-f{group}", f"F{group}", te=2), *ls_run(f"f{group}", f"F{group}", range(1, 11), 1 + (group - 1) * 10)])
        for group, rail in enumerate(range(3, 8), start=1)
    ]
    return document("ZB32S", modules, rows)


def three_point_zb53s() -> dict[str, Any]:
    """Round 3: the current 3-Punkt kits. A ZH53W9SNT (VF over AAR, one place,
    Zählersteckklemme) with an FI group on its VF, a 16 mm² ZH50D53ST with
    HLAK and Trennvorrichtung fed by an E50, and a ZH53X3T Doppelstock with
    one meter and one free place — both of its Trennvorrichtungen pre-fitted."""
    modules = [
        module("mod-w", "ZH53W9SNT", 0, {"nar": "row-w-nar", "aar2": "row-w-aar2", "vf2": "row-w-vf2"},
               meters=[meter(0, "1XYZ0000000051", "WE 1")]),
        module("mod-d", "ZH50D53ST", 1, {"nar": "row-d-nar", "aar1": "row-d-aar1", "aar2": "row-d-aar2"},
               meters=[meter(0, "1XYZ0000000052", "Wärmepumpe")]),
        module("mod-t", "ZH53X3T", 2, {"nar": "row-t-nar", "aar2": "row-t-aar2"},
               meters=[meter(0, "1XYZ0000000053", "WE 2")]),
    ]
    rows = [
        row("row-w-nar", "F1 · NAR", [dev("dev-w-q0", "sls", designation="Q0", rating="E35")]),
        row("row-w-aar2", "F1 · AAR 2", [
            dev("dev-w-q1", "hauptschalter", designation="Q1", parent_id="dev-w-q0", supplied_by=supplied("mod-w", "trenn"))]),
        row("row-w-vf2", "F1 · Verteilerfeld 2", [
            fi("dev-w-f1", "F1", parent_id="dev-w-q1"), *ls_run("w-f1", "F1", range(1, 4), 1)]),
        row("row-d-nar", "F2 · NAR", [dev("dev-d-q0", "sls", designation="Q10", rating="E50")]),
        row("row-d-aar1", "F2 · AAR 1", [dev("dev-d-x0", "hlak", designation="X10", supplied_by=supplied("mod-d", "hlak"))]),
        row("row-d-aar2", "F2 · AAR 2", [
            dev("dev-d-q1", "hauptschalter", designation="Q11", parent_id="dev-d-q0", supplied_by=supplied("mod-d", "trenn"))]),
        row("row-t-nar", "F3 · NAR", [dev("dev-t-q0", "sls", designation="Q20", rating="E35")]),
        row("row-t-aar2", "F3 · AAR 2", [
            dev("dev-t-q1", "hauptschalter", designation="Q21", parent_id="dev-t-q0", supplied_by=supplied("mod-t", "trenn")),
            dev("dev-t-q2", "hauptschalter", designation="Q22", supplied_by=supplied("mod-t", "trenn2"))]),
    ]
    return document("ZB53S", modules, rows)


BOARDS = {
    "meter_dist_zb33s": meter_dist_zb33s,
    "violations_zb34s": violations_zb34s,
    "removed_dangling_zb52s": removed_dangling_zb52s,
    "tall_zb54s": tall_zb54s,
    "cross_feed_zb33s": cross_feed_zb33s,
    "terminals_zb34s": terminals_zb34s,
    "terminals_rk_zb53s": terminals_rk_zb53s,
    "terminals_overflow_zb32s": terminals_overflow_zb32s,
    "three_point_zb53s": three_point_zb53s,
}
