/**
 * Number formatting and the two geometry conversions every calibration helper
 * builds on (docs/LABEL_PRINTER_CALIBRATION.md §7.2). Split out of
 * `labelCalibration.ts` so the measuring helpers can use them without an
 * import cycle; `labelCalibration.ts` re-exports all of it.
 */
import { scaleToX } from "../components/labelPrinter/sensorGeometry";
import type { LabelMaterial } from "../types/labelPrinter";

export const MINUS = "−";

/** Phase 1 always converts printer dots at 12 per mm (300 dpi); the real scale is test T4/T14. */
export const DOTS_PER_MM = 12;

/** Printer dots → mm, one decimal ("97", "2,5"). */
export function dotsToMmDe(dots: number): string {
  return formatMmDe(dots / DOTS_PER_MM);
}

/** One decimal, decimal comma, trailing ",0" dropped, U+2212 minus; −0 reads "0". */
export function formatMmDe(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  if (rounded === 0) return "0";
  const text = Math.abs(rounded).toFixed(1).replace(/\.0$/, "").replace(".", ",");
  return rounded < 0 ? `${MINUS}${text}` : text;
}

/** As `formatMmDe`, with an explicit "+" for positive values. */
export function formatSignedMmDe(value: number): string {
  const text = formatMmDe(value);
  return text === "0" || text.startsWith(MINUS) ? text : `+${text}`;
}

/** Always `digits` decimals ("2,0") — for before/after pairs that must line up. */
export function formatFixedDe(value: number, digits = 1): string {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  const text = Math.abs(rounded).toFixed(digits).replace(".", ",");
  return rounded < 0 ? `${MINUS}${text}` : text;
}

/** A scale reading: 3.4 → "3,4", 3 → "3". */
export function formatScaleDe(reading: number): string {
  return formatMmDe(reading);
}

/** "2,4" / "2.4" / "−1,5" → number; anything else (or empty) → null. */
export function parseDecimalInput(text: string): number | null {
  const cleaned = text.trim().replace(MINUS, "-").replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned) && !/^-?\.\d+$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** A reading typed by hand: one decimal (3,44 → 3,4), 0,5–5,5, else null (§3.8). */
export function parseScaleInput(text: string): number | null {
  const value = parseDecimalInput(text);
  if (value === null) return null;
  const rounded = Math.round(value * 10) / 10;
  return rounded >= 0.5 && rounded <= 5.5 ? rounded : null;
}

/** "99 × 44 mm" or "11 mm Endlos" — how electricians read a box label. */
export function dimensionLabel(material: Pick<LabelMaterial, "continuous" | "width_mm" | "length_mm">, de = true): string {
  if (material.continuous || material.length_mm === null) {
    return `${formatMmDe(material.width_mm)} mm ${de ? "Endlos" : "continuous"}`;
  }
  return `${formatMmDe(material.length_mm)} × ${formatMmDe(material.width_mm)} mm`;
}

/** Physical roll width: the liner when known, else the lanes side by side. */
export function webWidthMm(material: Pick<LabelMaterial, "web" | "width_mm">): number {
  const { web } = material;
  if (web.liner_width_mm !== null) return web.liner_width_mm;
  const across = web.label_across_mm ?? material.width_mm;
  return web.lanes * across + (web.lanes - 1) * web.lane_gap_mm;
}

/** Where the pointer must sit, in mm from the centre line (+ = right). */
export function targetOffsetMm(material: Pick<LabelMaterial, "sensor_scale">): number {
  return scaleToX(material.sensor_scale);
}
