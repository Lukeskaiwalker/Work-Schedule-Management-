/**
 * The measuring helpers of the calibration screens
 * (docs/LABEL_PRINTER_CALIBRATION.md §4.11, §7.8): the offset correction from a
 * printed measuring pattern, the ruler scale, and the sensor spot check.
 *
 * Both are deliberately conservative:
 *   * the feed offset comes from edge A ONLY — B mixes the label's real length
 *     (the printer measured 97,0 mm on 99 mm stock) into the number, so it
 *     feeds a length check that is shown and never applied (critique M5);
 *   * every correction is clamped to the material's `offset_limits` before it
 *     is shown or PUT, so the server's limit check never rejects a value this
 *     computed;
 *   * the spot check only ever returns information. It assumes a web centred
 *     on scale 3, which nobody has checked at the printer, so it never gates
 *     a step (critique M4).
 */
import { SENSOR_GEOMETRY } from "../components/labelPrinter/sensorGeometry";
import type { LabelMaterial, PatternGeometry } from "../types/labelPrinter";
import { formatMmDe, targetOffsetMm, webWidthMm } from "./labelCalibrationFormat";
import { DOTS_PER_MM, mmToDots } from "./printerDots";

type Geometry = typeof SENSOR_GEOMETRY;

/** Lanes side by side, centred on x = 0, as [left, right] in mm. */
export function laneSpans(material: Pick<LabelMaterial, "web" | "width_mm">): Array<[number, number]> {
  const { lanes, lane_gap_mm: laneGap } = material.web;
  const across = material.web.label_across_mm ?? material.width_mm;
  const total = lanes * across + (lanes - 1) * laneGap;
  const start = -total / 2;
  return Array.from({ length: lanes }, (_, k) => {
    const left = start + k * (across + laneGap);
    return [left, left + across] as [number, number];
  });
}

export type SensorTrackKind =
  | "alternating"
  | "liner_only"
  | "edge"
  | "off_material"
  | "continuous"
  | "mark_track";

export interface SensorTrack {
  kind: SensorTrackKind;
  text: string;
  severity: "info";
}

const TRACK_TEXT: Record<SensorTrackKind, [string, string]> = {
  alternating: [
    "Etikett und Spalt laufen abwechselnd unter dem Sensor durch",
    "Label and gap pass the sensor in turn",
  ],
  liner_only: [
    "Der Sensor sieht nur den Trägerstreifen – keine Spalte erkennbar",
    "The sensor sees only the liner – no gaps to detect",
  ],
  edge: [
    "Der Sensor liegt an der Etiketten- oder Materialkante",
    "The sensor sits on a label or media edge",
  ],
  off_material: ["Der Sensor liegt neben dem Material", "The sensor is beside the media"],
  continuous: ["Endlosmaterial läuft unter dem Sensor", "Continuous media runs under the sensor"],
  mark_track: [
    "Die Schwarzmarke muss unter dem Zeiger durchlaufen",
    "The black mark must pass under the pointer",
  ],
};

/** Where the sensing spot lands on the (assumed centred) web — ℹ only (§7.8). */
export function sensorTrack(
  material: LabelMaterial,
  geometry: Geometry = SENSOR_GEOMETRY,
  de = true,
): SensorTrack {
  const t = targetOffsetMm(material);
  const r = geometry.beamSpotRadiusMm;
  const lo = t - r;
  const hi = t + r;
  const inside = ([a, b]: [number, number]) => lo >= a && hi <= b;
  const overlaps = ([a, b]: [number, number]) => hi > a && lo < b;
  const half = webWidthMm(material) / 2;
  const web: [number, number] = [-half, half];

  let kind: SensorTrackKind;
  if (material.continuous) {
    kind = inside(web) ? "continuous" : overlaps(web) ? "edge" : "off_material";
  } else {
    const lanes = laneSpans(material);
    if (lanes.some(inside)) kind = material.media_type === "mark" ? "mark_track" : "alternating";
    else if (!overlaps(web)) kind = "off_material";
    else if (!lanes.some(overlaps) && inside(web)) kind = "liner_only";
    else kind = "edge";
  }

  let text = TRACK_TEXT[kind][de ? 0 : 1];
  if (material.guide === "max") {
    text = `${de ? "Falls das Material mittig läuft: " : "If the media runs centred: "}${text}`;
  }
  if (material.web.source === "estimate") text += de ? " (Maße geschätzt)" : " (sizes estimated)";
  return { kind, text, severity: "info" };
}

/**
 * Dots per mm the printer really feeds, from the printed ruler (2 decimals;
 * info only). The ruler's `nominalMm` are drawn as `mmToDots(nominalMm)` dots
 * (80 mm = 945), so a printer true to its 300 dpi reads 11,81.
 */
export function scaleFromRuler(nominalMm: number, measuredMm: number): number {
  return Math.round((mmToDots(nominalMm) / measuredMm) * 100) / 100;
}

export interface OffsetInputs {
  lead: number | null;
  trail: number | null;
  left: number | null;
  right: number | null;
  rulerMeasured: number | null;
}

export interface OffsetCorrection {
  from: number;
  /** What is shown and PUT: `raw` clamped to the material's offset limits. */
  to: number;
  raw: number;
  clamped: boolean;
}

export interface OffsetCorrectionResult {
  xOffset: OffsetCorrection | null;
  across: OffsetCorrection | null;
  infos: string[];
}

const round1 = (value: number) => Math.round(value * 10) / 10;

function corrected(
  from: number,
  raw: number,
  [min, max]: [number, number],
  infos: string[],
  de: boolean,
): OffsetCorrection {
  const value = round1(raw);
  const to = Math.min(max, Math.max(min, value));
  const clamped = to !== value;
  if (clamped) {
    infos.push(
      de
        ? `Korrektur ${formatMmDe(value)} mm liegt außerhalb des möglichen Bereichs (${formatMmDe(min)} … ${formatMmDe(max)} mm) – übernommen wird ${formatMmDe(to)} mm. Material, Sensorposition und Führungen prüfen.`
        : `Correction ${formatMmDe(value)} mm is outside the possible range (${formatMmDe(min)} … ${formatMmDe(max)} mm) – ${formatMmDe(to)} mm is used. Check material, sensor position and guides.`,
    );
  }
  return { from, to, raw: value, clamped };
}

/**
 * The live result of the measuring pattern (§4.11). Inputs are the distances
 * the operator measured from the physical edges to the printed lines, in mm.
 */
export function offsetCorrections(
  material: Pick<LabelMaterial, "x_offset_mm" | "across_offset_mm" | "offset_limits">,
  geometry: PatternGeometry,
  inputs: OffsetInputs,
  de = true,
): OffsetCorrectionResult {
  const infos: string[] = [];
  const limits = material.offset_limits;
  let xOffset: OffsetCorrection | null = null;
  let across: OffsetCorrection | null = null;

  if (geometry.feed_measurable && inputs.lead !== null) {
    const inset = geometry.inset_mm;
    xOffset = corrected(material.x_offset_mm, material.x_offset_mm - (inputs.lead - inset), [limits.x_min, limits.x_max], infos, de);
    if (inputs.trail !== null) {
      const e = round1(inputs.lead + inputs.trail - 2 * inset);
      if (Math.abs(e) > 0.5) {
        const word = e > 0 ? (de ? "kürzer" : "shorter") : de ? "länger" : "longer";
        infos.push(
          de
            ? `Länge: Druckbild ${formatMmDe(Math.abs(e))} mm ${word} als erwartet – Längen-/Maßstabsabweichung, wird nicht als Versatz übernommen`
            : `Length: print ${formatMmDe(Math.abs(e))} mm ${word} than expected – a length/scale error, not taken as an offset`,
        );
      }
    }
  }

  const nominal = geometry.kind === "diecut" ? geometry.inset_mm : geometry.side_line_inset_mm ?? 1;
  const { left, right } = inputs;
  if (geometry.across_measurable && left !== null) {
    const raw = material.across_offset_mm + (right === null ? left - nominal : (left - right) / 2);
    across = corrected(material.across_offset_mm, raw, [limits.across_min, limits.across_max], infos, de);
    if (right !== null) {
      const e = round1(left + right - 2 * nominal);
      if (Math.abs(e) > 0.5) {
        infos.push(
          de
            ? `Breite weicht um ${formatMmDe(Math.abs(e))} mm ab – Profilbreite prüfen`
            : `Width is off by ${formatMmDe(Math.abs(e))} mm – check the profile width`,
        );
      }
    }
  } else if (!geometry.across_measurable && (left !== null || right !== null)) {
    const diff = left !== null && right !== null ? ` (L − R = ${formatMmDe(left - right)} mm)` : "";
    infos.push(
      de
        ? `Seitliche Lage bei ganz offener Führung nicht festgelegt – kein Korrekturwert${diff}`
        : `Lateral position is not fixed with the guides fully open – no correction${diff}`,
    );
  }

  if (inputs.rulerMeasured !== null && geometry.ruler_to_mm !== null && geometry.ruler_from_mm !== null) {
    const nominalRuler = geometry.ruler_to_mm - geometry.ruler_from_mm;
    const scale = scaleFromRuler(nominalRuler, inputs.rulerMeasured).toFixed(2).replace(".", ",");
    const assumed = DOTS_PER_MM.toFixed(2).replace(".", ",");
    infos.push(
      de
        ? `Maßstab ≈ ${scale} Punkte je mm (SMPL rechnet mit ${assumed}) – nur zur Information`
        : `Scale ≈ ${scale} dots per mm (SMPL uses ${assumed}) – for information only`,
    );
  }

  return { xOffset, across, infos };
}
