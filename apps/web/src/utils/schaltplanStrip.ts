/**
 * BMK label strip geometry and the board-wide font size.
 *
 * The printer lays one continuous WAGO 2009-110 strip per rail, one segment
 * per *labelled* device, so the strip can be stuck on in a single pass and
 * cut at the marks. A segment is exactly as wide as the device it sits on.
 * Blindabdeckungen and devices without a BMK get no segment and no width:
 * the strip simply continues with the next labelled device, and whoever
 * sticks it on skips the blank.
 *
 * Every BMK on the board is printed at ONE size — the largest size at which
 * the tightest segment of the whole document still holds its text — so the
 * rail printed today matches the rail printed last week, and no two fields
 * on one board differ in height.
 *
 * Mirrors `apps/api/app/services/schaltplan_layout.py` (`strip_segments`,
 * `board_font_size`, `GLYPH_ADVANCE_EM`). Keep the two in step: the preview
 * drawn from this file is what the electrician checks before the strip
 * feeds, and a divergence means a strip that is right on screen and wrong
 * in the hand.
 */
import type { DeviceKind, PanelDevice, PanelRow } from "../types/schaltplan";

/** Nominal module width (DIN 43880). A 4 TE FI is 70 mm; a 12-module rail 210 mm. */
export const MODULE_WIDTH_MM = 17.5;

/** Blank lead the printer adds before the start line and after the end line. */
export const STRIP_LEAD_MM = 3;

/** Width across the 2009-110 strip, i.e. the height of the printed band. */
export const STRIP_HEIGHT_MM = 11;

/** WAGO 210-805 die-cut single label, 15 mm along × 6 mm across. */
export const SINGLE_LABEL_WIDTH_MM = 15;
export const SINGLE_LABEL_HEIGHT_MM = 6;

/** Printer resolution the layout is computed in (300 dpi ≈ 12 dots/mm). */
export const DOTS_PER_MM = 12;

/** Padding kept free on either side of a BMK inside its segment, in dots. */
export const SEG_PAD_DOTS = 12;

/** Smallest font the strip is ever printed at — below this a BMK is unreadable on the rail. */
export const MIN_FONT_DOTS = 24;

/** The largest font may never fall below this, however narrow the stock. */
export const MAX_FONT_DOTS_FLOOR = 16;

/** The largest font is capped at this share of the strip height … */
export const MAX_FONT_HEIGHT_RATIO = 0.72;

/** … and at the strip height minus this margin, whichever is smaller. */
export const MAX_FONT_MARGIN_DOTS = 12;

/** Advance for a glyph outside the table, in em. */
export const FALLBACK_ADVANCE_EM = 0.58;

/**
 * Horizontal advance per glyph, in em, for Arial regular — the face the
 * printer sets BMKs in. Covers printable ASCII plus the German umlauts, ß,
 * ° and µ that turn up in Betriebsmittelkennzeichen. The same table lives
 * in `schaltplan_layout.py` as `GLYPH_ADVANCE_EM`; change both or neither.
 */
export const GLYPH_ADVANCE_EM: Readonly<Record<string, number>> = {
  " ": 0.278, "!": 0.278, "\"": 0.355, "#": 0.556, "$": 0.556, "%": 0.889,
  "&": 0.667, "'": 0.191, "(": 0.333, ")": 0.333, "*": 0.389, "+": 0.584,
  ",": 0.278, "-": 0.333, ".": 0.278, "/": 0.278, "0": 0.556, "1": 0.556,
  "2": 0.556, "3": 0.556, "4": 0.556, "5": 0.556, "6": 0.556, "7": 0.556,
  "8": 0.556, "9": 0.556, ":": 0.278, ";": 0.278, "<": 0.584, "=": 0.584,
  ">": 0.584, "?": 0.556, "@": 1.015, "A": 0.667, "B": 0.667, "C": 0.722,
  "D": 0.722, "E": 0.667, "F": 0.611, "G": 0.778, "H": 0.722, "I": 0.278,
  "J": 0.5, "K": 0.667, "L": 0.556, "M": 0.833, "N": 0.722, "O": 0.778,
  "P": 0.667, "Q": 0.778, "R": 0.722, "S": 0.667, "T": 0.611, "U": 0.722,
  "V": 0.667, "W": 0.944, "X": 0.667, "Y": 0.667, "Z": 0.611, "[": 0.278,
  "\\": 0.278, "]": 0.278, "^": 0.469, "_": 0.556, "`": 0.333, "a": 0.556,
  "b": 0.556, "c": 0.5, "d": 0.556, "e": 0.556, "f": 0.278, "g": 0.556,
  "h": 0.556, "i": 0.222, "j": 0.222, "k": 0.5, "l": 0.222, "m": 0.833,
  "n": 0.556, "o": 0.556, "p": 0.556, "q": 0.556, "r": 0.333, "s": 0.5,
  "t": 0.278, "u": 0.556, "v": 0.5, "w": 0.722, "x": 0.5, "y": 0.5,
  "z": 0.5, "{": 0.334, "|": 0.26, "}": 0.334, "~": 0.584, "Ä": 0.667,
  "Ö": 0.778, "Ü": 0.722, "ä": 0.556, "ö": 0.556, "ü": 0.556, "ß": 0.611,
  "°": 0.4, "µ": 0.576,
};

export const LABEL_MATERIALS = [
  {
    id: "wago-2009-110",
    label: "WAGO 2009-110",
    hint: "11 mm Endlosstreifen — ein Streifen je Reihe, mit Schnittmarken",
  },
  {
    id: "wago-210-805",
    label: "WAGO 210-805",
    hint: "Einzeletiketten 6 × 15 mm — ein Etikett je BMK",
  },
] as const;

export type LabelMaterialId = (typeof LABEL_MATERIALS)[number]["id"];

export const DEFAULT_LABEL_MATERIAL: LabelMaterialId = "wago-2009-110";

export function isLabelMaterialId(value: string): value is LabelMaterialId {
  return LABEL_MATERIALS.some((material) => material.id === value);
}

export interface StripSegment {
  deviceId: string;
  kind: DeviceKind;
  /** Printed text — never empty; a device without one gets no segment at all. */
  text: string;
  widthMm: number;
  /** Running offset in mm from the first labelled device on the rail. */
  start: number;
}

type RowLike = Pick<PanelRow, "devices">;
type DocumentLike = { rows: ReadonlyArray<RowLike> };

/**
 * The real mounted width of a device.
 *
 * An explicit `width_mm` wins whenever it is a usable number; anything else
 * (null, 0, NaN, a negative from a half-typed field) falls back to the
 * modular width, so a bad value can never collapse a segment to nothing.
 */
export function deviceWidthMm(device: Pick<PanelDevice, "te" | "width_mm">): number {
  const explicit = device.width_mm;
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  // Whole modules only, exactly like the API (`int(te)`): a half module typed
  // into the inspector must not preview wider than it will print.
  return Math.max(1, Math.trunc(device.te) || 1) * MODULE_WIDTH_MM;
}

/** What the segment says — nothing for a blank cover or an unnamed device. */
/**
 * What is trimmed off a BMK before it counts as text. Spelled out because the
 * API trims with the same pattern: JS trim() and Python strip() disagree on
 * U+FEFF and the C0 controls, and a designation made only of those must be
 * "ohne BMK" on both sides.
 */
const BMK_EDGE_JUNK = /^[\s\ufeff\u0000-\u001f\u007f]+|[\s\ufeff\u0000-\u001f\u007f]+$/g;

/** Trim a marker text the way the printer path does — shared with the Reihenklemmen strip. */
export function trimMarkerText(text: string): string {
  return (text ?? "").replace(BMK_EDGE_JUNK, "");
}

export function segmentText(device: Pick<PanelDevice, "kind" | "designation">): string {
  if (device.kind === "blank") return "";
  return trimMarkerText(device.designation);
}

/** Does this device get a segment on the strip? Blanks and unnamed devices do not. */
export function isLabelled(device: Pick<PanelDevice, "kind" | "designation">): boolean {
  return segmentText(device) !== "";
}

export function stripSegments(row: RowLike): StripSegment[] {
  return row.devices.filter(isLabelled).reduce<StripSegment[]>((segments, device) => {
    const previous = segments[segments.length - 1];
    const start = previous ? previous.start + previous.widthMm : 0;
    return [
      ...segments,
      {
        deviceId: device.id,
        kind: device.kind,
        text: segmentText(device),
        widthMm: deviceWidthMm(device),
        start,
      },
    ];
  }, []);
}

/** Printed length between the start and end lines, without the lead: the emitted segments only. */
export function stripLengthMm(row: RowLike): number {
  return stripSegments(row).reduce((total, segment) => total + segment.widthMm, 0);
}

/** Total strip the printer feeds: lead + printed length + lead. */
export function stripTotalMm(row: RowLike): number {
  return STRIP_LEAD_MM + stripLengthMm(row) + STRIP_LEAD_MM;
}

export interface RowLabelCounts {
  /** Devices that get a printed BMK. */
  labelled: number;
  /** Real devices without a BMK — skipped on the strip. A blank cover is not counted; it was never meant to have one. */
  withoutBmk: number;
}

export function rowLabelCounts(row: RowLike): RowLabelCounts {
  return row.devices.reduce<RowLabelCounts>(
    (counts, device) => {
      if (device.kind === "blank") return counts;
      return isLabelled(device)
        ? { ...counts, labelled: counts.labelled + 1 }
        : { ...counts, withoutBmk: counts.withoutBmk + 1 };
    },
    { labelled: 0, withoutBmk: 0 },
  );
}

/** The 210-805 view of a rail: one label per BMK, in rail order — the same devices the strip prints. */
export function singleLabels(row: RowLike): StripSegment[] {
  return stripSegments(row);
}

/** Width of a text in em: the sum of its glyph advances. Multiply by the font size for dots. */
export function textWidthEm(text: string): number {
  return Array.from(text).reduce(
    (total, glyph) => total + (GLYPH_ADVANCE_EM[glyph] ?? FALLBACK_ADVANCE_EM),
    0,
  );
}

/** Largest font the stock allows: max(16, min(h − 12, ⌊0.72 h⌋)) with h the strip height in dots. */
export function maxFontDots(stripWidthMm: number): number {
  // Whole millimetres first, then dots — the printer frames the strip as
  // round(width) × 12, and the twin sizes against the same height.
  const heightDots = Math.round(stripWidthMm) * DOTS_PER_MM;
  return Math.max(
    MAX_FONT_DOTS_FLOOR,
    Math.min(heightDots - MAX_FONT_MARGIN_DOTS, Math.trunc(MAX_FONT_HEIGHT_RATIO * heightDots)),
  );
}

export interface BoardFontSize {
  /** The one size every BMK on the board is printed at, in dots. */
  sizeDots: number;
  /** BMK texts that will run past their segment even at the smallest size, in document order. */
  overflowing: string[];
}

/** A text and the segment it has to fit into — a labelled device, or a terminal marker. */
export interface FitSegment {
  text: string;
  widthMm: number;
}

interface SegmentFit {
  text: string;
  /** The font size (dots) at which this text exactly fills its segment minus the padding. */
  fit: number;
}

/**
 * ONE font size for a list of segments: the largest size at which the
 * tightest segment still holds its text, floored to whole dots and clamped
 * to [MIN_FONT_DOTS, maxFontDots]. `padDots` is what stays free between a
 * cut mark and the text on either side — 1 mm on the BMK strip, 0.5 mm on
 * a Reihenklemme (`schaltplanTerminals.TERMINAL_SEG_PAD_DOTS`). An empty
 * list gets the maximum. Twin of `font_size_for_fits` on the backend.
 */
export function fontSizeForSegments(
  segments: readonly FitSegment[],
  stripWidthMm: number,
  padDots: number = SEG_PAD_DOTS,
): BoardFontSize {
  const max = maxFontDots(stripWidthMm);
  const fits: SegmentFit[] = segments
    .filter((segment) => segment.text !== "")
    .map((segment) => ({
      text: segment.text,
      fit: (segment.widthMm * DOTS_PER_MM - 2 * padDots) / textWidthEm(segment.text),
    }));
  if (fits.length === 0) return { sizeDots: max, overflowing: [] };
  const tightest = fits.reduce((smallest, entry) => Math.min(smallest, entry.fit), Number.POSITIVE_INFINITY);
  return {
    sizeDots: Math.min(max, Math.max(MIN_FONT_DOTS, Math.floor(tightest))),
    overflowing: fits.filter((entry) => entry.fit < MIN_FONT_DOTS).map((entry) => entry.text),
  };
}

function labelledSegments(document: DocumentLike): FitSegment[] {
  return document.rows.flatMap((row) =>
    row.devices.filter(isLabelled).map((device) => ({
      text: segmentText(device),
      widthMm: deviceWidthMm(device),
    })),
  );
}

/**
 * The board font size: every labelled device of every row, fitted with the
 * BMK pad. Computed over the whole document, not just the rails being
 * printed, so a rail reprinted later matches the others. A board with
 * nothing labelled gets the maximum.
 */
export function boardFontSize(document: DocumentLike, stripWidthMm: number): BoardFontSize {
  return fontSizeForSegments(labelledSegments(document), stripWidthMm, SEG_PAD_DOTS);
}

/**
 * Chip values for the inspector's "Breite (mm)" field: the nominal DIN
 * width and the 18 mm-per-module rounding some makers use, for the
 * device's current TE. A 4 TE FI offers 70 / 72, a 1 TE LS 17,5 / 18.
 */
export function widthSuggestionsMm(te: number): number[] {
  const modules = Math.max(1, te || 1);
  return [modules * MODULE_WIDTH_MM, modules * 18];
}

/** "17,5" / "70" — German decimal comma, no trailing zeros. */
export function formatMm(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return String(rounded).replace(".", ",");
}

/** A font size in dots as millimetres with one decimal: 92 dots → "7,7". */
export function formatFontMm(sizeDots: number): string {
  return (sizeDots / DOTS_PER_MM).toFixed(1).replace(".", ",");
}
