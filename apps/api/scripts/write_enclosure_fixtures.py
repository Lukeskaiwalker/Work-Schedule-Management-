"""Write the shared cabinet fixture the TypeScript twins are pinned on.

    cd apps/api
    PYTHONPATH=. python scripts/write_enclosure_fixtures.py

Writes ``apps/web/src/test/fixtures/enclosureFixtures.json``
(docs/PANEL_ENCLOSURE.md §14):

    {"catalog": <EnclosureCatalogOut subset>,
     "constants": {"TERMINAL_RAIL_USABLE_MM", "TERMINAL_RAIL_USABLE_VERIFIED"},
     "label_fit": [{"text", "cell": {"w", "h"}, "size": {"max", "min"}, "scale", "fit"}],
     "boards": {name: {"document", "order", "scene_open", "scene_closed", "findings",
                       "terminal_skip", "terminal_placement", "terminal_closeup",
                       "terminal_suggestions"}}}

The layout, the geometry and the findings exist twice — here in Python for the
PDF and the panel detail, in ``apps/web/src/utils/enclosure*.ts`` for the
editor — and D8 wants one picture, not two. So Python computes every answer
once, this file records it, and both test suites demand it back:
``tests/test_panel_enclosure_{layout,geometry,rules}.py`` and the web parity
tests. A rule changed on one side only turns one of them red. After a
deliberate change, re-run this script and commit the JSON with the change.

The boards and their builders live in ``enclosure_fixture_boards.py``
(re-exported here, so tests import either). Round 2 added the keys
``terminal_skip``, ``terminal_placement``, ``terminal_closeup`` and
``terminal_suggestions`` per board, the strip boxes in ``scene_open``, the
top-level ``constants`` and the ``label_fit`` table both twins of
``fit_label`` run (docs/PANEL_ENCLOSURE_R2.md §14.1, §7.1). Round 4
(docs/PANEL_ENCLOSURE_R4.md §10) added ``control_block`` (the placement) and
``prep`` (``cabinet_prep``) per board, the ``control_block`` box in
``scene_open``, the round-4 findings, and the parser tables
``control_block_parse``, ``prep_parse``, ``infeed_parse`` and ``fuse_parse``
(plus ``control_strip_size`` once the printing slice's module exists).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

API_ROOT = Path(__file__).resolve().parents[1]
if str(API_ROOT) not in sys.path:  # run as a plain script from apps/api
    sys.path.insert(0, str(API_ROOT))

from app.schemas.panel_enclosure import CatalogEntryOut, parse_control_block, parse_prep  # noqa: E402
from app.services.cable_section_parse import parse_cable_section, parse_fuse_amps  # noqa: E402
from app.services.label_fit import fit_label  # noqa: E402
from app.services.panel_enclosure_catalog import EnclosureCatalog, builtin_catalog  # noqa: E402
from app.services.panel_enclosure_control_block import (  # noqa: E402
    DEFAULT_CONTROL_LABELS,
    place_control_block,
)
from app.services.panel_enclosure_geometry import build_enclosure_scene  # noqa: E402
from app.services.panel_enclosure_layout import physical_row_order  # noqa: E402
from app.services.panel_enclosure_prep import cabinet_prep  # noqa: E402
from app.services.panel_enclosure_rules import enclosure_findings  # noqa: E402
from app.services.panel_enclosure_terminal_closeup import terminal_closeup  # noqa: E402
from app.services.panel_enclosure_terminal_suggest import terminal_suggestions  # noqa: E402
from app.services.panel_enclosure_terminals import (  # noqa: E402
    TERMINAL_RAIL_USABLE_MM,
    TERMINAL_RAIL_USABLE_VERIFIED,
    board_terminals,
    place_terminals,
)
from scripts.enclosure_fixture_boards import (  # noqa: E402,F401  (re-exported for the tests)
    BOARDS,
    CUSTOM_APZ_MIDDLE,
    busbar_gap_zb34s,
    control_3p_zb53s,
    control_ehz_zb33s,
    cross_feed_zb33s,
    custom_apz_middle_spec,
    dev,
    document,
    fi,
    ls,
    ls_run,
    meter,
    meter_dist_zb33s,
    module,
    removed_dangling_zb52s,
    reserve_zb33s,
    row,
    snapshot,
    supplied,
    tall_zb54s,
    terminals_overflow_zb32s,
    terminals_rk_zb53s,
    terminals_zb34s,
    violations_zb34s,
)

FIXTURE_PATH = API_ROOT.parent / "web" / "src" / "test" / "fixtures" / "enclosureFixtures.json"

CATALOG_CODES = (
    "ZB33S", "ZB34S", "ZB52S", "ZB54S",
    "ZH3EH16", "ZU37KS", "ZU37VT5APZ2", "ZH3EL27", "ZH3EL22", "ZH33X7",
    "ZH5EL27", "ZH53X3", "ZH53XS", "ZU62A",
    # Round 2 (§14.1): the RK fields, and the two cabinets the terminal boards use.
    "ZB32S", "ZB53S", "ZU37RK", "ZU59RK", "ZU37V5RKAPZ2", "ZH53XSRK",
    # Round 3: the three 3-Punkt kits of three_point_zb53s.
    "ZH53W9SNT", "ZH50D53ST", "ZH53X3T",
    # Round 4 (R4 §10): the codes of the new boards, and ZH3ES5 for the moved SAS.
    "ZH3ES5", "ZU59VT7APZ2", "ZH33XL", "ZH53X9ST",
)

# ── Catalogue subset ─────────────────────────────────────────────────────────


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


# ── The text-fit table (R2 §7.1) ─────────────────────────────────────────────

_MARKER_PT = (14.74, 28.35)  # a 5.2 mm terminal under the PDF's 10 mm marker strip
# (text, (cell w, cell h), (size max, size min), scale): every branch of fit_label.
LABEL_FIT_CASES: tuple[tuple[str, tuple[float, float], tuple[float, float], float], ...] = (
    ("X1", _MARKER_PT, (6, 5), 1.0),                          # horizontal at max
    ("10.12", _MARKER_PT, (6, 5), 1.0),                       # shrunk
    ("Steckdosen", _MARKER_PT, (6, 5), 1.0),                  # rotated
    ("Steckdosen Küche", _MARKER_PT, (6, 5), 1.0),            # ellipsis, rotated keeps more
    ("ab cde", (25, 10), (10, 10), 1.0),                      # ellipsis, horizontal, trailing space cut
    ("ab cde", (25, 10), (10, 10), 1.0),                 # only U+0020 is cut: the no-break space stays
    ("1.12", (26, 40), (13, 11), 1.1),                        # the app's 1.1 margin
    ("Abc", (2, 2), (6, 5), 1.0),                             # nothing fits
    ("", _MARKER_PT, (6, 5), 1.0),                            # empty
    ("F1.1 · Licht EG · Nr. 1", (30, 220), (13, 11), 1.1),    # a "für" column in the app sheet
    ("Wärmepumpe Außeneinheit — 3×", (80, 12), (5.5, 5), 1.0),  # umlauts, ß, dash, ×
)


def label_fit_cases() -> list[dict[str, Any]]:
    return [
        {"text": text, "cell": {"w": w, "h": h}, "size": {"max": high, "min": low}, "scale": scale,
         "fit": fit_label(text, w, h, high, low, scale).as_dict()}
        for text, (w, h), (high, low), scale in LABEL_FIT_CASES
    ]


# ── The round-4 parser tables (R4 §2.1, §2.2, §3.5) ──────────────────────────

_T = {"id": "t1", "label": "UNSM", "color": "braun"}
CONTROL_BLOCK_PARSE_CASES: tuple[Any, ...] = (
    None, "x", [], 5,
    {},
    {"terminals": "x", "rail": "aar1", "wire_mm2": 1.5, "wire_length_m": 2.25, "label_material": "wago-211-501",
     "off": True},
    {"terminals": [_T, "x", None, 3, {"label": "60%"}]},
    {"terminals": [{"label": f"K{i}"} for i in range(14)]},
    {"terminals": [{"id": "t2"}, {"id": "t2"}, {"id": "T3"}, {"id": "t1234"}, {"id": "t01"}, {"id": 5}, {}]},
    {"terminals": [{"label": 7}, {"label": "  60 %  "}, {"label": "a\u0000b\u001fc\u007fd\u0085e\u009f"},
                   {"label": "\u00a0UNSM\u00a0"}, {"label": "Steuerbox-Abgang-1"}, {"label": "  0123456789abc"},
                   {"label": "🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌"}, {"label": "\tStve\n"}]},
    {"terminals": [{"color": c} for c in ("weiß", "grün", "Braun", None, "rosa", "", "orange", 3, "blau")]},
    {"rail": "aar2"}, {"rail": "AAR1"}, {"rail": ""}, {"rail": "aar 1"}, {"rail": 5}, {"rail": "a" * 41},
    {"rail": "aar1\n"},
    {"wire_mm2": 2}, {"wire_mm2": True}, {"wire_mm2": "2.5"}, {"wire_mm2": 1.50}, {"wire_mm2": 4},
    {"wire_length_m": 0.44}, {"wire_length_m": 0.45}, {"wire_length_m": 20.04}, {"wire_length_m": 20.05},
    {"wire_length_m": 1.25}, {"wire_length_m": 3}, {"wire_length_m": True}, {"wire_length_m": "5"},
    {"wire_length_m": -1}, {"wire_length_m": 1e12},
    {"label_material": "wago-211-502"}, {"label_material": "wago-2009-110"}, {"label_material": ["wago-211-501"]},
    {"off": "true"}, {"off": 1}, {"off": False},
    {"terminals": [_T], "extra": "dropped", "rail": None},
)
PREP_PARSE_CASES: tuple[Any, ...] = (
    None, "auto", [], {},
    {"supply": "LS", "infeed": "clamps", "joints": "off", "network": "off", "network_m": 2.25},
    {"supply": "SI", "infeed": "K96ESA5", "joints": "auto", "network": "auto", "network_m": 0.5},
    {"supply": "off", "infeed": "off"},
    {"supply": "sa", "infeed": "K96F", "joints": "on", "network": True, "network_m": 0.3},
    {"supply": "SA", "network_m": 20.05}, {"network_m": True}, {"network_m": "2"}, {"network_m": 7},
    {"supply": 5, "infeed": None, "extra": 1},
)
INFEED_PARSE_CASES: tuple[str, ...] = (
    "NYY-J 5x16 mm²", "NYY-J 5×35mm²", "5G25", "4x35+16", "NYCWY 3x35/16", "NAYY-J 4x50", "NA2XY 4x150",
    "35 mm2", "35 qmm", "NYY-J 5x16, 3x63A", "NYY-J 5x16\u00a0mm²", "1x500+5x35", "", "Hausanschluss",
    "NYM-J 5x2,5", "NYY-J 4 x 240 mm²", "5x16.5", "12x16", "Alu 4x50", "NYY 5*25 qmm", "3 x 63 A",
)
FUSE_PARSE_CASES: tuple[str, ...] = ("NH 63 A", "3x63A", "125 Ampere", "", "NH00 100A", "NH00 gG 63 A / SLS 50 A",
                                     "63 Amp", "2.5a")


def parser_tables() -> dict[str, Any]:
    return {
        "control_block_parse": [{"input": case, "output": parse_control_block(case)}
                                for case in CONTROL_BLOCK_PARSE_CASES],
        "prep_parse": [{"input": case, "output": parse_prep(case)} for case in PREP_PARSE_CASES],
        "infeed_parse": [{"input": text, "output": parse_cable_section(text)} for text in INFEED_PARSE_CASES],
        "fuse_parse": [{"input": text, "output": parse_fuse_amps(text)} for text in FUSE_PARSE_CASES],
    }


def control_strip_size_cases() -> list[dict[str, Any]] | None:
    """HOOK for the printing slice (R4 §9.1, table ``control_strip_size``):
    emitted once ``werkstatt_label_control_strip.control_strip_size(labels)``
    exists; until then the key is left out."""
    try:
        from app.services.werkstatt_label_control_strip import control_strip_size
    except ImportError:
        return None
    cases = (list(DEFAULT_CONTROL_LABELS), ["", "", ""], ["UNSM", "Steuerbox 12"], ["0%"])
    return [{"labels": labels, "size": control_strip_size(labels)} for labels in cases]


# ── Output ───────────────────────────────────────────────────────────────────


def board_answers(document: dict[str, Any], catalog: EnclosureCatalog) -> dict[str, Any]:
    """Everything the twins must agree on for one board."""
    terms = board_terminals(document, catalog)
    placement = place_terminals(document, catalog, terms)
    return {
        "order": physical_row_order(document, catalog),
        "scene_open": build_enclosure_scene(document, catalog, view="open", placement=placement),
        "scene_closed": build_enclosure_scene(document, catalog, view="closed", placement=placement),
        "findings": enclosure_findings(document, catalog, terms, placement),
        "terminal_skip": sorted(terms.skip),
        "terminal_placement": placement,
        "terminal_closeup": terminal_closeup(document, catalog, terms, placement),
        "terminal_suggestions": terminal_suggestions(document, catalog, terms, placement),
        "control_block": place_control_block(document, catalog),
        "prep": cabinet_prep(document, catalog),
    }


def build_fixtures() -> dict[str, Any]:
    payload = catalog_payload()
    # Read back through the API shape, as the web client does.
    catalog = EnclosureCatalog.from_out(payload)
    boards = {}
    for name, make in BOARDS.items():
        doc = make()
        boards[name] = {"document": doc, **board_answers(doc, catalog)}
    constants = {
        "TERMINAL_RAIL_USABLE_MM": TERMINAL_RAIL_USABLE_MM,
        "TERMINAL_RAIL_USABLE_VERIFIED": TERMINAL_RAIL_USABLE_VERIFIED,
    }
    out = {"catalog": payload, "constants": constants, "label_fit": label_fit_cases(), **parser_tables()}
    strip_sizes = control_strip_size_cases()
    if strip_sizes is not None:
        out["control_strip_size"] = strip_sizes
    return {**out, "boards": boards}


def render(fixtures: dict[str, Any]) -> str:
    return json.dumps(fixtures, ensure_ascii=False, indent=1) + "\n"


def main() -> int:
    FIXTURE_PATH.write_text(render(build_fixtures()), encoding="utf-8")
    print(f"wrote {FIXTURE_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
