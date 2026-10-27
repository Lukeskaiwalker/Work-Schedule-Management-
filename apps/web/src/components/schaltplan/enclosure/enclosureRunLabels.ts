/**
 * Where a lead's label goes in the 2D cabinet drawing (docs/PANEL_ENCLOSURE_R4.md
 * §5) — the Aufbau PDF's placement (`_label_spot` in panel_enclosure_pdf.py)
 * for the SVG: the label follows its segment (turned 90°, reading bottom →
 * top, on a vertical one) and moves along the run, longest segment first,
 * stops 0,5 · 0,3 · 0,7 · 0,15 · 0,85, until it covers no box label and no
 * other run label. Unlike the PDF it also tries the other side of the
 * segment, stays inside the drawing — the SVG clips at its viewBox, and a
 * label centred near the cabinet's left edge lost the article number of the
 * supply kit — and, when no spot is clear, takes the one covering least.
 *
 * Text is sized in screen px and converted with the zoom, so every width
 * here is an estimate in cabinet mm (jsdom has no layout; the same estimate
 * runs in the browser). Pure.
 */
import type { PrepRun, SceneBox } from "../../../types/panelEnclosure";

/** x0, y0, x1, y1 in cabinet mm (y down). */
export type LabelRect = readonly [number, number, number, number];

export interface RunLabelSpot {
  /** The point on the segment the label hangs from (the rotation centre of a vertical one). */
  x: number;
  y: number;
  vertical: boolean;
  /** The baseline's offset from the segment before any rotation, mm: negative above/left of it, positive below/right. */
  baseline: number;
  rect: LabelRect;
}

/** Where a run label may sit along a segment, in order of preference (the PDF's stops). */
export const RUN_LABEL_STOPS = [0.5, 0.3, 0.7, 0.15, 0.85] as const;
/** The label's baseline sits this far off its segment, px. */
export const RUN_LABEL_LIFT_PX = 6;
/** Average advance of the drawing's font, em: an estimate that errs wide (Source Sans 3 caps run ≈ 0,63). */
const ADVANCE_EM = 0.62;
/** Ascent and descent of a line, em (WebKit's text box is 1,16 em high). */
const ASCENT_EM = 0.9;
const DESCENT_EM = 0.3;
/** A box label's line box, em. */
const LINE_EM = 1.2;

/** The estimated width of a text in screen px. */
export function textWidthPx(text: string, fontPx: number): number {
  return Array.from(text).length * ADVANCE_EM * fontPx;
}

const overlaps = (a: LabelRect, b: LabelRect): boolean => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

const clamp = (value: number, low: number, high: number): number => (low > high ? (low + high) / 2 : Math.min(high, Math.max(low, value)));

interface Metrics {
  /** Text width, height and lift, cabinet mm. */
  w: number;
  h: number;
  lift: number;
}

/** The band the text takes across its segment: [near, far] from the segment line, for a side. */
function across(side: -1 | 1, m: Metrics): { baseline: number; low: number; high: number } {
  if (side < 0) return { baseline: -m.lift, low: -m.lift - ASCENT_EM * m.h, high: -m.lift + DESCENT_EM * m.h };
  const baseline = m.lift + ASCENT_EM * m.h;
  return { baseline, low: m.lift, high: baseline + DESCENT_EM * m.h };
}

function spotAt(x: number, y: number, vertical: boolean, side: -1 | 1, m: Metrics, bounds: LabelRect): RunLabelSpot {
  const band = across(side, m);
  if (vertical) {
    // rotate(-90) maps an offset v below the baseline to v right of the segment: the band keeps its numbers.
    const cy = clamp(y, bounds[1] + m.w / 2, bounds[3] - m.w / 2);
    return { x, y: cy, vertical, baseline: band.baseline, rect: [x + band.low, cy - m.w / 2, x + band.high, cy + m.w / 2] };
  }
  const cx = clamp(x, bounds[0] + m.w / 2, bounds[2] - m.w / 2);
  return { x: cx, y, vertical, baseline: band.baseline, rect: [cx - m.w / 2, y + band.low, cx + m.w / 2, y + band.high] };
}

const overlapArea = (a: LabelRect, b: LabelRect): number =>
  Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

/**
 * The first stop, longest segment first (the first on a tie), above/left of
 * the segment and then below/right of it, whose label rect is clear of
 * `taken`, kept inside `bounds`; when none is, the stop that covers least
 * (the first on a tie). Null for a run without label or segment.
 */
export function runLabelSpot(run: PrepRun, taken: readonly LabelRect[], fontPx: number, zoom: number, bounds: LabelRect): RunLabelSpot | null {
  const points = run.points;
  if (!run.label || points.length < 2) return null;
  const m: Metrics = { w: textWidthPx(run.label, fontPx) / zoom, h: fontPx / zoom, lift: RUN_LABEL_LIFT_PX / zoom };
  const segments = points.slice(1).map((end, i) => [points[i], end] as const);
  const length = ([a, b]: (typeof segments)[number]) => Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
  const ordered = segments.map((segment, i) => ({ segment, i })).sort((a, b) => length(b.segment) - length(a.segment) || a.i - b.i);
  let best: { spot: RunLabelSpot; covered: number } | null = null;
  for (const { segment: [[x0, y0], [x1, y1]] } of ordered) {
    const vertical = Math.abs(y1 - y0) > Math.abs(x1 - x0);
    for (const t of RUN_LABEL_STOPS) {
      for (const side of [-1, 1] as const) {
        const spot = spotAt(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, vertical, side, m, bounds);
        if (!taken.some((other) => overlaps(spot.rect, other))) return spot;
        let covered = 0;
        for (const other of taken) covered += overlapArea(spot.rect, other);
        if (!best || covered < best.covered) best = { spot, covered };
      }
    }
  }
  return best ? best.spot : null;
}

/** Every run's spot, in run order; a later label also keeps clear of the earlier ones. */
export function runLabelSpots(runs: readonly PrepRun[], obstacles: readonly LabelRect[], fontPx: number, zoom: number, bounds: LabelRect): (RunLabelSpot | null)[] {
  const taken = [...obstacles];
  return runs.map((run) => {
    const spot = runLabelSpot(run, taken, fontPx, zoom, bounds);
    if (spot) taken.push(spot.rect);
    return spot;
  });
}

/** Kinds whose label is centred in the box: the whole box is taken. */
const CENTRED: ReadonlySet<string> = new Set(["device", "device_front", "meter", "meter_place", "terminal_strip", "control_block", "blind_plate"]);

/**
 * Where the drawing writes, cabinet mm: every box with a centred label, the
 * label of every empty rail, and each zone's and module's label line
 * (`fontPx` = the small label size, `inset` = the corner inset, mm).
 */
export function labelObstacles(boxes: readonly SceneBox[], emptyRails: ReadonlySet<string>, fontPx: number, zoom: number, layout: { zoneStripMm: number; insetMm: number }): LabelRect[] {
  const h = (LINE_EM * fontPx) / zoom;
  const out: LabelRect[] = [];
  for (const box of boxes) {
    const w = Math.min(textWidthPx(box.label, fontPx) / zoom, box.kind === "zone" || box.kind === "module" ? box.w / 2 : box.w);
    if (CENTRED.has(box.kind)) {
      out.push([box.x, box.y, box.x + box.w, box.y + box.h]);
    } else if ((box.kind === "rail" || box.kind === "busbar") && emptyRails.has(box.id) && box.label) {
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      out.push([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]);
    } else if ((box.kind === "zone" || box.kind === "module") && box.label) {
      const cy = box.y + layout.zoneStripMm / 2;
      const x0 = box.kind === "zone" ? box.x + layout.insetMm : box.x + box.w - layout.insetMm - w;
      out.push([x0, cy - h / 2, x0 + w, cy + h / 2]);
    }
  }
  return out;
}
