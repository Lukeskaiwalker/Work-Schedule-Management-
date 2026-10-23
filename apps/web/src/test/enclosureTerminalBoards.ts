/**
 * Small invented boards for the terminal close-up, rules and suggestions
 * (docs/PANEL_ENCLOSURE_R2.md §4, §7) — the TS twins of
 * `apps/api/tests/panel_enclosure_terminal_boards.py` and of the Python
 * fixture writer's builders. Each board isolates one branch of the
 * sequential suggestion pass (§4.2); the shared fixture covers the rest.
 *
 * The fixture's catalogue subset has no ZU59KS, so `elsewhereFirstZb53s`
 * uses the ZU59RK, whose VT rails are the same nine: only `insulated`
 * differs, which no suggestion or sentence reads. Invented data only — the
 * repo is public.
 */
import { makeDevice } from "../utils/schaltplanDevices";
import type { EnclosureModule, TerminalOrderEntry } from "../types/panelEnclosure";
import type { DeviceKind, PanelDevice, PanelDocument, PanelRow } from "../types/schaltplan";
import { board } from "./enclosureTestCatalog";

export const dev = (id: string, kind: DeviceKind, overrides: Partial<PanelDevice> = {}): PanelDevice =>
  makeDevice(kind, { id, ...overrides });

export const fi = (id: string, bmk: string, overrides: Partial<PanelDevice> = {}): PanelDevice =>
  dev(id, "rcd", { designation: bmk, rating: "40 A", residual_current: "30 mA", rcd_type: "A", ...overrides });

export const ls = (id: string, bmk: string, circuit: string, label: string, overrides: Partial<PanelDevice> = {}): PanelDevice =>
  dev(id, "mcb", { designation: bmk, circuit, label, rating: "B16", cable: "NYM-J 3x2,5 mm²", ...overrides });

/** Python `range(from, to)`. */
export const range = (from: number, to: number): number[] => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);

/** LS `{bmk}.k` for every k in `numbers`, each on a Reihenklemme; circuits count up from `firstCircuit` (Python `ls_run`). */
export function lsRun(group: string, bmk: string, numbers: number[], firstCircuit: number, overrides: Partial<PanelDevice> = {}): PanelDevice[] {
  return numbers.map((k, i) =>
    ls(`dev-${group}-${k}`, `${bmk}.${k}`, String(firstCircuit + i), `Stromkreis ${firstCircuit + i}`, { terminal_block: true, ...overrides }),
  );
}

export const row = (id: string, label: string, devices: PanelDevice[], slots = 12): PanelRow => ({ id, label, slots, devices });

export function mod(
  id: string, code: string, field: number, rails: Record<string, string>,
  terminalOrder?: Record<string, TerminalOrderEntry | { strips: string[] }>,
): EnclosureModule {
  const out: EnclosureModule = { id, code, field, unit: 0, label: "", rails, fittings: [], removed_fittings: [], meters: [] };
  return terminalOrder ? { ...out, terminal_order: terminalOrder as Record<string, TerminalOrderEntry> } : out;
}

export const doc = (cabinet: string, modules: EnclosureModule[], rows: PanelRow[]): PanelDocument =>
  board(rows, { code: cabinet, modules });

const rails = (rows: Record<number, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(rows).map(([rail, rowId]) => [`r${rail}`, rowId]));

/** Every rail of field 0 holds a breaker: the two reserved rows have nowhere to go. */
export function fullFieldZb32s(): PanelDocument {
  const rows = range(1, 8).map((r) => row(`row-${r}`, `F1 · Verteiler ${r}`, [ls(`dev-${r}`, `F${r}`, String(r), "Licht")]));
  return doc("ZB32S", [mod("mod-a", "ZU37KS", 0, rails(Object.fromEntries(range(1, 8).map((r) => [r, `row-${r}`]))))], rows);
}

/** A breaker on r1 of a field whose five 71.5 mm Leisten overflow anyway: vacating r1 still leaves X5 without place. */
export function stillShortZb32s(): PanelDocument {
  const groups = range(3, 8).map((rail, i) => {
    const group = i + 1;
    return row(`row-o${rail}`, `F1 · Verteiler ${rail}`, [
      fi(`dev-f${group}`, `F${group}`, { te: 2 }),
      ...lsRun(`f${group}`, `F${group}`, range(1, 11), 1 + (group - 1) * 10),
    ]);
  });
  const rows = [row("row-o1", "F1 · Verteiler 1", [ls("dev-r1", "F0.1", "90", "Außenlicht")]), ...groups];
  return doc("ZB32S", [
    mod("mod-o", "ZU37KS", 0, { r1: "row-o1", ...rails(Object.fromEntries(range(3, 8).map((r) => [r, `row-o${r}`]))) }),
    mod("mod-e", "ZU37KS", 1, {}),
  ], rows);
}

/** 41 breakers with terminals before any protective device: one 213.2 mm supply Leiste with no head to move. */
export function supplyOverflowZb32s(): PanelDocument {
  const breakers = lsRun("s", "F0", range(1, 42), 1);
  const rows = range(3, 7).map((rail, i) => row(`row-s${rail}`, `F1 · Verteiler ${rail}`, breakers.slice(i * 12, i * 12 + 12)));
  return doc("ZB32S", [
    mod("mod-s", "ZU37KS", 0, rails(Object.fromEntries(range(3, 7).map((r) => [r, `row-s${r}`])))),
    mod("mod-e", "ZU37KS", 1, {}),
  ], rows);
}

/**
 * A meter field's VF group (133.9 mm, placed in field 1 by R6) and five
 * 76.7 mm Leisten, stored in an order that leaves the VF strip and F6
 * without place. Only F6 may be moved (R6 strips are skipped), and its FI +
 * 11 LS need two rails of the empty field 2.
 */
export function elsewhereFirstZb53s(): PanelDocument {
  const order = {
    "0": { strips: ["dev-f2:leiste", "dev-f3:leiste", "dev-f4:leiste", "dev-f5:leiste", "dev-f1:leiste", "dev-f6:leiste"] },
  };
  const groups = range(2, 7).map((group, i) => {
    const rail = i + 3;
    return row(`row-d${rail}`, `F2 · Verteiler ${rail}`, [
      fi(`dev-f${group}`, `F${group}`, { te: 2 }),
      ...lsRun(`f${group}`, `F${group}`, range(1, 12), 23 + (group - 2) * 11),
    ]);
  });
  const rows = [
    row("row-vf1", "F1 · Verteilerfeld 1", [fi("dev-f1", "F1", { te: 2 }), ...lsRun("f1", "F1", range(1, 11), 1)]),
    row("row-vf2", "F1 · Verteilerfeld 2", lsRun("f1", "F1", range(11, 23), 11)),
    ...groups,
  ];
  return doc("ZB53S", [
    mod("mod-m", "ZH5EL27", 0, { vf1: "row-vf1", vf2: "row-vf2" }),
    mod("mod-d", "ZU59RK", 1, rails(Object.fromEntries(range(3, 8).map((r) => [r, `row-d${r}`]))), order),
    mod("mod-x", "ZU59RK", 2, {}),
  ], rows);
}

/** A 3-pole B20 breaker on a Reihenklemme: one 60 mm Block. */
const block = (id: string, bmk: string, circuit: string): PanelDevice =>
  ls(id, bmk, circuit, "Durchlauferhitzer", { rating: "B20", poles: 3, te: 3, terminal_block: true });

/**
 * Field 0 stores an order that puts F1's two Blocks first: F1's 92.3 mm
 * Leiste and F3's are left without place. Moving F1 with its circuits into
 * field 1 would place both of field 0's (2 → 1 unplaced), but field 1 then
 * holds F1's Leiste and one Block only, and the other Block, placed before,
 * loses its place — so the move is refused (§4.2 step 3).
 */
export function lostPlaceZb32s(): PanelDocument {
  const g = lsRun("g", "F1", range(1, 15), 1);
  const a = lsRun("a", "F2", range(1, 11), 20);
  const b = lsRun("b", "F3", range(1, 11), 30);
  const m = lsRun("m", "F4", range(1, 27), 40);
  const rows = [
    row("row-f3", "F1 · Verteiler 3", [block("dev-s1", "F0.1", "91"), block("dev-s2", "F0.2", "92"), block("dev-s3", "F0.3", "93"),
      fi("dev-g", "F1", { te: 2 })]),
    row("row-f4", "F1 · Verteiler 4", [block("dev-g-b1", "F1.15", "15"), block("dev-g-b2", "F1.16", "16"), ...g.slice(0, 6)]),
    row("row-f5", "F1 · Verteiler 5", [...g.slice(6), fi("dev-a", "F2", { te: 2 }), ...a.slice(0, 2)]),
    row("row-f6", "F1 · Verteiler 6", [...a.slice(2), fi("dev-b", "F3", { te: 2 }), ...b.slice(0, 2)]),
    row("row-f7", "F1 · Verteiler 7", b.slice(2)),
    row("row-m3", "F2 · Verteiler 3", [fi("dev-m", "F4", { te: 2 }), ...m.slice(0, 10)]),
    row("row-m4", "F2 · Verteiler 4", m.slice(10, 22)),
    row("row-m5", "F2 · Verteiler 5", m.slice(22)),
  ];
  const order = {
    "0": { strips: ["dev-g-b1:block", "dev-g-b2:block", "dev-s1:block", "dev-s2:block", "dev-s3:block", "dev-g:leiste", "dev-a:leiste", "dev-b:leiste"] },
  };
  return doc("ZB32S", [
    mod("mod-f", "ZU37KS", 0, rails(Object.fromEntries(range(3, 8).map((r) => [r, `row-f${r}`]))), order),
    mod("mod-m", "ZU37KS", 1, rails(Object.fromEntries(range(3, 6).map((r) => [r, `row-m${r}`])))),
  ], rows);
}

/** A ZU37KS whose rails in `reserved` and `full` hold one breaker each, and whose `emptyRows` carry a row without devices. */
function vtField(name: string, field: number, reserved: number[], full: number[], emptyRows: number[] = []): [EnclosureModule, PanelRow[]] {
  const named = Object.fromEntries([...reserved, ...full, ...emptyRows].map((r) => [r, `row-${name}${r}`]));
  const rows = [
    ...[...reserved, ...full].map((r) =>
      row(`row-${name}${r}`, `F${field + 1} · Verteiler ${r}`, [ls(`dev-${name}${r}`, `F${field}.${r}`, "", "Licht")]),
    ),
    ...emptyRows.map((r) => row(`row-${name}${r}`, `F${field + 1} · Verteiler ${r}`, [])),
  ];
  return [mod(`mod-${name}`, "ZU37KS", field, rails(named)), rows];
}

const assemble = (cabinet: string, parts: [EnclosureModule, PanelRow[]][]): PanelDocument =>
  doc(cabinet, parts.map(([module]) => module), parts.flatMap(([, rows]) => rows));

/** Field 0's r1 and r2 hold a breaker each; fields 1 and 2 have one free rail apiece (field 2's with an empty row). */
export const scatteredVacateZb33s = (): PanelDocument =>
  assemble("ZB33S", [vtField("a", 0, [1, 2], range(3, 8)), vtField("b", 1, [], range(3, 7)), vtField("c", 2, [], range(3, 7), [7])]);

/** Field 0's r1 and r2 hold a breaker each and field 1 has a single free rail. */
export const halfVacateZb32s = (): PanelDocument =>
  assemble("ZB32S", [vtField("a", 0, [1, 2], range(3, 8)), vtField("b", 1, [], range(3, 7))]);

/** Fields 0 and 1 each hold a breaker on r1 and a full r3–r7; field 2 is an empty ZU37KS. */
export function twoVacatesZb33s(): PanelDocument {
  const modules: EnclosureModule[] = [];
  const rows: PanelRow[] = [];
  for (const [field, name] of [[0, "a"], [1, "b"]] as const) {
    const used = [1, 3, 4, 5, 6, 7];
    modules.push(mod(`mod-${name}`, "ZU37KS", field, rails(Object.fromEntries(used.map((r) => [r, `row-${name}${r}`])))));
    rows.push(...used.map((r) => row(`row-${name}${r}`, `F${field + 1} · Verteiler ${r}`, [ls(`dev-${name}${r}`, `F${r}`, "", "Licht")])));
  }
  modules.push(mod("mod-c", "ZU37KS", 2, {}));
  return doc("ZB33S", modules, rows);
}

/**
 * F5's run spills over the field line: field 0's r8 holds FI F5 and ten LS,
 * and the first two LS on field 1's r3 still follow F5 by position. F4 (21
 * LS over r6 and r7) leaves X5 without place in field 0. Moving F5 with its
 * ten field-0 circuits onto field 1's free r4 leaves the two spilled LS
 * behind F4 by position; the real op pins them back to F5 (C§2.4), so the
 * virtual move must as well, or the pass refuses a move that places every
 * strip. Twin of Python's `spill_zb53s` (which uses the ZU59KS).
 */
export function spillZb53s(): PanelDocument {
  const rows = [
    ...range(1, 5).map((group) => row(`row-a${group + 2}`, `F1 · Verteiler ${group + 2}`, [
      fi(`dev-f${group}`, `F${group}`, { te: 2 }),
      ...lsRun(`f${group}`, `F${group}`, range(1, 11), 1 + (group - 1) * 10),
    ])),
    row("row-a7", "F1 · Verteiler 7", lsRun("f4", "F4", range(11, 22), 41)),
    row("row-a8", "F1 · Verteiler 8", [fi("dev-f5", "F5", { te: 2 }), ...lsRun("f5", "F5", range(1, 11), 61)]),
    row("row-b3", "F2 · Verteiler 3", [
      ...lsRun("f5", "F5", range(11, 13), 71),
      fi("dev-f6", "F6", { te: 2 }),
      ...lsRun("f6", "F6", range(1, 9), 81),
    ]),
  ];
  return doc("ZB53S", [
    mod("mod-a", "ZU59RK", 0, rails(Object.fromEntries(range(3, 9).map((r) => [r, `row-a${r}`])))),
    mod("mod-b", "ZU59RK", 1, { r3: "row-b3" }),
  ], rows);
}

/**
 * FI F1's run starts on the reserved r2 and continues on r3, ahead of F2.
 * Vacating r2 onto the free r4 puts F1.5 and F1.6 first in the reading
 * order, before any head: the real op pins them back to F1 (C§2.4), and so
 * must the virtual relink. Twin of Python's `run_over_r2_zb32s`.
 */
export function runOverR2Zb32s(): PanelDocument {
  return doc("ZB32S", [mod("mod-a", "ZU37KS", 0, { r2: "row-a2", r3: "row-a3" })], [
    row("row-a2", "F1 · Verteiler 2", [fi("dev-f1", "F1", { te: 2 }), ...lsRun("f1", "F1", range(1, 5), 1)]),
    row("row-a3", "F1 · Verteiler 3", [...lsRun("f1", "F1", range(5, 7), 5), fi("dev-f2", "F2", { te: 2 }), ...lsRun("f2", "F2", range(1, 4), 7)]),
  ]);
}
