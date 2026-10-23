/**
 * How a text fits a cell: the one rule of the WAGO close-up
 * (docs/PANEL_ENCLOSURE_R2.md §7.1) — the TypeScript twin of
 * `apps/api/app/services/label_fit.py`. Both run the table of cases in
 * `test/fixtures/enclosureFixtures.json` (`label_fit`). The app sheet and
 * the Aufbau PDF draw every marker, level and "für" text through it:
 *
 * 1. horizontal at `size.max` when it fits;
 * 2. horizontal, shrunk to the largest size ≥ `size.min` that fits;
 * 3. rotated 90° (the cell's height is then the length), max … min the
 *    same way;
 * 4. cut with "…" at `size.min`, in whichever orientation keeps more
 *    characters (a tie stays horizontal); trailing spaces before the "…" go.
 *
 * A size fits when the text's width is at most the cell's length and the
 * size itself at most the cell's other side. A shrunk size is floored to 0.1.
 *
 * The width is the sum of Helvetica's AFM advance widths (the PDF's font;
 * the table is Python's, which a test pins against reportlab), 556/1000 em
 * for a character the table lacks, × size × `scale`. The PDF uses
 * `scale = 1`; the app uses 1.1, because its UI font is not Helvetica and
 * needs a margin. Characters are code points (`Array.from`), as Python
 * counts them; the units are integers, so both sums agree exactly.
 */

export const ELLIPSIS = "…";
export const FALLBACK_UNITS = 556;
const EPS = 1e-9;

// Helvetica advance widths in 1/1000 em (WinAnsiEncoding, as reportlab draws it).
const ASCII_UNITS = [ // U+0020 … U+007E
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
] as const;
const LATIN1_UNITS = [ // U+00A0 … U+00FF
  278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333,
  400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
] as const;
const PUNCTUATION_UNITS: Readonly<Record<string, number>> = {
  "–": 556, "—": 1000, "…": 1000, "€": 556, "„": 333, "“": 333, "”": 333, "‚": 222, "‘": 222, "’": 222, "•": 350,
};

/** character → advance width in 1/1000 em. */
export const HELVETICA_UNITS: ReadonlyMap<string, number> = new Map<string, number>([
  ...ASCII_UNITS.map((units, i) => [String.fromCodePoint(0x20 + i), units] as const),
  ...LATIN1_UNITS.map((units, i) => [String.fromCodePoint(0xa0 + i), units] as const),
  ...Object.entries(PUNCTUATION_UNITS),
]);

export interface LabelFit {
  /** What to draw: the text, or its prefix and "…". */
  text: string;
  /** Font size, in the cell's unit. */
  size: number;
  /** Drawn 90°, along the cell's height. */
  rotated: boolean;
  /** The text was cut (or nothing fitted at all). */
  truncated: boolean;
}

export interface FitCell {
  w: number;
  h: number;
}

export interface FitSize {
  max: number;
  min: number;
}

/** The text's advance width in 1/1000 em (an integer: exact in both languages). */
export function textUnits(text: string): number {
  let total = 0;
  for (const char of text) total += HELVETICA_UNITS.get(char) ?? FALLBACK_UNITS;
  return total;
}

export function textWidth(text: string, size: number, scale = 1): number {
  return (textUnits(text) / 1000) * size * scale;
}

const fits = (units: number, size: number, length: number, cross: number, scale: number): boolean =>
  (units / 1000) * size * scale <= length + EPS && size <= cross + EPS;

/** The largest size ≤ max (and ≤ cross) at which the text fits, floored to 0.1. */
function largestSize(units: number, length: number, cross: number, max: number, scale: number): number {
  let size = Math.min(max, cross);
  if (units > 0) size = Math.min(size, length / ((units / 1000) * scale));
  return Math.floor(size * 10 + EPS) / 10;
}

function sized(units: number, length: number, cross: number, max: number, min: number, scale: number): number | null {
  if (fits(units, max, length, cross, scale)) return max;
  const size = largestSize(units, length, cross, max, scale);
  return size >= min - EPS && fits(units, size, length, cross, scale) ? size : null;
}

/**
 * [characters kept, the cut text] at `size`; [-1, ""] when not even "…"
 * fits. The count is the prefix length before its trailing spaces are cut.
 * Only U+0020 is cut — `trimEnd` would cut more than Python's `rstrip(" ")`.
 */
function kept(chars: readonly string[], length: number, cross: number, size: number, scale: number): [number, string] {
  for (let k = chars.length - 1; k >= 0; k -= 1) {
    const candidate = chars.slice(0, k).join("").replace(/ +$/, "") + ELLIPSIS;
    if (fits(textUnits(candidate), size, length, cross, scale)) return [k, candidate];
  }
  return [-1, ""];
}

/** How `text` is drawn in a `cell.w` × `cell.h` cell (see the module doc). */
export function fitLabel(text: string, cell: FitCell, size: FitSize, scale = 1): LabelFit {
  const min = Math.min(size.min, size.max);
  if (!text) return { text: "", size: size.max, rotated: false, truncated: false };
  const units = textUnits(text);
  const horizontal = sized(units, cell.w, cell.h, size.max, min, scale);
  if (horizontal !== null) return { text, size: horizontal, rotated: false, truncated: false };
  const rotated = sized(units, cell.h, cell.w, size.max, min, scale);
  if (rotated !== null) return { text, size: rotated, rotated: true, truncated: false };
  const chars = Array.from(text);
  const [flatK, flat] = kept(chars, cell.w, cell.h, min, scale);
  const [turnedK, turned] = kept(chars, cell.h, cell.w, min, scale);
  if (flatK < 0 && turnedK < 0) return { text: "", size: min, rotated: false, truncated: true };
  if (turnedK > flatK) return { text: turned, size: min, rotated: true, truncated: true };
  return { text: flat, size: min, rotated: false, truncated: true };
}
