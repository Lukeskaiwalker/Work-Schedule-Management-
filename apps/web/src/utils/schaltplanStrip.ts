/**
 * BMK label strip geometry.
 *
 * The printer lays one continuous WAGO 2009-110 strip per rail, one segment
 * per device, so the strip can be stuck on in a single pass and cut at the
 * marks. Every segment must therefore be exactly as wide as the device it
 * sits on — including Blindabdeckungen and devices without a BMK, which
 * print nothing but still take up their width.
 *
 * Mirrors the rule in `apps/api/app/services/schaltplan_labels.py`. Keep
 * the two in step: the preview here is what the electrician checks before
 * the strip feeds, and a divergence means a strip that is right on screen
 * and wrong in the hand.
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
  /** Printed text; "" for a Blindabdeckung or a device without a BMK. */
  text: string;
  widthMm: number;
  /** Running offset in mm from the first device on the rail. */
  start: number;
}

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
  return Math.max(1, device.te || 1) * MODULE_WIDTH_MM;
}

/** What the segment says — nothing for a blank cover or an unnamed device. */
export function segmentText(device: Pick<PanelDevice, "kind" | "designation">): string {
  if (device.kind === "blank") return "";
  return (device.designation ?? "").trim();
}

export function stripSegments(row: Pick<PanelRow, "devices">): StripSegment[] {
  return row.devices.reduce<StripSegment[]>((segments, device) => {
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

/** Printed length between the start and end lines, without the lead. */
export function stripLengthMm(row: Pick<PanelRow, "devices">): number {
  return row.devices.reduce((total, device) => total + deviceWidthMm(device), 0);
}

/** Total strip the printer feeds: lead + printed length + lead. */
export function stripTotalMm(row: Pick<PanelRow, "devices">): number {
  return STRIP_LEAD_MM + stripLengthMm(row) + STRIP_LEAD_MM;
}

export interface RowLabelCounts {
  /** Devices that get a printed BMK. */
  labelled: number;
  /** Blind covers and unnamed devices — width on the strip, no text. */
  withoutBmk: number;
}

export function rowLabelCounts(row: Pick<PanelRow, "devices">): RowLabelCounts {
  return stripSegments(row).reduce<RowLabelCounts>(
    (counts, segment) =>
      segment.text
        ? { ...counts, labelled: counts.labelled + 1 }
        : { ...counts, withoutBmk: counts.withoutBmk + 1 },
    { labelled: 0, withoutBmk: 0 },
  );
}

/** The 210-805 view of a rail: one label per BMK, in rail order. */
export function singleLabels(row: Pick<PanelRow, "devices">): StripSegment[] {
  return stripSegments(row).filter((segment) => segment.text !== "");
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
