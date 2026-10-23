/**
 * The performance guard of docs/PANEL_ENCLOSURE_R2.md §6.7: a full ZB55S
 * (45 rails, 460 devices, every field overflowing, a reserved row on every
 * terminal rail, one empty rail per field for the vacate to try) must derive
 * its terminals, place them, find, suggest and draw in ≤ 40 ms (median of
 * 5, jsdom). It catches O(n²) regressions, not
 * micro-costs; each run gets a fresh copy of the board, so the memoisation by
 * document identity cannot hide the work. Invented data only.
 */
import { describe, expect, it } from "vitest";

import { catalogIndex } from "../utils/enclosureCatalog";
import { buildEnclosureScene } from "../utils/enclosureGeometry";
import { boardTerminals, placeTerminals } from "../utils/enclosureTerminals";
import { terminalFindings } from "../utils/enclosureTerminalRules";
import { terminalSuggestions } from "../utils/enclosureTerminalSuggest";
import type { CatalogEntry, EnclosureSpec } from "../types/panelEnclosure";
import type { PanelDocument, PanelRow } from "../types/schaltplan";
import { FIXTURE_CATALOG } from "./enclosureFixtureBoards";
import { doc, fi, lsRun, mod, range, row } from "./enclosureTerminalBoards";

const BUDGET_MS = 40;
const RUNS = 5;

/** The fixture's ZB54S, one field wider: the five-field cabinet of the guard. */
function zb55sIndex() {
  const zb54s = FIXTURE_CATALOG.enclosures.find((entry) => entry.code === "ZB54S") as CatalogEntry<EnclosureSpec>;
  const spec = { ...zb54s.spec!, code: "ZB55S", article_no: "ZB55S", fields: 5, width_mm: zb54s.spec!.width_mm + zb54s.spec!.field_width_mm };
  return catalogIndex({ ...FIXTURE_CATALOG, enclosures: [...FIXTURE_CATALOG.enclosures, { ...zb54s, code: "ZB55S", spec }] });
}

/** Five ZU59RK, nine rails each: 12 TE on r1–r8 (four FIs over two rails each), r9 an empty row. */
function fullZb55s(): PanelDocument {
  const modules = range(0, 5).map((field) =>
    mod(`mod-${field}`, "ZU59RK", field, Object.fromEntries(range(1, 10).map((r) => [`r${r}`, `row-${field}-${r}`]))));
  const rows: PanelRow[] = range(0, 5).flatMap((field) =>
    range(1, 10).map((r) => {
      const group = `g${field}-${Math.ceil(r / 2)}`;
      const first = r % 2 === 1;
      const devices = r === 9 ? []
        : first ? [fi(`dev-${group}`, `F${field}${r}`, { te: 2 }), ...lsRun(`${group}-a`, `F${field}${r}`, range(1, 11), r * 100)]
          : lsRun(`${group}-b`, `F${field}${r}`, range(1, 13), r * 100);
      return row(`row-${field}-${r}`, `F${field + 1} · Verteiler ${r}`, devices);
    }));
  return doc("ZB55S", modules, rows);
}

function oneRun(template: PanelDocument, index: ReturnType<typeof zb55sIndex>): number {
  const document = structuredClone(template);
  const started = performance.now();
  const terms = boardTerminals(document, index);
  const placement = placeTerminals(document, index, terms);
  terminalFindings(document, index, { terms, placement });
  terminalSuggestions(document, index, terms, placement);
  buildEnclosureScene(document, index, "open", placement);
  return performance.now() - started;
}

describe("a full ZB55S", () => {
  it(`derives, places, finds, suggests and draws in ≤ ${BUDGET_MS} ms (median of ${RUNS})`, () => {
    const index = zb55sIndex();
    const board = fullZb55s();
    expect(board.rows.flatMap((candidate) => candidate.devices)).toHaveLength(460);
    const placement = placeTerminals(board, index);
    expect(placement.fields).toHaveLength(5);
    expect(placement.fields.every((field) => field.unplaced.length > 0)).toBe(true);
    // Ten reserved rows, five free rails, nearest first: fields 1–3 get a vacate, 4 and 5 none.
    const vacates = terminalSuggestions(board, index, boardTerminals(board, index), placement).filter((s) => s.kind === "relink_rows");
    expect(vacates.map((s) => s.field)).toEqual([0, 1, 2]);
    oneRun(board, index); // warm-up: module code paths, JIT
    const times = range(0, RUNS).map(() => oneRun(board, index)).sort((a, b) => a - b);
    expect(times[Math.floor(RUNS / 2)]).toBeLessThanOrEqual(BUDGET_MS);
  });
});
