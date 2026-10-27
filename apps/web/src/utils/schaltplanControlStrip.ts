/**
 * The §14a block on the printer, as the print sheet sees it
 * (docs/PANEL_ENCLOSURE_R4.md §9.1–§9.2) — the predicates of
 * `apps/api/app/services/werkstatt_label_control_strip.py`.
 *
 * **The block strip** (`control:block`) is one more item of the Klemmen
 * list, always the last: one 5,2 mm segment per 2002-1671 on the 2009-110,
 * every label written across the strip at ONE size (`controlStripSize`). A
 * blank label keeps its empty segment, so every later label stays on its
 * own terminal. A label that cannot be printed at 24 dots is never sent:
 * the sheet disables the item, the server would answer 400.
 *
 * **The wire labels** (`control:wires`) are the ordinary rail strip on the
 * board's own heat-shrink tube: every named terminal twice, one sleeve at
 * each end of the wire. Both read the labels as printed (`printedLabel`).
 *
 * Both read the block only through `parseControlBlock` and need no
 * catalogue: the strip prints whether or not the block has found its rail.
 * Kept apart from `schaltplanStrip.ts` / `schaltplanTerminals.ts` because
 * the parser's module imports theirs; importing it back would close a cycle.
 */
import { CONTROL_LABEL_MAX, WIRE_LABEL_MAX_DOTS, WIRE_LABEL_PIECE_MM, storedBlock } from "./enclosureControlBlock";
import {
  CONTROL_SEGMENT_MM,
  SEG_PAD_DOTS,
  controlLabelFits,
  controlStripSize,
  fontSizeForSegments,
  type BoardFontSize,
  type FitSegment,
} from "./schaltplanStrip";
import type { TubeMaterialId } from "../types/panelEnclosure";

export const CONTROL_STRIP_ID = "control:block";
export const WIRE_STRIP_ID = "control:wires";
/** The block strip's row in the Klemmen list. */
export const CONTROL_STRIP_TITLE = "§14a-Klemmleiste (senkrecht beschriftet)";
/** What the wire labels are called on the preview and in the server's answer. */
export const WIRE_STRIP_LABEL = "Aderbeschriftung";

export const CONTROL_STALE_DETAIL =
  "Die §14a-Klemmleiste wurde geändert oder entfernt — nichts gedruckt. Bitte die Seite neu laden und erneut drucken.";
export const NO_WIRE_LABELS_DETAIL = "Keine Aderbeschriftung — erst Klemmen benennen.";

export function labelTooLongDetail(label: string): string {
  return `„${label}“ ist zu lang für die Klemme — in der §14a-Klemmleiste kürzen.`;
}

export interface ControlStripItem {
  stripId: typeof CONTROL_STRIP_ID;
  title: string;
  /** Every terminal's label, left → right; "" is an empty segment. */
  labels: string[];
  /** The strip's own size, in dots (`controlStripSize`). */
  sizeDots: number;
  partCount: number;
  blankCount: number;
  /** Printed length between the end lines: 5,2 mm per terminal, `round1`. */
  lengthMm: number;
  /** The first label that cannot be printed at 24 dots; null when all fit. */
  tooLong: string | null;
}

/** Python's whitespace for `str.split()` above U+001F (the controls are blanked before). */
const PRINTER_SPACE = /[ \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;

/**
 * A label as the printer prints it — twin of `printed_label` (the printer
 * path's `_clean`): controls, DEL and the EZPL prefixes `~` and `^` become
 * spaces, runs of spaces collapse, the ends are cut. Counts, sizes and the
 * preview read this, so "A^B" shows as "A B" and a label of only "~" is blank.
 */
export function printedLabel(label: string): string {
  const blanked = Array.from(label, (ch) => (ch < " " || ch === "\u007f" || ch === "~" || ch === "^" ? " " : ch)).join("");
  const collapsed = blanked.split(PRINTER_SPACE).filter((part) => part !== "").join(" ");
  return Array.from(collapsed).slice(0, CONTROL_LABEL_MAX).join("").replace(/^ +| +$/g, "");
}

function round1(value: number): number {
  return Math.floor(value * 10 + 0.5) / 10;
}

/** The block strip of a board, or null without a block, when it is off or has no terminal. */
export function controlStrip(document: unknown): ControlStripItem | null {
  const block = storedBlock(document);
  if (!block || block.off || block.terminals.length === 0) return null;
  const labels = block.terminals.map((terminal) => printedLabel(terminal.label));
  let lengthMm = 0;
  for (let i = 0; i < labels.length; i += 1) lengthMm += CONTROL_SEGMENT_MM;
  return {
    stripId: CONTROL_STRIP_ID,
    title: CONTROL_STRIP_TITLE,
    labels,
    sizeDots: controlStripSize(labels),
    partCount: labels.length,
    blankCount: labels.filter((label) => label === "").length,
    lengthMm: round1(lengthMm),
    tooLong: labels.find((label) => !controlLabelFits(label)) ?? null,
  };
}

/** The block strip when it can be printed — what "Alle" and the derived set may contain. */
export function printableControl(control: ControlStripItem | null): ControlStripItem | null {
  return control && control.tooLong === null ? control : null;
}

/**
 * Every strip id the Klemmen sheet can print, in board order, the §14a strip
 * last — the "Alle" set, the derived set and what the Klemmen tab opens with.
 */
export function klemmenStripIds(
  groups: readonly { strips: readonly { stripId: string }[] }[],
  control: ControlStripItem | null,
): string[] {
  const ids = groups.flatMap((group) => group.strips.map((strip) => strip.stripId));
  return printableControl(control) ? [...ids, CONTROL_STRIP_ID] : ids;
}

// ── Aderbeschriftung (§9.2) ──────────────────────────────────────────────────

/** Every named terminal twice, left → right, one sleeve each; null = nothing to print. */
export function wireLabelSegments(document: unknown): FitSegment[] | null {
  const block = storedBlock(document);
  if (!block || block.off) return null;
  const segments = block.terminals.flatMap((terminal) => {
    const text = printedLabel(terminal.label);
    return text ? [{ text, widthMm: WIRE_LABEL_PIECE_MM }, { text, widthMm: WIRE_LABEL_PIECE_MM }] : [];
  });
  return segments.length > 0 ? segments : null;
}

/** The rail strip's fit on the tube, at most `WIRE_LABEL_MAX_DOTS` (twin of `wire_label_size`). */
export function wireLabelSize(segments: readonly FitSegment[], tubeWidthMm: number): BoardFontSize {
  const fit = fontSizeForSegments(segments, tubeWidthMm, SEG_PAD_DOTS);
  return { sizeDots: Math.min(fit.sizeDots, WIRE_LABEL_MAX_DOTS), overflowing: fit.overflowing };
}

export interface TubeMaterial {
  id: TubeMaterialId;
  label: string;
  /** Flat width of the built-in profile (`werkstatt_label_builtins`): the band the text has. */
  widthMm: number;
  hint: string;
}

const TUBES: Readonly<Record<TubeMaterialId, { label: string; widthMm: number; bore: string }>> = {
  "wago-211-502": { label: "WAGO 211-502", widthMm: 7.5, bore: "Ø 4,8 mm" },
  "wago-211-501": { label: "WAGO 211-501", widthMm: 5, bore: "Ø 3,2 mm" },
};

/** The board's tube as the sheet's one material chip. */
export function tubeMaterial(id: TubeMaterialId): TubeMaterial {
  const tube = TUBES[id];
  return {
    id,
    label: tube.label,
    widthMm: tube.widthMm,
    hint: `Schrumpfschlauch ${tube.label} (${tube.bore}) einlegen — nicht den 11-mm-Streifen.`,
  };
}
