# Verteilerpläne — Schrank, Runde 4: Zählerschrank-Vorbereitung, §14a-Klemmleiste, Modulsuche

Contract for round 4 of the cabinet layer. Read `PANEL_ENCLOSURE.md` (round 1)
and `PANEL_ENCLOSURE_R2.md` (round 2) first; this file only states what changes.
The all-conductor schematic has its own contract, `SCHALTPLAN_STROMLAUF.md`.
The repo is public: every example below is invented data.

Status: **rev 2**, 2026-10-26, branch `claude/verteiler-r4` (v2.15.3 = 0ab0192
plus the merged `claude/label-calibration`). Rev 2 folds in a three-lens
review (owner/electrical, code fit, UI/print); §17 lists what changed.

---

## 0. Owner asks of 2026-10-26 (binding)

| # | Ask (condensed) | Owner answer to a follow-up |
|---|---|---|
| O1 | "search box is needed" — the module picker (the owner answered the offer "add a quick search … to the picker"; cmd+F today) | — |
| O2 | §14a block in the **first meter field from the left**: 249-116 on each side, six 2002-1671, one 2002-1692 after the last 2002-1671. Labels left → right "UNSM", "60%", "30%", "0%", "UStve", "Stve", written **vertically** on the same solid strip as the other WAGOs. Add/remove single clamps, rename each output. | Text reads **bottom → top**. |
| O3 | 6 × H07V-K 1 × 2,5 mm² in several colours from the block to the **APZ field** (3-Punkt cabinet) or to the **RfZ above the first meter** (eHZ cabinet); at the far end a Lüsterklemme with exactly as many poles as WAGOs. | Default **2,5 mm² + WAGO 211-502** tube (211-501 takes only 0,75–1 mm²); **both changeable per board**. Lengths **from the cabinet drawing + reserve**, editable. |
| O4 | Wire labels on heat-shrink, the same label at both ends → **each label twice**. | Tube per O3. |
| O5 | Network cable from the APZ field to the RfZ above the eHZ meter, or to the meter itself (3-Punkt). | Length from the drawing (O3). |
| O6 | Spannungsversorgung for APZ and RfZ ("something like ZY3N2SA, check which one is right for each panel"). | — |
| O7 | More than one module with Sammelschienen → connect with Hager **ZZ55SAVE**. | — |
| O8 | Each cabinet with Sammelschienen needs a **K96ESA5**, only if the infeed is ≤ 25 mm²; no info → assume K96ESA5; otherwise Sammelschienenklemmen. | — |
| O9 | What happened to the printer calibration tool? | Merge it into this round. |
| O10 | Better schematic in the export. | Add allpolig sheets **and** fix the Übersicht → `SCHALTPLAN_STROMLAUF.md`. |
| O11 | — | Deploy: stage, then swap after hours. |

No discontinued Hager articles (standing rule). Checked on hager.com on
2026-10-26, none "Auslaufprodukt": ZY3N1SA, ZY3N2SA, ZY5N1SA, ZY5N2SA,
ZY3N1LS, ZY3N2LS, ZY5N1LS, ZY5N2LS, ZY3R1SI, ZY3R2SI, ZY5R1SI, ZY5R2SI,
ZZ55SAVE, K96ESA5, K96F, K96H, K96K, K96N, KS18D, ZZ45WAN040/100/150/200/500.
(The builder re-checks K96N and the LS/SI kits with `curl -A Mozilla
'https://hager.com/de/katalog/?artnr=CODE' | grep -c Auslaufprodukt` and
reports any hit instead of shipping it.)

## 1. Decisions

| # | Decision | Why |
|---|---|---|
| R4-1 | The §14a block is **stored** at the enclosure level: `enclosure.control_block` (§2.1). Its carrier is **derived** (§3.1): the first in-use meter module from the left. | "first meter field from the left": adding or moving a meter module moves the block with the rule. Labels are user data. |
| R4-2 | The block is **seeded** by the client op `placeModule` when it places a meter-family module and `control_block` is absent. Boards older than round 4 get the info finding `encl.control_block_missing` with the action "§14a-Klemmleiste anlegen". The server never writes it. | The block holds user data only the editor can seed. |
| R4-3 | The block sits on an **AAR rail of the carrier** (BDEW Anwendungshilfe §3.5.2: the Steuersignal-Klemmleiste belongs in the AAR above the meter field; never in APZ/RfZ). It is a scoped exception to R2's "no WAGO on AAR" (R3/Q4) and "no 249-116" (R7): both stay true for circuit terminals; the block has its own part table (`CONTROL_PARTS ∩ TERMINAL_PARTS = ∅`, tested) and its own placement, never `place_terminals`. | Keeps every R2 invariant. |
| R4-4 | Supply kit, infeed part, busbar joints, network cable, wires, Lüsterklemme, PEN split and wire runs are **derived** (`cabinet_prep`, §3.3), and they **do** appear on existing cabinet boards, built ones included; the owner reviews `report_prep_impact.py` before the swap. Each derived group can be **overridden per board** (`enclosure.prep`, §2.2). | One source of truth that follows the cabinet; the VNB or the Werkstatt can still decide otherwise without hand lines that double the article. |
| R4-5 | Twins: `panel_enclosure_control_block.py ⇄ enclosureControlBlock.ts`, `panel_enclosure_prep.py ⇄ enclosurePrep.ts`, `panel_enclosure_prep_rules.py ⇄` (inside `enclosureRules.ts` or a new `enclosurePrepRules.ts`), pinned by the shared fixture (§10). The Materialliste stays server-only. | The Schrank tab renders live (D8). |
| R4-6 | New Materialliste lines use kind `enclosure`. New mapping prefixes `wire:` and `prep:`. Hager items use `accessory:<art>`, WAGO block parts `part:<art>`. | No new kind → no Literal/TS/PDF/consumption change. |
| R4-7 | Wire lengths are measured on the drawing plus a reserve; the ledger is integer, so planned = **whole metres (ceil)**, computed in integer decimetres; the detail shows the measured value. The network lead comes from **Hager's own length table** when it covers the case, else from the drawing (§3.3 d). | O3/O5; `planned` is `int`; Hager's table is what their kits are measured for. |
| R4-8 | Printed labels are **not** Materialliste lines (block strip: Klemmen print dialog; wire labels: print target "Aderbeschriftung"). | You print them, you don't pick them. |
| R4-9 | Catalogue correction: the Sammelschienenzone of ZH3ES5, ZH3ES5RK, ZH53XS, ZH53XSRK moves to the **bottom** (Hager photos). Keys unchanged. | Physical truth; joints need aligned bars. |
| R4-10 | The infeed cross-section is **parsed** from `supply.incoming` (no schema change); the Daten tab shows what was recognised. | O8 "no info → K96ESA5". |
| R4-11 | Busbar zones have a **role**: `main` (Hauptleitung, ungezählt: every NAR zone, the SAS of `communication` modules, a SAS whose rail holds an `sls`) or `customer` (every other SAS: Kundenverteilung, gezählt). Joints and the infeed only connect `main` to `main` and `customer` to `customer`; the infeed serves `main` runs only. | A ZZ55SAVE between an unmetered NAR and a metered customer busbar would bridge around the meter (R2 §1: "the SAS of a busbar Verteilerfeld is the customer's distribution after the meter"). |
| R4-12 | Reserve meter fields (ZH33XL, ZH53XL, ZH52XL) are flagged `reserve_field: true` in the catalogue and are never the carrier while an in-use meter module exists. | "first meter field" means the first metering place in use. |

## 2. Stored data

### 2.1 `enclosure.control_block`

```jsonc
"enclosure": {
  "code": "ZB33S", "modules": [ … ],
  "control_block": {                       // absent on boards older than round 4
    "terminals": [                         // left → right; 0..12
      { "id": "t1", "label": "UNSM",  "color": "braun"   },
      { "id": "t2", "label": "60%",   "color": "schwarz" },
      { "id": "t3", "label": "30%",   "color": "grau"    },
      { "id": "t4", "label": "0%",    "color": "rot"     },
      { "id": "t5", "label": "UStve", "color": "violett" },
      { "id": "t6", "label": "Stve",  "color": "weiß"    }
    ],
    "rail": null,                          // AAR rail key of the carrier; null = automatic (§3.2)
    "wire_mm2": 2.5,                       // 1.5 | 2.5
    "wire_length_m": null,                 // null = measured; else 0.5..20, one decimal
    "label_material": "wago-211-502",      // "wago-211-502" | "wago-211-501"
    "off": false                           // true = removed on this board
  }
}
```

`parse_control_block(value) -> dict | None` ⇄ `parseControlBlock`, lenient,
never raises; `PanelEnclosure.control_block: Annotated[ControlBlock | None,
BeforeValidator(parse_control_block)] = Field(default=None, exclude_if=lambda v: v is None)`
(the `terminal_order` pattern; unknown keys inside the block are dropped, as
in `terminal_order` — a later round that adds keys bumps it with a rollback note).
Exact algorithm (both twins; the fixture table `control_block_parse` pins every branch):

1. not a dict → `None`.
2. `entries = [e for e in (v["terminals"] if it is a list else []) if isinstance(e, dict)][:12]`.
3. Ids, pass 1: keep `e["id"]` if it is a str, `re.fullmatch(r"t[0-9]{1,3}", id, re.ASCII)` (TS `/^t[0-9]{1,3}$/`) and not already kept. Pass 2: in list order, every entry without a kept id gets `t<n>`, the smallest `n ≥ 1` not yet kept or assigned.
4. `label`: a str else `""`; remove U+0000–U+001F and U+007F–U+009F; strip U+0020 only (both ends); cut to **12 code points** (Python `s[:12]`, TS `Array.from(s).slice(0, 12).join("")`); no second strip.
5. `color`: one of `WIRE_COLOURS` else `WIRE_COLOURS[i % 8]` (i = index after step 2).
6. `rail`: a str that fully matches `KEY_PATTERN` else `None`.
7. `wire_mm2`: a non-bool number equal to 1.5 or 2.5 else 2.5.
8. `wire_length_m`: a non-bool finite int/float `v`; `r = round1(v)` (half-up); `r` if `0.5 ≤ r ≤ 20` else `None`.
9. `label_material`: `"wago-211-501"` or `"wago-211-502"` else `"wago-211-502"`.
10. `off`: `value["off"] is True`.

Output key order: `terminals, rail, wire_mm2, wire_length_m, label_material, off`;
terminal keys `id, label, color`. Every derivation (Python and TS) reads the
block **only** through the parser — never the raw stored value.
`panel_enclosure_control_block.py` re-exports `parse_control_block`.

### 2.2 `enclosure.prep` (per-board overrides of derived items)

```jsonc
"prep": { "supply": "auto", "infeed": "auto", "joints": "auto", "network": "auto", "network_m": null }
```

`parse_prep` ⇄ `parsePrep` (fixture table `prep_parse`), lenient, `exclude_if None`;
absent ≡ all `auto`. Values: `supply` ∈ {`auto`,`SA`,`LS`,`SI`,`off`};
`infeed` ∈ {`auto`,`K96ESA5`,`clamps`,`off`}; `joints` ∈ {`auto`,`off`};
`network` ∈ {`auto`,`off`}; `network_m`: rule 8 above (0.5..20, one decimal) else
`null`. Anything else → `auto` / `null`. Output key order as written.
Effects: §3.3. Ops: `setPrepOverride(key, value)` (pure; `"auto"` everywhere and
`network_m: null` removes the key).

### 2.3 Constants (both twins, exact)

```text
CONTROL_PARTS = {
  "249-116":   { label: "WAGO 249-116 Endklammer",                       width_mm: 6.0, marker: false },
  "2002-1671": { label: "WAGO 2002-1671 2-Leiter-Trenn- und Messklemme", width_mm: 5.2, marker: true  },
  "2002-1692": { label: "WAGO 2002-1692 Abschluss- und Zwischenplatte",  width_mm: 1.0, marker: false },
}
DEFAULT_CONTROL_LABELS = ["UNSM", "60%", "30%", "0%", "UStve", "Stve"]
WIRE_COLOURS = ["braun", "schwarz", "grau", "rot", "violett", "weiß", "orange", "rosa"]
  # never grün-gelb (PE), hellblau/blau (N), single grün/gelb
WIRE_COLOUR_STYLE = { braun: "#8a5527", schwarz: "#1c2024", grau: "#8b929b", rot: "#d0312d",
                      violett: "#7547c9", weiß: "#ffffff", orange: "#f08a24", rosa: "#f2a7c3" }
  # weiß and rosa are drawn with a 1 px #6b7a8c outline; UI option text capitalised ("Braun")
DEFAULT_WIRE_MM2 = 2.5
DEFAULT_LABEL_MATERIAL = "wago-211-502"
TUBE_MATERIAL_IDS = {"wago-211-501", "wago-211-502"}
MAX_CONTROL_TERMINALS = 12
CONTROL_LABEL_MAX = 12            # code points
WIRE_RESERVE_DM = 3               # 300 mm per wire (150 per end)
NETWORK_RESERVE_MM = 300          # only for meter_3p (Hager: ≥ 30 cm free cable)
NETWORK_LEADS = [(400,"ZZ45WAN040"),(1000,"ZZ45WAN100"),(1500,"ZZ45WAN150"),(2000,"ZZ45WAN200"),(5000,"ZZ45WAN500")]
WIRE_LABEL_PIECE_MM = 15.0        # one sleeve; ungeprüft
WIRE_LABEL_MAX_DOTS = 48
```

Default block = `t1…t6`, `DEFAULT_CONTROL_LABELS`, the first six `WIRE_COLOURS`,
`rail: null`, `wire_mm2: 2.5`, `wire_length_m: null`, `label_material:
"wago-211-502"`, `off: false` (`default_control_block()` ⇄ `defaultControlBlock()`).

### 2.4 Catalogue spec field

`ModuleSpec.reserve_field: bool = False` (Python schema, TS type, admin form
untouched — admins may set it in JSON); built-ins ZH33XL, ZH53XL, ZH52XL get
`true`. Not frozen (§3.5 of round 1 freezes size, family, meter places only).

## 3. Derived

### 3.0 Shared rules for twinned strings and numbers

* Every number in a twinned string goes through `mm_text` ⇄ `formatMmText`
  (round1, comma, no trailing ",0"). Field numbers are 1-based. Lists join with
  `", "`; field ranges use U+2013 ("Feld 1–2").
* Every millimetre value is `round1`'d on output only; sums are explicit
  left → right loops in both twins (never Python `sum()`); ints stay ints.
* `DERIVE` is a module sentinel in both twins: `fn(..., block=DERIVE)` derives;
  `None` means "there is no block".

### 3.1 Carrier (`control_carrier` ⇄ `controlCarrier`)

Candidates = modules whose served spec has family `meter_ehz`/`meter_3p`, in
`(field, unit, list index)` order (the `_meter_modules` order; TS must not use
`modulesInOrder`, which breaks ties by id). The carrier is the first candidate
whose spec is not `reserve_field`; if every candidate is a reserve field, the
first candidate (finding `encl.control_block_reserve`). No candidate → `None`.
The same carrier is used for the supply ends and the network lead.

### 3.2 Placement (`place_control_block` ⇄ `placeControlBlock`)

`None` when `B = parse_control_block(...)` is `None`, `B.off`, 0 terminals, no
carrier, or no candidate rail. Otherwise:

1. **Candidate rails**: the carrier spec's rails in zones of type `AAR`, not
   retired, `mount: "rail"`, ordered top → bottom by `(zone.unit + rail.unit)`,
   ties by spec order.
2. `devices_mm(rail)` = explicit left → right loop of
   `enclosure_device_width_mm(device, rail)` over **every** device of the rail's
   linked row (an AAR rail is never a terminal rail, so the scene draws
   placeholders there too); `capacity_mm = rail.ple × PLE_MM`.
3. `block_mm` = loop over the parts (6 + 5.2·n + 1 + 6).
4. **Rail**: `B.rail` if it is a candidate; else the first candidate with
   `devices_mm + block_mm ≤ capacity_mm + 0.05`; else the first candidate.
5. **Offset** (right-aligned, never over the devices):
   `offset = max(capacity_mm − block_mm, devices_mm)`;
   `overflow = devices_mm + block_mm > capacity_mm + 0.05`.
6. Parts left → right: `249-116`, one `2002-1671` per terminal (`terminalId`,
   `label`, `color`, `position` 1-based int), `2002-1692`, `249-116`; each with
   `offsetMm` (cumulative, relative to the block) and `widthMm`.

Output (camelCase; mm `round1`, ints stay ints):

```jsonc
{ "moduleId": "mod-a", "railKey": "aar1", "field": 0, "railTitle": "F1 · AAR 1",
  "railX": 45.0, "railY": 100.0, "offsetMm": 165.8, "widthMm": 44.2, "devicesMm": 70.0,
  "capacityMm": 210.0, "overflow": false, "parts": [ … ] }
```

`railTitle = default_rail_label(carrier, aar_zone, position)` (never the row
label); `field = zone_field(carrier, aar_zone)`; `railX` = rail left edge,
`railY` = rail centre line (§3.4).

**Occupancy.** `encl.rail_overflow` is unchanged and counts devices only (its
Python loop becomes an explicit left → right loop like the TS reduce). The
block's own finding is `encl.control_block_overflow`. TS only:
`controlBlockMmOn(doc, index, moduleId, railKey)` = `placeControlBlock(doc,
index)?.widthMm` (unrounded) when moduleId/railKey match, else 0.
`sheetModel` (RailSheet fullness) adds it; `enclosureDropTargets` builds the
post-drop document and adds `controlBlockMmOn(postDropDoc, …)` (the automatic
rail may move the block away). Fix the reference: the function is
`enclosureDropTargets.railUsedMm`, used by `sheetModel`.

### 3.3 Cabinet preparation (`cabinet_prep` ⇄ `cabinetPrep`)

`cabinet_prep(document, catalog, *, block=DERIVE) -> {"items": [...], "runs": [...],
"infeed": {...} | None, "overrides": {...}} | None` (`None` when the cabinet is
unknown). `P = parse_prep(enclosure.get("prep"))`. Items in this fixed order,
each `{key, articleNo, label, qty, unit: "Stk"|"m", reason, verified, group,
override}` (`override` = the matching `P` value or `null`); an item suppressed by
an override `off` is still returned with `qty: 0` and `"suppressed": true` so
the UI can show it struck through; Materialliste drops qty-0 items.

**Busbar zones and roles.** A busbar zone = a zone of type `NAR` or `SAS` with
a rail of `mount: "busbar"`. Its field = `module.field + zone.field`, its span
= `[module.unit + zone.unit, + zone.units)`. Role `main` when: type `NAR`; or
type `SAS` in a module of family `communication`; or type `SAS` whose busbar rail's
linked row holds a device of kind `sls`. Every other SAS is `customer`.
Two busbar zones are **joined** when their fields differ by exactly 1, they
belong to different modules, they have the same role and their spans overlap.
A **run** = a connected component of same-role busbar fields under "joined".

**(a) Spannungsversorgung RfZ/APZ** (group `supply`), O6. Condition: a carrier
exists and the cabinet spec `height_mm` is 1100 (digit `3`) or 1400 (digit `5`);
any other height → no item and the warn finding `encl.supply_height`. Leads
digit `2` if any placed module's served spec has a zone of type `APZ`, else `1`.
Variant by `P.supply`: `auto`/`SA` → `ZY{h}N{l}SA`; `LS` → `ZY{h}N{l}LS`; `SI` →
`ZY{h}R{l}SI`; `off` → suppressed. **Existing tap:** in `auto` only, when the
carrier's NAR rail or any RFZ/APZ rail of the cabinet holds an `mcb` with rating
≤ 10 A (the `_is_small_tap` predicate of the rules), no kit is derived
(suppressed, reason "Spannungsabgriff bereits geplant ({bmk}, {railTitle})") and
the info finding `encl.supply_existing` fires.
Labels: `…N2SA` "Bestückungspaket Spannungsversorgung APZ/RfZ, SABO 1,6 A, Bauhöhe {1100|1400} mm",
`…N1SA` "Bestückungspaket Spannungsversorgung RfZ, SABO 1,6 A, Bauhöhe …",
`…N{l}LS` "… Sammelschienen-LS 6 A …", `…R{l}SI` "… Sicherungsbox 1 A im RfZ …".
Reason: "Spannungsversorgung SMGW/Steuerbox: {SABO 1,6 A|LS 6 A} im NAR von Feld {n}, Leitungen zum {RfZ Feld n|Zählerplatz Feld n}{ und APZ Feld m}"
plus " · VNB muss die SABO zulassen (sonst ZY…LS / ZY…R…SI)" for SA.
`verified`: true, except false when digit `5` and the carrier is `meter_ehz`
(the 2021 Hager sheet names ZY5 only for 3-Punkt).
RfZ end: carrier `meter_ehz` → its first RFZ zone; carrier `meter_3p` → the
first RFZ zone of a non-meter module in the cabinet (ZU37VT4APZ2, ZH33SAR2,
ZH55SAR2, ZY150RFZ), else the carrier's meter place 0.

**(b) Einspeisung** (group `busbar`), O8. Condition: at least one `main`
busbar zone. `infeed = parse_infeed(supply.incoming)` (§3.5). Article:
* `P.infeed == "off"` → suppressed.
* `K96ESA5` when `P.infeed == "K96ESA5"`, or `auto` and (mm² is `None` or ≤ 25)
  and not aluminium. Label "Einspeiseadapter univers Z, 1–25 mm², 5-polig",
  qty = number of `main` runs, verified true; reason "Zuleitung {n} mm² ≤ 25 mm²" /
  "Querschnitt unbekannt — angenommen".
* otherwise clamps (also when `P.infeed == "clamps"`), qty = (cores if 4 or 5
  else 5) × `main` runs, verified false:
  Cu 25 < mm² ≤ 70 → `K96F` "Sammelschienenklemme 25–70 mm² für 12×5 mm";
  ≤ 95 → `K96H` "Sammelschienenklemme 16–95 mm² für 12×5 mm";
  ≤ 150 → `K96K` "Sammelschienenklemme 50–150 mm² für 12×5 mm";
  ≤ 185 → `KS18D` "Sammelschienenklemme 50–185 mm², Al/Cu, für 12×5 mm";
  Al ≤ 50 → `K96N` "Sammelschienenklemme 10–50 mm², Al/Cu"; Al ≤ 185 → `KS18D`;
  mm² unknown with clamps forced → `K96F`; > 185 → no item and the warn finding
  `encl.infeed_size`. Reason "Zuleitung {n} mm²{ Al} > 25 mm²: eine Klemme je Leiter" /
  "Zuleitung Al, Querschnitt unbekannt: eine Klemme je Leiter".
* Each extra `main` run adds " · Feld {b}: eigene Einspeisung" to the reason.
* `infeed` = `{"mm2", "cores", "aluminium", "article", "assumed"}` (for the Daten hint).

**(b2) PEN-Aufteilung** (group `busbar`): when `supply.system == "TN-C-S"` and
parsed `cores == 4`: `prep:pen_split` "PEN-Aufteilung im NAR (z. B. Hager N75B / ZM35PE)",
qty 1, verified false, mapping only; plus the info finding `encl.pen_split`.

**(c) Sammelschienenverbinder** (group `busbar`), O7. qty = number of joined
field pairs (`main` and `customer` alike, each pair once); `P.joints == "off"`
→ suppressed. `ZZ55SAVE` "Sammelschienenverbinder Feld/Feld, 5-polig, 12×5 mm, 250 A",
reason "1 Feldübergang: Feld 1–2" / "{k} Feldübergänge: Feld 1–2, Feld 2–3",
verified true.

**(d) Netzwerkleitung** (group `network`), O5. Condition: a carrier, an APZ
zone (the first by field, unit) and a target: carrier `meter_ehz` → its first
RFZ zone with a rail; `meter_3p` → its ZF meter place 0. `P.network == "off"` →
suppressed. Lead:
1. `P.network_m` set → the first `NETWORK_LEADS` entry with length ≥ `network_m·1000`.
2. else **Hager table** (Bestellhilfe 20DE0173), when the case is covered: key =
   (carrier family, cabinet `height_mm`, APZ position = "top" if the APZ zone's
   absolute start unit < `units_per_field / 2` else "bottom", intermediate
   fields = |APZ field − carrier field| − 1 ∈ 0..3):
   * eHZ 1100 bottom: WAN100, WAN100, WAN150, WAN200; top: WAN040, WAN100, WAN100, WAN150
   * 3-Punkt 1100 bottom: WAN100, WAN100, WAN150, WAN200; top: WAN100, WAN150, WAN150, WAN200
   * 3-Punkt 1400 bottom: WAN100, WAN150, WAN200, WAN200; top: WAN100, WAN150, WAN150, WAN200
   verified true; reason "… · Länge nach Hager-Bestelltabelle".
3. else geometry: required = run `lengthMm` + (`NETWORK_RESERVE_MM` for 3-Punkt,
   0 for eHZ); the first entry ≥ required, else `ZZ45WAN500` + " · länger als 5 m";
   verified false; reason "… · ≈ {x} m gemessen".
Label "Patch-Leitung RJ45 Cat 5e, spannungsfest, {mm_text(len/1000)} m"; reason
starts "APZ (Feld {a}) → RfZ über dem Zähler (Feld {b})" / "APZ (Feld {a}) → Zählerplatz (Feld {b})".
Every table cell is pinned by a Python test.

**(e) §14a-Klemmleiste** (group `control`), O2–O4. Condition: placement not
`None`. Items: `part:249-116` × 2, `part:2002-1671` × n, `part:2002-1692` × 1
(labels from `CONTROL_PARTS`, reason "§14a-Steuersignal-Klemmleiste, Feld {n} · {railTitle}",
verified true); then, **only with a control target** (§3.4), one wire item per
colour in first-use order, key `wire:h07vk:{"2.5"|"1.5"}:{colour}`, label
"Aderleitung H07V-K 1 × {mm_text(mm2)} mm² {colour}", unit `m`, verified false,
reason "{labels} · Klemmleiste → {RfZ|APZ} · ≈ {x} m je Ader" (labels = the
non-blank labels of that colour, else "Klemme {position}", joined ", ");
then `prep:luesterklemme` × 1, label "Lüsterklemme {n}-polig (von 12-poliger Leiste)",
reason "Gegenstück am {RfZ|APZ} Feld {m}", verified false.
**Wire metres** in integer decimetres, per wire: if `wire_length_m` is set,
`dm = round_half_up(wire_length_m × 10)`; else `len_dm = ceil(lengthMm / 100)`
(lengthMm = the control run's rounded length) and
`dm = ceil((len_dm + WIRE_RESERVE_DM) / 5) × 5` (0,5 m steps). Planned per colour =
`ceil(dm × count / 10)` in integer arithmetic (`(dm·count + 9) // 10`);
"≈ {x} m" shows `mm_text(dm / 10)`.

### 3.4 Points, runs and lengths

Scene millimetres (geometry conventions: origin top-left of the back face, y
down). For module `m`, zone `z`, rail `r`:
`zone_x = margin + (m.field + z.field)·field_width`,
`zone_y = margin + (m.unit + z.unit)·unit_mm`,
`rail_left = zone_x + (field_width − r.ple·PLE_MM)/2`,
`rail_y = zone_y + r.unit·unit_mm + unit_mm/2`,
rail centre = `(rail_left + r.ple·PLE_MM/2, rail_y)`.
Meter place `k` of a ZF zone with `p` places, `zone_h = z.units·unit_mm`:
stacked (3-Punkt) `(zone_x + field_width/2, zone_y + k·cell + cell/2)` with
`cell = zone_h/p`; side by side (eHZ) `(zone_x + k·cell + cell/2, zone_y + zone_h/2)`
with `cell = field_width/p` — the expression order of `_meter_boxes`.

* Block point = `(railX + offsetMm + widthMm/2, railY)` (unrounded inputs).
* Control target: carrier `meter_ehz` → its first RFZ zone's first rail centre;
  `meter_3p` → the first APZ zone in the cabinet (by field, unit), first rail centre.
* SABO point = the carrier's first NAR busbar rail: `(rail_left + 30, rail_y)`.
  Supply ends: the RfZ end of §3.3 (a) and the APZ (if any). No NAR busbar → no
  supply runs (the item stays).
* A run = `{"kind": "supply"|"network"|"control", "from": [x,y], "to": [x,y],
  "points": [...], "label": str, "lengthMm": float}`: points from round1'd
  endpoints, vertical first then horizontal, consecutive equal points dropped
  (a straight run has 2 points); `lengthMm = round1(|x1−x0| + |y1−y0|)` from the
  **unrounded** endpoints; everything downstream uses that rounded value.
* Run order: supply (RfZ end, then APZ), network, control. Labels:
  "{ZY…} · SABO 1,6 A → {RfZ|Zählerplatz|APZ}" (LS/SI variants name their device),
  "{ZZ45WAN…} · RJ45", "{n} × H07V-K {mm_text(mm2)} mm²".

### 3.5 Parsers (`parse_infeed` ⇄ `parseInfeed`, `parse_fuse_amps` ⇄ `parseFuseAmps`)

Normalise: `s = text.lower()` (TS `toLowerCase()`); replace `²`→`2`, `×` and
`*`→`x`, `,`→`.`, `qmm`→`mm`; map U+0009–U+000D, U+00A0, U+1680, U+2000–U+200A,
U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF to U+0020. Python compiles with
`re.ASCII`; TS uses no `u` flag; patterns use `" *"`, never `\s`:

```text
PAIR = (?<![0-9.])([0-9]) *[xg] *([0-9]+(?:\.[0-9]+)?)(?![0-9]|\.[0-9])(?! *a\b)
EXTRA = ^ *[/+] *[0-9]          # applied right after the chosen pair: cores += 1 (clamped to 5)
MM   = (?<![0-9.])([0-9]+(?:\.[0-9]+)?) *mm
FUSE = (?<![0-9.])([0-9]+) *a(?:mpere)?\b
ALU  = \bna[a-z0-9]*y|\bna2x|\balu?(?:minium)?\b
```

Built (2026-10-26): the PAIR lookahead is `(?![0-9]|\.[0-9])`, not `(?![0-9.])` — the
normalised comma of "NYY-J 5x16, 3x63A" is a "." and must not hide the pair; TS has no
lookbehind (Safari < 16.4) and applies `(?<![0-9.])` by hand (`afterNoNumber`).
PAIR matches left → right; drop pairs with mm² outside [1.5, 300]; take the
**first** pair with the largest mm²; cores = int if 2 ≤ cores ≤ 5 else `None`;
then `EXTRA` on the text after that pair. No pair → the first MM match within
[1.5, 300] (cores `None`). `parse_fuse_amps` = max int over FUSE matches, else `None`.
Output `{"mm2": float|None, "cores": int|None, "aluminium": bool}`.
The shared fixture table `infeed_parse` pins at least: "NYY-J 5x16 mm²",
"NYY-J 5×35mm²", "5G25", "4x35+16", "NYCWY 3x35/16", "NAYY-J 4x50", "NA2XY 4x150",
"35 mm2", "35 qmm", "NYY-J 5x16, 3x63A", "NYY-J 5x16 mm²" with U+00A0,
"1x500+5x35", "", "Hausanschluss", "NYM-J 5x2,5"; `fuse_parse`: "NH 63 A", "3x63A",
"125 Ampere", "", "NH00 100A".

## 4. Findings (twins)

`RULE_ORDER` gains, after `encl.meter_place_invalid` and before the terminal
rules: `encl.control_block_missing`, `encl.control_block_reserve`,
`encl.control_block_rail`, `encl.control_block_overflow`, `encl.control_block_target`,
`encl.control_block_bdew`, `encl.control_tube`, `encl.busbar_unjoined`,
`encl.busbar_role`, `encl.supply_height`, `encl.supply_existing`,
`encl.infeed_assumed`, `encl.infeed_fuse`, `encl.infeed_size`, `encl.pen_split`.
Let `B = parse_control_block(...)`, `C = control_carrier(...)`, `L = placement`.
Scope `""` = board level (as every board-level rule today).

| rule | level | scope | condition | text |
|---|---|---|---|---|
| control_block_missing | info | "" | C and B is None | **Zählerschrank ohne §14a-Steuersignal-Klemmleiste: im ersten Zählerfeld anlegen.** (action **§14a-Klemmleiste anlegen**, only when not read-only) |
| control_block_reserve | info | C.id | B, not off, C is a reserve field | **§14a-Klemmleiste sitzt auf einem Reserve-Zählerfeld (Feld {n}).** |
| control_block_rail | warn | C.id | B, not off, ≥1 terminal, C, no candidate rail | **§14a-Klemmleiste: Feld {n} hat keine AAR-Hutschiene.** |
| control_block_overflow | warn | C.id | L and L.overflow | **§14a-Klemmleiste passt nicht auf {railTitle}: {mm_text(devices+block)} mm von {mm_text(cap)} mm.** |
| control_block_target | warn | C.id | L and no control target | 3-Punkt: **§14a-Steuerleitungen ohne Ziel: im Schrank fehlt ein APZ.** eHZ: **§14a-Steuerleitungen ohne Ziel: Feld {n} hat keinen RfZ.** |
| control_block_bdew | info | C.id | L and terminal count ≠ 6 | **§14a-Klemmleiste mit {n} statt 6 Klemmen — BDEW/VDE-AR-N 4100 sieht 6 vor.** |
| control_tube | warn | C.id | L, label_material 211-501, wire_mm2 > 1 | **Schrumpfschlauch 211-501 passt nur auf 0,75–1 mm² — Leitung ist {mm_text(mm2)} mm².** |
| busbar_unjoined | warn | "" | per role, consecutive busbar fields a < b of that role with b > a+1: **Sammelschienen in Feld {a} und Feld {b} sind nicht verbunden: dazwischen liegt kein Feld mit Sammelschiene.** Adjacent same-role, different modules, spans do not overlap: **Sammelschienen in Feld {a} und Feld {b} liegen nicht auf gleicher Höhe.** A field pair whose zones belong to one module is neither. |
| busbar_role | info | customer module id | adjacent main/customer busbar zones (different modules, overlapping spans) | **Sammelschiene in Feld {b} ist Kundenverteilung (gezählt) und wird nicht mit dem NAR von Feld {a} verbunden.** |
| supply_height | warn | "" | carrier, cabinet height not 1100/1400 | **Spannungsversorgung RfZ/APZ: Schrankhöhe {h} mm nicht im Hager-Programm — Bestückungspaket selbst wählen.** |
| supply_existing | info | "" | (a) suppressed by an existing tap | **Spannungsabgriff bereits geplant ({bmk}, {railTitle}) — Bestückungspaket nicht ergänzt; Leitungen zu RfZ/APZ prüfen.** |
| infeed_assumed | info | "" | item (b) exists, K96ESA5 via `auto`, mm² unknown | **Querschnitt der Zuleitung unbekannt: Einspeiseadapter K96ESA5 (bis 25 mm²) angenommen. Im Tab Daten bei „Zuleitung“ eintragen.** |
| infeed_fuse | warn | "" | item (b) is K96ESA5 and `parse_fuse_amps(supply.fuse) > 100` | **Einspeiseadapter K96ESA5 nur hinter höchstens NH00 gG 100 A: Vorsicherung „{fuse}“ prüfen.** |
| infeed_size | warn | "" | parsed mm² > 185 | **Zuleitung {n} mm²: keine Sammelschienenklemme für 12×5 mm bis 185 mm² — Einspeisung gesondert planen.** |
| pen_split | info | "" | TN-C-S and cores == 4 | **Zuleitung 4-adrig im TN-C-S-System: PEN im NAR von Feld {n} in PE und N aufteilen.** |

`enclosure_findings` / `enclosureFindings` gain `block=DERIVE`.
The findings footer line "Nicht automatisch geprüft: …" becomes **Nicht
automatisch geprüft: Zulassung der SABO durch den Netzbetreiber · RJ45-Dose im RfZ ·
Einführung des Hauptkabels nicht von oben · Montagehöhe und Arbeitsraum · TAB des
Netzbetreibers.** (update PANEL_ENCLOSURE.md §5 and its test).

## 5. Geometry

* New box kind `control_block`, id `control:block`, open view only, on the
  carrier rail: `x = railX + offsetMm`, `y = railY − _STRIP_H/2`, `z = _STRIP_Z`,
  `w = widthMm`, `h = _STRIP_H`, `d = _STRIP_D`, `label = "§14a"`, `module`,
  `rail`, `row`, `zone: "AAR"`, flags `["overflow"]` when overflowing. TS
  `SceneBoxKind` gains it; 3D `COLOURS.control_block = 0xb9c0c8`.
* `build_enclosure_scene(..., block=DERIVE)`.
* Runs are not boxes. The 2D SVG (open view) and the Aufbau PDF draw
  `prep.runs`: supply thin dashed ink (2/2), network dashed `#0f8b8d` (4/3),
  control dashed `#7547c9` (6/4); a small label at the midpoint of the longest
  segment. Closed view and 3D draw no runs. Built (2026-10-26): the Aufbau PDF turns the
  label 90° on a vertical segment and moves it along the run (stops 0,5 · 0,3 · 0,7 ·
  0,15 · 0,85, longest segment first) until it covers no box label and no other run
  label — at the midpoint it hid the meter number and the SLS's BMK. The 2D SVG keeps
  the midpoint (it zooms).
* `panel_enclosure_control_block.py` takes `round1` from
  `panel_enclosure_terminals` and never imports `panel_enclosure_geometry`
  (geometry imports it).

## 6. Materialliste (`panel_enclosure_prep_material.py`, cabinet boards only)

* `planned_lines` (cabinet branch) appends the prep lines after the accessory
  lines and before the device lines, in `cabinet_prep` item order; qty-0
  (suppressed) items produce no line. Legacy output byte-identical (goldens).
* Keys: `accessory:<art>` (Hager), `part:<art>` (WAGO block parts),
  `wire:h07vk:<2.5|1.5>:<colour>`, `prep:luesterklemme`, `prep:pen_split`.
  `detail = reason + (" · Meter" if unit m) + (" · ungeprüft" if not verified)`.
* A derived Hager item whose article an admin accessory also lists is emitted
  **once, at the admin line's slot** (planned = max; derived label and detail
  when derived > 0) and omitted from the prep block (the `u84t_line` pattern).
* `line_article_numbers`: every `accessory:`/`part:` key → its article number;
  `wire:`/`prep:` keys → none (mapping only).
* `MAPPABLE_PREFIXES` gains `wire:` and `prep:` (`reports:create`; the 400 text
  lists them).
* `apps/api/scripts/report_prep_impact.py` (read-only, counts only — the output
  goes into deploy notes and the repo is public): cabinet boards; per derived
  article the number of boards gaining it; of those, boards with booked
  consumption; `PanelMaterialManualLine` rows naming one of these article numbers
  and their board count; boards with a carrier but no `control_block`; override or
  custom catalogue rows for ZH3ES5/ZH3ES5RK/ZH53XS/ZH53XSRK (R4-9 does not reach them).

## 7. Catalogue correction (R4-9, R4-12)

* `_with_busbars`: zones `[VT at unit 0 (rows), SAS at unit rows (2 units)]`; the
  unverified note becomes "Sammelschienenzone unten laut Hager-Produktfoto".
* `reserve_field: true` on ZH33XL, ZH53XL, ZH52XL.
* Docs: `PANEL_ENCLOSURE.md` §3.2 rows + the paragraph and Q2 that say ZZ55SAVE
  is not auto-added; a pointer in `PANEL_ENCLOSURE_R2.md` R7 to R4-3.

## 8. UI (web)

### 8.1 Module search — `ModulePickerSheet.tsx`, new `modulePickerSearch.ts`

* Toolbar slot of `SheetFrame` (new optional `toolbar` prop, non-scrolling,
  between head and body): `<label>` **Modul suchen** + `input type="search"`
  (flex 1, min-height 56 px, font-size 16 px, `appearance: none`,
  `::-webkit-search-cancel-button { display: none }`), placeholder **Code,
  Bezeichnung oder Artikelnummer**, `autoComplete="off" autoCorrect="off"
  autoCapitalize="none" spellCheck={false} enterKeyHint="search"`, no autoFocus,
  no `<form>`; Enter → `preventDefault()` + blur. A 56 × 56 px button **×**
  (aria-label **Suche löschen**) shows while the query is non-empty, clears it and
  refocuses the input. A `role="status"` element is always mounted: **{n} Treffer**
  (n ≥ 1), **Kein Treffer** (n = 0), empty without a query.
* Matching via `utils/searchNormalize.ts` (`buildSearchTokens`,
  `buildSearchHaystack`, `haystackMatchesTokens`): text = name, family label,
  stock article name, the spec's zone type names (NAR, AAR, RfZ, APZ, SAS, VF);
  identifiers = code, article_no, stock article number, internal code, name.
* `pickerModel` stays memoised on its inputs and keeps hidden-height entries;
  filtering is a second memo over `useDeferredValue(query)`. Sections and
  in-section order unchanged; empty sections dropped; "Im Lager, nicht im Katalog"
  filtered on item_name, article_number, code_guess. n counts every visible item
  (refused ones included; hidden heights not).
* Empty: **Kein Modul gefunden für „{q}“.** + 56 px **Suche löschen**. Hidden
  heights while searching: **1 passendes Modul für {h}-mm-Felder ausgeblendet** /
  **{k} passende Module für {h}-mm-Felder ausgeblendet** (omitted when 0).
* The query lives in the stack entry (`query?: string` on `module-picker`,
  controlled with a local fallback like the switches).
* Keep the heading assertion `["Im Lager","Zuletzt verwendet","Hager univers Z"]`.

### 8.2 §14a sheet — `ControlBlockSheet.tsx` (+ `controlBlockLayout.ts`, `ControlBlockSvg.tsx`)

Stack kind `{ kind: "control-block" }` (not removed with the carrier).
States, in order:
1. No carrier → title **§14a-Klemmleiste**, text **Kein Zählerfeld im Schrank — die §14a-Klemmleiste sitzt im ersten Zählerfeld von links.**
2. Block absent → **Noch keine §14a-Klemmleiste.** + 56 px **§14a-Klemmleiste anlegen**; read-only: **Keine §14a-Klemmleiste geplant.**
3. `off` → **§14a-Klemmleiste entfernt — sie steht nicht auf der Materialliste.** + **§14a-Klemmleiste wieder anlegen** (hidden when read-only).
4. Present → title **§14a-Klemmleiste · Feld {n}**, subtitle **Steuersignal-Klemmleiste (BDEW / VDE-AR-N 4100)**:
   * Drawing in `.sp-term-scroll` (flex none), 5 px/mm: 249-116 | n × 2002-1671 with the marker text at the print size (`controlStripSize`), rotated to read **bottom → top** | 2002-1692 | 249-116; a 6 mm wire stub in `WIRE_COLOUR_STYLE` under each terminal; `role="img"`, aria-label **§14a-Klemmleiste: {labels joined ", "}**.
   * Rows: grid `32px 1fr minmax(8rem,10rem) auto`, wrapping to two lines below 480 px; position number; text input (min-height 56 px, 16 px, maxLength 12, aria **Bezeichnung Klemme {i}**); colour select (aria **Aderfarbe Klemme {i}**, options "Braun" … "Rosa"); button **Entfernen** (aria **Klemme {i} „{label}“ entfernen**), disabled at 1 terminal with the visible text **Mindestens eine Klemme bleibt — sonst die ganze §14a-Klemmleiste entfernen.** When `controlLabelFits(label)` is false: `<small>` (aria-describedby) **Zu lang für die senkrechte Beschriftung — kürzer schreiben.**
   * **+ Klemme** (disabled at 12 with **Höchstens 12 Klemmen.**); **Standard wiederherstellen** via ConfirmStrip **Bezeichnungen und Farben auf die sechs Standardklemmen zurücksetzen?**
   * Selects: **Hutschiene** (**Automatisch** / each candidate's railTitle); **Leitung** (**1,5 mm²** / **2,5 mm²**); **Schrumpfschlauch** (**WAGO 211-502 (Ø 4,8 · 1–2,5 mm²)** / **WAGO 211-501 (Ø 3,2 · 0,75–1 mm²)**), with the hint **211-501 passt nur auf 0,75–1 mm² — für {mm2} mm² 211-502 wählen.** when applicable.
   * **Länge je Ader**: `type="text" inputMode="decimal"`, 56 px, value shown with a comma, placeholder **≈ {x} m aus der Zeichnung**; parse on blur/Enter ("," or "."); [0,5; 20] → stored (rule 8); emptied → `null`; else keep the stored value and show **Länge 0,5 bis 20 m — leer lassen für die Länge aus der Zeichnung.**
   * Facts (read-only): **Ziel: RfZ über dem Zähler (Feld {n})** / **Ziel: APZ (Feld {n})** / **Ziel fehlt**; **Gegenstück: Lüsterklemme {n}-polig**; **Versorgung der Klemmleiste: aus dem gemessenen Bereich (nicht automatisch geplant)**; **Aderbeschriftung: WAGO {211-501|211-502}, jede Bezeichnung zweimal**; **2002-1671: 0,25–4 mm²; manche Netzbetreiber verlangen 0,14–1,5 mm² — TAB prüfen.**
   * Footer: 56 px **Aderbeschriftung drucken** (enabled on read-only boards too): closes the stack, then opens the page's label dialog in mode `adern`; **§14a-Klemmleiste entfernen** via ConfirmStrip **§14a-Klemmleiste und ihre Materialzeilen entfernen?** → `off: true`.
* Read-only: every editing control disabled.
* Entry points: in `EnclosureFieldBar`, the carrier's group gets a 56 px button **§14a-Klemmen** in states 2–4 (read-only too), second line / aria suffix **{n} Klemmen** / **fehlt** / **entfernt** / **passt nicht**; a tap on the `control_block` box (hit layer paints it last, kind `"control"`, `role="button"`, aria **§14a-Klemmleiste, Feld {n}, {k} Klemmen**; no hit in the closed view); the finding action.

### 8.3 Ops — `utils/enclosureOpsControlBlock.ts` (pure, deep-freeze tested)

`addControlBlock`, `removeControlBlock` (→ off), `restoreControlBlock`,
`resetControlBlock`, `addControlTerminal`, `removeControlTerminal(id)`,
`renameControlTerminal(id, label)` (edit; clamp 12 code points),
`setControlTerminalColour(id, colour)`, `setControlBlockRail(rail | null)`,
`setControlWire(mm2)`, `setControlWireLength(m | null)`,
`setControlLabelMaterial(id)`, `setPrepOverride(key, value)`. `placeModule`
seeds `defaultControlBlock()` when it places a meter-family module and
`control_block` is absent (never when present or off). New terminals get the
smallest free `t<n>` id and the default colour of their position. Refusal copy
exported as constants.

### 8.4 "Automatisch ergänzt" — new `EnclosurePrepList.tsx`

Under the findings: `<ul aria-label="Automatisch ergänzt">` with heading
**Automatisch ergänzt**; per item a 56 px `<li>`: **{qty} × {articleNo} {label}**
(articleNo bold, omitted when null; unit m: **{qty} m {label}**), reason in
`<small>`, `UnverifiedBadge` (new `title` prop: **Aus der Zeichnung abgeleitet —
vor dem Einbau prüfen**) when not verified; text column `min-width: 0;
overflow-wrap: anywhere`. Items with an override select (supply, infeed,
joints, network) get a compact 56 px select: supply **Automatisch · SABO · LS 6 A ·
Sicherungsbox · Nicht ergänzen**; infeed **Automatisch · K96ESA5 · Sammelschienenklemmen ·
Nicht ergänzen**; joints/network **Automatisch · Nicht ergänzen**; network also
**Länge** (text decimal, same rule as 8.2). A suppressed item shows struck
through with **manuell abgewählt** and a 56 px **Wieder automatisch**. Hidden when
there are no items.

### 8.5 Daten tab

`PanelDataTab` gains `infeedHint: string | null`, computed by the page from
`cabinetPrep(...).infeed` (null while the catalogue loads, without a cabinet,
or without a `main` busbar zone). Rendered inside the Zuleitung `<label>` as
`<small className="sp-field-hint">` (aria-describedby, no live region):
**Querschnitt erkannt: {mm} mm²{ Al} → Einspeiseadapter K96ESA5** /
**Querschnitt erkannt: {mm} mm²{ Al} → {k} × Sammelschienenklemme {art}** /
**Kein Querschnitt erkannt → Einspeiseadapter K96ESA5 angenommen**, plus
** · Vorsicherung über 100 A prüfen** under the `infeed_fuse` condition.

## 9. Printing

**First, behaviour-preserving extractions** (file caps; built: also `services/werkstatt_label_frame.py`,
the frame helpers, so the strips module never imports `werkstatt_labels` at load time; web twins of
§9.1/§9.2 in `utils/schaltplanControlStrip.ts` and `components/schaltplan/LabelPrintDialogWires.tsx`): `services/werkstatt_label_strips.py`
(`_render_rail_strip`, `_render_block_label`, `print_marking_strips`, strip
constants; `werkstatt_labels` re-exports them) and `routers/workflow_schaltplan_labels.py`
(`_PrintPlan`, `_bmk_print_plan`, `_terminal_print_plan`, `print_panel_labels`
and the new plans; the router module's net line change ≤ 0). Adapt to what the
merged calibration branch already split. Every new rendering module is appended
to the AST guard's `RENDERING_MODULES`; `label_jobs_300dpi.json` gains keys,
existing keys stay byte-identical.

### 9.1 Block strip (vertical text) — `services/werkstatt_label_control_strip.py` ⇄ `utils/schaltplanStrip.ts`

* Predicate `control_strip(document)` ⇄ `controlStrip(document)`: exists iff
  the parsed block is not None, not off, ≥ 1 terminal (no catalogue needed).
  Strip id `control:block`; always the **last** item of the Klemmen dialog list,
  of "Alle" and of `strip_ids: null`. `derived`/`boardStrips` include it; the 400
  "Keine Reihenklemmen" fires only when neither groups nor the block exist; 409
  when `control:block` is sent but not derived: **Die §14a-Klemmleiste wurde
  geändert oder entfernt — nichts gedruckt. Bitte die Seite neu laden und erneut drucken.**
* Material `wago-2009-110`; segments of 5.2 mm per terminal; the existing 3 mm
  lead, cut marks and end marks; a blank label prints an empty segment (counts
  in `skipped_without_bmk`).
* Size `control_strip_size(labels)` ⇄ `controlStripSize`: `budget = 11 ×
  PHYSICAL_DOTS_PER_MM − 2 × STRIP_SEG_PAD_DOTS` (float); per non-blank label
  `fit = budget / text_width_em(label)` (em summed left → right);
  `size = min(floor(min fit), 48, mm_to_dots(5.2) − 2·_STRIP_TEXT_GUARD)`;
  all blank → 48. The default block is pinned in fixture table
  `control_strip_size` (expected 35). `control_label_fits(label)` ⇄
  `controlLabelFits` = `floor(budget / em) ≥ 24`; a non-fitting label is **never
  printed**: the dialog disables the item with **„{label}“ ist zu lang für die
  Klemme — in der §14a-Klemmleiste kürzen.**, the server answers 400 with the same text.
* Geometry in the reading frame (never as an EZPL anchor): per terminal i,
  `cx = mm_to_dots(3 + 5.2·i + 2.6)` (mm summed first); `w = size ×
  text_width_em(label)`; the advance runs from `y0 = round_half_up(h_px/2 + w/2)`
  to `y0 − w` with `h_px = mm_to_dots(11)`; the em box spans reading x
  `[cx − size·(CAP_TOP_RATIO + CAP_HEIGHT_RATIO/2), + size]`.
* `VERTICAL_ROTATION = "0"` (hypothesis: bottom → top is a machine advance of
  +x given the validated `x_machine = h − y_reading`); `VERTICAL_ANCHORS =
  {"0": (xm(y0), ym(em_left)), "2": (xm(y0 − w), ym(em_left + size))}`. Test print
  **T-V1** picks the digit; only the constant changes.
* The bounds check (`_anchor_extent`) reads the AT rotation field: "1" → x ∈
  [x − size, x], y = y; "0" → x ∈ [x, x + ceil(w)], y ∈ [y, y + size]; "2" → x ∈
  [x − ceil(w), x], y ∈ [y − size, y]. `dry_render_samples` adds the default
  block for `wago-2009-110`; golden key `control_strip_default`.
* Dialog: row **§14a-Klemmleiste (senkrecht beschriftet)**, meta **{n} Klemmen ·
  senkrecht · {len} mm**, summary suffix ** · §14a: {x} mm**, preview at 5 px/mm,
  hint **Schrift liest von unten nach oben — so einsetzen, dass „{first label}“ links steht.**

### 9.2 Aderbeschriftung — target `adern`

* `wire_label_segments(document)` ⇄ `wireLabelSegments(document)`: per terminal
  left → right with a non-blank label, `(label, WIRE_LABEL_PIECE_MM)` **twice**.
  None → 400 **Keine Aderbeschriftung — erst Klemmen benennen.**
* Job: `_render_rail_strip(material, segments, size=size)` unchanged (lead,
  dividers, end lines as today), material = the block's `label_material`,
  `size = min(font_size_for_fits(segments, material.width_mm, pad_dots=STRIP_SEG_PAD_DOTS)[0], WIRE_LABEL_MAX_DOTS)`.
  `strip_ids` ignored; `payload.material_id` ignored. Response `strips =
  [PanelStripOut(row_id="control:wires", row_label="Aderbeschriftung",
  length_mm=2n·15, part_count=2n)]`. Never `copies`.
* Web: `LabelPrintMode` gains `"adern"`: title **Aderbeschriftung drucken**, one
  material chip (the board's tube), hint **Schrumpfschlauch WAGO {211-502 (Ø 4,8 mm)|211-501 (Ø 3,2 mm)} einlegen — nicht den 11-mm-Streifen.**,
  no strip list, summary **{n} Adern · {2n} Hülsen · {mm} mm Schlauch · Schriftgröße: {x} mm**;
  `useLabelPrinting` (`components/schaltplan/useLabelPrinting.ts`) sends
  `{target: "adern", stripIds: ["control:wires"], materialId}` and reports
  **{2n} Aderetiketten gedruckt**. Entry: the §14a sheet footer and a button next
  to "Klemmen-Etiketten drucken" on the Klemmen tab when a block exists.

### 9.3 Material `wago-211-502`

`MaterialProfile(id="wago-211-502", name="Schrumpfschlauch Ø 4,8 (weiß, Endlos)",
part_no="WAGO 211-502", width_mm=7.5, length_mm=None, builtin=True,
sensor_mode="see_through", sensor_scale=<centre>, guide="fit",
feed_path="external", web=MediaWeb(liner_width_mm=7.5, source="estimate"))`
(adapt field names to the merged calibration code), after 211-501. **Not** in
`LEGACY_V1_BUILTIN_VALUES` (missing builtins heal from code). Hints as for 211-501
plus "Breite flach ≈ 7,5 mm: berechnet (π · 4,8 / 2), nicht gemessen";
`AUTOSENSE_COST_HINT`: "Menge unbekannt – für Endlosschlauch nennt keine Quelle eine
Grenze". `TUBE_MATERIAL_IDS` replaces the single tube id wherever it drives the
tube pattern or the word "Schlauch". Setup row `^G1, ^XSET,SENSING,1, ^Q15,0, ^W8`.
Tests: a v1 and a v2 settings blob without the id both heal it; dry samples cover it.

### 9.4 Aufbau PDF page — `panel_enclosure_pdf_control.py`

One page when the placement exists, after the carrier field's terminal page
(else after page 1). Title **§14a-Klemmleiste · Feld {n} · {VT} {name}**, the R2
furniture **Maßstab 1:1 (Breite) — zum Anlegen an die Hutschiene** and
**Kontrollmaß 100 mm**. The block drawn 1:1 across: each 2002-1671 with its
marker rotated reading bottom → top (6 → 5 pt, fitLabel, ellipsis) and a 6 mm
wire stub. Table: Klemme · Bezeichnung · Aderfarbe · Ziel ({RfZ|APZ} Feld n) ·
Lüsterklemme Pol {i}. Footer **Aderbeschriftung: WAGO {…}, jede Bezeichnung
zweimal**. The open-view drawing page also draws the runs (§5). Update the
round-2 page-count tests.

## 10. Fixture (`scripts/write_enclosure_fixtures.py`)

* `board_answers` gains `control_block` (placement or null) and `prep`
  (`cabinet_prep`); `findings` include the new rules; `scene_open` the new box.
* Top-level tables: `control_block_parse`, `prep_parse`, `infeed_parse`,
  `fuse_parse`, `control_strip_size`.
* `document()` gains a `supply=` parameter. `CATALOG_CODES` gains every code the
  new boards use (incl. ZH3ES5, ZU59VT7APZ2, ZH33XL).
* New boards: `control_ehz_zb33s` (ZH3EH16 + ZH3EL27 side by side + ZU37VT5APZ2;
  block seeded; one ZZ55SAVE joint; ZY3N2SA; network to RfZ via the Hager table),
  `control_3p_zb53s` (ZH53X9ST + ZH53XS customer busbar next to it (→
  `busbar_role`, no joint) + ZU59VT7APZ2; renamed and removed terminals, one colour
  twice, `wire_length_m` set, tube 211-501 with 2,5 mm² (→ `control_tube`); infeed
  "NYY-J 5x50 mm²" → K96F × 5), `busbar_gap_zb34s` (meter fields 1 and 3 with a
  Verteilerfeld between → `busbar_unjoined`, K96ESA5 × 2 runs; infeed "" →
  `infeed_assumed`; fuse "NH 125 A" → `infeed_fuse`; block absent →
  `control_block_missing`; `prep: {supply: "LS", network: "off"}`), `reserve_zb33s`
  (ZH33XL left of ZH33X7: carrier = ZH33X7; a TN-C-S "NYY-J 4x35" infeed →
  `pen_split`, K96F × 4).
* **Existing boards change deliberately:** `control_block: null`; new `prep`;
  findings gain `control_block_missing` on the boards with a meter module and
  `busbar_unjoined`/`busbar_role` where they apply; scene, placement and catalogue
  change for ZH53XS/ZH53XSRK/ZH3ES5 (R4-9). List every changed board in the
  build report.

## 11. Slices and file ownership

| Slice | Owns (creates/edits) | Needs |
|---|---|---|
| CAL | the calibration merge | — |
| A1 Py core | `schemas/panel_enclosure.py` (control_block, prep, reserve_field), new `panel_enclosure_control_block.py`, new `panel_enclosure_prep.py`, new `panel_enclosure_prep_rules.py`, `panel_enclosure_rules.py` (RULE_ORDER, hook, rail_overflow loop), `panel_enclosure_geometry.py`, `panel_enclosure_catalog_data.py`, `scripts/enclosure_fixture_boards.py`, `scripts/write_enclosure_fixtures.py`, the regenerated fixture JSON, Python tests (new files: `test_panel_enclosure_control_block.py`, `test_panel_enclosure_cabinet_prep.py`, `test_panel_enclosure_prep_rules.py`; **`tests/test_panel_enclosure_prep.py` is Slice P's and is not touched**), docs `PANEL_ENCLOSURE.md` §3.2/Q2/§5 footer + R2 R7 pointer | CAL |
| A2 Search | `ModulePickerSheet.tsx`, new `modulePickerSearch.ts`, `useSheetStack.ts` (module-picker `query` only), `EnclosureSheetHost.tsx` (module-picker case only), `EnclosureSheetFrame.tsx` (toolbar slot), `schaltplan-enclosure-sheets.css` (search rules), tests | CAL |
| A3 Schematic (distribution + Übersicht) | per `SCHALTPLAN_STROMLAUF.md` §4–§5 except the cabinet sheet; **not** `routers/workflow_schaltplan.py`; creates `tests/pdf_recorder.py` (a copy of `_Recorder`) | CAL |
| B1 Material + Aufbau PDF | new `panel_enclosure_prep_material.py`, `schaltplan_material.py` (hook only), `routers/workflow_schaltplan_material.py` (prefixes), `panel_enclosure_material.py` (accessory merge), `panel_enclosure_pdf*.py` + new `panel_enclosure_pdf_control.py`, `scripts/report_prep_impact.py`, tests (`test_panel_enclosure_prep_material.py`, `test_report_prep_impact.py`) | A1 |
| B2 TS twins | `types/panelEnclosure.ts`, `types/schaltplan.ts` (if needed), new `utils/enclosureControlBlock.ts`, new `utils/enclosurePrep.ts`, `utils/enclosureRules.ts` (+ new `enclosurePrepRules.ts` if it nears 800), `utils/enclosureGeometry.ts`, `utils/enclosureCatalog.ts`, `components/schaltplan/enclosure/sheetModel.ts`, `enclosureDropTargets.ts`, `test/enclosureTestCatalog.ts` (SAS moved), parity tests | A1 |
| B3 Printing | the §9 extractions, `werkstatt_label*.py`, new `werkstatt_label_control_strip.py`, `routers/workflow_schaltplan_labels.py` (+ the minimal router edit), `schemas/schaltplan.py` (PrintTarget), web `LabelPrintDialog*.tsx`, `LabelPrintTerminals.tsx`, `StripSvg.tsx`, `utils/schaltplanTerminals.ts`, `utils/schaltplanStrip.ts`, `utils/schaltplanApi.ts`, `components/schaltplan/useLabelPrinting.ts`, label tests + goldens | A1, B2, CAL |
| B4 Schematic cabinet sheet | `SCHALTPLAN_STROMLAUF.md` §5 cabinet sheet in A3's modules | A1, A3 |
| C1 Web UI | `utils/enclosureOpsControlBlock.ts`, `enclosureOpsModules.ts` (seed), `ControlBlockSheet.tsx`/`ControlBlockSvg.tsx`/`controlBlockLayout.ts`, new `EnclosurePrepList.tsx`, `useSheetStack.ts`/`EnclosureSheetHost.tsx` (control-block kind), `EnclosureFieldBar.tsx`, `EnclosureFrontSvg.tsx`/`EnclosureFrontBoxes.tsx`/hit layer (block box, runs), `enclosureThreeScene.ts` (colour), `EnclosureTab.tsx`, `EnclosureFindings*`, `UnverifiedBadge` (title prop), `PanelDataTab.tsx` + page wiring (infeed hint), the Klemmen-tab button, CSS, tests | B2, A2, B3 |
| D Integrate | the PDF route wiring in `workflow_schaltplan.py` (`catalog=terminals.catalog`), full suites, browser + PDF proof | all |

No slice runs `git add/commit/stash/checkout/reset`; only D commits.

## 12. Tests (write first; RED before GREEN)

Python (new files listed in §11): parse tables; carrier (reserve field,
moved modules); placement (rails, right-aligned offset, overflow, stored rail
honoured, placeholders counted); prep per fixture board (keys, qty, order,
roles, runs, suppressed items, overrides); infeed matrix; joints, runs, gaps,
roles; Hager network table (every cell) and geometry fallback; supply variants
and the existing-tap rule; findings; Materialliste order, admin merge at the
admin slot, legacy goldens unchanged, `wire:`/`prep:` mapping 200 and an unknown
prefix 400; impact script (counts only); `CONTROL_PARTS ∩ TERMINAL_PARTS = ∅`.
**Update deliberately** (name each in the report): `test_panel_enclosure_material.py`
cabinet tests that gain lines, the fixture-pinned findings/scene tests for
boards with meter modules or ZH53XS/ZH3ES5, `enclosureTab.test.tsx` footer line,
round-2 Aufbau page counts, `test_schaltplan_terminals.py`/`test_panel_enclosure_terminals.py`
"no 249-116" tests stay as they are (they inspect terminal parts only).
Web: parity of `control_block`, `prep`, findings, scene for every board; ops
(deep-frozen inputs, refusals, seeding, no seeding when present/off); sheet
states 1–4, rename, colour, add/remove, rail, wire, tube, length input, remove /
restore, read-only; `EnclosurePrepList` overrides; picker search (code fragment,
"zaehler"/"zahler" for "Zähler", article number, order kept, refused items listed,
empty state, hidden-height count, stack persistence, 56 px CSS); Daten hint.
Printing: vertical strip job golden, `control_strip_size` table, non-fitting label
400, 211-502 job with each label twice, stale 409, block-only board, material
healing.

## 13. Rollout

No migration. No `tools/label_agent` change. Before the swap:
`report_prep_impact.py` in the staged image (counts only, owner reads them).
The calibration merge changes every workshop print (job header, 300 dpi); its
T5 gate and the ruler check, plus T-V1 (vertical rotation) and one 211-502
test print, are owner tasks on the office LAN.

## 14. Open (Werkstatt / owner)

Preferred AAR rail when both have room (automatic = top); VNB acceptance of
the SABO (override exists); 211-502 flat width and the rotation digit (prints);
ZH33SAR2/ZH55SAR2 "bis 35 mm²" clamps as infeed; RfZ-side RJ45 socket;
ZU37V5RKAPZ2 / ZU59V7RKAPZ2 are "Auslaufprodukt" (archive?); a stored "SAS
ungezählt" toggle for a ZH3ES5 used to relieve a full NAR (Tipp 44); Mehrkunden-
anlagen (Allgemeinstrom meter as carrier); ferrules (2 × n, WAGO 216-246);
NAR space for SLS + K96ESA5 (22 mm) + SABO.

## 15. Sources

Hager: catalogue pages (2026-10-26), Hager Tipp 44 (26DE0009, May 2026), product
info 21DE0009_04 (ZY kits), 20DE0038/20DE0209 (ZZ55SAVE), 21DE0258 +
Montageanleitung 6LE002163C (K96ESA5), Bestellhilfe 20DE0173 (ZZ45WAN lengths).
WAGO datasheets 2002-1671 (07.04.2026), 2002-1692, 249-116, 2009-110, 211-50x
(29.04.2026). BDEW Anwendungshilfe Steuersignal-Klemmleiste (08.08.2025,
§3.5.2, Tab. 1, Abb. 6). Research notes: session scratchpad `r4/understand/`, `r4/notes/`.

## 16. Review log

Rev 1 → rev 2 took over every blocker and major finding of the three-lens
review (scratchpad `r4/review/*.json`): busbar roles (R4-11); per-board
overrides (§2.2); tube per board; PEN split; existing tap; reserve fields
(R4-12); exact parse algorithms and regexes (ASCII, NBSP, lookarounds);
single-finding block overflow; occupancy in TS via `controlBlockMmOn`; finding
conditions and scopes; deliberate fixture changes; test file names; the ZY
height digit from the cabinet; string and number formats; run rounding;
geometry fallbacks; impact script counts only; Hager network table; vertical
print geometry, size rule, non-fitting labels, bounds check; the adern job,
entry point and material; file extractions; sheet states, length input, rows,
colours, copy prefixes; prep list; Daten hint; hit layer; Aufbau page.
Minor findings not taken: a stored "SAS ungezählt" toggle and an NAR-space
finding (open items, §14); unifying the catalogue admin's search (separate
round).
