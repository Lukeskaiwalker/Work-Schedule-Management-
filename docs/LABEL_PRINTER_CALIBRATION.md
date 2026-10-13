# Label printer calibration — build contract (phase 1)

Printer: WAGO smartPRINTER 258-5101, a GoDEX OEM that speaks EZPL over raw TCP 9100
(192.168.2.158 in the office). Branch `claude/label-calibration`, base `a9c335f`.

This document is the **contract** for two agents that build in parallel without talking
to each other: a backend agent (`apps/api`) and a frontend agent (`apps/web`). Every JSON
shape, path, permission, German UI string and test file named here is normative. Where
this document and the research notes (`scratchpad/calib/*.md`) disagree, this document
wins. Where it leaves something open, it says so and names who decides.

---

## 0. How to read this

### 0.1 Wording rules (owner decision 3)

- Everything is built and tested against a **simulated printer** (a fake TCP server). The
  physical tests (§9) run later with the owner at the printer.
- **Nothing is called "verified"** — not in UI text, not in docs, not in code comments.
  UI text never uses "verifiziert" or "bestätigt" for printer behaviour; it uses "laut
  WAGO-Handhabungshinweis", "laut EZPL-Handbuch", "geschätzt", "nicht am Drucker geprüft".
  A wording test enforces this (§8.2).
- Source markers used below:
  - **[WAGO]** stated in a WAGO document (handling sheets 08.2020, roller table 12.2016, OI).
  - **[EZPL]** stated in the GoDEX EZPL Programmer's Manual Rev. J (2018-02-26).
  - **[Probe]** seen in the read-only probe of the real printer on 2026-10-13.
  - **[Inferred]** our reasoning, not a source.
  - **[Unverified → Tn]** a printer behaviour this build must handle defensively; physical
    test Tn (§9) decides it.

### 0.2 Owner decisions (2026-10-13) this contract implements

1. **Two flows.** Users with `werkstatt:manage` get the QUICK flow "Material gewechselt"
   (choose the loaded material → sensor positioning guide → apply settings (no paper) →
   confirm → auto-calibrate (feeds) → read back and verify). Users with `settings:manage`
   additionally get the FULL wizard (sensor mode, gap/mark, offsets via a measuring
   pattern, darkness/speed/stop, notes) and the profile editor. Both live in SMPL's web app.
2. **Every SMPL job states its baseline** in the header: darkness `^H`, speed `^S`, stop
   `^E` and copies `^C` (always `^C1` or `^Cn`), so values left behind by other clients
   (WAGO smartScript, GoDoctor) cannot change SMPL prints. Sensor commands (`^G`,
   `^XSET,SENSING`) are sent **only** by apply/calibrate, **never per job**
   ([Unverified → T15]). This build extends the same protection in two places (§4.8):
   `^P1` right after `^C` (owner confirmation pending, §11 D1; one constant removes it),
   and a standalone `^C1` after the final `E` of every job with copies > 1, so SMPL does
   not leave its own `^Cn` behind for the other clients.
3. **Simulated printer first**; every unverified printer behaviour is handled defensively
   and listed in §9.
4. **Sensor positioning diagram now**, drawn from WAGO's documentation, with every
   geometric constant in ONE module (`apps/web/src/components/labelPrinter/sensorGeometry.ts`)
   so it can be corrected from the owner's photo. Positions are labelled approximate:
   "Position laut WAGO-Handhabungshinweis".
   **Update 13.10.2026:** the owner's photo of his 258-5101 is in. His housing has none of
   the ▽/⬇ marks WAGO's handling sheets show (older housing); it has a printed scale 1–5
   (centimetres, millimetre ticks, 3 = media centre line) and a carriage with a ▲▼
   double-triangle pointer. The contract therefore models the sensor position as **one
   scale reading per material** (`sensor_scale`, §3.2). Scale, slot and carriage are drawn
   as measured from the photo (§2, §7.8); the per-material readings are WAGO's positions
   transferred to this scale and stay approximate ("ca.") until T0 (§3.3, §9).

### 0.3 Critique resolution (every high and medium finding, plus the lows)

| # | Finding (critique.md) | Resolution in this contract | § |
|---|---|---|---|
| H1 | `^C` is permanent; jobs only send `^C` when copies > 1 | Every job header always carries `^C{n}` (`^C1` for single). The pattern endpoint has no `copies`. Byte change accepted explicitly and pinned. T5 checks a single job after a copies=2 job. | 4.8, 8.1, 9 |
| H2 | Verify cannot tell a fresh auto-sense from a stale one | Freshness proof: STATUS 50/60 seen while sensing, OR stored `^Q` changed from the pre-sense snapshot to a value consistent with the new `^QD`, OR `^QD` changed. No proof → verdict `unchecked`, never `match`. Explicit rule order. | 4.6, 4.7 |
| H3 | Darkness ladder leaves `^H` behind; cancel leaves printer state unrecorded | The ladder is phase 2. Every SMPL job states `^H ^S ^E ^C`, so leftovers cannot affect SMPL prints. Apply writes a server-side `last_applied` record; the cancel dialog names exactly what was changed on the printer. | 1, 3.6, 4.8, 7.5 |
| H4 | 210-805 phase-1 builtin gives wrong physical instructions | A separate physical `web` geometry (2 lanes, ≈ 15 × 6 mm, liner ≈ 34 mm, source `estimate`) drives the guide text, diagram and verify; printing stays one-lane 6 × 15 (unchanged). Guide text says "an den Trägerrand anlegen (≈ 34 mm, geschätzt)". Spot check is hint-only. Tests run on the actual builtin. | 3.3, 4.7, 7.8 |
| M1 | `/apply` sends `^E`, which can feed | Apply sends only sensor commands, `^Q` and `^W`. No `^E ^H ^S ^C ^L E`. The UI says "laut EZPL-Handbuch", never "verified". T1 watches for movement. | 4.5 |
| M2 | Radio switch: auto-send or not? | No auto-send anywhere. The admin radio only changes SMPL's selection and then offers the quick flow. Tests pin "radio = one PATCH, no apply". | 7.6, 8.2 |
| M3 | `~S,SENSOR` may overwrite `^G`/`^XSET,SENSING` | After sensing, verify compares the sensor line with the profile and offers a no-paper re-apply. **Every** apply sends an explicit `^XSET,SENSING,n` (die-cut included, so a "Kein Sensor" apply never lingers), and `auto` is not allowed on continuous stock. T1/T2/T17 ask the question. | 4.4, 4.5, 4.7 |
| M4 | Spot check gives ✓/✗ from an unverified sensor model | `sensorTrack` returns ℹ hints only; it never gates a step. With guides fully open (`guide: "max"`) it does not assume a centred web, and the wizard computes no across correction. T0 asks which element moves and what centres the web. | 4.11, 7.8 |
| M5 | A/B formula mixes length error with feed offset | Feed offset comes from A (leading edge) only. B feeds a length/scale check that is shown as info and never applied. | 4.11 |
| M6 | Builtin defaults stop healing after one save | Builtin entries store **only overrides** (a diff against the code default). Legacy (v1) blobs are migrated at read time against a frozen copy of the v1 defaults. A test changes a code default after a save and sees it arrive. | 3.5 |
| M7 | Card echo freezes the resolved baseline into every profile | `darkness`/`speed_ips`/`stop_mm` in GET are the **stored** overrides (null = baseline); resolved values live in a separate `resolved` object. PATCH list semantics are defined (ids missing → removed, listed → merged). A test echoes the new GET shape back. | 3.9, 6.4 |
| M8 | Nothing serialises calibration against other users/workers | DB-backed calibration session lock with TTL; every print path (`_ship`) refuses with 409 while someone else holds it; the loaded material becomes active at the load step; config writes use `with_for_update` + revision compare-and-set; a cross-worker file lock allows one printer connection at a time. | 5 |
| M9 | T-tests are referenced but undefined | §9 defines T0–T16: steps, expected readback, paper cost, who is at the printer, what each result unlocks; plus a results table. | 9 |
| M10 | Checklist has the sensor set after threading the media | Order is roller → sensor carriage → roll/thread → guides → ribbon → lid. The diagram's "Sensor" state draws no media. T0 asks whether the housing scale is visible with media loaded. | 7.4, 7.8 |
| L1 | Negative `x_offset_mm` gives negative coordinates | Every job passes a coordinate guard (machine x within the `^W` region 0…h_px, die-cut y within 0…form length; `Lo` clamped, text/codes/images raise a German `LabelFormatUnsupported` subclass); profile saves run a dry render of every renderer for that material and answer 422; the API exposes the resulting `offset_limits`. | 4.9 |
| L2 | Round-half-up breaks byte identity | `_mm` rounding is **not** changed in phase 1. | 4.8 |
| L3 | "`^W` differs" warning fires after SMPL's own strips | Dropped: every SMPL job states `^Q`/`^W` anyway. | 4.3 |
| L4 | `POST /row-offset` is a general `~Q` writer | Phase 1 sends no `~Q` at all; it only reads, pins and warns. The phase-2 restore action takes no body. | 1, 4.1 |
| L5 | F1/F4 and black-mark rule overstate the research | `~X` stays on the never-send list without claiming it prints; media type from `^Q` form is marked [Inferred]; the black-mark sensor rule is a hint, not a validation error. | 2, 3.8 |
| L6 | Verdict and safety rules contradict each other | One explicit rule order (§4.7). No "degraded auto-sense": without STATUS replies the user is sent to the calibration button (method `button`, which proceeds without STATUS, §4.6), and freshness can then only come from `^Q`/`^QD` changes. | 4.6, 4.7 |
| L7 | `_query_tcp` 300 ms idle cut truncates CONFIG | Reads end on the reply's own terminator (`---` line for CONFIG, first `nn,nnnnn` line for STATUS) or a deadline; `ERRORnn` pushes are skipped and reported; one connection at a time. | 4.2 |

### 0.4 Second review (2026-10-13): where each problem is resolved

S1–S31 follow the order of the second review's problem list. Every problem was checked
against the code at `a9c335f` and the research notes before it was resolved. Choices
between offered alternatives and partial adoptions are explained in "Review decisions" at
the end of this document.

| # | Problem | Resolution | § |
|---|---|---|---|
| S1 | Measurement replaced after a `^Q` write; `^QD` may echo `^Q` | Measurement **latched** at the first fresh verify of a run and never replaced; every write after sensing is recorded in `writes_since_sense`; a write before the latch ⇒ `unchecked` (echo detected or not). Fake gets `q_write_updates_qd`. T1 records `^QD` around a differing `^Q`. | 3.7, 4.6, 4.7, 8.1, 9 |
| S2 | Runaway auto-sense cannot be stopped | Continuous cost hint "unbekannt" (no cm bound); stop instruction (lid) in both feed dialogs and the sensing view from the start; elapsed vs cost hint; 15 s "slow" hint. T9 checks the lid stop. | 3.3, 4.6, 7.4, 7.7, 9 |
| S3 | GET /status writes `^XSET,IMMEDIATE,1` | Phase 1 never sends IMMEDIATE. `read_status` is read-only; silent STATUS ⇒ `answered:false`. | 4.1, 4.3, 4.6 |
| S4 | `/pattern` has no feed confirm, status, phase or double-send guard | 422 `confirm_feed_required`; STATUS `00` + 0 pending; phase `judged`; `pattern_pending`; `activate`/`apply` refused while sensing. | 6.2 |
| S5 | Pattern on two-lane 210-805 | 422 `pattern_unsupported` when `web.lanes > 1` or web ≠ print geometry; `pattern_supported` in the API. | 4.11, 6.2, 7.6 |
| S6 | SMPL leaves `^Cn` behind for other clients | Standalone `^C1` after the final `E` of copies > 1 jobs; carry-over of `^H/^S/^E` stated. | 4.8, 9 (T5), 11 |
| S7 | `^P` leftovers multiply SMPL prints | `^P1` after `^C` in every header (constant `JOB_HEADER_SENDS_P1`); owner confirmation pending. | 4.1, 4.8, 11 |
| S8 | `^XSET,SENSING,2` never reset | Every apply sends `^XSET,SENSING,n`; T1 ends on the reset; new T17; "Kein Sensor" form hint. | 4.4, 7.9, 9 |
| S9 | Lid close may auto-sense with old settings | ℹ line on checklist item 6; autosense re-sends `^Q`/`^W` before the pre-sense snapshot. | 4.6, 7.4 |
| S10 | Guard bounds the head, not the media | Machine x within 0…h_px, die-cut y within 0…form length; `Lo` clamped, `AT` em box / `XRB` / `Y` raise. | 4.9 |
| S11 | Queries assumed harmless | §2 row + T0b (first test). | 2, 9 |
| S12 | Prod would run unverified behaviour for staff | `label_calibration_staff_enabled` (default false) hides the quick entry from `werkstatt:manage`-only users and refuses their sessions; physical tests from a local API. | 3.4, 6.2, 7.11, 9, 11 |
| S13 | `app_settings.value` is VARCHAR(2048) | Migration to `Text`; caps on every list in the blobs; size test. | 3.1, 8.1 |
| S14 | Button fallback unreachable | Autosense steps 3–4 depend on the method; `button` proceeds without STATUS. | 4.6, 7.4 |
| S15 | Wizard PUT after activate is stale | `SessionOut.config_revision`; the wizard always uses the latest revision it received. | 6.4, 7.6 |
| S16 | One busy exception for two situations | `LabelPrinterSessionBusy` / `LabelPrinterIoBusy` subclasses. | 5.1, 5.3 |
| S17 | `read_status` write refused by own session | Moot: reads never write (R3); reads never pass the session check. | 4.3, 5.1 |
| S18 | Poll texts have no field; `done` cannot replay | `SensePollOut.message`; `sense.result`; ordered poll table, timeout first, unknown codes. | 3.7, 4.6, 6.4 |
| S19 | Two messages for `printer_not_ready` | One template. | 4.5, 6.3 |
| S20 | `HH:MM` timezone undefined | Server formats in `settings.app_timezone`; `since` = ISO UTC; frontend never parses messages. | 5.1, 6.3, 7.4 |
| S21 | Sticky freshness has no storage | `sense.latched` and the `verify` blob defined field by field. | 3.7, 4.7 |
| S22 | `activate` effect on `apply` undefined | `activate` resets `apply`/`verify`, keeps `sense`, re-captures `profile_at_start`. | 3.7, 6.2 |
| S23 | PATCH error shapes undefined | PATCH error table; explicit null on a non-nullable item field is ignored. | 6.3, 6.4 |
| S24 | Pydantic ranges give English errors | Input schemas carry types only; ranges validated in the service with German texts. | 3.8, 6.4 |
| S25 | Builtin override entry dropped for missing `width_mm` | The `width_mm` rule applies to custom entries only. | 3.5 |
| S26 | Non-ASCII `part_no` ⇒ 500 | Pattern text mapped to the allow-list charset (`?`). | 4.10, 4.11 |
| S27 | Import cycles via exceptions | Leaf module `werkstatt_label_errors.py`. | 5.0 |
| S28 | Dry render misses most renderers | Every renderer that can run on the material; `offset_limits` exposed and used by the wizard. | 4.9, 6.4, 7.6 |
| S29 | DELETE after save undefined | DELETE idempotent, always 204. | 6.2 |
| S30 | No printer address | 503 `not_configured`; quick entry disabled; sheet shows the text. | 6.2, 7.4, 7.11 |
| S31 | Switch-material UI state undefined | `verifyWithoutSensing`; wizard subject follows `session.material_id`. | 7.4, 7.5, 7.6 |

---

## 1. Scope

### 1.1 Phase 1 — this build

The owner's three asks, lean but complete:

1. **Calibrate per material.** Quick flow (apply → auto-sense → verify → save a calibration
   record) for `werkstatt:manage`; full wizard (adds printer check, profile edit, measuring
   pattern with offset correction, print values, notes) for `settings:manage`.
2. **Set the sensor per material.** New profile fields (`sensor_mode`, `sensor_scale`,
   black mark, …) and a no-paper apply that sends `^G` / `^XSET,SENSING` / `^Q` / `^W`.
3. **Show the sensor position.** An SVG top view (the housing's printed scale 1–5 with
   millimetre ticks, the carriage with its ▲▼ double-triangle pointer at the material's
   scale reading, an optional "Ist" pointer for the reading the user sees now, guides,
   material to scale incl. two lanes for 210-805) and a schematic side view of the media
   path.

Also in phase 1, because the three asks need them:

- per-job baseline header `^H ^S ^E ^C ^P1` plus the trailing `^C1` reset (owner decision 2, §4.8);
- printer readback over port 9100 (`~S,STATUS`, `^XGET,CONFIG`), strictly read-only;
- calibration session lock, revision compare-and-set, one-connection-at-a-time I/O lock;
- overrides-only storage of builtin profiles with read-time migration;
- **one DB migration**: `app_settings.value` VARCHAR(2048) → `Text` (§3.1);
- the runtime switch `label_calibration_staff_enabled` (default off) that keeps the quick
  flow admin-only until the physical tests have results (§3.4, §9);
- correction of the wrong roller advice (all six materials use **258-5006**);
- `_clean` additionally strips `~` and `^` from interpolated text;
- coordinate guard against printing outside the material, with per-material
  `offset_limits` (§4.9).

### 1.2 Phase 2 — gated on physical tests (not built now)

| Item | Gate |
|---|---|
| Printer scale `dots_per_mm` (H1: 1164 dots may be 98.6 mm at 11.81 dots/mm) threaded into all renderers and the web `schaltplanStrip.DOTS_PER_MM`; "Messwerte übernehmen" (write measured length/gap into a profile) | T4 + T14 |
| 210-805 printed two-lane (width 15, length 6, two texts per row) | T0 + T8 |
| `^G` / `^XSET,SENSING` inside every job (so `material_by_id` strip jobs always use the right sensor) | T15 |
| Darkness ladder (one job per level) | owner wish; T5 done |
| `~Q` restore action (no body; sends the pinned value) and optional per-job `~Q` | T11 |
| "Fehler quittieren" via `~S,CANCEL` | T12 |
| Decimal or half-up `^Q` values | new test, after T2 |
| Quick-flow reorder (apply before the lid is closed) if closing the lid auto-senses; phase 1 already re-sends `^Q`/`^W` before the pre-sense snapshot, so the reorder keeps freshness working | T3 |
| `^XSET,IMMEDIATE,1` as an explicit, audited step of autosense (only if STATUS stops answering) | T10 |
| Measuring pattern for multi-lane stock (210-805) | T8 |
| Wider across offsets on 2009-110 (the block label's top row sits 3 dots from the strip edge, §4.9) | owner wish |
| Replace the hard-coded web `LABEL_MATERIALS` in `utils/schaltplanStrip.ts` with the API list | none |
| Printer hardening (unauthenticated Telnet :23, web :80, SNMP `public`) | owner decision (§11) |

The owner's photo (13.10.2026) is already in: the scale, slot and carriage geometry in
`sensorGeometry.ts` is taken from it (`measured: true`, §7.8). Small follow-up after T0
(no phase-2 code): once T0 has confirmed or corrected the per-material scale readings,
update the builtin `sensor_scale` values and drop "ca." from their hints
(`werkstatt_label_builtins.py`, §3.3) — a one-file edit.

---

## 2. Facts this build relies on

| Fact | Status |
|---|---|
| Port 9100 is two-way. `~S,CHECK`, `~S,STATUS`, `~B`, `^XGET,CONFIG`, `~MDIR` answered in well under 3 s without `^XSET,IMMEDIATE,1`. | [Probe] |
| STATUS/CONFIG lösen keine Bewegung und keinen Druck aus (status stayed `00`, 0 pending; nobody watched the printer). | [Probe], [Unverified → T0b] |
| `^XSET,IMMEDIATE,1` is the documented precondition of `^XSET,ACTIVERESPONSE` (default 1), which pushes `ERRORxx` to the host. Its persistence is undocumented. Phase 1 never sends it. | [EZPL] p.14, [Unverified → T10] |
| `^XGET,CONFIG` carries the active sensor line (`See.:…`), the last measurement `^QD<len>,<gap>` (dots) with `Label+Gap = N Dots`, and stored `^S ^H ^R ~R ~Q ^W ^Q ^E ^D ^O ^A`. Its reply ends with the lines `--------` and `---`. | [Probe] (Appendix A) |
| Currently stored: `^S2 ^H12 ^R000 ~R255 ~Q-19`, `^W34 ^Q97,2 ^E0`, `^AT`, last measurement `^QD1164,30` (97.0 + 2.5 mm at 12 dots/mm). | [Probe] |
| `^G0` reflective, `^G1` see-through, `^G2` auto; `^XSET,SENSING,0/1/2` (reflective / see-through / none) for continuous stock. | [EZPL] p.5, p.20 |
| `^XSET,SENSING,n` sent with die-cut stock is ignored or harmless (the manual scopes it to continuous labels); `SENSING` cannot be read back. | [Inferred], [Unverified → T1/T17] |
| With "Kein Sensor" (`SENSING,2`) the printer probably also misses the end of the material. | [Inferred], [Unverified → T9] |
| Whether a `^Q` write (apply, pattern, job) rewrites the `^QD` line. | [Unverified → T1] |
| Media type follows from the form of `^Q`: `^Qx,y` gap, `^Qx,0` continuous, `^Qx,y,z±` black mark. | [EZPL] p.10, [Inferred] for "no separate mode command" |
| `~S,SENSOR` = auto-sense, feeds media, stores the result; equivalent to the calibration button on the back (1 s [WAGO], 2 s [GoDEX]). | [EZPL] p.34, [WAGO] OI §6.5.9 |
| Setup commands placed between `^L` and `E` are ignored. | [EZPL] p.75 |
| `^C` is "Permanent, default ^C1". | [EZPL] p.2, [Unverified → T5] on this firmware |
| `^C` and `^P` multiply ("^C2 ^P3 … 6 pieces"); no persistence is stated for `^P`; CONFIG shows neither. | [EZPL] p.2, p.9, [Unverified → T5] |
| A standalone `^C1` after `E` sets the value without printing and does not shorten the job before it. | [Inferred] from [EZPL] p.2/p.75, [Unverified → T5] |
| `^E` "Feed the paper to specific stop position". | [EZPL] p.4 |
| Opening the lid stops the motor (stated for `^B`/`^M`: "Dooropen … motor would stop"), so it can stop a runaway auto-sense; status then reads `04`. | [Inferred] from [EZPL] p.2/p.7, [Unverified → T9] |
| `~V` prints a self-test page; `~T` prints a head test; `~S,DUMP` prints; `^Z` restores factory defaults; `~Z` resets; `~R` is 180° rotation, not reset. `~Xn` is described as "Print…" but its examples reply to the host — unknown, never sent. | [EZPL] p.26–37 |
| WAGO's sensor position, drawn on the **older** housing with ▽/⬇ marks: labels 210-804/-824/-812/-805 → carriage pointer at the triangle ▽, ≈ 3–4 mm right of the centre seen from the front; strip 2009-110 and tube 211-501 → at the arrow ⬇ = media centre line. | [WAGO] handling sheets 08.2020 §1.2; distance estimated from WAGO's photos |
| The owner's 258-5101 (dark grey interior, green media guides, black smooth platen roller) has **no** ▽/⬇ marks. Its housing carries a **printed scale "1 2 3 4 5"** on the rear side of the sensor slot: numbers = centimetres, a long tick at each number, a medium tick at each half, short ticks every millimetre (9 between two numbers); printed ticks run from about 0,6 to 5,4. | Foto 13.10.2026 |
| Scale **3 = media-path centre line** (it lines up with the centre between the green guides within about 0,5 mm). Offset from the centre in mm = (reading − 3) × 10, + = right seen from the front; one tick = 1 mm. | Foto 13.10.2026; the 0,5 mm [Unverified → T0] |
| Sensor carriage: a black block sliding in a horizontal slot that spans about scale −1,1 … 7,1 (≈ −41 … +41 mm from the centre). The carriage is ≈ 26 mm wide incl. its side wings, its central block ≈ 9 mm; so the pointer travels about 0,3 … 5,7. On the central block a black **double-triangle pointer** (▲ toward the scale, ▼ toward the operator, each ≈ 3,5 mm wide) with a window between them that holds the two optical elements; the ▲ tip marks the sensing point on the scale. | Foto 13.10.2026 (measured against the printed millimetre ticks) |
| Rows of 3 raised dots above and below the slot are decorative; SMPL neither draws nor uses them. | Foto 13.10.2026 |
| Order along the feed (seen from the front): roll holder at the rear, green guides, sensor slot with the scale on its rear side, platen roller and print line at the front. | Foto 13.10.2026 |
| With 210-804 loaded and the pointer at **≈ 3,4** (≈ 4 mm right of the centre) the printer senses correctly: see-through sensor, last measurement 97,0 mm label + 2,5 mm gap. | Foto 13.10.2026 + [Probe] (Appendix A) |
| WAGO's positions transferred to this scale: labels 210-804/-824/-812/-805 (triangle, 3–4 mm right) → **ca. 3,4**; strip 2009-110 and tube 211-501 (arrow = centre) → **ca. 3,0**. The owner can read the scale to 0,1 (1 mm). | [Inferred] from [WAGO] + Foto 13.10.2026, [Unverified → T0] (by eye, per material) |
| Whether the scale and the pointer stay readable with media loaded. | [Unverified → T0] |
| Guides: 210-804 family "maximale Öffnung"; 210-805, 211-502, 2009-110 "1 mm + Materialbreite + 1 mm". Strip and tube come from the external unwinder, unrolling to the left, counter-clockwise through the rear slot. | [WAGO] §1.3 |
| All six materials use roller **258-5006** (black, smooth). 258-5007 (dark green, grooved) is only for WMB-Inline 2009-113/-114/-115. | [WAGO] roller table 12.2016; Foto 13.10.2026 shows a black smooth roller fitted |
| 210-805 is supplied as 3000 labels/roll on **2 lanes**. Size ≈ 15 across × 6 along, liner ≈ 34 mm are estimates from a WAGO photo. | [WAGO] (lanes), WAGO photo (sizes) [Unverified → T0/T8] |
| Expected auto-sense result for 2009-110: "Continuous Paper / See-Through". Labels with the pointer at ≈ 3,4: see-through. | [WAGO] GoDoctor 2017 (2009-110); [Probe] sensor line `See.` + Foto 13.10.2026 (210-804) |
| Which sensor element moves with the carriage; whether see-through sensing follows the pointer. | [Unverified → T0/T8] |
| Whether settings survive a power cycle; whether closing the lid auto-senses. | [Unverified → T10/T3] |

The UI never calls the sensor "IR" (no source states the wavelength). It says
"Sensor", "Durchlicht" (see-through) and "Reflex" (reflective).

---

## 3. Data model

### 3.1 Storage keys (all in `AppSetting`) and the one migration

| Key | Constant (`services/runtime_settings.py`) | Content | Writers |
|---|---|---|---|
| `werkstatt_label_printer` | `WERKSTATT_LABEL_PRINTER_KEY` (exists) | configuration, **revisioned** (§3.4) | PATCH, PUT material, PUT printer, session `activate` |
| `werkstatt_label_printer_state` | `WERKSTATT_LABEL_PRINTER_STATE_KEY` (new) | calibration records + `last_applied` (§3.6) | session `apply`, `save` |
| `werkstatt_label_printer_lock` | `WERKSTATT_LABEL_PRINTER_LOCK_KEY` (new) | the one calibration session (§3.7); `{}` when free | session endpoints |

**Migration (backend, required).** `AppSetting.value` is `String(2048)`
(`app/models/settings_models.py:15`, created as `VARCHAR(2048)` by
`alembic/versions/20260222_0015_bootstrap_runtime_settings.py:25`). One §3.6 record is
≈ 1 KB of JSON, four full custom profiles plus builtin overrides exceed 2 KB, and the lock
blob carries a profile snapshot, poll codes and a verify snapshot. SQLite (the test DB)
does not enforce the length, so only prod would fail (DataError → 500). Therefore:

- new revision `apps/api/alembic/versions/<date>_<next>_app_settings_value_text.py`, the
  next free number after the current head (`20261010_0101` at `a9c335f`), `down_revision`
  = that head: `op.alter_column("app_settings", "value", existing_type=sa.String(length=2048),
  type_=sa.Text(), existing_nullable=False)`; downgrade back to `String(2048)` (documented
  as lossy if longer values exist);
- model: `value: Mapped[str] = mapped_column(Text, nullable=False)`;
- verify the upgrade/downgrade in a throwaway PG16 container (migrations only run on
  Postgres) and keep `apps/api/scripts/check_schema_drift.py` at 0;
- every list inside the blobs is capped (§3.6, §3.7) and a test writes the worst case (§8.1).

All three are read defensively: malformed JSON reads as defaults/empty and never raises.
Delete the dead `runtime_settings.get_label_printer_settings` / `set_label_printer_settings`
(no callers; the setter would wipe all materials).

### 3.2 `MaterialProfile` fields

Module split (all files new except where noted):

- `services/werkstatt_label_profile.py`: the dataclasses below, enum tuples,
  `HEAD_WIDTH_MM`, `MIN_LENGTH_MM`, `MAX_LENGTH_MM`, `TIER_*`, `CODE_BASELINE`,
  `SENSOR_SCALE_MIN = 0.5`, `SENSOR_SCALE_MAX = 5.5`, `SENSOR_SCALE_CENTRE = 3.0`,
  `SENSOR_SCALE_LABELS = 3.4` (default reading for die-cut stock) and
  `format_scale_de(reading) -> str` (decimal comma, one decimal, a trailing ",0" dropped:
  `3.4 → "3,4"`, `3.0 → "3"`).
- `services/werkstatt_label_builtins.py`: `DEFAULT_MATERIALS`, `DEFAULT_ACTIVE_ID`,
  `LEGACY_V1_BUILTIN_VALUES`, `BUILTIN_HINTS`, `AUTOSENSE_COST_HINT`, `PATTERN_COST_HINT`.
- `services/werkstatt_label_materials.py` (exists): storage, migration, validation,
  `get_label_printer_config`, `active_material`, `material_by_id`,
  `normalize_incoming_material`. It **re-exports** every name it exports today
  (`MaterialProfile`, `DEFAULT_MATERIALS`, `DEFAULT_ACTIVE_ID`, `TIER_*`,
  `MaterialValidationError`, …) so no existing import breaks.

```python
@dataclass(frozen=True)
class MediaWeb:                       # the physical roll, for guide/diagram/verify only
    lanes: int = 1                    # 1..4 labels side by side
    label_across_mm: float | None = None   # None → profile.width_mm
    label_along_mm: float | None = None    # None → profile.length_mm (ignored when continuous)
    lane_gap_mm: float = 0.0          # slit between lanes, 0..10
    liner_width_mm: float | None = None    # 3..60; None = unknown
    source: str = "catalogue"         # "catalogue" | "estimate" | "measured"

@dataclass(frozen=True)
class JobSettings:                    # resolved per-job values, never None
    darkness: int                     # ^H 0..19
    speed_ips: int                    # ^S 2..4
    stop_mm: int                      # ^E 0..40

CODE_BASELINE = JobSettings(darkness=12, speed_ips=2, stop_mm=0)
```

`MaterialProfile` keeps its existing fields **in their existing order** and appends the
new ones (all keyword construction in the codebase keeps working):

| Field | Type | Unit / range | Default (custom) | Sent to printer | Meaning |
|---|---|---|---|---|---|
| `id` | str | 1–40 chars | — | never | slug; builtins `wago-…`, customs `custom-<base36>` |
| `name` | str | 1–60 | — | never | German display name |
| `part_no` | str | ≤ 40 | `""` | pattern text only (cleaned) | |
| `width_mm` | float | 4–47 | — | `^W` | across the head (print geometry) |
| `length_mm` | float \| None | 5–762; None = continuous | — | `^Q` | along the feed (print geometry) |
| `gap_mm` | float | 0–10 | 3.0 | `^Q` | gap between labels |
| `x_offset_mm` | float | **−5…10** (was 0…10), and inside `offset_limits` (§4.9) | 2.0 | none (software, machine y) | "Versatz Vorschub" |
| `darkness` | int \| None | 0–19 | None | `^H` (resolved) | **stored override**; None = baseline |
| `builtin` | bool | derived from id | False | never | |
| `across_offset_mm` | float | −5…5, and inside `offset_limits` (§4.9) | 0.0 | none (software, machine x) | "Versatz quer"; + moves the print toward edge "L" (§4.9) |
| `speed_ips` | int \| None | 2–4 | None | `^S` (resolved) | stored override |
| `stop_mm` | int \| None | 0–40 | None | `^E` (resolved) | stored override |
| `mark_width_mm` | float \| None | 1–10 (integer on the wire) | None | `^Q…,{M},…` | set ⇒ black-mark stock |
| `mark_offset_mm` | float | 0–50 (range [Inferred]) | 0.0 | `^Q…,{Z}±` | black line → top of form |
| `mark_inside` | bool | | False | `-` if True else `+` | position inside/outside the mark [EZPL] p.10 |
| `sensor_mode` | str | `see_through` \| `reflective` \| `auto` \| `none` | gap: `auto`; mark: `reflective`; continuous: `see_through` | `^G` / `^XSET,SENSING` (apply only) | |
| `sensor_scale` | float | 0.5–5.5 on the housing scale, one decimal (rounded on write, §3.8); offset from the centre line in mm = (`sensor_scale` − 3.0) × 10, + = right seen from the front | die-cut (gap/mark): 3.4; continuous: 3.0 | never | the reading the carriage's ▲▼ pointer must show on the printed scale (§2) |
| `guide` | str | `max` \| `fit` | `fit` | never | guides fully open, or 1 mm + web + 1 mm |
| `feed_path` | str | `internal` \| `external` | die-cut: `internal`; continuous: `external` | never | internal roll holder or external unwinder |
| `roller` | str | `258-5006` \| `258-5007` | `258-5006` | never | platen roller to fit |
| `web` | MediaWeb | see above | `MediaWeb()` | never | physical roll geometry |
| `job` | JobSettings \| None | | None (`compare=False`) | — | resolved values, attached by `get_label_printer_config` |

Derived properties (not stored):

- `continuous` = `length_mm is None` (unchanged).
- `media_type` = `"continuous"` if continuous, `"mark"` if `mark_width_mm` is set, else `"gap"`.
- `tier` unchanged.
- `job_settings` → `self.job` if set, else `JobSettings(darkness ?? CODE_BASELINE.darkness, …)`.
  `_sheet` uses this, so profiles built directly in tests still print with the code baseline.
- `web_width_mm` → `web.liner_width_mm` if set, else `lanes·across + (lanes−1)·lane_gap`
  with `across = web.label_across_mm ?? width_mm`.
- `physical_length_mm` → `web.label_along_mm ?? length_mm` (verify uses it, §4.7).
- `fingerprint` → first 16 hex chars of sha256 over canonical JSON of
  `width_mm, length_mm, gap_mm, mark_width_mm, mark_offset_mm, mark_inside, sensor_mode,
  sensor_scale, web` (§3.6 stale detection).

### 3.3 Builtin defaults (`werkstatt_label_builtins.py`)

All builtins: `x_offset_mm 2.0`, `across_offset_mm 0`, `darkness/speed_ips/stop_mm None`,
no black mark, `roller "258-5006"`, `gap_mm 3.0`.

| id | width × length (print, unchanged) | sensor_mode | sensor_scale | guide | feed_path | web: lanes / across / along / lane gap / liner / source |
|---|---|---|---|---|---|---|
| `wago-210-804` | 44 × 99 | see_through | 3.4 | max | internal | 1 / None / None / 0 / None / catalogue |
| `wago-210-824` | 44 × 99 | see_through | 3.4 | max | internal | 1 / None / None / 0 / None / catalogue |
| `wago-210-812` | 25 × 50 | see_through | 3.4 | max | internal | 1 / None / None / 0 / None / catalogue |
| `wago-210-805` | 6 × 15 (**printing unchanged**) | see_through | 3.4 | fit | internal | **2 / 15.0 / 6.0 / 1.0 / 34.0 / estimate** |
| `wago-211-501` | 5, continuous | see_through | 3.0 | fit | external | 1 / None / None / 0 / 5.0 / estimate |
| `wago-2009-110` | 11, continuous | see_through | 3.0 | fit | external | 1 / None / None / 0 / 11.0 / catalogue |

`sensor_scale` 3.4 is WAGO's "triangle" position (3–4 mm right of the centre) transferred
to the owner's scale; the photo of 13.10.2026 shows the pointer at ≈ 3,4 with 210-804
loaded and sensing correctly. 3.0 is WAGO's "arrow" = the centre line. Both stay
approximate until T0 (§9), so their hints say "ca.".

`BUILTIN_HINTS: dict[str, list[tuple[topic, text]]]`, topics `sensor_position`,
`sensor_mode`, `geometry`, `web`, `roller`, `printing`. Exact German texts:

- every builtin, topic `roller`: "Andruckwalze 258-5006 laut WAGO-Zuordnungstabelle (12.2016)"
- every builtin with `sensor_scale` 3.4 (`wago-210-804`, `-824`, `-812`, `-805`), an
  additional sensor_position hint: "Foto 13.10.2026: Etiketten werden so korrekt erkannt (Rolle 210-804)"
- `wago-210-804`:
  - sensor_position: "Sensorposition ca. 3,4 der Skala: WAGO-Handhabungshinweis 210-804 (08.2020), auf die Skala Ihres Druckers übertragen"
  - sensor_mode: "Sensor Durchlicht: abgeleitet, nicht am Drucker geprüft"
  - geometry: "99 × 44 mm, Spalt 3 mm: von SMPL am Drucker eingestellt (WAGO veröffentlicht Spalt und Trägerbreite nicht)"
- `wago-210-824`:
  - sensor_position: "Sensorposition ca. 3,4 der Skala wie 210-804: WAGO-Handhabungshinweis (WAGO ordnet denselben zu), auf die Skala Ihres Druckers übertragen"
  - sensor_mode: "Sensor Durchlicht: abgeleitet, nicht am Drucker geprüft"
  - geometry: "Gleich groß wie 210-804 – eine Messung unterscheidet die beiden nicht"
- `wago-210-812`:
  - sensor_position: "Sensorposition ca. 3,4 der Skala: WAGO-Handhabungshinweis 210-804 (dort mitgenannt), auf die Skala Ihres Druckers übertragen"
  - sensor_mode: "Sensor Durchlicht: abgeleitet, nicht am Drucker geprüft"
  - geometry: "Spalt 3 mm: Annahme von SMPL"
- `wago-210-805`:
  - sensor_position: "Sensorposition ca. 3,4 der Skala: WAGO-Handhabungshinweis 210-805 (08.2020), auf die Skala Ihres Druckers übertragen"
  - web: "WAGO: 3.000 Etiketten pro Rolle, 2 Bahnen"
  - web: "Maße der Rolle (≈ 15 × 6 mm je Etikett, Träger ≈ 34 mm) aus einem WAGO-Foto geschätzt, nicht am Material gemessen"
  - printing: "SMPL druckt 210-805 in diesem Stand weiter einbahnig 6 × 15 mm"
- `wago-211-501`:
  - sensor_position: "Sensorposition ca. 3 der Skala (Mitte): WAGO-Handhabungshinweis 211-502 (gilt für 211-500 … -506), auf die Skala Ihres Druckers übertragen"
  - web: "Breite flach ≈ 5 mm: berechnet (π · 3,2 / 2), nicht gemessen"
  - sensor_mode: "Sensor Durchlicht: abgeleitet, nicht am Drucker geprüft"
- `wago-2009-110`:
  - sensor_position: "Sensorposition ca. 3 der Skala (Mitte): WAGO-Handhabungshinweis 2009-110 (08.2020), auf die Skala Ihres Druckers übertragen"
  - sensor_mode: "Sensor Durchlicht für Endlosmaterial: Ergebnis der WAGO-Software GoDoctor (2017)"

The UI hides `web`-topic hints once `web.source == "measured"`, and `sensor_position`
hints once `sensor_scale` is in `overridden_fields` (they describe the builtin default
reading, not the admin's value). Both rules live in one helper, `visibleHints(material)`
(§7.2).

`AUTOSENSE_COST_HINT` (German, shown in the feed confirmation):

| id | text |
|---|---|
| `wago-210-804`, `wago-210-824` | "voraussichtlich 2–3 Etiketten (≈ 20–30 cm, Schätzung)" |
| `wago-210-812` | "voraussichtlich 2–3 Etiketten (≈ 11–16 cm, Schätzung)" |
| `wago-210-805` | "voraussichtlich einige Etikettenreihen (wenige cm, Schätzung)" |
| `wago-211-501` | "Menge unbekannt – für Endlosschlauch nennt keine Quelle eine Grenze" |
| `wago-2009-110` | "Menge unbekannt – für Endlosstreifen nennt keine Quelle eine Grenze" |
| custom die-cut | "voraussichtlich 2–3 Etiketten (≈ {3 × Teilung} mm, Schätzung)" |
| custom continuous | "Menge unbekannt – für Endlosmaterial nennt keine Quelle eine Grenze" |

No source bounds the feed of an auto-sense on continuous stock (T9 budgets 70 cm per
attempt), so continuous hints name no length.

`PATTERN_COST_HINT`: die-cut "1 Etikett"; continuous "≈ {pattern length + x_offset, rounded} mm Streifen (Schätzung)" (2009-110 → "≈ 42 mm Streifen (Schätzung)", 211-501 → "≈ 32 mm Schlauch (Schätzung)"); `""` when the pattern is unsupported (210-805, §4.11).

Every hint carries its own qualifier; the UI shows hints verbatim and appends nothing.

`FEED_STOP_HINT` (German, a **frontend** constant in `utils/labelCalibration.ts`, shown by
the feed dialogs and the sensing view, §7.4/§7.7):
"Läuft zu viel Material durch: Deckel öffnen – der Drucker stoppt (nicht am Drucker geprüft)."
Source: [Inferred] from [EZPL] p.2/p.7 ("Dooropen … motor would stop"), [Unverified → T9].
The backend's poll messages (§4.6 P1 and the slow message) carry the same instruction in
their own words.

### 3.4 Configuration blob (format 2)

```json
{
  "format": 2,
  "revision": 13,
  "host": "192.168.2.158",
  "port": 9100,
  "active_material_id": "wago-210-804",
  "baseline": {"darkness": 11},
  "row_offset_dots": -19,
  "label_calibration_staff_enabled": false,
  "materials": [
    {"id": "wago-210-804", "x_offset_mm": 1.6},
    {"id": "custom-lx9k2", "name": "Fremdetikett 38 × 23", "part_no": "", "width_mm": 23,
     "length_mm": 38, "gap_mm": 3, "x_offset_mm": 2, "darkness": null, "across_offset_mm": 0,
     "speed_ips": null, "stop_mm": null, "mark_width_mm": null, "mark_offset_mm": 0,
     "mark_inside": false, "sensor_mode": "auto", "sensor_scale": 3.4,
     "guide": "fit", "feed_path": "internal", "roller": "258-5006",
     "web": {"lanes": 1, "label_across_mm": null, "label_along_mm": null, "lane_gap_mm": 0,
             "liner_width_mm": null, "source": "catalogue"}}
  ]
}
```

- `revision`: int ≥ 0, absent → 0. Incremented by **every** config write.
- `baseline`: stores **only** keys that differ from `CODE_BASELINE`. Effective baseline =
  `CODE_BASELINE` with stored keys applied. Provenance (hint text in the UI): "Grundwerte
  vom Drucker abgelesen am 13.10.2026 (^H12 ^S2 ^E0); WAGO empfiehlt 2 Zoll/s".
- `row_offset_dots`: the `~Q` value SMPL's offsets were calibrated against (int −100…100) or
  absent/null = not pinned. SMPL never sends `~Q` in phase 1; it only compares (§4.3).
- `label_calibration_staff_enabled`: bool, absent/malformed → `false`. While false, users
  who hold `werkstatt:manage` but not `settings:manage` do not see the quick entry and
  cannot start a session (403 `staff_flow_disabled`, §6.3). Written only by PUT printer.
  The owner switches it on once T0b, T1, T2 and T5 have results in the §9 table.

### 3.5 Overrides-only storage and read-time migration

**Read** (`get_label_printer_config`):

1. Parse JSON; anything malformed → defaults (today's behaviour).
2. `format` absent ⇒ legacy v1. For each **builtin** entry, drop every key whose value
   equals `LEGACY_V1_BUILTIN_VALUES[id][key]`, a frozen copy of today's stored shape
   (`name`, `part_no`, `width_mm`, `length_mm`, `gap_mm 3.0`, `x_offset_mm 2.0`,
   `darkness None` as in `DEFAULT_MATERIALS` at `a9c335f`). What remains are overrides.
   Floats compare with `abs(a − b) < 1e-9`.
3. `format == 2` ⇒ builtin entries are overrides as stored.
4. Builtin effective profile = `replace(code_default, **valid_overrides)`; custom entries are
   full profiles with type-dependent defaults for missing new keys (§3.2 "Default (custom)").
5. **Per-field fallback**: a malformed value (unknown enum, out of range, wrong type) falls
   back to that field's default; the profile is not dropped.
   - A **custom** entry is dropped only when `id` or `width_mm` cannot be parsed (today's
     rule).
   - A **builtin** override entry (format 2 stores only overrides, so it usually has no
     `width_mm`, e.g. `{"id": "wago-210-804", "x_offset_mm": 1.6}`) is dropped only when its
     `id` is missing or not a builtin id; every key it lacks comes from the code default.
   - Missing builtins heal from code (today).
6. `web` is one field: a stored `web` must parse completely, otherwise the default `web` is used.
7. Attach `job = resolve(profile, effective_baseline)` to every profile.

The returned dict keeps today's keys (`host`, `port`, `materials`, `active_material_id`)
and adds `revision`, `baseline` (JobSettings), `baseline_overrides` (dict),
`row_offset_dots`, `label_calibration_staff_enabled`, `overrides: dict[str, frozenset[str]]`
(builtin id → overridden field names; customs → empty).

**Write** (`write_label_printer_config(db, *, host, port, materials, active_material_id,
baseline_overrides, row_offset_dots, label_calibration_staff_enabled, expected_revision)`): runs inside the CAS of §5.2,
validates (§3.8), writes `format: 2`, `revision + 1`, builtins as a diff against the
**current** code default (keys equal to the default are not stored; `web` compared as a
whole), customs as full dicts. `set_label_printer_config` stays as a thin wrapper with its
current signature for existing callers (no revision check).

Consequence: a later change to a builtin default in code reaches every install whose
admin did not override that field (test §8.1).

### 3.6 Calibration state blob

```json
{
  "calibrations": {
    "wago-210-804": {
      "material_id": "wago-210-804",
      "kind": "quick",
      "at": "2026-10-20T09:12:00Z",
      "by_id": 1,
      "by_name": "Luca Schmidt",
      "verdict": "match",
      "fresh": true,
      "freshness": "busy_seen",
      "accepted": false,
      "measured_length_dots": 1164,
      "measured_gap_dots": 30,
      "measured_pitch_dots": 1194,
      "stored_q_before": "99,3",
      "stored_q_after": "97,2",
      "sensor_kind": "see_through",
      "sensor_line": "See.:0.1 1.7 1.0 [1.6_58]",
      "firmware": "Smart Printer V5.UW0m",
      "row_offset_dots": -19,
      "poll_codes": ["60", "60", "00"],
      "fingerprint": "3f2a9c0d11b7e845",
      "pattern": null,
      "changes": {},
      "notes": ""
    }
  },
  "last_applied": {
    "material_id": "wago-210-804",
    "at": "2026-10-20T09:10:41Z",
    "by_id": 1,
    "by_name": "Luca Schmidt",
    "commands": ["^G1", "^XSET,SENSING,1", "^Q99,3", "^W44"],
    "confirmed": true
  }
}
```

- Only the session `save` endpoint writes `calibrations[id]` (one record per material,
  latest wins). Everything in it comes from the server: every measurement and printer field
  from the session's `verify` blob (§3.7, which carries the latched measurement when there
  is one), `stored_q_before` from `sense.presense`, `poll_codes` from `sense`, `by_*` from
  the token user, `changes` from `profile_at_start` vs now (`{field: {"from": …, "to": …}}`
  over `x_offset_mm`, `across_offset_mm`, `darkness`, `speed_ips`, `stop_mm`). `notes` go
  through `_clean(…, 200)` and are never sent to the printer.
- `pattern` (full only): `{lead_mm, trail_mm, left_mm, right_mm, ruler_nominal_mm,
  ruler_measured_mm}` as entered (null where empty).
- `stale` is **derived**, never stored: `record.fingerprint != profile.fingerprint`.
- `accepted` is true when the user saved a non-`match` verdict explicitly.
- `poll_codes`: the STATUS codes seen while sensing (**≤ 60 entries**, the first 60 are
  kept) — data for T2. `sensor_line` ≤ 80 chars, `firmware` ≤ 60 chars.
- `last_applied` is written by every apply. Config writes never touch this blob.
- Size: six records with 60 poll codes, a pattern and 200-char notes are ≈ 7 KB; the
  column is `Text` (§3.1). `STATE_BLOB_BUDGET = 65536` chars is asserted in a test, not
  enforced at runtime.

### 3.7 Session lock blob

Example: 210-804 was chosen, 210-812 is loaded, the run measured 812, the user switched to
812 and applied it (the T6 path):

```json
{
  "session_id": "8c1e…(uuid4 hex)",
  "mode": "quick",
  "material_id": "wago-210-812",
  "user_id": 7,
  "user_name": "Max Monteur",
  "acquired_at": "2026-10-20T09:05:00Z",
  "expires_at": "2026-10-20T09:15:00Z",
  "phase": "judged",
  "profile_at_start": {"material_id": "wago-210-812", "x_offset_mm": 2.0, "across_offset_mm": 0.0,
                       "darkness": null, "speed_ips": null, "stop_mm": null},
  "apply": {"at": "2026-10-20T09:08:30Z", "material_id": "wago-210-812",
            "commands": ["^G1", "^XSET,SENSING,1", "^Q50,3", "^W25"], "confirmed": true},
  "sense_pending": false,
  "pattern_pending": false,
  "sense": {
    "method": "command",
    "started_at": "2026-10-20T09:07:10Z",
    "status_answered": true,
    "presense": {"stored_q": "99,3", "qd": [1164, 30], "apply_confirmed": true},
    "saw_busy": true,
    "poll_codes": ["60", "60", "00"],
    "no_reply_polls": 0,
    "result": {"phase": "done", "code": "00", "code_text": "Bereit", "message": ""},
    "latched": {"at": "2026-10-20T09:07:31Z", "freshness": "busy_seen",
                "measured_length_dots": 600, "measured_gap_dots": 36,
                "measured_pitch_dots": 636, "stored_q_after": "50,3"},
    "writes_since_sense": [{"kind": "apply", "at": "2026-10-20T09:08:30Z", "q": "50,3"}]
  },
  "verify": {
    "material_id": "wago-210-812", "at": "2026-10-20T09:08:41Z",
    "verdict": "match", "freshness": "busy_seen", "fresh": true, "from_latch": true,
    "measured_length_dots": 600, "measured_gap_dots": 36, "measured_pitch_dots": 636,
    "stored_q_after": "50,3", "status_code": "00",
    "sensor_kind": "see_through", "sensor_line": "See.:0.1 1.7 1.0 [1.6_58]", "sensor_ok": true,
    "firmware": "Smart Printer V5.UW0m", "row_offset_dots": -19
  }
}
```

Field rules:

| Field | Shape | Written by |
|---|---|---|
| `profile_at_start` | `{material_id, x_offset_mm, across_offset_mm, darkness, speed_ips, stop_mm}` (stored values) | `acquire`; re-captured by `activate` when `material_id` changes |
| `apply` | `{at, material_id, commands (≤ 6), confirmed}` \| null | `apply`; reset to null by `activate` |
| `sense_pending` / `pattern_pending` | bool; set and committed before the printer I/O, cleared after it (also on failure) | `autosense` / `pattern` |
| `sense` | object below \| null | replaced as a whole by every successful `autosense` start |
| `sense.method` | `"command"` \| `"button"` | autosense |
| `sense.status_answered` | bool: STATUS answered at the start | autosense |
| `sense.presense` | `{stored_q: str \| null, qd: [len, gap] \| null, apply_confirmed: bool \| null}` \| null | autosense step 4 |
| `sense.saw_busy`, `poll_codes` (≤ 60, first kept), `no_reply_polls` | | poll |
| `sense.result` | `{phase: "done" \| "error" \| "timeout", code: str \| null, code_text: str, message: str}` \| null | poll (final result; replayed by later polls) |
| `sense.latched` | `{at, freshness, measured_length_dots, measured_gap_dots, measured_pitch_dots, stored_q_after}` \| null | the first verify of the run that finds it fresh with no write in between (§4.7); **never replaced or cleared** inside the run |
| `sense.writes_since_sense` | list (≤ 20, last kept) of `{kind: "apply" \| "pattern" \| "reprime", at, q: str \| null}`; `q` = the `^Q` value written (`"50,3"`, `"42,0"`) | `apply` and `pattern` while `sense` exists; `reprime` only when an autosense start fails after its step 4 (§4.6) |
| `verify` | `{material_id, at, verdict, freshness, fresh, from_latch, measured_length_dots, measured_gap_dots, measured_pitch_dots, stored_q_after, status_code, sensor_kind, sensor_line, sensor_ok, firmware, row_offset_dots}` (measurements null when absent) \| null | `verify`; reset to null by `activate` and by a new `autosense` |

`phase` ∈ `open → activated → applied → sensing → sensed → judged`. Transitions:
`activate` → `activated` (resets `apply` and `verify`, keeps `sense`); `apply` →
`applied` (never clears `sense`); `autosense` → `sensing`; final poll → `sensed`;
`verify` → `judged`; `pattern` and `heartbeat` leave the phase unchanged. TTL
`SESSION_TTL_S = 600`, renewed by every session call. Free lock = `{}` or an expired
session.

### 3.8 Validation (`validate_materials`, German, raises `MaterialValidationError`)

Existing rules and their existing messages stay unchanged (ids unique, builtins present,
active id known, width 4–47 "Breite muss zwischen 4 und 47 mm liegen", length 5–762, gap
0–10, darkness 0–19). The input schemas carry **types only** (§6.4), so this function is
the only place ranges are checked and every range error reaches the user in German. New,
with exact messages (`{label}` = name or id):

| Rule | Message |
|---|---|
| `id` 1–40 chars, `name` 1–60, `part_no` ≤ 40 | "{label}: Kennung 1–40, Name 1–60 und Artikelnummer bis 40 Zeichen" |
| `x_offset_mm` −5…10 | "{label}: Versatz Vorschub muss zwischen −5 und 10 mm liegen" |
| `x_offset_mm` / `across_offset_mm` inside the material's `offset_limits` (§4.9; checked after the static ranges) | "{label}: Versatz {Vorschub \| quer} muss für dieses Material zwischen {min} und {max} mm liegen – sonst läge das Druckbild außerhalb des Materials" |
| `across_offset_mm` −5…5 | "{label}: Versatz quer muss zwischen −5 und 5 mm liegen" |
| `speed_ips` None or 2–4 | "{label}: Geschwindigkeit muss zwischen 2 und 4 liegen" |
| `stop_mm` None or 0–40 | "{label}: Stopp-Position muss zwischen 0 und 40 mm liegen" |
| `sensor_mode == "none"` only on continuous | "{label}: „Kein Sensor“ geht nur bei Endlosmaterial – sonst findet der Drucker keine Etikettenspalte" |
| `sensor_mode == "auto"` not on continuous | "{label}: Endlosmaterial braucht eine feste Sensorart (Durchlicht, Reflex oder kein Sensor)" |
| `mark_width_mm` only on die-cut | "{label}: Schwarzmarken gibt es nur bei Etiketten mit fester Länge" |
| `mark_width_mm` 1–10, `mark_offset_mm` 0–50 | "{label}: Schwarzmarke: Breite 1–10 mm, Abstand 0–50 mm" |
| `sensor_scale` 0.5…5.5 (checked after rounding to one decimal) | "{label}: Sensorposition muss zwischen 0,5 und 5,5 auf der Skala liegen" |
| `web.lanes` 1–4, `lane_gap` 0–10, `liner` 3–60, `label_across` ≤ 60 | "{label}: Rollenmaße ungültig" |
| liner ≥ lanes·across + (lanes−1)·lane_gap (when liner set) | "{label}: Trägerbreite ist kleiner als die Etiketten nebeneinander" |

`sensor_scale` is rounded to one decimal (`round(v, 1)`) before it is validated and
stored, so extra decimals are never an error (3.44 → 3.4). The range covers the printed
ticks (0,6 … 5,4) plus 1 mm either side and stays inside the pointer travel (≈ 0,3 … 5,7,
§2).

Black mark with `sensor_mode == "see_through"` is **not** an error; the UI shows the hint
"Schwarzmarken werden üblicherweise mit dem Reflexsensor erkannt; ob der Durchlichtsensor
sie erkennt, ist am Drucker nicht geprüft."

The UI shows a hint (never a validation error) next to `sensor_mode == "none"`:
"Drucker erkennt dann vermutlich auch das Materialende nicht (nicht am Drucker geprüft)."

Printer-level (`PUT /printer`, `validate_printer_settings`, raises
`PrinterSettingsValidationError` → 422 `invalid_printer_settings`): baseline darkness
0–19, speed 2–4, stop 0–40 → "Grundeinstellung ungültig: Schwärzung 0–19, Geschwindigkeit
2–4, Stopp 0–40 mm"; `row_offset_dots` −100…100 → "Zeilenversatz muss zwischen −100 und
100 Punkten liegen"; `label_calibration_staff_enabled` must be a bool → "Freigabe muss ja
oder nein sein".

### 3.9 Stored vs resolved (fixes the baseline-freeze finding)

- `LabelMaterialOut.darkness / speed_ips / stop_mm` are the **stored overrides** (null =
  "Grundeinstellung").
- `LabelMaterialOut.resolved = {darkness, speed_ips, stop_mm}` are what jobs send.
- Writes never accept `resolved` (pydantic ignores unknown fields).

---

## 4. EZPL

### 4.1 Command policy (`services/werkstatt_label_ezpl_policy.py`)

Every line the calibration code sends goes through `assert_allowed(lines)`, which raises
`DisallowedPrinterCommand` (a programming error → HTTP 500, logged) unless **each** line
fully matches one of:

```
^\^G[012]$
^\^XSET,SENSING,[012]$
^\^Q\d{1,3},\d{1,2}$
^\^Q\d{1,3},\d{1,2},\d{1,2}[+-]$
^\^W\d{1,2}$
^\^H\d{1,2}$
^\^S[2-4]$
^\^E\d{1,2}$
^\^C\d{1,2}$
^\^P1$
^\^L$
^E$
^Lo,\d{1,4},\d{1,4},\d{1,4},\d{1,4}$
^AT,\d{1,4},\d{1,4},\d{1,3},\d{1,3},0,1E,0,0,[\x20-\x5D\x5F-\x7D]{1,40}$
^~S,SENSOR$
```

The `AT` text class is printable ASCII without `^` and `~`; `pattern_job` maps its text
into it (§4.11), so user input can never make `assert_allowed` fail.

Queries are not free text: `PrinterQuery` is an `Enum` with exactly `STATUS = "~S,STATUS"`
and `CONFIG = "^XGET,CONFIG"`; anything else raises `ValueError`. Queries are **reads**:
they never go through `_ship`, never pass the session busy check (§5.1) and never write a
setting. Whether they are physically harmless is [Unverified → T0b].

**Never sent** (a test asserts no builder emits a line starting with any of these):
`~V`, `~T`, `~X`, `~Z`, `^Z`, `~R`, `^R`, `~Q` (phase 1), `~S,DUMP`, `~S,FEED`,
`~S,CANCEL` (phase 1), `~S,BUFCLR`, `~S,PAUSE`, `~M`, `^M`, `^B`, `^A`, `^N`, `~EB`,
`^XSET,IMMEDIATE` (phase 1), and any `^XSET,` other than `^XSET,SENSING,`.

`^XSET,IMMEDIATE,1` is **not sent in phase 1**. The probe shows STATUS answers without it;
on the manual's reading it also enables `ERRORxx` pushes (ACTIVERESPONSE, default 1) to
every host connection, including WAGO's software, and its persistence is unknown. A silent
STATUS routes the user to the calibration button (method `button`, §4.6). T10 decides
whether phase 2 needs it as an explicit, audited step.

Normal print jobs (machine, BMK, article, box, type labels) are not calibration sends and do
not pass `assert_allowed` (they contain `~EB`, `XRB`, `Y` …); their header is pinned by the
golden tests instead (§8.1).

### 4.2 Transport

**Writes are unchanged**: `werkstatt_labels._send_tcp` stays the only write function and the
test seam; `_ship(db, payload, *, session_id: str | None = None)` gains the busy check
(§5.1, raises `LabelPrinterSessionBusy`) and the I/O lock (§5.3, raises
`LabelPrinterIoBusy`). Calibration sends go through
`werkstatt_label_transport.send_lines(db, lines, *, session_id)` = `assert_allowed(lines)` →
`payload = ("\r\n".join(lines) + "\r\n").encode("utf-8")` → `wl._ship(db, payload, session_id=…)`.

**Reads** (new, `services/werkstatt_label_transport.py`):

```python
class PrinterQuery(Enum):
    STATUS = "~S,STATUS"
    CONFIG = "^XGET,CONFIG"

@dataclass(frozen=True)
class QueryReply:
    text: str                 # latin-1 decoded, CR/LF normalised to "\n", other control chars removed
    complete: bool            # terminator seen
    errors_seen: tuple[str, ...]   # e.g. ("ERROR02",)

def query_socket(host: str, port: int, query: PrinterQuery) -> QueryReply
def query_printer(db: Session, query: PrinterQuery) -> QueryReply   # address + I/O lock + query_socket
```

`query_printer` raises `LabelPrinterNotConfigured` when no address is set, takes the I/O
lock (§5.3) but **no** session check, and never sends anything except the query line.

`query_socket` rules:

- `socket.create_connection((host, port), timeout=QUERY_CONNECT_TIMEOUT_S)` (3.0 s);
  `OSError` → `LabelPrinterUnreachable("host:port")`.
- `sendall(query.value.encode("ascii") + b"\r\n")`.
- Read with a 0.25 s socket timeout in a loop until the terminator, the deadline
  (`STATUS_DEADLINE_S = 2.0`, `CONFIG_DEADLINE_S = 4.0`) or `QUERY_MAX_BYTES = 65536`.
- Lines matching `^ERROR\d{2}$` are removed from `text` and collected in `errors_seen`
  (unsolicited pushes, ACTIVERESPONSE [EZPL] p.14).
- Terminators: STATUS — the first line matching `^\d{2},\d{5}$`; CONFIG — a line that is
  exactly `---` (three dashes; the line `--------` before it is not a terminator).
- Empty reply → `QueryReply("", False, ())`; callers report "Drucker antwortet nicht auf
  Abfragen".
- The connection is closed by us as soon as the terminator arrives (the printer may keep it
  open).

### 4.3 Status and CONFIG parsing (`services/werkstatt_label_printer_status.py`)

Pure functions, every field optional, never raising:

`parse_status(text) -> tuple[str | None, int | None]`: first line matching
`^(\d{2}),(\d{5})$` → (code, pending).

`parse_config(text, complete) -> PrinterConfig`:

| Field | Rule |
|---|---|
| `firmware` | first non-empty line |
| `speed_ips`, `darkness`, `left_margin_dots`, `row_offset_dots` | on the line containing `^S` and `~Q`: `\^S(\d+)`, `\^H(\d+)`, `\^R(\d+)`, `~Q([+-]?\d+)` |
| `width_mm`, `stored_q`, `stop_mm` | on the line that contains `^W` and does **not** start with `^QD`: `\^W(\d+(?:\.\d+)?)`, `\^Q(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?)([+-]))?`, `\^E(\d+)`; `stored_q` normalised to `"97,2"` / `"25,4,3+"` |
| `measured_length_dots`, `measured_gap_dots` | line starting `^QD`: `\^QD(\d+),(\d+)` (both 0 → treated as absent) |
| `measured_pitch_dots` | `Label\+Gap\s*=\s*(\d+)\s*Dots`, else length + gap |
| `sensor_kind`, `sensor_line` | line starting `See` → `see_through`; line containing `Reflect` → `reflective`; else `unknown`. The raw line (≤ 80 chars) is kept; its numbers are undocumented and shown raw. |
| `print_mode` | `\^A([TD])` → `thermal_transfer` / `direct_thermal` |
| `resolution_dpi` | `resolution\s*=\s*(\d+)\s*Dpi` |
| `complete` | from `QueryReply.complete` |

The probe reply (Appendix A) is the golden fixture.

**Status codes** (`STATUS_TEXT_DE`, `STATUS_ACTION_DE`):

| Code | `code_text` | `action_text` |
|---|---|---|
| 00 | "Bereit" | "" |
| 01 | "Kein Material erkannt" | "Material, Sensorposition und Führungen prüfen" |
| 02 | "Papierstau oder Spalt nicht gefunden" | "Material, Sensorposition und Führungen prüfen" |
| 03 | "Farbband leer" | "Farbband einlegen" |
| 04 | "Druckkopf offen" | "Deckel schließen" |
| 05 | "Aufwickler voll" | "Aufwickler leeren" |
| 06 | "Speicher voll" | "Drucker neu starten oder WAGO-Software prüfen" |
| 07 | "Datei nicht gefunden" | "" |
| 08 | "Name doppelt" | "" |
| 09 | "Befehlsfehler" | "" |
| 10 | "Messer blockiert" | "Messer prüfen" |
| 11 | "Externer Speicher nicht gefunden" | "" |
| 20 | "Pause" | "Pause am Drucker beenden" |
| 21 | "Einstellmodus am Drucker" | "Menü am Drucker verlassen" |
| 22 | "Tastaturmodus am Drucker" | "Menü am Drucker verlassen" |
| 50 | "Druckt" | "Bitte warten" |
| 60 | "Verarbeitet Daten" | "Bitte warten" |
| other | "Unbekannter Status {aa}" | "" |
| no reply | "Drucker antwortet nicht auf Abfragen" | "" |

`read_status(db, *, full: bool) -> PrinterStatus`: STATUS, and when `full`, CONFIG — both
through `query_printer`. **Read-only**: it never sends a setting (no IMMEDIATE, no retry
write), so it needs no session id and cannot be refused by anyone's session. A silent
STATUS gives `answered: false`, `code: None`, `code_text` "Drucker antwortet nicht auf
Abfragen". GET /status, apply, autosense and verify all use it. Warnings (`code`, German
`message`):

| code | when | message |
|---|---|---|
| `row_offset_drift` | pinned `row_offset_dots` set and live `~Q` differs | "Zeilenversatz am Drucker ({live} Punkte) weicht vom Bezugswert ({pinned}) ab – ein anderes Programm hat ihn geändert. SMPL-Drucke können in Vorschubrichtung verschoben sein." |
| `direct_thermal` | `^AD` | "Drucker steht auf Thermodirekt – WAGO-Material braucht Thermotransfer mit Farbband." |
| `sensor_mismatch` | active profile expects `see_through`/`reflective` and the sensor line says the other | "Drucker nutzt den {Reflex \| Durchlicht}-Sensor, „{name}“ erwartet {Durchlicht \| Reflex}." |
| `incomplete_reply` | CONFIG not complete | "Antwort des Druckers unvollständig – einzelne Werte können fehlen." |
| `resolution_unexpected` | resolution ≠ 300 | "Drucker meldet {dpi} dpi – SMPL rechnet mit 300 dpi." |
| `error_pushed` | `errors_seen` non-empty | "Drucker meldete {ERRORnn}." |

There is deliberately **no** "stored `^W` differs" warning (critique L3).

### 4.4 Setup commands (`werkstatt_label_calibration.setup_commands(profile) -> list[str]`)

Sensor lines. **Every** apply sends an explicit `^XSET,SENSING,n`, die-cut included, so a
"Kein Sensor" apply (`SENSING,2`) never lingers into the next material: CONFIG cannot
show `SENSING`, so nothing else would ever reveal or reset it. The manual scopes `SENSING`
to continuous labels, so on die-cut stock it is expected to be ignored ([Inferred],
[Unverified → T1/T17]).

| media_type | sensor_mode | lines |
|---|---|---|
| gap / mark | see_through | `^G1`, `^XSET,SENSING,1` |
| gap / mark | reflective | `^G0`, `^XSET,SENSING,0` |
| gap / mark | auto | `^G2`, `^XSET,SENSING,1` |
| continuous | see_through | `^G1`, `^XSET,SENSING,1` |
| continuous | reflective | `^G0`, `^XSET,SENSING,0` |
| continuous | none | `^XSET,SENSING,2` |

(`gap`+`none` and `continuous`+`auto` cannot exist, §3.8.)

Then exactly one `^Q` and one `^W`, using today's `_mm()` rounding:

- gap: `^Q{_mm(length)},{_mm(gap)}`
- mark: `^Q{_mm(length)},{_mm(mark_width)},{_mm(mark_offset)}{'-' if mark_inside else '+'}`
- continuous: `^Q15,0` (`_MIN_CONTINUOUS_MM`)
- `^W{_mm(width)}`

Exact outputs (pinned by tests):

| Profile | Lines |
|---|---|
| wago-210-804 / -824 | `^G1`, `^XSET,SENSING,1`, `^Q99,3`, `^W44` |
| wago-210-812 | `^G1`, `^XSET,SENSING,1`, `^Q50,3`, `^W25` |
| wago-210-805 | `^G1`, `^XSET,SENSING,1`, `^Q15,3`, `^W6` |
| wago-211-501 | `^G1`, `^XSET,SENSING,1`, `^Q15,0`, `^W5` |
| wago-2009-110 | `^G1`, `^XSET,SENSING,1`, `^Q15,0`, `^W11` |
| 211-501 with sensor "none" | `^XSET,SENSING,2`, `^Q15,0`, `^W5` |
| custom die-cut 38 × 23 (length 38, width 23), sensor auto | `^G2`, `^XSET,SENSING,1`, `^Q38,3`, `^W23` |
| custom mark, length 25, width 40, mark 4, offset 3, outside, reflective | `^G0`, `^XSET,SENSING,0`, `^Q25,4,3+`, `^W40` |
| same, inside | `^G0`, `^XSET,SENSING,0`, `^Q25,4,3-`, `^W40` |

**Never** in setup: `^E` (can feed, [EZPL] p.4), `^H`, `^S`, `^C`, `^P` (every job states
them), `^L`/`E` (setup between them is ignored), `~Q`, `^R`, `^XSET,IMMEDIATE`.

`reprime_lines(profile) -> list[str]` = the `^Q` and `^W` lines of `setup_commands` only
(e.g. `["^Q99,3", "^W44"]`); autosense sends them right before its pre-sense snapshot
(§4.6 step 4).

### 4.5 Apply (no paper movement per the manual) — `apply_material(db, session)`

1. Session checks (§5.1): phase ≥ `activated` and ≠ `sensing` (else 409 `step_order`;
   in `sensing`: "Einmessen läuft noch – bitte warten, bis es abgeschlossen ist"),
   `session.material_id == active_material_id` (else 409 `step_order` "Gewähltes Material
   wurde geändert – bitte Material erneut wählen").
2. STATUS: code `50`/`60` → 409 `printer_not_ready` (the one §6.3 template). Any other
   code or no reply → continue.
3. `send_lines(setup_commands(profile), session_id)` — one connection, one payload.
4. Sleep `APPLY_SETTLE_S = 0.3`, read CONFIG. `confirmed`:
   - `None` when CONFIG gave no reply;
   - `True` when stored `^W` == profile `^W` **and** stored `^Q` == profile `^Q` **and**
     (profile expects `see_through`/`reflective` ⇒ sensor kind matches);
   - else `False`, with German `mismatches`, e.g. "Breite: Drucker 34 mm, Profil 44 mm",
     "Etikett/Spalt: Drucker 97,2, Profil 99,3", "Sensor: Drucker Reflex, Profil Durchlicht".
   A mismatch is a warning, not an error: the sensor-line switch on `^G0` is
   [Unverified → T1].
5. Write `session.apply`, `session.phase = "applied"`, `state.last_applied`; when
   `session.sense` exists, append `{kind: "apply", at, q}` to `sense.writes_since_sense`
   (q = the `^Q` value just sent, e.g. `"50,3"`). Apply **never** clears `sense` or its
   latched measurement. Audit.

### 4.6 Auto-calibrate (feeds media) — `start_autosense`, `poll_sensing`

**Start** (`POST …/autosense {confirm_feed: true, method}`):

1. `confirm_feed` must be `true` → else 422 `confirm_feed_required`.
2. Session phase ∈ {`applied`, `sensed`, `judged`} and `session.apply.material_id ==
   session.material_id` → else 409 `step_order` "Zuerst Einstellungen übertragen".
   `sense_pending` or `pattern_pending` true → 409 `step_order` "Einmessen wird bereits
   gestartet". Set `sense_pending = true`, commit (no DB lock is held during I/O, §5.4).
3. STATUS (read-only, §4.3) — **depends on the method**:
   - `command`: no reply → 409 `no_status_reply` (§6.3; the UI offers the button method).
     Code ≠ `00` → 409 `printer_not_ready` with `code`, `code_text`, `action_text`.
   - `button`: no reply → proceed with `status_answered = false`. A reply with code ≠ `00`
     (e.g. `04`, `50`, `60`) → 409 `printer_not_ready`, exactly as for `command`.
4. **Re-prime and pre-sense snapshot**: `send_lines(reprime_lines(profile), session_id)`
   (`^Q`/`^W` of the session's material, no paper, §4.4), so that a `^Q` rewritten by an
   unnoticed lid-close auto-sense ([Unverified → T3]) cannot spoil `q_changed`. Then CONFIG →
   `presense = {stored_q, qd: [len, gap] | null, apply_confirmed}`. If `stored_q` ≠ the
   profile's `^Q`, re-read up to `APPLY_CONFIRM_RETRIES = 2` times, 0.5 s apart; proceed
   regardless and record `apply_confirmed`. No CONFIG reply → `presense = null` (freshness
   can then only come from a busy status). This runs for both methods.
5. `method == "command"`: send `~S,SENSOR` as the **entire** payload of its own connection
   (`send_lines(["~S,SENSOR"])`). `method == "button"`: send nothing; the user presses the
   calibration button on the back.
6. `session.sense = {method, started_at, status_answered, presense, saw_busy: false,
   poll_codes: [], no_reply_polls: 0, result: null, latched: null, writes_since_sense: []}`
   (replacing any earlier run, §3.7), `verify = null`, `phase = "sensing"`,
   `sense_pending = false`; audit. On any failure in 3–5: `sense_pending = false`, phase and
   the earlier `sense` unchanged — except that when the re-prime of step 4 was already
   sent, `{kind: "reprime", at, q}` is appended to the earlier run's `writes_since_sense`
   (it did write `^Q`).

`AutosenseOut.status_answered` tells the client whether polling is useful (§7.4).

**Poll** (`POST …/poll`, client every 1.5 s). Allowed in phases `sensing` and `sensed`
(else 409 `step_order` "Kein Einmessen aktiv"). In `sensed` it replays `sense.result`
(phase, code, code_text, message) without querying the printer. In `sensing` it reads
STATUS once, appends the code (if any) to `poll_codes`, and applies the **first matching
row** of this ordered table:

| # | Observation | Result `phase` | `message` (German, exact) |
|---|---|---|---|
| P1 | elapsed > `AUTOSENSE_TIMEOUT_S` (45, command) / `BUTTON_SENSE_TIMEOUT_S` (120, button) | `timeout` | "Einmessen dauert ungewöhnlich lange – bitte am Drucker nachsehen. Läuft noch Material durch: Deckel öffnen." |
| P2 | no reply, method `command` | `sensing`, `no_reply_polls += 1`; at 3 → `error` | at 3: "Drucker antwortet nicht – Ergebnis abfragen" |
| P3 | no reply, method `button` | `sensing` (never an error) | "Drucker meldet keinen Status – wenn er stillsteht, „Ergebnis abfragen“ drücken." |
| P4 | code `50`/`60` | `sensing`; `saw_busy = true` | "" |
| P5 | code `00`, `saw_busy` true | `done` | "" |
| P6 | code `00`, not `saw_busy`, method `command`, elapsed ≥ `AUTOSENSE_MIN_WAIT_S` (6.0) | `done` | "" |
| P7 | code `00`, not `saw_busy`, method `command`, elapsed < 6.0 | `sensing` | "" |
| P8 | code `00`, not `saw_busy`, method `button` | `sensing` | "Wenn der Drucker stillsteht: „Ergebnis abfragen“ drücken." |
| P9 | a code of the §4.3 table other than `00`/`50`/`60` (01–11, 20–22) | `error` | "" (`code_text` carries the text) |
| P10 | any other code (e.g. `99`) | `error` | "Unbekannter Status {aa}" |

A result `sensing` with elapsed ≥ `AUTOSENSE_SLOW_S` (15) and an empty message gets the
message "Dauert länger als erwartet – läuft Material durch, Deckel öffnen (der Drucker
stoppt dann vermutlich)." `done`/`error`/`timeout` store `sense.result = {phase, code,
code_text, message}` and set `phase = "sensed"`. SMPL has **no command** that stops a
running auto-sense in phase 1 (`~S,CANCEL`, `~S,BUFCLR`, `~S,PAUSE` are never sent); the
physical stop is the lid ([Inferred], [Unverified → T9]), which the UI shows from the start
(§7.4, §7.7).

**Freshness proof** (computed by verify from a fresh CONFIG read):

```
q_changed  = presense.stored_q is not None and q_after is not None
             and q_after != presense.stored_q
             and consistent(q_after, qd_after)
             # consistent: |q_len − qd_len/12| < 1.0 and |q_gap − qd_gap/12| < 1.0
qd_changed = presense.qd is not None and qd_after is not None and qd_after != presense.qd
freshness  = "busy_seen"  if sense.saw_busy
        else "q_changed"  if q_changed
        else "qd_changed" if qd_changed
        else "none"
fresh = freshness != "none"
```

**The measurement is latched, never replaced.** The first verify of a run that (a) passes
R1/R2 of §4.7, (b) finds `fresh`, and (c) sees an empty `sense.writes_since_sense` stores
`sense.latched = {at, freshness, measured_length_dots, measured_gap_dots,
measured_pitch_dots, stored_q_after}` from that read. From then on, every verify of the run
judges the **latched** values against the session's current material, reports
`latched.freshness`, and uses the new CONFIG read only for the status, sensor line,
firmware, `~Q` and warnings. Nothing inside the run clears or overwrites the latch: not
apply, reapply, pattern, activate or a later read with a different `^QD`. Only a new
autosense starts a new run.

Why: nobody has tested whether a `^Q` write (apply, pattern, job) rewrites the `^QD` line
([Unverified → T1]); `ezpl.md` only infers that `^QD` is the last auto-sense result. If it
echoes, the apply for a switched-to material (`^Q50,3`) would show exactly `^QD600,36`, and
a "replace on change" rule would turn that echo into a perfect `match` on the wrong stock.

Whether STATUS reports 50/60 while sensing and whether `^Q` is rewritten by the sense is
[Unverified → T2].

### 4.7 Verify — `verify_material(db, session)` and pure `judge(...)`

`POST …/verify` requires a sensing run in this session (`session.sense` set) → else 409
`step_order` "Zuerst einmessen"; and an apply for the session's current material
(`session.apply.material_id == session.material_id`) → else 409 `step_order` "Zuerst
Einstellungen übertragen" (after a material switch the new material must be applied
first). It reads STATUS and CONFIG (read-only), stores the result as the `verify` blob
(§3.7, for the session's current material) and sets `phase = "judged"`. Rules, **in this
order** (first hit wins); "measurement" means `sense.latched` when it exists, else the
values of this CONFIG read:

| # | Condition | `verdict` |
|---|---|---|
| R1 | STATUS replied with a code ≠ `00` | `printer_error` |
| R2 | no latch, and CONFIG missing, or no `^QD` line, or `^QD0,0` | `no_result` |
| R3 | no latch, and `sense.writes_since_sense` is non-empty | `unchecked` (detail W1 or W2 below; `freshness` reported as `none`) |
| R4 | no latch, and `freshness == "none"` | `unchecked` |
| — | no latch so far: **latch this read now** (§4.6), then continue | |
| R5 | profile continuous: latched freshness `q_changed` or `qd_changed` → gap dots == 0 ⇒ `match`, gap dots > 0 ⇒ `gap_on_continuous`; only `busy_seen` ⇒ `unchecked` | as stated |
| R6 | profile die-cut: gap dots == 0 | `no_gap` |
| R7 | profile die-cut: \|Δlength\| ≤ tol **and** \|Δpitch\| ≤ tol | `match` |
| R8 | another die-cut profile passes R7 | `other_material` |
| R9 | otherwise | `mismatch` |

`VerdictOut.freshness` is `latched.freshness` whenever a latch exists (also after reapply,
pattern or a material switch), else the freshness computed from this read (`none` for R3).
`VerdictOut.from_latch` is true when the verdict judged a latch made by an **earlier**
verify.

R3 details (exact):

- **W1** (echo): `^QD` of this read equals the last write's `^Q` × 12 exactly (e.g. write
  `"50,3"` and `^QD600,36`): "Messwert entspricht nur der übertragenen Einstellung –
  bitte erneut einmessen."
- **W2** (otherwise): "Seit dem Einmessen wurden Einstellungen übertragen oder ein
  Messmuster gedruckt – das Messergebnis ist nicht mehr eindeutig. Bitte erneut einmessen."

Definitions:

- `dpm = 12` (phase 1 always; H1 is phase 2).
- Expected length = `physical_length_mm` (= `web.label_along_mm ?? length_mm`); expected
  gap = `mark_width_mm` for mark stock, else `gap_mm`; expected pitch = length + gap; all ×
  dpm for dots.
- `tol = max(1.5 mm, 3 % of expected pitch)`. The 3 % absorbs H1's 1.6 % until T4.
- Δ = measured − expected. Measured pitch = `Label+Gap` dots if present, else length + gap.
- R8 candidates: every other die-cut profile, compared with its own physical geometry;
  `suggested_material_ids` sorted by \|Δpitch\|. Also filled for `gap_on_continuous`.
- **Sensor check** (independent of the verdict, always from this read's sensor line):
  expected kind for `see_through` / `reflective`, none for `auto`/`none`;
  `sensor_ok = None | True | False`. False adds the `sensor_mismatch` warning and the offer
  `reapply` (a no-paper apply) — `~S,SENSOR` may replace the sensor SMPL set
  [Unverified → T2]. The `reapply` re-sends `^Q`, which overwrites the `^Q` the printer
  rewrote while sensing; the latch keeps the verdict (`match`, `busy_seen`) unchanged.

`title` and `detail` (German, server-built, shown verbatim; numbers with decimal comma, one
decimal, U+2212 for minus):

| verdict | title | detail |
|---|---|---|
| match (die-cut) | "Passt zu „{name}“" | "Gemessen {len} + {gap} mm (Teilung {pitch} mm), Abweichung {Δpitch} mm bei ± {tol} mm Toleranz." |
| match (continuous) | "Passt zu „{name}“" | "Endlosmaterial erkannt." |
| mismatch | "Messung passt nicht zum Profil" | "Gemessen {len} + {gap} mm (Teilung {pitch} mm), Profil erwartet {elen} + {egap} mm ({epitch} mm). Eingelegtes Material und Sensorposition prüfen." |
| other_material | "Anderes Material gemessen" | "Gemessen {pitch} mm Teilung – passt zu „{other name}“ ({part_no}). Ist ein anderes Material eingelegt?" |
| no_gap | "Keine Etikettenspalte erkannt" | "Der Sensor sieht keine Spalte. Zeiger auf {3,4} der Skala stellen und erneut einmessen." ({3,4} = the session material's `sensor_scale` via `format_scale_de`, §3.2; 3.0 → "3") |
| gap_on_continuous | "Spalten gemessen" | "Der Drucker hat Etiketten gemessen ({len} + {gap} mm). Ist wirklich Endlosmaterial eingelegt?" |
| no_result | "Kein Messergebnis" | "Der Drucker meldet kein Messergebnis. Ergebnis am Probedruck prüfen." |
| unchecked | "Ergebnis nicht prüfbar" | "Kein Nachweis, dass gerade neu gemessen wurde – angezeigt werden möglicherweise Werte einer früheren Messung." (continuous busy-only: "Der Drucker hat gemessen, für Endlosmaterial aber kein neues Messergebnis gemeldet.") |
| printer_error | "Drucker meldet: {code_text}" | "{action_text}" ; for 01/02 on continuous stock append " Bei durchsichtigem Material hilft eventuell die Sensorart „Kein Sensor“ im Profil." |

Extra detail lines (appended as separate `notes[]` entries):

- 210-804 or 210-824 involved: "210-804 und 210-824 sind gleich groß – die Messung unterscheidet sie nicht."
- 210-805: "Maße der Rolle 210-805 sind geschätzt (zweibahnig ≈ 15 × 6 mm). SMPL druckt 210-805 in diesem Stand weiter einbahnig."
- `web.source == "estimate"` (other materials): "Erwartete Maße sind geschätzt."
- `from_latch`: "Bewertet wird die Messung vom Einmessen um {HH:MM} – spätere Übertragungen ändern sie nicht." ({HH:MM} = `latched.at` in `settings.app_timezone`)

`offers` per verdict (the UI renders exactly these buttons, §7.5):

| verdict | offers |
|---|---|
| match | `save` (+ `reapply` if `sensor_ok` false) |
| mismatch | `resense`, `accept_anyway` |
| other_material | `switch_material`, `resense` |
| no_gap | `resense` |
| gap_on_continuous | `switch_material` (if suggestions), `resense` |
| no_result | `requery`, `accept_anyway` |
| unchecked (R3) | `resense`, `accept_anyway` |
| unchecked (R4, R5) | `requery`, `resense`, `accept_anyway` |
| printer_error | `requery`, `resense` |

**Worked examples** (unit tests on `judge`):

- Probe data, 210-804, fresh: expected 1188 / 36 / 1224 dots; measured 1164 / 30 / 1194;
  Δlength −2,0 mm, Δpitch −2,5 mm, tol 3,06 mm → `match`.
- Same data, nothing changed since the snapshot, no busy → `unchecked` (the critique's
  stale-match scenario).
- `^QD600,36` with 210-804 active, fresh → pitch 636 dots = 53 mm → `other_material`,
  suggestions `["wago-210-812"]`.
- 210-805 builtin: expected pitch (6 + 3) mm = 108 dots, tol 1,5 mm (18 dots).
- Switch path: latch `610/30` (busy_seen) from a run with 210-804 chosen → `other_material`
  [`wago-210-812`]; activate 812, apply (`^Q50,3`; the read afterwards shows `^QD600,36`)
  → verify judges **610/30** against 812 → `match`, `freshness busy_seen`, `from_latch`
  true; the response's measured values are 610/30, not 600/36.
- Write before latch: sense on 804, then activate 812 and apply (`^Q50,3`) before any
  verify; the read shows `^QD600,36` = `^Q50,3` × 12 → R3 `unchecked` with W1 (busy seen
  or not).

**Switch material** (`other_material`, `gap_on_continuous` with suggestions):
`POST …/activate {material_id}` sets the session and active material (phase `activated`,
`apply` and `verify` reset, `sense` and its latch kept) → UI returns to the sensor guide for
the new material → apply (no paper) → verify **without** re-sensing, which judges the
latched measurement against the new material. The verdict does not depend on what a `^Q`
write does to `^QD`; whether it changes `^QD` at all (the printer's own readback after the
switch) is [Unverified → T1].

### 4.8 Per-job header (owner decision 2)

`werkstatt_labels._sheet` delegates to `werkstatt_label_jobs.job_header(profile, *,
length_mm, copies)`; the output order is fixed:

```
^Q…          gap ^Q{L},{G} | mark ^Q{L},{M},{Z}± (new) | continuous ^Q{max(len,15)},0 (unchanged)
^W{W}
^H{job.darkness}      always
^S{job.speed_ips}     always
^E{job.stop_mm}       always (switchable, see below)
^C{copies}            always; ^C1 for a single label
^P1                   always (switchable, see below)
^L
…element lines…
E
^C1                   only when copies > 1: standalone reset after the job
```

- `JOB_HEADER_SENDS_STOP = True` (module constant in `werkstatt_label_jobs.py`): if T5
  shows that `^E` in a job header adds a feed, flipping it removes `^E` from headers. No
  other code depends on it.
- `JOB_HEADER_SENDS_P1 = True` (same module): `^P1` right after `^C`. `^C` and `^P`
  multiply ([EZPL] p.2: "^C2 ^P3 … 6 pieces") and the manual states no persistence for
  `^P`, so a `^P` left by another client could multiply every SMPL print; CONFIG would not
  show it. Owner decision 2 names only `^H ^S ^E ^C`; extending it to `^P1` is pending
  owner confirmation (§11 D1) — flipping the constant removes the line and nothing else.
- **Trailing reset** (`job_footer(copies) -> list[str]`, used by `_sheet`): a job with
  copies > 1 ends `…, "E", "^C1"`. `^C` is "Permanent" ([EZPL] p.2); without the reset a
  WAGO smartScript/GoDoctor job that states no `^C` would print SMPL's copy count, and
  nobody could tell SMPL caused it. Setup outside `^L … E` sets a value without printing
  ([Inferred] from [EZPL] p.75, [Unverified → T5], which also checks that the reset does not
  shorten the copies job). Single-label jobs end at `E` as today. Multi-job payloads
  (klein sheets) have copies 1 and therefore no reset.
- Carry-over the other way: the resolved `^H`, `^S`, `^E` (for example a tube darkness
  override) also stay stored after an SMPL job, so another client that states none of them
  prints with SMPL's last values. SMPL does not reset them (it does not know the other
  client's intent); §11 states it.
- Not in jobs: `^G`, `^XSET,SENSING`, `~Q`, `^R` (T15/T11).
- `_mm()` rounding is unchanged (critique L2).
- `material_by_id` jobs (BMK strips on 2009-110) use that profile's resolved values.

**Byte changes accepted explicitly** (and nothing else):

1. Every job header gains `^H ^S ^E ^C ^P1` as above (`^H` was only sent for a darkness
   override; `^C` only for copies > 1). Example: the 210-804 machine label header becomes
   `^Q99,3`, `^W44`, `^H12`, `^S2`, `^E0`, `^C1`, `^P1`, `^L`.
2. Jobs with copies > 1 (admin freetext, type label) gain a final `^C1` line after `E`.
3. `_clean` turns `~` and `^` into spaces (§4.10).
4. `Lo` lines that would leave the media are clamped (§4.9) — no golden job has one at its
   default offsets (checked against the `a9c335f` renderers on 2026-10-13).

Element lines (between `^L` and `E`) stay byte-identical when `across_offset_mm == 0`; a
golden fixture captured at `a9c335f` pins this (§8.1).

### 4.9 Coordinates: across offset and the bounds guard

- `_Frame` gains `across_px: int = 0` (`round(across_offset_mm × 12)`), and
  `xm(reading_y) = h_px − reading_y + across_px`. `ym` is unchanged. Positive
  `across_offset_mm` raises machine x, i.e. moves the print toward the reading-top edge,
  which the pattern labels "L".
- `werkstatt_label_jobs.fit_to_media(profile, lines, *, form_length_dots) -> list[str]`
  runs inside `_sheet` on every job (the element lines between `^L` and `E`). Bounds:
  machine x within **[0, h_px]** (the `^W` region, `h_px = _mm(width)·12`, not the 564-dot
  head); machine y ≥ 0, and for die-cut stock y ≤ `form_length_dots = _mm(length)·12`
  (continuous: no upper y bound, strips compute their own length). Per element:
  - `Lo,x1,y1,x2,y2` (x1 ≤ x2, y1 ≤ y2 as all renderers emit them): **clamped** —
    x to [0, h_px], y to [0, form length]; a line whose clamped extent is empty
    (x1 ≥ x2 or y1 ≥ y2) is dropped. Clamping keeps rules, cut marks and pattern boxes on
    the material instead of printing ribbon onto the bare platen roller.
  - `AT,x,y,size,…`: the em box **[x − size, x]** must lie within [0, h_px] and y within
    the y bounds — else raise.
  - `XRB…` and `Y…`: the anchor (first two numbers) must lie within the bounds — else
    raise (their extent is not checked in phase 1).
  Violations raise `LabelLayoutOutOfBounds(LabelFormatUnsupported)` (from
  `werkstatt_label_errors`, §5.0) with "Druckbild läge außerhalb des Materials – Versatz im
  Material-Profil prüfen". At the default offsets no golden job is clamped or raises (test;
  checked against the `a9c335f` renderers on 2026-10-13).
- `DRY_RENDER_SAMPLES` (in `werkstatt_label_jobs.py`): every renderer that can run on the
  material, with fixed sample content:
  - voll tier: machine label (`LabelContent("M-0042", "Makita Akkuschrauber DDF485",
    "Makita", "SN123456")`), klein quad with four of them, article label
    (`ArticleLabelContent("SMPL-81JHYT", "WAGO 2016-7607 - TOPJOB S 2L-PE", "WAGO",
    "SP-0187", "4045454545454")`), box label (`BoxLabelContent("KISTE-BK-2026-0001",
    "BK-2026-0001", "Kiste Wallbox")`), type label (`TypeLabelContent("Familie Schulze",
    "381", "09.2026", "VT-0001")`);
  - kompakt tier: `_render_kompakt` with the machine-label content;
  - mini tier and every continuous material: `_render_mini` with "M-0042", "F1.1" and
    "Herd Küche 16A";
  - `wago-2009-110` additionally: rail strip `[("F1", 17.5), ("F2", 35)]` size 36 and the
    block label ("PV Wechselrichter", "X1", cells N L1 L2 L3 PE at 5 mm);
  - the measuring pattern when `pattern_supported` (§4.11).
- `offset_limits(profile) -> OffsetLimits(x_min, x_max, across_min, across_max)` (mm,
  rounded inward to 0.1): render every sample with `across 0` and `x_offset 0`; collect
  the raising elements' x extents (AT em box, XRB/Y anchor) and y anchors; then
  `across_min = −min_x/12`, `across_max = (h_px − max_x)/12`, `x_min = −min_y/12`,
  `x_max = (form_length − max_y)/12` for die-cut, `10` for continuous; intersect with the
  static ranges (x −5…10, across −5…5). `Lo` lines do not limit (they are clamped). Coordinates
  shift linearly with both offsets, so the limits are exact for the samples. Other content
  (another text length or font size) can still hit the guard at print time; the route then
  answers with the German text. Because the samples render at offsets 0, the result
  depends only on the geometry: cache it (`functools.lru_cache`) keyed on `(id, tier,
  width_mm, length_mm, gap_mm, mark_width_mm, pattern_supported)`, so building
  `LabelMaterialOut` for GET overview/settings does not re-render type labels with QR codes
  on every request.
- Every profile write (PUT material, PATCH list) runs `dry_render_checks(profile)` =
  "offsets inside `offset_limits`"; outside → `MaterialValidationError` with the §3.8
  message naming the limits (422 `invalid_material` on PUT, 400 string on PATCH, §6.3).
  `LabelMaterialOut.offset_limits` exposes the same numbers so the wizard can clamp or warn
  before it PUTs (§7.6).
- Orientation (computed at `a9c335f` with these samples; the code computes them, tests do
  not pin these values):

  | Material | across (mm) | x_offset (mm) | Limiting sample |
  |---|---|---|---|
  | 210-804 / -824 | −2,6 … +1,0 | −2,0 … 10,0 | voll (−), klein quad (+), quad (x) |
  | 210-812 | −4,0 … +1,2 | −2,0 … 10,0 | kompakt |
  | 210-805 | −0,5 … +0,5 | −1,0 … 10,0 | mini "F1.1" |
  | 211-501 | −0,7 … +0,6 | −2,0 … 10,0 | mini |
  | 2009-110 | −0,5 … +0,2 | −2,0 … 10,0 | block label (its top row sits 3 dots from the strip edge) |

  The static −5…5 across range of §3.8 is therefore never the binding limit on the
  builtins; no separate "±width/4" rule is needed.
- Routes that print must map `LabelFormatUnsupported` (and therefore the guard): add the
  missing `except` to `workflow_schaltplan.py` (BMK labels, ~line 549 → 400) and to the
  admin test/freetext routes (`ok:false`).

### 4.10 Text sanitising

`werkstatt_labels._clean` replaces every character `< 0x20`, `0x7F`, `~` and `^` with a
space, then collapses whitespace and truncates (today minus nothing, plus `~`/`^`). Whether
EZPL executes `~` inside text data is [Unverified → T16]; stripping stays regardless. The
pattern text is `"SMPL KAL " + _pattern_ascii(_clean(part_no, 20))`, where
`_pattern_ascii` replaces every character outside the `AT` allow-list class
`[\x20-\x5D\x5F-\x7D]` (non-ASCII such as "ä", "×", "Ø", "®") with `?`, so a custom
`part_no` can never make `assert_allowed` fail (that would be a 500). Example:
`"Brady® Ø3"` → `"SMPL KAL Brady? ?3"`. Calibration notes are never sent.

### 4.11 Measuring pattern (`services/werkstatt_label_patterns.py`)

`pattern_job(profile) -> tuple[list[str], PatternGeometry]`, built through `_frame`/`_at`
and `_sheet` (so it carries the job header with `^C1 ^P1` and the profile's current
offsets — the operator measures the **remaining** error). Line weight `t = 3` dots.

`pattern_supported(profile) -> bool` is false when `web.lanes > 1`, or `web.label_across_mm`
is set and differs from `width_mm`, or `web.label_along_mm` is set and differs from
`length_mm` (die-cut) — i.e. whenever the physical roll is not the print geometry. The
built-in 210-805 (two lanes ≈ 15 × 6 mm, printed one-lane 6 × 15) is therefore
unsupported: a 6 × 15 box would cross the real gaps and the centre slit, waste material,
and give meaningless A/B/L/R readings; offering an `x_offset` correction from it would
change 805's printing, which the owner excluded from this build. `pattern_job` raises
`PatternUnsupported` (→ 422 `pattern_unsupported`, §6.3) for such profiles.

**Die-cut** (h = `_mm(width)·12`, w = `_mm(length)·12`, inset `i = 24` dots (2 mm) when
`min(W, L) ≥ 12`, else 12 (1 mm)):

| Element | Reading-frame placement (dots) | Condition |
|---|---|---|
| Leading line (edge "A", leaves the printer first) | x [i, i+t], y [i, h−i] | always |
| Trailing line ("B") | x [w−i−t, w−i], y [i, h−i] | always |
| Top line (edge "L") | y [i, i+t], x [i, w−i] | always |
| Bottom line ("R") | y [h−i−t, h−i], x [i, w−i] | always |
| Centre cross | feed arm x [w/2−a, w/2+a], y [h/2−1, h/2+1]; across arm x [w/2−1, w/2+1], y [h/2−a, h/2+a]; a = min(36, h/4, w/4) | always |
| Letter "A" | `_at` size 36 at (i+t+12, h/2+48) | min(W, L) ≥ 20 |
| Letter "L" | `_at` size 36 at (w/2+48, i+t+12) | min(W, L) ≥ 20 |
| Text "SMPL KAL {part}" | `_at` size 24 at (i+t+12, i+t+12) | W ≥ 25 and L ≥ 50 |
| Ruler | baseline y_r = h−i−t−12; tick k mm at x [12k−1, 12k+1], height 12 (minor) / 24 (k % 5 == 0) / 36 (k % 10 == 0) upward from y_r; numbers "10", "20" … size 24 centred over the 10-mm ticks at y_r−66 | L ≥ 50; k = 10 … `ruler_to` = 10·⌊(L−9)/10⌋ (90 on 210-804, 40 on 210-812) |

Worked example 210-804 (`x_offset 2.0` → 24, `across 0`, h 528, w 1188, i 24) — the first
lines are pinned exactly:

```
^Q99,3
^W44
^H12
^S2
^E0
^C1
^P1
^L
Lo,24,48,504,51
Lo,24,1185,504,1188
Lo,501,48,504,1188
Lo,24,48,27,1188
Lo,263,582,265,654
Lo,228,617,300,619
…letters, text, ruler…
E
```

**Continuous** (pattern length `P` = 40 mm, 30 mm for `wago-211-501`; h = W·12,
pw = P·12):

- side lines (2 dots) at y [12, 14] and [h−14, h−12], x [36, pw−36];
- start/end bars (4 dots) at x [34, 38] and [pw−38, pw−34], y [12, h−12];
- ticks every 5 mm from 5 to P−5 mm: 2 dots wide, height min(24, h/3) from y = 14 inward;
- letter "L" size min(36, h−40) at (pw/2, 18) only when W ≥ 10;
- header `^Q{round((pw + x_offset_px)/12)},0` (same rule as strips: 2009-110 → `^Q42,0`).

`PatternGeometry` (returned to the UI):
`kind ("diecut"|"continuous"), width_mm, length_mm, inset_mm, line_mm 0.25, letters,
ruler_from_mm (10|None), ruler_to_mm (int|None), side_line_inset_mm (1.0 continuous),
bar_inset_mm (3.0 continuous), feed_measurable (die-cut), across_measurable (guide=="fit")`.

**Offset formulas** (frontend `utils/labelCalibration.ts`, live; the server only stores the
raw measurements; all inputs in mm, results rounded to 0.1 mm):

| Inputs | Result |
|---|---|
| die-cut, A | `x_offset_new = x_offset − (A − i_mm)` |
| die-cut, A and B | same as A only; length check `e = (A + B) − 2·i_mm`; \|e\| > 0.5 → info, never applied |
| guide `fit`, L only | `across_new = across + (L − nominal)` |
| guide `fit`, L and R | `across_new = across + (L − R)/2`; width check `(L + R) − 2·nominal`, \|…\| > 0.5 → info |
| guide `max` | no across correction; info shows `L − R` |
| ruler: nominal N (= `ruler_to − 10`), measured D | `scale = 12 · N / D` (2 decimals), info only |

`nominal` = `i_mm` for die-cut, 1.0 mm for continuous. Continuous stock gets no feed
correction (no edge to register against); `x_offset_mm` stays editable in the profile form.

Every computed value is clamped to `material.offset_limits` (§4.9) before it is shown or
PUT. When clamping changed it, `offsetCorrections` also returns the info line
"Korrektur {raw} mm liegt außerhalb des möglichen Bereichs ({min} … {max} mm) – übernommen
wird {clamped} mm. Material, Sensorposition und Führungen prüfen." So the server never
rejects a value the wizard computed.
A + B: the trailing line is placed from the profile length; when the real label is shorter
(the printer measured 97,0 mm for 99 mm stock) B is small or the line falls into the gap —
which is exactly why B is never used for the offset.

---

## 5. Concurrency

### 5.0 Exceptions (leaf module, no import cycles)

`services/werkstatt_label_errors.py` holds **every** label exception and imports nothing
from the label services (stdlib + `datetime` only):

```python
class LabelPrinterNotConfigured(RuntimeError): ...
class LabelPrinterUnreachable(RuntimeError): ...
class LabelFormatUnsupported(RuntimeError): ...
class LabelLayoutOutOfBounds(LabelFormatUnsupported): ...
class LabelPrinterBusy(RuntimeError): ...                 # base; workflow/admin routes catch this
class LabelPrinterSessionBusy(LabelPrinterBusy):          # another session holds the printer
    holder_name: str; since: datetime                     # since = acquired_at (UTC)
class LabelPrinterIoBusy(LabelPrinterBusy): ...           # I/O lock timeout (§5.3)
class DisallowedPrinterCommand(RuntimeError): ...         # programming error → 500
class PatternUnsupported(ValueError): ...                 # §4.11
class StaleRevision(RuntimeError):
    revision: int                                         # the current revision
class MaterialValidationError(ValueError): ...
class PrinterSettingsValidationError(ValueError): ...
```

`werkstatt_labels` re-exports `LabelPrinterNotConfigured`, `LabelPrinterUnreachable`,
`LabelFormatUnsupported`, `LabelLayoutOutOfBounds`, `LabelPrinterBusy` (+ subclasses);
`werkstatt_label_materials` re-exports `MaterialValidationError` and `StaleRevision`, so
every existing `wl.LabelPrinterUnreachable` / `from …materials import
MaterialValidationError` keeps working (the classes are the same objects). The new modules
(`werkstatt_label_jobs`, `_io_lock`, `_transport`, `_session`, `_calibration`,
`_patterns`, `_ezpl_policy`) import exceptions **only** from `werkstatt_label_errors`.

### 5.1 Calibration session lock (DB, TTL)

`services/werkstatt_label_session.py`:

- `acquire(db, *, user, mode, material_id, takeover) -> Session`, in this order:
  no printer address → 503 `not_configured`; the caller lacks `settings:manage` and
  `label_calibration_staff_enabled` is false → 403 `staff_flow_disabled`; `mode == "full"`
  without `settings:manage` → 403; unknown `material_id` → 404 `unknown_material`. Then
  `SELECT … FOR UPDATE` on the lock row (skip `FOR UPDATE` on SQLite exactly like
  `werkstatt_movements.py:151`); if the row does not exist, insert `{}` and flush (a
  concurrent insert's `IntegrityError` → rollback and retry once). If a non-expired session
  exists:
  - same `user_id` → replaced (takeover of the user's own stale tab);
  - other user and `takeover` and caller has `settings:manage` → replaced, audit
    `takeover_of`;
  - otherwise 409 `session_locked` with `holder_name`, `since`, `mode`.
  Stores `profile_at_start` of the material.
- `require(db, session_id, user) -> Session` (FOR UPDATE): exists, same id, not expired,
  `user_id == user.id` → else 409 `session_lost`. Extends `expires_at = now + TTL`.
- `release(db, session_id, user) -> bool`: **idempotent**. When the stored session has this
  id (expired or not) and belongs to `user`, it writes `{}` and returns true (audit
  `session_end`). When the lock is free, or held by another session (another user's, or the
  user's own newer tab), it writes nothing and returns false. The route answers 204 either
  way (§6.2).
- `active_session(db) -> Session | None`: plain read, ignores expired sessions.

**Busy check in `_ship`** (writes only; reads never pass it): before the I/O lock,
`s = active_session(db)`; if `s` and `s.session_id != session_id` → raise
`LabelPrinterSessionBusy(holder_name=s.user_name, since=s.acquired_at)`, German `str()`:
"Etikettendrucker wird gerade eingerichtet ({user_name}, seit {HH:MM}) – bitte warten, bis
die Einrichtung abgeschlossen ist".

**Times**: every server-built `HH:MM` is `acquired_at` (or `latched.at`) converted to
`settings.app_timezone` (Europe/Berlin, `app/core/config.py:69`). Every `since` field in a
response is the ISO-8601 UTC datetime equal to `acquired_at` (e.g.
`"2026-10-20T07:05:00Z"`). The frontend builds every banner from `since`/`acquired_at` with
local formatting and never parses a server message.

Mapping:

| Caller | `LabelPrinterSessionBusy` | `LabelPrinterIoBusy` |
|---|---|---|
| `workflow_werkstatt_machines.py` (2 routes), `workflow_werkstatt_boxes.py`, `workflow_werkstatt_articles.py`, `workflow_schaltplan.py` (BMK labels, type label) | catch the base `LabelPrinterBusy` → `HTTPException(409, detail=str(exc))` (string detail, like the existing 502/503) | same |
| admin `test` and `freetext` | catch the base → `200 LabelPrinterTestOut(ok=False, detail=str(exc))` | same |
| calibration endpoints | 409 `session_lost` (the caller's own session was replaced or expired between steps, §5.4) | 409 `printer_busy` |

Add the new `except` **before** `LabelPrinterUnreachable` in each of the 8 handlers.

### 5.2 Revision compare-and-set

`werkstatt_label_materials.update_config(db, mutate, *, expected_revision: int | None)`:
`SELECT AppSetting … FOR UPDATE` (skip on SQLite), parse, if `expected_revision is not None
and expected_revision != stored.revision` → raise `StaleRevision` (→ 409 `stale_revision`
"Einstellungen wurden inzwischen geändert – bitte neu laden"), else apply `mutate`, write
`revision + 1`, caller commits. Revision is **required** on PUT material and PUT printer,
**optional** on PATCH (old cached bundles send none; then last-writer-wins but the revision
still increments). `activate` takes no revision (single-field write) but increments it
when the active material changes. Because of that, **every** `SessionOut` carries
`config_revision` (the configuration revision after the call), and the frontend always
sends the most recent revision it has received from any response (§7.6).
The state and lock blobs are written under their own `FOR UPDATE`, without revision.

### 5.3 One printer connection at a time

`services/werkstatt_label_io_lock.py`: `printer_io_lock(timeout_s=IO_LOCK_TIMEOUT_S)` — an
`fcntl.flock` on `Path(tempfile.gettempdir()) / "smpl-werkstatt-label-printer.lock"`
(all uvicorn workers share the container's `/tmp`), polling `LOCK_EX | LOCK_NB` every
50 ms up to 8.0 s; timeout → `LabelPrinterIoBusy` "Drucker ist gerade mit einem anderen
Auftrag beschäftigt – bitte gleich erneut versuchen" (409 `printer_busy` on calibration
routes; GET /status answers the same 409). `_ship` and `query_printer` hold it around exactly one connection. Tests may
monkeypatch the lock path into `tmp_path`.

### 5.4 Ordering rules (no deadlocks)

- Never hold a DB row lock (`FOR UPDATE`) across printer I/O, and never touch the DB while
  holding the I/O lock.
- Session actions run in three steps: (1) `require` + validate + mark (e.g. `sense_pending`)
  + commit; (2) printer I/O; (3) `require` again + write results + commit. If step 3 finds
  the session gone → 409 `session_lost` (the printer action happened; it is audited).

---

## 6. API

### 6.1 Routers

| File | Prefix (mounted with `/api` in `main.py`) | Router dependency |
|---|---|---|
| `routers/werkstatt_label_printer.py` (new) | `/werkstatt/label-printer` | `require_any_permission("werkstatt:manage", "settings:manage")` |
| `routers/admin_label_printer.py` (new) | `/admin/settings/label-printer` | `require_permission("settings:manage")` |
| `routers/admin.py` (existing GET/PATCH/test/freetext stay there) | `/admin` | unchanged |

`_label_printer_settings_out` moves to `services/werkstatt_label_settings_view.py`
(builders for `LabelMaterialOut`, `LabelPrinterSettingsOut`, `LabelPrinterOverviewOut`).
No path collides with an existing `/werkstatt/...` route (none uses a bare path parameter).

### 6.2 Endpoints

All new endpoints answer errors as `{"detail": {"code": str, "message": str, …extra}}`
(the web client reads `detail.message`, §7.3). Workflow print routes keep string details.

| # | Method | Path | Body | 200 response | Permission | Feeds paper | Audit action |
|---|---|---|---|---|---|---|---|
| 1 | GET | `/api/werkstatt/label-printer` | – | `LabelPrinterOverviewOut` | any of the two | no | – |
| 2 | GET | `/api/werkstatt/label-printer/status?full=false` | – | `PrinterStatusOut` | any (`raw_config` only for `settings:manage`) | no; **never writes** (queries only, §4.3) | – |
| 3 | POST | `/api/werkstatt/label-printer/session` | `SessionStartIn` | `SessionOut` | any; `mode:"full"` needs `settings:manage`; without `settings:manage` needs `label_calibration_staff_enabled` | no | `werkstatt.label_printer.session_start` |
| 4 | POST | `…/session/{session_id}/heartbeat` | – | `SessionOut` | holder | no | – |
| 5 | DELETE | `…/session/{session_id}` | – | 204 (always, idempotent) | any of the two | no | `werkstatt.label_printer.session_end` (only when a session was released) |
| 6 | POST | `…/session/{session_id}/activate` | `ActivateIn` | `SessionOut` | holder | no | `werkstatt.label_printer.activate` |
| 7 | POST | `…/session/{session_id}/apply` | – | `ApplyOut` | holder | no (per manual) | `werkstatt.label_printer.apply` |
| 8 | POST | `…/session/{session_id}/autosense` | `AutosenseIn` | `AutosenseOut` | holder | **yes** | `werkstatt.label_printer.autosense` |
| 9 | POST | `…/session/{session_id}/poll` | – | `SensePollOut` | holder | no | – |
| 10 | POST | `…/session/{session_id}/verify` | – | `VerdictOut` | holder | no | – |
| 11 | POST | `…/session/{session_id}/pattern` | `FeedConfirmIn` | `PatternOut` | holder + `settings:manage` + `mode == "full"` | **yes** | `werkstatt.label_printer.pattern` |
| 12 | POST | `…/session/{session_id}/save` | `CalibrationSaveIn` | `CalibrationRecordOut` | holder (`pattern` only in full sessions) | no | `werkstatt.label_printer.calibration_save` |
| 13 | GET | `/api/admin/settings/label-printer` (exists) | – | `LabelPrinterSettingsOut` (extended) | settings | no | – |
| 14 | PATCH | `/api/admin/settings/label-printer` (exists) | `LabelPrinterSettingsUpdate` (changed) | `LabelPrinterSettingsOut` | settings | no | `settings.label_printer.update` |
| 15 | PUT | `/api/admin/settings/label-printer/materials/{material_id}` | `LabelMaterialUpdate` | `LabelPrinterSettingsOut` | settings | no | `settings.label_printer.material_update` {id, changed_fields, reset_fields} |
| 16 | PUT | `/api/admin/settings/label-printer/printer` | `PrinterSettingsUpdate` (baseline, row offset, staff switch) | `LabelPrinterSettingsOut` | settings | no | `settings.label_printer.printer_update` (`staff_enabled` from/to when it changes) |
| 17 | POST | `/api/admin/settings/label-printer/test` (exists) | – | `LabelPrinterTestOut` | settings | yes | unchanged |
| 18 | POST | `/api/admin/settings/label-printer/freetext` (exists) | unchanged | `LabelPrinterTestOut` | settings | yes | unchanged |

`session` (3): checks in the order of §5.1 `acquire` — 503 `not_configured` when no printer
address is set (runtime or env), 403 `staff_flow_disabled` for a caller without
`settings:manage` while `label_calibration_staff_enabled` is false, 403 for `mode:"full"`
without `settings:manage`, 404 `unknown_material`, 409 `session_locked`.

`DELETE` (5): idempotent, always 204, never 409: releases the lock when the id matches the
caller's stored session (expired or not); when the lock is free, expired or held by another
session (including a newer tab or a takeover) it writes nothing. A stale tab can therefore
never wipe someone else's session, and the hook's unmount DELETE after `save` is harmless.
Route pattern as `workflow_customer_credentials.py:78`: `status_code=204`, **no return
annotation** (a 204 route must not be annotated `-> None`).

`save` (12) releases the session after writing the record. A verify must exist for the
session's current material, else 409 `step_order` "Zuerst Ergebnis prüfen". A verdict other
than `match` needs `accept_verdict: true`, else 422 `accept_required` "Abweichendes Ergebnis
muss ausdrücklich bestätigt werden". `pattern` in a quick session → 422 `pattern_full_only`
"Messmuster gibt es nur in der vollständigen Einrichtung".

`activate` (6): refused while phase is `sensing` (409 `step_order` "Einmessen läuft noch –
bitte warten, bis es abgeschlossen ist"; switching material mid-feed would drop the poll
while the printer still feeds). Material must exist (404 `unknown_material`); writes
`active_material_id` via the CAS without revision (no write and no revision bump if
unchanged); `session.material_id = material_id`; `apply = null`, `verify = null`;
`sense` (with its latch and `writes_since_sense`) is kept; when `material_id` changes,
`profile_at_start` is re-captured for the new material (so `changes` in the record compare
the same material); phase `activated`. Allowed in phases `open`, `activated`, `applied`,
`sensed`, `judged`. The response's `config_revision` is the revision after the write.

`pattern` (11), checks in this order:

1. `confirm_feed` must be `true` → else 422 `confirm_feed_required` (FeedConfirmIn defaults
   to false; the server never assumes consent).
2. `mode == "full"` → else 422 `pattern_full_only`.
3. `pattern_supported(profile)` → else 422 `pattern_unsupported` "Messmuster für
   mehrbahniges Material folgt nach dem Praxistest (T8)" (210-805, §4.11).
4. Phase `judged` (a verdict exists; in full mode the pattern comes after step 4) and an
   apply for the session's current material → else 409 `step_order` "Zuerst Einstellungen
   übertragen und Ergebnis prüfen". Never in `sensing`.
5. `pattern_pending` or `sense_pending` true → 409 `step_order` "Messmuster wird bereits
   gedruckt". Set `pattern_pending = true`, commit; any failure in 6–7 clears it again.
6. STATUS must answer `00` with pending == 0 → else 409 `printer_not_ready` (no reply:
   `code` null, `code_text` "Drucker antwortet nicht auf Abfragen"). This stops a pattern
   from being buffered while the head is open (it would print when someone closes the lid)
   and from interleaving with a print.
7. `assert_allowed` → `wl._ship(…, session_id=sid)`; append `{kind: "pattern", at, q}` to
   `sense.writes_since_sense`; clear `pattern_pending` (also on failure); phase unchanged.
   Allowed repeatedly (re-print loop, "Probedruck").

Phase preconditions at a glance: `activate` ∈ {open, activated, applied, sensed, judged} ·
`apply` ∈ {activated, applied, sensed, judged} · `autosense` ∈ {applied, sensed, judged}
with a current apply · `poll` ∈ {sensing, sensed} (in `sensed` it replays `sense.result`
without querying) · `verify` needs a sensing run and a current apply · `pattern` needs
phase `judged` and a current apply · `save` needs a verify of the current material. Every
violation → 409 `step_order` with the step-specific German message. The frontend gates its
buttons on `phase` **together with** `applied` (§7.4).

### 6.3 Errors

| HTTP | `code` | `message` (German, exact) | Extra fields |
|---|---|---|---|
| 503 | `not_configured` | "Kein Etikettendrucker konfiguriert" | – |
| 502 | `unreachable` | "Etikettendrucker nicht erreichbar ({host}:{port})" | `printer` |
| 409 | `session_locked` | "Der Etikettendrucker wird gerade von {name} eingerichtet (seit {HH:MM})" | `holder_name`, `since` (ISO-8601 UTC = `acquired_at`), `mode` |
| 409 | `session_lost` | "Die Einrichtung ist abgelaufen oder wurde übernommen – bitte neu starten" | – |
| 409 | `stale_revision` | "Einstellungen wurden inzwischen geändert – bitte neu laden" | `revision` (current) |
| 409 | `printer_busy` | "Drucker ist gerade mit einem anderen Auftrag beschäftigt – bitte gleich erneut versuchen" | – |
| 409 | `printer_not_ready` | "Drucker nicht bereit: {code_text}" — the **only** template, also for apply on `50`/`60` ("Drucker nicht bereit: Druckt") | `code`, `code_text`, `action_text` |
| 409 | `no_status_reply` | "Drucker antwortet nicht auf Statusabfragen – stattdessen die Kalibriertaste auf der Rückseite verwenden" | – (only for method `command`) |
| 409 | `step_order` | step-specific (see §4.5–4.7, §6.2) | – |
| 404 | `unknown_material` | "Unbekanntes Material: {id}" | – |
| 403 | `staff_flow_disabled` | "Der Schnellablauf ist noch nicht freigegeben – bitte an die Verwaltung wenden" | – |
| 422 | `invalid_material` | the `MaterialValidationError` text (§3.8, §4.9) | – |
| 422 | `invalid_printer_settings` | the `PrinterSettingsValidationError` text (§3.8) | – |
| 422 | `confirm_feed_required` | "Materialeinzug muss bestätigt werden" | – |
| 422 | `accept_required` | "Abweichendes Ergebnis muss ausdrücklich bestätigt werden" | – |
| 422 | `pattern_full_only` | "Messmuster gibt es nur in der vollständigen Einrichtung" | – |
| 422 | `pattern_unsupported` | "Messmuster für mehrbahniges Material folgt nach dem Praxistest (T8)" | – |
| 422 | (pydantic) | FastAPI default list — only for wrong **types** or unknown enum values; ranges never reach pydantic (§6.4) | – |
| 403 | – | "Permission denied" (existing) | – |

The frontend renders `printer_not_ready` as "{message}. {action_text}" when `action_text` is
non-empty, else "{message}".

**PATCH `/api/admin/settings/label-printer` error table** (backward compatible, pinned by
tests):

| Situation | HTTP | `detail` |
|---|---|---|
| `MaterialValidationError` (§3.8, incl. `offset_limits`) | 400 | the German string (as today) |
| builtin missing from `materials` | 400 | "Mitgeliefertes Material {id} kann nicht entfernt werden" (today's string) |
| unknown `active_material_id` | 400 | "Unbekanntes Material: {id}" (today's string) |
| `revision` sent and stale | 409 | `{"code": "stale_revision", "message": "Einstellungen wurden inzwischen geändert – bitte neu laden", "revision": <current>}` (dict, so `apiErrorCode` works) |
| wrong type / unknown enum value | 422 | pydantic list |

Explicit `null` inside a PATCH `materials[]` item on a **non-nullable** field (for example
`sensor_mode: null`, `sensor_scale: null`, `across_offset_mm: null`, `guide: null`) is
**ignored**: the stored value is kept. Only the nullable fields (`length_mm`, `darkness`,
`speed_ips`, `stop_mm`, `mark_width_mm`) take `null` as a value. (PUT material instead
answers 422 `invalid_material` "Feld {name} darf nicht leer sein", §6.4.)

### 6.4 Schemas

New file `app/schemas/label_printer.py`; `LabelMaterialIn/Out`, `LabelPrinterSettingsOut`,
`LabelPrinterSettingsUpdate` stay in `app/schemas/settings.py`, extended.

**Input schemas carry types only.** `MediaWebIO`, `LabelMaterialIn`, `LabelMaterialUpdate`,
`BaselineIn` and `PrinterSettingsUpdate` have **no** numeric (`ge/le/gt`) and no string
length (`min_length/max_length`) constraints — including the ones `LabelMaterialIn` has
today. A pydantic range error would surface as FastAPI's English list, which `apiFetch`
turns into "Unprocessable Entity"; instead `validate_materials` /
`validate_printer_settings` check every range with the German texts of §3.8 (PUT → 422
`invalid_material` / `invalid_printer_settings`, PATCH → 400 string). Literal enums and
types stay (a wrong type is a client bug). `SessionStartIn`, `ActivateIn`,
`PatternMeasurementsIn` and `CalibrationSaveIn` keep their constraints: the UI never lets
them be violated (inputs have `maxLength`/ranges, §7.6).

```python
SensorMode = Literal["see_through", "reflective", "auto", "none"]
GuideSetting = Literal["max", "fit"]
FeedPath = Literal["internal", "external"]
Roller = Literal["258-5006", "258-5007"]
MediaType = Literal["gap", "mark", "continuous"]
WebSource = Literal["catalogue", "estimate", "measured"]
SessionMode = Literal["quick", "full"]
SessionPhase = Literal["open", "activated", "applied", "sensing", "sensed", "judged"]
Verdict = Literal["match", "mismatch", "other_material", "no_gap",
                  "gap_on_continuous", "no_result", "unchecked", "printer_error"]
Freshness = Literal["busy_seen", "q_changed", "qd_changed", "none"]
SensorKind = Literal["see_through", "reflective", "unknown"]
Offer = Literal["save", "accept_anyway", "resense", "requery", "reapply", "switch_material"]
HintTopic = Literal["sensor_position", "sensor_mode", "geometry", "web", "roller", "printing"]


class MediaWebIO(BaseModel):              # ranges: §3.8 "Rollenmaße ungültig"
    lanes: int = 1
    label_across_mm: float | None = None
    label_along_mm: float | None = None
    lane_gap_mm: float = 0.0
    liner_width_mm: float | None = None
    source: WebSource = "catalogue"


class OffsetLimitsOut(BaseModel):          # §4.9, mm
    x_min: float
    x_max: float
    across_min: float
    across_max: float


class JobSettingsOut(BaseModel):
    darkness: int
    speed_ips: int
    stop_mm: int


class MaterialHintOut(BaseModel):
    topic: HintTopic
    text: str


class CalibrationSummaryOut(BaseModel):
    kind: SessionMode
    at: datetime
    by_name: str
    verdict: Verdict
    fresh: bool
    accepted: bool
    stale: bool                       # derived: fingerprint differs
    measured_length_mm: float | None
    measured_gap_mm: float | None
    notes: str = ""


# settings.py — LabelMaterialOut gains (existing fields unchanged):
class LabelMaterialOut(BaseModel):
    id: str
    name: str
    part_no: str = ""
    width_mm: float
    length_mm: float | None = None
    gap_mm: float = 3.0
    x_offset_mm: float = 2.0
    darkness: int | None = None        # STORED override; None = baseline
    builtin: bool = False
    tier: str = "mini"
    continuous: bool = False
    # new
    media_type: MediaType = "gap"
    across_offset_mm: float = 0.0
    speed_ips: int | None = None       # stored override
    stop_mm: int | None = None         # stored override
    resolved: JobSettingsOut
    mark_width_mm: float | None = None
    mark_offset_mm: float = 0.0
    mark_inside: bool = False
    sensor_mode: SensorMode
    sensor_scale: float                # reading on the housing scale, 0.5–5.5, 3.0 = centre (§3.2)
    guide: GuideSetting
    feed_path: FeedPath
    roller: Roller
    web: MediaWebIO
    web_width_mm: float
    overridden_fields: list[str] = []
    hints: list[MaterialHintOut] = []
    calibration: CalibrationSummaryOut | None = None
    autosense_cost_hint: str
    pattern_cost_hint: str             # "" when pattern_supported is false
    pattern_supported: bool            # §4.11 (false for 210-805)
    offset_limits: OffsetLimitsOut     # §4.9


# settings.py — PATCH list item (id/name/width required as today; everything else optional).
# Types only: every range and length check is in validate_materials (§3.8).
class LabelMaterialIn(BaseModel):
    id: str
    name: str
    part_no: str = ""
    width_mm: float
    length_mm: float | None = None
    gap_mm: float = 3.0
    x_offset_mm: float = 2.0
    darkness: int | None = None
    across_offset_mm: float | None = None
    speed_ips: int | None = None
    stop_mm: int | None = None
    mark_width_mm: float | None = None
    mark_offset_mm: float | None = None
    mark_inside: bool | None = None
    sensor_mode: SensorMode | None = None
    sensor_scale: float | None = None
    guide: GuideSetting | None = None
    feed_path: FeedPath | None = None
    roller: Roller | None = None
    web: MediaWebIO | None = None
    # PATCH merge (§6.4 "PATCH list semantics"): fields in model_fields_set are applied,
    # except an explicit None on a non-nullable field, which is ignored (§6.3).


class LabelPrinterSettingsUpdate(BaseModel):
    host: str | None = None            # None = keep (was "" = clear when omitted); "" = clear
    port: int | None = Field(default=None, ge=1, le=65535)   # None = keep
    materials: list[LabelMaterialIn] | None = None
    active_material_id: str | None = None
    revision: int | None = None        # optional CAS


class LastAppliedOut(BaseModel):
    material_id: str
    at: datetime
    by_name: str
    commands: list[str]
    confirmed: bool | None


class SessionInfoOut(BaseModel):       # what anyone may see about the current session
    mode: SessionMode
    material_id: str
    user_name: str
    acquired_at: datetime
    expires_at: datetime
    mine: bool
    session_id: str | None = None      # only when mine


class LabelPrinterSettingsOut(BaseModel):   # existing fields unchanged, plus:
    revision: int = 0
    baseline: JobSettingsOut
    baseline_overridden: list[str] = []
    row_offset_dots: int | None = None
    label_calibration_staff_enabled: bool = False
    session: SessionInfoOut | None = None
    last_applied: LastAppliedOut | None = None


class LabelPrinterOverviewOut(BaseModel):   # GET /api/werkstatt/label-printer (DB only, no printer I/O)
    configured: bool
    printer: str                       # "host:port" or ""
    active_material_id: str
    active_material_name: str
    materials: list[LabelMaterialOut]
    session: SessionInfoOut | None
    last_applied: LastAppliedOut | None
    can_full: bool                     # caller holds settings:manage
    staff_enabled: bool                # label_calibration_staff_enabled (§3.4)


class LabelMaterialUpdate(BaseModel):  # PUT …/materials/{id}; exclude_unset; types only (§3.8)
    revision: int
    name: str | None = None
    part_no: str | None = None
    width_mm: float | None = None
    length_mm: float | None = None      # explicit null = continuous
    gap_mm: float | None = None
    x_offset_mm: float | None = None
    across_offset_mm: float | None = None
    darkness: int | None = None         # explicit null = baseline
    speed_ips: int | None = None        # explicit null = baseline
    stop_mm: int | None = None          # explicit null = baseline
    sensor_mode: SensorMode | None = None
    sensor_scale: float | None = None   # 0.5–5.5 and rounding in validate_materials (§3.8)
    guide: GuideSetting | None = None
    feed_path: FeedPath | None = None
    roller: Roller | None = None
    mark_width_mm: float | None = None  # explicit null = no black mark
    mark_offset_mm: float | None = None
    mark_inside: bool | None = None
    web: MediaWebIO | None = None       # replaces web as a whole
    reset_fields: list[str] = Field(default_factory=list)   # builtins only


class BaselineIn(BaseModel):           # exclude_unset; explicit null = back to code default; types only
    darkness: int | None = None
    speed_ips: int | None = None
    stop_mm: int | None = None


class PrinterSettingsUpdate(BaseModel):    # PUT …/printer; exclude_unset semantics; types only
    revision: int
    baseline: BaselineIn | None = None
    row_offset_dots: int | None = None      # explicit null = unpin
    label_calibration_staff_enabled: bool | None = None   # null/absent = keep


class PrinterWarningOut(BaseModel):
    code: Literal["row_offset_drift", "direct_thermal", "sensor_mismatch",
                  "incomplete_reply", "resolution_unexpected", "error_pushed"]
    message: str


class PrinterConfigOut(BaseModel):
    complete: bool
    firmware: str | None = None
    sensor_kind: SensorKind = "unknown"
    sensor_line: str | None = None
    measured_length_dots: int | None = None
    measured_gap_dots: int | None = None
    measured_pitch_dots: int | None = None
    stored_q: str | None = None
    width_mm: float | None = None
    darkness: int | None = None
    speed_ips: int | None = None
    stop_mm: int | None = None
    left_margin_dots: int | None = None
    row_offset_dots: int | None = None
    print_mode: Literal["thermal_transfer", "direct_thermal"] | None = None
    resolution_dpi: int | None = None


class PrinterStatusOut(BaseModel):
    printer: str
    answered: bool
    code: str | None
    code_text: str
    action_text: str = ""
    ready: bool
    pending: int | None
    config: PrinterConfigOut | None = None     # full=true and CONFIG replied
    raw_config: str | None = None              # full=true, settings:manage only; ≤ 8000 chars
    warnings: list[PrinterWarningOut] = []
    errors_seen: list[str] = []


class SessionStartIn(BaseModel):
    mode: SessionMode
    material_id: str = Field(min_length=1, max_length=40)
    takeover: bool = False


class SessionOut(BaseModel):
    session_id: str
    mode: SessionMode
    material_id: str
    phase: SessionPhase
    user_name: str
    acquired_at: datetime
    expires_at: datetime
    applied: bool                 # apply exists and apply.material_id == material_id
    sensed: bool                  # a sensing run exists (sense != null)
    verdict: Verdict | None       # verify.verdict, null after activate / new autosense
    config_revision: int          # configuration revision after this call (§5.2)


class ActivateIn(BaseModel):
    material_id: str = Field(min_length=1, max_length=40)


class ApplyOut(BaseModel):
    printer: str
    commands: list[str]
    confirmed: bool | None
    mismatches: list[str] = []
    config: PrinterConfigOut | None = None
    session: SessionOut


class FeedConfirmIn(BaseModel):
    confirm_feed: bool = False


class AutosenseIn(FeedConfirmIn):
    method: Literal["command", "button"] = "command"


class PresenseOut(BaseModel):
    stored_q: str | None
    measured_length_dots: int | None
    measured_gap_dots: int | None
    apply_confirmed: bool | None


class AutosenseOut(BaseModel):
    printer: str
    method: Literal["command", "button"]
    cost_hint: str
    status_answered: bool         # false only for method "button" with a silent STATUS
    presense: PresenseOut | None
    session: SessionOut


class SensePollOut(BaseModel):
    phase: Literal["sensing", "done", "error", "timeout"]
    answered: bool                # STATUS replied to this poll (replays: the stored result's)
    code: str | None
    code_text: str                # printer status text (§4.3 table)
    message: str = ""             # SMPL's own text: no reply, slow, timeout, unknown code (§4.6)
    saw_busy: bool
    elapsed_s: float
    session: SessionOut


class VerdictOut(BaseModel):
    material_id: str
    verdict: Verdict
    title: str
    detail: str
    notes: list[str] = []
    fresh: bool
    freshness: Freshness               # latched.freshness whenever a latch exists (§4.7)
    from_latch: bool                   # judged a measurement latched by an earlier verify
    dots_per_mm: float = 12.0
    expected_length_mm: float | None
    expected_gap_mm: float | None
    expected_pitch_mm: float | None
    measured_length_mm: float | None
    measured_gap_mm: float | None
    measured_pitch_mm: float | None
    measured_length_dots: int | None
    measured_gap_dots: int | None
    delta_length_mm: float | None
    delta_pitch_mm: float | None
    tolerance_mm: float | None
    sensor_kind: SensorKind
    sensor_expected: Literal["see_through", "reflective"] | None
    sensor_ok: bool | None
    suggested_material_ids: list[str] = []
    status_code: str | None
    status_text: str
    offers: list[Offer]
    warnings: list[PrinterWarningOut] = []
    session: SessionOut


class PatternGeometryOut(BaseModel):
    kind: Literal["diecut", "continuous"]
    width_mm: float
    length_mm: float
    inset_mm: float
    line_mm: float = 0.25
    letters: bool
    ruler_from_mm: int | None
    ruler_to_mm: int | None
    side_line_inset_mm: float | None
    bar_inset_mm: float | None
    feed_measurable: bool
    across_measurable: bool


class PatternOut(BaseModel):
    printer: str
    cost_hint: str
    geometry: PatternGeometryOut
    x_offset_mm: float
    across_offset_mm: float
    session: SessionOut


class PatternMeasurementsIn(BaseModel):
    lead_mm: float | None = Field(None, ge=0, le=30)
    trail_mm: float | None = Field(None, ge=0, le=30)
    left_mm: float | None = Field(None, ge=0, le=30)
    right_mm: float | None = Field(None, ge=0, le=30)
    ruler_nominal_mm: int | None = Field(None, ge=10, le=750)
    ruler_measured_mm: float | None = Field(None, gt=0, le=800)


class CalibrationSaveIn(BaseModel):
    notes: str = Field("", max_length=200)
    accept_verdict: bool = False
    pattern: PatternMeasurementsIn | None = None


class CalibrationRecordOut(BaseModel):   # the stored record (§3.6) plus derived `stale`
    material_id: str
    kind: SessionMode
    at: datetime
    by_name: str
    verdict: Verdict
    fresh: bool
    freshness: Freshness
    accepted: bool
    stale: bool
    measured_length_dots: int | None
    measured_gap_dots: int | None
    measured_pitch_dots: int | None
    sensor_kind: SensorKind
    firmware: str | None
    row_offset_dots: int | None
    pattern: PatternMeasurementsIn | None
    changes: dict[str, dict[str, float | int | None]]
    notes: str
```

**PATCH list semantics** (`materials` present):

- Every builtin must be listed → else 400 "Mitgeliefertes Material {id} kann nicht entfernt
  werden" (today).
- Custom ids not listed are **removed** (the "Entfernen" button relies on this).
- A listed existing id is **merged**: `item.model_dump(exclude_unset=True)` replaces stored
  values field by field; unset fields keep stored values; an explicit `None` on a
  non-nullable field is dropped from the dump first (keeps the stored value, §6.3). For
  builtins the merged result is stored as a diff against the code default.
- A listed unknown id creates a custom profile (type-dependent defaults for unset fields).
- Derived/server-owned fields in the payload (`builtin`, `tier`, `continuous`, `media_type`,
  `resolved`, `web_width_mm`, `hints`, `overridden_fields`, `calibration`, `*_cost_hint`,
  `pattern_supported`, `offset_limits`) are ignored.
- Echoing a GET object back unchanged therefore changes nothing but `revision`.
- Errors: the PATCH error table of §6.3.

**PUT material semantics**: `exclude_unset`; explicit `null` is allowed only on the
nullable fields (`length_mm`, `darkness`, `speed_ips`, `stop_mm`, `mark_width_mm`), on any
other field (e.g. `sensor_scale`) → 422 `invalid_material` "Feld {name} darf nicht leer
sein". `reset_fields` (builtins only, else 422) removes overrides; allowed names are every
profile field except `id`. Then validation (§3.8) and `dry_render_checks` (§4.9). 404 for an
unknown id.

---

## 7. Frontend

### 7.1 Where it lives

- **Admin → Einstellungen → "Etikettendrucker (Werkstatt)"**
  (`apps/web/src/components/admin/AdminLabelPrinterCard.tsx`, mounted at
  `pages/AdminPage.tsx:2092`): status line, per-material chips and buttons, the full wizard,
  the profile form, the quick flow.
- **Werkstatt → Maschinen** (`apps/web/src/pages/werkstatt/WerkstattMaschinenPage.tsx`):
  the page where workshop staff print machine labels. Add ONE element to the list view's
  `werkstatt-sub-actions` (before "Scannen"): `<LabelPrinterQuickEntry />`. It self-gates
  (§7.11: permissions, the staff switch, a configured printer). The page is already 919
  lines; the edit must be ≤ 5 lines.
- Do not touch `App.tsx`.

### 7.2 Files

| File | Content |
|---|---|
| `src/types/labelPrinter.ts` | all TS types (§7.3); `LabelMaterial` and `LabelPrinterSettings` move here from the card (the card re-exports them for existing importers) |
| `src/utils/labelPrinterApi.ts` | API client functions (§7.3) |
| `src/utils/labelCalibration.ts` | pure helpers: `formatMmDe`, `formatSignedMmDe`, `formatScaleDe` (3.4 → "3,4", 3 → "3"), `parseScaleInput` (decimal comma, one decimal, 0,5–5,5, else null), `webWidthMm`, `targetOffsetMm`, `targetText`, `scaleShiftText`, `visibleHints` (§3.3), `guideText`, `feedText`, `rollerText`, `sensorModeLabel`, `checklistItems`, `sensorTrack`, `offsetCorrections` (clamps to `offset_limits`), `scaleFromRuler`, `diagramDescription`, `calibrationChip`, `apiErrorCode`, `apiErrorDetail`, `formatLocalTime` (ISO UTC → local "HH:MM"); constant `FEED_STOP_HINT` (§3.3) |
| `src/components/labelPrinter/sensorGeometry.ts` | **the** geometry constants module (§7.8) |
| `src/components/labelPrinter/LabelSensorDiagram.tsx` | top view SVG |
| `src/components/labelPrinter/LabelPathSideView.tsx` | side view SVG |
| `src/components/labelPrinter/LabelPatternPreview.tsx` | "what to measure" SVG |
| `src/components/labelPrinter/ConfirmFeedDialog.tsx` | feed confirmation |
| `src/components/labelPrinter/LoadingChecklist.tsx` | sensor + load step (diagram, target text, "Zeiger steht jetzt auf …" input, checklist) |
| `src/components/labelPrinter/ApplyPanel.tsx` | apply step |
| `src/components/labelPrinter/SensePanel.tsx` | auto-sense step incl. polling |
| `src/components/labelPrinter/VerdictCard.tsx` | verdict display + offer buttons |
| `src/components/labelPrinter/useCalibrationSession.ts` | session lifecycle hook (start, heartbeat every 60 s, poll every 1.5 s, end on unmount — `endCalibrationSession` errors are ignored there; DELETE is idempotent, §6.2); keeps `latestRevision` = the highest `config_revision`/`revision` seen in any response, and `verifyWithoutSensing` (§7.5) |
| `src/components/labelPrinter/MaterialChangeSheet.tsx` | quick flow |
| `src/components/labelPrinter/LabelPrinterQuickEntry.tsx` | button + sheet for the Werkstatt page |
| `src/components/labelPrinter/CalibrationWizard.tsx` | full wizard shell |
| `src/components/labelPrinter/wizard/StepPrinter.tsx`, `StepMaterial.tsx`, `StepPattern.tsx`, `StepFinish.tsx` | wizard steps 1, 2, 5, 6 (steps 3–4 reuse the panels) |
| `src/components/labelPrinter/LabelMaterialForm.tsx` | profile form |
| `src/components/labelPrinter/PrinterStatusPanel.tsx` | status block (line + details + raw data) |
| `src/components/labelPrinter/CalibrationChip.tsx` | per-material chip |
| `src/styles/label-calibration.css` | all styles, imported by the components |

Every file < 400 lines. Dialogs use the existing `werkstatt-modal*` markup
(`role="dialog" aria-modal="true"`, `werkstatt-modal-head/body/foot`), full-height sheet
below 640 px. German strings are normative; each string also gets an English variant via
the existing `de ? … : …` pattern (wording free, not tested). Server-built texts (`title`,
`detail`, `message`, `code_text`, hints) are shown verbatim.

### 7.3 Types and API client (mirror §6.4 exactly)

```ts
// src/types/labelPrinter.ts
export type SensorMode = "see_through" | "reflective" | "auto" | "none";
export type GuideSetting = "max" | "fit";
export type FeedPath = "internal" | "external";
export type Roller = "258-5006" | "258-5007";
export type MediaType = "gap" | "mark" | "continuous";
export type WebSource = "catalogue" | "estimate" | "measured";
export type SessionMode = "quick" | "full";
export type SessionPhase = "open" | "activated" | "applied" | "sensing" | "sensed" | "judged";
export type Verdict = "match" | "mismatch" | "other_material" | "no_gap"
  | "gap_on_continuous" | "no_result" | "unchecked" | "printer_error";
export type Freshness = "busy_seen" | "q_changed" | "qd_changed" | "none";
export type SensorKind = "see_through" | "reflective" | "unknown";
export type Offer = "save" | "accept_anyway" | "resense" | "requery" | "reapply" | "switch_material";
export type HintTopic = "sensor_position" | "sensor_mode" | "geometry" | "web" | "roller" | "printing";

export interface MediaWeb {
  lanes: number; label_across_mm: number | null; label_along_mm: number | null;
  lane_gap_mm: number; liner_width_mm: number | null; source: WebSource;
}
export interface JobSettings { darkness: number; speed_ips: number; stop_mm: number }
export interface MaterialHint { topic: HintTopic; text: string }
export interface CalibrationSummary {
  kind: SessionMode; at: string; by_name: string; verdict: Verdict; fresh: boolean;
  accepted: boolean; stale: boolean; measured_length_mm: number | null;
  measured_gap_mm: number | null; notes: string;
}
export interface LabelMaterial {
  id: string; name: string; part_no: string; width_mm: number; length_mm: number | null;
  gap_mm: number; x_offset_mm: number; darkness: number | null; builtin: boolean;
  tier: "voll" | "kompakt" | "mini"; continuous: boolean;
  media_type: MediaType; across_offset_mm: number; speed_ips: number | null;
  stop_mm: number | null; resolved: JobSettings; mark_width_mm: number | null;
  mark_offset_mm: number; mark_inside: boolean; sensor_mode: SensorMode;
  sensor_scale: number;   // reading on the housing scale, 0.5–5.5, 3 = centre (§3.2)
  guide: GuideSetting;
  feed_path: FeedPath; roller: Roller; web: MediaWeb; web_width_mm: number;
  overridden_fields: string[]; hints: MaterialHint[];
  calibration: CalibrationSummary | null; autosense_cost_hint: string; pattern_cost_hint: string;
  pattern_supported: boolean; offset_limits: OffsetLimits;
}
export interface OffsetLimits { x_min: number; x_max: number; across_min: number; across_max: number }
export interface LastApplied {
  material_id: string; at: string; by_name: string; commands: string[]; confirmed: boolean | null;
}
export interface SessionInfo {
  mode: SessionMode; material_id: string; user_name: string; acquired_at: string;
  expires_at: string; mine: boolean; session_id: string | null;
}
export interface LabelPrinterSettings {
  host: string; port: number; configured: boolean; source: "runtime" | "env" | "none";
  materials: LabelMaterial[]; active_material_id: string; active_material_name: string;
  active_tier: string; revision: number; baseline: JobSettings; baseline_overridden: string[];
  row_offset_dots: number | null; label_calibration_staff_enabled: boolean;
  session: SessionInfo | null; last_applied: LastApplied | null;
}
export interface LabelPrinterOverview {
  configured: boolean; printer: string; active_material_id: string; active_material_name: string;
  materials: LabelMaterial[]; session: SessionInfo | null; last_applied: LastApplied | null;
  can_full: boolean; staff_enabled: boolean;
}
export interface PrinterWarning {
  code: "row_offset_drift" | "direct_thermal" | "sensor_mismatch" | "incomplete_reply"
    | "resolution_unexpected" | "error_pushed";
  message: string;
}
export interface PrinterConfig {
  complete: boolean; firmware: string | null; sensor_kind: SensorKind; sensor_line: string | null;
  measured_length_dots: number | null; measured_gap_dots: number | null;
  measured_pitch_dots: number | null; stored_q: string | null; width_mm: number | null;
  darkness: number | null; speed_ips: number | null; stop_mm: number | null;
  left_margin_dots: number | null; row_offset_dots: number | null;
  print_mode: "thermal_transfer" | "direct_thermal" | null; resolution_dpi: number | null;
}
export interface PrinterStatus {
  printer: string; answered: boolean; code: string | null; code_text: string; action_text: string;
  ready: boolean; pending: number | null; config: PrinterConfig | null; raw_config: string | null;
  warnings: PrinterWarning[]; errors_seen: string[];
}
export interface CalibrationSession {
  session_id: string; mode: SessionMode; material_id: string; phase: SessionPhase;
  user_name: string; acquired_at: string; expires_at: string; applied: boolean;
  sensed: boolean; verdict: Verdict | null; config_revision: number;
}
export interface ApplyResult {
  printer: string; commands: string[]; confirmed: boolean | null; mismatches: string[];
  config: PrinterConfig | null; session: CalibrationSession;
}
export interface AutosenseResult {
  printer: string; method: "command" | "button"; cost_hint: string; status_answered: boolean;
  presense: { stored_q: string | null; measured_length_dots: number | null;
              measured_gap_dots: number | null; apply_confirmed: boolean | null } | null;
  session: CalibrationSession;
}
export interface SensePoll {
  phase: "sensing" | "done" | "error" | "timeout"; answered: boolean; code: string | null;
  code_text: string; message: string; saw_busy: boolean; elapsed_s: number;
  session: CalibrationSession;
}
export interface CalibrationVerdict {
  material_id: string; verdict: Verdict; title: string; detail: string; notes: string[];
  fresh: boolean; freshness: Freshness; from_latch: boolean; dots_per_mm: number;
  expected_length_mm: number | null; expected_gap_mm: number | null; expected_pitch_mm: number | null;
  measured_length_mm: number | null; measured_gap_mm: number | null; measured_pitch_mm: number | null;
  measured_length_dots: number | null; measured_gap_dots: number | null;
  delta_length_mm: number | null; delta_pitch_mm: number | null; tolerance_mm: number | null;
  sensor_kind: SensorKind; sensor_expected: "see_through" | "reflective" | null;
  sensor_ok: boolean | null; suggested_material_ids: string[]; status_code: string | null;
  status_text: string; offers: Offer[]; warnings: PrinterWarning[]; session: CalibrationSession;
}
export interface PatternGeometry {
  kind: "diecut" | "continuous"; width_mm: number; length_mm: number; inset_mm: number;
  line_mm: number; letters: boolean; ruler_from_mm: number | null; ruler_to_mm: number | null;
  side_line_inset_mm: number | null; bar_inset_mm: number | null;
  feed_measurable: boolean; across_measurable: boolean;
}
export interface PatternResult {
  printer: string; cost_hint: string; geometry: PatternGeometry; x_offset_mm: number;
  across_offset_mm: number; session: CalibrationSession;
}
export interface PatternMeasurements {
  lead_mm: number | null; trail_mm: number | null; left_mm: number | null; right_mm: number | null;
  ruler_nominal_mm: number | null; ruler_measured_mm: number | null;
}
export interface CalibrationSaveIn {
  notes: string; accept_verdict: boolean; pattern: PatternMeasurements | null;
}
export interface CalibrationRecord {
  material_id: string; kind: SessionMode; at: string; by_name: string; verdict: Verdict;
  fresh: boolean; freshness: Freshness; accepted: boolean; stale: boolean;
  measured_length_dots: number | null; measured_gap_dots: number | null;
  measured_pitch_dots: number | null; sensor_kind: SensorKind; firmware: string | null;
  row_offset_dots: number | null; pattern: PatternMeasurements | null;
  changes: Record<string, { from: number | null; to: number | null }>; notes: string;
}
export type LabelMaterialUpdate = { revision: number; reset_fields?: string[] } & Partial<{
  name: string; part_no: string; width_mm: number; length_mm: number | null; gap_mm: number;
  x_offset_mm: number; across_offset_mm: number; darkness: number | null;
  speed_ips: number | null; stop_mm: number | null; sensor_mode: SensorMode;
  sensor_scale: number; guide: GuideSetting;
  feed_path: FeedPath; roller: Roller; mark_width_mm: number | null;
  mark_offset_mm: number; mark_inside: boolean; web: MediaWeb;
}>;
export interface PrinterSettingsUpdate {
  revision: number;
  baseline?: Partial<{ darkness: number | null; speed_ips: number | null; stop_mm: number | null }>;
  row_offset_dots?: number | null;
  label_calibration_staff_enabled?: boolean;
}
export interface LabelPrinterSettingsPatch {
  host?: string | null; port?: number | null; materials?: Partial<LabelMaterial>[] | null;
  active_material_id?: string | null; revision?: number | null;
}
export interface LabelPrinterApiErrorDetail { code: string; message: string; [extra: string]: unknown }
```

```ts
// src/utils/labelPrinterApi.ts — all via apiFetch(path, token, init); ids encodeURIComponent'd
const W = "/werkstatt/label-printer";
const A = "/admin/settings/label-printer";
getLabelPrinterOverview(token): Promise<LabelPrinterOverview>                 // GET  W
getPrinterStatus(token, full: boolean): Promise<PrinterStatus>                // GET  W/status?full=true|false
startCalibrationSession(token, body: {mode, material_id, takeover?}): Promise<CalibrationSession>  // POST W/session
heartbeatSession(token, sid): Promise<CalibrationSession>                     // POST W/session/{sid}/heartbeat
endCalibrationSession(token, sid): Promise<void>                              // DELETE W/session/{sid}
activateMaterial(token, sid, materialId): Promise<CalibrationSession>         // POST W/session/{sid}/activate {material_id}
applyMaterialSettings(token, sid): Promise<ApplyResult>                       // POST W/session/{sid}/apply
startAutosense(token, sid, method: "command"|"button"): Promise<AutosenseResult>  // POST …/autosense {confirm_feed:true, method}
pollSensing(token, sid): Promise<SensePoll>                                   // POST …/poll
verifyMeasurement(token, sid): Promise<CalibrationVerdict>                    // POST …/verify
printMeasuringPattern(token, sid): Promise<PatternResult>                     // POST …/pattern {confirm_feed:true}
saveCalibration(token, sid, body: CalibrationSaveIn): Promise<CalibrationRecord>  // POST …/save
getLabelPrinterSettings(token): Promise<LabelPrinterSettings>                 // GET  A
patchLabelPrinterSettings(token, body: LabelPrinterSettingsPatch): Promise<LabelPrinterSettings>  // PATCH A
updateLabelMaterial(token, id, body: LabelMaterialUpdate): Promise<LabelPrinterSettings>          // PUT A/materials/{id}
updatePrinterSettings(token, body: PrinterSettingsUpdate): Promise<LabelPrinterSettings>          // PUT A/printer
printTestLabel(token): Promise<{ok: boolean; printer: string; detail: string}>                    // POST A/test
printFreetext(token, text, copies): Promise<{ok: boolean; printer: string; detail: string}>       // POST A/freetext
```

`apiErrorCode(err): string | null` reads `(err as ApiError).detail?.code`; the UI shows
`err.message` (the client already extracts `detail.message`). `apiErrorDetail(err)` returns
the dict detail (for `since`, `action_text`, `revision`) or null; it never parses `message`.
A string detail (workflow routes, PATCH 400) gives `apiErrorCode === null`, and the UI shows
`err.message`.

### 7.4 Quick flow "Material gewechselt" (`MaterialChangeSheet.tsx`)

Sheet title "Material gewechselt", subtitle "WAGO-Etikettendrucker", step line
"Schritt {n} von 5". Buttons sticky at the bottom: [Zurück] [Weiter]; [Abbrechen] in the
header. Opening the sheet fetches the overview (`GET W`).

- `overview.configured === false`: the sheet shows only "Kein Etikettendrucker
  konfiguriert" (and [Schließen]) instead of step 1. A 503 `not_configured` from any later
  call shows the same text.
- 403 `staff_flow_disabled` on start: the server message instead of step 1.
- Buttons gate on `session.phase` **together with** `session.applied` (e.g. [Einmessen
  starten] needs `applied` and a phase in {applied, sensed, judged}); never on `applied`
  alone.

**Step 1 — "Welches Material ist eingelegt?"**

- Intro: "Wähle das Material, das jetzt im Drucker liegt oder gleich eingelegt wird."
- Radio cards: name (bold); line 2 "{part_no} · {Maße}" (Maße: "99 × 44 mm" /
  "11 mm Endlos"); `CalibrationChip`; badge "zurzeit gewählt" on the active one.
- If `overview.session` exists and is not mine: banner "Der Etikettendrucker wird gerade
  von {user_name} eingerichtet (seit {HH:MM})." — {HH:MM} formatted locally from
  `session.acquired_at`; [Weiter] disabled; with `can_full` a button [Einrichtung
  übernehmen] (→ start with `takeover: true`).
- [Weiter] → `startCalibrationSession({mode:"quick", material_id})`. 409 `session_locked` →
  the banner above, built from the error's `holder_name` and `since` (local formatting;
  the server `message` is never parsed).

**Step 2 — "Sensor stellen und Material einlegen"** (`LoadingChecklist`)

- Diagram (§7.8) with a two-option toggle "Sensor" | "Mit Material". It starts in
  "Sensor" (no media drawn); ticking checklist item 2 switches it to "Mit Material".
- Target line (large, under the diagram), from `targetText(material)`; {3,4} =
  `formatScaleDe(sensor_scale)` (decimal comma, 3.0 → "3"), {4} =
  `formatMmDe(|targetOffsetMm(material)|)`, right for + and left for −:
  - `sensor_scale` ≠ 3: "Zeiger ▲▼ auf {3,4} der Skala – ca. {4} mm {rechts|links} der Mitte"
  - `sensor_scale` = 3: "Zeiger ▲▼ auf 3 der Skala – Mitte der Materialbahn"
- **Current position** (optional; never gates [Weiter], never stored or sent): a number
  input labelled "Zeiger steht jetzt auf …" (`inputmode="decimal"`, placeholder "z. B. 3,0",
  decimal comma accepted, parsed by `parseScaleInput`). A valid reading draws the "Ist"
  pointer in the diagram (§7.8) and shows `scaleShiftText(current, sensor_scale)` under the
  input: "≈ {5} mm nach {rechts|links} schieben" ({5} =
  `formatMmDe(|scaleToX(target) − scaleToX(current)|)`, §7.8; current 2,9 and target 3,4 →
  "≈ 5 mm nach rechts schieben"), or "Zeiger steht richtig" when the difference is 0 mm.
  Not a number or outside 0,5–5,5 → "Bitte einen Wert zwischen 0,5 und 5,5 eingeben" and no
  "Ist" pointer. Empty → nothing.
- Caption: "Skala und Sensor-Schlitten nach Foto des Druckers (13.10.2026). Zielposition: WAGO-Handhabungshinweis, auf die Skala Ihres Druckers übertragen (ca.)."
- Heading "In dieser Reihenfolge:"; checklist (all must be ticked for [Weiter]):
  1. roller 258-5006: "Andruckwalze 258-5006 (schwarz, glatt) ist eingesetzt";
     258-5007: "Andruckwalze 258-5007 (dunkelgrün, gerillt) ist eingesetzt – laut WAGO nur für WMB-Inline 2009-113/-114/-115"
  2. "Sensor-Schlitten verschieben, bis der Zeiger auf {3,4} der Skala zeigt" ({3,4} =
     `formatScaleDe(sensor_scale)`; 3.0 → "… bis der Zeiger auf 3 der Skala zeigt")
  3. internal: "Rolle auf den internen Rollenhalter setzen und das Material durchfädeln";
     external: "Externen Abroller hinter den Drucker stellen (gleiche Höhe, in einer Linie). Abrollrichtung links: Material gegen den Uhrzeigersinn durch den hinteren Schlitz führen"
  4. max: "Materialführungen ganz öffnen";
     fit, `web.source` ≠ estimate: "Materialführungen auf 1 mm + {web} mm + 1 mm stellen – das Material darf nicht klemmen";
     fit, estimate: "Materialführungen an den Trägerrand anlegen – Trägerbreite ≈ {web} mm (geschätzt), je 1 mm Luft"
  5. "Farbband ist eingelegt"
  6. "Deckel ist geschlossen", with the ℹ line under it (not a checkbox): "Beim Schließen
     des Deckels kann der Drucker selbst einmessen und Material einziehen (nicht am Drucker
     geprüft)." [Unverified → T3]
- Hints under the checklist (ℹ, never gating): `sensorTrack` result + `visibleHints(material)`
  (§3.3), footer "Einschätzung von SMPL, keine WAGO-Angabe."
- [Weiter] label: "Weiter – Material ist eingelegt" → `activateMaterial(sid, material_id)`.

**Step 3 — "Einstellungen übertragen"** (`ApplyPanel`)

- Text: "SMPL stellt den Drucker auf „{name}“ ein: Sensor {Durchlicht|Reflex|Automatisch|kein Sensor} und Etikettengröße. Laut EZPL-Handbuch bewegt dieser Schritt kein Material."
- [Übertragen] → `applyMaterialSettings`. Result:
  - commands in a monospace list inside an `overflow-x: auto` box;
  - `confirmed === true`: "✓ Drucker meldet: Breite {W} mm, Etikett/Spalt {stored_q}, Sensor {Durchlicht|Reflex}"
  - `confirmed === false`: "⚠ Drucker meldet andere Werte:" + `mismatches` list + [Erneut übertragen]
  - `confirmed === null`: "ℹ Der Drucker hat keine Werte zurückgemeldet – das Einmessen prüft das Ergebnis."
- [Weiter] enabled after any successful send.

**Step 4 — "Einmessen"** (`SensePanel`)

- Text: "Der Drucker zieht jetzt Material ein und misst Etikett und Spalt – wie die Kalibriertaste auf der Rückseite."
- Stop instruction, visible **from the start** of this step (before and during sensing),
  as a highlighted ⚠ line: `FEED_STOP_HINT` ("Läuft zu viel Material durch: Deckel
  öffnen – der Drucker stoppt (nicht am Drucker geprüft).").
- [Einmessen starten] → `ConfirmFeedDialog` (command variant, §7.7) → `startAutosense("command")`.
- Link: "Drucker reagiert nicht? Mit der Kalibriertaste einmessen" → `ConfirmFeedDialog`
  (button variant) → `startAutosense("button")` → text "Jetzt die Kalibriertaste auf der Rückseite des Druckers 1 Sekunde gedrückt halten." and the button [Ergebnis abfragen] (→ verify).
  With `status_answered === false` the panel does not poll at all; it shows that text and
  [Ergebnis abfragen] only.
- While polling: spinner + "Drucker misst … ({code_text}) · {elapsed} s · erwartet:
  {autosense_cost_hint}", and the poll's `message` (when non-empty) as a ⚠ line under it
  (no reply, "Dauert länger als erwartet …").
- `phase:"done"` → `verifyMeasurement` → step 5. `error`/`timeout` → `message` (or
  `code_text` when `message` is empty) + [Ergebnis abfragen] (verify) and [Zurück zum
  Sensor] (step 2).
- 409 `printer_not_ready` → "{message}. {action_text}" + [Erneut versuchen];
  409 `no_status_reply` → message + the button-variant link highlighted; following it calls
  `startAutosense("button")`, which the server accepts with a silent STATUS (§4.6).
- **Switch mode** (`verifyWithoutSensing`, set by [Auf „X“ umstellen], §7.5): the panel
  shows neither [Einmessen starten] nor the button link, only the text "Gemessen wurde
  bereits – SMPL bewertet die Messung jetzt für „{name}“." and [Ergebnis prüfen] (→ verify).
  The step line stays "Schritt 4 von 5".

**Step 5 — "Ergebnis"** (`VerdictCard`, §7.5) → [Speichern] →
`saveCalibration({notes:"", accept_verdict, pattern:null})` → toast "Gespeichert – „{name}“ ist eingemessen." (match) / "Gespeichert – Ergebnis ohne Bestätigung." (accepted) → close (the server already released the session; the hook's unmount DELETE then answers 204 and changes nothing).

**Cancel** (any step): before step 2's [Weiter] → close immediately (`endCalibrationSession`).
Afterwards a dialog "Einrichtung abbrechen?" with one of:
- activated, not applied: "„{name}“ ist jetzt als eingelegtes Material gewählt. Die Sensor-Einstellung wurde noch nicht übertragen."
- applied, not sensed: "„{name}“ ist gewählt und die Einstellungen wurden an den Drucker übertragen. Das Einmessen fehlt noch."
- sensed, not saved: "Die Messung wird nicht gespeichert."
Buttons [Einrichtung beenden] (→ DELETE session) and [Weiter einrichten].

### 7.5 Verdict card (`VerdictCard.tsx`)

- Heading icon by verdict: match ✓, mismatch/other_material/gap_on_continuous ⚠,
  no_gap/printer_error ✗, no_result/unchecked ℹ — always with the server `title` text
  (status never by colour alone).
- `detail`, then `notes[]` as small lines.
- Table "Profil · Gemessen · Abweichung" with rows "Etikett", "Spalt", "Teilung" (die-cut)
  or only "Spalt" (continuous); footer "Toleranz ± {tol} mm · gerechnet mit 12 Punkten je mm".
- Sensor row: `sensor_ok` true "Sensor: {Durchlicht|Reflex} ✓"; false
  "Sensor: {kind} – erwartet {expected} ⚠"; null "Sensor: {kind}".
- Freshness line: busy_seen "Messung beobachtet (Drucker meldete „misst“)"; q_changed /
  qd_changed "Neues Messergebnis vom Drucker"; none "Kein Nachweis einer neuen Messung".
  (`from_latch` adds the server's `notes[]` line about the earlier measurement; nothing else.)
- Buttons, exactly from `offers`:
  - `save` → [Speichern]
  - `accept_anyway` → [Trotzdem speichern] (sets `accept_verdict: true`)
  - `switch_material` → one button per suggestion: [Auf „{name}“ umstellen] →
    `activateMaterial(sid, id)` → sets `verifyWithoutSensing = true` → quick step 2 /
    wizard step 3 for that material (checklist, ends with `activate` on the same id) →
    step 3 apply → step 4 in switch mode: [Ergebnis prüfen] (verify, no new sensing)
  - `resense` → [Sensor prüfen und erneut einmessen] → `verifyWithoutSensing = false` → step 2
  - `requery` → [Ergebnis erneut abfragen] → verify
  - `reapply` → [Sensor erneut übertragen] → apply, then verify (the latched measurement
    keeps the verdict)
- `verifyWithoutSensing` is frontend state in `useCalibrationSession`: set only by
  [Auf „X“ umstellen], cleared by any `startAutosense` call and by `resense`. The server
  needs no flag for it: verify judges the latch whenever one exists (§4.7).
- In the full wizard, [Speichern]/[Trotzdem speichern] become [Weiter]/[Trotzdem fortfahren]
  (the record is saved in step 6).

### 7.6 Full wizard "Material einrichten: {name}" (`CalibrationWizard.tsx`, `settings:manage`)

Opened from the admin card's [Einrichten]. Starts a `mode:"full"` session for the material.
Step line "Schritt {n} von 6". Same cancel dialog as §7.4, plus — when offsets were already
saved in step 5 — the line "Bereits gespeichert: Versatz Vorschub {x} mm, Versatz quer {y} mm."

- **Subject material** = `session.material_id` (not the material the wizard was opened
  for). After [Auf „X“ umstellen] the title becomes "Material einrichten: {X}", and step 5/6
  PUTs and the save go to X. The wizard re-reads `LabelMaterial` for X from the latest
  settings it holds.
- **Revision**: every PUT sends `latestRevision` from `useCalibrationSession` — the highest
  of `LabelPrinterSettings.revision` (GET/PUT responses) and `CalibrationSession.config_revision`
  (every session response, including `activate`). Opening [Einrichten] on a material that is
  not active therefore works: step 2 PUT → r+1, step 3 `activate` → `config_revision` r+2,
  step 5 PUT sends r+2.
- Same not-configured and phase/applied gating as §7.4.

1. **"Drucker prüfen"** (`StepPrinter`, `PrinterStatusPanel` with `full=true`):
   - Lines: "Status: {code_text}", "Sensor: {Durchlicht|Reflex|unbekannt} ({sensor_line})",
     "Am Drucker gespeichert: Breite {W} mm · Etikett/Spalt {stored_q} · Schwärzung {H} · Geschwindigkeit {S} · Stopp {E} mm",
     "Letzte Messung: {len} + {gap} mm ({dots} + {dots} Punkte)",
     "Zeilenversatz: {~Q} Punkte ({mm} mm)", "Firmware: {fw}"; disclosure "Rohdaten" with
     `raw_config` in a `pre` inside its own `overflow-x: auto` box.
   - "Grundeinstellung für alle SMPL-Drucke: Schwärzung {d} · Geschwindigkeit {s} · Stopp {e} mm" [Ändern] → three inputs + [Speichern] (`PUT printer`). If the readback differs from the baseline: "Der Drucker steht auf Schwärzung {h} · Geschwindigkeit {s} · Stopp {e} mm – SMPL sendet mit jedem Druck die Grundeinstellung." + [Druckerwerte als Grundeinstellung übernehmen].
   - Row offset: unpinned → "Zeilenversatz am Drucker: {v} Punkte." [Als Bezugswert merken] (`PUT printer {row_offset_dots}`); pinned and equal → "Zeilenversatz {v} Punkte entspricht dem Bezugswert ✓"; drift → the warning message.
   - Warnings list; [Weiter].
2. **"Material und Sensor"** (`StepMaterial`): `LabelMaterialForm` (sections Grunddaten,
   Schwarzmarke, Sensor, Einlegen, Material auf der Rolle) → [Speichern und weiter]
   (`PUT material`, skipped when unchanged).
3. **"Sensor stellen und einlegen"**: `LoadingChecklist` (identical to §7.4 step 2; ends with `activate`).
4. **"Übertragen und einmessen"**: `ApplyPanel`, then `SensePanel`, then `VerdictCard`.
   [Weiter] needs `match` or [Trotzdem fortfahren] (stored in wizard state as `accept_verdict`).
5. **"Messmuster"** (`StepPattern`):
   - `pattern_supported === false` (210-805): only the text "Messmuster für mehrbahniges
     Material folgt nach dem Praxistest (T8)." and [Überspringen]; no print button, no
     inputs, no offset PUT.
   - Text: "Das Messmuster zeigt, wo SMPL druckt. Miss die Abstände mit dem Messschieber – SMPL rechnet die Korrektur aus."
   - [Messmuster drucken] → `ConfirmFeedDialog` (pattern variant) → `printMeasuringPattern`.
     A second click while the request runs is ignored (button disabled); the server also
     refuses a parallel print (§6.2).
   - `LabelPatternPreview` from the returned geometry; inputs (decimal comma accepted):
     "Rand vorne (A)", "Rand hinten (B, optional)", "Rand links (L)", "Rand rechts (R, optional)",
     "Lineal 10 → {to} gemessen (optional)" (die-cut with ruler). Continuous: only L and R.
   - Live results (`offsetCorrections`): "Versatz Vorschub: {old} → {new} mm"; guide fit:
     "Versatz quer: {old} → {new} mm"; guide max: "Seitliche Lage bei ganz offener Führung nicht festgelegt – kein Korrekturwert (L − R = {x} mm)";
     info "Länge: Druckbild {e} mm {kürzer|länger} als erwartet – Längen-/Maßstabsabweichung, wird nicht als Versatz übernommen";
     info "Breite weicht um {e} mm ab – Profilbreite prüfen";
     info "Maßstab ≈ {x} Punkte je mm (SMPL rechnet mit 12) – nur zur Information";
     clamped values carry the `offset_limits` info line of §4.11 (the PUT sends the clamped
     value, so the server's limit check never rejects a computed correction).
   - Inputs accept 0–30 mm (ruler: up to 800 mm); outside → "Bitte einen Wert zwischen 0
     und 30 mm eingeben" under the field and no request (`PatternMeasurementsIn` keeps its
     pydantic ranges as a backstop).
   - Buttons: [Übernehmen und neu drucken] (PUT offsets with revision → pattern dialog → print; shown while |correction| > 0,3 mm), [Übernehmen] (PUT), [Überspringen].
   - After a PUT: "Gespeichert: Versatz Vorschub {x} mm" / "… Versatz quer {y} mm".
6. **"Druckwerte und Abschluss"** (`StepFinish`):
   - "Schwärzung (leer = Grundeinstellung {d})", "Geschwindigkeit (leer = Grundeinstellung {s})", "Stopp-Position in mm (leer = Grundeinstellung {e})".
     Warnings: darkness > 12 "WAGO Smart Script warnt ab Schwärzung 12, WAGO ab 14 – das Farbband kann beschädigt werden."; speed > 2 "WAGO empfiehlt Geschwindigkeit 2 (50,8 mm/s)."
   - [Probedruck] → pattern print (after saving the values); hidden when
     `pattern_supported` is false.
   - "Notiz (optional, max. 200 Zeichen)" (`maxLength=200`).
   - Range errors of the print values come back as 422 `invalid_material` with the German
     §3.8 message, shown above the buttons.
   - Summary: verdict title, offset changes, print values.
   - [Speichern] → `PUT material` (if print values changed) → `saveCalibration({notes, accept_verdict, pattern})` → toast "Gespeichert – „{name}“ ist kalibriert." → close + reload settings.
   - 409 `stale_revision` anywhere → "Einstellungen wurden inzwischen geändert – bitte neu laden" + [Neu laden] (reload settings, keep wizard state).

### 7.7 Feed confirmation (`ConfirmFeedDialog.tsx`)

Nothing that feeds is called before the user confirms here. Variants:

| Variant | Title | Body | Buttons |
|---|---|---|---|
| command | "Material wird eingezogen" | "Beim Einmessen zieht der Drucker Material ein – bei „{name}“: {autosense_cost_hint}. Danach liest SMPL das Messergebnis aus." + ⚠ line `FEED_STOP_HINT` | [Einziehen lassen] [Abbrechen] |
| button | "Einmessen mit der Kalibriertaste" | "Nach „Los“ die Kalibriertaste auf der Rückseite 1 Sekunde gedrückt halten. Der Drucker zieht dabei Material ein – bei „{name}“: {autosense_cost_hint}." + ⚠ line `FEED_STOP_HINT` | [Los] [Abbrechen] |
| pattern | "Messmuster drucken" | "SMPL druckt ein Messmuster auf „{name}“: {pattern_cost_hint}." | [Drucken] [Abbrechen] |

Hints are shown verbatim (they carry their own "Schätzung"/"unbekannt", §3.3).

The confirm button is not the default focus (Abbrechen is), and Enter does not confirm.

### 7.8 Sensor positioning diagram

**Constants module** `src/components/labelPrinter/sensorGeometry.ts` — the only place any
geometric number of the diagrams lives (components import it; no literals elsewhere):

```ts
/** Sensor-area and media-path geometry of the owner's WAGO 258-5101, in millimetres.
 *  x = across the media path, 0 = scale reading 3 = media centre line, + = right as seen
 *  from the front with the lid open; a scale reading r sits at
 *  x = (r − scaleCentre) · scaleUnitMm (see `scaleToX`). y = along the feed, 0 = rear
 *  (roll side), increasing toward the operator.
 *  SOURCE: "Foto des Druckers 13.10.2026". The x values of the scale, slot, carriage and
 *  pointer are measured against the printed millimetre ticks (≈ ±0,5 mm); the y bands and
 *  depths are a drawing layout that follows the photo's order, not measurements (the photo
 *  is not perspective-corrected). Guide opening and the side view stay schematic.
 *  Per-material target readings are NOT here: they are the profile's `sensor_scale` (§3.3),
 *  approximate ("ca.") until T0. */
export const SENSOR_GEOMETRY = {
  measured: true,                 // scale / slot / carriage geometry from the photo
  source: "Foto des Druckers 13.10.2026",
  // printed scale on the rear side of the sensor slot
  scaleUnitMm: 10,                // one scale number = 1 cm
  scaleCentre: 3,                 // reading of the media centre line
  scaleTickFrom: 0.6,             // first printed tick (reading)
  scaleTickTo: 5.4,               // last printed tick (reading)
  scaleTickStep: 0.1,             // short tick every millimetre
  scaleNumbers: [1, 2, 3, 4, 5],  // long tick + number; medium tick at every .5
  tickLengthMm: { short: 1.2, medium: 2.5, long: 5.0 },
  scaleNumberSizeMm: 2.4,         // font-size of the numbers 1–5
  // slot and carriage
  slotReadings: [-1.1, 7.1],      // slot / track ends as readings (≈ −41 … +41 mm)
  carriageWidthMm: 26,            // total, incl. the side wings
  carriageCoreWidthMm: 9,         // central block that carries the pointer
  carriageDepthMm: 8,
  pointerWidthMm: 3.5,            // base of ▲ and of ▼
  pointerHeightMm: 2.4,           // each triangle
  pointerWindowMm: 1.8,           // optical window between ▲ and ▼; sensing point at its centre
  beamSpotRadiusMm: 1.0,          // guess
  // media guides
  guideJawWidthMm: 3,
  guideFitClearanceMm: 1,
  guideMaxHalfOpeningMm: 30,      // unknown; 60 mm is the media maximum
  viewBox: { x: -44, y: 0, width: 88, height: 66 },
  bands: {
    guide: [2, 12], housing: [14, 42], scaleNumbers: [15, 17.5], tickBaseline: 24,
    slot: [25, 35], sensingY: 30, shiftArrowY: 36.5, calloutTarget: 38.5, calloutActual: 41,
    breakMark: 44, platen: [47, 53], printLine: 50, tearEdge: 60,
  },
  zoomHalfWidthMm: 8,             // "Lupe": viewBox (target − 8, 14, 16, 28)
  zoomBand: [14, 42],
  silverMaterialIds: ["wago-210-804", "wago-210-824", "wago-210-812"],
  sideView: {
    viewBox: { x: 0, y: 0, width: 160, height: 70 },
    rollInternal: { cx: 28, cy: 38, r: 13 },
    rollExternal: { cx: 10, cy: 38, r: 9 },
    housingX: [22, 150],
    rearSlotX: 44, guideX: 56, sensorX: 82, platenCx: 116, platenR: 7, tearX: 142,
    pathY: 38,
  },
} as const;

/** Scale reading → x in mm (0 = centre line), rounded to 0,1 mm: 3.4 → 4, 2.5 → −5. */
export const scaleToX = (reading: number): number =>
  Math.round((reading - SENSOR_GEOMETRY.scaleCentre) * SENSOR_GEOMETRY.scaleUnitMm * 10) / 10;
```

`targetOffsetMm(material)` (`utils/labelCalibration.ts`) = `scaleToX(material.sensor_scale)`;
no other code converts readings to millimetres.

**Top view** `LabelSensorDiagram` props: `{ material: LabelMaterial; state: "sensor" | "loaded"; zoom?: boolean; actualScale?: number | null }`
(`actualScale` = the valid reading from "Zeiger steht jetzt auf …", §7.4).
Looking down into the open printer from the front; rear at the top, feed direction ↓.
SVG user units are millimetres (`viewBox="-44 0 88 66"`), so everything is to scale except
the break between sensor and print line. Layers, top to bottom of the drawing order:

1. Interior background (`.lc-bg`).
2. **Guides** (y 2–12, `.lc-guide`, green): two **jaws**, each `guideJawWidthMm` wide,
   extending outward from its inner (contact) edge. `fit`: inner edges at
   ±(`web_width_mm`/2 + `guideFitClearanceMm`). `max`: inner edges at
   ±`guideMaxHalfOpeningMm`, small text "ganz offen" between them.
3. **Housing plate** (y 14–42, `.lc-housing`) with the **printed scale**
   (`.lc-scale`, `--lc-housing-mark`) along the rear edge of the slot: ticks at every
   reading from `scaleTickFrom` to `scaleTickTo` in steps of `scaleTickStep` (0,6 … 5,4 →
   49 ticks), x = `scaleToX(reading)`, growing upward from `bands.tickBaseline`: short
   (`tickLengthMm.short`) at every millimetre, medium at every .5 (1,5 · 2,5 · 3,5 · 4,5),
   long at 1 … 5 with the number centred above it in the `scaleNumbers` band. The tick at
   the target reading (`sensor_scale`) is **highlighted** (`.lc-target-tick`, `--lc-target`,
   double stroke width; if the target is not a printed tick, an extra tick is drawn there).
   No dot rows, no ⬇/▽ marks.
4. **Sensor slot** (y 25–35, `.lc-slot`) from x = `scaleToX(slotReadings[0])` to
   `scaleToX(slotReadings[1])` (≈ −41 … +41), with the **carriage** centred at
   x = `targetOffsetMm(material)`: the body `carriageWidthMm` × `carriageDepthMm`
   (`.lc-carriage`, side wings) with the central block `carriageCoreWidthMm` wide
   (`.lc-carriage-core`) and on it the **▲▼ pointer** (`.lc-pointer`): ▲ (base
   `pointerWidthMm`, height `pointerHeightMm`, apex toward the scale, apex on the target
   x), the optical window `pointerWindowMm` high centred on `bands.sensingY`, ▼ below it.
5. **Callouts** (below the slot, in the housing): "Ziel: {3,4}" (`formatScaleDe`, a small
   `.lc-callout` box in `--lc-target`) centred on the target x at `bands.calloutTarget`.
   When `actualScale` is set: an **"Ist" pointer** (`.lc-actual`, `--lc-actual`): a dashed
   outline ▲ at x = `scaleToX(actualScale)` on the tick baseline, a dashed outline of the
   carriage body at that x, the label "Ist: {2,9}" at `bands.calloutActual`, and — when Ist
   and Ziel differ — a horizontal arrow at `bands.shiftArrowY` from the Ist x to the target
   x. Without `actualScale` none of these are drawn.
6. **Media** — only in `state === "loaded"`, drawn after the sensor so the user first sees
   where the pointer must go (critique M10), `fill-opacity: .6` so the pointer stays visible:
   - liner (`.lc-liner`) of width `web.liner_width_mm`; unknown → dashed outline of the web
     width with the legend "Trägerbreite nicht hinterlegt";
   - die-cut: `web.lanes` columns of labels `label_across` wide, `physical_length` long,
     gaps `gap_mm`, lanes symmetric about x = 0 (scale 3) with `lane_gap_mm` between them;
     phase so a gap is centred on the sensing point (y = `bands.sensingY`); fill silver for
     `silverMaterialIds`, else white; 210-805 therefore shows **two lanes** with the slit
     at x = 0;
   - continuous: a band `width_mm` wide;
   - black mark: grey media with black bars `mark_width_mm` long under the pointer;
   - guide `max`: media drawn centred with a dashed outline and the legend
     "Lage bei offener Führung nicht festgelegt".
7. **Beam spot** at (target, `bands.sensingY`), radius `beamSpotRadiusMm`: see_through two
   concentric rings; reflective a "V" glyph; auto dashed circle; none grey dot.
8. **Break mark** (zigzag at y 44) with the small text "nicht maßstäblich".
9. **Platen roller** (y 47–53): `.lc-roller-5006` black, `.lc-roller-5007` green with a
   centre groove line; print line dashed at y 50 (`--lc-accent`).
10. **Tear-off edge** at y 60, serrated.

While `measured` is false (only if the constants are ever reset to estimates), a small "≈"
is drawn after the number 5 of the scale; with `measured: true` the drawing has no "≈".

Glyphs (▲, ▼, the "Ist" ▲, the shift arrow) are SVG paths, not text. The scale numbers
1–5 (font-size `scaleNumberSizeMm`), the callouts and mm labels (font-size 2.6) are
`<text>` with a `paint-order: stroke` halo.

**Zoom ("Lupe")**: the same component rendered with `zoom` → `viewBox =
"{target−8} 14 16 28"`; shown beside the main view from 560 px container width, below it on
narrower screens. Makes the millimetre ticks, the pointer, the 5 mm tube and the 210-805
slit legible on a phone.

**Under the SVG (HTML, not inside it)**: the target line, the "Zeiger steht jetzt auf …"
input with its shift line, and the caption from §7.4.

**Spot check** `sensorTrack(material, geometry)` (pure, `utils/labelCalibration.ts`) returns
`{ kind, text }` with `severity` always `"info"` — **never gates**:

| kind | text |
|---|---|
| `alternating` | "Etikett und Spalt laufen abwechselnd unter dem Sensor durch" |
| `liner_only` | "Der Sensor sieht nur den Trägerstreifen – keine Spalte erkennbar" |
| `edge` | "Der Sensor liegt an der Etiketten- oder Materialkante" |
| `off_material` | "Der Sensor liegt neben dem Material" |
| `continuous` | "Endlosmaterial läuft unter dem Sensor" |
| `mark_track` | "Die Schwarzmarke muss unter dem Zeiger durchlaufen" |

Rules: t = `targetOffsetMm(material)`, r = `beamSpotRadiusMm`, spot = [t − r, t + r]; the
web is assumed centred on scale 3 (x = 0); with guide `max` the text is
prefixed "Falls das Material mittig läuft: "; with `web.source == "estimate"` suffixed
" (Maße geschätzt)". Fully inside a lane → `alternating`; no overlap with any lane but
inside the liner → `liner_only`; no overlap with the liner/web → `off_material`; partial →
`edge`; continuous fully inside → `continuous`, partial → `edge`, outside → `off_material`.
Expected for the builtins at their default readings: 210-804/-824/-812 at 3,4 (t = 4) →
`alternating` (prefixed), 210-805 at 3,4 → `alternating` (inside the right lane), 211-501
and 2009-110 at 3 → `continuous`. With `sensor_scale` changed on a copy of the profile:
210-805 at 3 → `edge` (spot on the slit), 211-501 at 3,4 → `off_material`, 2009-110 at
3,4 → `continuous`.

**Side view** `LabelPathSideView` props `{ material }` (schematic, `viewBox 0 0 160 70`,
caption "schematisch, nicht maßstäblich"), feed left → right: roll (internal inside the
housing outline; external on an unwinder left of the housing with a counter-clockwise arc
arrow and the label "Abrollrichtung links") → rear slot → guide → sensor (see_through:
emitter below and receiver above the path with a dashed vertical beam; reflective: one unit
below with a V; none: grey unit) → platen (roller colour) with the head on the lid above it
and the ribbon loop → tear edge.

**Pattern preview** `LabelPatternPreview` props `{ geometry, offsets }`: the label to scale
with the box, letters A/L at their positions, dimension arrows "A", "B", "L", "R" from the
physical edges to the box lines, the ruler span "10 → {to}", and for continuous stock the
side lines with "L"/"R".

**Theme** (`styles/label-calibration.css`): every colour is a token on `.lc-diagram`;
classes only reference tokens.

```css
.lc-diagram {
  --lc-bg: var(--surface);  --lc-ink: var(--ink);  --lc-muted: var(--muted);
  --lc-accent: var(--accent);
  --lc-housing: #4a5563;  --lc-housing-mark: #f4f6f8;  --lc-slot: #1d232b;
  --lc-guide: #2f8a4c;  --lc-liner: #efe6cf;
  --lc-carriage: #15181c;  --lc-pointer: #000000;   /* outlined in --lc-housing-mark */
  --lc-target: var(--accent);  --lc-actual: #b7791f;
  --lc-label-silver: #c9ced6;  --lc-label-white: #ffffff;  --lc-mark: #111111;
  --lc-roller-5006: #1b1b1b;  --lc-roller-5007: #2f6b3a;
  --lc-ok: #1f8a4c;  --lc-warn: #b7791f;  --lc-bad: var(--danger);
}
:root[data-theme="dark"] .lc-diagram {
  --lc-bg: #1a2230;  --lc-ink: #e6edf5;  --lc-muted: #9fb0c3;
  --lc-housing: #2b3440;  --lc-housing-mark: #dfe6ee;  --lc-slot: #0c1016;
}
```

SMPL is light-only today (`styles.css` sets `color-scheme: light`), so there is
deliberately **no** `prefers-color-scheme` block — the diagram must not turn dark inside a
light app. The `data-theme="dark"` override is the hook for the future dark theme. Material,
roller, carriage and pointer colours are physical and stay the same in both themes, always
outlined in `--lc-ink` (the pointer in `--lc-housing-mark`, so black on black stays visible).

**Phone width**: SVG `width: 100%; height: auto; max-width: 560px`; at 343 px that is about
3.9 px/mm (the millimetre ticks are legible in the zoom). Nothing is wider than its container (the root uses `overflow-x: clip`); command
lists and raw data sit in their own `overflow-x: auto` boxes. Touch targets ≥ 44 px.

**Accessibility**: `role="img"`, `aria-labelledby` pointing at `<title>` and `<desc>`;
`<desc>` = `diagramDescription(material, state, actualScale)`, e.g. "Sensor-Zeiger auf 3,4
der Skala, etwa 4 mm rechts der Mitte; Etiketten 44 mm breit, Spalt 3 mm; Materialführung
ganz offen." With `actualScale` it adds "; Zeiger steht jetzt auf 2,9 – etwa 5 mm nach
rechts schieben". Checklist items are real checkboxes with labels; the verdict uses `role="status"`.

### 7.9 Profile form (`LabelMaterialForm.tsx`, title "Material bearbeiten: {name}")

| Section | Field labels (exact) |
|---|---|
| Grunddaten | "Name", "Artikelnummer", "Breite (mm, quer zum Druckkopf)", "Länge (mm, in Vorschubrichtung – leer = Endlos)", "Spalt (mm)" |
| Schwarzmarke (die-cut only) | checkbox "Material hat Schwarzmarken", "Markenbreite (mm)", "Abstand Marke → Etikettenanfang (mm)", radio "außerhalb der Marke (+)" / "innerhalb der Marke (−)" |
| Sensor | "Sensorart": "Durchlicht" / "Reflex" / "Automatisch (nur Etiketten)" / "Kein Sensor (nur Endlos)"; "Sensorposition (Skala 1–5, eine Nachkommastelle)" — number input (`inputmode="decimal"`, `step="0.1"`, decimal comma accepted) with the help text "3 = Mitte der Materialbahn, 1 Teilstrich = 1 mm" and, live under it, `targetText` for the entered value (e.g. "Zeiger ▲▼ auf 3,4 der Skala – ca. 4 mm rechts der Mitte"; shown only while `parseScaleInput` accepts the value — the PUT still sends any number, and the range error comes from the server) |
| Einlegen | "Materialführung": "ganz offen" / "1 mm + Breite + 1 mm"; "Zuführung": "interner Rollenhalter" / "externer Abroller"; "Andruckwalze": "258-5006 (schwarz, glatt)" / "258-5007 (dunkelgrün, gerillt – nur WMB-Inline)" |
| Material auf der Rolle | "Bahnen nebeneinander", "Etikett quer (mm)", "Etikett längs (mm)", "Abstand zwischen den Bahnen (mm)", "Trägerbreite (mm)", checkbox "Maße am Material nachgemessen" (sets `web.source = "measured"`) |
| Druck | "Schwärzung (0–19, leer = Grundeinstellung)", "Geschwindigkeit (2–4, leer = Grundeinstellung)", "Stopp-Position (mm, leer = Grundeinstellung)" |
| Versatz | "Versatz Vorschub (mm, {x_min} bis {x_max})", "Versatz quer (mm, {across_min} bis {across_max})" — numbers from `offset_limits` with decimal comma |

Builtins: each field in `overridden_fields` shows the tag "angepasst" and a [Standard]
button (adds the field to `reset_fields`). Hints box (ℹ list of `visibleHints(material)`). With "Kein Sensor"
selected, an ℹ line under the sensor radio: "Drucker erkennt dann vermutlich auch das
Materialende nicht (nicht am Drucker geprüft)." Buttons [Speichern] [Abbrechen]; PUT with
`revision`; every range error comes back as 422 `invalid_material` with the German §3.8
message, shown above the buttons (the form does no range validation of its own; the
inline "+ Eigenes Material" PATCH gets the same German text as a 400 string detail).

### 7.10 Admin card changes (`AdminLabelPrinterCard.tsx`)

- Types and API calls move out (§7.2); the card stays < 800 lines.
- "Eingelegtes Material": a `PrinterStatusPanel` line on demand — [Status abfragen] →
  `getPrinterStatus(full=true)` → "● {code_text} · Sensor {Durchlicht|Reflex|unbekannt} · letzte Messung {len} + {gap} mm"; never fetched on page load.
- A banner when `settings.session` is set: "Einrichtung läuft: {user_name} ({Schnell|Vollständig}) seit {HH:MM}" ({HH:MM} formatted locally from `session.acquired_at`).
- Staff switch: a checkbox "Schnellablauf „Material gewechselt“ für die Werkstatt
  freigeben" bound to `label_calibration_staff_enabled` (`PUT printer` with `revision`),
  hint under it: "Erst freigeben, wenn die Praxistests T0b, T1, T2 und T5 Ergebnisse haben.
  Bis dahin sehen nur Administratoren den Schnellablauf."
- Each material row: `CalibrationChip`; an info line "Walze {roller} · {Rollenhalter innen|Abroller extern} · Sensor auf {3,4} der Skala" ({3,4} = `formatScaleDe(sensor_scale)`); buttons [Material gewechselt] (quick flow preselected), [Einrichten] (wizard), [Bearbeiten] (form), [Entfernen] (custom only, as today).
- The radio PATCHes only `{active_material_id, revision}` — **no apply** — and then shows "Rolle gewechselt? [Material gewechselt …]".
- "+ Eigenes Material" stays the inline form; its PATCH sends `revision` and the GET objects echoed back (safe per §6.4).
- `CalibrationChip` texts (`calibrationChip` helper): no record → "Nicht eingemessen";
  stale → "Profil seit Messung geändert"; verdict match & quick → "Eingemessen {dd.mm.yyyy}";
  match & full → "Kalibriert {dd.mm.yyyy}"; accepted non-match → "Gespeichert mit Abweichung {dd.mm.yyyy}";
  `no_result`/`unchecked` accepted → "Ungeprüft gespeichert {dd.mm.yyyy}". Never "verifiziert".

### 7.11 Quick entry (`LabelPrinterQuickEntry.tsx`)

A `werkstatt-action-btn` with a printer icon and the label "Etikettendrucker"
(`title="WAGO-Etikettendrucker: Material gewechselt"`). Click opens `MaterialChangeSheet`
with no preselection. Rules, in order:

1. Without `werkstatt:manage` and without `settings:manage` → renders nothing and fetches
   nothing.
2. Otherwise it fetches `GET W` once on mount (DB only, no printer I/O). While loading or on
   a fetch error it renders nothing.
3. Caller without `settings:manage` (`can_full === false`) and `staff_enabled === false` →
   renders nothing (the quick flow stays admin-only until the physical tests, §9).
4. `configured === false` → renders the button **disabled** with
   `title="Kein Etikettendrucker konfiguriert"`.
5. Else the enabled button.

---

## 8. Tests

Memory note for whoever runs them: one pytest session per worktree, gate on the exit code.

### 8.1 Backend (pytest, `apps/api/tests/`)

**Fake printer** `tests/fake_ezpl_printer.py` (helper module) + fixture `fake_printer` in
`tests/conftest.py`:

```python
class FakeEzplPrinter:
    """Threaded TCP server on 127.0.0.1:0 that speaks enough EZPL for the calibration code."""
    host: str; port: int
    received: list[bytes]            # full bytes of every connection, in order
    max_concurrent: int              # highest number of simultaneous connections seen
    # printer state (initialised from tests/fixtures/ezpl_config_258_5101.txt)
    status_code: str = "00"; pending: int = 0
    stored_q: str = "97,2"; stored_w: str = "34"; h: str = "12"; s: str = "2"; e: str = "0"
    row_offset: str = "-19"; sensor: str = "see_through"; sensing: str | None = None
    qd: tuple[int, int] | None = (1164, 30)
    # scripting
    sense_busy_polls: int = 2              # STATUS answers "60,00000" this often after ~S,SENSOR
    sense_result_qd: tuple[int, int] | None = (1164, 30)
    sense_rewrites_q: bool = True          # stored ^Q := trunc(qd/12)
    sense_final_code: str = "00"
    sense_sensor_after: str | None = None  # e.g. "reflective" to simulate ^G being replaced
    silent: set[str] = set()               # {"STATUS", "CONFIG"} → accept, never answer
    requires_immediate: bool = False       # STATUS answers only after ^XSET,IMMEDIATE,1
                                           # (SMPL never sends it: proves the button fallback)
    q_write_updates_qd: bool = False       # every ^Q write sets qd := (q_len·12, q_gap·12)
                                           # (the unverified echo of §4.6/§4.7)
    status_override: list[str] = []        # scripted STATUS codes, consumed one per query
                                           # (e.g. ["99"], or ["04"] while a pattern is sent)
    truncate_config: bool = False          # omit the "--------"/"---" trailer
    split_reply: bool = False              # send replies in two chunks 50 ms apart
    push_error: str | None = None          # e.g. "ERROR02" before every reply
    refuse: bool = False                   # close the listening socket (unreachable)
    reply_delay_s: float = 0.0             # delay before handling a print job (parallel-click tests)
    jobs_printed: list[list[str]]          # every ^L … E job with its effective ^C/^P count
```

It applies setup lines (`^Q`, `^W`, `^G0/1/2` → sensor line `See.:0.1 1.7 1.0 [1.6_58]` or
`Reflective Volt:2.4 3.1 3.9(1.4_1.1)`, `^H`, `^S`, `^E`, `^C`, `^P`, `^XSET,SENSING,n`,
`^XSET,IMMEDIATE,1`), keeps `^C`/`^P` as persistent state (so a test can show a leftover
`^C3` or `^P2` multiplying a later job that states neither), answers `~S,STATUS` and
`^XGET,CONFIG` (the fixture text with current values substituted), runs the sense script on
`~S,SENSOR`, keeps the connection open after a reply (to prove terminator handling) and
records everything. A helper
`configure_fake(client, admin_token, fake)` PATCHes host/port. Timing constants
(`APPLY_SETTLE_S`, `AUTOSENSE_MIN_WAIT_S`, timeouts) are monkeypatched small; the I/O lock
path is monkeypatched into `tmp_path`.

**Fixtures**

- `tests/fixtures/ezpl_config_258_5101.txt` — the probe reply of Appendix A verbatim, CRLF.
- `tests/fixtures/label_jobs_a9c335f.json` — captured **before any code change** by running
  the base-commit renderers in the test environment (no logo file present) for:
  210-804 machine label; 210-804 quad with four entries; 210-812 kompakt; 210-805 mini
  "F1.1"; 2009-110 rail strip `[("F1", 17.5), ("F2", 35)]` size 36; 2009-110 block label;
  211-501 freetext "X1" copies 3; article label; box label; type label copies 2. Stored as
  `{name: [lines…]}`. Commit it first.

**Files and cases**

| File | Cases |
|---|---|
| `test_label_printer_transport.py` | split reply joined; CONFIG ends on `---` within < 1 s although the fake keeps the socket open; `--------` alone does not terminate; `ERROR02` removed and reported; truncated reply → `complete False` after the deadline; silent → empty within deadline + 0.5 s; refused → `LabelPrinterUnreachable`; 64 KiB cap; `PrinterQuery` rejects anything else; a query and a `_ship` from two threads never overlap (`max_concurrent == 1`); I/O lock timeout → `LabelPrinterIoBusy` (and `isinstance(…, LabelPrinterBusy)`); `read_status` with a silent STATUS sends **no** bytes other than the query (no `^XSET`), also while another user's session is active; GET /status during another user's session → 200 (reads pass), I/O lock timeout → 409 `printer_busy` |
| `test_label_errors_module.py` | `werkstatt_label_errors` imports no `app.services.werkstatt_label*` module (inspect `sys.modules` after a fresh import in a subprocess); `wl.LabelPrinterUnreachable is werkstatt_label_errors.LabelPrinterUnreachable`; same for `MaterialValidationError` via `werkstatt_label_materials`; `LabelPrinterSessionBusy` and `LabelPrinterIoBusy` subclass `LabelPrinterBusy` |
| `test_app_settings_text_column.py` | `AppSetting.__table__.c.value.type` is `Text`; worst-case blobs: six records with 60 poll codes, a pattern and 200-char notes, four full custom profiles plus builtin overrides, a lock blob with 60 poll codes, 20 writes and a full verify — each serialises, stays under `STATE_BLOB_BUDGET` (65536), and round-trips through `set_runtime_setting`/`get` unchanged; caps: `poll_codes` > 60 keeps the first 60, `writes_since_sense` > 20 keeps the last 20. (The PG16 upgrade/downgrade and `check_schema_drift.py` run by hand, §3.1.) |
| `test_label_printer_status_parse.py` | golden probe → see_through, 1164/30/1194, stored `97,2`, `^W34`, `^H12`, `^S2`, `~Q-19`, `^E0`, thermal transfer, 300 dpi, firmware "Smart Printer V5.UW0m"; empty/garbage/truncated → all None, no exception; "Reflective Volt:…" → reflective; "Gap Sensor AD : 129 162 195" → unknown with the raw line kept; `^QD0,0` → absent; `parse_status("ERROR02\n00,00000")` → ("00", 0); warnings: drift, `^AD`, incomplete, resolution; no "^W differs" warning exists |
| `test_label_material_storage.py` | legacy v1 blob (all keys at defaults, 210-804 `x_offset 1.5`) → only that override, sensor fields from code; write → `format 2`, builtins store only overrides, `revision + 1`; **healing**: save once, monkeypatch a builtin default (2009-110 `web.liner_width_mm` 11 → 11.5), read → new value; overridden field keeps the override; malformed `sensor_mode "laser"` → default, profile kept; PATCH list: custom missing → removed, builtin missing → 400, unknown id → created; echo of the **new** GET shape → stored blob unchanged except revision; echo after a baseline change → profile `darkness` stays null; PATCH without `host` keeps host, `""` clears; PUT `reset_fields`; PUT explicit null on `width_mm` → 422; validation messages of §3.8; `dry_render_checks` rejects `x_offset −5` on 2009-110 (422); **format-2 builtin override without `width_mm`** (`{"id": "wago-210-804", "x_offset_mm": 1.6}`) survives a read with `x_offset 1.6` and every other field from code; a custom entry without `width_mm` is dropped; **German ranges through the API**: PUT `x_offset_mm: 12` → 422 `invalid_material` with "Versatz Vorschub muss zwischen −5 und 10 mm liegen", PATCH item `x_offset_mm: 12` → 400 with the same text, PUT printer `speed_ips: 5` → 422 `invalid_printer_settings` German; across `+0,5` on 2009-110 (outside `offset_limits`) → 422 naming the limits; **PATCH error table** (§6.3): stale `revision` → 409 dict with `code`, `revision`; explicit `sensor_mode: null` / `across_offset_mm: null` in a PATCH item → stored values kept; `label_calibration_staff_enabled` default false, PUT printer true → GET shows true, revision + 1; **sensor scale**: builtin `sensor_scale` 3.4 for 210-804/-824/-812/-805 and 3.0 for 211-501/2009-110, custom die-cut default 3.4, custom continuous 3.0; PUT `sensor_scale: 3.44` stores 3.4; PUT 5.6 and 0.4 → 422 `invalid_material` "… Sensorposition muss zwischen 0,5 und 5,5 auf der Skala liegen"; PUT `sensor_scale: null` → 422 "Feld sensor_scale darf nicht leer sein", PATCH item `sensor_scale: null` → stored value kept; malformed stored `sensor_scale` (`"rechts"`, 9.0) → default, profile kept; changing `sensor_scale` changes the fingerprint (record becomes `stale`); no GET object carries `sensor_mark` or `sensor_offset_mm`; every builtin's `sensor_position` hints contain "ca." and "auf die Skala Ihres Druckers übertragen", the four 3.4 builtins also "Foto 13.10.2026: Etiketten werden so korrekt erkannt"; `format_scale_de(3.4) == "3,4"`, `format_scale_de(3.0) == "3"` |
| `test_label_job_header.py` | every golden job: `new[:2] == old[:2]`, `new[2:7] == ["^H12","^S2","^E0","^C{n}","^P1"]`, element lines identical; jobs with copies > 1 (freetext copies 3, type label copies 2) end `[…, "E", "^C1"]`, single-copy jobs end at `"E"`; baseline darkness 10 via PUT printer → all jobs `^H10`, profile override 8 wins; `material_by_id` strips carry the 2009-110 values; `^C1` on single, `^C3` freetext; mark profile header `^Q25,4,3+`; `JOB_HEADER_SENDS_STOP=False` drops `^E`; `JOB_HEADER_SENDS_P1=False` drops `^P1` and nothing else; fake printer: an SMPL single job after a raw job with `^P2` (no `^C`) prints 1 piece, a raw job without `^C` after an SMPL copies-3 job prints 1 piece; `_clean("A~B^C\r\nD")` == "A B C D"; across offset +1 mm → every machine x +12 vs golden (where not clamped); **guard**: `Lo` beyond the `^W` region is clamped and a fully outside `Lo` dropped; `AT` whose em box leaves [0, h_px] raises; die-cut y beyond the form length raises for `AT`/`XRB`/`Y`; no golden job is clamped or raises at its default offsets; `dry_render_checks` at across ±5 and x_offset −5/+10 on 2009-110, 211-501 and 210-812 raises exactly where `offset_limits` says (and never inside the limits); `offset_limits` of each builtin lies inside the static ranges and contains (0, 2.0) |
| `test_label_calibration_commands.py` | exact `setup_commands` table of §4.4 (every row incl. `^XSET,SENSING,n` on die-cut) and `reprime_lines`; **allow-list**: every line of `setup_commands` and `pattern_job` for every builtin with `pattern_supported` × every valid sensor mode × offsets at the corners of its `offset_limits` (outside them `pattern_job` raises, never emits) + custom mark (inside/outside) + continuous `none`/`reflective` matches §4.1; never-send prefixes absent (incl. `^XSET,IMMEDIATE`); query enum values; `~S,SENSOR` and `^P1` pass, `^XSET,IMMEDIATE,1` does **not**; pattern worked example lines of §4.11 exact; `part_no "X\r\n~Z"` yields no line starting `~Z` and AT text without `~`; `part_no "Brady® Ø3"` yields the allowed line text `SMPL KAL Brady? ?3`; pattern has no `copies`; `pattern_job` on 210-805 raises `PatternUnsupported` |
| `test_label_calibration_flow.py` | quick flow end-to-end against the fake: start → activate → apply (bytes `^G1\r\n^XSET,SENSING,1\r\n^Q99,3\r\n^W44\r\n` in one connection, no `^E ^H ^S ^C ^P ^L`) → autosense (one connection `^Q99,3\r\n^W44\r\n`, then CONFIG, then a separate connection with exactly `~S,SENSOR\r\n`) → poll (60, 60, 00 → done) → verify `match` (busy_seen, latched) → save (record from the fake, `by_id` from token, notes cleaned) → lock free; freshness: q_changed only, qd_changed only, none → `unchecked`; `^QD` absent → `no_result`; `^QD600,36` with 804 → `other_material` [`wago-210-812`]; gap 0 die-cut → `no_gap` with the detail "… Zeiger auf 3,4 der Skala stellen und erneut einmessen."; continuous busy-only with stale `^QD1164,30` → `unchecked`, continuous new `^QD` gap 0 → `match`, gap > 0 → `gap_on_continuous`; final status 02 → `printer_error`; **latch**: `sense_sensor_after="reflective"` → `match` with `sensor_ok False` and offer `reapply` → apply → verify → still `match`, `freshness busy_seen`, `from_latch` true; **switch with echo**: `sense_result_qd=(610,30)`, `q_write_updates_qd=True` → `other_material` → activate 812 → apply → verify → `match`, measured 610/30 (not 600/36), `from_latch` true; **write before latch**: sense, activate 812, apply with `q_write_updates_qd=True`, verify → `unchecked` with W1, offers `resense`/`accept_anyway`; same without the echo → W2; requery after W1 stays `unchecked`; a new autosense clears latch and writes; activate resets `applied`/`verdict`, keeps `sensed`; verify after activate without apply → 409; 422 without `confirm_feed`; status 04 → 409 `printer_not_ready` and no `~S,SENSOR` received; apply while status 50 → 409 `printer_not_ready` with message "Drucker nicht bereit: Druckt"; **button fallback**: `requires_immediate` (STATUS silent) + method `command` → 409 `no_status_reply` and no `^XSET` bytes ever; same + method `button` → 200, `sense.method button`, `status_answered false`, no `~S,SENSOR` and no `^XSET` bytes; poll then answers `sensing` with the P3 message (never `error`), verify works; fully silent STATUS → same; **poll**: unknown code `99` → `error` "Unbekannter Status 99"; timeout wins over a simultaneous `60`; a poll in `sensed` replays phase, code and message without a printer query; slow message after `AUTOSENSE_SLOW_S`; poll in `judged` → 409; **pattern**: `confirm_feed` false/missing → 422; status 04 → 409 and nothing printed; phase `sensing` → 409; phase `applied` (no verify yet) → 409; `pattern_pending` already set → 409; two parallel requests (fake `reply_delay_s`) → exactly one job printed; 210-805 → 422 `pattern_unsupported`; full flow pattern → header + box lines and a `writes_since_sense` entry; **activate/apply while sensing** → 409; verify before autosense → 409; save non-match without accept → 422; pattern in quick session → 422; `last_applied` written; audit rows exist |
| `test_label_calibration_lock.py` | second user start → 409 `session_locked` with holder name and `since` equal to the holder's `acquired_at` (ISO UTC); its message shows HH:MM in Europe/Berlin (07:05Z → "09:05" in October); same user → takeover; admin `takeover:true` → ok, staff `takeover:true` on another's → 409; expiry (monkeypatched clock) frees the lock; foreign `session_id` → 409 `session_lost`; during a session: machine print-label → 409 with the German text, BMK labels → 409, admin Testdruck → 200 `ok:false`; the session's own pattern print is allowed; `_ship` from a calibration route whose session was taken over → 409 `session_lost`, I/O lock timeout on a calibration route → 409 `printer_busy`; **DELETE**: after `save` → 204, lock stays free; a stale tab's DELETE while another user holds the lock → 204 and the other session is unchanged; DELETE of an unknown id → 204; PUT material with stale revision → 409 `stale_revision`; PATCH without revision succeeds and bumps; activate on another material bumps revision and returns it in `config_revision`, activate on the same material does not bump; **not configured**: no host → POST session 503 `not_configured` |
| `test_label_printer_permissions.py` | employee without grants → 403 on every new route; `werkstatt:manage` (via `_employee_with` pattern) with the staff switch **off** → overview 200 with `staff_enabled false`, POST session 403 `staff_flow_disabled`; with the switch **on** → 200 on overview/status/quick session/activate/apply/autosense/poll/verify/save, 403 on `mode:"full"`, pattern, admin GET/PATCH/PUT; `raw_config` null for staff, present for admin; admin → everything regardless of the switch |

**Existing tests to update (accepted byte changes, §4.8)**:

- `tests/test_werkstatt_article_label_layout.py:63` (`job[:3]` → header with `^H12 ^S2 ^E0 ^C1 ^P1`);
- `tests/test_schaltplan_type_label.py:158` (`"^Q99,3\n^W44\n^H12\n^S2\n^E0\n^C2\n^P1\n^L"`)
  and `:159` (`text.rstrip().endswith("\nE\n^C1")` — the copies-2 job now ends with the
  reset);
- `tests/test_werkstatt_label_materials.py:63-71` `_jobs` helper: accept and strip one
  trailing `^C1` line after the final `E` (the freetext copies-3 test at :213-234 would
  otherwise fail "payload must end at a job boundary"); the test itself additionally
  asserts the trailing `^C1`.

Any other failure caused by the header is a bug, not an expectation change.

### 8.2 Frontend (vitest, `apps/web/src/test/`, `vi.mock("../api/client")` + `makeAppContextStub`)

| File | Cases |
|---|---|
| `labelCalibration.test.ts` | `formatMmDe(11) === "11"`, `formatMmDe(3.5) === "3,5"`, `formatMmDe(-2.5) === "−2,5"`, `formatSignedMmDe(0.4) === "+0,4"`; `webWidthMm` (805 → 34, 804 → 44); `guideText` for 804 (ganz öffnen), 2009-110 ("1 mm + 11 mm + 1 mm"), 805 (Trägerrand, ≈ 34 mm, geschätzt); `formatScaleDe(3.4) === "3,4"`, `formatScaleDe(3) === "3"`; `parseScaleInput("3,4") === 3.4`, `("3.4") === 3.4`, `("3,44") === 3.4`, `("5,6")`, `("0,4")`, `("abc")`, `("")` → null; `targetOffsetMm` (3.4 → 4, 3 → 0, 2.5 → −5); `targetText` at 3.4 "Zeiger ▲▼ auf 3,4 der Skala – ca. 4 mm rechts der Mitte", at 3 "Zeiger ▲▼ auf 3 der Skala – Mitte der Materialbahn", at 2.5 "Zeiger ▲▼ auf 2,5 der Skala – ca. 5 mm links der Mitte"; `scaleShiftText(2.9, 3.4) === "≈ 5 mm nach rechts schieben"`, `scaleShiftText(3.8, 3.4) === "≈ 4 mm nach links schieben"`, `scaleShiftText(3.4, 3.4) === "Zeiger steht richtig"`; `visibleHints` drops `web` hints when measured and `sensor_position` hints when `sensor_scale` is overridden; `checklistItems` order roller → sensor → roll → guides → ribbon → lid, item 2 "Sensor-Schlitten verschieben, bis der Zeiger auf 3,4 der Skala zeigt" (2009-110: "… auf 3 der Skala zeigt"); `offsetCorrections`: A only, A+B (length info, offset from A only), L only / L+R on fit, guide max → no across; continuous → across only; a correction beyond `offset_limits` is clamped and carries the "außerhalb des möglichen Bereichs" info; `scaleFromRuler(80, 81.3) === 11.81`; `sensorTrack` expectations of §7.8 (all `severity: "info"`); `calibrationChip` texts; `formatLocalTime("2026-10-20T07:05:00Z")` is "09:05" under `TZ=Europe/Berlin`; `apiErrorDetail` on a string detail → null |
| `labelSensorDiagram.test.tsx` | the scale renders 49 ticks (5 long with the numbers 1–5, 4 medium, 40 short) and number n at x = `scaleToX(n)` (change `scaleUnitMm` in the test → the drawing follows); 210-804: the ▲▼ pointer and the highlighted target tick at x = 4, the callout "Ziel: 3,4"; 2009-110: pointer at x = 0, callout "Ziel: 3"; no dot elements and no ⬇/▽ glyph anywhere; without `actualScale` no `.lc-actual` element, with `actualScale` 2.9 an `.lc-actual` pointer at x = −1, the label "Ist: 2,9" and a shift arrow; the slot spans x ≈ −41 … +41; no "≈" while `measured` is true (setting it false in the test adds one); state "sensor" renders no media group; "loaded" renders labels whose width equals `label_across`; 805 renders two lane columns; continuous band width = `width_mm`; `.lc-roller-5007` with groove for that roller; `<desc>` contains the target text (and the Ist reading when given); zoom viewBox centred on the target |
| `labelPrinterApi.test.ts` | every function: method, path (incl. encoded ids), body (`confirm_feed: true` on autosense/pattern) |
| `materialChangeSheet.test.tsx` | step order; [Weiter] disabled until all six boxes are ticked; the lid ℹ line is present under item 6 and is not a checkbox; step 2 for 210-804 shows "Zeiger ▲▼ auf 3,4 der Skala – ca. 4 mm rechts der Mitte"; typing "2,9" into "Zeiger steht jetzt auf …" shows "≈ 5 mm nach rechts schieben" and draws the Ist pointer, "7" shows "Bitte einen Wert zwischen 0,5 und 5,5 eingeben"; the input sends no request and does not change the [Weiter] gating; activate called on leaving step 2; no `autosense` call before the dialog is confirmed; Abbrechen in the dialog sends nothing; both feed dialogs and the step-4 panel (before starting) show `FEED_STOP_HINT`; polling shows "erwartet: {cost hint}" and the poll `message`; polling stops on `done` and calls verify; **button fallback**: `startAutosense("command")` rejects 409 `no_status_reply` → the button link is highlighted → confirming its dialog calls `startAutosense("button")`, which resolves (`status_answered: false`) → no poll calls, [Ergebnis abfragen] calls verify; `other_material` shows [Auf „…“ umstellen] → activate → step 2 → step 3 apply → step 4 shows only [Ergebnis prüfen] (no [Einmessen starten]) → verify, and no autosense call happens; [Sensor prüfen und erneut einmessen] clears switch mode; `save` called with `accept_verdict` only via [Trotzdem speichern]; 409 `session_locked` shows the holder banner with HH:MM built from `since` (the mocked message deliberately carries a different time); overview `configured: false` → only "Kein Etikettendrucker konfiguriert", no session call; cancel after apply shows the "Einstellungen wurden an den Drucker übertragen" dialog; unmount after save calls DELETE and a rejected DELETE raises nothing |
| `calibrationWizard.test.tsx` | six steps; step 2 PUT carries `revision`; **non-active material**: open [Einrichten] on 210-812 while 804 is active, step 2 PUT returns revision r+1, `activate` returns `config_revision` r+2, step 5 [Übernehmen] PUTs with r+2 and succeeds (mock returns 409 for any older revision); after [Auf „X“ umstellen] the title and the step-5 PUT target are X; pattern print needs the dialog; 210-805 step 5 shows only the T8 text and [Überspringen], no print call; entering A shows "Versatz Vorschub: 2,0 → 1,6 mm" for A = 2,4; [Übernehmen] PUTs `x_offset_mm: 1.6`; a correction beyond `offset_limits` PUTs the clamped value; guide max shows no across correction; finish posts `save` with `pattern`; 409 `stale_revision` shows the reload message; a 422 `invalid_material` shows its German message |
| `adminLabelPrinterCard.test.tsx` | radio change = exactly one PATCH `{active_material_id, revision}` and **no** apply/session call; chips render; [Material gewechselt]/[Einrichten]/[Bearbeiten] open the right component; status fetched only on [Status abfragen]; the staff-switch checkbox PUTs `{revision, label_calibration_staff_enabled: true}`; the form shows the "Kein Sensor" hint when that sensor mode is selected; the material row of 210-804 reads "… · Sensor auf 3,4 der Skala"; the form's "Sensorposition (Skala 1–5, eine Nachkommastelle)" field shows "3 = Mitte der Materialbahn, 1 Teilstrich = 1 mm", accepts "3,6" and PUTs `sensor_scale: 3.6` |
| `labelPrinterQuickEntry.test.tsx` | hidden (and no fetch) without permissions; `werkstatt:manage` only + `staff_enabled: false` → hidden; `werkstatt:manage` + `staff_enabled: true` → visible; `settings:manage` + `staff_enabled: false` → visible; `configured: false` → disabled with `title="Kein Etikettendrucker konfiguriert"`; opens the sheet |
| `labelPrinterWording.test.ts` | the sources under `components/labelPrinter/**` and `utils/labelCalibration.ts` (via `import.meta.glob(…, { query: "?raw" })`) contain neither "verifiz…" nor "verified" (case-insensitive) and no "IR" as a whole word |

---

## 9. Physical test plan

**Who**: the owner stands at the printer (loads material, moves the carriage, watches for
movement, measures with caliper and steel rule). Claude drives SMPL from the Mac and records
every readback in the results table.

**Where**: from a **local API of this branch running outside the preview sandbox**
(sandboxed dev servers cannot reach the LAN), against the office printer. Not from prod:
deploying first would put the unverified `^E/^C/^P1` header into every workshop print and
the "Material gewechselt" flow into the workshop before T0b/T1/T2/T5 have run, without the
owner and Claude at the printer (owner decision 3). If prod is ever used for a test, the
build there has `label_calibration_staff_enabled = false` (the default), so only admins
see the flow; the header change still reaches every print on deploy (§11).

**Recommended order**: T0b → T0 → T1 → T3 → T2 → T17 → T5 → T4 → T6 → T12 → T13 → T7 → T9 → T8 → T14 → T10; T11/T15 with phase 2; T16 optional. The staff switch (§3.4) is turned on only after T0b, T1, T2 and T5 have results below.

| ID | Steps | Expected readback / observation | Paper cost | Unlocks |
|---|---|---|---|---|
| **T0b** Queries are harmless | Owner watches the printer (lid closed, 804 loaded). Admin card [Status abfragen] (status full) × 3, then 10 STATUS polls (GET /status, 1.5 s apart). | No movement, no print, no beep; status `00` throughout. | 0 | The "STATUS/CONFIG harmless" row of §2; until then the admin status button keeps its "on demand only" rule (§7.10) |
| **T0** Scale readings & survey | The photo of 13.10.2026 already gave the housing (dark grey, no ▽/⬇ marks), the scale, the carriage and the roller (black, smooth); nothing of that is measured again. Lid open. (a) **Scale readings by eye, no caliper needed**, per material: set the pointer to the profile's reading (210-804/-824/-812/-805 → 3,4; 2009-110 and 211-501 → 3), load the material as the checklist says, and look whether the optical window sits over the labels (die-cut; 210-805: over one lane, not on the slit) or over the web (continuous). If the owner prefers another reading, note it to 0,1. (b) With media loaded: is the **scale** still readable, and the ▲▼ pointer? (c) Does anything **above** the media path move with the carriage? (d) Is scale 3 on the centre between the guides (the photo says within ≈ 0,5 mm)? (e) With guides fully open, what centres the 44 mm web (left/right clearance)? (f) With a ruler: 210-805 roll (lanes, label across × along, gap, slit, liner), liner widths of 804/812/824, tube flat width. | (a) window over the labels / web at 3,4 and 3; (b) open — the photo crop shows no media over the scale | 0 | Confirm or correct each builtin `sensor_scale` and drop "ca." from its hints (§3.3, §1.2); if the scale is hidden with media loaded, the checklist order (sensor before loading, §7.4) already covers it — add a caption line saying so; enter web values with "Maße am Material nachgemessen"; spot-check validity; input for phase-2 210-805 |
| **T1** Apply without feed | 804 loaded; owner watches for movement throughout; status full before and after every step, record the `^QD` line each time. (1) Full wizard steps 1–4 apply only, 210-804. (2) **`^Q` echo check**: apply 210-812 (`^Q50,3`, differs from the measured `^QD1164,30`) with 804 still loaded. (3) Profile sensor → Reflex, apply; back to Durchlicht, apply. (4) Apply 2009-110 (804 still loaded). (5) Apply 211-501 with "Kein Sensor" (`^XSET,SENSING,2`). (6) Apply 210-804 again — it sends `^XSET,SENSING,1`, the reset; T1 always ends here. | No movement. (1) `^W44 ^Q99,3`, line `See.…`; (2) **`^QD` unchanged** (still `1164,30`) — if it reads `600,36`, a `^Q` write echoes into `^QD`: record it; SMPL's verdicts do not depend on it (latch, §4.6), the readback shown after a switch does; (3) after `^G0` the line reads `Reflective…`(?); (4) `^W11 ^Q15,0`; (5)/(6) CONFIG cannot show `SENSING` — nothing to read; the effect of the reset is checked by T17 | 0 | Keeps "laut EZPL-Handbuch bewegt dieser Schritt kein Material" (or adds a confirm dialog); makes `sensor_ok` reliable for Reflex; answers the switch/reapply-without-resense readback question |
| **T2** Auto-sense 210-804, pointer at 3,4 | Quick flow. Pen mark on the liner at the tear edge, run "Einmessen". The session logs `poll_codes`. Measure the fed length. | `^QD ≈ 1164,30`; verdict `match` (Δ −2,5 mm). Record: were 50/60 seen? Did `^Q` change 99,3 → 97,2? Sensor line still `See.` (does `~S,SENSOR` keep `^G`)? | 2–3 labels (≈ 20–30 cm) | Confirms freshness rules (if neither busy nor `^Q` change, only `qd_changed` remains → expect `unchecked` on re-sensing the same roll → phase-2 rule); corrects `AUTOSENSE_COST_HINT` |
| **T3** Lid behaviour | No commands. Status full; open and close the lid; status full again. | Does `^QD`/`^Q` change? Does it feed? (`^XSET,WHENTOSENSING` cannot be read back) | 0, or 2–3 labels | Phase 1 already shows the ℹ line "kann … einmessen" and re-primes `^Q`/`^W` before the pre-sense snapshot. If closing the lid auto-senses: the ℹ line becomes a firm warning and phase 2 reorders apply before the lid |
| **T4** Measuring pattern 210-804 | Full wizard step 5: print, measure A/B/L/R, ruler 10 → 90 with a steel rule; apply; reprint. Count labels per print. | A within 0,3 mm after one correction; ruler 80,0 mm (12 dots/mm) or ≈ 81,3 mm (H1); exactly one label per print | 2 labels | H1 decision (phase-2 scale); confirmed 804 offset |
| **T5** Job header, `^C`, `^P` | On 2009-110: (a) admin freetext copies 2 → count pieces (the trailing `^C1` must not shorten it); (b) a **raw** job without `^C`/`^P` (scratch script outside SMPL, owner's OK; e.g. `^Q20,0` `^W11` `^L` `AT,…,T5b` `E`) → count; (c) a raw job with `^P2` and no `^C` → count; (d) an SMPL single Testdruck → count. Watch the stop position of a normal job with `^E0` in its header. | (a) 2 pieces; (b) **exactly 1** (the trailing `^C1` reset SMPL's `^C2`); (c) 2 pieces; (d) **exactly 1** (`^P1` in the header beats the leftover `^P2`); no extra feed from the header | ≈ 6 pieces (≈ 25 cm) | Confirms owner decision 2 incl. `^P1` (§11 D1) and the trailing reset; if `^E` in the header feeds → `JOB_HEADER_SENDS_STOP = False`; if (a) prints fewer than 2 → move the reset (phase 2) |
| **T6** 210-812 + wrong material | Load 210-812 (pointer at 3,4, guides open). Quick flow with **210-804** chosen. Then [Auf „Typenschilder 50 × 25“ umstellen] → apply → [Ergebnis prüfen]. Status full after the apply. Then one pattern in the full wizard. | `other_material` → 210-812; then `match` without new sensing, judged on the **latched** values (verdict shows `from_latch`); record `^QD` after the 812 apply (compare with T1 step 2) | ≈ 3 labels + 1–2 pattern labels | Confirms tolerance and the switch path; measured 812 gap. The switch/reapply-without-resense path stays [Unverified → T1] for the readback, not for the verdict |
| **T7** 2009-110 continuous | External unwinder, guides 1 + 11 + 1, pointer at 3. Quick flow; owner's hand on the lid; record `^QD`, `^Q`, sensor line before/after; fed length and duration. Then a 40 mm pattern (L/R). | Expected "Continuous / See-Through"; does `^QD` change, gap 0? does `^Q` change? Does the sense stop by itself, and after how long? | unknown — stop at 70 cm by opening the lid + ≈ 4 cm | Continuous verdict rules (R5); cost hint for continuous (stays "Menge unbekannt" unless measured) |
| **T8** 210-805 | Pointer at 3,4, guides at the liner. Quick flow. Optional: pointer at 3 (on the slit), sense again. | Pitch ≈ 9 mm (6 + 3) if the two-lane estimate holds → `match`; at 3: 01/02 or odd values | a few rows per sensing (≤ 10 labels each) | Phase-2 two-lane printing; 805 web values; which element moves |
| **T9** 211-501 tube | Unwinder, pointer at 3. Quick flow; on 01/02 set "Kein Sensor" and retry. **Lid stop**: during one auto-sense that is still feeding (or one started on purpose for this), the owner opens the lid. Then a 30 mm pattern. With "Kein Sensor": does the printer notice the end of the tube (pull the tube out before a short job)? | Continuous result or 01/02 (transparency). Lid open: the feed stops at once; STATUS then `04` (record what follows: does closing the lid resume the sense, end it, or start a new one?) | unknown per attempt (stop with the lid) + ≈ 3 cm; budget 70 cm | Tube sensor default; cost hint; confirms or replaces `FEED_STOP_HINT` and the "Kein Sensor" hint |
| **T10** Persistence | After T1/T6 values: status full; power off/on; status full. Then open and close the lid while a status poll runs. | Which of `^G` (sensor line), `^Q`, `^W`, `^H`, `^S`, `^E`, `~Q` survive? Does STATUS still answer without SMPL ever having sent `^XSET,IMMEDIATE,1`? Any feed at power-on? Do `ERRORxx` lines appear on SMPL's sockets (`errors_seen`) when the lid opens — i.e. is ACTIVERESPONSE already active? | 0, or 2–3 labels | Whether the quick flow must be repeated after power-on (then a hint "Nach dem Einschalten „Material gewechselt“ ausführen"); whether phase 2 needs IMMEDIATE as an explicit, audited step (only if STATUS stops answering) |
| **T11** `~Q` write (phase 2) | Phase-2 build: restore sends the pinned `~Q-19`; read back. | `~Q-19`, no movement | 0 | Phase-2 restore action |
| **T12** Error states | Open the lid → status shows 04 "Druckkopf offen"; close → 00. | 04 / 00 | 0 | Status texts; phase-2 `~S,CANCEL` test |
| **T13** Readback while printing | Freetext copies 2 while the admin status line is polled. | 50/60 visible; the job prints correctly | 2 pieces | Confirms the I/O lock suffices; optional raw two-socket test needs the owner's OK |
| **T14** H1 on a real rail | Print an existing 12-module BMK strip (17,5 mm/module); measure end mark to end mark. | 210,0 mm (12 dots/mm) or ≈ 213,4 mm (H1) | ≈ 22 cm | Phase-2 scale, together with T4 |
| **T15** `^G` inside a job (phase 2) | One job with `^G1` before `^L`. | No extra feed or re-sensing | 1 label | Phase-2 per-job sensor commands |
| **T16** `~` inside text (optional) | Outside SMPL (scratch script, owner's OK): one job whose AT text contains `~S,STATUS`; read the socket. | A status reply ⇒ `~` is live inside text | 1 label | Documents the risk; SMPL strips `~`/`^` regardless |
| **T17** `SENSING` carry-over | Right after T2 (804 loaded, pointer at 3,4): apply 211-501 with "Kein Sensor" (`SENSING,2`, no feed), then the quick flow on 210-804 (its apply sends `^XSET,SENSING,1`) and "Einmessen". | Same as T2: normal duration, `^QD ≈ 1164,30`, verdict `match`. A long gap search or 01/02 would mean the reset did not work. | 2–3 labels | Confirms that every apply's explicit `SENSING` (§4.4) resets a "Kein Sensor" apply |

**Results** (fill in as the tests run; never paraphrase a result as "verified"):

| ID | Date | Result | Readback excerpt | Decision taken |
|---|---|---|---|---|
| T0b | | | | |
| T0 | | | | |
| T1 | 2026-10-13 | Step (1) only (210-804 apply, quick flow). Width taken; **`^Q` NOT taken**: a standalone `^Q99,3` left the stored `^Q97,2` (the printer keeps its own measured size). App showed "Drucker meldet andere Werte" + [Erneut übertragen] as designed. Movement during the apply: owner to confirm. Steps (2)–(6) still open. | before `^W44 ^Q97,2 ^E0`, `See.:0.1 1.7 1.0 [1.6_58]`, `^QD1164,30`; after apply `^W44 ^Q97,2` | `^Q` readback cannot confirm an apply — the freshness proof leans on busy codes / `^Q` change by the sense itself |
| T2 | 2026-10-13 | 210-804, pointer ≈3,4 (from the photo, not re-read), quick flow on the REAL printer from a local API: auto-sense ran, verdict **match** (fresh, `freshness: q_changed`): measured 96,2 + 3,5 mm (pitch 99,7) vs profile 99 + 3 (pitch 102), Δ pitch −2,3 mm within ±3,1. Saved "eingemessen". Owner: fed exactly 3 labels (estimate 2–3 holds). | after `^W44 ^Q96,3`, `^QD1154,42  ^Q96.2,3.5`, `Label+Gap = 1196`, `See.:0.1 3.2 1.9 [3.2_62]` (sensor contrast up from 1.7/1.0) | `~S,SENSOR` over TCP 9100 works on V5.UW0m and rewrites `^Q` — freshness rule `q_changed` holds; UI: step 4 shows no "misst …" state while polling (fix) |
| T3 | 2026-10-13 | Lid opened and closed with 210-804 loaded, nothing sent: status 04 → 00 directly, no 50/60 seen (0,5 s polling); measurement unchanged to the dot. Closing the lid does NOT auto-sense on this printer. | after close `^QD1154,42`, `^Q96,3`, `See.:0.1 3.2 1.9 [3.2_62]` | The lid-close hint in the checklist ("kann selbst einmessen") can be softened for this printer; `^XSET,WHENTOSENSING` value still unknown (not readable) |
| T4 | 2026-10-13 | Full wizard on 210-804 after a 2nd auto-sense (3 more labels; measured 95,8 + 3,7 mm, pitch 99,5 → label Δ −3,2 just outside ±3,1 → "Messung passt nicht zum Profil", continued with [Trotzdem fortfahren]). Pattern printed (1 label). Owner measured A = 5 mm, L = 2 mm, ruler 10→90 = 81,5 mm. Wizard: feed offset 2,0 → −1,0 mm (saved), across none (guides open), scale ≈ 11,78 dots/mm (info). | — | **H1 confirmed**: the feed axis prints at ≈ 1/300 in per dot (81,5 vs 80,0; H1 predicts 81,3), SMPL assumes 12/mm → +1,9 % along the feed (≈ 1,3 mm over a 70 mm BMK module span, ≈ 4 mm over a 210 mm strip) — phase-2 scale fix. **210-804 builtin is off**: both senses give pitch ≈ 99,6 mm, the profile assumes 99 + 3 = 102 — correct length/gap after the owner measures a label; the tolerance then judges real deviations. Wizard has no "reuse this session's fresh measurement" path, so a pattern always costs a new sense (3 labels). **Re-print after the correction: A = 2 mm (exact), L = 1,1 mm (was 2 — the web wanders ≈ 1 mm with the guides fully open, as the across rule assumes), ruler unchanged 81,5.** Wizard finished and saved ("kalibriert", note with the readings). |
| T5 | | | | |
| T6 | | | | |
| T7 | | | | |
| T8 | | | | |
| T9 | | | | |
| T10 | | | | |
| T11 | | | | |
| T12 | 2026-10-13 | Lid open: STATUS `04` "Druckkopf offen", action "Deckel schließen"; no `ERRORxx` pushed on the query socket. With the lid open `^XGET,CONFIG` gave no recognisable config (only STATUS answers). Close → `00`. | `04,00000` → `00,00000` | Status texts confirmed; CONFIG reads must expect no config while the head is open |
| T13 | | | | |
| T14 | | | | |
| T15 | | | | |
| T16 | | | | |
| T17 | | | | |

---

## 10. Docs and memory to update

- **`docs/SETUP.md` → "Werkstatt Label Printer (optional)"** (currently lines 178–200):
  - replace "Label geometry … lives as constants in `werkstatt_labels.py` — adjust there"
    with: material profiles in Admin → Einstellungen → Etikettendrucker, the quick flow on the
    Werkstatt → Maschinen page, the full wizard, and a link to this document;
  - replace "(The first-gen smartPRINTER 258-5000 was a cab device; this generation is not.)"
    with "Research (2026-10) found WAGO's own GoDoctor screenshots identifying the 258-5000
    generation as a GoDEX RT230i; the 258-5101 is GoDEX-based as well (EZPL).";
  - add: port 9100 answers `~S,STATUS` and `^XGET,CONFIG` (readback); the never-send list
    (§4.1, incl. `^XSET,IMMEDIATE` in phase 1); all six materials use roller 258-5006;
    print routes answer 409 while a calibration session runs; every job states
    `^H ^S ^E ^C ^P1` and copies jobs end with `^C1`; the staff switch
    `label_calibration_staff_enabled` (Admin → Etikettendrucker) is off until the
    physical tests of §9 have results.
- **`apps/api/app/services/werkstatt_labels.py` module docstring**: the same cab correction;
  mention the job header (§4.8), the busy check and I/O lock in `_ship`, `~`/`^` stripping.
- **`apps/api/app/services/werkstatt_label_materials.py` docstring**: sensor fields,
  overrides-only storage, roller 258-5006 for all six builtins, 210-805 web vs print geometry.
- **`CODEMAP.md`** (label services section around lines 383–396): the new services
  (`werkstatt_label_errors/profile/builtins/jobs/io_lock/ezpl_policy/transport/
  printer_status/session/calibration/patterns/settings_view`), the two routers,
  `components/labelPrinter/`, and the `app_settings.value` → `Text` migration.
- **258-5007 advice**: a grep of the repo at `a9c335f` finds it nowhere in code, UI or
  docs; it lives only in the memory note. The new UI must never suggest 258-5007 for the six
  builtins (it appears only as a profile-form option labelled "nur WMB-Inline").
- **Memory (for the orchestrator)** `project_werkstatt_label_printer.md`:
  - replace "(strips/shrink also need the 258-5007 roller swapped in)" with "all six
    materials use roller 258-5006 (WAGO roller table 12.2016); 258-5007 is WMB-Inline only";
  - extend "answers neither `~X9` nor `~X8`" with "but port 9100 is two-way: `~S,STATUS`
    and `^XGET,CONFIG` answer (probe 2026-10-13); never send `~X`, `~V` (prints self-test)";
  - `sysName` is now `Wago_Printer`;
  - sensor position: the owner's 258-5101 has no ▽/⬇ marks but a printed scale 1–5
    (cm, mm ticks, 3 = media centre); profiles store one reading `sensor_scale` — labels
    ca. 3,4 (photo 13.10.2026: 210-804 senses correctly there), strip and tube ca. 3;
    T0 confirms by eye;
  - pointer to this document; H1 once T4/T14 have run.

---

## 11. Open owner decisions and risks

- **Printer exposure**: Telnet `GoDEX>` shell (:23), web UI (:80, PIN) and SNMP `public`
  are reachable on the office LAN; anyone there can change the settings SMPL now relies on.
  Owner decides whether to lock them down (phase 2, not a code change).
- **D1 — `^P1` in every job header (owner to confirm).** Decision 2 names `^H ^S ^E ^C`.
  `^P` multiplies with `^C` and has no stated persistence, so a `^P` left by another client
  could multiply every SMPL print. This build sends `^P1` after `^C`
  (`JOB_HEADER_SENDS_P1 = True`, an accepted byte change pinned by the golden tests). If
  the owner declines, flipping the constant removes exactly that line; T5 (c)/(d) shows
  whether it matters on this firmware.
- **The header change reaches prod on deploy.** `^H ^S ^E ^C ^P1` (and the trailing `^C1`)
  go into every workshop print as soon as this build is deployed, independent of the staff
  switch. Deploy after T5 has a result (tests run from a local API, §9).
- **Staff switch.** `label_calibration_staff_enabled` is false by default; the owner turns
  it on in the admin card once T0b, T1, T2 and T5 have results. Until then only
  `settings:manage` users see and can run the quick flow.
- **Prod reachability**: the label path needs the API container to reach 192.168.2.158;
  the physical tests run against a local API outside the sandbox (§9).
- **Other clients** (WAGO smartScript, GoDoctor) can still change `^G`, `~Q` and the
  stored `^Q`; SMPL states `^Q ^W ^H ^S ^E ^C ^P1` per job and warns on `~Q` drift, but a
  foreign `^G` change shows only in the status/verify sensor check.
- **SMPL's own leftovers for other clients.** SMPL resets `^C` after copies jobs (§4.8).
  It does **not** reset `^H`, `^S`, `^E` or the `^Q`/`^W`/`^G`/`SENSING` an apply or job
  left stored: a WAGO job that states none of them prints with SMPL's last values (for
  example a tube darkness override, or `^Q15,0` after a strip). Which of these WAGO's
  software states itself is unknown; if the owner sees odd WAGO prints after SMPL jobs,
  this is the first suspect.
- **H1** (scale 11.81 vs 12 dots/mm) remains open until T4/T14; phase 1 measures, never
  applies.
- **No new dependencies** (`fcntl`, `tempfile`, `socket` are stdlib); no exposure change;
  the dependency audit before deploy still applies (security rules). The one migration
  (§3.1) runs on deploy; take the usual backup first (deploy runbook).

---

## Appendix A — probe reply `^XGET,CONFIG` (2026-10-13, golden fixture)

```
Smart Printer V5.UW0m
USB S/N: 2532090E
Serial port: 96,N,8,1
LAN MAC: 00:1d:9a:10:1a:18
LAN IP 192.168.2.158(DHCP_100M)
LAN Gateway 192.168.2.1
LAN Sub-Mask: 255.255.255.000
LAN Network: ON-LINE
Card Status: BT card detected
BT MAC Addr: 08 BE AC 46 C6 14
BLE Server: Not connected
Classical(EDR) Server: Not connected
PORT State L S E U B
           1 1 1 1 1
################################
0000 FORM(S) IN MEMORY
0003 GRAPHIC(S) IN MEMORY
000 FONT(S) IN MEMORY
000 ASIAN FONT(S) IN MEMORY
000 DATABASE(S) IN MEMORY
000 TTF(S) IN MEMORY
14192184 KB FREE MEMORY
^S2 ^H12 ^R000 ~R255 ~Q-19
^W34 ^Q97,2 ^E0
Option:^D0 ^O0 ^AT
See.:0.1 1.7 1.0 [1.6_58]
Code Page:850
Y-axis resolution = 300 Dpi
^QD1164,30  ^Q97.0,2.5
Label+Gap = 1194 Dots
--------
---
```

Other probe replies: `~S,CHECK` → `00`; `~S,STATUS` → `00,00000`;
`~B` → `BOOT :5.000d` / `F/W : Smart Printer V5.UW0m`. Every line ends with CRLF.

---

## Review decisions (second review, 2026-10-13)

Only the points where this contract does not do exactly what the review's fix said, or
picks one of several offered options. Everything else in §0.4 is adopted as written.

1. **S1, test expectation changed.** The review asked for a test where the switch path
   with `q_write_updates_qd` on gives `unchecked`. Once the measurement is latched at the
   first fresh verify (also adopted), the switch path judges the **sensed** values, and
   `match` is the correct answer when 812 is really loaded. So the switch-path test asserts
   `match` on the sensed 610/30 rather than the echoed 600/36. The echo case becomes the
   `unchecked` test on the only path where it can still occur: a write between sensing and
   the first fresh verify. That rule is also stricter than asked: any such write gives
   `unchecked`, echo detected (W1) or not (W2), because without a latch SMPL cannot tell
   which `^QD` the read shows.
2. **S3/S17, alternative taken.** Of "IMMEDIATE only inside autosense, audited" and "drop
   it", this contract drops it for phase 1. The probe shows STATUS answers without it. It
   may switch on `ERRORxx` pushes for every client, and its persistence is unknown. The
   button method (S14) already covers a silent STATUS. This also makes S17 moot: reads
   never write, so they need no session id. Phase 2 can add it behind T10.
3. **S7, built before the owner answered.** The owner cannot be asked from inside this
   document, and two builders need one answer. `^P1` is therefore built in behind
   `JOB_HEADER_SENDS_P1 = True` and recorded as open decision D1 (§11). Flipping the
   constant removes exactly that line.
4. **S10, guard refined.** For `AT` the guard checks the em box `[x − size, x]`, not just the
   anchor. An anchor-only check would let tube text hang several millimetres off the strip
   (211-501: anchor limit −4,3 mm, em-box limit −0,7 mm). For `XRB` and `Y` it still checks
   only the anchor. The suggested "±width/4" across rule for continuous stock was not
   added: the renderer-derived `offset_limits` are tighter on every builtin
   (2009-110 −0,5 … +0,2 mm, block label).
5. **S12, option chosen.** The physical tests run from a local API, and the runtime switch
   `label_calibration_staff_enabled` is built as well (default off, admin toggle), so a prod
   deploy before the tests still keeps the quick flow away from workshop staff.
6. **S13, option chosen.** `app_settings.value` → `Text` (one migration) rather than a
   separate table. The blobs keep their key/value home, and every other runtime setting
   gains the same headroom.
7. **S15:** option (a), `SessionOut.config_revision`. **S19:** one template ("Drucker nicht
   bereit: {code_text}"); no separate `printer_printing` code. **S24:** option (a), types-only
   input schemas with German service validation; `PatternMeasurementsIn`/`CalibrationSaveIn`
   keep pydantic bounds because the UI cannot violate them. **S26:** non-ASCII mapped to
   `?`, not rejected at validation, so existing custom part numbers stay valid.
8. **S4:** "phase ≥ judged" means phase == `judged`, since `judged` is the last phase. The
   "refuse while sensing" rule was extended from `activate` to `apply`, which has the same
   problem.
9. **S2, addition.** Besides the stop instruction, polls in `sensing` add a "slow" message
   after 15 s. The 45 s / 120 s timeouts stay, because no source says how long a real
   auto-sense takes.
10. **Incidental fix.** The §4.4 example "custom mark 25 × 50 → `^W50`" was not a valid
    profile (width ≤ 47). It is now length 25, width 40 → `^W40`.

## Security addendum (2026-10-13, after two commit security reviews)

Reading the printer's replies back turned the printer address into a server-side request with
a read-back: an admin could aim STATUS/CONFIG at the database, the update runner or a metadata
endpoint and see the answer. `services/werkstatt_label_address.py` closes it:

- An admin-entered address must use port **9100–9109** (nothing inside the deployment listens
  there) and a host that is not loopback, link-local, unspecified, multicast, reserved, a compose
  service name (`api`, `api_worker`, `db`, `web`, `update_runner`), `localhost`, a metadata name or
  `*.internal` / `*.localhost` / `*.local`. Numeric spellings the resolver reads as IPv4 (`127.1`,
  `2130706433`, `0x7f000001`) are refused; mapped and 6to4 IPv6 are judged by their IPv4.
  A port-only change is checked against the stored host. German 400 messages.
- `open_checked` resolves the host once, skips refused addresses and connects to the checked IP,
  never the name (no resolver/DNS differential). It serves every printer connection, jobs and
  queries; a refused address answers like an unreachable printer.
- An address stored before the rule is not dialled; the env fallback is the operator's own
  (the port rule does not apply to it, the connect-time address check does).
- A CONFIG reply without this printer's setup lines (`^S… ^H…`, `^W… ^Q…`) is neither parsed nor
  returned raw — the old "firmware" field was the reply's first line, which would have shown a
  foreign service's banner even to staff.
- Tests: `tests/test_label_printer_address.py`; the fake-printer fixture flips
  `ALLOW_LOCAL_TEST_PRINTER` (127.0.0.1, random port) — never set outside tests.
