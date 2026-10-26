/**
 * The pure half of the §14a sheet (docs/PANEL_ENCLOSURE_R4.md §8.2).
 *
 * - `controlBlockDrawing`: the block at 5 px/mm — 249-116 | n × 2002-1671 |
 *   2002-1692 | 249-116 — with each marker written at the size it prints at
 *   (`controlStripSize`) and a 6 mm wire stub under every terminal.
 * - `controlSheetState`: which of the sheet's four states a board is in (no
 *   meter field · no block · removed · present), and for a present block what
 *   the sheet reads: the field, the wires' target, the AAR rails it may sit
 *   on and the measured wire length.
 * - `controlBarEntry`: the field bar's second line ("6 Klemmen", "fehlt",
 *   "entfernt", "passt nicht").
 * - `parseLengthText`: a length as typed ("4,5", "4.5 m"), by rule 8.
 *
 * Everything reads the block through `parseControlBlock` (via `storedBlock`)
 * and the derivations of `enclosureControlBlock.ts` / `enclosurePrep.ts`, so
 * the sheet shows what the Materialliste will list.
 */
import { VERTICAL_PX_PER_MM, previewFontPx } from "../StripSvg";
import type { CatalogIndex } from "../../../utils/enclosureCatalog";
import {
  CONTROL_PARTS,
  blockParts,
  blockPoint,
  candidateRails,
  controlBlockLayout,
  controlCarrier,
  parseLengthM,
  storedBlock,
  type BlockLayout,
  type Carrier,
} from "../../../utils/enclosureControlBlock";
import { controlTarget, makeRun, wireDm, type End } from "../../../utils/enclosurePrep";
import { railTitle } from "../../../utils/enclosureTerminals";
import { CONTROL_STRIP_HEIGHT_MM, controlStripSize } from "../../../utils/schaltplanStrip";
import type { ControlBlock, ControlPartId, ControlTerminal, WireColour } from "../../../types/panelEnclosure";
import type { PanelDocument } from "../../../types/schaltplan";

// ── Drawing ──────────────────────────────────────────────────────────────────

/** Room around the block so the outer strokes are not clipped, px. */
export const CONTROL_DRAWING_PAD_PX = 4;
/** Drawn housing heights, mm: schematic (the real parts are taller), so the sheet stays short on a phone. */
const TERMINAL_BODY_MM = 30;
const END_STOP_MM = 24;
/** The wire stub under each terminal, mm. */
const STUB_MM = 6;

export interface DrawnPart {
  key: string;
  partId: ControlPartId;
  /** px, in the drawing. */
  x: number;
  y: number;
  w: number;
  h: number;
  label: string | null;
  color: WireColour | null;
  /** 1-based terminal position; null for the end stops and the end plate. */
  position: number | null;
}

export interface ControlBlockDrawing {
  width: number;
  height: number;
  parts: DrawnPart[];
  /** The marker band across the terminals, px. */
  marker: { y: number; h: number };
  /** The wire stubs under the terminals, px. */
  stub: { y: number; h: number };
  /** The marker text at its print size, px. */
  fontPx: number;
  ariaLabel: string;
}

export function controlBlockDrawing(terminals: readonly ControlTerminal[]): ControlBlockDrawing {
  const scale = VERTICAL_PX_PER_MM;
  const pad = CONTROL_DRAWING_PAD_PX;
  const { parts, widthMm } = blockParts(terminals);
  const bodyTop = pad;
  const bodyH = TERMINAL_BODY_MM * scale;
  const drawn = parts.map((part, i): DrawnPart => {
    const tall = part.partId !== "249-116";
    const h = (tall ? TERMINAL_BODY_MM : END_STOP_MM) * scale;
    return {
      key: `${part.partId}:${part.terminalId ?? i}`,
      partId: part.partId,
      x: pad + part.offsetMm * scale,
      y: bodyTop + (bodyH - h) / 2,
      w: CONTROL_PARTS[part.partId].width_mm * scale,
      h,
      label: part.label,
      color: part.color,
      position: part.position,
    };
  });
  const markerH = CONTROL_STRIP_HEIGHT_MM * scale;
  const stubY = bodyTop + bodyH;
  const labels = terminals.map((terminal) => terminal.label);
  return {
    width: widthMm * scale + 2 * pad,
    height: stubY + STUB_MM * scale + pad,
    parts: drawn,
    marker: { y: bodyTop + (bodyH - markerH) / 2, h: markerH },
    stub: { y: stubY, h: STUB_MM * scale },
    fontPx: previewFontPx(controlStripSize(labels), scale),
    ariaLabel: `§14a-Klemmleiste: ${labels.map((label) => label || "leer").join(", ")}`,
  };
}

// ── The sheet's state ────────────────────────────────────────────────────────

export interface RailChoice {
  key: string;
  /** "F1 · AAR 1" (`default_rail_label`, never the row label). */
  title: string;
}

export type ControlSheetState =
  | { kind: "no-carrier" }
  | { kind: "absent"; carrier: Carrier }
  | { kind: "off"; carrier: Carrier; block: ControlBlock }
  | {
      kind: "present";
      carrier: Carrier;
      block: ControlBlock;
      /** Null when the block has no terminal or the carrier no AAR rail. */
      layout: BlockLayout | null;
      /** 0-based field of the block (its AAR zone), else of the carrier. */
      field: number;
      /** Where the wires run to (RfZ above the eHZ meter, the APZ for 3-Punkt); null = none. */
      target: End | null;
      rails: RailChoice[];
      /** Metres per wire from the drawing plus the reserve (§3.3 e); null without a target. */
      measuredM: number | null;
    };

export function controlSheetState(document: PanelDocument, index: CatalogIndex): ControlSheetState {
  const carrier = controlCarrier(document, index);
  if (!carrier) return { kind: "no-carrier" };
  const block = storedBlock(document);
  if (!block) return { kind: "absent", carrier };
  if (block.off) return { kind: "off", carrier, block };
  const layout = controlBlockLayout(document, index, block);
  const target = controlTarget(document, index, carrier);
  const rails = candidateRails(document, index, carrier).map((candidate) => ({
    key: String(candidate.rail.key),
    title: railTitle(carrier.module, candidate.zone, candidate.position),
  }));
  const runMm = layout && target ? makeRun("control", blockPoint(layout), target.point, "").lengthMm : null;
  return {
    kind: "present",
    carrier,
    block,
    layout,
    field: layout ? layout.field : carrier.field,
    target,
    rails,
    measuredM: runMm === null ? null : wireDm(null, runMm) / 10,
  };
}

/** The field bar's "§14a-Klemmen" line on the carrier's field; null without a meter field. */
export function controlBarEntry(state: ControlSheetState): { field: number; sub: string } | null {
  switch (state.kind) {
    case "no-carrier":
      return null;
    case "absent":
      return { field: state.carrier.field, sub: "fehlt" };
    case "off":
      return { field: state.carrier.field, sub: "entfernt" };
    case "present": {
      const count = state.block.terminals.length;
      const unplaced = count > 0 && (!state.layout || state.layout.overflow);
      return { field: state.carrier.field, sub: unplaced ? "passt nicht" : count === 1 ? "1 Klemme" : `${count} Klemmen` };
    }
  }
}

// ── Length as typed ──────────────────────────────────────────────────────────

export type LengthText = { kind: "empty" } | { kind: "value"; metres: number } | { kind: "invalid" };

const LENGTH_TEXT = /^(\d+(?:[.,]\d+)?)\s*m?$/i;

/** "" → empty (back to the drawing); "4,5" / "4.5 m" → metres by rule 8 (0,5 … 20, one decimal); else invalid. */
export function parseLengthText(text: string): LengthText {
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "empty" };
  const match = LENGTH_TEXT.exec(trimmed);
  const metres = match ? parseLengthM(Number(match[1].replace(",", "."))) : null;
  return metres === null ? { kind: "invalid" } : { kind: "value", metres };
}
