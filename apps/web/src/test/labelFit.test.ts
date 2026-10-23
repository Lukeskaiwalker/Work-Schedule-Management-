/**
 * The one text-fit rule of the WAGO close-up (docs/PANEL_ENCLOSURE_R2.md
 * §7.1) — the TS twin of `apps/api/tests/test_label_fit.py`.
 *
 * `fitLabel` decides how a marker, a level or a "für" text is drawn in a
 * cell: horizontal at the largest size, shrunk to the minimum, rotated 90°,
 * and only then cut with an ellipsis. The app sheet (scale 1.1) and the PDF
 * (scale 1) share it, so both twins run the same table of cases, written by
 * Python into `enclosureFixtures.json` (`label_fit`).
 */
import { describe, expect, it } from "vitest";

import {
  ELLIPSIS,
  FALLBACK_UNITS,
  HELVETICA_UNITS,
  fitLabel,
  textUnits,
  textWidth,
  type LabelFit,
} from "../utils/labelFit";
import fixtures from "./fixtures/enclosureFixtures.json";

interface FitCase {
  text: string;
  cell: { w: number; h: number };
  size: { max: number; min: number };
  scale: number;
  fit: LabelFit;
}

const CASES = (fixtures as unknown as { label_fit: FitCase[] }).label_fit;
/** A 5.2 mm terminal under the PDF's 10 mm marker strip, in pt. */
const MARKER = { w: 14.74, h: 28.35 };
const NBSP = " ";

/** The fitted text must lie inside the cell it was fitted to. */
function expectInside(fit: LabelFit, cell: { w: number; h: number }, scale: number): void {
  const [length, cross] = fit.rotated ? [cell.h, cell.w] : [cell.w, cell.h];
  expect(textWidth(fit.text, fit.size, scale)).toBeLessThanOrEqual(length + 1e-9);
  if (fit.text) expect(fit.size).toBeLessThanOrEqual(cross);
}

describe("the width table", () => {
  it("is Python's table, entry for entry (count and two checksums of label_fit.HELVETICA_UNITS)", () => {
    const entries = [...HELVETICA_UNITS.entries()];
    expect(entries).toHaveLength(202);
    expect(entries.reduce((total, [, units]) => total + units, 0)).toBe(108834);
    expect(entries.reduce((total, [char, units]) => total + char.codePointAt(0)! * units, 0)).toBe(57356448);
  });

  it("falls back to 556/1000 em for a character it lacks and counts code points", () => {
    expect(FALLBACK_UNITS).toBe(556);
    expect(textUnits("→")).toBe(556);
    expect(textUnits("X1")).toBe(667 + 556);
    expect(textUnits("")).toBe(0);
    expect(textUnits("😀")).toBe(556); // one code point, two UTF-16 units
    expect(textUnits("Wärme")).toBe(944 + 556 + 333 + 833 + 556);
  });

  it("scales with size and scale", () => {
    expect(textWidth("X1", 6)).toBeCloseTo(7.338, 9);
    expect(textWidth("X1", 6, 1.1)).toBeCloseTo(7.338 * 1.1, 9);
  });
});

describe("fitLabel", () => {
  it("runs the shared table of cases exactly as Python does", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(8);
    for (const c of CASES) {
      const fit = fitLabel(c.text, c.cell, c.size, c.scale);
      expect(fit, JSON.stringify(c.text)).toEqual(c.fit);
      expectInside(fit, c.cell, c.scale);
    }
  });

  it.each<[string, string, { w: number; h: number }, { max: number; min: number }, number, LabelFit]>([
    ["1. horizontal at the largest size", "X1", MARKER, { max: 6, min: 5 }, 1, { text: "X1", size: 6, rotated: false, truncated: false }],
    ["2. horizontal, shrunk (floored to 0.1)", "10.12", MARKER, { max: 6, min: 5 }, 1, { text: "10.12", size: 5.8, rotated: false, truncated: false }],
    ["3. rotated 90°", "Steckdosen", MARKER, { max: 6, min: 5 }, 1, { text: "Steckdosen", size: 5.4, rotated: true, truncated: false }],
    ["4. ellipsis where more is kept", "Steckdosen Küche", MARKER, { max: 6, min: 5 }, 1, { text: "Steckdose…", size: 5, rotated: true, truncated: true }],
    ["4. a trailing space goes before the ellipsis", "ab cde", { w: 25, h: 10 }, { max: 10, min: 10 }, 1, { text: "ab…", size: 10, rotated: false, truncated: true }],
    ["4. a no-break space stays (not trimEnd)", `ab${NBSP}cde`, { w: 25, h: 10 }, { max: 10, min: 10 }, 1, { text: `ab${NBSP}…`, size: 10, rotated: false, truncated: true }],
    ["4. a tie stays horizontal (a square cell keeps as much either way)", "Steckdosen Küche", { w: 20, h: 20 }, { max: 6, min: 6 }, 1, { text: "Stec…", size: 6, rotated: false, truncated: true }],
    ["the app's 1.1 margin", "1.12", { w: 26, h: 40 }, { max: 13, min: 11 }, 1.1, { text: "1.12", size: 12.1, rotated: false, truncated: false }],
    ["nothing fits, not even the ellipsis", "Abc", { w: 2, h: 2 }, { max: 6, min: 5 }, 1, { text: "", size: 5, rotated: false, truncated: true }],
    ["the empty text", "", MARKER, { max: 6, min: 5 }, 1, { text: "", size: 6, rotated: false, truncated: false }],
  ])("%s", (_, text, cell, size, scale, expected) => {
    const fit = fitLabel(text, cell, size, scale);
    expect(fit).toEqual(expected);
    expectInside(fit, cell, scale);
  });

  it("uses scale 1 by default and a minimum above the maximum counts as the maximum", () => {
    expect(fitLabel("X1", MARKER, { max: 6, min: 5 })).toEqual(fitLabel("X1", MARKER, { max: 6, min: 5 }, 1));
    expect(fitLabel("Abc", { w: 2, h: 2 }, { max: 5, min: 9 })).toEqual({ text: "", size: 5, rotated: false, truncated: true });
  });

  it("keeps a prefix of the text and ends it with one ellipsis character", () => {
    expect(ELLIPSIS).toBe("…");
    const fit = fitLabel("Durchlauferhitzer Bad oben", { w: 30, h: 8 }, { max: 6, min: 5 });
    expect(fit.truncated).toBe(true);
    expect(fit.text.endsWith(ELLIPSIS)).toBe(true);
    expect("Durchlauferhitzer Bad oben".startsWith(fit.text.slice(0, -1))).toBe(true);
  });

  it("never splits a character outside the BMP", () => {
    // 6 × 556 units at size 2 = 6.672 > 4: cut; one emoji and the ellipsis fit (3.112).
    expect(fitLabel("😀😀😀😀😀😀", { w: 4, h: 2 }, { max: 2, min: 2 })).toEqual({ text: "😀…", size: 2, rotated: false, truncated: true });
  });
});
