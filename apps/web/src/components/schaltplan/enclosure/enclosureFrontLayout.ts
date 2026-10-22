/**
 * The pure half of the 2D cabinet drawing (docs/PANEL_ENCLOSURE.md §4, §11).
 *
 * Geometry decides WHERE every box is (`buildEnclosureScene`); this module
 * only decides how the screen shows it: the stepped zoom, whether a label
 * fits across, rotated or not at all, which 150 mm units of a field are
 * free, and the band around each rail that the one tap rule routes to
 * RailSheet. Kept apart from the component so each rule has its own test
 * and the SVG stays a plain map from boxes to shapes.
 */
import type { EnclosureScene, SceneBox } from "../../../types/panelEnclosure";

// ── Zoom ─────────────────────────────────────────────────────────────────────

/**
 * Screen px per cabinet mm, buttons only (gloves; no pinch). At the largest
 * step a 1-TE device is 23 px wide — still too small to aim at, which is why
 * a tap anywhere on the rail band opens RailSheet's 56 px tiles.
 */
export const ENCLOSURE_ZOOM_STEPS: readonly number[] = Object.freeze([0.2, 0.3, 0.45, 0.65, 0.9, 1.3]);

/** Room around the cabinet so its outer strokes are not clipped. */
export const DRAWING_PAD_PX = 4;
/** The band above the cabinet that names the fields ("Feld 1" …), constant in px at every zoom. */
export const FIELD_HEADER_PX = 24;

export function clampZoomStep(step: number): number {
  if (!Number.isFinite(step)) return 0;
  return Math.min(ENCLOSURE_ZOOM_STEPS.length - 1, Math.max(0, Math.floor(step)));
}

export function drawingSizePx(scene: Pick<EnclosureScene, "width" | "height">, zoom: number): { width: number; height: number } {
  return {
    width: scene.width * zoom + 2 * DRAWING_PAD_PX,
    height: scene.height * zoom + FIELD_HEADER_PX + 2 * DRAWING_PAD_PX,
  };
}

/** The largest step whose drawing fits `availablePx` across; the smallest when none does. */
export function initialZoomStep(sceneWidthMm: number, availablePx: number): number {
  if (!Number.isFinite(sceneWidthMm) || !Number.isFinite(availablePx) || availablePx <= 0) return 0;
  let best = 0;
  ENCLOSURE_ZOOM_STEPS.forEach((zoom, step) => {
    if (sceneWidthMm * zoom + 2 * DRAWING_PAD_PX <= availablePx) best = step;
  });
  return best;
}

/** scrollLeft/Top that keeps `centerRatio` (0…1 of the content) in the middle of the viewport. */
export function scrollForZoom(centerRatio: number, contentPx: number, clientPx: number): number {
  if (!Number.isFinite(centerRatio) || !Number.isFinite(contentPx) || !Number.isFinite(clientPx)) return 0;
  return Math.max(0, centerRatio * contentPx - clientPx / 2);
}

// ── Labels ───────────────────────────────────────────────────────────────────

/** Below this box width (CSS px) a device label is hidden (§4); RailSheet shows the full text. */
export const MIN_LABEL_BOX_PX = 9;
/** Device and meter labels, constant in px so they stay readable at every zoom. */
export const DEVICE_FONT_PX = 10;
export const SMALL_FONT_PX = 10;
export const FIELD_FONT_PX = 12;
const MIN_FONT_PX = 7;
/** Average advance of a glyph in the UI sans, as a share of the font size (digits and capitals). */
const CHAR_EM = 0.6;
const PAD_ALONG_PX = 2;
const PAD_ACROSS_PX = 1;
const ELLIPSIS = "…";

export type LabelMode = "horizontal" | "rotated" | "hidden";
export interface FittedLabel {
  mode: LabelMode;
  text: string;
  fontPx: number;
}

const HIDDEN: FittedLabel = Object.freeze({ mode: "hidden", text: "", fontPx: 0 }) as FittedLabel;

export function estimateTextPx(text: string, fontPx: number): number {
  return Array.from(text).length * fontPx * CHAR_EM;
}

/** `text` cut with "…" to `maxPx`; "" when not even two letters and the ellipsis fit. */
function truncateToPx(text: string, maxPx: number, fontPx: number): string {
  const points = Array.from(text);
  const capacity = Math.floor(maxPx / (fontPx * CHAR_EM));
  if (points.length <= capacity) return text;
  if (capacity < 3) return "";
  return `${points.slice(0, capacity - 1).join("").trimEnd()}${ELLIPSIS}`;
}

/**
 * A device or meter label (§4): across when it fits; else rotated 90° in a
 * box taller than wide (font shrunk to the box width, never below 7 px);
 * hidden below 9 px box width. Cut with "…" rather than overflow the box.
 */
export function fitBoxLabel(text: string, widthPx: number, heightPx: number, fontPx: number): FittedLabel {
  const value = text.trim();
  if (!value || !(widthPx >= MIN_LABEL_BOX_PX)) return HIDDEN;
  const acrossFits = fontPx <= heightPx - 2 * PAD_ACROSS_PX;
  if (acrossFits && estimateTextPx(value, fontPx) <= widthPx - 2 * PAD_ALONG_PX) {
    return { mode: "horizontal", text: value, fontPx };
  }
  if (heightPx > widthPx) {
    const font = Math.min(fontPx, widthPx - 2 * PAD_ACROSS_PX);
    if (font < MIN_FONT_PX) return HIDDEN;
    const cut = truncateToPx(value, heightPx - 2 * PAD_ALONG_PX, font);
    return cut ? { mode: "rotated", text: cut, fontPx: font } : HIDDEN;
  }
  return fitLineLabel(value, widthPx, heightPx, fontPx);
}

/** A one-line label (rail, zone, gap, module): across, cut to the width, or hidden. */
export function fitLineLabel(text: string, widthPx: number, heightPx: number, fontPx: number): FittedLabel {
  const value = text.trim();
  if (!value || fontPx > heightPx - 2 * PAD_ACROSS_PX) return HIDDEN;
  const cut = truncateToPx(value, widthPx - 2 * PAD_ALONG_PX, fontPx);
  return cut ? { mode: "horizontal", text: cut, fontPx } : HIDDEN;
}

// ── Free units ───────────────────────────────────────────────────────────────

/** Hager univers Z raster; the catalogue's `unit_mm` default. */
export const DEFAULT_UNIT_MM = 150;
/** Geometry rounds to 0.1 mm; overlaps thinner than this are rounding, not a module. */
const EPS_MM = 0.5;

export interface FreeCell {
  field: number;
  unit: number;
  /** Units in this field — "Höhe {unit+1} von {units}". */
  units: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GapRun {
  field: number;
  unit: number;
  units: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w - EPS_MM && b.x < a.x + a.w - EPS_MM && a.y < b.y + b.h - EPS_MM && b.y < a.y + a.h - EPS_MM;
}

/** "field:3" → 3; null for anything else. */
function fieldNumber(box: SceneBox): number | null {
  const match = /^field:(\d+)$/.exec(box.id);
  return match ? Number(match[1]) : null;
}

export function fieldBoxes(scene: EnclosureScene): { field: number; box: SceneBox }[] {
  return scene.boxes
    .filter((box) => box.kind === "field")
    .map((box) => ({ field: fieldNumber(box), box }))
    .filter((entry): entry is { field: number; box: SceneBox } => entry.field !== null)
    .sort((a, b) => a.field - b.field);
}

/** Every raster unit of every field that no module box touches, field by field, top → bottom. */
export function freeCells(scene: EnclosureScene, unitMm: number = DEFAULT_UNIT_MM): FreeCell[] {
  if (!(unitMm > 0)) return [];
  const modules = scene.boxes.filter((box) => box.kind === "module");
  const cells: FreeCell[] = [];
  for (const { field, box } of fieldBoxes(scene)) {
    const units = Math.round(box.h / unitMm);
    for (let unit = 0; unit < units; unit += 1) {
      const cell = { x: box.x, y: box.y + unit * unitMm, w: box.w, h: unitMm };
      if (!modules.some((module) => overlaps(module, cell))) cells.push({ field, unit, units, ...cell });
    }
  }
  return cells;
}

/** Neighbouring free cells of one field joined into one drawn gap. */
export function gapRuns(cells: readonly FreeCell[]): GapRun[] {
  return cells.reduce<GapRun[]>((runs, cell) => {
    const last = runs[runs.length - 1];
    if (last && last.field === cell.field && last.unit + last.units === cell.unit) {
      return [...runs.slice(0, -1), { ...last, units: last.units + 1, h: last.h + cell.h }];
    }
    return [...runs, { field: cell.field, unit: cell.unit, units: 1, x: cell.x, y: cell.y, w: cell.w, h: cell.h }];
  }, []);
}

/** The field a cabinet x lies in; null in the margin. */
export function fieldIndexAt(scene: EnclosureScene, x: number): number | null {
  const hit = fieldBoxes(scene).find(({ box }) => x >= box.x - EPS_MM / 10 && x < box.x + box.w);
  return hit ? hit.field : null;
}

// ── Rail bands ───────────────────────────────────────────────────────────────

/** Half the drawn device height: the band is the rail centre ± this (§11 "rail box ± device height"). */
const BAND_HALF_MM = 45;
/** Beyond the rail ends, still inside the 20 mm the zone leaves around a 12-PLE rail. */
const BAND_PAD_MM = 15;

export interface RailBand {
  /** The rail/busbar box id, `rail:{moduleId}:{railKey}`. */
  boxId: string;
  moduleId: string;
  railKey: string;
  rowId: string | null;
  label: string;
  deviceCount: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

const DEVICE_KINDS = new Set(["device", "device_front"]);

/** One tap target per rail (open and closed view alike): the rail and every device on it, ± half a device height. */
export function railBands(scene: EnclosureScene): RailBand[] {
  const devices = scene.boxes.filter((box) => DEVICE_KINDS.has(box.kind));
  return scene.boxes
    .filter((box) => (box.kind === "rail" || box.kind === "busbar") && box.moduleId !== null && box.railKey !== null)
    .map((rail) => {
      const own = devices.filter((device) => device.moduleId === rail.moduleId && device.railKey === rail.railKey);
      const left = Math.min(rail.x, ...own.map((device) => device.x)) - BAND_PAD_MM;
      const right = Math.max(rail.x + rail.w, ...own.map((device) => device.x + device.w)) + BAND_PAD_MM;
      const cy = rail.y + rail.h / 2;
      return {
        boxId: rail.id,
        moduleId: rail.moduleId as string,
        railKey: rail.railKey as string,
        rowId: rail.rowId,
        label: rail.label,
        deviceCount: own.length,
        x: left,
        y: cy - BAND_HALF_MM,
        w: right - left,
        h: 2 * BAND_HALF_MM,
      };
    });
}
