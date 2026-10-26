# Schaltplan-Export — Stromlaufplan (allpolig) und überarbeiteter Übersichtsschaltplan

Contract for the drawing sheets of the Verteilerplan PDF (`GET …/panels/{id}/pdf`).
Owner, 2026-10-26: "in the html file … you drew a better ac schematic than the
export of our panel planning tool; especially now that we have a more complex
build our drawings need to be better as well." Follow-up answer: **add the
allpolig sheets and fix the Übersicht** (keep both).
Reference: sheet S3 "AC wiring, all conductors" of an earlier drawing set
(session scratchpad `r4/ref/S3.svg`, CSS inlined; conductor colours, horizontal
buses with tags, vertical drops with junction dots, hop arcs, device boxes with
designation + rating, cross-sections written on the wires, a colour key).
The repo is public: invented data only.

Status: **rev 2**, 2026-10-26, branch `claude/verteiler-r4` (review fixes in §8).

## 1. What is wrong today (measured)

* `_paginate_groups` puts at most one wide group per band and never splits:
  a group of ≥ 6 circuits gets its own sheet (11 FIs → 12 sheets), and from
  the 8th circuit columns are drawn past the page edge. The docstring's
  "scales" claim is false.
* All heads hang in parallel off one busbar line (SLS, HS, FIs look like
  siblings); the chain is only told by "über Q0 SLS" plates.
* No conductors, no meters, no busbar joints, no RfZ/APZ supply, no §14a
  block, no network cable; HLAK, SPD and meters are invisible.

## 2. Sheet order (full PDF)

1. **Übersichtsschaltplan** (fixed, §4) — sheets 1..a
2. **Stromlaufplan allpolig** (new, §5) — sheets a+1..n
3. Legende (unchanged), 4. Reihenklemmen (unchanged; only with terminals).

`legend_only` / `terminals_only` print exactly what they print today;
`build_legend` is called exactly once per PDF and through the name
`schaltplan_pdf.build_legend` (spy tests). "Blatt i/n" counts all drawing
sheets; the whole layout is computed before anything is drawn.

**File caps.** `schaltplan_pdf.py`, `schaltplan_layout.py` must not grow. The
overview code (pagination, `_draw_diagram_sheet`, `_draw_group`, `_draw_circuit`,
`_supply_block`, the title strip) moves to new `schaltplan_pdf_overview.py`;
`build_panel_plan_pdf` stays in `schaltplan_pdf.py`. New modules aim for
200–400 lines, hard cap 800.

## 3. Shared furniture (`schaltplan_pdf_style.py`)

* A4 landscape; header bar unchanged (title "Übersichtsschaltplan" /
  "Stromlaufplan allpolig").
* **Title strip** replaces the corner Schriftfeld on drawing sheets: full width
  at the bottom, y 24..70 pt (y up), fixed cell widths summing to 762 pt (x
  40..802): company + sheet title 150 · Kunde 110 · Projekt 110 · Verteiler 132
  ("{designation} · {name}") · Art / Ort 90 · Einspeisung von 60 · Datum 40 ·
  Stand 40 ("Entwurf|Bestand · Rev. {plan.revision}") · Blatt 30 ("{i}/{n}");
  each text fitted 7.5 → 6.5 pt, then "…". Stromlauf sheets show above the strip
  (y 72..80) the key **L1 braun · L2 schwarz · L3 grau · N blau · PE grün-gelb ·
  PEN grün-gelb/blau** and **Punkt = Verbindung · Bogen = Kreuzung ohne Verbindung**.
* Drawing area: x 40..802, y 82..520.
* `CONDUCTOR_COLOURS`: L1 `#8a5527`, L2 `#1c2024`, L3 `#8b929b`, N `#2867d1`,
  PE `#2f8f3a` + `#e2bf12` 3/3 dash overlay, PEN `#2f8f3a` + `#2867d1` 3/3 overlay;
  §14a control `#7547c9` dashed 4/3; data `#0f8b8d` dashed 2/2; "L?" in WARN.
* Fonts ≥ 6.5 pt; BMK 7.5 pt bold; text only via `drawString`/`drawCentredString`.

## 4. Übersichtsschaltplan — the fix (`schaltplan_pdf_overview.py`)

Keep today's look; make it fit:
* Vertical metrics (pt, y up): band-0 constants move up 54: `_Y_BUS 488,
  _Y_GROUP_TOP 470, _Y_GROUP_BOT 432, _Y_SUBBUS 416, _Y_DEV_TOP 396,
  _Y_DEV_BOT 356, _Y_CHIP 342, _Y_TEXT 328`; `_BAND_DY` stays 212 (band 1's bus
  at 276, its deepest text ≥ 83.5). The supply block sits beside the groups at
  x 40..190, y 432..488; band 0's groups start at x 200 (7 columns of 78 pt),
  band 1 at x 40 (9 columns).
* `paginate_overview(groups)` packs groups greedily, several per band; a group
  wider than the remaining band is split into column chunks; the continuation
  repeats the head as "F1 (Forts.)" with paired markers **→ Forts. Blatt {k}** /
  **Forts. von Blatt {i}**. Nothing past x 802; nothing scaled.
* Groups in one band share a busbar line only when they share their source
  (`fed_by` root); otherwise the line is broken (≥ 16 pt gap) and each segment
  is captioned "hinter {bmk}".
* Feeder heads without circuits (SLS/HS/VB) draw as a compact chain at the
  start of band 0 ("Q0 SLS → Q1 HS → Sammelschiene"); the texts "über Q1 HS" and
  "speist F1, F2" stay (tests pin them).
* On a readable cabinet board, supply-group members on RFZ/APZ rails (or the NAR
  tap) are drawn in a neutral box **Messsystem (ungezählt, vor SLS)** instead of
  "OHNE FI-SCHUTZ"; any other member keeps the WARN box.
* Tests: `test_schaltplan_pdf_layout.py` page-count/band expectations updated
  deliberately; new invariant: every primitive of every overview sheet inside
  x 40..802 / y 82..520 for 0–40 circuits per FI and 1–12 FIs.

## 5. Stromlaufplan allpolig

### 5.1 Conductors (`schaltplan_conductors.py`, pure)

* `device_conductors(device)`: 1 pole → `L1`/`L2`/`L3` from `phase` "L1"/"L2"/"L3";
  "L1/N" → L1; "L1-L3", "N", "-" → `L?`. 2 poles → (Lx, N) by the same rule.
  3 → (L1, L2, L3). 4 → (L1, L2, L3, N). Poles via the existing `_poles`
  fallback.
* `parse_cable_section(text)` shared with R4's `parse_infeed` (same
  normalisation and regexes, `PANEL_ENCLOSURE_R4.md` §3.5) → `(cores, mm2)`.
* `outgoing_conductors(device, cable)`: cores 2 → (Lx, N); 3 → (Lx, N, PE);
  4 → (L1, L2, L3, PE); 5 → (L1, L2, L3, N, PE); 7+ → device conductors + N + PE
  with the note "{n}-adrig"; unknown → device conductors + N + PE and the text
  "Leitung —".
* `supply_conductors(system, cores)`: TN-S, or TN-C-S with 5 cores → L1 L2 L3
  N PE in (TN-C-S labelled "PEN-Aufteilung im HAK" left of the tags); TN-C-S with
  4 cores → L1 L2 L3 PEN in, the split drawn at the infeed of the carrier lane
  (PEN → PE bar, junction dot, PE–N bridge) labelled "PEN-Aufteilung im NAR";
  TN-C-S cores unknown → as with 5 plus a WARN note "Aufteilungspunkt
  unbekannt"; TT → L1 L2 L3 N in, PE enters separately as "PE (Anlagenerder)";
  IT → L1 L2 L3 in, PE from "Anlagenerder", N only with 5 cores.
* One sheet note instead of per-circuit notes: **L? = Phase nicht angegeben ({n} Stromkreise)**.

### 5.2 Model (`schaltplan_stromlauf_model.py`, pure)

`build_stromlauf_model(document, catalog=None, *, terminal_labels=None)`:
* reads `build_topology(document)` only (never mutates its dicts);
* **sources**: each head chain (`fed_by` root plus its feeder path) is one
  source; load groups (RCD, fuse groups, the implicit supply group) are ordered
  by (source in lane order, then topology order);
* on a readable cabinet board adds the **cabinet section** from
  `panel_enclosure_layout` readers and `cabinet_prep` / `place_control_block`
  (R4 §3): **one lane per meter place** (module field order, then place index).
  Place k takes: SLS = the k-th `sls` on the module's NAR rails left → right
  (missing ones from a SAS SLS in the same or an adjacent field, in
  `vde.nar_sls` credit order, noted "auf SAS Feld {m}"); Trennvorrichtung = the
  `hauptschalter` whose `supplied_by.part` is `hs`/`trenn` (place 0) or
  `hs2`/`trenn2` (place 1), else the k-th `hauptschalter` on the AAR left →
  right; HLAK = AAR `hlak`; the meter (number/label, "frei"). If the topology's
  `fed_by` for that HS names a different SLS, the lane keeps the physical
  pairing and adds the WARN note "Einspeisung laut Plan: {bmk}". Other AAR
  circuits stay in the distribution sheets under their topology head with the
  location tag "AAR Feld {n}".
* from `cabinet_prep`: infeed (K96ESA5 / clamps), `main` busbar runs and their
  ZZ55SAVE joints, the supply kit (SABO/LS/SI) with leads to RfZ/APZ, the
  network lead, the PEN split; RfZ/APZ rail devices hang off the supply lead
  ("ZY… → 3-pol. Buchse RfZ/APZ") when the kit exists, else off the existing tap
  device — never under a customer RCD;
* the §14a block (from the placement): terminal names, control wires,
  Lüsterklemme, target;
* nothing guessed silently: unlinked SLS/HS are not drawn upstream of a bus.

### 5.3 Layout (`schaltplan_stromlauf_layout.py`, pure; split into `_cabinet`/`_bands`/`_routes` as needed)

`layout_stromlauf(model, frame) -> list[Sheet]`; Sheet = `{kind, title, wires:
[{conductor, points}], dots: [[x,y]], hops: [{x, y}], boxes: [{kind, x, y, w, h,
poles, texts}], texts: [{x, y, size, text, anchor, bold, colour, angle}],
xrefs}`; points in pt, y up, `round1`, deterministic order.

**Sheet "Einspeisung & Zählerplatz"** (cabinet boards; otherwise the supply
and the feeder chain open the first distribution band):
* The NAR bus is a **vertical** 5-line bus at the left (x 60..88, L1…PE at
  7 pt pitch, or L1 L2 L3 PEN for a 4-core TN-C-S), with the supply tags and
  "Zuleitung {incoming} · Vorsicherung {fuse} · {system}" above it and the
  infeed part ("K96ESA5" / "5 × K96F") at its top. It is split into one
  segment per `main` busbar field; joints carry a ZZ55SAVE tag between segments,
  unjoined runs are drawn as a break with their own infeed tag.
* Each meter place is one **horizontal lane** (96 pt high; ≤ 4 lanes per
  sheet; more continue on the next "Einspeisung & Zählerplatz" sheet with paired
  markers): tap dots on the NAR segment of its field → (carrier lane only) the
  supply-kit tap with thin L1+N leads "→ RfZ Feld n" / "→ APZ Feld m" labelled
  "{ZY…} · SABO 1,6 A" → SLS box over L1–L3 → meter box (eHZ / 3-Punkt, number,
  label, "frei") → Trennvorrichtung/HS → HLAK (junction dots, "→ Feld n") → xref
  "→ Sammelschiene Blatt {k}".
* A **"Steuerung & Kommunikation" band** (120 pt) under the last lane of the
  carrier's sheet: the §14a block as a terminal row (names vertical, bottom → top)
  drawn **on the metered side** (to the right of the carrier's Trennvorrichtung);
  upper side open customer stubs labelled by position ("UNSM ← gemessener Bereich
  (Erzeugungsanlage/Kundenanlage)", "60 % / 30 % / 0 % → Erzeugungsanlage",
  "UStve ← gemessener Bereich", "Stve → steuVE"; names from the stored labels,
  not drawn when blank); lower side the n purple control wires
  "{n} × H07V-K {mm2} mm²" to a Lüsterklemme symbol at "{RfZ|APZ} Feld {n}";
  the network lead dashed teal "{ZZ45WAN…} · RJ45" from "APZ Feld {a}" to
  "{RfZ|Zählerplatz} Feld {b}". No conductor joins the block to the supply-kit
  leads or the NAR (layout test).

**Distribution sheets:**
* A **bus segment carries exactly one source**. Each band starts a 5-line bus
  (L1 L2 L3 N PE, 7 pt pitch, tags, "von Blatt {i}") with its caption
  "hinter {bmk} {kind} (Zähler {place}, Feld {n})" (or "hinter {bmk}" on boards
  without a cabinet); a new source starts a new segment after ≥ 16 pt of empty
  bus with its own tags and caption. No conductor joins two segments (layout test).
* Per group head a box with one stub per pole (RCD: a ring around the stubs and
  "IΔn {residual_current} · Typ {rcd_type}", "—" when empty; a pre-fuse as a
  fuse box on the drop). Under the head a sub-bus of its switched conductors
  (6 pt pitch).
* Per circuit a column: taps with junction dots on its phase(s), N from the
  sub-bus (or the main N when the head does not switch N), PE from the band's
  PE rail; the outgoing cores in colour, the cable text rotated along them, the
  terminal label (X1.3 … when `terminal_labels` is given), the circuit chip, two
  label lines, the room.
* Column width from the outgoing core count: ≤ 3 cores 48 pt, more 64 pt.
  Built (2026-10-26): a circuit label that 7 pt would cut ("Wärmepumpe" in 48 pt) is set
  at 6.5 pt; a lane placeholder too wide for its column breaks after its first word
  ("keine" / "Trennvorrichtung") instead of ending in "…".
  `paginate_columns` packs greedily per source and splits over-wide groups with
  paired markers **→ Forts. Blatt {k}** / **Forts. von Blatt {i}**.
* `crossings()` returns every horizontal/vertical crossing that is not a
  junction; each is drawn as a hop (semicircle r 2.2 pt on the vertical line).

### 5.4 Renderer (`schaltplan_stromlauf_pdf.py` + `schaltplan_stromlauf_symbols.py`)

`draw_stromlauf_sheets(c, sheets, *, plan, customer_name, project_label,
fed_from, author, company, first_sheet, total)` maps the layout to the canvas
only. Symbols per pole: contact, MCB, RCD ring, fuse, meter (eHZ / 3-Punkt),
SPD, terminal circle, Lüsterklemme, RJ45, SABO. Hops with path arcs.

### 5.5 Wiring

`build_panel_plan_pdf(..., catalog: EnclosureCatalog | None = None)`. The
route passes `catalog=terminals.catalog` (Slice D, ≤ +4 lines in
`workflow_schaltplan.py`, after the printing slice's extraction landed).

## 6. Tests

* `test_schaltplan_conductors.py`: tables for device, cable, supply conductors.
* `test_schaltplan_stromlauf_layout.py`: invariants over generated boards (0–40
  circuits per FI, 1–12 FIs, 1P/3P mixes, unknown phases, 1–5 fields × 1–2
  meter places, two sources): every primitive inside the drawing area; group
  order kept; continuation markers paired; a dot at every tap; a hop at exactly
  every non-junction crossing; PE never passes an RCD/MCB; N under a 4P RCD from
  the RCD; no wire joins two sources; the §14a block's net never touches L/N/PE;
  texts fit (stringWidth); deterministic output; the fixture boards
  `meter_dist_zb33s`, `three_point_zb53s`, `control_ehz_zb33s`,
  `control_3p_zb53s`, `busbar_gap_zb34s`, `reserve_zb33s`.
* `test_schaltplan_stromlauf_pdf.py`: `tests/pdf_recorder.py` (copy of
  `_Recorder`) — colours per conductor, dash patterns, nothing outside the frame.
* Route tests: the full PDF contains "Stromlaufplan allpolig"; "über Q1 HS" and
  "speist F1, F2" still present; no "Reihenklemmen" without terminals;
  `legend_only` unchanged; `build_legend` called once.
* **Visual proof** (mandatory): render every fixture board with `pdftoppm -r 110`,
  look at every page; an independent reviewer compares against `r4/ref/S3.svg`
  (colours, dots, hops, legibility at 100 %, nothing clipped, nothing
  overlapping) and the builder fixes until it passes.

## 7. Out of scope (offer later)

The in-app `PanelDiagram` keeps its look; a JSON endpoint serving the same
layout to the web is the follow-up.

## 8. Review log

Rev 2 took over: build order (A3 without the cabinet sheet; B4 after A1), the
overview vertical metrics, lanes per meter place with the SLS/HS pairing rule,
one source per bus segment (both sheet kinds), the Einspeisung sheet layout,
the §14a block on the metered side, PEN split by core count, TT/IT, the phase
mapping, core counts 2/4/7, RCD text from data, colour/legend/continuation
copy, title-strip widths, the "Messsystem" box, the overview file split.
