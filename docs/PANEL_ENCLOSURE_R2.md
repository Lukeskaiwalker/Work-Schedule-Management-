# Verteilerpläne — Schrank, Runde 2: WAGO-Reihenklemmen im Schrank, Drag & Drop, Nahansicht

Addendum to the shipped contract `docs/PANEL_ENCLOSURE.md` (cited below as
**C§n**). That file stays as shipped, apart from the pointer and the short
**Round 2:** notes listed in §1.2; this one says what round 2 adds and
which parts of it are replaced (§1.2). Read C§1–C§2.4, C§4, C§5, C§6,
C§10 and C§11 first.

Status: **built 2026-10-23**, shipping in the next release (**v2.15.1**);
not deployed. Branch `claude/panel-round2`, based on production v2.15.0
(HEAD `0b6cc96`). Design rev 2 of 2026-10-22; the owner requirements and
answers of 2026-10-22 are binding and quoted as **O1–O7**, and the owner's
answers to rev 2's open questions (§1.3, also 2026-10-22) override rev 2
where they differ. This file describes
what was **built**: every deviation of the build, integration, review and
fix passes is folded into the sections below, and §20 is the index of them.
§19 keeps the history of the two design reviews. The repo is public, so
every example below is invented data. No Alembic migration (§16).

---

## 1. Decisions

### 1.1 Round-2 decisions

| # | Decision | Why (one line) |
|---|----------|----------------|
| R1 | WAGO terminals stay **derived**. Their physical placement is a pure function, `place_terminals` (Python) ⇄ `placeTerminals` (TS), of the document and the catalogue. The only new stored key is `module.terminal_order` (§2.1): one **strip sequence per field**, plus an optional "rail 2 starts at strip S" marker, written only by a manual strip move. Which strip sits on which rail is never stored. | O-rules: "store only what the derivation cannot know (e.g. manual terminal order per field) — never a second copy that can drift". A sequence cannot go stale; a stored rail split that no longer fits is ignored (R5). |
| R2 | **Terminal rails** of a cabinet field = the first two rails, top → bottom, of the field's `VT` zones (mount `rail`, not retired). They are reserved whether or not the board has any terminals yet. A field with no `VT` rail has no terminal rails. | O2; owner answer (e): the top two rails of **every** Verteilerfeld, no per-board opt-out. AAR, SAS, NAR, RfZ, APZ and VF rails are never terminal rails (Tipp 44: the AAR is no Stromkreisverteiler; a 2-rail VF would lose all its MCB space). |
| R3 | **No WAGO** for circuits on rails of zone types `AAR`, `NAR`, `RFZ` or `APZ` (and `ZF`/`COVER`, which hold none). The derivation skips them; the device's `terminal_block` flag is kept as the user's intent. `VT`, `VF`, `MM` and **`SAS`** keep their terminals (a wallbox on a busbar adapter is a normal Block). | Owner answer (d). O2 names the AAR; NAR, RfZ and APZ are the grid operator's side of the same meter field (Q4). The SAS of a busbar Verteilerfeld is the customer's distribution after the meter. |
| R4 | A **strip's home field** = the field holding the most of the strip's circuits. Ties go to the field of the strip's first circuit in reading order. A Block's home is its own device's field. Circuits outside the cabinet do not count. When the home field differs from the field of the strip's protective device, an info finding says that the N feed wire crosses fields (`encl.terminals_head_field`). | O2: "belong to the field of its circuits". Each circuit's cable lands on its own Etagenklemme, the FI's N feed is one wire, so majority keeps the many wires short. C§2.4 pins (`parent_id`) can put a whole group in another field than its FI without any warning today, so the finding is needed. |
| R5 | **Packing.** The field's *sequence* is the stored manual order (§2.1) or, by default, Leisten then Blocks, each in X order. (a) A stored rail-2 marker is honoured only when both rails fit; otherwise it is ignored with an info finding. (b) Otherwise **next-fit** walks the sequence onto rail 1, then rail 2, so X1, X2 … read in order. (c) Strips next-fit could not place are then placed **first-fit** (end of rail 1, else end of rail 2). Only a strip that fits neither rail is **unplaced**: never a third rail, never another field. | O2. Pure next-fit reports false overflows when a later Block would still fit on rail 1 (review). |
| R6 | A home field with no terminal rails (a ZH5EL* meter field's VF, a communication field) sends its strips to the **nearest field with terminal rails** (smallest field distance, ties to the left), with an info finding. | Such strips still need a place; they stay whole in one field, so O2's and owner answer (e)'s "never split across fields" holds. |
| R7 | **Rail parts** per terminal rail that holds a placed strip: one **end plate** matching the rail's last terminal block (`2003-7692` after a 2003-series terminal, `2016-7691` after a 2016-76xx terminal), drawn right after it and before a trailing 2009-305. It counts against the rail and appears on the Materialliste. **No end stops**: there is no WAGO 249-116 anywhere (placement, close-up, PDF, Materialliste) and no switch to bring them back. | O4 (end plates, articles from the WAGO datasheets, §5.3); owner answer (a), 2026-10-22: one end plate per rail, no 249-116. |
| R8 | **U84T**: one set per terminal rail that holds a placed strip, on KS-type fields. Rails of modules whose served spec has the non-device fitting `u84t` (the RK fields) need none. The served spec of a built-in always carries its built-in fittings (`_merge_override` appends any an override lacks, §10). The line is `accessory:U84T`, matched by mapping, then EAN, then article number. | O3; owner answer (f). A fitting needs no spec-schema change, so a rollback image still accepts the catalogue. Appending fixes RK overrides saved under v2.15.0. |
| R9 | **Drag & drop**: a hand-written Pointer Events hook, not `@dnd-kit` (§6.1). Touch and pen arm after a 450 ms long-press; a mouse after 6 px. A short tap, and a long press released **without moving**, both act as a tap: RailSheet as today, and in the close-up the terminal under the finger is selected (§6.2). Drag works in the **Offen** view only. | O1, and D16 (one tap rule) stays intact for slow, gloved taps (review). |
| R10 | A dropped device **follows its position**: one pure rule, `followPosition`, clears the moved circuit's `parent_id` only when its *positional* head differs between the old and the new spot; a group head keeps its feeder link. The same rule now runs for the inspector arrows and for "Auf andere Hutschiene…" (which gains a position step), so all three give the same feed. Every feed and terminal change is listed in a note with **Rückgängig** (one-step undo). | O1: "follows the position (regrouped like the arrow buttons) … Rückgängig". Today an explicit `parent_id` beats position, so the arrows did not regroup pinned circuits; a nudge inside a run must not wipe a deliberate cross-feed. |
| R11 | The unit of manual WAGO order is the **whole strip** (Leiste or Block), moved within its field's two terminal rails. The order of terminals inside a Leiste follows the MCB order: drag the MCBs to change it. | Owner answer (c). A Leiste is one N bus: feed first, 2009-305 last, markers "n.k" counted along it. |
| R12 | Devices already on a now-reserved rail **stay**. Their width is subtracted from that rail's capacity. `encl.terminal_rail_devices` (warn) offers one action per field that moves **all** of the field's reserved rows together onto empty rails (§4.2). Hand-placed `terminal` devices ("Reihenklemme N/PE") on a terminal rail are **placeholders**: not counted, no warn, an info finding offers to remove them. Every path that can put a device on a reserved rail is listed in §3.6 with its handling. | O-rules: "warning + suggestion, never silent moves". The back-compat board (ZB34S, rows on r1–r2 and r3–r7) opens unchanged. |
| R13 | **Close-up** ("Nahansicht") of a field's two terminal rails: one sheet in the Schrank tab with both rails in one drawing, and one page per field in "Aufbau als PDF" at 1:1 across the rail, plus a legend page when a text had to be shortened. Both read one pure layout and one pure text-fit rule. | O5. At the largest 2D zoom a 5.2 mm terminal is 6.8 px wide, below the label threshold (C§4). |
| R14 | Aufbau tab: every module gets a group, every resolvable rail an entry. An empty rail offers "+ Gerät" through `addDeviceToRail`. A rail-less or unknown module gets a note. A linked row on a retired rail is still listed. A reserved row shows the warning and the action, never "+ Gerät". | O6 and the bug map. |
| R15 | Four built-ins are added (ZU37V5RKAPZ2, ZU59V7RKAPZ2, ZH3ES5RK, ZH53XSRK), and the fitting `u84t` is appended to ZU37RK, ZU59RK and the four new codes, under the C§3.5 identity rules. ZU37RK/ZU59RK stay `verified`. | O7. hager.com (2026-10-22) confirms rows and names of all four and marks them **Auslaufprodukt**. |
| R16 | **Capacity** is one named constant, `TERMINAL_RAIL_USABLE_MM = 210.0` for a 12-PLE rail, mirrored in TS and echoed in the fixture. It is **unverified**: the physical rail is ≈ 248 mm, but how much of it terminals may use (frame screws, U84T, cover) is not known. Until the Werkstatt measures (Q1a, **open**), `encl.terminals_overflow` is level **info** and quotes the assumed length; one flag makes it warn. | Owner answer (g): the Werkstatt facts stay unverified until measured. Review: the value decides the move-circuits advice on full boards and must not hide behind `ple × 17.5`. |
| R17 | **Suggestions are one sequential pure pass**: first vacate reserved rails, then re-run the placement on that hypothetical board, and only then suggest moving circuits — never while a vacate is pending. Each move-circuits candidate is validated by applying the move virtually and re-placing. | Review: vacating often solves the overflow, and independent suggestions named the same target rail twice. |
| R18 | Dragging a **group head** (FI/RCD, Hauptschalter, a fuse that opens a group) moves it **with its circuits**: every circuit it feeds in its own field, by position or pinned to it from another run, travels as one block right behind it, in reading order (`dragGroup`, §6.4). Circuits of the group in another field stay where they are. The RailPicker uses the same rule. | Owner answer (b), 2026-10-22; replaces rev 2's "FI alone". The group is the one §4.2's `move_group` names, so its Klemmleiste stays whole. |
| R19 | On a board whose rows are not in cabinet order (`encl.row_order`), a device drop is refused with "Reihen nicht in Schrankreihenfolge — erst „Reihen ordnen“". | Without it the feed would follow `rows[]`, not the drawn position, and O1 would silently not hold. |

### 1.2 What this replaces in the shipped contract

| C§ | Shipped text | Round 2 |
|----|--------------|---------|
| §1 non-goals ("WAGO … not placed on rails in v1") | non-goal | Replaced by R1–R8, R16 |
| §1 D16 / §11 one tap rule | tap = sheet | Tap (short or slow) = sheet as before. A tap on a terminal rail or strip opens the close-up. Long-press then move / mouse drag = move (R9) |
| §2.4 last paragraph | "Auf andere Hutschiene…" pins | The picker follows position like the drag (R10); changed shipped behaviour, listed in §16 |
| inspector arrows (`moveDeviceIn`) | never touch `parent_id` | `followPosition` (R10); changed shipped behaviour, listed in §16 |
| §5 `encl.terminals` | info "… im Schrankbild nicht gezeichnet" | New text plus nine terminal rules (§4) |
| §6 | no WAGO rail parts | End plates and U84T added (§5); no end stops (owner answer (a)) |
| §10.2 `moveDeviceToRail` | appends | Unchanged. The drag and the picker use the new `dropDevice` (§6.4) |
| §11 RailEditor ("linked rows: …") | modules without rows vanish | Fixed by R14 (§9) |
| §17 Q3 (terminals "at the bottom", `enclosure.terminal_rails`) | recommendation | Superseded by O2 (top two rails) and R1 (`module.terminal_order`) |
| §18 R2-9 | "Partly" | Closed |
| `RailEditor.tsx` header comment (argues against DnD for gloves) | rationale | Rewrite so it names the owner's 2026-10-22 decision; otherwise the next session "fixes" it back |
| §6 row 5 `terminal` "unchanged", §11 "Auf andere Hutschiene…" | shipped behaviour | AAR/NAR/RfZ/APZ circuits no longer count terminals (R3); a dragged or picked group head takes its circuits along (R18) |
| §3.2 built-in list (ZU37RK/ZU59RK fittings "—") | data | `u84t` added; four RK built-ins appended (R15, §10) |
| §13 Aufbau PDF (front view, then the Materialliste pages) | page order | Close-up pages per field with placed terminals in between (§7.3); 409 for a refused cabinet block (§3.1) |

Done 2026-10-23: the shipped contract's **Status** carries the line "Round 2:
see `PANEL_ENCLOSURE_R2.md`", and each shipped statement that round 2 makes
false (the rows of this table) carries a short **Round 2:** note pointing
here. Nothing else in that file changes.

### 1.3 Owner answers of 2026-10-22 (binding; they override rev 2)

| | Answer | Where |
|---|--------|-------|
| (a) | No WAGO 249-116 end stops. One end plate per rail, matching its last terminal: 2003-7692 or 2016-7691. | R7, §3.4, §5, §7 |
| (b) | Dragging an FI or other group head moves it **with** its circuits. | R18, §6.4 |
| (c) | Manual WAGO order moves whole strips only. | R11, §6.4, §7.2 |
| (d) | No WAGO in NAR, RfZ, APZ or AAR; WAGO on a Verteilerfeld's SAS, yes. | R3, §3.1 |
| (e) | WAGO strips sit on the top two rails of **every** Verteilerfeld and are never split across fields. On overflow, suggest moving circuits. | R2, R5, R6, §4.2 |
| (f) | One U84T set per WAGO rail on KS-type fields, none on RK fields. | R8, §5.1 |
| (g) | Werkstatt facts stay unverified until measured, starting with the 210 mm usable rail. | R16, §17 |

---

## 2. Data model

### 2.1 Stored: `module.terminal_order` (new, optional)

```jsonc
"enclosure": {
  "code": "ZB34S",
  "modules": [
    { "id": "mod-z", "code": "ZH3EH16", "field": 0, "unit": 0,
      "rails": { "nar": "row-nar", "aar1": "row-aar1", "aar2": "row-aar2" } },
    { "id": "mod-v", "code": "ZU37KS", "field": 1, "unit": 0,
      "rails": { "r3": "row-v3", "r4": "row-v4", "r5": "row-v5", "r6": "row-v6" },
      "fittings": [ { "key": "pe_n", "label": "PE/N-Klemmen waagerecht", "article_no": null,
                      "device_kind": null, "removable": false } ],
      // NEW — only after a manual strip move. Keyed by the field offset inside
      // this module ("0" for every built-in; width_fields ≤ 3). Strip ids are
      // the derivation's stable ids, never X numbers or row ids.
      "terminal_order": {
        "0": { "strips": [ "dev-f2:leiste", "dev-f1:leiste", "dev-q7:block", "dev-f3:leiste" ],
               "rail2_from": "dev-q7:block" } } },
    { "id": "mod-rk", "code": "ZU37RK", "field": 2, "unit": 0, "rails": {},
      "fittings": [ { "key": "u84t", "label": "Hutschienen-Isolierung U84T (ab Werk)",
                      "article_no": "U84T", "device_kind": null, "removable": false } ] }
  ]
}
```

* `strips`: the field's strip sequence, left → right on rail 1, then rail 2.
  `rail2_from`: the strip that starts rail 2, or `null` (split
  automatically). `null` and an absent key mean the same, in both languages.
* Strip ids (from `derive_terminals`, unchanged): `"{headId}:leiste"`,
  `"supply:leiste"`, `"{deviceId}:block"`.
* **Reading** (`field_order` ⇄ `fieldOrder`): the field's modules are walked
  in terminal-rail order, and the first one that carries an entry for this
  field wins. The **effective sequence** (§3.4) keeps the listed ids that
  are current strips of the field, in stored order, ignores the rest, and
  merges every unlisted strip in at its default neighbour (right after the
  strip that precedes it in the default order; at the front if none does).
  So a new FI group lands where it would have landed anyway, and a growing
  Leiste is still one id: nothing is copied that could go stale.
* **Honouring the split**: `rail2_from` is used only when it names a strip
  of the effective sequence and both rails then fit. When it names a
  current strip and the rails do not fit, the field is packed automatically
  over the effective sequence (`order: "ignored"`), and
  `encl.terminal_order_ignored` (info, action **Reihenfolge zurücksetzen**)
  says so. When it names a strip that has left the field, the stored
  sequence is kept and split automatically: `order` stays `"manual"` and no
  finding fires (as the §3.4 reference code does; both twins pin it). A
  stored layout is never kept when it does not fit.
* **Writing**: only `moveTerminalStrip` writes, and only the field's
  *current* strips (stale ids are dropped at that moment). It stores
  `rail2_from` only when the requested layout needs an explicit split and
  that split fits; otherwise it stores `null` (§6.4). It writes to the
  module that holds the field's first terminal rail and removes the field's
  entry from the field's other modules in the same op. When the result
  equals the default placement, it deletes the entry instead.
  `resetTerminalOrder` deletes it. An empty `terminal_order` object is
  deleted.
* **Revival**: a strip that leaves the field and comes back before the next
  manual move takes its stored slot again. That is intended: the user put
  it there. `removeDevices` prunes the ids of deleted heads and block
  devices (and clears a `rail2_from` it prunes), as it already prunes
  `terminal_labels` keys. That is hygiene only.
* The data sits on a module, not in a top-level field map, so it moves with
  `moveModule`/`swapModules` and goes away with `removeModule`.

**Parsing** — one lenient parser per language, used by the schema **and**
by every derivation that reads the stored document (a v2.15.0 image during
a rollback stores the key unvalidated):

```python
MAX_ORDER_STRIPS = 40      # a 210 mm rail holds ≤ 8 Leisten; 40 is a DoS cap, not a model limit
STRIP_ID_MAX = 80
FIELD_OFFSET_KEYS = ("0", "1", "2")

def parse_terminal_order(value: Any) -> dict[str, dict[str, Any]] | None:
    if not isinstance(value, dict):
        return None
    out: dict[str, dict[str, Any]] = {}
    for key in FIELD_OFFSET_KEYS:
        entry = value.get(key)
        if not isinstance(entry, dict) or not isinstance(entry.get("strips"), list):
            continue
        strips = list(dict.fromkeys(
            s for s in entry["strips"] if isinstance(s, str) and 0 < len(s) <= STRIP_ID_MAX))[:MAX_ORDER_STRIPS]
        if strips:
            mark = entry.get("rail2_from")
            out[key] = {"strips": strips, "rail2_from": mark if isinstance(mark, str) and mark in strips else None}
    return out or None
```

**Schema** (`app/schemas/panel_enclosure.py`, `EnclosureModule`; TS
`types/panelEnclosure.ts`): `terminal_order: Annotated[dict[str,
TerminalOrderEntry] | None, BeforeValidator(parse_terminal_order)] =
Field(default=None, exclude_if=lambda v: v is None)`. The parser never
raises. A raised error would make `readable_document` drop the whole
enclosure block (`encl.invalid_block`). `exclude_if` keeps `null` and absent
the same on the way out, so stored modules and fixture documents gain no
`"terminal_order": null` key. It needs pydantic ≥ 2.12, so
`apps/api/requirements.txt` now pins **`pydantic==2.14.1`**; before, pydantic
came only through fastapi (≥ 2.9). The parser and its caps live in the
schema module, because importing `panel_enclosure_terminals` there would be
circular; `panel_enclosure_terminals` re-exports them. TS: `terminal_order?:
Record<string, { strips: string[]; rail2_from: string | null }> | null`,
read only through `parseTerminalOrder`. The 64 KB ceiling on the enclosure
block (C§2.2) still bounds the total.

### 2.2 Catalogue: fitting `u84t` (data, no schema change)

`INSULATED_RAILS_FITTING = "u84t"`. A module's rails count as insulated
when its **served** spec (`catalog.module(code)`) has a non-retired fitting
with that key. The placement snapshot is not read here, because placements
made before R2 lack the key. The served spec of a built-in always carries
the built-in's fittings: `_merge_override` appends, in built-in order, every
built-in fitting whose key the override lacks (§10). So a ZU37RK override
saved under v2.15.0 is still insulated, in both languages, without a TS
catalogue twin. The fitting is non-device and `removable: false`, so it
never makes a Materialliste line of its own (C§6). ModuleSheet shows
**U84T ab Werk** from the served spec (not from the snapshot), so the sheet
and the close-up agree on old placements. An admin marks a custom field as
insulated by adding the same fitting in the JSON editor.

### 2.3 Derived, never stored: `TerminalPlacement`

Python emits the TypeScript key names (as the geometry does, C§4), so the
fixture compares without translation. Numbers are computed unrounded;
`round1` is applied on the way out.

Example (invented; the numbers were recomputed from the built code on
2026-10-23): field 1 is a ZU37KS with its MCB rows on r3–r6. Groups:
F1 (FI + 6 LS → X1, 50.7 mm), F2 (FI + 8 LS → X2, 61.1 mm), F3 (FI + 5 LS →
X3, 45.5 mm, plus a 3-pole B20 `dev-q7` → Block X4, 60 mm), F4 (FI + 8 LS →
X5, 61.1 mm). The stored order is the one in §2.1. X5 is not listed, so it
merges in after X3 (its default predecessor). The effective sequence is X2,
X1, X4, X3, X5, and `rail2_from` = X4 fits both rails:

```jsonc
{
  "skip": ["dev-aar-ls1"],                       // circuits with terminal_block in a no-WAGO zone (R3), sorted
  "usableMm": 210.0,                             // TERMINAL_RAIL_USABLE_MM (R16)
  "fields": [
    { "field": 1, "order": "manual", "orderModuleId": "mod-v",    // "default" | "manual" | "ignored"
      "rails": [
        { "moduleId": "mod-v", "railKey": "r1", "rowId": null, "position": 0, "title": "F2 · Verteiler 1",
          "capacityMm": 210.0, "devicesMm": 0.0, "usedMm": 112.6, "insulated": false,
          "strips": [
            { "stripId": "dev-f2:leiste", "stripNo": 2, "kind": "leiste", "xLabel": "X2", "groupId": "dev-f2",
              "homeField": 1, "headField": 1, "offsetMm": 0.0, "widthMm": 61.1, "extentMm": 61.1 },
            { "stripId": "dev-f1:leiste", "stripNo": 1, "kind": "leiste", "xLabel": "X1", "groupId": "dev-f1",
              "homeField": 1, "headField": 1, "offsetMm": 61.1, "widthMm": 50.7, "extentMm": 51.5 } ],
          "parts": [
            { "partId": "2003-7692", "role": "end_plate", "offsetMm": 104.3, "widthMm": 0.8 } ] },
        { "moduleId": "mod-v", "railKey": "r2", "rowId": null, "position": 1, "title": "F2 · Verteiler 2",
          "capacityMm": 210.0, "devicesMm": 0.0, "usedMm": 167.4, "insulated": false,
          "strips": [
            { "stripId": "dev-q7:block", "stripNo": 4, "kind": "block", "xLabel": "X4", "groupId": "dev-f3",
              "homeField": 1, "headField": 1, "offsetMm": 0.0, "widthMm": 60.0, "extentMm": 60.0 },
            { "stripId": "dev-f3:leiste", "stripNo": 3, "kind": "leiste", "xLabel": "X3", "groupId": "dev-f3",
              "homeField": 1, "headField": 1, "offsetMm": 60.0, "widthMm": 45.5, "extentMm": 45.5 },
            { "stripId": "dev-f4:leiste", "stripNo": 5, "kind": "leiste", "xLabel": "X5", "groupId": "dev-f4",
              "homeField": 1, "headField": 1, "offsetMm": 105.5, "widthMm": 61.1, "extentMm": 61.9 } ],
          "parts": [
            { "partId": "2003-7692", "role": "end_plate", "offsetMm": 159.1, "widthMm": 0.8 } ] } ],
      "unplaced": [],
      "missingMm": 0.0 } ],
  "elsewhere": [],                               // [{stripId, homeField, field}] (R6)
  "outside": [],                                 // strip ids whose circuits are in no field ("Nicht im Schrank")
  "noRails": [],                                 // strip ids with a home field but no field with terminal rails at all
  "railParts": { "2003-7692": 2 },
  "insulationSets": 2
}
```

Without the stored order the same field packs by default: rail 1 X1, X2, X3
(158.1 mm), rail 2 X5, X4 (122.1 mm: the rail ends in a Block, so it takes
a `2016-7691`).

* `devicesMm`: Σ `enclosure_device_width_mm` of non-placeholder devices on
  the rail's row (back-compat, R12). The first strip starts after them.
* `extentMm` = `widthMm`, plus the end plate's width when the plate sits
  inside this strip: the rail's last strip, when it ends in a 2009-305.
* `usedMm = devicesMm + Σ strips.widthMm + the end plate's width`.
* `parts`: only the end plate (`role: "end_plate"`). There is no
  `end_stop` role (owner answer (a)).
* `missingMm` = Σ `widthMm` of the unplaced strips. The finding quotes it.
* `unplaced`: `[{ stripId, xLabel, widthMm }]`.
* `headField`: the field of the strip's protective device (`null` for the
  supply group or a head outside the cabinet).

Everything else in the document is unchanged: `rows[]` stays the only
device container (D1), and terminals never enter `rows[]`, so feeds and
topology cannot move because of them.

---

## 3. WAGO terminals: rules and algorithm

### 3.1 Which circuits get terminals (`terminal_skip` ⇄ `terminalSkip`)

`WAGO_ZONE_TYPES = {"VT", "VF", "MM", "SAS"}`. On a board with a cabinet,
every device in a row linked to a resolvable rail whose zone type is **not**
in that set is skipped. On a board without a cabinet the skip set is empty,
and every output stays byte-identical (golden tests).

`board_terminals(document, catalog) -> BoardTerminals(skip, groups)` ⇄
`boardTerminals(doc, index)` is the **only** way to obtain the groups the
placement uses: it derives `groups = derive_terminals(document, skip=skip)`.
`place_terminals(document, catalog, terms=None)` accepts nothing else
(Python: a frozen dataclass checked with `isinstance`; TS: a branded
type), so a caller cannot hand it groups derived without the skip set (a
test pins the mis-call). TS also checks at runtime that the object came
from `boardTerminals` (a `WeakSet`), so an object that only copies
`__brand` is refused with a `TypeError`; Python raises its `TypeError`
before the no-cabinet early return. The TS function memoises in a `WeakMap`
keyed by document identity, per catalogue index. `boardTerminals` reads the
rows leniently, as Python's `iter_devices` does: rows that are not objects
are dropped, a non-array `devices` reads as `[]`, and a well-formed
document passes through as the same object, so the groups and X numbers
stay exactly what the Klemmen tab derives.

`derive_terminals(document, *, skip=frozenset())` ⇄ `deriveTerminals(doc,
skip = EMPTY)` leaves skipped devices out of `terminal_children`. X
numbering then runs over what is left. Every caller on a cabinet board
passes the same skip set, or the Klemmen tab, legend, print and
Materialliste would number differently:

| Caller | Python | TS |
|--------|--------|----|
| detail route `_detail` (legend, findings, `terminal_bom`) | `terminal_view(db, document)` (service: `TerminalView(skip, groups, rail_parts, catalog, terms, placement)`; loads the catalogue once, only with a cabinet, and places once) | — |
| print plan `_terminal_print_plan` | `board_terminal_skip(db, document)` | — |
| Plan PDF (`schaltplan_pdf.py`: legend + Klemmenliste) | `terminal_view` in its route; `terminal_skip` and `rail_parts` passed kw-only | — |
| `build_legend`, `validate_document` (`_strip_name_clashes`) | new kw `terminal_skip` | `buildLegend(doc, skip)`, `validateDocument(doc, skip)` |
| Materialliste | `panel_enclosure_terminal_material` | — |
| findings, placement, geometry, close-up | `board_terminals` | `boardTerminals` |
| SchaltplanPage (legend, findings, terminal groups), EnclosureTab, TerminalList, LabelPrintDialog | — | one `useBoardTerminals(document, index)` in SchaltplanPage, passed down as one `boardTerminals: {ready, terms, placement}` prop (§6.7); outside React, `boardTerminalsState(doc, index)` |

**One stored board for every caller** (D14). `terminal_view`,
`board_terminal_skip`, `schaltplan_material.material_lines` and
`aufbau_pdf` first clean the stored document with `readable_blocks` (new
`panel_enclosure_readable.py`, which also holds `readable_document` and
`INVALID_BLOCK`; `panel_enclosure_service` re-exports all three). This is
the same cleaning the detail route applies through `readable_document`. A
stored cabinet block that the types refuse (written while Slice P was live,
or after a rollback to it) is therefore numbered as a legacy board
everywhere: the screen, the label print, the Plan PDF and the Materialliste
agree, and "Aufbau als PDF" answers **409** `Für diesen Verteiler ist kein
Schrank geplant.`, as the Schrank tab hides such a block.

**Stale clients** (review UPG-5). `POST /panels/{id}/labels` with target
Reihenklemmen answers **409** (`STALE_TERMINALS_DETAIL`, §13) when
`strip_ids` names a strip the board no longer derives. Before, the server
silently dropped it. This catches a pre-round-2 tab's or iOS app's default
"every strip" selection. LabelPrintDialog sends only the ticked ids that
the board still derives, so a current client never trips the guard.

Inspector: `terminalOffered(device, document, skip)` is false for a
skipped device. In place of the checkbox the inspector shows "Im {zone}
keine Reihenklemme — nur in Verteilerfeldern." This holds on the Plan tab
and in the Schrank tab's embedded inspector (`EnclosureSheetHost` passes
`terminalBlockedZone` as well). `DeviceInspector.terminalBlockedZone` is
optional and defaults to `null`.
`setTerminalsEverywhere(document, flag, skip)` leaves skipped devices
alone; the Klemmen tab's "Alle …" buttons run
`editor.mutate(c => setAllTerminalsOnBoard(c, index, flag))`
(enclosureEditorModel), which passes the skip set. On a cabinet board the
Klemmen tab and the label sheet wait for the catalogue ("Schrankkatalog
wird geladen…") instead of showing numbers that would shift once it loads.
If the catalogue fetch fails, the Klemmen tab shows the same alert as the
Aufbau tab (`Schrankkatalog konnte nicht geladen werden.` with **Erneut
laden**), so it never waits forever. While the catalogue loads, the legend
and the Prüfen findings are computed without the skip set and renumber
once it arrives.

### 3.2 Terminal rails (`terminal_rails` ⇄ `terminalRails`)

```python
@dataclass(frozen=True)
class TerminalRail:
    field: int            # cabinet field (zone_field(module, zone))
    position: int         # 0 = top terminal rail, 1 = second
    module_id: str
    rail_key: str
    row_id: str | None    # linked row, if any (back-compat devices)
    title: str            # generated label, "F2 · Verteiler 1"
    capacity_mm: float    # TERMINAL_RAIL_USABLE_MM on a 12-PLE rail, else ple × 17.5 (custom rails)
    devices_mm: float     # Σ widths of non-placeholder devices on row_id
    insulated: bool       # served spec has fitting "u84t"
```

For each module with a resolvable spec, every rail in a `VT` zone with
`mount == "rail"` and `retired == false` is a candidate, keyed by
`(module.unit + zone.unit + rail.unit, module.id, rail.key)` and grouped by
`zone_field(module, zone)`. Each field takes its first two by that key.
Unknown or invalid codes contribute none. A retired top rail is skipped,
and the next VT rail moves up.

| Field contents (built-ins) | Terminal rails |
|----------------------------|----------------|
| ZU37KS / ZU37RK / ZU59KS / ZU59RK | r1, r2 |
| ZU37VT5APZ2, ZU37VT4APZ2, ZU59VT7APZ2, ZU37V5RKAPZ2, ZU59V7RKAPZ2 | r1, r2 |
| ZH3ES5, ZH53XS, ZH3ES5RK, ZH53XSRK (SAS on top) | r1, r2 (below the SAS) |
| meter fields (ZH3E…, ZH33X7, ZH31X7NT, ZH53X3), ZH5EL* (VF on top), communication, ZY150RFZ, covers | none |

### 3.3 Home field (R4)

```python
def device_fields(document, catalog) -> dict[str, int]:
    """device id → cabinet field of the rail its row is linked to (resolvable rails only)."""

def strip_home_field(strip: Mapping[str, Any], fields_of: Mapping[str, int]) -> int | None:
    if strip["kind"] == "block":
        return fields_of.get(strip["device_id"])
    order: list[int] = []            # field of each distinct circuit, in strip order
    seen: set[str] = set()
    for terminal in strip["terminals"]:
        device_id = terminal["device_id"]
        if terminal["part_id"] not in OUTGOING_PART_IDS or not device_id or device_id in seen:
            continue
        seen.add(device_id)
        if device_id in fields_of:
            order.append(fields_of[device_id])
    if not order:
        return None
    counts = Counter(order)
    best = max(counts.values())
    return next(field for field in order if counts[field] == best)   # tie → first circuit's field
```

`headField` = `fields_of.get(group head id)`. A Leiste whose `homeField ≠
headField` (both known) produces `encl.terminals_head_field`.

### 3.4 Packing (`place_terminals` ⇄ `placeTerminals`), the reference implementation

```python
TOLERANCE_MM = 0.05
TERMINAL_RAIL_USABLE_MM = 210.0         # 12-PLE rail. UNVERIFIED (Q1a): Werkstatt measures.
TERMINAL_RAIL_USABLE_VERIFIED = False   # True flips encl.terminals_overflow from info to warn
# No end stops (owner answer (a)): no END_STOPS_ENABLED, no 249-116 part.


def place_terminals(document, catalog, terms: BoardTerminals | None = None) -> dict:
    if terms is not None and not isinstance(terms, BoardTerminals):   # checked before the early return
        raise TypeError("place_terminals needs board_terminals(); groups without the skip set are refused")
    if enclosure_of(document) is None:
        return empty_placement()
    terms = board_terminals(document, catalog) if terms is None else terms
    rails = terminal_rails(document, catalog)                 # {field: (TerminalRail, …≤2)}
    fields_of = device_fields(document, catalog)
    target, elsewhere, outside, no_rails = _assign_fields(terms.groups, rails, fields_of)   # R4, R6
    fields = [_place_field(f, rails[f], target.get(f, []), field_order(document, catalog, f, rails))
              for f in sorted(rails)]
    return _out(fields, terms.skip, elsewhere, outside, no_rails)   # adds railParts, insulationSets


def _place_field(field, rails, strips, order):
    default = sorted(strips, key=lambda s: (s.kind != "leiste", s.no))
    seq = effective_sequence(default, order["strips"] if order else ())
    status = "manual" if order else "default"
    mark = order["rail2_from"] if order else None
    if mark is not None and len(rails) == 2:
        k = next((i for i, s in enumerate(seq) if s.id == mark), None)
        if k is not None and _fits(rails[0], seq[:k]) and _fits(rails[1], seq[k:]):
            return _layout(field, rails, [seq[:k], seq[k:]], [], "manual")
        if k is not None:
            status = "ignored"                      # stored split no longer fits → auto, info finding
    content, cursor, left = [[] for _ in rails], 0, []
    for strip in seq:                               # (b) next-fit keeps X1, X2 … in reading order
        for i in range(cursor, len(rails)):
            if _fits(rails[i], content[i] + [strip]):
                content[i].append(strip); cursor = i
                break
        else:
            left.append(strip)
    unplaced = []
    for strip in left:                              # (c) first-fit: end of rail 1, else end of rail 2
        for i, rail in enumerate(rails):
            if _fits(rail, content[i] + [strip]):
                content[i].append(strip)
                break
        else:
            unplaced.append(strip)
    return _layout(field, rails, content, unplaced, status)


def effective_sequence(default, stored):
    by_id = {s.id: s for s in default}
    seq = [by_id[i] for i in dict.fromkeys(stored) if i in by_id]
    listed = {s.id for s in seq}
    for n, strip in enumerate(default):
        if strip.id in listed:
            continue
        at = 0 if n == 0 else next(i for i, s in enumerate(seq) if s.id == default[n - 1].id) + 1
        seq.insert(at, strip)
        listed.add(strip.id)
    return seq


def _fits(rail, strips) -> bool:
    return _used(rail, strips) <= rail.capacity_mm + TOLERANCE_MM


def _used(rail, strips) -> float:
    """devices, then each strip left → right, then the last strip's end plate."""
    used = rail.devices_mm
    if not strips:
        return used
    for strip in strips:
        used += strip.width
    return used + _plate_mm(strips[-1])
```

* `_Strip.width` = Σ part `width_mm` of `strip["terminals"]`, summed left →
  right in a plain loop in both languages, so the IEEE results match. An FI
  Leiste with k Etagenklemmen is 19.5 + 5.2·k mm, a no-FI Leiste 5.2·k mm,
  a Block 60 mm. `_Strip.end_plate` = the `end_plate` of its last terminal
  that is not in `END_PART_IDS`; `tail_mm` = the width of its trailing
  `END_PART_IDS` parts (a 2009-305 is 7.5 mm).
* `_layout`: the strips go left → right from `devicesMm`, then the end
  plate after the last strip's last terminal block (offset = that strip's
  offset + width − `tail_mm`; when the strip ends in a 2009-305, the clamp
  shifts right by the plate width and the strip's `extentMm` grows by it).
  The plate's open-side orientation (drawn on the right) is **unverified**
  and says so in a code comment, in the close-up legend and in the PDF's
  convention note.
* `railParts`: per terminal rail with ≥ 1 placed strip, its end plate,
  counted. `insulationSets`: the number of those rails with
  `insulated == false`.
* `field_order` takes the precomputed rails as an optional 4th parameter,
  so the placement does not derive them twice (both twins).
* **First-fit example** (fixture `terminals_zb34s`, field 3, 2-TE FIs):
  X7, X8, X9 = FI + 10 LS (71.5 mm), X10 = F9's 3-pole B20 Block (60 mm),
  X11, X12 = FI + 6 LS (50.7 mm). Next-fit: rail 1 X7, X8 (143.8 mm with its
  plate); X9 does not fit there, so rail 2 X9, X11, X12 (173.7 mm); the
  Block fits neither cursor rail. First-fit puts it at the end of rail 1:
  143.0 + 60 + 1.0 = 204.0 mm. Nothing is unplaced (pure next-fit would have
  reported X10 as overflow). Rev 2 used FI + 9 LS for X7/X8; without end
  stops next-fit would then put X9 on rail 1 and the first-fit case would
  never happen, so the board uses 10 LS.
* **Overflow example**: a full ZU59KS field (7 MCB rails below the two
  terminal rails), each FI 4 TE + 8 LS, i.e. seven Leisten of 61.1 mm. Each
  rail takes three (183.3 + 0.8 = 184.1 mm); a fourth would need 245.2 mm.
  X7 is unplaced (61.1 mm). This holds at the assumed 210 mm. At the
  physical ≈ 248 mm a rail would take four and nothing would be unplaced,
  so here the Werkstatt measurement (Q1a, open) decides the outcome.
* **Back-compat example**: §3.6.

### 3.5 Capacity facts used

* `TERMINAL_RAIL_USABLE_MM = 210.0`: the 12-PLE figure (C§3.2), the one
  length known to be clear of the frame. The U842B rail is ≈ 248 mm long
  (hager.json), but how much of it terminals may occupy (frame screws, U84T
  pieces of 27 mm under each rail end, the cover edges over 42.3 mm deep
  terminals) has not been measured (Q1a). The constant is mirrored in TS,
  echoed as `usableMm` in every placement, and pinned in the fixture, so a
  change shows up in one diff. Custom rails with `ple ≠ 12` use `ple ×
  17.5`.
* End plates 0.8 mm (2003-7692) and 1.0 mm (2016-7691): §5.3. No end stops
  (owner answer (a)).
* Widths of the existing parts are from `schaltplan_terminal_rules.py`
  (verified 2026-09-17/19).

### 3.6 Back-compat on reserved rails (R12)

Nothing moves on load. A reserved rail's existing row keeps its devices,
drawn left as today, and the strips follow after them in what is left.

**The owner's board** (fixture `terminals_zb34s`, field 1, ZU37KS): r1 holds
FI F1 + 4 LS (140 mm), r2 holds 3 LS (52.5 mm) and one hand-placed
"Reihenklemme N/PE"; r3–r7 hold five FI × 8 LS. Strips: X1 = F1's Leiste
(7 Etagenklemmen, 55.9 mm), X2–X6 = 61.1 mm each.

* Today: X1 on r1 (140 + 55.9 + 0.8 = 196.7 mm), X2–X3 on r2 (52.5 +
  122.2 + 0.8 = 175.5 mm), X4–X6 unplaced (183.3 mm).
* `encl.terminal_rail_devices` on both rows; the single vacate action moves
  row-old1 and row-old2 together onto F3 · Verteiler 3 and F3 · Verteiler 4
  (field 2, ZU37RK, its first two non-reserved empty rails). F1's group then
  homes in field 2 and renumbers after the field-1 groups (X6 on field 2's
  r1, insulated, so no U84T), and field 1 packs its five 61.1 mm Leisten
  three on r1 (184.1 mm) and two on r2 (123.0 mm).
* `encl.terminals_overflow` for field 1 offers **no** move-circuits action
  while the vacate is pending; its sentence says that vacating first makes
  everything fit (R17, §4.2).
* The placeholder on r2 is not counted and gets `encl.terminal_placeholders`
  (info) with **Platzhalter entfernen**.

**Placeholders.** On a cabinet board, devices of kind `terminal` ("Reihenklemme
N/PE", 1 TE, not a circuit) on a terminal rail stand for the strip's rail
space that pre-R2 boards had to reserve by hand (`_STRIP_NAMED_KINDS`). They
are not counted in `devicesMm`, do not raise `encl.terminal_rail_devices`,
and are not drawn under the strips. Their device line on the Materialliste
stays as long as the device exists (the list follows the document); the
action removes them through `removeDevices`, with **Rückgängig** (§6.5),
which also removes the line. Kinds `terminal` elsewhere and `blank` are
unaffected.

**Vacate action** (`relinkRows`): re-points each **row** to an empty rail
(rows stay the device container; row ids and devices are untouched; a
generated label is relabelled), all in one op that ends with C§2.4 `finish`
(pins and RegroupConfirm if a feed would change). Moving the rows of one
field together keeps a group that spans r1–r2 contiguous, so no LS is
stranded.

**Every path onto a reserved rail**, and its handling:

| Path | Handling |
|------|----------|
| drag / RailPicker (`dropDevice`) | refused: **Diese Hutschiene ist für Reihenklemmen reserviert.** |
| RailSheet "+ Gerät" / template, Aufbau "+ Gerät" on a reserved entry (empty **or** row) | not offered |
| `placeModule({adoptRows})` | skips the field's terminal rails |
| inspector arrows (`moveDeviceIn` hops along `rows[]`) | tolerated; `encl.terminal_rail_devices` fires and offers the move |
| "Gerät duplizieren" (`duplicateDevice`, same row) | tolerated; same finding |
| `placeModule` device fittings of a custom module that sit on r1/r2 | materialised as specified (factory parts); same finding |
| `ensureRailRow` / `addDeviceToRail` called directly | tolerant (ops stay total); the UI never calls them for terminal rails |

Each tolerated path has a test that asserts the finding appears.

---

## 4. Findings

### 4.1 Rules (twins `panel_enclosure_terminal_rules.py` ⇄ `enclosureTerminalRules.ts`)

Called from the existing `enclosure_findings`/`enclosureFindings`, which
take the precomputed `{terms, placement}` (§6.7). The old `_terminals`
check is removed. `RULE_ORDER` replaces `"encl.terminals"` with the ten
rules below, in this order. The compliant fixture board must still yield
zero warns (§14).

| rule | level | fires when | message (German, exact) | scope |
|------|-------|------------|-------------------------|-------|
| `encl.terminals` | info | a field has placed strips | `Feld {n}: {k} Reihenklemmen auf den oberen Hutschienen, {mm} von {cap} mm belegt.` | "" |
| `encl.terminals_overflow` | **info** while `TERMINAL_RAIL_USABLE_VERIFIED` is false, else warn | a field has unplaced strips | `Feld {n}: {s} Klemmleiste(n) passen nicht auf die zwei oberen Hutschienen ({mm} mm ohne Platz{assumed}) — eine dritte Hutschiene wird nicht belegt.` + suggestion sentence (§4.2). `{assumed}` = `, Nutzlänge {usable} mm je Hutschiene angenommen` while unverified, else "" | module id of the field's top terminal rail |
| `encl.terminal_order_ignored` | info | `order == "ignored"` | `Feld {n}: Die manuelle Aufteilung der Klemmleisten passt nicht mehr — automatisch verteilt.` | module id |
| `encl.terminal_rail_devices` | warn | a row on a terminal rail holds non-placeholder devices | `{row}: Hutschiene ist für Reihenklemmen reserviert — {k} Gerät(e) tiefer setzen.` + suggestion sentence | row id |
| `encl.terminal_placeholders` | info | a row on a terminal rail holds `terminal` devices | `{row}: {k} Platzhalter-Reihenklemme(n) — Reihenklemmen werden jetzt aus den Stromkreisen abgeleitet.` | row id |
| `encl.terminals_elsewhere` | info | `elsewhere` not empty (one per home field) | `Feld {n} hat keine Hutschienen für Reihenklemmen — {Xlist} in Feld {m}.` | "" |
| `encl.terminals_no_field` | info | `noRails` or `outside` not empty | `{Xlist}: kein Platz für Reihenklemmen — Stromkreise nicht in einem Verteilerfeld.` | "" |
| `encl.terminals_split` | info | a Leiste's circuits lie in ≥ 2 fields | `{X} ({head}): Stromkreise in Feld {a} und {b} — Reihenklemmen in Feld {f}.` (fields ascending, joined with " und " / ", ") | "" |
| `encl.terminals_head_field` | info | a Leiste's `headField ≠ f` | `{X} ({head}): Schutzgerät in Feld {a}, Klemmen in Feld {f} — N-Zuleitung über die Feldgrenze.` | "" |
| `encl.terminals_zone` | info | a device with `terminal_block: true` is skipped (R3) | `{bmk}: im {zone} — keine Reihenklemme (nur in Verteilerfeldern).` (`{zone}` = `zone_label`: AAR, NAR, RfZ, APZ) | device id |

`{Xlist}` = X labels in strip order, joined with ", ", at most 4, then
` und {k} weitere`. `{mm}` uses `mm_text` (comma decimal). `{head}` uses
`group_head_label`. `encl.terminal_rail_overflow` from rev 1 is gone: a
stored split that does not fit is no longer kept (R5).

As built, these details are pinned in the fixture for both twins:

* `{f}` in `encl.terminals_split` and `encl.terminals_head_field` is the
  field the strip's terminals are **placed** in: its home field, or the
  field R6 sent it to. Rev 2 said `homeField`, which reads falsely whenever
  the home field has no terminal rails (an FI in field 2 whose circuits are
  pinned into a ZH5EL VF in field 1 would read "Klemmen in Feld 1").
  For a strip placed in its home field nothing changes. An R6 strip whose
  head sits in the home field also gets `head_field`, which is true: the N
  feed crosses fields. Example in `terminals_rk_zb53s`: `X1 (F1):
  Schutzgerät in Feld 1, Klemmen in Feld 2 — …`.
* `encl.terminals`: `{k}` counts every terminal of the field's placed
  strips, the 2009-305 included. `{mm}` = Σ `rails[].usedMm` (back-compat
  devices included) and `{cap}` = Σ `rails[].capacityMm` over the field's
  terminal rails, summed in rail order from the rounded values.
* `encl.terminals_no_field` lists `outside` + `noRails` ordered by strip
  number.
* When all unplaced strips of an overflowing field are R6 strips (no
  candidate of its own), its sentence is the ` Kein anderes Feld hat genug
  Platz …` one (§4.2).
* `terminal_findings` never raises. Python's catch-all is not reached on
  garbage documents (tests assert no ERROR log, rail values that are not
  text included). The TS twin also catches any throw, logs `console.warn`
  and returns `[]`.

### 4.2 Suggestions (twins `panel_enclosure_terminal_suggest.py` ⇄ `enclosureTerminalSuggest.ts`)

Pure, deterministic, pinned in the fixture (`terminal_suggestions`). The
finding's sentence comes from the same function, so the text and the action
cannot disagree.

```ts
type RailTarget = { moduleId: string; railKey: string; title: string; field: number };
type TerminalSuggestion =
  | { rule: "encl.terminal_rail_devices"; field: number; kind: "relink_rows"; scopes: string[];
      moves: { rowId: string; target: RailTarget }[] }
  | { rule: "encl.terminals_overflow"; field: number; kind: "move_group"; scope: string;
      headId: string; deviceIds: string[]; targets: RailTarget[] }
  | { rule: "encl.terminal_order_ignored"; field: number; kind: "reset_order"; scope: string }
  | { rule: "encl.terminal_placeholders"; field: number; kind: "remove_placeholders"; scopes: string[]; deviceIds: string[] };
```

One sequential pass, `terminal_suggestions(document, catalog, terms,
placement)`; `taken` (rails already named as a target) carries through all
steps:

1. **Vacate**, per field with reserved rows (fields ascending). `rows` = the
   field's terminal-rail rows with non-placeholder devices, in rail order.
   *Eligible* rail = non-reserved, non-retired `VT` rail with no row or an
   empty row, not in `taken`, and `ple × 17.5 ≥` the row's device width.
   Take the first field, same field first and then by `(|Δ|, index)`, that
   has `len(rows)` eligible rails; the rows get its first ones, top →
   bottom, in rail order. If no single field has enough, each row gets the
   first eligible rail anywhere, in the same order. Eligibility (`ple ×
   17.5 ≥` row width) is checked per (rail, row) pair in order, with all of
   the row's devices, placeholders included, since they travel with the
   row. On a mixed outcome, rows with a target carry the "umhängen"
   sentence naming the targets found, a row without one carries the "Keine
   leere Hutschiene" sentence, and `moves` lists only the rows that got a
   target. Sentences:
   * all rows with a target: ` Vorschlag: {Reihe|Reihen} auf {titles} umhängen.`
     (`{titles}` joined with " und " / ", ");
   * a row without a target: ` Keine leere Hutschiene frei — Geräte einzeln wegziehen (gedrückt halten).`
2. **Hypothetical board.** If step 1 produced any move, `H =
   virtual_relink(document, moves)` and `P' = place_terminals(H)`. Each
   field that overflows in the actual placement gets, **instead of a
   move-circuits action**:
   * ` Zuerst die reservierten Hutschienen räumen (Vorschlag „umhängen“) — danach passen alle Klemmleisten.` when the field has no unplaced strip in `P'`;
   * ` Zuerst die reservierten Hutschienen räumen — danach fehlen noch {mm} mm.` otherwise.
   No `move_group` suggestion is made anywhere on the board while a vacate
   is pending. After the user runs it, everything is recomputed.
3. **Move circuits** (only when step 1 produced nothing), per overflowing
   field f, ascending. The candidate is the first unplaced strip in sequence
   order whose `homeField == f` (strips placed here by R6 are skipped) and
   whose group has a head. `deviceIds` = the head plus the group's circuits
   on rails of field f, in reading order. For each candidate field `m ≠ f`
   with terminal rails, by `(|m − f|, m)`: `targets` = the shortest prefix
   of m's eligible rails (top → bottom) that takes `deviceIds` filled in
   order (each device onto the current target until it is full, never
   reordered). The candidate is **accepted** when, after
   `virtual_move(document, deviceIds, targets)` and re-placing, the board's
   number of unplaced strips is lower and no strip that was placed has
   become unplaced. The first accepted m wins and its rails join `taken`.
   Sentences:
   * accepted: ` Vorschlag: {head} mit {c} Stromkreis(en) nach {titles} verschieben.`
   * none accepted: ` Kein anderes Feld hat genug Platz — Verteilerfeld ergänzen oder bei einzelnen Stromkreisen „Reihenklemme“ abwählen.`
   * the candidate is the supply group (no head): ` Stromkreise vor dem ersten Schutzgerät — einzeln in ein anderes Feld ziehen.`
4. `order == "ignored"` → `reset_order`. Placeholders → `remove_placeholders`.

`virtual_relink` and `virtual_move` (twins in
`panel_enclosure_terminal_virtual.py` ⇄ `enclosureTerminalVirtual.ts`) are
small pure document transforms: rows are re-linked or devices re-homed, new
rows are inserted at their physical position (the C§2.3 order twin), and
nothing is relabelled. They exist only to re-place. **As built they pin
like the real ops** (review WAGO-1): after the physical reorder, every
circuit whose feed changed and whose old head is still a head gets
`parent_id` = the old head, the C§2.4 `preserveFeeds` rule that the real
`relinkRows`/`moveGroupToRails` apply in `finish()`. Rev 2 said they pin
nothing. Unpinned, a group run that spills over a field line, or runs on
from r2 onto r3, gave the virtual board other Leisten than the real op: the
pass refused a move that would have fixed the board and said "Verteilerfeld
ergänzen" instead. Rail entries that are not text ids are left untouched
(`module_rails`), as the TS twin does, so garbage never costs the findings
(review sec-2).

Parity: `enclosureOpsTerminals.test.ts` asserts that the real ops on the
fixture suggestions, and on the test boards `spill_zb53s` /
`run_over_r2_zb32s` (twins in both languages), give the same pins and
placement as the virtual ones. There is no randomized Python ⇄ TS check of
pinned virtual boards; the shared fixture did not change with the pinning,
because no fixture board crosses a row or field line.

`suggestionPass` (TS) is memoised per document in a `WeakMap`, keyed on the
identity of (index, terms, placement); `terminalSuggestions` hands out a
copy of the memoised array. So the page's findings, the Schrank tab and the
Aufbau actions share one pass per edit (§6.7).

UI (§7.4): EnclosureFindings shows a 56 px button **Vorschlag ausführen**
(or **Reihenfolge zurücksetzen** / **Platzhalter entfernen**) on a finding
whose `(rule, scope)` has a suggestion. The close-up's "Ohne Platz" section,
the reserved-rail banner and the Aufbau tab's reserved rows (§9) offer the
same buttons. Actions run through the op runner (C§2.4 pinning and confirm)
and then show the drop note with **Rückgängig** (§6.5). The Schrank tab
builds the action buttons only on an editable board; the finding sentences
are the same either way.

---

## 5. Materialliste

### 5.1 Lines (cabinet boards only; legacy boards byte-identical)

| Order (C§6) | kind | key | label | detail | planned |
|-------------|------|-----|-------|--------|---------|
| 3 accessories | `enclosure` | `accessory:U84T` | `Isolierstück univ. Z, mit Schrauben, Satz=2 St.` | `Hutschienen-Isolierung je Klemmen-Hutschiene · Hager U84T` | `max(Σ admin accessories U84T on the board's modules, insulationSets)`; the derived label wins |
| 5 terminals | `terminal` | `part:2003-7692` | `WAGO 2003-7692` | `Abschluss- und Zwischenplatte, 0,8 mm, orange` | `railParts["2003-7692"]` |
| 5 terminals | `terminal` | `part:2016-7691` | `WAGO 2016-7691` | `Abschlussplatte, 1 mm, grau` | `railParts["2016-7691"]` |

There is no `part:249-116` line (owner answer (a)).

* The terminal lines on a cabinet board come from
  `panel_enclosure_terminal_material.terminal_lines(document, catalog,
  terms, placement)`: `terminal_bom(terms.groups, extra=railParts)`, so
  the rail parts sort into `TERMINAL_PART_ORDER`. Skipped AAR/NAR/RfZ/APZ
  circuits therefore no longer count. Legacy boards keep
  `_terminal_lines(document)`.
* U84T uses `max`, not a sum: an admin who added U84T as a module accessory
  meant the same physical sets. `line_article_numbers` always maps
  `accessory:U84T` → `U84T`; `line_eans` gives the EAN only when
  `u84t_planned > 0`.
* Hand-added lines (`panel_material_manual_lines`) are **not** de-duplicated
  against the new derived lines. On a board where the Werkstatt added an end
  plate or a U84T by hand under v2.15.0, the derived line takes the booked
  pieces first (`allocate_scans`), the hand line reopens and the planned
  total doubles until someone deletes or shortens the hand line. The deploy
  report counts these boards (§16, review UPG-1).
* No placed strip means no U84T and no rail-part line. Unplaced strips
  still count their terminals (they must be bought), but they add no rail
  parts.
* **Every Stückliste carries the rail parts** on a cabinet board: the
  detail route's `terminal_bom`, the Klemmen tab (`TerminalList`, through
  `useBoardTerminals`), and the Klemmenliste PDF. So the detail route's
  terminal BOM equals the Materialliste terminal lines (§14.2 asserts it).
* Consumption (C§6) already ticks the kinds `enclosure` and `terminal`. The
  Regal station needs no change. `PUT /material/mapping` already accepts
  `accessory:` and `part:`.

### 5.2 Article matching

Order for `accessory:U84T`:

1. the explicit mapping;
2. **EAN** `4010330552465` exact on `werkstatt_articles.ean`, with
   archived and merged articles excluded (the column has a partial unique
   index, so at most one hit);
3. the supplier number `U84T`;
4. the whole token `U84T` in the name (C§3.4: "U84TX" never matches).

End plates use `auto_match_part("WAGO 2003-7692")` like every WAGO part. The EAN is a code constant (`U84T_RAIL_SET_EAN`) in
`panel_enclosure_terminal_material.py`, not catalogue data. C§3.2 "no EANs
in the catalogue" stands; this one identifies the owner-named article.

Code move (forced by the 800-line cap: `schaltplan_material.py` is at
792): `explicit_mappings`, `auto_match_part` and `resolve_line_articles`
move unchanged into new `services/schaltplan_material_match.py` and are
re-exported from `schaltplan_material`. Then `resolve_line_articles(db,
lines, numbers, eans=None)` gains step 2 via
`match_articles_by_ean(db, eans)`: one batched `IN` query. As built,
`schaltplan_material.py` went from 792 to 740 lines, not the planned −80.

### 5.3 Part table additions (`schaltplan_terminal_rules.py` ⇄ `schaltplanTerminalRules.ts`)

`TerminalPart` gains `end_plate: str | None = None` (TS `endPlate`) and the
role `"rail_part"`. `END_PLATE_PART_IDS = {"2003-7692", "2016-7691"}`,
`RAIL_PART_IDS = END_PLATE_PART_IDS` (no end stop, owner answer (a)).
`TERMINAL_PART_ORDER` becomes `2003-7641, 2003-7642, 2003-7692, 2009-305,
2016-7601, 2016-7604, 2016-7607, 2016-7691, 2016-7714`. Legacy BOMs are
unchanged, because order only matters for parts in use.

| Part | name | width | marker | verified | source |
|------|------|-------|--------|----------|--------|
| 2003-7692 | Abschluss- und Zwischenplatte, 0,8 mm, orange | 0.8 | no | yes | WAGO datasheet 2003-7641 (Stand 28.05.2026), "Notwendiges Zubehör … 2003-7692": https://www.ottofischer.ch/pim/606cdaba-26c8-4370-8d87-2d49619b437f/WAGO_2003-7641de.pdf ; https://www.wago.com/gb/10001/p/2003-7692 |
| 2016-7691 | Abschlussplatte, 1 mm, grau | 1.0 | no | yes | WAGO datasheet 2016-7601 (Stand 03.06.2026), "Notwendiges Zubehör: 2016-7691 Abschlussplatte; 1 mm dick; grau": https://ariba.ottofischer.ch/pim/8abfa8a1-008b-442b-a07f-081fec7025bc/WAGO_2016-7601de.pdf ; https://www.wago.com/nl/rijgklemmen/afsluitplaat/p/2016-7691 |

The WAGO 249-116 end stop (6 mm) that rev 2 listed here is **not** in the
table: the owner ruled it out on 2026-10-22.

| Terminal | `end_plate` | status |
|----------|-------------|--------|
| 2003-7641 | 2003-7692 | **verified** (its datasheet) |
| 2003-7642 | 2003-7692 | **unverified**: same 2003-76xx housing assumed; the comment says so |
| 2016-7601 | 2016-7691 | **verified** (its datasheet) |
| 2016-7604, 2016-7607 | 2016-7691 | **unverified**: same 2016-76xx housing assumed |
| 2016-7714 | None | never a rail's last terminal block: a Leiste with a feed always ends in an outgoing and 2009-305. Its series plate would be 2016-7792 (unverified), which is not modelled |
| 2009-305 | None | carrier with end-clamp function, skipped when looking for the last terminal block. Its break-out separator plate closes the **N busbar** end ("berührungsgeschützter Abschluss einer N-Sammelschiene", 2009-305 datasheet, Stand 31.05.2026), not the terminal's open side, so the end plate stays. One end plate per rail, after its last terminal: a Leiste in the middle of a rail gets none (owner answer (a); Q1d closed) |

The ` · ungeprüft` suffix (C§6) is not used on part lines. The unverified
mappings are code comments and doc rows, as for the widths.

---

## 6. Drag & drop

### 6.1 Mechanism: Pointer Events, not `@dnd-kit`

`apps/web/package.json` pins `@dnd-kit/core` 6.3.1, `@dnd-kit/sortable`
10.0.0 and `@dnd-kit/utilities` 3.2.2, used only by `DashboardEditor.tsx`.
They are **not** used here:

* the drop targets are scene geometry in mm (rail bands, device centres),
  not DOM rectangles, so the insertion maths is ours either way;
* the draggables are SVG `<rect>`s (dnd-kit refs are typed for
  HTMLElement), and they are deliberately not tab stops (C§11), while the
  KeyboardSensor needs focusable draggables;
* dnd-kit's `delta` mixes in scroll compensation, and the hit test needs
  raw client coordinates;
* a pure state machine plus a pure hit test can be unit-tested in jsdom 29,
  which lacks `setPointerCapture`, `getScreenCTM` and layout.

From dnd-kit's TouchSensor we copy the iPad technique (§6.6). No
dependency is added or removed. The technique is proven on WebKit **before**
any UI is built (slice W0, §11).

### 6.2 Gesture (`dragMachine.ts`, pure; `useLongPressDrag.ts`, the hook)

States: `idle → pressing → armed → dragging → idle`.

| Pointer | pressing → armed | cancels before arming | armed → dragging | release in `armed` |
|---------|------------------|-----------------------|------------------|--------------------|
| touch / pen | `LONG_PRESS_MS` = 450 still | movement > `SLOP_PX` = 8: native scroll goes on | movement > `SLOP_PX` after arming | **tap**: the hook calls `onTap(sourceId, pressedElement)` itself (RailSheet), no drop; the one click that follows is swallowed |
| mouse (button 0) | — (goes straight to dragging) | release before `MOUSE_SLOP_PX` = 6 = click | movement > 6 px | — |

* A release in `pressing` is an ordinary click, so RailSheet opens and the
  one tap rule holds. A slow gloved tap (held 700 ms, never moved) is a tap
  too. Only a release in `dragging` commits a drop.
* **WebKit quirk** (W0 spike, iPadOS 26.5 simulator): Mobile Safari sends a
  click about 40 ms after a long press that is released in place; other
  browsers may not. So the hook reports the long-press tap itself
  (`onTap`), and after that tap and after every drop it swallows **exactly
  one** click: a window capture listener eats the first click within
  `SUPPRESS_CLICK_MS` = 400 ms and `SUPPRESS_CLICK_RADIUS_PX` = 32 px of
  the release point. Without it the rail would open twice; a deliberate tap
  elsewhere (Rückgängig right after a wrong drop) still goes through. Rev 2
  had "no click suppression" for the tap and a check in
  `Target.onActivate`.
* `onTap` also receives the element the press began on. The close-up uses
  it to select the terminal (`[data-item]`) under the finger, so a slow tap
  on a terminal of an editable board opens its details as a quick tap
  does, and only a slow tap on the strip's own background selects just the
  strip (R9, D16; review ui-3).
* Abort: Escape, `pointercancel`, and a **new** `pointerdown` inside the
  scroller after the press began. Pointers already down when the press
  began (a thumb resting on the glass) are ignored. When Escape or a new
  pointer ends a shown drag, the one click at the pressing pointer's
  later release is swallowed as after a drop (§6.6).
* On arming: `setPointerCapture?.(id)` (guarded for jsdom),
  `navigator.vibrate?.(15)` (absent on iPadOS), and the ghost and label
  appear at once (§6.6), so a wrong pick can be released in place.
* Drag sources exist only when `onMoveDevice` / `onMoveStrip` props are
  passed, and those are left out on read-only boards, as `onPickSlot` is
  today. Only in the Offen view.
* `LONG_PRESS_MS`, `SLOP_PX` and `MOUSE_SLOP_PX` are named constants,
  settled by the W0 spike; the glove check on a real iPad (§14.4) is still
  **open**.
* One long-press hook per scroll container (`useDrawingDrag.ts`) picks a
  device drag or a strip drag from the source's box id (`terminal:` prefix
  = strip); two hooks would both start on one press.

### 6.3 Drop targets (`enclosureDropTargets.ts`, pure)

```ts
export function clientToSceneMm(svgRect: DOMRect, zoom: number, client: { x: number; y: number }): { x: number; y: number };
// x = (cx − rect.left − DRAWING_PAD_PX) / zoom ; y = (cy − rect.top − FIELD_HEADER_PX − DRAWING_PAD_PX) / zoom

export type DropRefusal = "terminal_rail" | "retired" | "row_order" | "other_field" | "not_terminal_rail" | "too_full";
export interface DeviceDrop { moduleId: string; railKey: string; rowId: string | null; at: number;
  indicatorX: number; bandBoxId: string; title: string; afterLabel: string | null;
  overMm: number /* > 0: rail too full, warn only (D10) */; refused: DropRefusal | null }
export function deviceDropAt(index: DropIndex, point: { x: number; y: number }, dragged: string | readonly string[]): DeviceDrop | null;
// `dragged`: the travelling group (dragGroup, R18); its devices are all taken out before `at` is counted
export interface StripDrop { field: number; rail: 0 | 1; moduleId: string; railKey: string; at: number;
  indicatorX: number; overMm: number; refused: DropRefusal | null; bandBoxId: string; title: string }
export function stripDropAt(index: DropIndex, placement: TerminalPlacement, point: { x: number; y: number }, stripId: string,
  measure?: (target: StripTarget) => number /* stripMoveOverMm: the op's own fit number */): StripDrop | null;
export function buildDropIndex(scene: EnclosureScene, bands: RailBand[],
  opts: { reserved: ReadonlySet<string>; rowsInOrder: boolean; overMmOn?: RailFitMeasure }): DropIndex;  // once per drag start
```

* Band choice: the field under the point (`fieldIndexAt`) first. Within it,
  the band containing the point; otherwise the band whose **rectangle**
  (dx and dy) is nearest, within 1.5 × band height (needed at 0.2 px/mm,
  where a band is 18 px). Bands of other fields never win a tie.
* `at` = the number of the rail's **other** devices whose centre lies left
  of `point.x`. That index applies after the dragged device is taken out.
* Refused, with a red label and no drop: for a device, a terminal rail
  (`terminal_rail`), a retired rail, or any rail while the board's rows are
  out of cabinet order (`row_order`, R19); for a strip, a rail that is no
  terminal rail (`not_terminal_rail`), another field's terminal rail
  (`other_field`), or a result that does not fit (`too_full`, with
  `overMm`). Busbar rails accept devices (SLS onto NAR).
* Device `overMm` reuses the rail-fit helper that `sheetModel.railInfo` and
  `RailPickerSheet` use. W2a moved it into `enclosureDropTargets.ts`, both
  import it, and `buildDropIndex` takes it as `overMmOn`, so the drop label
  and the picker cannot disagree. Strip `overMm` is `stripMoveOverMm`, the
  op's own number (§6.4), cached per (rail, place) during a drag.
* The drawing has no document or catalogue index, so EnclosureFrontSvg
  takes `dragSource(deviceId)` and `stripSource(stripId)` callbacks that
  return the drag source (or `null`).
* A device drop reads the reserved set from the board it is applied to
  (`terminalRailKeys(current)`), not from the last render.
* `RailBand` (enclosureFrontLayout.ts) gains `field`, `retired` and
  `reserved`.

### 6.4 Ops (pure, `utils/enclosureOpsDrag.ts` and `utils/enclosureOpsTerminals.ts`)

```ts
/** R10: the one regroup rule for drag, RailPicker and the inspector arrows. */
export function followPosition(before: PanelDocument, after: PanelDocument, deviceId: string): PanelDocument;
// positionalHead(doc, id) = the last device before `id` in reading order that opens a run by the topology's own
// rule (isGroupDevice, or a fuse with feeds_following: buildTopology's `current`), ignoring id's own parent_id.
// (Read literally, TS `opensGroup` covers fuses only and would ignore FIs.)
// If opensGroup(device, after) → after (a head keeps its feeder link).
// Else if positionalHead(before, id) === positionalHead(after, id) → after (a nudge inside a run keeps a deliberate cross-feed).
// Else → after with the device's parent_id cleared (identity kept when it was already null).

export interface FeedChange { deviceId: string; from: string; to: string }   // head ids, "" = Einspeisung
export type DropResult =
  | { ok: true; document: PanelDocument; deviceId: string; changes: FeedChange[]; unchanged: boolean }
  | { ok: false; error: string };

/** Drag and RailPicker. Positional (R10): no physical re-sort, no pinning. */
export function dropDevice(doc: PanelDocument, index: CatalogIndex, deviceId: string,
  target: { moduleId: string; railKey: string; at: number },
  opts?: { reserved?: ReadonlySet<string> /* "moduleId:railKey" = terminalRailKeys(current) */ }): DropResult;

/** R18: what one drag moves — a non-head alone; a group head first, then every circuit it feeds
 *  (feedMap) in the head's own field, in reading order. [] for an unknown device. */
export function dragGroup(doc: PanelDocument, index: CatalogIndex, deviceId: string): string[];
```

1. The device must exist (`Gerät nicht gefunden.`). The target rail must
   resolve and must be neither retired nor in `opts.reserved` (`Diese
   Hutschiene ist für Reihenklemmen reserviert.`). The board's linked rows
   must be in cabinet order (`Reihen sind nicht in Schrankreihenfolge — erst
   „Reihen ordnen“.`, R19).
2. Same row and same `at` → `{ok: true, document: doc, unchanged: true}`
   (identity, so `mutate` saves nothing).
3. `ensureRailRow`, then `moveDevicesInto(doc, dragGroup(…), rowId, at)`:
   the device, or the group head with its circuits as one block (`at` is an
   index after removal, clamped), then `followPosition` for each moved
   device in turn.
4. `pruneEmptyRailRows` (exported from `enclosureOpsCore.ts`) →
   `normalizeEnclosure` → the `MAX_ROWS` refusal. No `withPhysicalOrder`
   (the board is in order by step 1, and `ensureRailRow` inserts at the
   physical position) and no `preserveFeeds`.
5. `changes` = every device whose `feedMap` entry differs between `doc` and
   the result.

A **group head travels with its group** (R18, owner answer (b)): FI/RCD,
Hauptschalter, a flagged or named fuse. Every circuit it feeds in its own
field travels right behind it in reading order, whether it follows by
position or is pinned to it from another run. Circuits of the group in
another field (a deliberate cross-field feed, or a run that spills over the
field line) stay where they are: the installer drags the FI block he sees.
The RailPicker runs the same `dropDevice`, so it moves the same group. One
consequence the owner may want to look at: a circuit in the same field that
is pinned to the FI from another run now lands next to it; its feed stays,
and the pin is dropped because position now gives the same feed. Rev 2's
"FI alone" and `dropGroup` are gone.

`moveDeviceIn` (usePanelDocumentEditor.ts, the inspector arrows) returns
`followPosition(document, moved, deviceId)`. Its behaviour changes only for
circuits with an explicit `parent_id` that cross into another head's run.

```ts
export function planStripMove(doc, index, stripId, target, pre?): StripPlan | { error: string };
// StripPlan: { field; holderId; rails: string[][]; unplaced: string[]; over; split: boolean; unchanged: boolean }
export function stripMoveOverMm(doc, index, stripId, target, pre?): number;   // the drag label's number; 0 = fits
export function moveTerminalStrip(doc, index, stripId, target: { field: number; rail: 0 | 1; at: number }): OpResult;
// takes the field's current rails (as placed), removes the strip, inserts it into rail `target.rail` at `at`;
// sequence = rail 1 + rail 2 + still-unplaced strips.
// With strips on rail 2, a split at rail 2's first strip is tried first: rail 1 must hold its list and rail 2
// its list PLUS the unplaced strips (R5). If that does not fit but the sequence with rail2_from = null packs into
// exactly the requested rails, that is taken (split: false; stripMoveOverMm 0). rail2_from is stored only when
// split is true. Without strips on rail 2 the field packs automatically; only the target rail must hold its own.
// refuses another field: `Klemmen gehören zu Feld {n} — die Stromkreise verschieben, nicht die Klemmen.`
// refuses a place no packing gives: `Passt nicht: {mm} mm zu viel auf Hutschiene {r}.` ({r} = the rail that runs over)
// refuses `Feld {n} hat keine Hutschiene {r} für Reihenklemmen.` and `Klemmleiste nicht gefunden.`
// writes only current strip ids, to the holder of the field's first terminal rail; deletes the entry when
// the result equals the default placement; identity when unchanged
export function resetTerminalOrder(doc, index, field: number): PanelDocument;
export function relinkRows(doc, index, moves: { rowId: string; target: { moduleId: string; railKey: string } }[]): OpResult;
// every target must be empty: `Hutschiene ist nicht leer.`; relabels generated labels; one finish (C§2.4)
export function moveGroupToRails(doc, index, deviceIds: string[], targets: { moduleId: string; railKey: string }[]): OpResult;
// fills the targets in order without reordering; one finish (C§2.4)
export function removeTerminalPlaceholders(doc, index, deviceIds: string[]): PanelDocument;   // removeDevices
```

Rev 2 stored `rail2_from` = rail 2's first strip whenever rail 2 was
non-empty. On a field with any unplaced strip that split can never fit
(the unplaced strips count onto rail 2), so every manual move there was
refused, even a plain reorder on rail 1, and the message named rail 2
(review WAGO-2). As built, a field that still waits for its vacate (the
owner's board) can be reordered.

`removeDevices` (schaltplanDocumentOps) also drops `"{id}:leiste"` /
`"{id}:block"` from every module's `terminal_order`. `placeModule`'s
`adoptRows` skips the field's terminal rails.

### 6.5 Note and undo (`useDropUndo.ts`, `DropNote.tsx`, `dropNoteText.ts`)

```ts
export function useDropUndo(args: { document: PanelDocument | null; mutate: EditDocument }): {
  note: { lines: string[]; canUndo: boolean } | null;
  run(op: (current: PanelDocument) => DropResult | OpResult, describe: (before: PanelDocument, after: PanelDocument) => string[]): void;
  remember(before: PanelDocument, after: PanelDocument, lines: string[]): void;   // op-runner actions, after RegroupConfirm
  undo(): void; dismiss(): void;
};
```

* `run` calls `mutate` **once**, on drop, never on pointermove. Inside the
  recipe it keeps `{before: current, after: result.document}`. A refusal
  leaves `current` and shows the error; `unchanged` shows nothing.
* `remember` serves the suggestion actions (§4.2), the vacate, the
  move-circuits action, the strip moves and **Platzhalter entfernen**:
  `useEnclosureOpRunner` gains `onCommitted(before, after)`, called after
  its confirm. As built, only the terminal actions feed it to `remember`:
  `useTerminalActions.ts` runs the strip moves, the reset and the
  suggestions through an op runner of its own, and
  `useAufbauTerminalActions.tsx` reuses it on the Aufbau tab with
  RegroupConfirm, a backdrop and DropNote. Wiring it to every runner op
  would put a Rückgängig note on every sheet edit. So "Vorschlag
  ausführen" gets the same **Rückgängig** as a one-breaker drag.
* `undo` = `mutate(c => c === after ? before : c)`. The editor's `mutate`
  returns early on identity, `normalizeEnclosure` returns its input for a
  clean board, and the editor never adopts the server document after an
  autosave, so the identity survives the save. Tests pin all three.
* `canUndo` is `document === after`. Any later edit hides the button; undo
  is one step only.
* **Lines** (`describeDrop(before, after, index, terms?)`, pure, at most 5
  lines, then `…`):
  1. `{bmk} verschoben: {title}, Platz {i}.`; a group head: `{bmk} mit {n}
     Stromkreisen verschoben: {title}, Platz {i}.` (strips: `{X}
     verschoben: Feld {n} · Hutschiene {r}.`; a finding's action: what it
     did, see below)
  2. feeds: one change `{bmk} hängt jetzt an {to} (vorher {from}).`;
     several `{n} Stromkreise hängen jetzt an einem anderen Schutzgerät:
     {a} {from} → {to}, …` (at most 3, then ` und {k} weitere`). Heads are
     named with `group_head_label` (`Einspeisung` for "").
  3. terminals (cabinet boards; `boardTerminals` + `placeTerminals` before
     and after): `Klemmen neu nummeriert: {X3 → X4, …} — Beschriftung neu
     drucken.` (strips present in both whose `xLabel` changed, at most 3);
     `{X} jetzt in Feld {n}.`; `{X} hat keinen Platz mehr in Feld {n}.`;
     `{X} hat jetzt Platz in Feld {n}.`
  4. `Im {zone} keine Reihenklemme für {bmk}.` when a `terminal_block`
     device lands in a no-WAGO zone.
* **Line 1 of a finding's action** is not in §13 and needs an owner
  decision (**open**, §17). As built: `Vorschlag ausgeführt: Reihe(n) auf
  {titles} umgehängt.` · `Vorschlag ausgeführt: {head} mit {n}
  Stromkreis(en) nach {titles} verschoben.` · `Reihenfolge der Klemmleisten
  in Feld {n} zurückgesetzt.` · `{n} Platzhalter-Reihenklemme(n) entfernt.`
* **Placement**: a fixed bottom bar (`position: fixed`, `bottom:
  env(safe-area-inset-bottom)`), stacked **above** the sheet backdrop, so
  it is visible below a 75dvh drawing. Buttons **Rückgängig** and ×, both
  ≥ 56 px. `role="status"`, `aria-live="polite"`, text set once per note.
  The RailPicker path closes all sheets before the note appears (it no
  longer returns to the inspector). The note stays until dismissed, until
  the next drop, or until another edit lands.
* **The note lifts the sheets** (review ui-1). Rev 2 drew it over an open
  sheet, so at phone width it covered sheet footers: RegroupConfirm's
  **Trotzdem ausführen**, RailSheet's **+ Gerät**, the palette's last
  tiles. As built, DropNote sets `data-sp-dropnote` and `--sp-dropnote-h`
  (the bar's height, measured with a `ResizeObserver`, tracked per instance;
  the sheets end above the tallest note) on `<html>` while a note is shown,
  and removes them when it goes or unmounts.
  `schaltplan-enclosure-drag.css` then ends every `.sp-sheet` above the bar:
  below 768 px `bottom: calc(var(--sp-dropnote-h) + safe-area)` and
  `max-height: calc(88vh − var)`; from 768 px `bottom: auto`, `top:
  calc(50% − var / 2)` and `max-height: calc(84vh − var)`. While the note
  is up it still covers the bottom of the drawing itself (about 75 px on
  an iPad); in one mouse attempt a press landed on the bar instead of a
  breaker in the bottom row. Dismiss it with ×.

### 6.6 iPad, Android and desktop details

* `.sp-encl-scroll` keeps `touch-action: manipulation`, so a finger that
  moves before the long-press fires scrolls natively. **On mount** the hook
  registers one non-passive `touchmove` listener on the scroll container
  (`{passive: false}`). It calls `preventDefault()` only while `armed` or
  `dragging`. This is the dnd-kit TouchSensor technique: Safari and Chrome
  only honour `preventDefault` from a listener that was non-passive before
  the gesture. 8 px of slop stays inside Chrome's own touch slop, so no pan
  has started when the drag arms.
* `.sp-encl-svg`: `-webkit-touch-callout: none; -webkit-user-select:
  none`. `contextmenu` inside the SVG gets `preventDefault` (Android fires
  it on long-press). `overscroll-behavior: contain` on the scroller.
* Edge auto-scroll (`dragAutoScroll.ts`, extracted from the hook; review
  ui-2): the drawing's scroller has zones 48 px inside its **visible**
  part, its rect clipped to `window.visualViewport` **and to every
  scrolling ancestor**. A rAF loop scrolls by `round((48 − d) / 48 × 18)`
  px per frame and recomputes the target every frame. Per axis the
  scroller moves first, by its own zones; then each ancestor that scrolls
  on that axis, innermost first (in the close-up: the sheet body, because
  `.sp-term-scroll` scrolls only sideways; in the wide layout:
  `main.content`), by the ancestor rule below; then the page. The page
  **never** scrolls behind a fixed layer: a sheet is `position: fixed`, and
  scrolling the cabinet page under its backdrop only moves what nobody
  sees. `scrollFrameOf` reads the ancestors once per drag (computed styles,
  innermost first), and the rects are read once per frame. Rev 2 said
  "when the scroller cannot scroll further, the window scrolls": then a
  strip drag in the close-up never scrolled the sheet, the bottom zone lay
  below the sheet's edge, and the page behind the modal scrolled instead.
* **Ancestor rule** (`ancestorStep`, `pageStep`): an ancestor never moves
  from the drawing's zones. Every scrolling ancestor after the drawing's
  scroller has zones of its own, 48 px inside what of it is on screen (its
  rect clipped to the scrolling ancestors around it and to the visual
  viewport). It moves only towards a side where the drawing, clipped to the
  scrolling ancestors inside it, still runs beyond that visible edge, so it
  stops once the drawing's edge is on screen and never runs on to its own
  end. The page is the outermost case: its zones lie at the visual
  viewport's edges, and the drawing is clipped to every scrolling ancestor.
  The rule first covered only the page. On a phone the drawing often fits
  and ends mid-screen, and a finger held still on its bottom rail sits in
  the drawing's own zone. Measured against the drawing, that scrolled the
  window under the finger every frame until the page ended (review F1,
  390 × 844). The browser recheck then found the same failure in the wide
  layout, where `main.content` (`overflow-y: auto`) scrolls instead of the
  window (recheck R1, 1180 × 820 iPad landscape and 1366 × 1024).
  `main.content` was chained after the drawing and driven by the drawing's
  zones, so it ran from 1033 to 1286, its end, under a still finger, and
  the label lost its drop target. Under the rule it holds still there. It
  scrolls only for a finger at its own visible edge while the drawing
  still runs past that edge. The close-up is unchanged, because its
  drawing does run past the sheet body's edge, and so is the window on a
  phone.
* **The click after a cancel** (recheck note): Escape (an iPad with a
  hardware keyboard) or a second finger ends a shown drag, armed or
  dragging, while its pointer is still on the glass. The browser still
  sends a click when that finger lifts, and before this fix the click
  opened the rail sheet. The hook now remembers that pointer
  (`releasing`), keeps its window listeners until the pointer's
  `pointerup`, and there swallows the one click exactly as after a drop:
  within `SUPPRESS_CLICK_MS` = 400 ms of the release and
  `SUPPRESS_CLICK_RADIUS_PX` = 32 px of the release point. The window
  starts at the release, not at the Escape, so a finger held for seconds
  is covered. A `pointercancel` sends no click and clears it, and a press
  cancelled before it armed was never shown, so its release stays an
  ordinary click. If the release was missed, the next `pointerdown` of the
  same pointer clears it.
* WebKit width (found in the browser proof): the app shell's
  `grid-template-columns: 1fr` lets WebKit count a scroll container's
  content in the page width. Round 2's extra **Klemmen Feld {n}** buttons
  pushed a ZB34S field bar past an iPad's portrait width: the page grew to
  1089 px, the root `overflow-x: clip` cut it off, and fit-to-width chose a
  bigger zoom. Fix: `contain: inline-size` on `.sp-encl-scroll` and
  `.sp-encl-fieldbar` (shipped `schaltplan-enclosure.css`). The Plan tab
  (≈ 4233 px) and the Aufbau tab (855 px) widen the page the same way on
  v2.15.0 already; that pre-existing case is out of scope for round 2.
* On an iPad a long-press can land on another breaker than intended when
  a swipe's momentum scroll is still running as the finger comes down. The
  gesture itself works; wait for the drawing to stop before pressing.
* Feedback:
  * the source is dimmed by an overlay rect in `EnclosureDragLayer` (the
    device picture itself never re-renders during a drag);
  * a ghost of at least 44 × 44 px with the BMK inside, offset 56 px above
    the finger (a gloved contact patch covers 4–6 breakers at 0.45 px/mm);
  * the target band gets `is-drop-target`, and a constant-px insertion bar
    is drawn;
  * a floating label in a fixed-position portal (never clipped by the
    scroller), shown from the moment of arming: `{bmk} {short} → {title} ·
    nach {bmk}` (e.g. `F1.4 LS B16 → F2 · Verteiler 3 · nach F1.3`), plus
    ` · zu voll: {mm} mm über` or the refusal; a group head's source half
    reads `{bmk} {short} {rating} mit {n} Stromkreisen`. The close-up uses
    the same portal (`DragOverlay`, exported from `EnclosureDragLayer`,
    §7.2);
  * an `aria-live` echo updated only when (rail, at, refusal) changes.

### 6.7 Performance at a full ZB55S

A full ZB55S has 45 rails, ≈ 540 devices, ≤ 40 strips and ≈ 800 boxes.

* **Once per document**: SchaltplanPage calls `useBoardTerminals(document,
  index)` → `{ready, terms, placement}` and passes it to EnclosureTab,
  TerminalList, LabelPrintDialog, `buildLegend`/`validateDocument` and
  `enclosureFindings`. `terminalFindings`, `terminalSuggestions`,
  `buildEnclosureScene` and `terminalCloseup` take the precomputed values.
  `boardTerminals`/`placeTerminals` also memoise by document identity, so a
  forgotten pass-down costs a lookup, not a recompute. `placeTerminals` is
  memoised per (catalogue index, document, terms); a board without a
  cabinet gets a fresh `emptyPlacement()` (not memoised), which
  `useBoardTerminals`' `useMemo` keeps stable. `suggestionPass` is memoised
  per document too (§4.2). EnclosureTab prefers the page's `boardTerminals`
  and falls back to its own `useBoardTerminals`. Close-ups are computed only
  while a "terminals" sheet is open.
* **During a drag**: `buildDropIndex` runs once at drag start (per band its
  y-range, x-range and sorted device centres). A hit test is then O(bands +
  devices on one rail), under 0.1 ms. Pointer moves land in a ref, and a
  rAF callback updates a tiny store read only by `EnclosureDragLayer`
  (ghost, bar, label, dimming overlay). `EnclosureFrontBoxes`/`HitLayer` do
  not re-render: the drag layer is a sibling `<g>`, and `BoxShape` becomes
  `React.memo` with a memoised `ShapeState`. The document, scene and
  placement are recomputed only after the single `mutate` on drop.
* **Guards**: a vitest timing test on a ZB55S fixture board (median of 5
  runs of `boardTerminals` + `placeTerminals` + `terminalFindings` +
  `terminalSuggestions` + `buildEnclosureScene` ≤ 40 ms in jsdom; catches
  O(n²) regressions, not micro-costs). The device proof (§14.4) covers
  inspector typing as well as dragging.

### 6.8 Keyboard / non-drag alternatives (kept)

* DeviceInspector "Nach links / Nach rechts" (positional, now with
  `followPosition`).
* "Auf andere Hutschiene…" (RailPickerSheet) gets a second step: **Wohin
  auf {title}?**, with buttons **Am Anfang**, **Nach {bmk}** (one per
  device on the rail) and **Am Ende**. It then hands `{moduleId, railKey,
  at}` to the tab's `onDropDevice`, which runs `dropDevice` through
  `useDropUndo`, so it moves the same group (R18) and shows the same note
  and undo after closing all sheets. Terminal rails are listed as disabled,
  "für Reihenklemmen reserviert".
* Strips: the close-up's buttons (§7.2).
* SVG devices stay non-focusable (C§11). The note is announced.

---

## 7. Close-up ("Nahansicht") of the WAGO rows

### 7.1 Pure layout (`panel_enclosure_terminal_closeup.py` ⇄ `enclosureTerminalCloseup.ts`)

```ts
interface CloseupItem {
  kind: "terminal" | "end_clamp" | "end_plate";   // no "end_stop" (owner answer (a))
  partId: string; partNo: string;              // "2003-7641", "WAGO 2003-7641"
  stripId: string | null; xLabel: string;      // the strip's "X3"; "" for rail parts
  offsetMm: number; widthMm: number;           // on the rail, from its left end (devices included)
  marker: string;                              // after overrides; "" without marker
  levels: string[];                            // conductors on this terminal, top → bottom
  forText: string;                             // same text as TerminalGroupCard's "für" column
  cable: string;                               // device.cable, trimmed
  deviceId: string | null;
}
interface CloseupRail { moduleId: string; railKey: string; title: string; position: 0 | 1; capacityMm: number;
  usedMm: number; insulated: boolean; devices: { deviceId: string; label: string; offsetMm: number; widthMm: number }[];
  items: CloseupItem[] }
interface TerminalCloseup { field: number; order: "default" | "manual" | "ignored"; rails: CloseupRail[];
  unplaced: { stripId: string; xLabel: string; title: string; widthMm: number }[] }
function terminalCloseup(doc, index, terms?, placement?): TerminalCloseup[]   // fields with terminal rails, ascending;
// derives terms and placement when they are not passed, as Python's terminal_closeup does
```

`levels`:

| Part | levels | source |
|------|--------|--------|
| 2003-7641, 1-pole outgoing | `["N", phase, "PE"]`, phase = `device.phase` if L1/L2/L3, else `"L"` | **verified**: 2003-7641 datasheet, "Potentialkennzeichnung NT/L/PE", symbol: top N (N-Trennschlitten), middle L, bottom PE ("Potential – Masse") |
| 2003-7641 / 2003-7642, 3-pole outgoing | `["N", "L1", "PE"]` / `["L2", "L3"]` | 2003-7642 order **unverified** (code comment, legend note) |
| 2016-7714 | `["N"]` | |
| Block cells | `[pole]` (N, L1, L2, L3, PE) | |
| 2009-305, end plate | `[]` | |

The marker is drawn **above** the terminal. That is a drawing convention:
WAGO marks the middle/side ("Beschriftungsebene Mitten-/Seitliche
Beschriftung"). The close-up legend says so.

`forText`: the TerminalGroupCard rule. The Python twin moved from
`schaltplan_pdf_terminals._for_text` to `schaltplan_terminals.py` as
`terminal_for_text` (with `rcd_detail`), next to the derivation, so the
close-up does not import the PDF module; `schaltplan_pdf_terminals.py`
re-imports both under their old private names. The TS twin is
`terminalForText` / `rcdDetail` in `enclosureTerminalCloseup.ts`;
`TerminalGroupCard.tsx` still keeps a private copy, equal for well-formed
devices. The feed reads `FI {bmk} · {rating} {residual}`; an outgoing reads
`{bmk} · {label} · Nr. {circuit}`; the end clamp reads `—`.

**Text fit** (`label_fit.py` ⇄ `labelFit.ts`, pure, shared by app and PDF):

```ts
export interface LabelFit { text: string; size: number; rotated: boolean; truncated: boolean }
export function fitLabel(text: string, cell: { w: number; h: number }, size: { max: number; min: number }, scale = 1): LabelFit;
// 1. horizontal at max if it fits; 2. horizontal, shrunk to ≥ min; 3. rotated 90° (cell h as the length) at max…min;
// 4. ellipsis at min, in whichever orientation holds more characters.
// Width = Σ Helvetica AFM advance widths (one table in both languages, fallback 556/1000 em) × size × scale.
```

The PDF uses `scale = 1`; the app uses `scale = 1.1` (its UI font is not
Helvetica, so it keeps a margin). Unit tests in both languages run the same
table of cases: the fixture's top-level `label_fit` table (`[{text, cell:
{w, h}, size: {max, min}, scale, fit}]`). Details pinned as built: a size
must also be ≤ the cell's cross side; a shrunk size is floored to 0.1; only
trailing U+0020 is cut before the `…` (TS `replace(/ +$/, "")`, not
`trimEnd`, whose whitespace set differs from Python's `rstrip()`); "holds
more characters" compares the prefix length before those spaces are cut,
and a tie stays horizontal.

### 7.2 App: `TerminalCloseupSheet` (Schrank tab sheet stack)

* New sheet kind `{ kind: "terminals"; field: number; stripId: string |
  null }` in `useSheetStack.ts`, rendered by `EnclosureSheetHost.tsx`.
* Opened by:
  * a tap on a terminal rail's band in the 2D drawing;
  * a tap on a strip box (that strip selected);
  * the field bar button **Klemmen Feld {n}** (≥ 56 px, only for fields
    with terminal rails). When strips are unplaced, ` · {k} ohne Platz` is
    in its `aria-label`, and `{k} ohne Platz` shows as a visible second
    line.
* **One drawing for both rails** (`TerminalCloseupSvg`), in one horizontal
  scroller of its own, `.sp-term-scroll` (the root has `overflow-x: clip`),
  so the rails line up and scroll together, and one drop index covers both.
  The scroller has `flex: none`: in Chromium it collapsed to its 2 px
  border inside the sheet body's flex column, which jsdom cannot see. The
  pure px layout and the `fitLabel` calls live in `terminalCloseupLayout.ts`.
  Horizontal scale
  5 px/mm (210 mm → 1050 px; a 5.2 mm terminal is 26 px). Vertical sizes
  are fixed, not to scale. Per rail, top → bottom:
  * the heading `Hutschiene {1|2} · {title} · {used} von {cap} mm` and a
    chip, **U84T ab Werk** or `U84T: 1 Satz auf der Materialliste`;
  * a 40 px marker zone: the marker, `fitLabel` with min 11 px (rotated in
    the zone when wider than the terminal, else ellipsis);
  * a 160 px terminal body: part number small, the levels as stacked tags,
    WAGO colours (grey 2003/2016-7601, blue 2016-7714/7604 and 2009-305,
    green-yellow 2016-7607, orange 2003-7692, grey 2016-7691);
  * a rotated column with `forText` and `cable` (two lines at ≥ 11 px,
    `fitLabel`); its height follows the longest fitted text, capped at
    220 px.
  * Devices on a reserved rail are drawn grey before the strips, with the
    banner from `encl.terminal_rail_devices` and the buttons **Vorschlag
    ausführen** / **Geräte bearbeiten** (pushes RailSheet).
* Tap a terminal (quick, or slow on an editable board, §6.2): it is
  selected, its row in the `TerminalStripCard` below is highlighted, and a
  details block under the drawing shows the full Klemme, Beschriftung,
  Leiter, für and Leitung (nothing is lost to the fit rule). Rev 2 called
  it a popover.
* Strip selection and the keyboard alternative: tap a strip to select it.
  Then **Nach links**, **Nach rechts**, **Auf Hutschiene 2** / **Auf
  Hutschiene 1** and **Reihenfolge zurücksetzen** (only when the field has
  a stored order). They run `moveTerminalStrip` / `resetTerminalOrder`
  through `useDropUndo`. Moves work on a field that still has strips
  without place (§6.4). A long-press drag of a whole strip works here too,
  with the same hook. Strip targets are the strip's extent × the body
  height; the smallest is 26 px wide (a one-terminal no-FI Leiste), so the
  buttons stay as the fallback.
* **The drag label is in a fixed portal** (review ui-2): during a strip
  drag the label and a ghost float on the page through the shared
  `DragOverlay`, so they cannot scroll away with the sheet body. The
  in-sheet `.sp-term-drag-label` stays only as a visually hidden polite
  echo. Edge auto-scroll reaches rail 2 through the sheet body (§6.6).
* Below the drawing: `TerminalStripCard` (unchanged) per strip.
* The section **Ohne Platz** lists the unplaced strips, with the finding's
  sentence and its action button.
* `order == "ignored"`: a banner with the finding text and **Reihenfolge
  zurücksetzen**.
* Empty field: `Noch keine Reihenklemmen in Feld {n} — Stromkreise mit
  „Reihenklemme“ erscheinen hier.`

### 7.3 PDF: one page per field with placed terminals (`panel_enclosure_pdf_terminals.py`)

* As built the code is three files, laid out as data first so a test can
  check every drawn string against its cell: `panel_enclosure_pdf_terminals.py`
  (the pages, `draw_terminal_closeup_pages`, `closeup_layout`),
  `panel_enclosure_pdf_terminal_sheet.py` (layout primitives, every text
  carries its cell) and `panel_enclosure_pdf_terminal_legend.py` (the
  legend pages).
* `build_aufbau_pdf` draws, after page 1 (front view) and before the
  Materialliste pages, `draw_terminal_closeup_pages(c, plan=…, closeup=…,
  company_name=None)`.
* Page format: A4 landscape, 12 mm margins (273 × 186 mm usable). Title
  `Reihenklemmen · Feld {n} · {VT-Nr.} {name}`, then `Maßstab 1:1 (Breite)
  — zum Anlegen an die Hutschiene` and a **Kontrollmaß 100 mm** bar (so a
  fit-to-page print on an iPad/AirPrint is detectable).
* Each rail at **1:1 across** (the rail outline is `capacityMm × 72/25.4`
  pt), stacked in two ≈ 84 mm blocks. A custom rail longer than the 273 mm
  usable width is drawn scaled down, with `Verkleinert: die Hutschiene ist
  länger als das Blatt — nicht zum Anlegen` in place of the 1:1 line:
  * the rail heading, the U84T state and the rail part (`Abschlussplatte
    {part}`);
  * a 10 mm marker strip above the terminals: `fitLabel` at 6 → 5 pt,
    rotated when wider than the terminal, else ellipsis;
  * a 30 mm terminal band, each part its true width, the levels **inside**
    the band (`fitLabel`, ≥ 5 pt);
  * a 40 mm column of rotated `forText` and cable: the column under each
    terminal splits its width between the two, 5.5 → 5.0 pt, `fitLabel`
    with ellipsis.
* When any terminal text on the page was shortened, the next page is a
  legend: `Reihenklemmen · Feld {n} · Legende`, a table with X, marker,
  part, levels, für and cable in full. Device labels on a reserved rail do
  not trigger it. Legend pages are capped at 4 per field, with `… und {n}
  weitere` at the end.
* The page's convention note (`Beschriftung oben gezeichnet (WAGO:
  Mitte/seitlich) · Abschlussplatte rechts angenommen`) marks the
  unverified Werkstatt facts.
* Footer: unplaced strips (`Ohne Platz: X7 (FI F7)`), cut off with `… und
  {n} weitere`.
* Text only via `canvas.drawString` and `saveState`/`rotate`, never
  Paragraph markup.
* Page count = 1 + fields with placed terminals + legend pages +
  Materialliste pages.
* A stored cabinet block the types refuse gets no Aufbau PDF at all (409,
  §3.1).

### 7.4 Findings with actions

`EnclosureFindings` gains the prop `actions: ReadonlyMap<string, { label:
string; run(): void }>`, keyed by `` `${rule}|${scope}` `` (a `relink_rows`
or `remove_placeholders` suggestion registers each of its scopes).
EnclosureTab builds it from `terminalSuggestions` and runs each action via
the op runner, whose `onCommitted` feeds `useDropUndo.remember` (§6.5).

---

## 8. Geometry and renderers (`panel_enclosure_geometry.py` ⇄ `enclosureGeometry.ts`)

* `SceneBoxKind` += `"terminal_strip"`. Flags += `"terminals"` (on a
  reserved rail box, drawn even when empty).
* Open view only: one box per placed strip.

  | id | x | y | z, d | w × h | label | refs |
  |----|---|---|------|-------|-------|------|
  | `terminal:{stripId}` | rail.x + `offsetMm` | cy − 48 | 47.5, 42.3 | `extentMm` × 96 | `xLabel` | `moduleId`, `railKey`, `rowId` = rail's row or null, `deviceId` null, `zoneType` "VT" |

  96 × 42.3 mm is the 2003-7641 body: a drawing approximation, labelled as
  such in the code. End plates are not 2D boxes (≤ 1.3 px at the largest
  zoom); the close-up draws them.
* The closed view gets no terminal boxes, because they sit behind the
  cover. The rail's `cover_slot` is unchanged.
* `build_enclosure_scene(document, catalog, view, placement=None)` /
  `buildEnclosureScene(doc, index, view, placement?)` accept the
  precomputed placement.
* Renderers:
  * `EnclosureFrontBoxes`: light-grey strip (`--sp-term-grey` #c9ced4,
    outline `--sp-term-outline` #2d3a48) with its X label, hatched orange
    "terminals" rail tint (`--sp-term-reserved`);
  * `enclosureThreeScene`: colour key `terminal_strip` (0xb9c0c8, slightly
    darker than the 2D grey);
  * `panel_enclosure_pdf._fill`: the 2D colours; a terminal rail is
    #f8d6b7, the opaque print version of the web's orange tint and hatch.
* The accessible name of a reserved rail band (not in rev 2's §13) is
  `Hutschiene {title} · für Reihenklemmen reserviert · X1, X2, X3`
  (`· noch keine` when it holds no strip), plus ` · {n} Gerät(e)` for
  devices left there from before R2. It reuses
  `enclosureEditorModel.reservedRailLine`, as the Aufbau tab does. Before
  the fix it read `· leer` on a rail that held four strips.
* `mm_text` moved from `panel_enclosure_rules.py` into
  `panel_enclosure_geometry.py` (TS: `formatMmText` into
  `enclosureGeometry.ts`), because the terminal rules need it and importing
  the rules module would be circular; both rules modules re-export it.
* Hit layer: strip targets (kind `"strip"`) are painted above the rail
  bands, in the same layer as devices. The paint-order test is extended.
  A tap on a strip or a reserved band calls `onOpenTerminals(field,
  stripId | null)`. A tap on a device on a reserved rail still opens
  RailSheet.
* Fixture: `scene_open` changes for every board with terminals. Re-run the
  writer.

---

## 9. Aufbau tab fix (O6)

Root cause (bug map): `railEditorGroups` keeps only linked rows and
`continue`s past a module without any. That hides:

* an empty ZU37VT5APZ2 (its RJ45 fitting creates no row);
* every cover;
* every unknown code;
* a linked row on a retired rail that is empty but carries a custom label
  (`moduleRails` drops empty retired rails, and the "Nicht im Schrank"
  filter excludes linked rows).

```ts
// enclosureEditorModel.ts
export type RailEditorEntry =   // xLabels: the strips placed on a reserved rail (as built)
  | { kind: "row"; row: PanelRow; reserved: boolean; xLabels: readonly string[] }
  | { kind: "empty"; moduleId: string; railKey: string; title: string; ple: number; reserved: boolean; xLabels: readonly string[] };
export interface RailEditorGroup { key: string; title: string; linked: boolean; entries: RailEditorEntry[]; note: string | null }
```

* For every module in `modulesInOrder`: `moduleRails(...)` gives a row
  entry or an empty entry (`title` = the generated label the row would
  get, `ple`). Then any linked row of the module not listed yet is
  appended (the retired-rail case).
* Never `continue`. With no entries, `note` = `Keine Hutschiene` (cover)
  or `Modulcode unbekannt — Reihen unter „Nicht im Schrank“`.
* "Nicht im Schrank" stays last, unchanged.
* `reserved` comes from `terminalRailKeys` (§3.2), wired in W4b.
* RailEditor renders an empty entry as an unnamed
  `<section className="sp-rail sp-rail--empty">`: plain-text name, `leer ·
  {ple} PLE`, and a **+ Gerät** tile (aria `Gerät auf {title}
  hinzufügen`). Read-only shows `Keine Geräte erfasst.` instead. There is
  no slot input and no ×, and the section is no region, so the existing
  role-count tests stay green.
* A reserved **empty** entry shows `für Reihenklemmen reserviert · X7, X8,
  X10` (the strips placed there), or `für Reihenklemmen reserviert · noch
  keine`, without quote marks, and no "+ Gerät".
* A reserved **row** entry keeps its devices and inspector, shows the
  `encl.terminal_rail_devices` finding's own sentence as its banner with
  **Vorschlag ausführen**, and has **no "+ Gerät" tile and no palette**.
  RailEditor takes `findings` and `findingActions` props and finds the
  action by `findingKey(rule, rowId)`; it imports `FindingAction` from
  EnclosureFindings. The action runs through `useAufbauTerminalActions.tsx`
  (W3's `useTerminalActions` with RegroupConfirm, a backdrop and the drop
  note with **Rückgängig**). Arrows and "duplizieren" stay (tolerated,
  §3.6).
* The new prop `onAddDeviceToRail(t: {moduleId; railKey; label})` opens
  the palette, and the pick runs `addDeviceToRail` through the new hook
  `useAufbauRailAdd` (wraps `useEnclosureOpRunner` + `SheetBackdrop` +
  `RegroupConfirm`). That gives C§2.4 pinning (toast) and confirmation
  exactly as on the Schrank tab, and keeps the SLS → HS link. The new
  device's inspector opens.
* `SchaltplanPage.paletteRowId` becomes `paletteTarget: {rowId} | {moduleId;
  railKey; label} | null`. As built, that state lives in the new hook
  `components/schaltplan/useSchaltplanPalette.ts` (`PaletteTarget`), which
  also calls `useAufbauRailAdd`, so SchaltplanPage stays under 800 lines
  (765 after W4b).
* The styles (`.sp-rail--empty`, `.sp-rail-empty-name`, the "+ Gerät" tile,
  `.sp-rail-group-note`, `.sp-rail--reserved`, `.sp-rail-reserved`) went into
  `schaltplan-enclosure-tab.css` next to the RailEditor group block:
  `src/styles/schaltplan.css`, which rev 2 named, does not exist.
* Every rail is shown individually, without collapsing; an installer picks
  the exact rail. Empty lines are one 56 px row.
* While the catalogue loads, Aufbau stays the flat list, as today. If the
  catalogue fetch fails, Aufbau shows `Schrankkatalog konnte nicht geladen
  werden.` with **Erneut laden** above the flat list.

---

## 10. Catalogue additions (O7, `panel_enclosure_catalog_data.py`, `panel_enclosure_catalog.py`)

`_part(...)` gains `verified: bool = True, note: str = ""`. `_with_apz` and
`_with_busbars` gain a `fittings` parameter (default: today's tuples);
`_with_apz` also takes `unverified`, so the two APZ variants carry their
"APZ-Höhe … angenommen" note.

```python
_U84T = _part("u84t", "Hutschienen-Isolierung U84T (ab Werk)", "U84T", verified=False,
              note="Lieferform RK: U84T statt PE/N-Klemmblöcken (Hager-Flyer 21DE0246); "
                   "Anzahl der Sätze ab Werk nicht angegeben (Foto: 1 Satz ZU37RK, 2 Sätze ZU59RK)")
```

The set-count caveat lives only on the fitting (`FittingSpec` has `verified`
and `note`). A module's `unverified` list is not touched, so ZU37RK and
ZU59RK **stay verified** and existing RK boards gain no `encl.unverified`
line.

| Code | Family | Field h | Zones (top → bottom) | Fittings | Module `unverified` |
|------|--------|---------|----------------------|----------|----------------------|
| ZU37RK (chg) | distribution | 1050 | unchanged | **+ u84t** (appended) | unchanged (verified) |
| ZU59RK (chg) | distribution | 1350 | unchanged | **+ u84t** | unchanged (verified) |
| ZU37V5RKAPZ2 | distribution_apz | 1050 | VT 0–4 (r1…r5) · APZ 5–6 (apz, ple 6, sealable) | u84t | "APZ-Höhe wie ZU37VT5APZ2 angenommen" |
| ZU59V7RKAPZ2 | distribution_apz | 1350 | VT 0–6 (r1…r7) · APZ 7–8 | u84t | "APZ-Höhe wie ZU59VT7APZ2 angenommen" |
| ZH3ES5RK | busbar | 1050 | SAS 0–1 (sas, busbar) · VT 2–6 (r1…r5) | busbar (SAS), u84t (no pe_n) | `_SAS_POSITION`, `_SAS_SEALED` |
| ZH53XSRK | busbar | 1350 | SAS 0–1 · VT 2–8 (r1…r7) | busbar, u84t | `_SAS_POSITION`, `_SAS_SEALED` |

* Rows, height, "APZ unten", "mit SaS 12x5mm" and "ohne QC-Klemmen" are
  confirmed by the hager.com catalogue pages (2026-10-22), which also mark
  all four codes **Auslaufprodukt**. hager.com does not mention an RJ45
  socket for the two APZ variants, so they get **no** `rj45` fitting
  (fitting keys are append-only: leaving it out is the reversible choice).
  U84T in all six RK fields: Hager flyer 21DE0246.
* Names: ZU37V5RKAPZ2 `Verteilerfeld, 5 Reihen, für Reihenklemmen, APZ
  unten, 1050 mm`; ZU59V7RKAPZ2 `Verteilerfeld, 7 Reihen, für
  Reihenklemmen, APZ unten, 1350 mm`; ZH3ES5RK `Verteilerfeld mit
  Sammelschienen, 5 Reihen, für Reihenklemmen, 1050 mm`; ZH53XSRK
  `Verteilerfeld mit Sammelschienen, 7 Reihen, für Reihenklemmen, 1350 mm`.
* Rail keys are identical to the KS/VT siblings. `source_url` =
  `_catalog_page(code)`. The new codes are appended at the end of
  `BUILTIN_MODULES`; C§3.5 makes codes and keys append-only.
* `tests/fixtures/enclosure_catalog_shipped.json` gets the 4 codes (frozen
  fields, rail keys, fittings with kinds `null`) and `"u84t": null` under
  ZU37RK and ZU59RK. The table in `test_panel_enclosure_catalog_data.py`
  grows with them. No frozen field of a shipped code changes.
* **`_merge_override`** (panel_enclosure_catalog.py): after validating an
  override's spec, append every built-in fitting whose key the override
  lacks, in built-in order. This extends C§3.5 ("fitting keys are
  append-only") from versions of one spec to built-in → override. Rails are
  not appended (no built-in gained a rail in R2). Consequences: a ZU37RK
  override saved under v2.15.0 is served with `u84t`; an admin edit of it
  saves the served spec, so the key becomes stored; `check_change` then
  keeps it. As built, the merged spec is re-validated (`_with_builtin_fittings`);
  if the schema would refuse it (more than 16 fittings, or a built-in
  device fitting on a rail the override lacks) the override is served
  unchanged and the case is logged once. Serving a 17-fitting spec would
  leave an entry the admin could never save again. With today's built-ins
  and realistic overrides the guard never fires.
* **A custom row that becomes a built-in.** A row for one of the four new
  codes created on v2.15.0 (e.g. through "Im Lager, nicht im Katalog →
  Eintrag anlegen") is treated as an override of the new built-in after the
  deploy, with `u84t` appended. Its own zone stack stays. The deploy report
  names any such row (§16); the owner keeps it or resets it with the
  existing `DELETE /enclosure-catalog/{code}/override`, which `check_change`
  guards (the built-in must keep every rail and fitting key the row's
  boards use).
* **Correcting an assumed stack later.** `frozen_fields` freezes zone types
  and meter places, not zone sizes or positions (C§3.5). So a wrong APZ
  height or SAS position can be corrected after boards use the code, as a
  data change plus a shipped-fixture update, as long as rail keys stay.

---

## 11. Slices, files, ownership, order

The tables below are the build **plan**. The files the build added or
touched beyond them are listed in §20.2; as built, `schaltplan_layout.py`
is 1123 lines, `schaltplan_pdf.py` 864, `schaltplan_material.py` 740,
`workflow_schaltplan.py` 783 and `SchaltplanPage.tsx` 765.

Builders write only their own rows; a file shared by two slices is edited
by them **in sequence**, never in parallel. New files stay < 800 lines.
Files already over the cap are only touched with pass-through changes and
must not grow: `schaltplan_layout.py` 1158 (T1 moves `_strip_name_clashes`
out, net negative), `schaltplan_pdf.py` 865 (M: one `terminal_skip` kw,
≤ +4 lines). Other counts that matter: `schaltplan_material.py` 792,
`workflow_schaltplan.py` 765, `SchaltplanPage.tsx` 737 (if W4a + W4b would
pass 800, extract `useSchaltplanPalette`), `panel_enclosure_rules.py` 609,
`enclosureRules.ts` 589, `schaltplanTerminals.ts` 580,
`enclosureTab.test.tsx` 571 (new tab tests go into new files).

```text
K ─→ T1 ─→ T2 ─────────→ M
      │      └─→ W1b ──┐
      └─→ W1a ─┬───────┤
W0 ─→ W2a ─────┼───────┴─→ W3
W4a ───────────┴─→ W4b
```

* K, T1, W0 and W4a start now. T1 writes the fixture first from a stub, so
  W1a's types and parity tests exist before the numbers do.
* W2a needs only W0 (it uses an empty reserved set until W3 passes the real
  one). W3 needs W2a and W1b. W4b needs W1a and W4a.

### Slice W0 — WebKit spike (1 day, not merged)

A throwaway page on a spike branch: one SVG with 30 rects in an
`overflow:auto` scroller, the gesture of §6.2 and the touchmove guard of
§6.6. Proven in the iOS Simulator's Mobile Safari (`touch_path`
long-press-then-drag), Android Chrome (CDP `Input.dispatchTouchEvent`) and
by the owner on a real iPad, with and without gloves. Output: the three
constants, and any WebKit quirk written into §6.6. As run: the iPadOS 26.5
simulator's Mobile Safari only; it found the click after a long press
(§6.2). Android Chrome and the real iPad are still owed (§14.4).

### Slice K — catalogue data (Python)

| File | New/Chg | Responsibility |
|------|---------|----------------|
| `app/services/panel_enclosure_catalog_data.py` | chg (≈ +45) | §10 data |
| `app/services/panel_enclosure_catalog.py` | chg (≈ +15) | `_merge_override` appends missing built-in fittings |
| `tests/fixtures/enclosure_catalog_shipped.json` | chg | 4 codes, `u84t` keys |
| `tests/test_panel_enclosure_catalog_data.py`, `tests/test_panel_enclosure_catalog.py` | chg | table rows; RK codes carry `u84t`; ZU37RK/ZU59RK stay verified; override without `u84t` is served with it; promoted custom row |

### Slice T1 — terminal core (Python)

| File | New/Chg | Responsibility |
|------|---------|----------------|
| `app/services/schaltplan_terminal_rules.py` | chg (≈ +60) | end plates, `end_plate`, `RAIL_PART_IDS`, part order (§5.3); no end stop |
| `app/services/schaltplan_terminals.py` | chg | `derive_terminals(…, skip)`, `terminal_bom(…, extra)` |
| `app/services/schaltplan_terminal_checks.py` | **new** (≈ 70) | `_strip_name_clashes` moved here, with `terminal_skip` |
| `app/services/schaltplan_layout.py` | chg (net < 0) | `build_legend` / `validate_document` kw `terminal_skip`, call the moved check |
| `app/services/panel_enclosure_terminals.py` | **new** (≈ 420) | §2.1 parser, §3: skip, `board_terminals`, rails, home fields, order, placement, rail parts, insulation |
| `app/schemas/panel_enclosure.py` | chg | `terminal_order` via `parse_terminal_order` |
| `scripts/write_enclosure_fixtures.py`, `scripts/enclosure_fixture_boards.py` (**new**) | chg/new | board builders move out; new boards; keys `terminal_skip`, `terminal_placement` (§14.1) |
| `apps/web/src/test/fixtures/enclosureFixtures.json` | regenerated | — |
| tests | new/chg | §14.2 rows 1, 3, 4 |

### Slice T2 — terminal views and rules (Python)

| File | New/Chg | Responsibility |
|------|---------|----------------|
| `app/services/label_fit.py` | **new** (≈ 120) | §7.1 fit rule + width table |
| `app/services/panel_enclosure_terminal_closeup.py` | **new** (≈ 220) | §7.1 |
| `app/services/panel_enclosure_terminal_virtual.py` | **new** (≈ 120) | `virtual_relink`, `virtual_move` |
| `app/services/panel_enclosure_terminal_suggest.py` | **new** (≈ 260) | §4.2 |
| `app/services/panel_enclosure_terminal_rules.py` | **new** (≈ 240) | §4.1 |
| `app/services/panel_enclosure_rules.py` | chg | remove `_terminals`, `RULE_ORDER`, call the new checks with precomputed values |
| `app/services/panel_enclosure_geometry.py` | chg (≈ +45) | §8 |
| fixture writer | chg | keys `terminal_closeup`, `terminal_suggestions`; `scene_open` |
| tests | new/chg | §14.2 row 2 and the closeup/fit cases |

### Slice M — Materialliste, PDF, routes (Python)

| File | New/Chg | Responsibility |
|------|---------|----------------|
| `app/services/schaltplan_material_match.py` | **new** (≈ 140) | moved matching + `match_articles_by_ean` (§5.2) |
| `app/services/schaltplan_material.py` | chg (net −80) | re-exports; cabinet branch calls `terminal_lines` |
| `app/services/panel_enclosure_terminal_material.py` | **new** (≈ 170) | terminal + rail-part lines, U84T line (`max`), `line_eans` |
| `app/services/panel_enclosure_material.py` | chg | `enclosure_planned_lines(…, rail_sets=0)`; `line_article_numbers` += `accessory:U84T` |
| `app/services/panel_enclosure_pdf_terminals.py` | **new** (≈ 300) | §7.3 pages and legend |
| `app/services/panel_enclosure_pdf.py` | chg | strip fill, call the close-up pages |
| `app/services/panel_enclosure_service.py` | chg | `board_terminal_skip(db, document)` |
| `app/routers/workflow_schaltplan.py` | chg (≤ +12, stays < 800) | `_detail` + print plan pass the skip; `terminal_bom` with rail parts |
| `app/services/schaltplan_pdf.py` | chg (≤ +4) | `terminal_skip` kw passed through to legend and Klemmenliste |
| `app/services/schaltplan_pdf_terminals.py` | chg | Stückliste rows for rail parts on cabinet boards |
| `scripts/report_terminal_impact.py` | **new** (≈ 80) | read-only deploy check (§16): counts only, no names |
| tests | new/chg | §14.2 |

### Slice W1a — TS core twin of T1

| File | New/Chg | Responsibility |
|------|---------|----------------|
| `src/types/panelEnclosure.ts` | chg | `terminal_order`, `TerminalPlacement`, closeup, suggestion types, `SceneBoxKind` += `terminal_strip` |
| `src/utils/schaltplanTerminalRules.ts` | chg | §5.3 twin |
| `src/utils/schaltplanTerminals.ts` | chg | `deriveTerminals(doc, skip)`, `terminalBom(groups, extra)` |
| `src/utils/schaltplanTopology.ts` | chg | `buildLegend`/`validateDocument`/`terminalOffered` take `skip` |
| `src/utils/schaltplanDocumentOps.ts` | chg | `setTerminalsEverywhere(…, skip)`; `removeDevices` prunes `terminal_order` |
| `src/utils/enclosureTerminals.ts` | **new** | §2.1 parser, §3 twin, `boardTerminals` (memoised) |
| `src/hooks/useBoardTerminals.ts` | **new** | `{ready, terms, placement}`; `ready` false while a cabinet board's index loads |

### Slice W1b — TS twin of T2

| File | New/Chg | Responsibility |
|------|---------|----------------|
| `src/utils/labelFit.ts` | **new** | §7.1 fit rule |
| `src/utils/enclosureTerminalCloseup.ts`, `enclosureTerminalVirtual.ts`, `enclosureTerminalSuggest.ts`, `enclosureTerminalRules.ts` | **new** | twins |
| `src/utils/enclosureRules.ts` | chg | remove terminals check; rule order; precomputed inputs |
| `src/utils/enclosureGeometry.ts` | chg | §8 twin |

### Slice W2a — device drag

| File | New/Chg | Responsibility |
|------|---------|----------------|
| `…/enclosure/dragMachine.ts` | **new** | §6.2 state machine (pure) |
| `…/enclosure/useLongPressDrag.ts` | **new** | listeners, capture, touchmove guard, auto-scroll, click suppression |
| `…/enclosure/enclosureDropTargets.ts` | **new** | §6.3 device part (pure) + the shared rail-fit helper |
| `…/enclosure/EnclosureDragLayer.tsx` | **new** | ghost, bar, dimming overlay, label portal, live echo |
| `…/enclosure/DropNote.tsx`, `…/enclosure/useDropUndo.ts`, `…/enclosure/dropNoteText.ts` | **new** | §6.5 (feed lines; W3 adds terminal lines) |
| `src/utils/enclosureOpsDrag.ts` | **new** | `dropDevice`, `followPosition` |
| `src/utils/enclosureOpsCore.ts` | chg | numeric position; export `pruneEmptyRailRows` |
| `src/hooks/usePanelDocumentEditor.ts` | chg | `moveDeviceIn` → `followPosition` |
| `…/enclosure/EnclosureFrontSvg.tsx`, `EnclosureFrontBoxes.tsx` | chg | drag sources, `onMoveDevice`, `reservedRails` prop (default empty), `React.memo` BoxShape |
| `…/enclosure/enclosureFrontLayout.ts` | chg | `RailBand.field/retired/reserved` |
| `…/enclosure/RailPickerSheet.tsx`, `sheetModel.ts` | chg | position step, reserved rails disabled, `dropDevice`, closes the stack; moved fit helper |
| `…/enclosure/useEnclosureOpRunner.ts` | chg | `onCommitted(before, after)` |
| `…/enclosure/EnclosureTab.tsx` | chg | device drag, note and undo wiring |
| `src/styles/schaltplan-enclosure-drag.css` | **new** | drag classes; `.sp-encl-svg` callout/select rules; note bar |

### Slice W3 — terminal UI (single owner of the terminal wiring)

| File | New/Chg | Responsibility |
|------|---------|----------------|
| `src/utils/enclosureOpsTerminals.ts` | **new** | `moveTerminalStrip`, `resetTerminalOrder`, `relinkRows`, `moveGroupToRails`, `removeTerminalPlaceholders` |
| `src/utils/enclosureOpsModules.ts` | chg | `placeModule({adoptRows})` skips the field's terminal rails |
| `…/enclosure/enclosureDropTargets.ts` | chg | `stripDropAt` |
| `…/enclosure/TerminalCloseupSheet.tsx`, `TerminalCloseupSvg.tsx` | **new** | §7.2 |
| `…/enclosure/useSheetStack.ts`, `EnclosureSheetHost.tsx` | chg | sheet kind `terminals` |
| `…/enclosure/EnclosureFieldBar.tsx` | chg | **Klemmen Feld {n}** (+ ohne Platz) |
| `…/enclosure/EnclosureFindings.tsx` | chg | `actions` prop |
| `…/enclosure/EnclosureFrontSvg.tsx`, `EnclosureFrontBoxes.tsx` | chg | strip boxes and targets, reserved rails, `onOpenTerminals`, `onMoveStrip` |
| `…/enclosure/EnclosureTab.tsx` | chg | close-up push, findings actions via `remember`, reserved set, `boardTerminals` prop (falls back to its own hook until W4b) |
| `…/enclosure/RailSheet.tsx`, `ModuleSheet.tsx` | chg | reserved banner and action; no "+ Gerät"/template on reserved rails; **U84T ab Werk** from the served spec |
| `…/enclosure/dropNoteText.ts` | chg | terminal lines (§6.5 item 3) |
| `…/enclosure/enclosureThreeScene.ts` | chg | colour `terminal_strip` |
| `src/styles/schaltplan-enclosure-terminals.css` | **new** | close-up styles, own scroll container |

### Slice W4a — Aufbau fix (starts now)

| File | New/Chg | Responsibility |
|------|---------|----------------|
| `…/enclosure/enclosureEditorModel.ts` | chg | §9 entries (`reserved` false) |
| `src/components/schaltplan/RailEditor.tsx` | chg | empty entries, notes, `onAddDeviceToRail`; header comment (§1.2) |
| `…/enclosure/useAufbauRailAdd.ts` | **new** | runner + confirm on the Aufbau tab |
| `src/pages/SchaltplanPage.tsx` | chg | `paletteTarget`, `useAufbauRailAdd`, catalogue error retry on Aufbau |
| `src/styles/schaltplan.css` (RailEditor block only) | chg | `.sp-rail--empty` |

### Slice W4b — page wiring (after W1a and W4a)

| File | New/Chg | Responsibility |
|------|---------|----------------|
| `src/pages/SchaltplanPage.tsx` | chg (stays ≤ 800) | one `useBoardTerminals`, passed to legend/findings/Klemmen/EnclosureTab; inspector `terminalBlockedZone` |
| `src/components/schaltplan/DeviceInspector.tsx` | chg | prop `terminalBlockedZone: string \| null` → note instead of checkbox |
| `src/components/schaltplan/TerminalList.tsx`, `LabelPrintDialog.tsx` | chg | `terms`/`ready` props; rail-part rows in the Stückliste |
| `…/enclosure/enclosureEditorModel.ts`, `RailEditor.tsx` | chg | `reserved` from `terminalRailKeys`; reserved row/empty rendering (§9) |

---

## 12. Interfaces

### 12.1 Python

```python
# app/services/panel_enclosure_terminals.py (T1)
WAGO_ZONE_TYPES: frozenset[str]            # {"VT", "VF", "MM", "SAS"}
TERMINAL_RAIL_ZONE_TYPES: frozenset[str]   # {"VT"}
TERMINAL_RAILS_PER_FIELD = 2
TERMINAL_RAIL_USABLE_MM = 210.0; TERMINAL_RAIL_USABLE_VERIFIED = False
INSULATED_RAILS_FITTING = "u84t"           # no END_STOPS_ENABLED (owner answer (a))
@dataclass(frozen=True)
class BoardTerminals: skip: frozenset[str]; groups: tuple[dict, ...]
def parse_terminal_order(value: Any) -> dict[str, dict[str, Any]] | None: ...   # defined in app/schemas/panel_enclosure.py, re-exported
def terminal_skip(document: Any, catalog: EnclosureCatalog) -> frozenset[str]: ...
def board_terminals(document: Any, catalog: EnclosureCatalog) -> BoardTerminals: ...
def terminal_rails(document: Any, catalog: EnclosureCatalog) -> dict[int, tuple[TerminalRail, ...]]: ...
def terminal_rail_keys(document: Any, catalog: EnclosureCatalog) -> frozenset[tuple[str, str]]: ...   # (module id, rail key)
def device_fields(document: Any, catalog: EnclosureCatalog) -> dict[str, int]: ...
def strip_home_field(strip: Mapping[str, Any], fields_of: Mapping[str, int]) -> int | None: ...
def field_order(document: Any, catalog: EnclosureCatalog, field: int, rails=None) -> dict[str, Any] | None: ...
def effective_sequence(default: Sequence[_Strip], stored: Sequence[str]) -> list[_Strip]: ...
def place_terminals(document: Any, catalog: EnclosureCatalog, terms: BoardTerminals | None = None) -> dict[str, Any]: ...
def terminal_rail_parts(placement: Mapping[str, Any]) -> dict[str, int]: ...
def insulation_sets(placement: Mapping[str, Any]) -> int: ...

# T2
def fit_label(text: str, cell_w: float, cell_h: float, size_max: float, size_min: float, scale: float = 1.0) -> LabelFit: ...
def terminal_closeup(document, catalog, terms=None, placement=None) -> list[dict[str, Any]]: ...   # derived when None
def virtual_relink(document, catalog, moves: list[dict[str, Any]]) -> dict: ...                # pins like finish() (§4.2)
def virtual_move(document, catalog, device_ids: list[str], targets: list[dict[str, str]]) -> dict: ...
def terminal_suggestions(document, catalog, terms=None, placement=None) -> list[dict[str, Any]]: ...
def terminal_findings(document, catalog, terms=None, placement=None) -> list[dict[str, str]]: ...   # never raises
def build_enclosure_scene(document, catalog, *, view, placement=None) -> dict: ...
def mm_text(mm: float) -> str: ...                     # moved to panel_enclosure_geometry, re-exported by the rules
def terminal_for_text(...) / rcd_detail(...)           # schaltplan_terminals.py (moved from schaltplan_pdf_terminals)

# schaltplan_terminals.py / schaltplan_layout.py / schaltplan_terminal_checks.py (T1, changed)
def derive_terminals(document: dict, *, skip: frozenset[str] = frozenset()) -> list[dict]: ...
def terminal_bom(groups: Sequence[dict], *, extra: Mapping[str, int] | None = None) -> list[dict]: ...
def build_legend(document: dict, *, terminal_skip: frozenset[str] = frozenset()) -> list[dict[str, str]]: ...
def validate_document(document: dict, *, terminal_skip: frozenset[str] = frozenset()) -> list[dict[str, str]]: ...

# M (+ fix pass)
def readable_blocks(document: Any) -> Any: ...                                              # panel_enclosure_readable; never raises
def readable_document(document: Any) -> tuple[Any, PanelDocument, list[dict[str, str]]]: ... # moved here, re-exported
def terminal_view(db: Session, document: Any) -> TerminalView: ...                          # panel_enclosure_service; cleans first
# TerminalView(skip, groups, rail_parts, catalog, terms, placement); detail_findings(db, document, view=None)
def board_terminal_skip(db: Session, document: Any) -> frozenset[str]: ...                   # panel_enclosure_service; cleans first
def terminal_lines(document, catalog, terms, placement) -> list[PlannedLine]: ...            # panel_enclosure_terminal_material
def u84t_planned(document, catalog, placement) -> int: ...                                   # max(admin accessories, insulation_sets)
def line_eans(document, catalog, placement) -> dict[str, str]: ...                           # {"accessory:U84T": "4010330552465"} when > 0
def match_articles_by_ean(db: Session, eans: list[str]) -> dict[str, WerkstattArticle]: ...  # schaltplan_material_match
def resolve_line_articles(db, lines, numbers=None, eans=None) -> dict[str, tuple[WerkstattArticle, str]]: ...
def draw_terminal_closeup_pages(c, *, plan, closeup: list[dict], company_name=None) -> int: ... # pages drawn (incl. legends)
# Optional keywords, all defaulting to the old behaviour: build_aufbau_pdf(…, terms=None, placement=None);
# planned_lines(document, catalog=None, *, terms=None, placement=None); terminal_lines(…, terms=None, placement=None);
# build_panel_plan_pdf(…, terminal_skip=frozenset(), rail_parts=None); draw_terminal_sheets(…, rail_parts=None)
STALE_TERMINALS_DETAIL: str                                                                  # workflow_schaltplan; label print 409
```

### 12.2 TypeScript

```ts
// utils/enclosureTerminals.ts (W1a)
export const WAGO_ZONE_TYPES: ReadonlySet<ZoneType>;
export const TERMINAL_RAIL_USABLE_MM = 210; export const TERMINAL_RAIL_USABLE_VERIFIED = false;
export type BoardTerminals = { readonly skip: ReadonlySet<string>; readonly groups: readonly TerminalGroup[]; readonly __brand: "BoardTerminals" };
export function parseTerminalOrder(value: unknown): Record<string, { strips: string[]; rail2_from: string | null }> | null;
export function terminalSkip(doc: PanelDocument, index: CatalogIndex): ReadonlySet<string>;
export function boardTerminals(doc: PanelDocument, index: CatalogIndex): BoardTerminals;          // WeakMap-memoised
export function terminalRails(doc: PanelDocument, index: CatalogIndex): Map<number, TerminalRail[]>;
export function terminalRailKeys(doc: PanelDocument, index: CatalogIndex): ReadonlySet<string>;   // "moduleId:railKey"
export function placeTerminals(doc: PanelDocument, index: CatalogIndex, terms?: BoardTerminals): TerminalPlacement;  // memoised
export function terminalRailParts(p: TerminalPlacement): Record<string, number>;
export const NO_SKIP: ReadonlySet<string>;                                                        // schaltplanTerminalRules.ts
// W1b
export function fitLabel(text: string, cell: { w: number; h: number }, size: { max: number; min: number }, scale?: number): LabelFit;
export function terminalCloseup(doc, index, terms?, placement?): TerminalCloseup[];               // derived when omitted
export function virtualRelink(doc, index, moves): PanelDocument; export function virtualMove(doc, index, deviceIds, targets): PanelDocument;
export function terminalSuggestions(doc, index, terms?, placement?): TerminalSuggestion[];        // copy of the memoised pass
export function terminalFindings(doc, index, pre?: { terms: BoardTerminals; placement: TerminalPlacement }): PanelFinding[];
export function buildEnclosureScene(doc, index, view, placement?): EnclosureScene;
// hooks/useBoardTerminals.ts (W1a)
export interface BoardTerminalsState { ready: boolean; terms: BoardTerminals | null; placement: TerminalPlacement | null }
export function useBoardTerminals(doc: PanelDocument | null, index: CatalogIndex | null): BoardTerminalsState;
export function boardTerminalsState(doc: PanelDocument | null, index: CatalogIndex | null): BoardTerminalsState;  // pure
// ops: §6.4
// components/schaltplan/enclosure/dragAutoScroll.ts (fix pass)
export interface ScrollFrame { x: readonly HTMLElement[]; y: readonly HTMLElement[]; clips: readonly HTMLElement[]; page: boolean }
export function scrollFrameOf(element: HTMLElement): ScrollFrame;
export function visibleRect(element: HTMLElement, clips?: readonly HTMLElement[]): Rect | null;
export function autoScroll(element: HTMLElement, point: Point | null, frame: ScrollFrame): boolean;
// useLongPressDrag.ts
LongPressDragHandlers.onTap: (sourceId: string, target: Element | null) => void   // the element the press began on
// components
EnclosureFrontSvg props (+): onMoveDevice?(deviceId: string, drop: DeviceDrop): void; onMoveStrip?(stripId: string, drop: StripDrop): void;
  onOpenTerminals?(field: number, stripId: string | null): void; placement?: TerminalPlacement | null; reservedRails?: ReadonlySet<string>;
  dragSource?(deviceId: string): DeviceDragSource | null; stripSource?(stripId: string): StripDragSource | null
EnclosureDragLayer exports (+): DragOverlay({ label, ghost, client, drop }), DragOverlayProps
TerminalCloseupSheet props: { document; index; terms: BoardTerminals; closeup: TerminalCloseup; placement;
  suggestions: TerminalSuggestion[]; findings: PanelFinding[]; readOnly: boolean; selectedStripId: string | null;
  onSelectStrip(stripId | null): void; onMove(stripId, target): void; onReset(field): void;
  onRunSuggestion(s: TerminalSuggestion): void; onOpenRail(moduleId, railKey, deviceId: string | null): void;
  onBack?(): void; onClose(): void }
EnclosureTab props (+): boardTerminals?: BoardTerminalsState
EnclosureSheetHost props (+): terminals?: TerminalSheetContext
RailSheet props (+): reserved, reservedAction, onOpenTerminals
EnclosureFieldBar props (+): terminals: { field: number; unplaced: number }[], onOpenTerminals
EnclosureFindings props (+): actions?: ReadonlyMap<string, { label: string; run(): void }>
useEnclosureOpRunner args (+): onCommitted?(before: PanelDocument, after: PanelDocument): void
RailEditor props (+): onAddDeviceToRail?(t: { moduleId: string; railKey: string; label: string }): void; findings; findingActions
DeviceInspector props (+): terminalBlockedZone?: string | null   // optional, default null (as built)
TerminalList, LabelPrintDialog props (+): boardTerminals?: BoardTerminalsState   // one prop, not terms + ready;
  // missing: derived against no catalogue, so a cabinet board waits; TerminalList exports CATALOG_LOADING
```

---

## 13. German copy (exact; tests assert the bold ones)

| Where | Text |
|-------|------|
| Drop label | `{bmk} {short} → {title} · am Anfang` / `{bmk} {short} → {title} · nach {bmk}` · group head source `{bmk} {short} {rating} mit {n} Stromkreisen` · ` · zu voll: {mm} mm über` · refusals **Reihenklemmen-Schiene — hier keine Geräte** · `ausgemustert` · **Reihen nicht in Schrankreihenfolge — erst „Reihen ordnen“** · strips `{X} → Hutschiene {r} · Platz {i}` · `Klemmen gehören zu Feld {n}` · `keine Klemmen-Hutschiene` · `passt nicht: {mm} mm zu viel` |
| Drop note | **{bmk} verschoben: {title}, Platz {i}.** · `{bmk} mit {n} Stromkreisen verschoben: {title}, Platz {i}.` · `{bmk} hängt jetzt an {to} (vorher {from}).` · `{n} Stromkreise hängen jetzt an einem anderen Schutzgerät: …` · **Klemmen neu nummeriert: {…} — Beschriftung neu drucken.** · `{X} jetzt in Feld {n}.` · `{X} hat keinen Platz mehr in Feld {n}.` · `{X} hat jetzt Platz in Feld {n}.` · `Im {zone} keine Reihenklemme für {bmk}.` · **Rückgängig** · `Verschieben rückgängig gemacht.` · strip `{X} verschoben: Feld {n} · Hutschiene {r}.` |
| Op refusals | **Diese Hutschiene ist für Reihenklemmen reserviert.** · **Reihen sind nicht in Schrankreihenfolge — erst „Reihen ordnen“.** · `Klemmen gehören zu Feld {n} — die Stromkreise verschieben, nicht die Klemmen.` · `Passt nicht: {mm} mm zu viel auf Hutschiene {r}.` · `Feld {n} hat keine Hutschiene {r} für Reihenklemmen.` · `Klemmleiste nicht gefunden.` · `Hutschiene nicht gefunden.` · `Hutschiene ist nicht leer.` (existing) |
| Drop note, finding actions (**open**: needs an owner decision) | `Vorschlag ausgeführt: Reihe(n) auf {titles} umgehängt.` · `Vorschlag ausgeführt: {head} mit {n} Stromkreis(en) nach {titles} verschoben.` · `Reihenfolge der Klemmleisten in Feld {n} zurückgesetzt.` · `{n} Platzhalter-Reihenklemme(n) entfernt.` |
| Label print, stale strips (409) | `Die Klemmenleisten dieses Plans sind neu nummeriert — nichts gedruckt. Bitte die Seite neu laden (in der iOS-App: App aktualisieren) und erneut drucken.` |
| RailPicker | **Wohin auf {title}?** · **Am Anfang** · **Nach {bmk}** · **Am Ende** · `für Reihenklemmen reserviert` |
| Field bar | **Klemmen Feld {n}** · ` · {k} ohne Platz` (aria-label) · second line `{k} ohne Platz` |
| Close-up | **Reihenklemmen · Feld {n}** · `Hutschiene {r} · {title} · {used} von {cap} mm` · **U84T ab Werk** · `U84T: 1 Satz auf der Materialliste` · **Nach links** · **Nach rechts** · **Auf Hutschiene 1** / **Auf Hutschiene 2** · **Reihenfolge zurücksetzen** · **Ohne Platz** · **Vorschlag ausführen** · **Platzhalter entfernen** · **Geräte bearbeiten** · `Noch keine Reihenklemmen in Feld {n} — Stromkreise mit „Reihenklemme“ erscheinen hier.` · legend `Beschriftung oben gezeichnet (WAGO: Mitte/seitlich) · Abschlussplatte rechts angenommen` |
| Reserved rail | `Diese Hutschiene ist für Reihenklemmen reserviert — Geräte tiefer setzen.` (close-up and RailSheet; the Aufbau banner shows the finding's own sentence) · band aria `Hutschiene {title} · für Reihenklemmen reserviert · {X1, X2 \| noch keine}` + ` · {n} Gerät(e)` |
| Inspector | **Im {zone} keine Reihenklemme — nur in Verteilerfeldern.** |
| Aufbau tab | `{title}` · `leer · {ple} PLE` · **+ Gerät** (aria `Gerät auf {title} hinzufügen`) · `Keine Geräte erfasst.` · `Keine Hutschiene` · `Modulcode unbekannt — Reihen unter „Nicht im Schrank“` · `für Reihenklemmen reserviert · {X7, X8 \| noch keine}` · `Schrankkatalog konnte nicht geladen werden.` · **Erneut laden** |
| Klemmen tab (cabinet) | `Schrankkatalog wird geladen…` · on failure `Schrankkatalog konnte nicht geladen werden.` · **Erneut laden** |
| Findings | §4.1, §4.2 (exact) |
| Materialliste | §5.1 (exact) |
| PDF | `Reihenklemmen · Feld {n} · {VT} {name}` · `Maßstab 1:1 (Breite) — zum Anlegen an die Hutschiene` · **Kontrollmaß 100 mm** · `Reihenklemmen · Feld {n} · Legende` · `Ohne Platz: …` · `Abschlussplatte {part}` · `U84T ab Werk` / `U84T: 1 Satz` · `Verkleinert: die Hutschiene ist länger als das Blatt — nicht zum Anlegen` · `… und {n} weitere` (no `Endklammer 249-116`) |

---

## 14. Tests (write first; RED before GREEN)

### 14.1 Shared fixture (T1/T2 write, W1a/W1b read)

`write_enclosure_fixtures.py` adds keys to **every** board: `terminal_skip`
(sorted list), `terminal_placement`, `terminal_closeup`,
`terminal_suggestions`; top level `constants` echoes
`TERMINAL_RAIL_USABLE_MM` and `TERMINAL_RAIL_USABLE_VERIFIED` (no end-stop
constant), and a top-level `label_fit` table holds the shared fit cases
(§7.1). The catalogue subset adds ZU37RK, ZU59RK, ZU37V5RKAPZ2 and
ZH53XSRK, plus the cabinets ZB32S and ZB53S that the new boards need. The
board builders moved to `scripts/enclosure_fixture_boards.py`. Existing
boards with rows on r1/r2 (`violations_zb34s`,
`tall_zb54s`, `cross_feed_zb33s`, `removed_dangling_zb52s`) gain the
reserved-rail findings; the regenerated file shows it. Board changes:

* `meter_dist_zb33s` (**the compliant reference moves**): its ZU37KS rows go
  from r1/r2 to r3/r4, and its ZU37VT5APZ2 row from r1 to r3. It must stay
  at **zero warns** with its strips placed on r1. The docstring says why it
  moved.
* new `terminals_zb34s`, the owner's back-compat board (§3.6):
  * field 0: ZH3EH16, with an LS B16 `terminal_block` on aar2 (skipped,
    `encl.terminals_zone`);
  * field 1: ZU37KS, r1 = FI F1 + 4 LS, r2 = 3 LS + one `terminal`
    placeholder, r3–r7 = five FI × 8 LS. Expected: X1 on r1, X2–X3 on r2,
    X4–X6 unplaced; one `relink_rows` suggestion (row-old1 → F3 · Verteiler
    3, row-old2 → F3 · Verteiler 4); overflow without `move_group`, with the
    "danach passen alle Klemmleisten" sentence; `encl.terminal_placeholders`;
  * field 2: ZU37RK, empty and insulated (the vacate target; no U84T line);
  * field 3: ZU37KS with 2-TE FIs and FI + 10 LS groups: the first-fit
    case of §3.4 (X10 Block back onto rail 1, 204.0 mm, nothing unplaced).
* new `terminals_rk_zb53s` (ZB53S, three 1350 mm fields):
  * field 0: ZH5EL27 with an FI group on vf1 (no rails → `elsewhere` →
    field 1);
  * field 1: ZU59RK (insulated): a **no_rcd Leiste** (LS directly under an
    HS; plate 2003-7692), and a stored `terminal_order`
    with one stale id and a `rail2_from` that no longer fits because a
    group grew (`order: "ignored"`, `encl.terminal_order_ignored`,
    `reset_order`);
  * field 2: ZH53XSRK: a 3-pole 32 A wallbox on the SAS with
    `terminal_block` (Block placed: the SAS keeps WAGO), a group whose FI
    and 2 LS are here and 1 LS (pinned) in field 1 (`encl.terminals_split`,
    home 2), and a group whose FI is in field 1 with all LS pinned here
    (`encl.terminals_head_field`). The R6 strip X1 also gets `head_field`
    (`X1 (F1): Schutzgerät in Feld 1, Klemmen in Feld 2 — …`, §4.1).
* new `terminals_overflow_zb32s` (ZB32S): field 0 ZU37KS with five 2-TE FI
  + 10 LS groups on r3–r7 (Leisten 71.5 mm: X1–X2 on rail 1, X3–X4 on rail
  2, 143.8 mm each, X5 unplaced); field 1 ZU37KS empty. Expected: one
  `move_group` (F5 and its 10 LS → F2 · Verteiler 3), validated virtually.

Python asserts its output equals the file; TS asserts the same.

Test-only boards outside the fixture, twinned in both languages
(`tests/panel_enclosure_terminal_boards.py` ⇄ `src/test/enclosureTerminalBoards.ts`),
cover the cases the fixture boards do not reach: `lost_place_zb32s` (a move that places more strips but costs a placed
strip its place is refused), `spill_zb53s` and `run_over_r2_zb32s` (runs
that cross a field line or run on from r2; virtual and real ops pin alike,
§4.2), and the vacate variants (`scattered_vacate_zb33s`,
`half_vacate_zb32s`, `two_vacates_zb33s`, …).

### 14.2 API (`apps/api/tests/`, SQLite, one session per worktree DB)

| File | Asserts |
|------|---------|
| `test_panel_enclosure_terminals.py` (new) | fixture parity (skip, placement); skip covers AAR/NAR/RfZ/APZ and keeps VT/VF/MM/SAS; rails per §3.2 (a retired top rail → next, unknown code → none, SAS fields → r1/r2); majority home and tie → first circuit; Block → own field; `headField`; nearest-field fallback left on tie; **next-fit + first-fit** (Block back onto rail 1; a strip unplaced only when it fits neither rail); the end plate in `_fits` and no end stop anywhere; plate inserted before 2009-305 (offsets); placeholders not counted; devices on a reserved rail shrink capacity; effective sequence (stored order kept, stale ids ignored, an unlisted strip merges after its default predecessor); `rail2_from` honoured when both fit, **ignored when a group grew** (`order: "ignored"`, auto layout, no overflow kept); `railParts`/`insulationSets` (RK excluded, an old snapshot without the key still insulated, an **override without `u84t`** still insulated); a split on a strip that is gone packs the stored sequence automatically (`order` stays `"manual"`); **`place_terminals` refuses raw groups** (TypeError); a board without a cabinet → empty placement; garbage never raises; `parse_terminal_order` on garbage |
| `test_panel_enclosure_terminal_rules.py` (new) | every rule fires on a minimal board with the exact German text and is silent on the compliant board; overflow level is info while unverified and warn when the flag is flipped (monkeypatch); suggestion sentences (vacate with/without target, vacate-first with both P' outcomes, move_group accepted / none / supply group); move_group skips R6 strips; a `move_group` target spans two empty rails; vacate targets never repeat a rail; the old `encl.terminals` copy is gone; a run that spills over the field line still moves its group, and the virtual relink pins a run that continued from the moved row (WAGO-1); a move that costs a placed strip its place is refused (`lost_place_zb32s`); rail values that are no text never cost the findings and log no ERROR (sec-2) |
| `test_panel_enclosure_terminal_closeup.py`, `test_label_fit.py` (new) | closeup parity; levels; the fit table (horizontal, shrink, rotate, ellipsis); an ellipsis tie stays horizontal |
| `test_schaltplan_terminals.py` (extend; at 755 lines, so new terminal tests go into new files) | `skip` removes children and renumbers X; `terminal_bom(extra)` ordering; part table has the plates and the `end_plate` mapping, no end stop; legacy fixtures unchanged |
| `test_panel_enclosure_schema.py` (extend) | `terminal_order` round-trips; `null` ≡ absent; garbage (non-dict, bad keys, non-str ids, 1000 ids, `rail2_from` not in strips) is dropped, never 422 and never `encl.invalid_block`; **a v2.15.0-shaped board with rows on r1–r2 and r3–r7 → GET 200, document unchanged, PATCH of another device → 200, stored rows and links byte-identical** |
| `test_panel_enclosure_material.py` (extend) | **legacy golden unchanged**; U84T = rails with strips, RK → 0, no strips → no line, admin accessory U84T → `max`, not sum; end plates per series; no `part:249-116`; AAR circuit with `terminal_block` → its terminals not counted; **EAN match beats name match**; mapping beats EAN; "Hager U84TX" never matches; unplaced strips still count terminals, no rail parts; consumption ticks `part:2003-7692` |
| `test_panel_enclosure_pdf.py` (extend) | page count = 1 + fields with terminals + legend pages + material pages; the close-up page carries `Reihenklemmen · Feld 2`, markers and **Kontrollmaß 100 mm**; **the rail outline is `210 × 72/25.4` pt wide**; a recording canvas asserts **no string's width exceeds its cell**; a board with ≥ 10 strips gets a legend page; a board without terminals has no extra page |
| `test_panel_enclosure_catalog_data.py`, `test_panel_enclosure_catalog.py` (extend) | 4 new codes validate and are recorded as shipped; `u84t` on all six RK codes; ZU37RK/ZU59RK `verified` true; frozen fields of shipped codes unchanged; an override without `u84t` is served with it; a custom row for a new code becomes an override with `u84t` appended |
| `test_panel_enclosure_terminal_routes.py` (new, in place of extending `test_schaltplan.py`) | on a cabinet board `terminal_bom` (with rail parts) equals the Materialliste terminal lines and the print plan uses the same numbering; the legend without an X label for an AAR circuit is asserted on `build_legend` with the skip set the Plan PDF route passes (a spy checks the route passes it), because the detail JSON's legend has no X column; **a refused cabinet block is left out by every route** (detail, label print, Plan PDF, Materialliste agree; the Aufbau PDF answers 409); a Reihenklemmen print naming a strip the board no longer derives → **409** |
| `test_report_terminal_impact.py` (new) | read-only (SELECT/BEGIN/ROLLBACK only, no writes), counts only, no names in the output; counts the hand-added lines for a now-derived part and the renumbered boards with net consumption > 0 |
| route-walk / partner fence, `test_alembic_single_head.py` | unchanged, green (no new routes, no migration) |

### 14.3 Web (vitest)

| File | Asserts |
|------|---------|
| `enclosureTerminals.test.ts` (new) | fixture parity + the direct cases of §14.2 row 1; `placeTerminals` refuses unbranded groups (type test + runtime guard); memoisation by identity |
| `enclosureTerminalRules.test.ts`, `enclosureTerminalSuggest.test.ts`, `enclosureGeometry.test.ts` (extend/new) | parity incl. `terminal_strip` boxes and `terminals` flags; Python's exact answers on broken rows; `suggestionPass` is one pass per board (same inputs → the identical pass, a copied array out). The test **real ops give the same pins and placement as the virtual ones** lives in `enclosureOpsTerminals.test.ts` (fixture suggestions plus the spill and run-over boards) |
| `labelFit.test.ts` (new) | the shared fit table |
| `enclosureOpsDrag.test.ts` (new) | index semantics (same rail left/right, other rail, empty rail creates a row, the emptied generated row is pruned); same place → `unchanged` and **identity**; a dragged LS under F2 follows it; **`followPosition`: a nudge within a run keeps a deliberate cross-feed, crossing into another head's run clears it, a head keeps its link**; the same three cases through the arrows (`moveDeviceIn`); a dragged group head moves with every circuit it feeds in its field (positional and pinned), circuits in other fields stay, and the RailPicker does the same; terminal/retired rail refused; **out-of-order board refused**; 121st row refused; inputs deep-frozen |
| `enclosureOpsTerminals.test.ts` (new) | `moveTerminalStrip` writes sequence + `rail2_from` (only when a split is needed), only current ids, to the first-rail holder, removes other modules' entries, deletes the entry when equal to default, refuses another field, identity on no change; **reorders while strips are without place: no split stored, packed exactly as asked**; refuses a place no packing gives, naming the rail that runs over; reorders the owner's board while it still waits for the vacate; manual order then a group grows → ignored, auto layout; a new strip after a manual order merges at its default neighbour; a strip leaving and returning revives its slot; `resetTerminalOrder`; `relinkRows` (empty targets, relabel, one finish, D4 pins); `moveGroupToRails` over two rails; `removeTerminalPlaceholders`; `removeDevices` prunes strip ids and `rail2_from` |
| `schaltplanTerminals.test.ts`, `schaltplanTerminalOffer.test.ts` (extend) | skip; `terminalOffered(…, skip)`; `setTerminalsEverywhere(…, skip)` |
| `dragMachine.test.ts`, `useLongPressDrag.test.tsx`, `useLongPressDragScroll.test.tsx`, `dragAutoScroll.test.ts` (new) | fake timers: tap < 450 ms → click (RailSheet opens); **hold 700 ms without moving, release → `onOpenRail` once, no drop; the one click that follows is swallowed, a tap elsewhere is not**; `onTap(sourceId, pressedElement)`; inside a fixed sheet the auto-scroll moves the sheet body and never the page, on the page the page still scrolls; **a finger held still near the bottom of a drawing that ends mid-screen (phone) or mid-`main.content` (wide layout) scrolls nothing; an ancestor or the page scrolls only for a finger at its own visible edge while the drawing still runs beyond it, and stops once the drawing's edge shows**; long-press + move → drag; > 8 px before → no drag; mouse 6 px → drag; Escape/pointercancel abort; **Escape or a second finger ending a shown drag swallows the one click at the finger's later release; a pointercancel or an Escape before arming swallows nothing**; **a pointer already down at press start does not abort; a new pointerdown in the scroller does**; click after a drag swallowed; `contextmenu` prevented; **the touchmove listener is registered with `{passive: false}` at mount** and calls `preventDefault` only while armed/dragging; no `setPointerCapture` in jsdom → no throw |
| `enclosureDropTargets.test.ts` (new) | `clientToSceneMm`; snapping at 0.2 px/mm; **field-restricted rectangle distance (a point in the gap between fields never picks the other field)**; insertion index; refusals incl. `row_order`; device `overMm` equals RailPicker's tight test; **strip `overMm` and `too_full`** |
| `enclosureDragLayer.test.tsx` (new) | label text `F1.4 LS B16 → F2 · Verteiler 3 · nach F1.3` shown at arming; ghost ≥ 44 px; aria-live text changes only with (rail, at, refusal) |
| `enclosureFrontSvg.test.tsx` (unchanged) + `enclosureFrontSvgDrag.test.tsx`, `enclosureFrontSvgTerminals.test.tsx` (new) | paint order incl. strips; no drag props on read-only; reserved band → `onOpenTerminals`; a reserved band's accessible name lists its strips; device on a reserved rail → `onOpenRail`; BoxShape does not re-render during a drag (render counter) |
| `enclosureTabDrag.test.tsx` (new) | drop → one `mutate` → note **Rückgängig** → undo restores the exact prior document; **undo still offered after the autosave lands**; undo hidden after another edit; note lines for renumbering, a field change and "keinen Platz mehr"; neutral "Schutzgerät" copy; **after a RailPicker move the sheets are closed and Rückgängig is visible and clickable**; the note bar renders above an open sheet backdrop; `dropNoteSheets.test.tsx`: DropNote sets and clears `data-sp-dropnote` / `--sp-dropnote-h`, and the CSS source lifts and shortens `.sp-sheet` at both breakpoints |
| `enclosureTabTerminals.test.tsx` (new) | strip drop; close-up opens from band, strip and field bar (with "ohne Platz"); **Vorschlag ausführen → confirm → note → undo restores the exact prior document**; vacate action moves both rows in one op; placeholders removed with undo |
| `terminalCloseupSheet.test.tsx` (new) | markers/levels/für text with the fit rule; a tap shows full texts; **a slow tap on a terminal of an editable board selects it too**, one on the strip background selects only the strip; buttons move strips; reset only with a stored order; ignored-order banner; **Ohne Platz** + action; U84T chip; read-only hides buttons; both rails in one scroller; the drag label and ghost are portaled to `body`, the in-sheet echo is visually hidden |
| `enclosureScrollersCss.test.ts` (new; checks the stylesheet source, jsdom computes no layout) | `.sp-encl-fieldbar` and `.sp-encl-scroll` scroll and have `contain: inline-size`; `.sp-term-scroll` has `flex: none` |
| `railPickerSheet.test.tsx` (extend) | position step; reserved rails disabled; same note as the drag |
| `enclosureEditorModel.test.ts` (new) + `railEditorEnclosureGroups.test.tsx`, `schaltplanEnclosurePage.test.tsx` (extend) | the bug-map cases: ZB35S with an empty ZU37VT5APZ2 shows 6 empty entries; mixed entries; cover/unknown notes (exact text); the retired-rail row is listed; "+ Gerät" on an empty rail creates the linked row via `addDeviceToRail` and opens the inspector; pinned toast / regroup confirm on Aufbau; **reserved empty and reserved row entries have no "+ Gerät"**; reserved row shows the banner and action; catalogue error → **Erneut laden**; existing role/textbox counts stay green |
| `deviceInspectorTerminalBlock.test.tsx` (extend) | AAR device → note instead of checkbox; SAS device keeps the checkbox |
| `enclosureThreeScene.test.ts` (extend) | a strip box becomes one mesh |
| `enclosurePerf.test.ts` (new) | ZB55S fixture board: the §6.7 guard (a fresh document per run, so the memo does not hide a regression) |
| `labelPrintDialog.test.tsx` (extend) | the dialog sends only ticked strip ids that the board still derives |

Coverage ≥ 80 % on every new module was the target. It could **not** be
measured: `apps/web` has no `@vitest/coverage-v8`, and adding a dependency
was out of scope. The slices used mutation checks instead (the one
surviving mutant led to a new test that now kills it), plus 2142 random
boards and 4000 random fit cases checked against live Python. Run per `docs/TESTING.md`.

### 14.4 Browser and device proof

Against the worktree dev stack, `access_token` cookie, invented data, on a
ZB34S built like `terminals_zb34s` and a full ZB55S:

* **Desktop** (Playwright MCP, 1024 × 768 and 768 × 1024): mouse-drag an LS
  across fields under another FI, check the note and undo; drag at zoom 0.2
  and 1.3; vacate action + undo; open the close-up, move a strip to rail 2,
  reset; Materialliste shows U84T (not for the RK field) and both end
  plates; "Aufbau als PDF" (page 2 = close-up, Kontrollmaß
  measures 100 mm in the PDF viewer at 100 %); Aufbau "+ Gerät" on the
  empty ZU37VT5APZ2.
* **Touch, WebKit** (iOS Simulator, Mobile Safari, `touch_path` with
  `dt_ms`): short tap → RailSheet; slow tap (700 ms, no move) → RailSheet;
  long-press + drag across fields; the page does not pan during a drag; a
  pinch aborts.
* **Touch, Android Chrome** (CDP `Input.dispatchTouchEvent` via Playwright
  `run_code`): the same five steps.
* **Performance**: Chrome Performance panel with **4× CPU throttling as the
  stated proxy** for an iPad 9th gen: ≤ 4 ms script per drag frame, and
  inspector typing on the ZB55S without dropped frames. Safari Web Inspector
  on a real iPad when the owner has one at hand.
* **Glove check before merge** (owner or Werkstatt, real iPad, work gloves):
  1. tap a breaker → RailSheet; 2. slow tap → RailSheet; 3. drag a breaker
  into another field; 4. Rückgängig; 5. move a strip in the close-up.
  `LONG_PRESS_MS`/`SLOP_PX` are adjusted from this, if needed.

Screenshots go into the PR.

**As run (integration, 2026-10-23)**, against a throwaway PostgreSQL 16
(full Alembic chain), the worktree API and Vite, with two invented boards
(a ZB34S with an AAR circuit flagged "Reihenklemme", an empty ZU37VT5APZ2
and a ZU37KS with five FI groups on r3–r7; a ZB32S with a ZU37RK and a
ZU37KS):

* Done. In Chromium (Playwright) at 1024 × 768 and 820 × 1180: Aufbau
  (reserved rails "noch keine", **+ Gerät** on a rail of the empty
  ZU37VT5APZ2 creates the row and opens the inspector), 2D strips with hatched reserved rails,
  the close-up (strip to rail 2, reset, each with its note), mouse drags
  with notes and Rückgängig, the Materialliste (U84T only on the KS field,
  RK "U84T ab Werk"), the Aufbau PDF (close-up page; Kontrollmaß ≈ 99.8 mm
  in a 100 dpi render), and the AAR note in the Schrank inspector. In
  WebKit (Playwright) at 820 × 1180: the iPad width regression, bisected
  against v2.15.0 and fixed (§6.6). In the iOS Simulator (iPad (A16),
  iPadOS 26.5, Mobile Safari): the board fits, a long-press drag (600 ms
  hold, then move) moves a breaker with its note, Rückgängig restores it,
  and a short tap opens RailSheet with the device highlighted.
* **Still owed (open):** Android Chrome via CDP touch; the **glove check on
  a real iPad**; Chrome Performance with 4× CPU throttling on a full ZB55S;
  a 768 × 1024 desktop pass; the Kontrollmaß measured in a PDF viewer at
  100 %; pinch-abort and "the page does not pan during a drag" re-proven on
  WebKit (the W0 spike covered them); and, after the fix pass, a 390 px
  check with a signed-in session that RegroupConfirm's buttons work while a
  note is up, plus an iPad landscape check that a close-up drag reaches
  rail 2 through the sheet body. The fix pass ran in jsdom only. Its
  browser recheck (§20.1) passed the phone, close-up and window cases and
  found R1. The R1 fix and the click after a cancel (§6.6) were also built
  in jsdom only. Still owed for them: a recheck at 1180 × 820 and
  1366 × 1024 (hold still near the drawing's bottom edge, then the edge
  test), and Escape from an iPad keyboard during a touch drag.

---

## 15. Security

* No new route, permission or dependency. `@dnd-kit` stays as pinned and
  unused here. `pydantic` was already installed through fastapi; it is now
  pinned (`pydantic==2.14.1`, §2.1), not added. At integration `npm audit
  --omit=dev` found 0 vulnerabilities and `pip-audit` found none, the pin
  included; both are run again per `~/.claude/rules/common/security.md`
  before the deploy.
* The label print gains a 409 for a strip selection the board no longer
  derives (§3.1); it prints nothing then.
* New stored input: `terminal_order` only. It goes through one lenient
  parser with caps (§2.1) inside the existing 64 KB block ceiling. Its
  values are used as lookup keys and never rendered.
* EAN lookup: exact equality on an indexed column, bound parameter, no
  LIKE. Archived and merged articles are excluded (as C§3.4).
* All new text is rendered as React text, SVG `<text>` or reportlab
  `drawString`. No HTML anywhere.
* Materialliste mapping keeps C§7 permissions (`accessory:`/`part:` with
  `reports:create`). Salvage is unaffected.
* Long-press handlers attach to the drawing's scroll container only. They
  never call `preventDefault` outside an armed or active drag, so page
  scrolling and zoom stay with the user.
* `report_terminal_impact.py` is read-only (its transaction is `READ ONLY`
  on PostgreSQL and rolled back) and prints counts only, plus the Hager
  codes that have a catalogue row of their own (the repo is public and the
  output lands in deploy notes). To match hand-added lines it reads their
  labels and the articles' name, number and EAN, and it reads consumption
  rows; it compares them with part numbers and never prints them.

## 16. Rollout and back-compat

* **One release, no migration.** Alembic head stays `20261021_0104`. The
  document keeps `version: 1`.
* **Rollback to v2.15.0 is image-only and safe**:
  * `EnclosureModule`/`PanelEnclosure` keep unknown keys (`_KEEP_UNKNOWN`),
    so `terminal_order` survives saves by the old image. Its client spreads
    modules in every op, so the old SPA keeps it too. The new image reads
    it through the lenient parser either way.
  * The four new codes render as placeholders with `encl.unknown_code`
    there. Boards still save (D14: stored codes always save).
  * The `u84t` fitting needs no spec-schema change. Custom DB specs written
    after R2 stay valid on the old image; this is why R8 uses a fitting,
    not a new spec field.
  * While rolled back, the Materialliste loses the U84T/rail-part lines and
    counts AAR terminals again. The ledger is untouched.
* **Pre-deploy checks** (the deploy session, read-only, on prod; builders
  have no prod access):
  1. `report_terminal_impact.py` (`cd apps/api && PYTHONPATH=. python
     scripts/report_terminal_impact.py`, with the new image's code against
     the production database, before the swap): the number of cabinet boards and rows
     with devices on the now-reserved rails, the number of boards whose X
     numbers change (non-empty skip set with `terminal_block`), and the
     number of RK placements. The owner sees the numbers before the deploy
     and confirms that there is **no per-board opt-out** (O2 says every
     Verteilerfeld). The same run counts (review UPG-1, UPG-2):
     * **hand-added lines for a part round 2 now derives** — a
       `panel_material_manual_lines` row whose article is the one the new
       `part:2003-7692` / `part:2016-7691` / `accessory:U84T` line resolves
       to, or whose label or article names `2003-7692`, `2016-7691`, `U84T`
       or the U84T EAN, on a board that plans that line. v2.15.0 listed no
       end plate and no U84T, so the Werkstatt may have added them by hand;
       after the swap the derived line takes that article's booked pieces
       (`allocate_scans` fills derived lines first), the hand line drops back
       to "offen" and the planned total doubles — the Regal would ask for a
       second part. **Deploy step:** the owner looks at each counted board
       and deletes or shortens those hand lines right after the swap,
       before the Werkstatt picks again;
     * **renumbered boards with booked material** (net consumption > 0,
       from `consumed_by_article`; a booking that was fully undone shows no
       "zu viel", so it does not count): they plan fewer WAGO parts now (no
       WAGO on AAR/NAR/RfZ/APZ), so the pieces booked under v2.15.0 show
       "zu viel", or "nicht geplant" where a part line went away. Those
       terminals are physically in the board. Renumbering stands in for
       "plans fewer WAGO parts": a skipped `terminal_block` circuit always
       changes the strip numbering. **The deploy report tells the Werkstatt
       not to undo those bookings** ("Eine Buchung zurücknehmen" in the
       Materialliste, or the Regal undo, would return to stock parts that
       are not on the shelf).
     * unreadable boards (documents the derivations cannot read).
  2. `panel_catalog_entries` rows for ZU37RK, ZU59RK and the four new
     codes: overrides of ZU37RK/ZU59RK are served with `u84t` (tested); a
     custom row for a new code becomes an override (§10) and is named in
     the report for the owner to keep or reset.
* **Existing boards open unchanged.** Nothing is written on load (a test
  asserts no PATCH on open). What changes, in the deploy report:
  * every cabinet board gains WAGO placement, the new findings and new
    derived lines;
  * devices on the top two VT rails produce `encl.terminal_rail_devices`
    warnings with a suggestion, never a move;
  * X numbers on cabinet boards renumber where AAR/NAR/RfZ/APZ circuits had
    `terminal_block`; printed strips of those boards may need a reprint
    (Klemmen tab);
  * **changed shipped behaviour**: "Auf andere Hutschiene…" now follows
    position (with a position step, note and Rückgängig) instead of pinning,
    and on an FI, Hauptschalter or group fuse it moves the head **with** the
    circuits it feeds in its field (R18); the inspector arrows now regroup a
    pinned circuit that crosses into another head's run;
  * a stored cabinet block that the types refuse gets no Aufbau PDF (409)
    and is numbered as a legacy board by every route (§3.1);
  * draft boards with a ZU37RK/ZU59RK placed before R2 show "Katalogstand
    übernehmen" once (the snapshot lacks `u84t`); pressing it changes
    nothing else, and ModuleSheet shows **U84T ab Werk** either way.
* Boards in picking: the new keys (`accessory:U84T`, `part:2003-7692`,
  `part:2016-7691`; no `part:249-116`, the owner dropped the end stops)
  appear as open lines. Existing scans keep their lines — **except** where
  a hand-added line names the same article as a new derived line: booked
  pieces go to the derived line first, so the hand line reopens (counted
  above, review UPG-1).
* **Mixed versions during the swap** (review UPG-5): a tab opened before
  the deploy numbers the Klemmen without the skip set (F1 shows as X2
  where the server now prints X1), and the iOS app bundles its web assets,
  so reloading does not update it — it keeps the old numbering until it is
  rebuilt and installed. The server refuses (409, "neu laden") a
  Reihenklemmen print naming a strip it no longer derives, which catches
  the stale Klemmen tab's default "every strip" selection; a stale
  selection of only surviving strips still prints the new numbers.
  **Deploy announcement:** reload every open Verteiler tab, print no
  Klemmen-Etiketten during the swap window, and none from the iOS app
  until its rebuild with round 2 is installed.
* Pi station: no update (it shows the server's picking view).
* The api image rebuild installs the pinned `pydantic==2.14.1` (§2.1).
  Rolling the image back brings back v2.15.0's own requirements.
* After the Werkstatt check (Q1): set `TERMINAL_RAIL_USABLE_MM` (and
  `_VERIFIED = True`), and if needed a U84T set count on the RK fitting;
  regenerate the fixture. Each is a constant or data change with its test.
* Done means (state on 2026-10-23):
  * tests green: done at the fix pass (API 1217 passed / 6 skipped over
    the schaltplan, panel, werkstatt and alembic tests; the last full API
    suite at integration: 2654 passed / 10 skipped; web 251 files / 3132
    tests, `tsc -b` 0 errors, the check scripts pass). The test runs of the
    later UPG follow-up (report counts, label-print 409,
    LabelPrintDialog) are recorded with its commit;
  * the fixture is regenerated: done, uncommitted;
  * the browser and device proof (§14.4): partly; the glove check is
    **open**;
  * `npm audit` and `pip-audit`: clean at integration; re-run for the
    deploy report;
  * the deploy report states the exposure per the security rules and the
    pre-deploy numbers: at deploy;
  * `docs/STATE.md` is updated: done;
  * the one-line pointer is added to the shipped contract (§1.2): done.

## 17. Open questions for the owner and the Werkstatt

Only questions whose answer changes what is built or ordered. The build
proceeds with the stated default until told otherwise.

**OPEN**

1. **Usable rail length (Q1a, Werkstatt).** How much of a 12-PLE rail may
   WAGO terminals use, with the end plate? The build assumes 210 mm (R16)
   and so shows "passt nicht" as info, not warn. At the physical ≈ 248 mm
   a full ZU59 field would fit (§3.4), so this number decides real
   overflows. Answer → `TERMINAL_RAIL_USABLE_MM` and `_VERIFIED = True`.
2. **U84T sets per RK box (Q1b, Werkstatt).** How many U84T sets come in a
   ZU37RK / ZU59RK box? Hager's photo shows one for the ZU37RK (two for the
   ZU59RK); one set insulates one rail, which would leave the second WAGO
   rail uninsulated. The build follows the owner's rule (f): no U84T for RK
   fields. If a box holds fewer sets than WAGO rails, the line becomes
   `rails − sets` (a data change on the fitting).
3. **Cover clearance (Q1e, Werkstatt).** Do 2003-7641 terminals (42.3 mm
   deep) clear the cover on a U84T-mounted rail?
4. **Glove check on a real iPad** (owner or Werkstatt, before merge, §14.4):
   tap, slow tap, drag a breaker into another field, Rückgängig, move a
   strip in the close-up. `LONG_PRESS_MS` / `SLOP_PX` are adjusted from it
   if needed.
5. **Drop-note copy for finding actions.** Line 1 of the note after
   "Vorschlag ausführen", "Reihenfolge zurücksetzen" or "Platzhalter
   entfernen" is not in §13. The build uses the four sentences in §6.5 /
   §13 until the owner decides.

Also unverified and shown as such: the end plate drawn on the right (open
side) and the 2003-7642 level order (code comments, close-up legend, PDF
note).

**Answered 2026-10-22** (§1.3)

* Q1c, end stops: **none** (a). Q1d, an end plate per Leiste in mid-rail:
  **no**, one end plate per rail after its last terminal (a).
* Q2, manual order: **whole Klemmleisten** (c).
* Q3, dragging an FI: **with its circuits** (b). Worth a look: a circuit
  in the same field that is pinned to the FI from another run now lands
  next to the FI and loses its pin, because position gives the same feed
  (§6.4).
* Q4: **no** WAGO in NAR, RfZ, APZ or AAR; **yes** on a Verteilerfeld's
  SAS (d).

## 18. Sources

* WAGO 2003-7641 datasheet (Stand 28.05.2026; "Notwendiges Zubehör
  2003-7692"; "Potentialkennzeichnung NT/L/PE"; "Beschriftungsebene
  Mitten-/Seitliche Beschriftung"):
  https://www.ottofischer.ch/pim/606cdaba-26c8-4370-8d87-2d49619b437f/WAGO_2003-7641de.pdf
* WAGO 2016-7601 datasheet (Stand 03.06.2026, "Notwendiges Zubehör
  2016-7691 / 2016-7692"):
  https://ariba.ottofischer.ch/pim/8abfa8a1-008b-442b-a07f-081fec7025bc/WAGO_2016-7601de.pdf
* WAGO 2009-305 datasheet (Stand 31.05.2026; "mit Endklammerfunktion und
  ausbrechbarer Trennplatte"; the plate closes an N busbar end):
  https://www.ottofischer.ch/pim/5d1232cd-9dd4-4afc-b299-bf4c5878c584/WAGO_2009-305de.pdf
* WAGO 249-116 (6 mm, TS 35; **not used**, owner answer (a)): https://www.wago.com/de/montagezubehoer/endklemme/p/249-116
* WAGO 2003-7692: https://www.wago.com/gb/10001/p/2003-7692 ·
  https://www.buerklin.com/en/abschluss-und-zwischenplatte/p/09h4611
* WAGO 2016-7691: https://www.wago.com/nl/rijgklemmen/afsluitplaat/p/2016-7691 ·
  https://asset.conrad.com/media10/add/160267/c1/-/de/001931747DS00/karta-katalogowa-1931747-wago-2016-7691-100-szt.pdf
* WAGO 2016-7792 (77xx series plate, **unverified**, not modelled):
  https://www.wago.com/2016-7792
* Hager U84T (Isolierstück univ. Z, Satz = 2 St., EAN 4010330552465):
  https://hager.com/de/katalog/produkt/u84t-isolierstueckuniverszm-schrauben2-st ·
  https://assets.hager.com/step-content/P/PDS_163537320101DE/Document/std.lang.all/U84T_0101_de-DE.pdf
* Hager RK fields (U84T ab Werk):
  https://assets.hager.com/step-content/P/HA_22838788/Document/std.lang.all/21DE0246-FLY-H-UNIVERS-Z-VERTEILERFELDER-WEB.pdf ·
  https://assets.hager.com/step-content/P/PDS_263002620101DE/Document/std.lang.all/ZU37RK_0101_de-DE.pdf ·
  https://assets.hager.com/step-content/P/PDS_263012150101DE/Document/std.lang.all/ZU59RK_0101_de-DE.pdf
* hager.com catalogue pages of the four new codes (rows, height, "APZ
  unten" / "mit SaS 12x5mm", "ohne QC-Klemmen", Auslaufprodukt; read
  2026-10-22): https://hager.com/de/katalog/?artnr=ZU37V5RKAPZ2 ·
  https://hager.com/de/katalog/?artnr=ZU59V7RKAPZ2 ·
  https://hager.com/de/katalog/?artnr=ZH3ES5RK ·
  https://hager.com/de/katalog/?artnr=ZH53XSRK
* ZU37V5RKAPZ2 (retailer, "ohne QC-Klemmen", 5 Reihen, APZ unten):
  https://www.zaehlerschrank24.de/hager-verteilerfeld-zu37v5rkapz2-1-feldrig-1050mm-5-reihig-1.html
* Hager Tipp 44 (VDE-AR-N 4100:2026-04; AAR is no Stromkreisverteiler):
  https://assets.hager.com/step-content/P/HA_90428939/Document/std.lang.all/26DE0009-tip-hager-tipp-44-vde-ar-n-web.pdf

## 19. Review resolutions (rev 1 → rev 2)

Every major finding is fixed; minors were folded in unless noted. This is
the design-review history. Where an owner answer (§1.3) or the build (§20)
changed a resolution, the row says "superseded" and the sections above
describe what was built.

| Finding (section) | Resolution |
|-------------------|------------|
| Next-fit never returns to rail 1 (§3.4) | R5: next-fit, then first-fit for what it skipped; pinned in `terminals_zb34s` field 3 (§3.4) |
| 210 mm capacity is the cover cutout (§3.5) | R16: one constant, echoed in the fixture, overflow at info until Q1a; ZU59 example shows it overflows even at 248 mm (superseded: without end stops it fits at 248 mm, §3.4) |
| Suggestions ignore vacating (§4.2) | R17: sequential pass, vacate first, hypothetical re-place, no `move_group` while a vacate is pending; owner's board pinned (§3.6) |
| `terminal_order` stores a full layout that goes stale (§2.1) | Now one sequence per field + optional rail-2 marker; rails always derived; a split that no longer fits is ignored with an info finding and reset action; unlisted strips merge at their default neighbour; revival documented |
| Hand-placed `terminal` devices (§3.6) | Placeholders: not counted, no warn, info + **Platzhalter entfernen** with undo; Materialliste line follows the device |
| Overrides and promoted custom rows lack `u84t` (§10) | `_merge_override` appends missing built-in fittings; deploy pre-check names custom rows; tests |
| `move_group` details (§4.2) | Skips R6 strips; targets may span several empty rails; each candidate validated by a virtual move + re-place |
| Wrong worked examples (§2.3/§3.4/§14.1) | Recomputed from the reference algorithm; supply-group case replaced by a no_rcd Leiste |
| RK fields flip to unverified; snapshot differs (§10) | Caveat moved onto the fitting; modules stay verified; ModuleSheet reads the served spec; snapshot note in §16 |
| New built-ins with assumed stacks (§10) | hager.com pages read: rows/height/APZ/SaS/QC confirmed, all Auslaufprodukt; RJ45 left out; correction path stated (sizes and positions are not frozen) |
| End plate vs 2009-305, end stops, plate side, level order (§5.3/§7.1) | 2009-305 datasheet read (its plate closes the N busbar); end stops modelled (R7, Q1c); mid-rail plates in Q1d; plate side and 2003-7642 levels marked unverified; NT/L/PE cited (superseded: no end stops, one plate per rail, owner answer (a)) |
| SAS in the skip set (§3.1) | SAS keeps WAGO; Q4 split accordingly |
| Reserved-rail enforcement paths (§3.6) | Path table with a decision and a test each |
| Stückliste vs Materialliste; U84T double count (§5.1) | Rail parts in every Stückliste (must); U84T = `max(admin, derived)` |
| R4 justification; strip field changes not reported (§1.1/§6.5) | Justification corrected; `encl.terminals_head_field`; note lines for field changes and lost/gained room |
| `null` vs absent; raw reads; groups mis-call (§2.1) | One lenient parser for schema and derivations; `null` ≡ absent; `BoardTerminals` branded, raw groups refused |
| Slow gloved tap arms and swallows (§6.2) | `armed` state: a release without movement is a tap |
| Picked device not visible (§6.6) | Label names source and target from arming; ghost ≥ 44 px above the finger |
| Note placement (§6.5) | Fixed bottom bar above the sheet backdrop; RailPicker closes the stack first (built: the note lifts open sheets, review ui-1) |
| Note misses WAGO changes; "FI" copy (§6.5) | Terminal diff lines; neutral "Schutzgerät" with `group_head_label` |
| `parent_id` clearing vs arrows (§6.4) | `followPosition`, shared by drag, picker and arrows |
| FI drag strands its LS (§17) | R18 + Q3 (superseded: the group travels, owner answer (b)) |
| Manual order + growth, no action for overflow (§3.4/§4.1) | Manual overflow can no longer persist; `encl.terminal_order_ignored` with reset action; tests |
| "Vorschlag ausführen" without undo (§4.2/§7.4) | `onCommitted` → `useDropUndo.remember`; test |
| PDF text cannot fit (§7.3) | Shared `fitLabel`; levels inside the band; two-line rotated column; legend page; Kontrollmaß; width and scale tests |
| App close-up readability (§7.2) | Fixed vertical sizes, `fitLabel` ≥ 11 px, tap shows full text |
| Browser proof cannot test touch/perf (§14) | iOS Simulator `touch_path`, Android via CDP, throttled Chrome as the stated proxy, glove check before merge |
| Slice graph circular (§11) | Re-cut: W0 spike; T1/T2; W1a/W1b; W2a (device drag) before W3 (all terminal UI); W4a/W4b sequential; shared files edited in sequence |
| Performance scope beyond the drag (§6.7) | Computed once in SchaltplanPage and passed down; identity memo; ZB55S timing guard; typing in the device proof |
| Gesture details (§6.2/§6.6) | Resting pointers ignored; edge zones clamped to the visual viewport; label portal; throttled aria-live (built: zones also clipped to scrolling ancestors, review ui-2) |
| Drop target ambiguity; strips onto full rails (§6.3) | Field-restricted rectangle distance; strip `overMm` and `too_full` |
| ShapeState memo (§6.7) | Overlay dimming + `React.memo` BoxShape (W2a) |
| `dropDevice` vs out-of-order rows (§6.4) | R19: refused with a hint |
| Aufbau reserved rows, catalogue error, unknown note (§9) | Specified and tested |
| Level order source (§7.1) | Cited; 2003-7642 unverified |
| File sizes over the cap (§11) | Listed; pass-through only, `_strip_name_clashes` extracted; new tab tests in new files |
| Reserved-rail warning volume, per-board opt-out (§16) | Read-only impact report before the deploy; owner confirms no opt-out; constants settled in the glove check |
| Missing tests (§14) | Added to §14.2/§14.3 |
| Close-up drag across rails (§7.2) | Both rails in one SVG and one scroller; real minimum target 26 px, buttons as fallback |

## 20. Build record (2026-10-23)

The build ran as the slices of §11, then one integration pass (with the
browser proof of §14.4), a review with four lenses, one fix pass, and a
follow-up on the main session's upgrade review (UPG). That follow-up also
fixed the phone finding F1. A browser recheck of the follow-up found R1,
which a last pass fixed together with the click after a cancel. Every
deviation is folded into the sections above; this section is the index.

### 20.1 Review findings and their resolution

| Finding | Severity | Defect | Resolution | § |
|---------|----------|--------|------------|---|
| WAGO-1 | medium | The suggestion pass checked moves on virtual boards that pinned nothing, while the real ops pin (`preserveFeeds`). A run that spilled over a field line made it say "Verteilerfeld ergänzen" where the move would have worked. | `virtual_relink` / `virtual_move` pin like `finish()`, in both twins; new boards `spill_zb53s`, `run_over_r2_zb32s`. | 4.2 |
| WAGO-2 | medium | `moveTerminalStrip` always stored a split, which cannot fit while strips are unplaced, so every manual move on such a field was refused, naming rail 2. | `rail2_from` only when a split is needed and fits; otherwise `null` when that packs exactly as asked (`StripPlan.split`). | 6.4 |
| WAGO-3 / sec-1 | low | On a stored cabinet block the types refuse, the detail route numbered like a legacy board while the label print, the Plan PDF and the Materialliste numbered with the block's skip set. | Every route reads the board through `readable_blocks`; the Aufbau PDF answers 409 for such a block. | 3.1, 7.3 |
| ui-1 | medium | The drop note covered sheet footers at phone width (RegroupConfirm's buttons, the palette's last tiles). | The note lifts and shortens every open sheet (`data-sp-dropnote`, `--sp-dropnote-h`). | 6.5 |
| ui-2 | low | A strip drag in the close-up never scrolled the sheet body, scrolled the page behind the modal, and its label scrolled away. | `dragAutoScroll.ts`: zones clipped to scrolling ancestors, ancestors scroll, never the page behind a fixed layer; label and ghost in the shared `DragOverlay` portal. | 6.6, 7.2 |
| ui-3 | low | A slow tap on a terminal of an editable board selected only the strip, so its details never opened. | `onTap(sourceId, pressedElement)`; the close-up selects the terminal under the press. | 6.2, 7.2 |
| sec-2 | low | A rail value that is not text made `_with_rails` raise, and `terminal_findings` then dropped all terminal findings with a logged traceback. | Non-text rail entries are left untouched, as in the TS twin; tests assert no ERROR log. | 4.1, 4.2 |
| ui-4 | — | Refuted as a code defect: the contract required the refusal. The behaviour was changed anyway with WAGO-2. | — | 6.4 |
| UPG-1 | — | Hand-added end plates or U84T on a board double the article once the derived line exists. | The impact report counts them; deploy step: the owner deletes or shortens them. The Materialliste still does not de-duplicate. | 5.1, 16 |
| UPG-2 | — | Renumbered boards with booked material show "zu viel" / "nicht geplant". | Counted (net consumption > 0); the Werkstatt is told not to undo those bookings. | 16 |
| UPG-5 | — | A stale tab or iOS app prints labels under the old numbering. | Label print 409 on a strip the board no longer derives; LabelPrintDialog sends only current ids; deploy announcement. | 3.1, 16 |
| F1 | medium | On a phone (390 × 844), a finger held still on the bottom rail of a drawing that ends mid-screen ran the window to the page's end, because the drawing's zones drove `window.scrollBy`. | The page has zones at the visual viewport's edges and scrolls only towards a side where the drawing is still hidden (`pageStep`). | 6.6 |
| R1 (recheck) | medium | The same failure in the wide layout (1180 × 820 iPad landscape, 1366 × 1024), where `main.content` scrolls instead of the window. It sat in the drawing's chain, was driven by the drawing's zones, ran to its end under a still finger, and lost the drop target. The F1 fix did not cause it: the round-2 build before that fix chained `main.content` the same way. | The page rule applies to every scrolling ancestor (`ancestorStep`): zones at the ancestor's own visible edges, and only towards a side where the drawing still runs beyond them. RED first: 4 cases in `dragAutoScroll.test.ts` and 1 through the hook in `useLongPressDragScroll.test.tsx`. | 6.6 |
| Recheck note | low | Escape ending a touch drag (an iPad keyboard) let the browser's click at finger-up through, and it opened the rail sheet. Only a drop or a tap armed the click suppression. | A shown drag that Escape or a second finger cancels swallows the one click at its pointer's later release. RED first: 3 cases in `useLongPressDrag.test.tsx`, plus one that pins that a pointercancel or a pre-arm Escape swallows nothing. | 6.2, 6.6 |

### 20.2 Files beyond the slice tables of §11

* API: `services/panel_enclosure_readable.py` (fix pass);
  `services/panel_enclosure_pdf_terminal_sheet.py` and
  `services/panel_enclosure_pdf_terminal_legend.py` (the PDF split, §7.3);
  `requirements.txt` (`pydantic==2.14.1`); tests
  `test_panel_enclosure_terminal_routes.py` (instead of extending
  `test_schaltplan.py`) and `tests/panel_enclosure_terminal_boards.py`.
* Web: `components/schaltplan/useSchaltplanPalette.ts` (W4a, §9);
  `enclosure/useAufbauTerminalActions.tsx` (W4b, §9);
  `enclosure/useTerminalActions.ts`, `enclosure/useDrawingDrag.ts` and
  `enclosure/terminalCloseupLayout.ts` (W3); `enclosure/dragAutoScroll.ts`
  (fix pass); `EnclosureSheetHost.tsx` (W2a: the picker hands its target
  to the tab's `onDropDevice`; integration: the embedded inspector gets
  `terminalBlockedZone`); the shipped `styles/schaltplan-enclosure.css`
  (`contain: inline-size`, §6.6).
* Existing tests whose boards put devices on r1/r2 of a Verteilerfeld were
  moved to lower rails once the real reserved set was wired
  (`enclosureTab.test.tsx`, `enclosureTabDrag.test.tsx`, three lines of
  `schaltplanEnclosurePage.test.tsx`); no assertion was weakened. The
  close-up's broken-rows test now expects Python's exact answer instead of
  `[]`.

### 20.3 Engineering items still open

* The device and browser proof still owed (§14.4), the glove check first.
* `TerminalGroupCard.tsx` keeps private copies of `forText` / `rcdDetail`;
  it could import the shared twins from `enclosureTerminalCloseup.ts`.
* `enclosureFindings`' `readBoard` (v1) is not tolerant of rows that are
  `null` or not objects: TS returns `[]` with a warning where Python still
  answers. The server never stores such rows.
* The 3D strip colour (0xb9c0c8) differs slightly from the 2D and PDF grey.
* No randomized Python ⇄ TS check of pinned virtual boards (§4.2).
* Coverage is not measured (§14.3).
* The Materialliste does not de-duplicate hand-added lines (§5.1).
* `src/test/enclosureTestCatalog.ts` (a hand-made TS test catalogue) still
  models ZU37RK without `u84t`; tests that need an insulated RK field use
  the fixture catalogue.
* Pre-existing on v2.15.0: in WebKit at 820 px the Plan and Aufbau tabs
  widen the page (§6.6); tracked as its own task.
