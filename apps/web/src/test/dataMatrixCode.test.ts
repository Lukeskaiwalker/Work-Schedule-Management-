/**
 * The station badge's DataMatrix: what is drawn must decode to EXACTLY the code.
 *
 * This is the property that failed for the obvious encoder. ReportLab's
 * ECC200, already shipped by the API, encoded every badge code with a trailing
 * NUL (its C40 padding) in an oversized 44x44 symbol -- 0 of 200 decoded
 * exactly with an independent decoder. ZXing forced square decoded 200/200.
 *
 * So the chain is tested end to end here, not taken on trust: encode, turn
 * the grid into the SVG's rects (moduleRuns), rebuild a picture from ONLY
 * those rects, and decode that picture. A run that dropped or shifted a module
 * fails the decode, not just a shape assertion.
 */
import { describe, expect, it } from "vitest";
import * as zx from "@zxing/library";

import { QUIET_MODULES, encodeDataMatrix, moduleRuns } from "../components/shared/DataMatrixCode";

const ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVWX";

function badgeCode(seed: number): string {
  let state = seed;
  let out = "SMPL-P-";
  for (let i = 0; i < 10; i += 1) {
    state = (state * 1103515245 + 12345) % 2147483648; // deterministic, so a failure reproduces
    out += ALPHABET[state % ALPHABET.length];
  }
  return out;
}

/** Rebuild the module grid (quiet zone included) from nothing but the SVG's rects. */
function gridFromRuns(size: number, runs: Array<{ x: number; y: number; w: number }>): boolean[][] {
  const edge = size + 2 * QUIET_MODULES;
  const grid = Array.from({ length: edge }, () => Array<boolean>(edge).fill(false));
  for (const run of runs) {
    for (let x = run.x; x < run.x + run.w; x += 1) grid[run.y][x] = true;
  }
  return grid;
}

function decode(grid: boolean[][], scale = 4): string {
  const width = grid[0].length * scale;
  const height = grid.length * scale;
  const pixels = new Uint8ClampedArray(width * height).fill(255);
  grid.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) pixels[(y * scale + dy) * width + x * scale + dx] = 0;
      }
    }),
  );
  const bitmap = new zx.BinaryBitmap(new zx.HybridBinarizer(new zx.RGBLuminanceSource(pixels, width, height)));
  const hints = new Map([[zx.DecodeHintType.PURE_BARCODE, true]]);
  return new zx.DataMatrixReader().decode(bitmap, hints).getText();
}

describe("the station badge DataMatrix", () => {
  it("is a SQUARE 18x18 symbol for a badge code", () => {
    const rows = encodeDataMatrix(zx, badgeCode(1));
    expect(rows).toHaveLength(18);
    rows.forEach((row) => expect(row).toHaveLength(18));
  });

  it("decodes to exactly the code, from nothing but the drawn rects", () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const code = badgeCode(seed);
      const rows = encodeDataMatrix(zx, code);
      const decoded = decode(gridFromRuns(rows.length, moduleRuns(rows)));
      // toBe, not toContain: a trailing NUL is exactly the bug this guards.
      expect(decoded).toBe(code);
    }
  });

  it("draws every dark module exactly once and nothing else", () => {
    const rows = encodeDataMatrix(zx, badgeCode(7));
    const grid = gridFromRuns(rows.length, moduleRuns(rows));
    rows.forEach((row, y) =>
      row.forEach((dark, x) => expect(grid[y + QUIET_MODULES][x + QUIET_MODULES]).toBe(dark)),
    );
    // The quiet zone is empty all the way round.
    const edge = grid.length;
    for (let i = 0; i < edge; i += 1) {
      for (let q = 0; q < QUIET_MODULES; q += 1) {
        expect(grid[q][i] || grid[edge - 1 - q][i] || grid[i][q] || grid[i][edge - 1 - q]).toBe(false);
      }
    }
  });

  it("merges a row's dark modules into runs, so neighbours share one rect", () => {
    const runs = moduleRuns([[true, true, false, true]]);
    expect(runs).toEqual([
      { x: QUIET_MODULES, y: QUIET_MODULES, w: 2 },
      { x: QUIET_MODULES + 3, y: QUIET_MODULES, w: 1 },
    ]);
  });
});
