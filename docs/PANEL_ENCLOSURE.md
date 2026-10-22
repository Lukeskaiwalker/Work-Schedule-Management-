# Verteilerpläne — Schrank (Hager univers Z), Vorschau und Materialliste

Contract for the physical enclosure layer of a Verteilerplan: which cabinet,
which field modules where, what came pre-fitted and what was taken out, how
it is drawn (2D open, 2D closed, 3D, PDF) and what lands on the Materialliste.
Read this before touching `document.enclosure`, `device.supplied_by`, the
enclosure catalogue, `panel_catalog_entries`, the `salvage` ledger types or
anything named `panel_enclosure_*` / `enclosure*`.

Status: design **rev 2**, 2026-10-21, branch `claude/panel-enclosure-preview`
(stacked on the undeployed `claude/customer-directory-fix`, see §16). Owner
decisions of 2026-10-21 are binding and quoted as **D1–D8**. Two reviews were
folded in; §18 maps every finding to its fix or to the reason it was
rejected. The repo is public: every example below is invented data.

---

## 1. Decisions

| # | Decision | Why (one line) |
|---|----------|----------------|
| 1 | `rows[]` stays the only device container. A module's DIN rails *reference* row ids (`module.rails[railKey] = rowId`); rows get no new keys. | D1 "one model": schematic, BMK strips, terminals, legend and Materialliste keep reading `rows` unchanged (~34 call sites). |
| 2 | The enclosure is one optional block, `document.enclosure`, default `null`. | Old boards load and save unchanged; any board can get a cabinet later (D1). |
| 3 | With an enclosure, `rows[]` follows the **electrical reading order** (§2.3): first every RfZ/APZ rail of the cabinet, then per module (field, unit) the rails by zone type NAR → SAS → AAR → VF → VT → MM, top → bottom inside a type; rows not in the cabinet last. The rule is fixed by zone *type*, never by catalogue list order. Only client ops reorder; the server never rewrites a document but detects divergence (`encl.row_order`, Python twin of the order). | Topology is "device order across rows". RfZ/APZ devices are fed before the SLS, so they must fall into the supply group, never under a customer FI. |
| 4 | **No silent re-feeding.** Every enclosure op is topology-preserving (§2.4): circuits whose derived feed would change are pinned to their old group head (`parent_id`), and changes that cannot be pinned are shown for confirmation before the op applies. | Placing, moving or removing a module must never move an LS from FI F1 to a Hauptschalter without anyone noticing. |
| 5 | Pre-fitted parts are catalogue **fittings**, **snapshotted into the module at placement** (`module.fittings`). A fitting with a `device_kind` is materialised as an ordinary device with `supplied_by` and is "removed" exactly when no device claims it. A fitting without a device (busbar, BKE-I, PE/N block, RJ45) is removed by listing its key in `module.removed_fittings`. Material derivation reads the snapshot; geometry reads the live catalogue. | Catalogue corrections must fix drawings everywhere but never rewrite the Materialliste of a planned, picked or built board. |
| 6 | Removed fittings become derived Materialliste lines of kind `removed` ("aus Modul entfernt → ins Lager"), booked with two new ledger types `salvage` / `salvage_undo`. The module line stays as bought (D3). Booking needs **`werkstatt:manage`** (D3: "the Werkstatt books it"), is refused for machines and archived articles, and `salvage_undo` is bounded by `stock_available`. Net salvage that no removed line names any more still shows as its own line, so it can always be taken back. | A return raises stock without an earlier decrement, so it gets the same grant as `inventory_plus`. |
| 7 | eHZ / 3-Punkt meters are `module.meters[]` entries (place + number), never devices, never material lines (D7). Placement occupies every meter place; a place set "frei" adds a blind-plate accessory line. A DIN-rail `meter` device keeps today's behaviour and is labelled "Zwischenzähler (Hutschiene)" on boards with a cabinet. | The grid operator supplies the meters; unused places must be covered (VDE-AR-N 4100). Legacy boards stay byte-identical. |
| 8 | Built-in catalogue = Python data module (reviewed in PRs); admin entries and overrides = DB table `panel_catalog_entries` (**migration 0104**, shipped in Slice P). Codes are never deleted, only archived. Rail and fitting keys are append-only (retire, never remove or rename). Size, family and meter places of a code that any plan uses are frozen. A committed file lists every built-in code ever shipped. | `app_settings.value` is `String(2048)`, too small. A stored document must always resolve its codes and keys. |
| 9 | The client has no catalogue twin; it renders from `GET /api/schaltplan/enclosure-catalog`. Layout resolution, geometry and rules are mirrored TS ⇄ Python and pinned by one shared fixture file written by Python. | D8 "one shared pure geometry module, mirrored in Python": parity is enforced by a test. |
| 10 | Placement rules (VDE-AR-N 4100:2026-04) and geometric problems are **findings** only (`level` warn/info, new `rule` id). The schema rejects only structural garbage. | D6 "warn, never block": a board captured half-built must save. |
| 11 | Catalogue read: login. Catalogue edit: `werkstatt:manage`. Salvage/unsalvage and mapping a `removed:` key: `werkstatt:manage`. Every other Materialliste booking and mapping keeps `reports:create`. | Only the Werkstatt can raise stock; installers keep today's rights. |
| 12 | 3D = vanilla `three@0.186.1` (exact pin, zero runtime deps, published 2026-09-24) in a lazy chunk behind its own error boundary. Procedural boxes only; no loaders, wasm or workers; view-only (selection happens in 2D). | D8; no CSP change. Gloves: the 2D view is the working view. |
| 13 | New device kind `hlak` ("Hauptleitungsabzweigklemme"): not a circuit, not a group. It is offered in the palette only on boards with a cabinet. | Several fields come with an HLAK fitted, and the AAR rule must recognise it. |
| 14 | Codes: the read path never fails on one. The write path rejects only codes that are **newly introduced** by the request (400). A code the stored board already carries always saves. | A catalogue change or a downgrade must never make a board unsaveable. |
| 15 | Rail rows are created **lazily** (a rail gets a row when it first holds something). `MAX_ROWS` rises from 60 to 120 in Python and TS; ops refuse before the cap with German copy. | A full ZB55S has ≈ 45 rails; eager empty rows plus legacy rows would break autosave at 60. |
| 16 | One tap rule in the 2D view at every zoom: a tap on a rail opens **RailSheet** (56 px tiles), and a tile opens the DeviceInspector. Module entry points are HTML buttons (≥ 56 px) above the drawing. | A 1-TE device is 23 px at the largest zoom, too small for gloves; the same tap must always do the same thing. |
| 17 | Rollout in two releases: **Slice P** (migration 0104, tolerant schemas, ledger types, `hlak`, `MAX_ROWS`) is live before the feature release, so the feature can be rolled back image-only (§16). | An older API returns 500 on an HLAK board and drops `enclosure` on save; an older image cannot start against an unknown Alembic head. |

Non-goals (D5): flush mounting, Blendrahmen, Sockel, IP54 `…W` cabinets,
1-field cabinets, Komplettschränke. The model keeps `mounting` and the
module grid generic so they can be added as catalogue data later. WAGO
Reihenklemmen strips are not placed on rails in v1: an info finding states
their length per field (Q3).

---

## 2. Data model (inside `panel_plans.document`)

### 2.1 Shape

```jsonc
{
  "version": 1,                       // unchanged; no version bump, tolerant defaults instead
  "supply": { "...": "unchanged" },
  "rows": [                           // electrical reading order (§2.3)
    { "id": "row-nar1", "label": "F1 · NAR", "slots": 12, "devices": [
        { "id": "dev-q0", "kind": "sls", "te": 3, "rating": "E35", "designation": "Q0", "...": "",
          "supplied_by": null } ] },
    { "id": "row-aar1", "label": "F1 · AAR 1", "slots": 12, "devices": [
        { "id": "dev-q1", "kind": "hauptschalter", "te": 3, "poles": 3, "designation": "Q1",
          "parent_id": "dev-q0", "supplied_by": { "module": "mod-a", "part": "hs" } } ] },
    { "id": "row-aar2", "label": "F1 · AAR 2", "slots": 12, "devices": [
        { "id": "dev-x0", "kind": "hlak", "te": 4, "poles": 3, "supplied_by": { "module": "mod-a", "part": "hlak" } } ] },
    { "id": "row-v1", "label": "F2 · Verteiler 1", "slots": 12, "devices": [ "FI + 8 LS …" ] }
    // … only rails that hold something have a row; then rows not in the cabinet
  ],
  "terminal_labels": {},
  "enclosure": {
    "code": "ZB33S",
    "modules": [
      { "id": "mod-a", "code": "ZH3EH16", "field": 0, "unit": 0, "label": "Allgemein",
        "rails": { "nar": "row-nar1", "aar1": "row-aar1", "aar2": "row-aar2" },
        "fittings": [
          { "key": "hs", "label": "Hauptschalter", "article_no": null, "device_kind": "hauptschalter", "removable": true },
          { "key": "hlak", "label": "Hauptleitungsabzweigklemme", "article_no": null, "device_kind": "hlak", "removable": true },
          { "key": "busbar", "label": "Sammelschiene 5-polig 12×5 mm (NAR)", "article_no": null, "device_kind": null, "removable": false },
          { "key": "bke", "label": "BKE-I Zählerplatz", "article_no": null, "device_kind": null, "removable": false } ],
        "removed_fittings": [],
        "meters": [ { "place": 0, "number": "1EBZ0100000001", "label": "Allgemein" } ] },
      { "id": "mod-b", "code": "ZU37KS", "field": 1, "unit": 0, "label": "",
        "rails": { "r1": "row-v1", "r2": "row-v2", "r3": "row-v3" },
        "fittings": [ { "key": "pe_n", "label": "PE/N-Klemmen waagerecht", "article_no": null, "device_kind": null, "removable": false } ],
        "removed_fittings": [], "meters": [] }
    ]
  }
}
```

* `field`: 0-based field from the left. `unit`: 0-based 150 mm raster unit
  from the top of the usable field height. A module's size (`width_fields`,
  `height_units`) comes from its catalogue entry, never from the document.
* `rails`: catalogue rail key → row id, **lazy**. A rail gets a row when it
  first holds something: a fitting device at placement, a device added from
  RailSheet, an adopted row, a template fill. A rail without an entry, or
  with a dangling row id, renders as an empty rail; `ensureRailRow` creates
  its row at the physical position. Enclosure ops prune linked rows that are
  empty and still carry their generated label.
* `fittings`: snapshot taken at placement of every non-retired catalogue
  fitting (`key`, `label`, `article_no`, `device_kind`, `removable`). The
  supplied, removed and Materialliste derivations read the snapshot; a module
  without one (a hand-made document) falls back to the catalogue. The
  snapshot is refreshed only by the explicit op "Katalogstand übernehmen"
  (draft boards, §10.2).
* `supplied_by`: `{module: <module instance id>, part: <fitting key>}` or
  `null`. Only the first device in row order claiming a `(module, part)` pair
  counts as the fitting; any further claimant is an ordinary device.
* `meters[]`: one entry per **occupied** meter place. Placement creates an
  entry for every place (`number` "", `label` ""). A place without an entry is
  "frei" (reserve): it is drawn with a blind plate and adds the module's
  `free_place_cover` accessory line (§6). `place` is a running index over the
  module's ZF zones in spec order, left → right for eHZ (side by side) and
  top → bottom for 3-Punkt (Doppelstock). Out-of-range places are ignored and
  reported (`encl.meter_place_invalid`).
* `supply.meter_number` (existing free text) stays stored. On a board with a
  cabinet the Daten tab hides it and shows the cabinet's meters read-only
  ("im Tab Schrank bearbeiten"). When the first meter module is placed and no
  meter number exists yet, `meters[0].number` is seeded from it once. The
  duplicate route clears every `meters[].number` (a meter number identifies
  one physical meter) and keeps places and labels.

### 2.2 Schema (Pydantic, `app/schemas/panel_enclosure.py`; TS mirror `types/panelEnclosure.ts`)

| Model | Field | Rule |
|-------|-------|------|
| `DeviceSuppliedBy` | `module` | str 1–64 |
| | `part` | str 1–40 |
| `PanelDevice` (+) | `supplied_by` | `DeviceSuppliedBy \| None = None` |
| `EnclosureMeter` | `place` | int 0–7 |
| | `number` | str ≤ 40, default "" |
| | `label` | str ≤ 64, default "" |
| `EnclosureFitting` | `key` | `RailKey` |
| | `label` | str 1–96 |
| | `article_no` | str ≤ 40 \| null |
| | `device_kind` | one of `DEVICE_KINDS` \| null |
| | `removable` | bool |
| `EnclosureModule` | `id` | str 1–64 |
| | `code` | `CatalogCode` |
| | `field` | int 0–9 |
| | `unit` | int 0–19 |
| | `rails` | `dict[str, str]`, ≤ 16 entries, keys `RailKey`, values 1–64 chars |
| | `fittings` | `list[EnclosureFitting]`, ≤ 16, unique keys, default `[]` |
| | `removed_fittings` | `list[str]`, ≤ 16, each 1–40 chars, de-duplicated |
| | `meters` | `list[EnclosureMeter]`, ≤ 8, unique `place` |
| | `label` | str ≤ 64, default "" |
| `PanelEnclosure` | `code` | `CatalogCode` |
| | `modules` | `list[EnclosureModule]`, ≤ 50 |
| `PanelDocument` (+) | `enclosure` | `PanelEnclosure \| None = None` |
| | `rows` | ≤ **120** (`MAX_ROWS`, was 60; same constant in `utils/schaltplanDevices.ts`, parity test) |
| `PanelFinding` (+) | `rule` | str, default "" (existing findings keep "") |

* `CatalogCode` = stripped, upper-cased, `^[A-Z0-9][A-Z0-9._-]{1,39}$`.
  `RailKey`/fitting keys = `^[a-z0-9_-]{1,40}$`.
* `PanelEnclosure` validators (structural, raise 422): unique module ids; a row
  id referenced by at most one rail across all modules. The client runs
  `normalizeEnclosure` before every save, so its own output never trips them.
* NOT validated by the schema (findings instead, §5): bounds against the real
  cabinet, overlaps, height family, dangling row/module references, unknown
  rail keys.
* Write-path code check (`assert_known_codes`), answered with **400**
  `Unbekannter Schrank- oder Modulcode: {code}.`:
  `POST /panels` checks every code. `PATCH /panels/{id}` with a document
  checks only codes that occur nowhere in the stored document.
  `POST /panels/{id}/duplicate` checks nothing (it copies a stored document).
  "Known" = present in the merged catalogue, archived or invalid included.
* The read path (`_detail` re-validation) never checks codes. A stored code
  that is unknown or invalid renders as a placeholder with finding
  `encl.unknown_code`.

### 2.3 Derived meaning (`enclosureLayout.ts` ⇄ `panel_enclosure_layout.py`)

* **Resolvable rail**: the module's code resolves to a valid spec and the key
  is one of its rails (retired included).
* **Row ↔ rail** (`linkedRows`): a row is "im Schrank" when a module names it
  under a resolvable rail. A row behind an unknown code or an unknown key is
  "Nicht im Schrank" and gets `encl.stale_rail`; its devices stay in the plan.
* **Fitting removed?** For a device fitting: no device has
  `supplied_by == {module.id, fitting.key}`. For a non-device fitting: its key
  is in `removed_fittings`. Only `removable: true` fittings can be removed; a
  non-removable key in `removed_fittings` is ignored.
* **Supplied devices** (counted by the module, not as device lines): devices
  whose `supplied_by.module` names an existing module instance whose
  snapshot has a device fitting with that key, first claimant only. This
  holds for unknown and invalid codes too, because it reads the snapshot.
* **Electrical reading order** (`physicalRowOrder` / `physical_row_order`),
  stable and idempotent:
  1. rails in zones of type `RFZ` and `APZ` of every module, by
     (module field, module unit, module id, zone unit, rail unit);
  2. every other linked rail, by (module field, module unit, module id,
     zone-type rank, zone unit, rail unit), with ranks NAR 1, SAS 2, AAR 3,
     VF 4, VT 5, MM 6 (`ZF` and `COVER` zones have no rails);
  3. rows not in the cabinet, in their current relative order.
  RailEditor and RailSheet display rows by module and rail position; the
  order above is what feeds the topology.

### 2.4 Feed preservation (`enclosureFeeds.ts`, TS only)

`feedMap(doc)`: circuit device id → id of the group head it hangs off
(`""` = direkt von der Einspeisung), derived from `buildTopology`.

`preserveFeeds(before, after, created)` runs at the end of every enclosure op
(place, move, swap, remove module, adopt, claim, move device to rail, fill
from template, fitting toggle, order rows). For each circuit in both
documents, not in `created`, whose feed differs:

* old head `h ≠ ""` still a group head in `after` → set `parent_id = h` on the
  circuit (new object) → listed in `pinned`;
* otherwise (old head gone, or the old feed was the Einspeisung) → listed in
  `regrouped: {deviceId, from, to}`.

Pinning cannot change any other circuit's feed: an explicit `parent_id` only
affects its own device, and the head it names was already a head. The UI
applies an op with `regrouped ≠ []` only after confirmation (§11) and shows
`pinned` as a toast. Group heads' feeder links (`parent_id` on an FI/HS) are
explicit already and are untouched. Device edits outside the enclosure ops
(adding an FI from the palette, "Nach links/rechts") keep today's positional
behaviour, which is deliberate.

---

## 3. Catalogue

### 3.1 Spec shapes (`app/schemas/panel_enclosure.py`; TS `types/panelEnclosure.ts`)

```text
ZoneType   = "NAR" | "ZF" | "RFZ" | "AAR" | "VF" | "APZ" | "VT" | "SAS" | "MM" | "COVER"
MountType  = "rail" | "busbar"
Family     = "meter_ehz" | "meter_3p" | "distribution" | "distribution_apz"
           | "busbar" | "communication" | "multimedia" | "cover"

RailSpec      { key: RailKey, unit: int ≥0 (within zone), ple: 1..24, mount: MountType = "rail",
                retired: bool = false }
ZoneSpec      { key: RailKey, type: ZoneType, label: str ≤64 = "", field: int ≥0 (offset in module) = 0,
                unit: int ≥0, units: 1..9, rails: RailSpec[] ≤9 = [],
                meter_places: 0..4 = 0, meter_type: "ehz" | "3punkt" | null = null, sealable: bool = false }
FittingDevice { kind: DEVICE_KINDS, rail: RailKey, te: 1..24, poles: 1..4, rating: str ≤32 = "",
                width_mm: float | null = null }
FittingSpec   { key: RailKey, label: str 1..96, article_no: str ≤40 | null, removable: bool,
                device: FittingDevice | null, verified: bool, note: str ≤300 = "", retired: bool = false }
AccessorySpec { article_no: str 1..40, label: str 1..160, qty: 1..99, verified: bool = true }

EnclosureSpec { code, article_no, manufacturer = "Hager", series = "univers Z", name ≤160,
                height_mm, width_mm, depth_mm, fields: 1..9, door_leaves: 1..4,
                field_width_mm = 250, unit_mm = 150, margin_mm = 25, units_per_field: 1..19,
                mounting: "surface", ip: str ≤8, door: str ≤64,
                accessories: AccessorySpec[] ≤20 = [],
                verified: bool, unverified: str[] ≤12 (each ≤200), source_url: https URL ≤500 | null, note ≤500 }
ModuleSpec    { code, article_no, manufacturer = "Hager", series = "univers Z", name ≤160, family: Family,
                field_height_mm: int | null   // 1050 → 1100 cabinets, 1350 → 1400; null = fits any
                width_fields: 1..3, height_units: 1..9, wiring_mm2: 10 | 16 | null = null,
                zones: ZoneSpec[] ≤12, fittings: FittingSpec[] ≤16, accessories: AccessorySpec[] ≤20,
                free_place_cover: AccessorySpec | null = null,
                verified, unverified, source_url, note }
```

Spec validators (422 for admin input; a test runs them over every built-in):

* zones lie inside `width_fields × height_units` and do not overlap; rail
  `unit < zone.units`; rail and fitting keys unique per module;
* a fitting device's `rail` exists and is not retired; a fitting with a
  `device` is `removable: true` (deleting the device is how it gets removed);
* `meter_type` is set iff `meter_places > 0`;
* every `SAS` zone has exactly one rail, `mount: "busbar"`; every `NAR` zone
  has at least one `busbar` rail;
* `meter_ehz` / `meter_3p` modules have exactly one NAR zone, at least one ZF
  zone with meter places and at least one AAR zone;
* `source_url` starts with `https://`;
* enclosure `width_mm == 2·margin + fields·field_width` and
  `units_per_field·unit_mm == height_mm − 2·margin` (checked in the data test
  only; admins may model a non-Hager cabinet);
* `verified == false` requires a non-empty `unverified` that says *what* is
  unchecked; `unverified` may also list single assumptions on a verified entry.

Zone *list* order carries no meaning (the reading order is fixed by type, §2.3).

Example module (built-in):

```json
{ "code": "ZH3EH16", "article_no": "ZH3EH16", "family": "meter_ehz",
  "name": "Komplettfeld eHZ, 1 Zählerplatz, Hauptschalter, HLAK, 1050 mm",
  "field_height_mm": 1050, "width_fields": 1, "height_units": 7, "wiring_mm2": null,
  "zones": [
    { "key": "aar", "type": "AAR", "unit": 0, "units": 2,
      "rails": [ { "key": "aar1", "unit": 0, "ple": 12 }, { "key": "aar2", "unit": 1, "ple": 12 } ] },
    { "key": "rfz", "type": "RFZ", "unit": 2, "units": 1, "sealable": true,
      "rails": [ { "key": "rfz", "unit": 0, "ple": 12 } ] },
    { "key": "zf",  "type": "ZF",  "unit": 3, "units": 2, "meter_places": 1, "meter_type": "ehz", "sealable": true },
    { "key": "nar", "type": "NAR", "unit": 5, "units": 2, "sealable": true,
      "rails": [ { "key": "nar", "unit": 0, "ple": 12, "mount": "busbar" } ] } ],
  "fittings": [
    { "key": "hs", "label": "Hauptschalter", "article_no": null, "removable": true, "verified": false,
      "device": { "kind": "hauptschalter", "rail": "aar1", "te": 3, "poles": 3, "rating": "" },
      "note": "Typ und Bemessungsstrom nennt Hager nicht" },
    { "key": "hlak", "label": "Hauptleitungsabzweigklemme", "article_no": null, "removable": true, "verified": false,
      "device": { "kind": "hlak", "rail": "aar2", "te": 4, "poles": 3 },
      "note": "3-polig wie ZH3EL16 angenommen" },
    { "key": "busbar", "label": "Sammelschiene 5-polig 12×5 mm (NAR)", "article_no": null, "removable": false, "verified": true, "device": null },
    { "key": "bke", "label": "BKE-I Zählerplatz", "article_no": null, "removable": false, "verified": true, "device": null } ],
  "accessories": [],
  "free_place_cover": { "article_no": "KU40XXE", "label": "Blindabdeckung freier eHZ-Zählerplatz", "qty": 1, "verified": false },
  "verified": false,
  "unverified": [ "Feldaufbau (AAR oben, RfZ, eHZ, NAR unten) aus Hager Tipp 44 abgeleitet",
                  "Hauptschalter: Typ/Bemessungsstrom unbekannt",
                  "HLAK 3-polig und 4 PLE breit angenommen",
                  "Feldverdrahtung (mm²) nicht angegeben" ],
  "source_url": "https://hager.com/de/katalog/?artnr=ZH3EH16", "note": "" }
```

### 3.2 Built-in list (`app/services/panel_enclosure_catalog_data.py`)

Cabinets (D5: exactly these eight; all 205 mm deep, IP44, door "Klappgriff mit
Vorreiber", `mounting: "surface"`). Every cabinet carries the assumptions
`"Raster 150 mm / 12 PLE laut ZU59XS-Datenblatt (125 mm nicht ausgeschlossen)"`,
`"Innenrand 25 mm aus dem Außenmaß abgeleitet"` and
`"Türflügel ({n}) angenommen"`. Assumption for all: a `ZB…S` is an empty
cabinet; field kits are ordered separately (a Komplettschrank like
ZB33ET225W1 is out of scope).

| Code | H × W mm | Fields | Units/field | Door leaves | verified | extra unverified |
|------|----------|--------|-------------|-------------|----------|------------------|
| ZB32S | 1100 × 550 | 2 | 7 | 1 | yes | — |
| ZB33S | 1100 × 800 | 3 | 7 | 2 | yes | — |
| ZB34S | 1100 × 1050 | 4 | 7 | 2 | yes | — |
| ZB35S | 1100 × 1300 | 5 | 7 | 2 | yes | — |
| ZB52S | 1400 × 550 | 2 | 9 | 1 | yes | — |
| ZB53S | 1400 × 800 | 3 | 9 | 2 | **no** | "Seite nicht geöffnet; Werte aus Suchzusammenfassung, 27 Reihen abgeleitet" |
| ZB54S | 1400 × 1050 | 4 | 9 | 2 | yes | — |
| ZB55S | 1400 × 1300 | 5 | 9 | 2 | yes | — |

("verified" covers dimensions and PLE; the door leaves stay in `unverified`.)

Modules: zones are listed top → bottom with their units; rails have `ple` 12
unless noted. Every meter-field stack is an **assumption** from Hager Tipp 44
arithmetic: those entries are `verified: false` and name the stack in
`unverified`. Every SAS position is flagged
`"Lage der Sammelschienenzone aus Rechnung abgeleitet"`. R = removable.
Every `meter_ehz` module has `free_place_cover` KU40XXE and every `meter_3p`
module has T95L (both `verified: false`).

| Code | Family | Field h | Zones (top → bottom) | Meters | mm² | Fittings |
|------|--------|---------|----------------------|--------|-----|----------|
| ZH3EL27 | meter_ehz | 1050 | AAR 0–1 (aar1, aar2) · RFZ 2 (rfz) · ZF 3–4 · NAR 5–6 (nar, busbar) | 1 ehz | 10 | busbar, bke |
| ZH3EL22 | meter_ehz | 1050 | as ZH3EL27 | 2 ehz | — | busbar, bke |
| ZH3EL16 | meter_ehz | 1050 | as ZH3EL27 | 1 ehz | 16 | busbar, bke, hlak R (hlak **3-pol.** @aar2) |
| ZH3EH16 | meter_ehz | 1050 | as ZH3EL27 | 1 ehz | — | busbar, bke, hs R (hauptschalter @aar1, ungeprüft), hlak R (3-pol. @aar2, ungeprüft) |
| ZH33X7 | meter_3p | 1050 | AAR 0–1 (aar1, aar2) · ZF 2–4 · NAR 5–6 (nar, busbar) | 1 3punkt | — | busbar |
| ZH31X7NT | meter_3p | 1050 | as ZH33X7 | 1 3punkt | 10 | busbar, trenn R (hauptschalter @aar1, ungeprüft: "Trennvorrichtung von Hager nicht benannt") |
| ZU37KS | distribution | 1050 | VT 0–6 (r1…r7) | — | — | pe_n "PE/N-Klemmen waagerecht" |
| ZU37RK | distribution | 1050 | VT 0–6 (r1…r7) | — | — | — |
| ZU37VT5APZ2 | distribution_apz | 1050 | VT 0–4 (r1…r5) · APZ 5–6 (apz, ple 6, sealable) | — | — | rj45 "RJ45-Buchse ZZ45WAN2PP" |
| ZU37VT4APZ2 | distribution_apz | 1050 | VT 0–3 (r1…r4) · RFZ 4 (rfz) · APZ 5–6 (apz, ple 6) — order ungeprüft | — | — | rj45 |
| ZH3ES5 | busbar | 1050 | SAS 0–1 (sas, busbar) · VT 2–6 (r1…r5) | — | — | busbar, pe_n |
| ZH33SAR2 | communication | 1050 | APZ 0–1 (apz, ple 6) · RFZ 2–4 (rfz1…rfz3) · SAS 5–6 (sas, busbar) | — | — | busbar |
| ZH5EL27 | meter_ehz | 1350 | VF 0–1 (vf1, vf2) · AAR 2–3 · RFZ 4 · ZF 5–6 · NAR 7–8 | 1 ehz | — | busbar, bke |
| ZH5EL22 | meter_ehz | 1350 | as ZH5EL27 | 2 ehz | — | busbar, bke |
| ZH5EL16 | meter_ehz | 1350 | as ZH5EL27 | 1 ehz | 16 | busbar, bke, hlak R (verified false, "aus ZH3EL16 übertragen") |
| ZH53X3 | meter_3p | 1350 | AAR 0–1 · ZF 2–6 (Doppelstock) · NAR 7–8 (nar, busbar) | 2 3punkt | — | busbar |
| ZU59KS | distribution | 1350 | VT 0–8 (r1…r9) | — | — | pe_n |
| ZU59RK | distribution | 1350 | VT 0–8 | — | — | — |
| ZU59VT7APZ2 | distribution_apz | 1350 | VT 0–6 · APZ 7–8 (ple 6) | — | — | rj45 |
| ZH53XS | busbar | 1350 | SAS 0–1 (sas, busbar) · VT 2–8 (r1…r7) | — | — | busbar, pe_n |
| ZH55SAR2 | communication | 1350 | APZ 0–1 · RFZ 2–6 (rfz1…rfz5) · SAS 7–8 (sas, busbar) | — | — | busbar |
| ZY150RFZ | communication | any | RFZ 0 (rfz) | — | — | — |
| ZU62A / ZU79A / ZU93A | cover | any | COVER 0 (1 / 2 / 3 units) | — | — | — (unverified "als Füllung ohne Einbausatz angenommen") |

`mm²` = `wiring_mm2` from the research (ZH3EL27, ZH31X7NT: 10; ZH3EL16,
ZH5EL16: 16); "—" = null, so `vde.sls_rating` stays silent rather than guess
from the article code (research uncertainty: code digits do not map to specs).

Not shipped (admins can add; the model supports them): 2-/3-field
Komplettfelder (ZK…/ZL…, `width_fields` 2–3), multimedia/Lastmanagement
fields (row counts unknown), ZH53X9ST (its stated stack does not add up to
1350 mm). Mandatory accessories the research names but cannot pin down
(ZH5EL27: "ZZ35S/S35V", "ZM15H/ZM25F", ZZ60A; VZ00APZ for …APZ2 fields;
ZZ55SAVE Feld-Feld) are **not** auto-added: the research gives alternatives
and no quantities, and a wrong line on every board is worse than a missing
one. Q2 asks the owner; the answer is catalogue data an admin enters, not
code. No prices, no EANs. `source_url` from the research file. Split the data
file at 800 lines (`…_data_cabinets.py`, `…_data_modules.py`).

### 3.3 Storage — table `panel_catalog_entries` (model `PanelCatalogEntry` in `app/models/schaltplan.py`, exported from `entities.py`)

| Column | Type | Note |
|--------|------|------|
| id | Integer PK | |
| code | String(40), unique, index, not null | `CatalogCode` |
| entry_type | String(16), not null | `enclosure` \| `module`; immutable after create |
| spec | JSON, nullable | null = "built-in spec stands" (only for built-in codes) |
| is_archived | Boolean, not null, default false | hidden from pickers, still resolves |
| created_by / updated_by | FK users, SET NULL | |
| created_at / updated_at | DateTime, not null | `utcnow` |

Merge (`load_catalog(db)`): start from the built-ins (`source: "builtin"`). A
row whose code is built-in overrides `spec` if non-null (`source: "override"`)
and/or `archived`. A row with a new code is `source: "custom"` (spec
required). A row whose spec fails validation (a tightened validator, a bad
manual edit) never 500s: a built-in code keeps its built-in spec; a custom
code becomes `CatalogEntry(invalid=True, spec=None)` and is logged once per
process. An invalid code still counts as known for the write check, draws as
a placeholder, and its boards' Materialliste reads the module snapshot.

### 3.4 Stock and "zuletzt verwendet" (D4)

Per entry the catalogue response carries:

* `article` / `article_source`: the explicit mapping on the line key
  (`enclosure:<code>` / `module:<code>`, the existing global
  `schaltplan_material_articles`) first, else an auto-match on `article_no`
  (`match_articles_by_number`, batched: one query on
  `werkstatt_article_suppliers.supplier_article_no IN (…)` with exact
  equality, one on article names containing any of the numbers). A name
  matches only on a **whole token**: the number must be followed by the end
  of the name or a non-alphanumeric character, so `ZH3EH16` never matches
  "Hager ZH3EH16N Komplettfeld". Archived and merged articles never match.
  `auto_match_part` (WAGO) is unchanged.
* `stock_available`: the article's `stock_available`, 0 without an article.
* `recent_count`, `last_used_at`: over the caller's **visible** plans
  (`_visible_plans`) updated in the last 365 days, at most the 300 newest:
  boards whose document uses the code.

Order of `modules` and `enclosures`: `stock_available > 0` first, then
`recent_count > 0` by `last_used_at` desc, then catalogue order.

For `can_manage` callers the response also lists up to 20 `uncatalogued`
stock articles: non-archived, `stock_available > 0`, manufacturer or name
containing "Hager", with a name token shaped like a univers Z code
(`^Z[A-Z]{1,2}\d[A-Z0-9]*$`) that is no catalogue code. The module picker shows
them as "Im Lager, nicht im Katalog → Eintrag anlegen" (form prefilled with
code, article number and name).

### 3.5 Change rules (identity is frozen)

1. **Keys are append-only.** For an existing code (built-in, override or
   custom), a PUT or a reset may not remove or rename a rail key or a fitting
   key, and may not change a fitting's `device.kind`. Retiring is how a key
   goes away: a retired rail gets no row for new placements and is drawn only
   while its row holds devices (flag `retired`, finding `encl.stale_rail` at
   info). A retired fitting is no longer snapshotted for new placements.
2. **Size and kind are frozen while used.** If any stored plan (all plans,
   not only visible ones) uses the code, `entry_type`, `family`,
   `width_fields`, `height_units`, `field_height_mm`, the zone types and each
   zone's `meter_places` cannot change → 409. Positions inside the module
   (zone/rail `unit`, `ple`), labels, article numbers, `wiring_mm2`,
   accessories, `verified`/`unverified`, notes and source stay editable: they
   are corrections, and geometry is live on purpose so a corrected stack
   reaches every drawing.
3. **Shipped built-ins never disappear.**
   `apps/api/tests/fixtures/enclosure_catalog_shipped.json` (committed,
   append-only) records every built-in code ever shipped with its frozen
   fields, rail keys and fitting keys/kinds. A test fails if a built-in
   disappears or breaks rule 1 or 2 against that record. A deliberate change
   to a frozen field edits the file in the same PR, and the PR text says why
   existing boards stay correct.
4. **Snapshots protect the list.** Because material facts come from
   `module.fittings`, a catalogue edit never changes the Materialliste of an
   existing board. "Katalogstand übernehmen" (ModuleSheet, draft boards only,
   shown when snapshot and catalogue differ) refreshes one module explicitly.

---

## 4. Geometry (one pure module, twice)

`apps/web/src/utils/enclosureGeometry.ts` and
`apps/api/app/services/panel_enclosure_geometry.py` produce **the same box
list** for the same `(document, catalog, view)`. Both use the shared layout
resolution (§2.3). Renderers (SVG, three.js, reportlab) only draw boxes; no
renderer computes a position.

* Units mm. Origin: top-left corner of the cabinet's **back** face.
  `x` → right, `y` → down, `z` → toward the viewer (front face at `z = depth`).
* `round1(v) = floor(v·10 + 0.5) / 10` on every number (both languages; never
  Python `round`).
* Output order: ascending `(z, y, x, id)`; `flags` sorted.
* `build(document, catalog, view)` returns `null` when `document.enclosure` is
  null or its cabinet code is unknown or invalid.
* Device width on a rail (`enclosureDeviceWidthMm` / `enclosure_device_width_mm`):
  `width_mm` if set; else an `sls` on a `busbar` rail is 78.75 mm (HTS335E,
  4.5 PLE; a drawing default); else `device_width_mm` (te × 17.5).

```ts
type SceneBoxKind = "shell" | "field" | "module" | "zone" | "rail" | "busbar" | "device"
  | "meter" | "meter_place" | "cover" | "cover_slot" | "device_front" | "window" | "meter_front"
  | "blind_plate" | "door" | "handle";
interface SceneBox {
  id: string; kind: SceneBoxKind;
  x: number; y: number; z: number; w: number; h: number; d: number;
  label: string;                       // "" when none
  moduleId: string | null; railKey: string | null; rowId: string | null; deviceId: string | null;
  zoneType: ZoneType | null;
  flags: string[];  // "overflow" | "supplied" | "sealable" | "unknown_code" | "unverified" | "free" | "retired"
}
interface EnclosureScene { width: number; height: number; depth: number; view: "open" | "closed"; boxes: SceneBox[] }
```

Let `M = margin_mm`, `FW = field_width_mm`, `U = unit_mm`, `W/H/D` the cabinet,
`L = door_leaves`.

| Box | id | Position / size | z, d | Views |
|-----|----|-----------------|------|-------|
| shell | `shell` | 0, 0, W × H | 0, D | both |
| field | `field:{i}` | x = M + i·FW, y = M, FW × units_per_field·U; label `Feld {i+1}` | 10, 2 | both |
| module | `module:{id}` | x = M + field·FW, y = M + unit·U, width_fields·FW × height_units·U; label `article_no`; unknown/invalid code → 1 × 1 unit, flag `unknown_code`; flag `unverified` when the spec is unverified | 12, 3 | both |
| zone | `zone:{mid}:{key}` | x = module.x + zone.field·FW, y = module.y + zone.unit·U, FW × zone.units·U; label zone.label or default (NAR, Zählerfeld, AAR, RfZ, Verteilerfeld, APZ, Verteiler, Sammelschienen, Multimedia, Abdeckung) | 15, 1 | both |
| rail | `rail:{mid}:{key}` | every non-retired rail, plus retired rails whose row holds devices (flag `retired`); centre `cy = zone.y + rail.unit·U + U/2`; x = zone.x + (FW − ple·17.5)/2, y = cy − 17.5, ple·17.5 × 35; label = row label or default; `rowId` = linked row or null | 40, 7.5 | both |
| busbar | `rail:{mid}:{key}` (mount busbar) | same x/w, y = cy − 30, h = 60 | 30, 12 | both |
| device | `device:{devId}` | x = rail.x + Σ previous widths, y = cy − 45, w = device width, h = 90; label = BMK else catalogue `short`; flags `overflow` (right edge > rail end + 0.05), `supplied` | 47.5, 70 | open |
| meter_place | `meter:{mid}:{place}` | cell: ehz → side by side (zone width / places), 3punkt → stacked (zone height / places); box centred: ehz 110 × 210, 3punkt 180 × 330; occupied → kind `meter`, label = number or "Zähler"; free → kind `meter_place`, flag `free`, label "frei" | 40, 80 (`meter`) / 15, 1 | open |
| cover | `cover:{mid}:{key}` | zone rect inset 2 mm; flag `sealable` from zone | 120, 2 | closed |
| cover_slot | `slot:{mid}:{key}` | x = rail.x, w = rail.w, y = cy − 23, h = 46 | 122, 0.5 | closed |
| device_front | `front:{devId}` | device x/w, y = cy − 22.5, h = 45; label as device | 123, 0.5 | closed |
| window / meter_front / blind_plate | `window:{mid}:{place}` / `mfront:{mid}:{place}` / `blind:{mid}:{place}` | meter box rect; meter_front when occupied (label = number), blind_plate when free (label "Blindabdeckung") | 122 / 123 / 123, 0.5 | closed |
| door | `door:{i}`, i < L | x = i·W/L, y = 0, W/L × H | D, 2 | both (2D open skips it; 3D swings each leaf about its outer edge) |
| handle | `handle:{i}` | 15 × 120 at y = H/2 − 60, on the leaf's inner edge: L = 1 → x = W − 30; otherwise a leaf left of centre → its right edge − 30, right of centre → its left edge + 15 | D + 2, 20 | both |

Devices of rows not in the cabinet produce no box. Non-device fittings
produce no box (they are listed in ModuleSheet and the PDF). Display-only
constants (device 90 × 70, eHZ 110 × 210, 3-Punkt 180 × 330, all z values,
the busbar SLS width) are drawing approximations, labelled as such in the code.

Labels are drawn by the renderers, not positioned by geometry: a label that
does not fit horizontally is rotated 90° inside the 90 mm device box; below a
minimum box width (SVG 9 CSS px, PDF 2 mm) it is hidden. RailSheet always
shows the full text.

---

## 5. Findings (`enclosureFindings` TS ⇄ `enclosure_findings` Py)

`(document, catalog) → [{level, scope, message, rule}]`, never raises, empty
for `enclosure: null`. Appended to `validate_document`'s output by the panel
detail route (through `panel_enclosure_service.detail_findings`) and by the
editor; `validate_document` itself is unchanged. Messages are prefixed
"VDE-AR-N 4100: " for `vde.*`.

Shown in the Schrank tab under the drawing with the disclaimer "Prüfhilfe nach
VDE-AR-N 4100:2026-04 — ersetzt nicht die TAB des Netzbetreibers." and the
line "Nicht automatisch geprüft: Spannungsabgriff für SMGW/APZ vor dem SLS ·
RJ45 im RfZ · Einführung des Hauptkabels nicht von oben · Montagehöhe und
Arbeitsraum · TAB des Netzbetreibers." The existing "Prüfen:" banner shows one
chip "Schrank: {n} Hinweise" (warn count) instead of the single lines, so the
slot and circuit warnings stay visible.

Helpers used below: *circuit* = catalogue `circuit: true`; *rating(d)* = last
number in `rating` (none → unknown); *occupied(m)* = meter places of module m
with an entry; *need(m)* = max(1, occupied(m)).

| rule | level | fires when | message (German) | scope |
|------|-------|------------|------------------|-------|
| `encl.unknown_code` | warn | cabinet/module code unknown or invalid | `Unbekannter oder fehlerhafter Katalogcode {code} — nur als Platzhalter gezeigt.` | module id / "" |
| `encl.out_of_bounds` | warn | module exceeds fields or units | `{art}: ragt aus dem Schrank (Feld {n}).` | module |
| `encl.overlap` | warn | two modules share a unit cell | `{a} und {b} überlappen in Feld {n}.` | module |
| `encl.height_mismatch` | warn | `field_height_mm` ≠ units_per_field·U | `{art}: für {fh} mm Felder — passt nicht in {cab}.` | module |
| `encl.field_gap` | info | unoccupied units in a field | `Feld {n}: {mm} mm ohne Modul — Abdeckung einplanen.` | "" |
| `encl.row_unlinked` | info | row not linked to a resolvable rail | `{row}: keiner Hutschiene im Schrank zugeordnet.` | row |
| `encl.stale_rail` | warn (info for a retired rail) | a module names a row under a key its spec lacks / a retired rail holds devices | `{row}: Hutschiene „{key}“ gibt es in {art} nicht — gilt als „Nicht im Schrank“.` / `{row}: Hutschiene „{key}“ in {art} ist ausgemustert — Geräte umsetzen.` | row |
| `encl.row_order` | warn | `rows[]` order of linked rows ≠ `physical_row_order` | `Reihenfolge der Reihen passt nicht zum Schrank — im Tab Schrank „Reihen ordnen“ tippen.` | "" |
| `encl.rail_overflow` | warn | Σ device widths > ple·17.5 + 0.05 mm **and** row.slots ≠ ple (else the existing slot warning already says it) | `{row}: {mm} mm Geräte auf {ple} PLE Hutschiene.` | row |
| `encl.supplied_dangling` | info | `supplied_by` names no module, or a key that is no device fitting in its snapshot | `{bmk}: gehört zu keinem Modul mehr — zählt als eigenes Gerät.` | device |
| `encl.cross_module_feed` | warn | positional circuits (no `parent_id`) hang off a group head in another module or outside the cabinet | `{row}: {k} Stromkreis(e) hängen an {head} aus einem anderen Feld — FI davor setzen oder Einspeisung prüfen.` | row |
| `encl.unverified` | info | a used catalogue entry has `verified: false` (once per code) | `{art}: Katalogdaten ungeprüft — {unverified[0]}.` | module |
| `encl.meter_device` | info | a `meter` device on a board whose cabinet has meter places | `{bmk}: Zwischenzähler auf der Hutschiene — eHZ/3-Punkt gehören auf den Zählerplatz.` | device |
| `encl.meter_place_invalid` | info | `meters[].place` ≥ the module's places | `{art}: Zählerplatz {p} gibt es nicht — Eintrag wird ignoriert.` | module |
| `encl.terminals` | info | a field whose FI groups derive WAGO strips (group attributed to the field of its head device) | `Feld {n}: Reihenklemmen {k} Stück, {mm} mm Hutschiene — im Schrankbild nicht gezeichnet.` | "" |
| `vde.nar_sls` | warn | meter module m: #`sls` on m's NAR rails + SAS credit < need(m). SAS credit: `sls` on SAS rails in m's field or an adjacent one, each SLS credited once, to meter modules in field order | `Feld {n} ({art}): {have} SLS-Schalter für {need} Zählerplatz/-plätze im NAR.` | module |
| `vde.nar_contents` | warn | on a NAR rail: a `fuse`; or an `rcd`, `rcbo` or circuit kind other than an `mcb` rated ≤ 10 A (Spannungsabgriff) | `NAR {art}: NH/Neozed ist nicht als Trennvorrichtung zulässig — SLS verwenden.` / `NAR {art}: {short} gehört nicht in den NAR.` | device |
| `vde.sls_rating` | warn | module `wiring_mm2` set and an SLS on its NAR rated > 35 A (10 mm²) or > 50 A (16 mm²) | `Feld {n} ({art}): SLS {rating} zu groß für {mm2} mm² Feldverdrahtung (max. E{max}).` | device |
| `vde.aar_contents` | warn | AAR device kind ∉ {hauptschalter, rcd, rcbo, mcb, hlak, terminal, spd, blank, pv, wallbox} | `AAR {art}: {short} gehört nicht in den AAR — kein Stromkreisverteiler.` | device |
| `vde.aar_circuits` | warn | circuits (pv, wallbox included) on the module's AAR rails > 3·need(m), or a circuit rated > 16 A | `AAR {art}: höchstens drei Stromkreise je Zählerplatz, je max. 16 A.` | module |
| `vde.3p_main_switch` | warn | `meter_3p` module: #`hauptschalter` on its AAR rails < need(m) | `Hinter jedem 3-Punkt-Zähler in Feld {n} gehört ein Hauptschalter in den AAR ({have} von {need}).` | module |
| `vde.rfz_devices` | warn | on an RFZ or APZ rail: kinds rcd, rcbo, hauptschalter, sls, fuse, contactor, impulse, timer, bell_transformer, knx_actuator, wallbox, pv, sub_feed; or an `mcb` rated > 10 A or unrated | `RfZ/APZ ({art}) ist nur für Geräte des Netz-/Messstellenbetreibers.` | device |
| `vde.apz_missing` | warn | ≥ 1 meter module and no APZ zone | `Kein APZ im Schrank (mind. 300 mm, plombierbar).` | "" |
| `vde.apz_position` | warn | APZ zone touches neither the top nor the bottom unit of its field, or its field also holds a ZF zone | `APZ in Feld {n}: oben oder unten am Schrankrand und seitlich neben dem Zählerfeld.` | module |
| `vde.meter_place_empty` | info | a meter place without an entry | `Zählerplatz {p} in Feld {n} als Reserve geplant — Blindabdeckung steht auf der Materialliste.` | module |

The compliant reference board (fixture `meter_dist_zb33s`) yields **zero
warn** findings.

---

## 6. Materialliste

`planned_lines(document, catalog=None)` (`services/schaltplan_material.py`,
logic in `panel_enclosure_material.py`): when `document.enclosure` is set,
`material_lines` loads the catalogue once per request and passes it. Without
an enclosure the output is byte-identical to today (golden test).

| Order | kind | key | label | detail | planned |
|-------|------|-----|-------|--------|---------|
| 1 | `enclosure` | `enclosure:{code}` | spec.name | `Hager {art} · {H} × {W} × {D} mm · {n} Felder` | 1 |
| 2 | `enclosure` | `module:{code}` | spec.name, else `Modul {code} (unbekannt)` | `Hager {art} · {wf} Feld/Felder · {hu·U} mm` | count, first-placement order |
| 3 | `enclosure` | `accessory:{article_no}` | accessory label | `Zubehör · Hager {art}`; `Blindabdeckung freier Zählerplatz · Hager {art}`; suffix ` · ungeprüft` when `verified: false` | Σ qty (cabinet + modules + `free_place_cover.qty` × free places) |
| 4 | `device` | unchanged | on cabinet boards `meter` is labelled "Zwischenzähler (Hutschiene)" | | supplied devices **skipped** |
| 5 | `terminal` | unchanged | | | |
| 6 | `removed` | `removed:{module code}:{fitting key}` | snapshot label | `aus Modul entfernt → ins Lager · {module art}` | count |
| 7 | `manual` | unchanged | | | |
| 8 | `removed` | `salvage:{article_id}` (orphan) | article name | `eingelagert, im Plan nicht mehr als entfernt geführt` | 0 |
| 9 | `extra` | unchanged | | | |

* Meter places never produce lines (D7); free places produce cover lines.
* Article resolution: explicit mapping on the key, else auto-match (§3.4) on
  `article_no` (spec / accessory / snapshot fitting); `article_source`
  `mapping` | `auto`.
* `PUT /material/mapping` accepts `device:`, `part:`, `enclosure:`, `module:`,
  `accessory:` with `reports:create`, and `removed:` only with
  `werkstatt:manage` (403 otherwise). Everything else (`article:`,
  `salvage:` included) is still refused.
* **Consumption** (`consumption − consumption_undo`) is spread with
  `allocate_scans` over the lines of kinds `enclosure`, `device`, `terminal`,
  `manual` that name the article. Extras (`article:<id>`) are the consumed
  articles that **none of those** lines name. A consumed article that only a
  removed line names therefore shows as "nicht geplant".
* **Salvage** (`salvage − salvage_undo` rows with this `panel_id`) is spread
  over the `removed` lines that name the article. An article with net salvage
  > 0 that no removed line names gets the orphan line 8 (planned 0), so
  "Zurücknehmen" stays reachable after the fitting is restored, the module or
  cabinet is removed, or the line is remapped.
* Status (`_status`, unchanged) with kind-specific texts for `removed`:
  `open` "offen", `done` **eingelagert**, `over` / `unplanned`
  "zu viel eingelagert".
* `counts_toward_picking` excludes `removed` (returns are not picks), so
  `planned_total`, `scanned_total` and `open_lines` are unaffected. New total
  `returns_open = Σ max(planned − scanned, 0)` over removed lines, carried in
  `PanelMaterialOut` and `PanelMaterialSummaryOut`; the Werkstatt Verteiler
  overview shows a chip "{n} × ins Lager offen".
* `line_for_article` ignores `removed` lines. Station endpoints
  (`workflow_station_werkstatt` panel GET/scan/undo) return
  `material.picking_view(...)` (the same payload without `removed` lines). A
  station scan of an article that only removed lines name answers **409**
  `Rücklauf: in der Materialliste „Ins Lager“ buchen, nicht scannen.` The Pi
  kiosk needs no change (it shows `detail`).
* Ledger (`werkstatt_movements.py`, Slice P): `_DELTAS["salvage"] = {total:+1,
  available:+1}`, `_DELTAS["salvage_undo"] = {total:-1, available:-1}`.
  `apply_movement` refuses `salvage_undo` with quantity > `stock_available`
  (the `inventory_minus` guard). Both types join `WerkstattMovementType`
  (schemas/werkstatt.py: a missing Literal 500s every movement list),
  `types/werkstatt.ts` and the label maps: German "Rücklauf aus Verteiler" /
  "Rücklauf storniert", direction in / out (`werkstattOverviewFormat.ts`,
  `mobileLabels.ts`, `DashboardMovementsCard.tsx`, `MaschineDetailPanel.tsx`
  if it maps types; kiosk `MOVE` map optional, since unknown types already
  fall back to grey).
* Project Material tab (`project_panel_materials`): unchanged in v1
  (consumption only) until Q4 is answered.
* Materialliste PDF `_KIND_TEXT`: `enclosure` "Schrank/Modul", `removed`
  "aus Modul entfernt → ins Lager". Removed and orphan lines print in their
  own block "Aus Modulen entfernt → ins Lager" after the planned lines.

---

## 7. API

All under `/api/schaltplan`. The partner fence covers new routes by endpoint
identity (no extra work; the route-walk test must stay green).

| Method | Path | Permission | Request | Response | Errors |
|--------|------|------------|---------|----------|--------|
| GET | `/enclosure-catalog` | login | — | `EnclosureCatalogOut` | — |
| POST | `/enclosure-catalog` | `werkstatt:manage` | `CatalogEntryIn` | `CatalogEntryOut` 201 | 409 `Den Code {code} gibt es schon.`; 413 `Eintrag zu groß (max. 32 KB).`; 422 `Aufbau ungültig: {path} — {message}` |
| PUT | `/enclosure-catalog/{code}` | `werkstatt:manage` | `CatalogEntryIn` (body code = path code) | `CatalogEntryOut` | 404 `Katalogeintrag nicht gefunden.`; 400 code mismatch; 400 `Der Typ eines Eintrags lässt sich nicht ändern.`; 409 `Schlüssel „{key}“ bleibt — ausmustern statt löschen oder umbenennen.`; 409 `In {n} Verteilerplänen verwendet — Größe, Familie und Zählerplätze bleiben. Als neuen Eintrag anlegen.`; 413; 422 |
| PATCH | `/enclosure-catalog/{code}` | `werkstatt:manage` | `{archived: bool}` | `CatalogEntryOut` | 404 |
| DELETE | `/enclosure-catalog/{code}/override` | `werkstatt:manage` | — | `CatalogEntryOut` (built-in again) | 404; 409 `Eigene Einträge werden archiviert, nicht gelöscht — Verteilerpläne verweisen darauf.`; the two 409s of PUT when the reset would break §3.5 |
| GET | `/panels/{id}/aufbau/pdf` | login + `_assert_readable` | — | `application/pdf`, inline, `Aufbau_{VT}_{date}.pdf` | 404; 409 `Für diesen Verteiler ist kein Schrank geplant.` |
| POST | `/panels/{id}/material/salvage` | **`werkstatt:manage`** + readable | `PanelMaterialBookRequest` | `PanelMaterialOut` | 404 article; 400 `Artikel ist archiviert — keine Buchungen möglich.`; 400 `Maschinen kommen nicht über die Materialliste ins Lager.`; 400 `Dieser Artikel steht nicht als „aus Modul entfernt“ auf der Liste.`; 400 `Mehr als aus Modulen entfernt — offen sind noch {n}.` |
| POST | `/panels/{id}/material/unsalvage` | **`werkstatt:manage`** + readable | `PanelMaterialBookRequest` | `PanelMaterialOut` | 400 `Nichts zum Zurücknehmen — für {VT} sind nur {n} × „{name}“ eingelagert.`; 400 `Schon wieder ausgegeben oder verbaut — erst den Bestand prüfen.` (quantity > `stock_available`); serialized/archived as above |
| PATCH/POST | `/panels…` (existing) | unchanged | document may carry `enclosure`, `supplied_by` | `PanelPlanOut` with enclosure findings (`rule` set) | 400 newly introduced unknown code (§2.2) |
| POST | `/panels/{id}/duplicate` (existing) | unchanged | — | copy with `meters[].number` cleared | no code check |
| PUT | `/material/mapping` (existing) | `reports:create`; `removed:` keys need `werkstatt:manage` | wider key prefixes (§6) | unchanged | 403 `Rückläufe ordnet die Werkstatt zu.` |

```text
CatalogEntryIn   { entry_type: "enclosure" | "module", spec: EnclosureSpec | ModuleSpec }   // ≤ 32 KB raw body, checked before parsing; ≤ 500 custom rows
CatalogEntryOut  { code, entry_type, source: "builtin" | "custom" | "override", archived: bool, invalid: bool,
                   spec | null, article: PanelMaterialArticleOut | null, article_source: "mapping" | "auto" | null,
                   stock_available: int, recent_count: int, last_used_at: datetime | null, used_by_plans: int }
EnclosureCatalogOut { enclosures: CatalogEntryOut[], modules: CatalogEntryOut[], can_manage: bool,
                      uncatalogued: { article: PanelMaterialArticleOut, code_guess: string }[] }   // [] unless can_manage
```

Spec validation errors are returned in German with the JSON path
(`zones[2].rails[0].ple: muss zwischen 1 und 24 liegen`); the router maps
Pydantic `loc`/`type` to a short German message with a generic fallback.
Archived and invalid entries are returned (flags set) so every stored code
renders; pickers hide them. Every catalogue write writes an audit row via
`log_admin_action(db, user, "schaltplan.catalog.{create|update|archive|unarchive|reset}", "panel_catalog_entry", code, {...})`
**after** the main commit (the helper commits). Salvage rows carry
`notes = booking_note(plan, "Rücklauf")`, `user_id`, `project_id`, `panel_id`.

Routers: catalogue endpoints in new `routers/workflow_schaltplan_catalog.py`;
Aufbau PDF in new `routers/workflow_schaltplan_enclosure.py`; salvage in the
existing `workflow_schaltplan_material.py`. The type-label routes move out of
`workflow_schaltplan.py` into new `routers/workflow_schaltplan_type_label.py`
(pure move, ≈ 90 lines) so that file ends ≤ 800 lines. `main.py` mounts the
new routers **before** `workflow_schaltplan.router`, next to the material
router.

---

## 8. Migration

One revision `20261021_0104_panel_catalog_entries.py`, `revision =
"20261021_0104"`, `down_revision = "20261022_0105"`: create
`panel_catalog_entries` (§3.3) with a unique index on `code`; downgrade drops
it. Additive, no backfill, no data change. It ships in **Slice P** (§9, §16)
so every later image knows the head. Written on `20261020_0102`; v2.14.42 put
`20261022_0105` (`app_settings.value` TEXT, the permission-overrides fix) on
top of 0102, so v2.14.43 re-pointed 0104 onto 0105: the chain is
`0101 → 0102 → 0105 → 0104`. Whoever merges after the 0103 branch
re-points `down_revision` (`tests/test_alembic_single_head.py` guards). Verify
upgrade/downgrade on a throwaway PostgreSQL 16 and keep
`apps/api/scripts/check_schema_drift.py` at 0. Everything else (document keys,
ledger types) needs no migration: JSON column, `String(32)` type column
without a CHECK.

---

## 9. File plan, ownership and build order

Builders work on **disjoint files**. A slice may read anything; it writes only
its own rows. Interfaces in §10 are the contract between slices.

**Order** (each arrow = "needs"):

```text
0 (page refactor) ──────────────────────────────┐
P (prep release) ─→ A (schemas, data) ─┬─→ B (layout, geometry, rules, fixture writer → PDF last)
                    D-types ←──────────┤        │ fixture committed early
                                       ├─→ C (material, salvage)
                                       └─→ D (TS core; parity tests once B's fixture exists)
                                                 └─→ E (2D UI, needs 0 + D) ─→ F (3D, admin)
```

Slice 0 and Slice P can start at once. B, C and D run in parallel once A and
the D types exist. E starts after 0 and D; F after E (F's admin mounts into
E's sheet stack through the props in §10.2).

### Slice 0 — page refactor (web, behaviour-preserving plus three fixes)

| File | New/Chg | Responsibility |
|------|---------|----------------|
| `src/hooks/usePanelDocumentEditor.ts` | new | `mutate`, autosave (`scheduleSave`, `flush`, `settleSaves`), all device/row ops moved out of the page; `removeDevice` goes through `removeDevices` (Slice D helper; until then local) |
| `src/components/schaltplan/PanelEditorHeader.tsx` | new | identity + action buttons; PDF actions via `openAfterSave` |
| `src/utils/openAfterSave.ts` | new | opens the window synchronously, `await settleSaves()`, then navigates (`win.opener = null`); closes it and reports on failure (iOS popup rule) |
| `src/pages/SchaltplanPage.tsx` | chg | uses hook + header; ends **≤ 800 lines** (952 today) |
| fixes | | (1) `flush` shows `Nicht gespeichert: {detail}` for a 4xx and keeps the connection hint for network errors/5xx; (2) switching to Material/Klemmen awaits `settleSaves()` ("Speichert…"); (3) `PanelMaterialList` is keyed on `panel.revision` |

### Slice P — preparatory release (Python + small web)

| File | New/Chg | Responsibility |
|------|---------|----------------|
| `alembic/versions/20261021_0104_panel_catalog_entries.py`, `app/models/schaltplan.py`, `app/models/entities.py` | new/chg | §8 table + model (unused in P) |
| `app/schemas/schaltplan.py` | chg | `MAX_ROWS = 120`; `PanelDocument.enclosure: dict[str, Any] \| None` pass-through (≤ 64 KB as JSON); `PanelDevice.supplied_by: dict[str, str] \| None` pass-through (≤ 4 keys, values ≤ 64) |
| `app/services/schaltplan_layout.py`, `src/utils/schaltplanDevices.ts` | chg | `hlak` in `DEVICE_CATALOG` after `distribution_block`: label "Hauptleitungsabzweigklemme (HLAK)", short "HLAK", te 4, poles 3, group/circuit False, symbol `terminal`, rating_hint ""; TS: not offered in the palette (palette filter added in E); TS `MAX_ROWS = 120` |
| `app/services/werkstatt_movements.py`, `app/schemas/werkstatt.py` | chg | `salvage`, `salvage_undo` + the `salvage_undo` stock guard |
| `src/types/werkstatt.ts`, `utils/werkstattOverviewFormat.ts`, `components/werkstatt/mobile/mobileLabels.ts`, `components/werkstatt/dashboard/DashboardMovementsCard.tsx`, `components/werkstatt/MaschineDetailPanel.tsx`, `tools/label_agent/static/kiosk_rack.html` (MOVE map, optional) | chg | movement labels and direction (§6) |
| tests | new | `test_panel_enclosure_prep.py` (§14) |

### Slice A — catalogue & schema (Python)

| File | New/Chg | Responsibility |
|------|---------|----------------|
| `app/schemas/panel_enclosure.py` | new | document parts (§2.2), catalogue specs (§3.1), API in/out (§7), German error mapping |
| `app/schemas/schaltplan.py` | chg | typed `PanelDevice.supplied_by`, `PanelDocument.enclosure` (same JSON as P), `PanelFinding.rule`, `PanelMaterialLineKind` += `enclosure`, `removed`; totals `returns_open` |
| `app/services/panel_enclosure_catalog_data*.py` | new | built-in entries (§3.2), data only |
| `app/services/panel_enclosure_catalog.py` | new | `EnclosureCatalog`, merge, invalid entries, annotate, CRUD, change rules (§3.5), code check |
| `apps/api/tests/fixtures/enclosure_catalog_shipped.json` | new | §3.5 rule 3 |
| `app/routers/workflow_schaltplan_catalog.py` | new | catalogue endpoints, raw-body size check |

### Slice B — layout, geometry, findings, PDF (Python) + wiring

| File | New/Chg | Responsibility |
|------|---------|----------------|
| `app/services/panel_enclosure_layout.py` | new | §2.3: resolvable rails, `linked_rows`, `physical_row_order`, device width |
| `app/services/panel_enclosure_geometry.py` | new | §4 |
| `app/services/panel_enclosure_rules.py` | new | §5 |
| `app/services/panel_enclosure_service.py` | new | `detail_findings`, `assert_known_codes` wiring (keeps the plan router small) |
| `app/services/panel_enclosure_pdf.py` | new | Aufbau sheet + combined PDF (§13) |
| `app/services/schaltplan_material_pdf.py` | chg | extract `draw_material_pages(c, *, material, company_name)`; `build_material_pdf` becomes a wrapper; kind texts + removed block (§6) |
| `app/routers/workflow_schaltplan_enclosure.py`, `workflow_schaltplan_type_label.py` | new | Aufbau PDF route; moved type-label routes |
| `app/routers/workflow_schaltplan.py` | chg | `_detail` appends `detail_findings`; create/update call `assert_known_codes(stored=…)`; duplicate clears meter numbers; type-label routes removed → **≤ 800 lines** |
| `app/main.py` | chg | mount catalogue, enclosure and type-label routers |
| `apps/api/scripts/write_enclosure_fixtures.py` | new | writes `apps/web/src/test/fixtures/enclosureFixtures.json` (§14); first deliverable of B |

### Slice C — Materialliste & salvage (Python + Werkstatt UI chip)

| File | New/Chg | Responsibility |
|------|---------|----------------|
| `app/services/panel_enclosure_material.py` | new | snapshot fittings, enclosure/accessory/removed/orphan lines, supplied set, token-boundary matching, salvage booking with guards |
| `app/services/schaltplan_material.py` | chg | `planned_lines(…, catalog)`, catalogue load, split consumption/salvage allocation, `counts_toward_picking`, `returns_open`, `line_for_article`, `picking_view` (stays < 800 lines; logic lives in the new module) |
| `app/routers/workflow_schaltplan_material.py` | chg | salvage/unsalvage routes (`werkstatt:manage`); mapping prefixes + `removed:` permission |
| `app/routers/workflow_station_werkstatt.py` | chg | `picking_view` on panel GET/scan/undo; 409 for removed-only articles |
| `src/pages/werkstatt/WerkstattVerteilerPage.tsx` (or its card) | chg | chip "{n} × ins Lager offen" |

### Slice D — web core (pure TS, no React)

| File | New/Chg | Responsibility |
|------|---------|----------------|
| `src/types/panelEnclosure.ts` | new | all enclosure/catalogue/scene types (§2.2, §3.1, §4) |
| `src/types/schaltplan.ts` | chg | `enclosure?`, `supplied_by?`, `rule?`, `DeviceKind` += `hlak`, `PanelMaterialLineKind` += `enclosure`, `removed`, `returns_open` |
| `src/utils/schaltplanDevices.ts` | chg | `emptyDocument({enclosureCode})`; `meter` label "Zwischenzähler (Hutschiene)" when a cabinet exists (`deviceLabel(kind, doc)`) |
| `src/utils/schaltplanDocumentOps.ts` | chg | `duplicateDevice` clears `supplied_by`; `removeDevices(doc, ids)` (clears `parent_id` references and `terminal_labels` keys `"{id}:…"`) |
| `src/utils/enclosureCatalog.ts` | new | `catalogIndex`, fit helpers (`freeRuns`, `fitsAt`) |
| `src/utils/enclosureLayout.ts` | new | §2.3 twin |
| `src/utils/enclosureGeometry.ts` | new | §4 |
| `src/utils/enclosureRules.ts` | new | §5 |
| `src/utils/enclosureFeeds.ts` | new | §2.4 |
| `src/utils/enclosureOps.ts` | new | document ops (§10.2) |
| `src/utils/schaltplanEnclosureApi.ts` | new | API calls (§10.2) |
| `src/hooks/useEnclosureCatalog.ts` | new | session-cached catalogue + index, `reload()` |

### Slice E — web UI (2D)

| File | New/Chg | Responsibility |
|------|---------|----------------|
| `src/pages/SchaltplanPage.tsx` | chg | tab `schrank` ("Schrank", between Plan and Aufbau); boards with a cabinet open on it; stays ≤ 800 lines |
| `src/components/schaltplan/enclosure/EnclosureTab.tsx` | new | toolbar, view switch, field bar, sheet stack, findings list, lazy 3D |
| `…/enclosure/useSheetStack.ts` | new | one stack, one backdrop, back/Escape pops |
| `…/enclosure/EnclosureFrontSvg.tsx` | new | SVG renderer of a scene; one tap rule (§11) |
| `…/enclosure/EnclosureFieldBar.tsx` | new | ≥ 56 px buttons per module / free field |
| `…/enclosure/EnclosureToolbar.tsx` | new | Offen/Geschlossen/3D, zoom, Reihen ordnen, Aufbau als PDF |
| `…/enclosure/EnclosurePickerSheet.tsx` | new | choose/change/remove cabinet |
| `…/enclosure/ModulePickerSheet.tsx` | new | sections Im Lager / Zuletzt verwendet / Hager univers Z / nicht im Katalog; claim preview; wrong heights hidden with a count |
| `…/enclosure/ModuleSheet.tsx` | new | position, swap, fittings, meters, label, snapshot refresh, remove |
| `…/enclosure/RailSheet.tsx` | new | one rail as 56 px tiles (reuses `RailRow`), + Gerät, Aus Vorlage füllen, Reihe einhängen |
| `…/enclosure/RailPickerSheet.tsx` | new | "Auf andere Hutschiene…" target list |
| `…/enclosure/RegroupConfirm.tsx` | new | confirm for `regrouped` |
| `src/components/schaltplan/RailEditor.tsx` | chg | group rows by module + "Nicht im Schrank"; export `RailRow`; linked rows: slots read-only, no remove, no row move |
| `src/components/schaltplan/DeviceInspector.tsx` | chg | supplied banner (+ "ungeprüft" note); "Auf andere Hutschiene…" (cabinet boards); prop `suppliedBy: {article: string; unverifiedNote: string \| null} \| null` |
| `src/components/schaltplan/DevicePalette.tsx` | chg | `hlak` only on cabinet boards; `meter` label via `deviceLabel` |
| `src/components/schaltplan/PanelDataTab.tsx` | chg | meters from the cabinet instead of `supply.meter_number` |
| `src/components/schaltplan/NewPanelDialog.tsx` | chg | optional cabinet select |
| `src/components/schaltplan/PanelMaterialRow.tsx`, `PanelMaterialList.tsx`, `panelMaterialTexts.ts` | chg | removed/orphan lines: "Ins Lager" / Zurücknehmen (enabled with `werkstatt:manage`, else hint) |
| `src/styles/schaltplan-enclosure.css` | new | `.sp-encl-*` styles, own scroll container |

### Slice F — 3D and catalogue admin

| File | New/Chg | Responsibility |
|------|---------|----------------|
| `apps/web/package.json`, `package-lock.json` | chg | `"three": "0.186.1"` (dependency), `"@types/three": "0.186.0"` (devDependency), exact pins |
| `src/components/schaltplan/enclosure/Enclosure3DView.tsx` | new | lazy default export; renderer lifecycle, presets, door leaves |
| `…/enclosure/Enclosure3DBoundary.tsx` | new | local error boundary + retry (§12) |
| `…/enclosure/enclosureThreeScene.ts` | new | pure scene-graph builder from `SceneBox[]` + `disposeGroup` |
| `…/enclosure/EnclosureCatalogAdmin.tsx` | new | list, archive/unarchive, reset, open form (props §10.2) |
| `…/enclosure/CatalogEntryForm.tsx` | new | metadata fields + "Aufbau (JSON)" textarea + live preview in a one-field dummy cabinet via `buildEnclosureScene` + `EnclosureFrontSvg` (readOnly); "Vorlage: wie …" copy |
| `src/styles/schaltplan-enclosure-admin.css` | new | admin styles |

`App.tsx` is untouched (SchaltplanPage is already lazy). Every new file
< 800 lines, functions < 50 lines where practical, immutable updates only.

---

## 10. Interfaces between slices

### 10.1 Python

```python
# app/services/panel_enclosure_catalog.py  (Slice A)
@dataclass(frozen=True)
class CatalogEntry:
    code: str
    entry_type: Literal["enclosure", "module"]
    spec: dict[str, Any] | None               # validated spec .model_dump(); None ⇔ invalid
    source: Literal["builtin", "custom", "override"]
    archived: bool
    invalid: bool = False

@dataclass(frozen=True)
class EnclosureCatalog:
    entries: Mapping[str, CatalogEntry]
    def enclosure(self, code: str) -> dict[str, Any] | None: ...   # None for unknown or invalid
    def module(self, code: str) -> dict[str, Any] | None: ...
    def known(self, code: str) -> bool: ...                          # archived/invalid count as known
    @classmethod
    def from_out(cls, payload: dict[str, Any]) -> "EnclosureCatalog": ...   # fixture / API JSON → catalog

class CatalogError(Exception):
    def __init__(self, status_code: int, message: str) -> None: ...

def builtin_catalog() -> EnclosureCatalog: ...                 # pure, no DB
def load_catalog(db: Session) -> EnclosureCatalog: ...
def document_codes(document: dict[str, Any]) -> set[str]: ...
def unknown_codes(document: dict[str, Any], catalog: EnclosureCatalog, *, stored: dict[str, Any] | None) -> list[str]: ...
def assert_known_codes(db: Session, document: dict[str, Any], *, stored: dict[str, Any] | None) -> None: ...   # HTTPException 400
def codes_in_use(db: Session) -> dict[str, int]: ...           # code → number of plans (all plans)
def check_change(old: dict[str, Any] | None, new: dict[str, Any], *, used_by: int) -> None: ...  # CatalogError 409 (§3.5)
def catalog_out(db: Session, user: User, catalog: EnclosureCatalog) -> EnclosureCatalogOut: ...
def create_entry(db: Session, *, payload: CatalogEntryIn, user: User) -> CatalogEntry: ...
def update_entry(db: Session, *, code: str, payload: CatalogEntryIn, user: User) -> CatalogEntry: ...
def set_archived(db: Session, *, code: str, archived: bool, user: User) -> CatalogEntry: ...
def reset_override(db: Session, *, code: str, user: User) -> CatalogEntry: ...

# app/services/panel_enclosure_layout.py  (Slice B)
def resolvable_rails(module: dict[str, Any], catalog: EnclosureCatalog) -> dict[str, tuple[dict, dict]]: ...  # key → (zone, rail)
def linked_rows(document: dict[str, Any], catalog: EnclosureCatalog) -> dict[str, tuple[str, str]]: ...      # row id → (module id, rail key)
def physical_row_order(document: dict[str, Any], catalog: EnclosureCatalog) -> list[str]: ...
def enclosure_device_width_mm(device: dict[str, Any], rail: dict[str, Any]) -> float: ...

# app/services/panel_enclosure_geometry.py  (Slice B)
def build_enclosure_scene(document: dict[str, Any], catalog: EnclosureCatalog,
                          *, view: Literal["open", "closed"] = "open") -> dict[str, Any] | None: ...
def round1(value: float) -> float: ...

# app/services/panel_enclosure_rules.py  (Slice B)
def enclosure_findings(document: dict[str, Any], catalog: EnclosureCatalog) -> list[dict[str, str]]: ...

# app/services/panel_enclosure_service.py  (Slice B)
def detail_findings(db: Session, document: dict[str, Any]) -> list[dict[str, str]]: ...   # [] without enclosure; loads catalogue only then

# app/services/panel_enclosure_pdf.py  (Slice B)
def pick_scale(width_mm: float, height_mm: float, box_w_pt: float, box_h_pt: float) -> int: ...  # 5 | 8 | 10 | 15 | 20
def build_aufbau_pdf(*, plan: PanelPlan, catalog: EnclosureCatalog, material: PanelMaterialOut,
                     findings: list[dict[str, str]], customer_name: str | None,
                     project_label: str | None, company_name: str | None) -> bytes: ...

# app/services/panel_enclosure_material.py  (Slice C)
@dataclass(frozen=True)
class RemovedFitting:
    module_id: str; module_code: str; module_article_no: str
    fitting_key: str; label: str; article_no: str | None

def module_fittings(module: dict[str, Any], catalog: EnclosureCatalog) -> list[dict[str, Any]]: ...  # snapshot, else catalogue
def supplied_device_ids(document: dict[str, Any], catalog: EnclosureCatalog) -> set[str]: ...
def removed_fittings(document: dict[str, Any], catalog: EnclosureCatalog) -> list[RemovedFitting]: ...
def enclosure_planned_lines(document: dict[str, Any], catalog: EnclosureCatalog) -> list[PlannedLine]: ...  # cabinet, modules, accessories, covers
def removed_planned_lines(document: dict[str, Any], catalog: EnclosureCatalog) -> list[PlannedLine]: ...
def line_article_numbers(document: dict[str, Any], catalog: EnclosureCatalog) -> dict[str, str]: ...  # line key → article_no
def match_articles_by_number(db: Session, numbers: list[str]) -> dict[str, WerkstattArticle]: ...    # whole-token matching
def salvaged_by_article(db: Session, panel_id: int) -> dict[int, _Consumed]: ...
def book_salvage(db: Session, *, plan: PanelPlan, article: WerkstattArticle, quantity: int, user_id: int) -> WerkstattMovement: ...    # MaterialError: archived, serialized, not removed, over
def undo_salvage(db: Session, *, plan: PanelPlan, article: WerkstattArticle, quantity: int, user_id: int) -> WerkstattMovement: ...    # MaterialError: net, stock_available, serialized

# app/services/schaltplan_material.py  (Slice C, changed)
LINE_ENCLOSURE = "enclosure"; LINE_REMOVED = "removed"
def planned_lines(document: dict[str, Any], catalog: EnclosureCatalog | None = None) -> list[PlannedLine]: ...
def material_lines(db: Session, plan: PanelPlan, catalog: EnclosureCatalog | None = None) -> list[PanelMaterialLineOut]: ...
def picking_view(material: PanelMaterialOut) -> PanelMaterialOut: ...
def removed_only(material: PanelMaterialOut, article_id: int) -> bool: ...   # station 409
```

### 10.2 TypeScript

```ts
// utils/enclosureCatalog.ts (Slice D)
export interface CatalogIndex {
  enclosure(code: string): EnclosureSpec | null;
  module(code: string): ModuleSpec | null;
  entry(code: string): CatalogEntry<EnclosureSpec | ModuleSpec> | null;
}
export function catalogIndex(catalog: EnclosureCatalog): CatalogIndex;
export function freeRuns(document: PanelDocument, index: CatalogIndex, field: number): { unit: number; units: number }[];
export function fitsAt(document: PanelDocument, index: CatalogIndex, code: string, field: number, unit: number,
                       ignoreModuleId?: string): string | null;   // null = fits, else German reason

// utils/enclosureLayout.ts / enclosureGeometry.ts / enclosureRules.ts (Slice D)
export function linkedRows(doc: PanelDocument, index: CatalogIndex): Map<string, { moduleId: string; railKey: string }>;
export function physicalRowOrder(doc: PanelDocument, index: CatalogIndex): string[];
export function enclosureDeviceWidthMm(device: PanelDevice, rail: RailSpec): number;
export function buildEnclosureScene(document: PanelDocument, index: CatalogIndex, view: "open" | "closed"): EnclosureScene | null;
export function enclosureFindings(document: PanelDocument, index: CatalogIndex): PanelFinding[];
export function round1(value: number): number;

// utils/enclosureFeeds.ts (Slice D)
export interface Regroup { deviceId: string; from: string; to: string }   // head ids, "" = Einspeisung
export function feedMap(doc: PanelDocument): Map<string, string>;
export function preserveFeeds(before: PanelDocument, after: PanelDocument, created: ReadonlySet<string>):
  { document: PanelDocument; pinned: string[]; regrouped: Regroup[] };

// utils/enclosureOps.ts (Slice D) — all pure, input never mutated, every op ends with
// normalizeEnclosure → orderRowsPhysically → pruneEmptyRailRows → preserveFeeds
export type OpResult =
  | { ok: true; document: PanelDocument; moduleId?: string; pinned: string[]; regrouped: Regroup[] }
  | { ok: false; error: string };
export function setEnclosure(doc: PanelDocument, index: CatalogIndex, code: string): OpResult;
export function removeEnclosure(doc: PanelDocument): PanelDocument;        // rows stay in place, supplied_by cleared
export function placeModule(doc: PanelDocument, index: CatalogIndex,
  args: { code: string; field: number; unit: number; adoptRows?: boolean; claim?: boolean }): OpResult;
export function previewClaims(doc: PanelDocument, index: CatalogIndex, code: string): { deviceIds: string[]; meterDeviceIds: string[] };
export function moveModule(doc: PanelDocument, index: CatalogIndex, moduleId: string, to: { field: number; unit: number }): OpResult;
export function swapModules(doc: PanelDocument, index: CatalogIndex, a: string, b: string): OpResult;
export function removeModule(doc: PanelDocument, index: CatalogIndex, moduleId: string): OpResult;
export function setFittingRemoved(doc: PanelDocument, index: CatalogIndex, moduleId: string, fittingKey: string, removed: boolean): OpResult;
export function refreshModuleSnapshot(doc: PanelDocument, index: CatalogIndex, moduleId: string): OpResult;
export function setMeter(doc: PanelDocument, moduleId: string, place: number, patch: Partial<EnclosureMeter> | null): PanelDocument;  // null = frei
export function setModuleLabel(doc: PanelDocument, moduleId: string, label: string): PanelDocument;
export function assignRowToRail(doc: PanelDocument, index: CatalogIndex, moduleId: string, railKey: string, rowId: string): OpResult;
export function ensureRailRow(doc: PanelDocument, index: CatalogIndex, moduleId: string, railKey: string): { document: PanelDocument; rowId: string } | { error: string };
export function addDeviceToRail(doc: PanelDocument, index: CatalogIndex, moduleId: string, railKey: string, kind: DeviceKind): OpResult;
export function fillRailFromTemplate(doc: PanelDocument, index: CatalogIndex, moduleId: string, railKey: string, templateId: string): OpResult;
export function moveDeviceToRail(doc: PanelDocument, index: CatalogIndex, deviceId: string, moduleId: string, railKey: string): OpResult;
export function orderRowsPhysically(doc: PanelDocument, index: CatalogIndex): OpResult;
export function normalizeEnclosure(doc: PanelDocument): PanelDocument;
export function railOfRow(doc: PanelDocument, index: CatalogIndex, rowId: string): { moduleId: string; railKey: string } | null;

// utils/schaltplanEnclosureApi.ts (Slice D)
export function getEnclosureCatalog(token: string | null): Promise<EnclosureCatalog>;
export function createCatalogEntry(token: string | null, body: CatalogEntryIn): Promise<CatalogEntry<EnclosureSpec | ModuleSpec>>;
export function updateCatalogEntry(token: string | null, code: string, body: CatalogEntryIn): Promise<CatalogEntry<EnclosureSpec | ModuleSpec>>;
export function setCatalogEntryArchived(token: string | null, code: string, archived: boolean): Promise<CatalogEntry<EnclosureSpec | ModuleSpec>>;
export function resetCatalogEntry(token: string | null, code: string): Promise<CatalogEntry<EnclosureSpec | ModuleSpec>>;
export function aufbauPdfUrl(panelId: number): string;
export function salvagePanelMaterial(token: string | null, panelId: number, articleId: number, quantity?: number): Promise<PanelMaterial>;
export function unsalvagePanelMaterial(token: string | null, panelId: number, articleId: number, quantity?: number): Promise<PanelMaterial>;

// hooks/useEnclosureCatalog.ts (Slice D)
export function useEnclosureCatalog(token: string | null): {
  catalog: EnclosureCatalog | null; index: CatalogIndex | null; loading: boolean; error: string | null; reload(): Promise<void>;
};

// components (Slice E/F)
EnclosureFrontSvg props: { scene: EnclosureScene; zoom: number; highlightDeviceId: string | null; selectedModuleId: string | null;
  onOpenRail(moduleId: string, railKey: string, deviceId: string | null): void; onOpenModule(moduleId: string): void;
  onPickSlot(field: number, unit: number): void; readOnly: boolean }
EnclosureFieldBar props: { document: PanelDocument; index: CatalogIndex; onOpenModule(id: string): void;
  onAddModule(field: number): void; readOnly: boolean }
EnclosureCatalogAdmin props: { token: string | null; catalog: EnclosureCatalog; onChanged(): Promise<void>; onClose(): void }
  // pushed onto EnclosureTab's sheet stack from ModulePickerSheet "Katalog verwalten" (only when catalog.can_manage)
Enclosure3DView (default export) props: { scene: EnclosureScene; onExit(): void }
enclosureThreeScene: buildThreeGroup(scene: EnclosureScene, opts: { doorOpen: boolean }): THREE.Group; disposeGroup(group: THREE.Group): void
```

Ops contract:

* **Rows cap**: any op that would make `rows.length > MAX_ROWS` returns
  `ok: false` with `Zu viele Reihen (max. 120) — erst leere Reihen entfernen.`
* **`placeModule`**: refuses via `fitsAt` (copy §11). Snapshots the
  non-retired fittings. For each device fitting: with `claim` (default true)
  takes the first device in row order **outside the cabinet** whose kind
  matches and that has no `supplied_by`, moves it to the fitting rail (keeps
  id, BMK, rating, `parent_id`) and sets `supplied_by`; otherwise creates
  one with `makeDevice(kind, {te, poles, rating, width_mm, supplied_by})`.
  Meter modules: with `claim`, up to `meter_places` `meter` devices outside
  the cabinet become `meters[]` entries (label = device label or BMK) and are
  deleted via `removeDevices`. All remaining places get empty entries; seeds
  `meters[0].number` from `supply.meter_number` (§2.1). Rows are created only
  for rails that receive a fitting device. `adoptRows` fills only empty
  **VT/VF** rails top → bottom with unlinked rows (their `slots` set to `ple`
  if the devices fit, else kept → overflow finding); it is offered only for
  modules with VT/VF rails. Created devices are excluded from
  `preserveFeeds`.
* **`moveModule` / `swapModules`**: `swapModules` only for equal size
  (`Nur Module gleicher Größe lassen sich tauschen.`). Rows whose label still
  equals the generated `F{field+1} · {zone label}{ n}` are relabelled.
* **`removeModule`**: deletes its supplied devices via `removeDevices`, drops
  rows that are then empty, and leaves the other rows in place as "Nicht im
  Schrank" (§2.3 puts them last).
* **`setFittingRemoved`**: `true` deletes the claimant via `removeDevices`, or
  adds the key to `removed_fittings`. `false` is idempotent: it does nothing
  when a claimant exists; otherwise it re-creates the device at index 0 of
  the rail row (`ensureRailRow`), or drops the key from `removed_fittings`.
* **`addDeviceToRail`**: `ensureRailRow` + append. An `sls` on a meter
  module's NAR rail also sets `parent_id = sls` on that module's
  `hauptschalter` devices that have none (SLS → HS feeder chain).
* **`fillRailFromTemplate`**: the rail must be empty (`Hutschiene ist nicht
  leer.`). It uses `rowFromTemplate(doc, templateId, {slots: ple})` numbering
  and keeps the rail row's id and label.
* **`moveDeviceToRail`**: appends the device to the target rail and keeps
  `supplied_by` (a pre-fitted part moved inside the cabinet is still the
  module's part). Its own feed is preserved like everyone else's.
* **`refreshModuleSnapshot`**: replaces `fittings` with the current catalogue
  (draft boards only, enforced by the UI). Claimants of keys that disappear
  have `supplied_by` cleared.
* **`normalizeEnclosure`**: gives duplicate module ids new ids and drops a
  second rail reference to the same row; the hook runs it before every
  `scheduleSave` on a cabinet board.
* **`removeDevices(doc, ids)`** (schaltplanDocumentOps) is the only way devices
  are deleted: by the page/hook, the fitting toggle, `removeModule` and claim
  conversion.

---

## 11. UI behaviour and German copy

Behaviour:

* Tab **Schrank** (`schrank`). No cabinet: empty state + "Schrank wählen".
  Boards with a cabinet open on Schrank (`openPanel` and after creation);
  others open on Plan as today (new boards without cabinet on Aufbau).
* Default view **Offen**. Zoom = stepped px/mm `[0.2, 0.3, 0.45, 0.65, 0.9, 1.3]`
  with buttons only (gloves; no pinch); the initial step is the largest
  whose width fits. Native scroll in `.sp-encl-scroll` (root `overflow-x:
  clip`).
* **Field bar** above the drawing (horizontally scrollable): one button per
  module, "Feld {n} · {art}", which opens ModuleSheet, plus "+ Modul in Feld
  {n}" per field with free units. Every button is ≥ 56 px high. This is the
  module entry point at every zoom.
* **One tap rule in the SVG**: a tap inside a rail band (rail box ± device
  height) opens **RailSheet** for that rail with the tapped device
  highlighted. Its 56 px tiles open the DeviceInspector, whose ‹ › still walks
  the board. A tap on module/zone background opens ModuleSheet (a
  convenience; the field bar is the primary path). A tap on a free unit opens
  ModulePickerSheet for that field and places at the tapped unit if the
  module fits there, else at the top of the free run. There is no "+" inside
  the SVG; RailSheet has "+ Gerät". All targets have `role="button"` with an
  `aria-label`.
* **Sheet stack** (`useSheetStack`): RailSheet → DeviceInspector → (Palette /
  RailPicker) stack with one backdrop; closing the inspector returns to
  RailSheet. On the Schrank tab the inspector is rendered inside the stack;
  the Plan tab keeps its own.
* **Confirm and toast**: an op with `regrouped` opens RegroupConfirm before
  applying; `pinned` shows a toast.
* **Geschlossen**: covers, device fronts in 46 mm slots, meter windows with
  numbers, blind plates on free places, seal marks, door leaves as outlines
  with handles.
* **3D**: lazy, behind `Enclosure3DBoundary`; buttons only (Front, Schräg,
  Seite, Tür auf/zu, +, −, 2D); `OrbitControls` as an extra. View-only.
* **RailEditor** groups: "Feld {n} · {art} {name}" per module (rails in
  position order), then "Nicht im Schrank". Linked rows: slots shown, not
  editable, no remove, no row move.
* **ModulePickerSheet** hides modules of the wrong field height and says how
  many; shows `ungeprüft` badges, stock counts, the claim preview ("Übernimmt:
  …") with the switch "Vorhandene Geräte übernehmen", and (managers) the
  uncatalogued stock section and "Katalog verwalten".
* **Findings**: the Schrank tab lists all enclosure findings with the
  disclaimer and the "Nicht automatisch geprüft" line; the "Prüfen:" banner
  shows one chip.
* **Freshness**: Material/Klemmen tabs and all PDF actions settle saves first
  (Slice 0).

Copy (exact strings; tests assert the bold ones):

| Where | Text |
|-------|------|
| Tab | **Schrank** |
| Empty state | **Noch kein Schrank geplant.** / Hager univers Z, 1100 oder 1400 mm hoch, 2 bis 5 Felder. / **Schrank wählen** |
| Cabinet picker | Schrank wählen · groups "1100 mm hoch", "1400 mm hoch" · item "{code} · {n} Felder · {H} × {W} × {D} mm · IP44 · Aufputz" · Schrank entfernen |
| Change refused | Der neue Schrank hat nur {n} Felder — erst die Module aus Feld {m} entfernen. / Höhe wechseln geht nur ohne Module — die Feldeinbausätze sind höhengebunden. |
| Remove cabinet confirm | Schrank aus dem Plan nehmen? Reihen und Geräte bleiben erhalten. |
| Toolbar | **Offen** · **Geschlossen** · **3D** · Verkleinern · Vergrößern · Reihen ordnen · **Aufbau als PDF** |
| Field bar | **Feld {n} · {art}** · **+ Modul in Feld {n}** |
| Module picker | Modul für Feld {n} · sections **Im Lager**, **Zuletzt verwendet**, **Hager univers Z**, **Im Lager, nicht im Katalog** · "{k} im Lager" · badge **ungeprüft** (title "Katalogdaten nicht vollständig geprüft") · "passt hier nicht: {reason}" · "{k} Module für {h} mm Felder ausgeblendet" · **Vorhandene Geräte übernehmen** · "Übernimmt: {list}" · Vorhandene Reihen übernehmen ({k}) · Katalog verwalten · Eintrag anlegen |
| Fit reasons | Für {fh} mm Felder — dieser Schrank hat {uh} mm. / Nicht genug Platz: {need} mm nötig, {free} mm frei. / Ragt über das letzte Feld hinaus. |
| Op refusals | **Zu viele Reihen (max. 120) — erst leere Reihen entfernen.** / Nur Module gleicher Größe lassen sich tauschen. / Hutschiene ist nicht leer. |
| Regroup confirm | **Stromkreise ändern ihre Einspeisung** · "{bmk}: {from} → {to}" ("Einspeisung" for none) · **Trotzdem ausführen** · Abbrechen |
| Pinned toast | **{n} Stromkreis(e) behalten ihre Einspeisung — fest eingetragen.** |
| Module sheet | Position · Feld ← · Feld → · Nach oben · Nach unten · Mit Modul tauschen… · **Vorbestückt** · "verbaut" / "**entfernt → ins Lager**" / "fest verbaut" · Zählerplätze · Zählerplatz {p} · "belegt" / "**frei (Blindabdeckung)**" · Zählernummer · Bezeichnung (z. B. WE 1) · Bezeichnung des Feldes · Katalog geändert — Vorbestückung neu übernehmen · **Modul entfernen** |
| Remove module confirm | Modul entfernen? Vorbestückte Geräte gehen mit; Reihen mit eigenen Geräten bleiben als „Nicht im Schrank“ im Plan. |
| Rail sheet | **+ Gerät** · **Aus Vorlage füllen** · Vorhandene Reihe hier einhängen |
| Rail picker | Hutschiene wählen · "Feld {n} · {zone} · {free} PLE frei" |
| RailEditor | Feld {n} · {art} {name} · **Nicht im Schrank** |
| Inspector | **Vorbestückt in {art}** — Löschen heißt: aus dem Modul entfernen; es kommt als „ins Lager“ auf die Materialliste. · (unverified) "Katalog ungeprüft: {note}" · **Auf andere Hutschiene…** |
| Palette | `meter` on cabinet boards: **Zwischenzähler (Hutschiene)** |
| Daten tab | Zähler im Schrank: {list} — im Tab Schrank bearbeiten. |
| New panel dialog | Schrank · "ohne Schrank (nur Hutschienen)" |
| Material, removed line | detail "aus Modul entfernt → ins Lager · {art}" · buttons **Ins Lager** / Zurücknehmen · status **eingelagert** / "zu viel eingelagert" · without permission: "Ins Lager bucht die Werkstatt." |
| Werkstatt overview | {n} × ins Lager offen |
| Save errors | **Nicht gespeichert: {detail}** · (network) Änderungen konnten nicht gespeichert werden. Prüfe die Verbindung. · tab switch "Speichert…" |
| 3D | 3D wird geladen… · **3D ist auf diesem Gerät nicht verfügbar — die 2D-Ansicht zeigt dasselbe.** · **3D konnte nicht geladen werden.** · 3D neu laden · Front · Schräg · Seite · Tür auf · Tür zu · 2D |
| Findings | Prüfhilfe nach VDE-AR-N 4100:2026-04 — ersetzt nicht die TAB des Netzbetreibers. · Nicht automatisch geprüft: … (§5) · chip **Schrank: {n} Hinweise** |
| Admin | Schrankkatalog · Eintrag anlegen · Bearbeiten · Archivieren · Wiederherstellen · Auf Hager-Standard zurücksetzen · Vorlage: wie … · Aufbau (JSON, für Fortgeschrittene) · Vorschau · Quelle (https-Link) · geprüft · Artikelnummer · Bezeichnung · Familie · Feldhöhe · Breite (Felder) · Höhe (Raster à 150 mm) · Notiz · "In {n} Plänen verwendet" |

---

## 12. 3D view

* `React.lazy` inside `EnclosureTab`, created by a factory so a retry gets a
  fresh import; Vite emits its own `chunks/Enclosure3DView-*.js`. The
  SchaltplanPage chunk must not import `three` anywhere (test greps the built
  manifest / source).
* `Enclosure3DBoundary` (local class boundary around `Suspense`) catches a
  failed chunk fetch (weak site network, or a stale tab after a deploy removed
  the hashed chunk) and render errors. It shows "3D konnte nicht geladen
  werden." + "3D neu laden" (new lazy instance) + "2D". The error never
  reaches `AppErrorBoundary`.
* Imports allowed: `three`, `three/addons/controls/OrbitControls.js`. Forbidden
  (test reads the source): `three/addons/loaders`, `three/addons/libs`,
  `Worker(`, `OffscreenCanvas`, `fetch(`.
* Geometry: one `BoxGeometry` per box kind+size cached, `MeshLambertMaterial`
  per kind colour, `EdgesGeometry` outlines for module/zone/device. Cover-layer
  boxes skipped (open interior). Each door leaf is a pivot group, opened 100°
  about its outer edge. y-flip from scene coordinates.
* Render on demand (controls `change`, resize, door toggle); no rAF loop.
  `pixelRatio = min(devicePixelRatio, 2)`, `powerPreference: "low-power"`,
  `antialias: true`, `touch-action: none` on the canvas only.
* WebGL2 missing → fallback text; `webglcontextlost` → "3D neu laden".
  Unmount: dispose geometries, materials, controls, renderer,
  `forceContextLoss()`; idempotent under StrictMode double-mount.

## 13. PDF "Aufbau"

`GET /panels/{id}/aufbau/pdf` (button via `openAfterSave`): page 1 A4
landscape, 12 mm margins, drawing box 180 × 180 mm on the left. Front view
(open) at the largest of 1:5, 1:8, 1:10, 1:15, 1:20 that fits the box (never
an arbitrary shrink; "Maßstab 1:{n}" printed; every shipped cabinet lands on
1:8). Boxes come from `build_enclosure_scene`; devices are labelled with BMK
(rotated or hidden per §4), meters with numbers, free places "frei". Right
column (85 mm): title block (VT number, name, customer, project, cabinet
article, date, plan status), per-field module list, pre-fitted parts,
"Aus Modulen entfernt → ins Lager", warn findings under "Hinweise (VDE-AR-N
4100) — Prüfhilfe, ersetzt keine Abnahme". Each list stops at the column
bottom with "… und {n} weitere" (the full findings follow on the Materialliste
pages' last page). Then the Materialliste pages (portrait) via
`draw_material_pages`. Text only via `canvas.drawString` (never Paragraph
markup). Shared style from `schaltplan_pdf_style.py`.

---

## 14. Test plan (write first; RED before GREEN)

Parity anchor: `apps/api/scripts/write_enclosure_fixtures.py` writes
`apps/web/src/test/fixtures/enclosureFixtures.json`:
`{catalog: EnclosureCatalogOut-subset, boards: {name: {document, order, scene_open, scene_closed, findings}}}`
for these boards:

* `meter_dist_zb33s`: compliant. ZH3EH16 + SLS (HS fed by it), ZU37KS rows
  each starting with an FI, ZU37VT5APZ2 with APZ. Zero warns.
* `violations_zb34s`: no SLS; 4 AAR circuits including a B20; contactor in
  the AAR; Neozed and an RCD on the NAR; LS B16 on the RfZ; a custom fixture
  module with the APZ in the middle; a 3-Punkt without HS; an SLS E50 on
  10 mm²; a ZH3EL22 with 2 occupied places and 1 SLS.
* `removed_dangling_zb52s`: HS deleted, `removed_fittings`, dangling
  `supplied_by`, unknown module code, a row behind an unknown rail key, an
  overflowing rail, an unlinked row, an out-of-range meter place, a free place.
* `tall_zb54s`: ZH5EL27, ZU59KS, ZH53X3, ZH53XS with an SLS on the SAS
  (credited to the adjacent meter field), ZU62A, a gap.
* `cross_feed_zb33s`: field 2's first VT row starts with LS that hang
  positionally off FI F1 in field 0; field 1 empty; rows stored out of
  physical order (`encl.row_order`, `encl.cross_module_feed`). This is the
  base of the TS feed-preservation tests.

Python asserts its output equals the file ("re-run the script" on mismatch);
TS asserts the same, including `order`.

API (`apps/api/tests/`, SQLite, helpers from `test_schaltplan.py`):

| File | Asserts |
|------|---------|
| `test_panel_enclosure_prep.py` (P) | legacy doc round-trips byte-identical; `enclosure`/`supplied_by` pass through unchanged; `hlak` device validates and GET 200; 120 rows → 200, 121 → 422; a `salvage` row → Werkstatt movement list 200 and stock recompute correct; `salvage_undo` > `stock_available` refused |
| `test_panel_enclosure_schema.py` | legacy doc round-trips (enclosure None, `supplied_by` None, findings unchanged); duplicate module ids / one row on two rails / > 50 modules / bad code pattern → 422; new unknown code on POST / PATCH → 400; **stored unknown code + PATCH editing another device → 200**; duplicate of a board with a stored unknown code → 200 with meter numbers cleared; doc with unknown code stored directly → GET 200 + `encl.unknown_code`; **invalid custom spec in the DB → GET 200, PATCH 200, Materialliste unchanged** |
| `test_panel_enclosure_catalog.py` | built-ins: exactly the 8 cabinet codes, width/units arithmetic, every module spec validates, keys unique, fitting kinds ∈ `DEVICE_KINDS`, `verified false ⇒ unverified ≠ []`, every SAS has a busbar rail, every meter module a NAR busbar rail; **shipped file: no built-in disappears, keys append-only, frozen fields unchanged**; GET as plain user (`can_manage` false, `uncatalogued` []); mapped article with stock sorts first; recent counts only visible plans; uncatalogued Hager stock for managers; POST/PUT/PATCH/DELETE 403 without `werkstatt:manage`; create, 409 duplicate, override + reset, 409 delete custom, archived still listed; **PUT removing/renaming a rail key, changing a fitting kind → 409; size change on a used code → 409 with count; on an unused custom code → 200; entry_type change → 400; body > 32 KB → 413 before parsing; German error with JSON path**; `javascript:` URL → 422; audit rows written; partner login 403 |
| `test_panel_enclosure_layout.py` | fixture parity of `order`; RfZ/APZ rows first, then NAR→SAS→AAR→VF→VT per module; unknown key → unlinked; retired rail drawn only with devices |
| `test_panel_enclosure_geometry.py` | fixture parity; shell = spec dims; field count; module y = 25 + 150·unit; rail w = ple·17.5; SLS on busbar 78.75 mm; devices contiguous; overflow flag; closed view has covers/slots/windows/blind plates/door leaves; unknown code placeholder; deterministic order |
| `test_panel_enclosure_rules.py` | fixture parity; each rule fires on a minimal board and stays silent on the compliant one (SAS credit, per-place counts, `pv`/`wallbox` allowed in AAR, mcb ≤ 10 A allowed in NAR); `encl.terminals` length; garbage documents never raise; panel GET findings carry `rule` |
| `test_panel_enclosure_material.py` | golden: legacy boards' `planned_lines` unchanged; cabinet line first, module counts, supplied HS not a device line, deleted HS → `removed:ZH3EH16:hs` while module line stays 1, `removed_fittings` → line, meters never lines, free place → KU40XXE line, second claimant counted as device, `meter` labelled Zwischenzähler on cabinet boards only; **catalogue edit after placement leaves the list unchanged (snapshot)**; unknown module → "Modul {code} (unbekannt)" and its HS still skipped; auto-match "Hager ZB33S – …" → `auto`; **ZH3EH16 does not match "Hager ZH3EH16N Komplettfeld"**; mapping accepts the new prefixes, refuses `article:`/`salvage:`, **`removed:` by an employee → 403**; salvage: stock_total/available +1, ledger type `salvage` with panel_id, line `done`; over-salvage 400; foreign article 400; **employee → 403; serialized → 400; archived → 400**; **salvage → consumed elsewhere → unsalvage refused (stock_available)**; **restore after salvage → orphan `salvage:` line, unsalvage works from it**; **consumption of an article only on a removed line → extra line**; consumption never ticks removed lines; totals exclude removed; `returns_open` in detail and overview; **station scan of a removed-only article → 409**; station panel payload has no removed lines; invisible project plan → 403/404 |
| `test_panel_enclosure_pdf.py` | 200 `application/pdf`, page 1 landscape, page count = 1 + material pages; 409 without cabinet; access rules; `pick_scale` on the 180 × 180 mm box: ZB55S → 8, ZB32S → 8, a 600 × 600 mm box → 5, a 4000 mm one → 20 (largest that fits, else 20); long findings list → "… und {n} weitere" |
| existing `test_werkstatt_ledger_bounds.py` (extend) | salvage deltas keep `total == available + out + repair`; salvage → consume elsewhere → `salvage_undo` refused |
| `test_alembic_single_head.py` | unchanged, green |
| route-walk / partner fence test | new routers covered (existing test, must stay green) |

Web (`apps/web/src/test/`, vitest):

| File | Asserts |
|------|---------|
| `usePanelDocumentEditor.test.tsx` (0) | one PATCH per debounced edit under StrictMode; flush on `visibilitychange` hidden and unmount; the server response never overwrites the document; `settleSaves` waits for the request in flight and flushes the rest; 4xx → "Nicht gespeichert: {detail}", network → connection hint; unknown top-level/device keys survive `mutate` |
| `materialTabFreshness.test.tsx` (0) | edit then switch to Material → `updatePanel` resolves before the material GET; list refetches when `revision` changes |
| `openAfterSave.test.ts` (0) | window opened synchronously, navigated after settle, closed on failure |
| `enclosureLayout.test.ts`, `enclosureGeometry.test.ts`, `enclosureRules.test.ts` | fixture parity (order, both views, findings) + direct cases |
| `enclosureFeeds.test.ts` | on `cross_feed_zb33s` and `meter_dist_zb33s`: place (incl. a supplied HS between fields), move, swap, remove, adopt, claim, `moveDeviceToRail`, `fillRailFromTemplate`, `orderRowsPhysically` leave `feedMap` identical for every circuit not in `regrouped` (pinned ones included); removing the HS fitting reports its circuits as `regrouped` |
| `enclosureOps.test.ts` | lazy rows (only fitting rails get rows); refuses overlap / out of bounds / wrong height with the §11 copy; **121st row refused**; physical row order, unlinked rows last; move relabels generated labels only; swap equal sizes only; remove keeps non-empty rows unlinked and clears `parent_id`/`terminal_labels` of deleted devices; `setFittingRemoved(false)` twice → one HS; **retrofit**: a legacy meter board + ZB33S + ZH3EH16 with claim → one HS (the old one, now supplied), `meter` device converted to `meters[0]`, meter number seeded; `moveDeviceToRail` puts the legacy SLS into the NAR; adoption only into VT/VF rails; `fillRailFromTemplate` numbering + keeps row id; `normalizeEnclosure`; `refreshModuleSnapshot`; SLS on NAR links the HS; inputs deep-frozen (no mutation) |
| `schaltplanDocumentOps.test.ts` (extend) | duplicate of a supplied device has `supplied_by: null`; `removeDevices` |
| `enclosureFrontSvg.test.tsx` | at **every zoom step** a tap on a 1-TE device and on a 4-TE FI both call `onOpenRail` with the device; module background → `onOpenModule`; free unit → `onPickSlot` at that unit; no "+" in the SVG; aria-labels; closed view shows meter number and blind plate |
| `enclosureTab.test.tsx` | empty state → picker → cabinet set; picker section order; **ungeprüft** badge; wrong heights hidden with count; field bar buttons; regroup confirm before apply, pinned toast; sheet stack: inspector closes back to RailSheet, one backdrop; findings chip in the banner; board with cabinet opens on Schrank; **3D import rejects → boundary text, "3D neu laden" retries**; no WebGL → fallback text |
| `moduleSheet.test.tsx` | fitting toggle, meter number edit, place "frei", swap, snapshot refresh on drafts only, remove confirm copy |
| `railSheet.test.tsx` | "+ Gerät" on a rail without a row creates it; "Aus Vorlage füllen"; adoption list only on VT/VF rails |
| `railEditorEnclosureGroups.test.tsx` | grouping, **Nicht im Schrank**, slots read-only and no remove on linked rows |
| `panelMaterialRemoved.test.tsx` | removed line: **Ins Lager** calls salvage, status **eingelagert**; orphan line offers Zurücknehmen; buttons disabled with the hint without `werkstatt:manage` |
| `enclosureThreeScene.test.ts` | one mesh per non-cover box; door leaves; `disposeGroup` disposes every geometry/material (spies); forbidden-import scan |
| `newPanelDialogEnclosure.test.tsx` | cabinet choice → document with enclosure and no rows |
| `werkstattOverviewFormat.test.ts`, `werkstattMobileLabels.test.ts` (extend) | salvage labels and direction |

Run per `docs/TESTING.md` (one pytest session per worktree DB, gate on the
exit code). Coverage ≥ 80 % on every new module.

Browser proof (part of Done): through Playwright MCP against the worktree dev
stack, logged in with the `access_token` **cookie** (not only localStorage),
at 768 × 1024 and 1024 × 768: create a board with ZB33S; place ZH3EH16,
ZU37KS, ZU37VT5APZ2; add an SLS on the NAR; fill a VT rail from a template;
enter a meter number; remove the HS; check the Materialliste (cabinet,
modules, removed line, no meter); open the Aufbau PDF; open 3D. Screenshots
go into the PR. Tap every target at the default zoom to confirm the one tap
rule.

---

## 15. Security

* Server-side permissions as in §7; `_assert_readable` on every panel route;
  the partner fence covers the new routes by endpoint identity.
* Stock integrity: only `werkstatt:manage` can salvage or map a `removed:` key,
  so an employee cannot place modules, delete parts and book stock in.
  Salvage needs an article on a removed line of that board and never exceeds
  its planned count. Unsalvage is bounded by the board's net and by
  `stock_available`. Machines and archived articles are refused. Every ledger
  row carries user, panel, project and note. Catalogue writes are audited.
* Admin input: Pydantic specs with length/count caps, 32 KB per entry checked
  on the raw body before parsing, ≤ 500 custom entries, `https://` only for
  `source_url` (rendered with `rel="noreferrer noopener"`), codes by pattern.
  No HTML anywhere: React text, SVG `<text>`, reportlab `drawString`.
* Document DoS ceiling: ≤ 120 rows, ≤ 50 modules, ≤ 16 rails, ≤ 16 fittings
  and ≤ 8 meters each.
* Dependencies: `three@0.186.1` (0 runtime deps) + `@types/three@0.186.0`
  (dev only; it pulls type and helper packages such as `fflate`,
  `meshoptimizer` and `@dimforge/rapier3d-compat` into the dev tree, never into
  the bundle; the deploy report names them). Exact pins, lockfile committed.
  `npm audit` (dev included) must stay at 0. After the build, grep only the
  emitted chunk:
  `grep -nE "\bnew Function\b|\beval\(" apps/web/dist/chunks/Enclosure3DView-*.js`
  must be empty. No Python dependency added; `pip-audit` unchanged.
* CSP unchanged (`Caddyfile`): no loaders, wasm, blob workers or CDN fetches.
  Proof: open 3D on the staged stack (`staged_deploy.sh stage`, behind the real
  Caddy headers) with zero CSP violations in the console.

## 16. Rollout and back-compat

* **Stacking**: this branch sits on `claude/customer-directory-fix`
  (2 commits, migration `20261020_0102`, not deployed; it clashes with
  `claude/label-calibration`'s 0102). Order: customer-directory-fix (with the
  0102 clash resolved) → Slice P → feature. As merged: v2.14.42 =
  customer-directory-fix with `20261022_0105` on top of 0102, v2.14.43 =
  Slice P with 0104 re-pointed onto 0105, v2.14.44 = the feature. Whoever
  merges after the 0103 branch re-points `down_revision`.
* **Two releases.** Slice P ships as its own PR and release (migration 0104,
  pass-through `enclosure`/`supplied_by`, `hlak`, `MAX_ROWS` 120, salvage
  ledger types). The feature release is deployed only after P has been live,
  and the deploy report names the P version.
* **Rollback**:
  * feature → P (images only) is safe: P knows Alembic head 0104, keeps
    `enclosure` and `supplied_by` on read and save, validates `hlak` and
    120-row boards, and lists salvage movements. While rolled back, the
    Schrank tab, the enclosure findings and the removed lines are gone; the
    ledger and stock stay correct.
  * P → before P needs `alembic downgrade 20261022_0105` first (it drops the
    still-empty table and nothing else; `20261020_0102` would also revert
    0105, a lossy TEXT → VARCHAR(2048) that PostgreSQL refuses while a longer
    value is stored), because an older image cannot start against an
    unknown head (the api image runs `alembic upgrade head`). Boards with
    `hlak` or more than 60 rows cannot exist yet in P, because P offers
    neither.
  * If the owner ships P and the feature together, the release is
    **forward-fix only**: a rollback then needs the pre-deploy DB backup.
* Existing boards: `enclosure` absent → `null`; derivations, findings, PDFs and
  Materialliste unchanged (golden tests). They gain the keys on their next
  save (`"enclosure": null`, `"supplied_by": null`), which is harmless.
* Old cached SPA tabs keep `enclosure` via spreads; their new rows are simply
  "Nicht im Schrank". Deleting a supplied device there = removed fitting (by
  design). Deleting a linked row = empty rail (rendered, recreated on use).
  Reordering rows there is caught by `encl.row_order`.
* Migration 0104 is additive; downgrade drops only the catalogue table
  (built-ins still work; custom codes in documents then render as
  placeholders with a finding, boards still save, lists read snapshots).
* Pi station: no update needed (removed lines filtered server-side; the 409
  text is shown as is). The kiosk label for `salvage` follows with the next
  Pi release ("API before Pi").
* Done means: tests green, browser proof (§14) with screenshots, `npm audit`
  0, `pip-audit` unchanged, Vite build shows the separate 3D chunk, the chunk
  grep and CSP proof clean, drift 0 on PG16, and the deploy report states the
  audit result, the exposure (per the security rules), the P version live and
  the dev-only type dependencies. Update `docs/STATE.md` with the feature.

## 17. Open questions for the owner

Each one changes shipped data or code; the plan proceeds with the
recommended answer until told otherwise.

1. **Catalogue facts to confirm on one real cabinet** (stack order AAR / RfZ /
   eHZ / NAR, 150 mm pitch, the ZH3EH16 Hauptschalter article and rating, HLAK
   poles, what the ZH31X7NT "Trennfunktion" device is, door leaves per
   width). *Recommended:* ship everything flagged "ungeprüft". The Werkstatt
   measures one ZB33S with a ZH3EH16 and notes the HS article (e.g. SH363N).
   Corrections are catalogue data and stay editable even for used codes
   (§3.5). With the article number, the "ins Lager" line matches stock
   automatically.
2. **Accessories that always go on the list.** Candidates: Feld-Feld-Verbinder
   ZZ55SAVE, the APZ socket VZ00APZ for …APZ2 fields, and the ZH5EL27
   Pflichtzubehör (ZZ35S or S35V, ZM15H or ZM25F, ZZ60A). *Recommended:* name
   the variant you buy and the quantity per field. An admin enters them as
   accessories (data, no code). v1 auto-adds only the blind plates for
   reserve meter places.
3. **Where do the WAGO Reihenklemmen strips sit in a univers Z?**
   *Recommended:* v1 states their length per field (`encl.terminals`). v2 puts
   them on their own rail at the bottom of the FI's distribution field (a
   `…RK` field where planned), stored as `enclosure.terminal_rails`, drawn and
   counted against rail capacity.
4. **Should a part returned "ins Lager" reduce the project's material?**
   Today the project Material tab counts consumption only, so it overstates
   the module by the returned part. *Recommended:* yes, as a negative line
   "Rücklauf ins Lager" (quantity only, no automatic price credit; billing
   stays manual). About 30 lines + a test in `project_panel_materials`.
5. **Multi-field Komplettfelder (ZK…/ZL…) and further 3-Punkt variants as
   built-ins?** *Recommended:* not in v1. The model supports 2–3-field
   modules; an admin can add the ones you actually build.
6. **Should "Plan als PDF" include the Aufbau sheet?** *Recommended:* no. Keep
   the separate "Aufbau als PDF", which already carries the Materialliste.
7. **Two releases (Slice P first)?** *Recommended:* yes. It costs one extra
   small deploy and makes the feature rollback image-only. Without it, the
   feature release is forward-fix only.

---

## 18. Review log (rev 2)

R1 = first review, R2 = second review. "Fixed" points to where the contract
now covers the finding.

| ID | Finding | Resolution |
|----|---------|------------|
| R1-1 / R2-3 (blocker) | Ops reorder rows and silently re-feed circuits | Fixed: feed preservation with `pinned`/`regrouped` + confirm (§2.4, §10.2, §11); `encl.row_order` with a Python twin of the order (§2.3, §5); `cross_module_feed` raised to warn; adoption limited to VT/VF; tests (§14) |
| R1-2 / R2-6 | Live catalogue rewrites existing boards; keys can vanish | Fixed: fitting snapshot (§2.1, D5), append-only keys + retire, frozen size/family/places for used codes, shipped-codes file (§3.5), `encl.stale_rail` (§2.3, §5). Geometry stays live on purpose |
| R1-3 | SAS zones without rails; NAR rail implicit for 3-Punkt | Fixed: every SAS has a busbar rail, NAR busbar rails explicit, validators, SAS credit in `vde.nar_sls`, SAS position flagged unverified (§3.1, §3.2, §5) |
| R1-4 | Retrofitting a legacy meter board gives two HS, SLS in the AAR, eHZ as a device | Fixed: claim on placement, meter-device conversion, VT/VF-only adoption, "Auf andere Hutschiene…", `encl.meter_device`, Zwischenzähler label (§10.2, §5, §6). Kind-based mapping of whole rows into meter rails rejected: one row mixes kinds, and moving single devices is clearer |
| R1-5 / R2-7 | Salvage loses its line after restore/remove/remap | Fixed: orphan `salvage:<id>` lines, consumption extras over non-removed lines only (§6), tests |
| R1-6 | `salvage_undo` can drive stock negative; machines | Fixed: `stock_available` guard in service and `apply_movement`, serialized/archived refused (§6, §7) |
| R1-7 / R2-5 | Unknown code makes boards unsaveable | Fixed: only newly introduced codes rejected, duplicate unchecked, invalid entries kept as known, 4xx detail shown, `normalizeEnclosure` (§2.2, §3.3, §9 Slice 0) |
| R1-8 | Image rollback 500s on HLAK and drops the enclosure | Fixed: Slice P preparatory release incl. migration 0104 and `MAX_ROWS`; explicit rollback matrix and forward-fix statement (§9, §16, Q7) |
| R1-9 | RfZ/APZ devices under customer FI; `rfz_devices` misfires | Fixed: RfZ/APZ rails first (supply group), fixed type ranks instead of list order, rule narrowed (§2.3, §5) |
| R1-10 / R2-19 | VDE rules miss per-place counts, PV/wallbox, NAR contents | Fixed: per-place SLS/HS counts, AAR allow-list, `vde.nar_contents`, `vde.sls_rating`, banner chip (§5) |
| R1-11 | Data accuracy, accessories, door leaves | Fixed: HLAK 3-pol., ZH5EL16 unverified, ZU37VT4APZ2 order unverified, `door_leaves`, blind plates. Pflichtzubehör auto-add **rejected** (alternatives and quantities unknown; would put wrong lines on every board), moved to Q2 |
| R1-12 | Prefix auto-match picks the wrong article | Fixed: whole-token matching (§3.4), test |
| R1-13 | Meter numbers in two places; duplicate copies them | Fixed: meters authoritative on cabinet boards, seed once, duplicate clears, place index defined, invalid places reported (§2.1) |
| R1-14 / R2-4 | MAX_ROWS 60 vs eager rows; dangling `parent_id`; stale labels; double HS | Fixed: lazy rows + 120 cap + refusal, `removeDevices`, relabel, idempotent toggle (D15, §10.2) |
| R2-1 (blocker) | Any employee can book stock in via salvage | Fixed: `werkstatt:manage` for salvage and `removed:` mapping, serialized/archived refused (D6, D11, §7) |
| R2-2 | Size-dependent tap routing; tiny targets | Fixed: one tap rule, field bar ≥ 56 px, no SVG "+", `onOpenRail(moduleId, railKey, deviceId)` (D16, §11) |
| R2-8 | Material tab / PDF read stale saves | Fixed: `settleSaves` on tab switch, `openAfterSave`, list keyed on revision (Slice 0) |
| R2-9 | Reihenklemmen ignored in rail capacity | Partly: `encl.terminals` info in v1; placement is Q3 |
| R2-10 | Filling rails one device at a time | Fixed: `fillRailFromTemplate` + RailSheet action |
| R2-11 | Failed 3D chunk kills the app | Fixed: `Enclosure3DBoundary` + retry (§12), test |
| R2-12 | Test gaps, no browser proof | Fixed: §14 additions + Playwright proof at tablet sizes in Done |
| R2-13 | Slices not independent | Fixed: build order and Slice 0/P (§9); admin props and CSS ownership (§9, §10.2) |
| R2-14 | `workflow_schaltplan.py` over 800 lines | Fixed: type-label routes move out, enclosure logic in a service (§7, §9) |
| R2-15 | Removed part scanned at the Regal books consumption | Fixed: station 409 (§6) |
| R2-16 | `meter` palette label invites eHZ on rails | Fixed on cabinet boards; Python/legacy label unchanged **on purpose** (legacy lists stay byte-identical) |
| R2-17 | Device deletion paths diverge | Fixed: single `removeDevices` |
| R2-18 | Labels unreadable at real scale; PDF column overflow | Fixed: rotate/hide rule, "… und {n} weitere" (§4, §13) |
| R2-20 | Unverified device fittings drawn as fact | Partly: kept as devices with an "ungeprüft" inspector note. Modelling them as non-devices **rejected**: `vde.3p_main_switch` would fire and invite buying a second HS. Q1 resolves the facts |
| R2-21 | Swap, place at tap, hidden heights | Fixed (§10.2, §11) |
| R2-22 | Sheet stacking, landing tab | Fixed (§11) |
| R2-23 | three.js grep and CSP proof | Fixed (§15) |
| R2-24 | Stacked branch; duplicate copies meter numbers | Fixed (§16, §2.1) |
| R2-25 | JSON-only admin editor | Fixed: German path errors, live preview, immutable entry_type, raw size check. Shipping the admin editor in a later release was **not asked**: D4 (admins can add/edit) is binding; Slice F is last and separable |
| R1/R2 missing: SLS vs wiring | Fixed: `wiring_mm2`, `vde.sls_rating` |
| R1 missing: SMGW tap, RJ45 | Not automatable from the model (no device kinds for them): listed under "Nicht automatisch geprüft" (§5) |
| R1 missing: blind plates, busbar SLS width | Fixed (§3.1, §4, §6) |
| R1 missing: stock not in catalogue | Fixed: `uncatalogued` section for managers (§3.4) |
| R1 missing: pending returns invisible | Fixed: `returns_open` + Werkstatt chip; project billing is Q4 |
| R1 missing: SLS → HS chain | Fixed: `addDeviceToRail` links the HS (§10.2) |
| R2 missing: who books, Regal returns, unverified devices, tap rule | Decided in this revision (D6, D11, §6, R2-20, D16); not asked |
