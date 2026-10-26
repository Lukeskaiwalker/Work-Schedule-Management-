/**
 * Pure helpers for the label-printer calibration screens
 * (docs/LABEL_PRINTER_CALIBRATION.md §7.2).
 *
 * Everything here ends up as a physical instruction — where the sensor pointer
 * goes, how far to push it, how wide the guides are set — so the texts are the
 * contract's German strings word for word, and every number goes through one
 * formatter (decimal comma, U+2212 for minus). English variants exist for the
 * language toggle; their wording is free.
 *
 * The measuring-pattern maths and the sensor spot check live in
 * `labelCalibrationMeasure.ts` (re-exported below) to keep both files small.
 */
import { ApiError } from "../api/client";
import { scaleToX } from "../components/labelPrinter/sensorGeometry";
import { formatMmDe, formatScaleDe, targetOffsetMm, webWidthMm } from "./labelCalibrationFormat";
import type {
  CalibrationSummary,
  LabelMaterial,
  LabelPrinterApiErrorDetail,
  MaterialHint,
  Roller,
  SensorKind,
  SensorMode,
} from "../types/labelPrinter";

export {
  laneSpans,
  offsetCorrections,
  scaleFromRuler,
  sensorTrack,
  type OffsetCorrection,
  type OffsetCorrectionResult,
  type OffsetInputs,
  type SensorTrack,
  type SensorTrackKind,
} from "./labelCalibrationMeasure";

/** Shown by both feed dialogs and the sensing view, from the start (§3.3, §7.4). */
export const FEED_STOP_HINT =
  "Läuft zu viel Material durch: Deckel öffnen – der Drucker stoppt (nicht am Drucker geprüft).";
export const FEED_STOP_HINT_EN =
  "Too much material running through: open the lid – the printer stops (not tested at the printer).";

export function feedStopHint(de = true): string {
  return de ? FEED_STOP_HINT : FEED_STOP_HINT_EN;
}

export {
  DOTS_PER_MM,
  MINUS,
  dimensionLabel,
  dotsToMmDe,
  formatFixedDe,
  formatMmDe,
  formatScaleDe,
  formatSignedMmDe,
  parseDecimalInput,
  parseScaleInput,
  targetOffsetMm,
  webWidthMm,
} from "./labelCalibrationFormat";


function readingOf(source: number | Pick<LabelMaterial, "sensor_scale">): number {
  return typeof source === "number" ? source : source.sensor_scale;
}

/** The large target line under the diagram (§7.4). */
export function targetText(source: number | Pick<LabelMaterial, "sensor_scale">, de = true): string {
  const reading = readingOf(source);
  const x = scaleToX(reading);
  const scale = formatScaleDe(reading);
  if (x === 0) {
    return de
      ? `Zeiger ▲▼ auf ${scale} der Skala – Mitte der Materialbahn`
      : `Pointer ▲▼ at ${scale} on the scale – centre of the media path`;
  }
  const side = x > 0 ? (de ? "rechts" : "right") : de ? "links" : "left";
  return de
    ? `Zeiger ▲▼ auf ${scale} der Skala – ca. ${formatMmDe(Math.abs(x))} mm ${side} der Mitte`
    : `Pointer ▲▼ at ${scale} on the scale – approx. ${formatMmDe(Math.abs(x))} mm ${side} of centre`;
}

/** Signed distance (mm) the carriage must travel from `current` to `target`. */
export function scaleShiftMm(current: number, target: number): number {
  return Math.round((scaleToX(target) - scaleToX(current)) * 10) / 10;
}

/** "≈ 5 mm nach rechts schieben" under the "Zeiger steht jetzt auf …" input. */
export function scaleShiftText(current: number, target: number, de = true): string {
  const shift = scaleShiftMm(current, target);
  if (shift === 0) return de ? "Zeiger steht richtig" : "Pointer is in place";
  const side = shift > 0 ? (de ? "rechts" : "right") : de ? "links" : "left";
  return de
    ? `≈ ${formatMmDe(Math.abs(shift))} mm nach ${side} schieben`
    : `≈ push ${formatMmDe(Math.abs(shift))} mm to the ${side}`;
}

/**
 * Hints the UI shows (§3.3): web hints describe estimated roll sizes and go
 * once someone measured the roll; sensor-position hints describe the BUILTIN
 * reading and go once the admin set their own.
 */
export function visibleHints(material: Pick<LabelMaterial, "hints" | "web" | "overridden_fields">): MaterialHint[] {
  return material.hints.filter((hint) => {
    if (hint.topic === "web" && material.web.source === "measured") return false;
    if (hint.topic === "sensor_position" && material.overridden_fields.includes("sensor_scale")) return false;
    return true;
  });
}

export function guideText(material: LabelMaterial, de = true): string {
  const web = formatMmDe(webWidthMm(material));
  if (material.guide === "max") return de ? "Materialführungen ganz öffnen" : "Open the media guides fully";
  if (material.web.source === "estimate") {
    return de
      ? `Materialführungen an den Trägerrand anlegen – Trägerbreite ≈ ${web} mm (geschätzt), je 1 mm Luft`
      : `Set the media guides to the liner edge – liner width ≈ ${web} mm (estimated), 1 mm clearance each`;
  }
  return de
    ? `Materialführungen auf 1 mm + ${web} mm + 1 mm stellen – das Material darf nicht klemmen`
    : `Set the media guides to 1 mm + ${web} mm + 1 mm – the media must not jam`;
}

export function feedText(material: Pick<LabelMaterial, "feed_path">, de = true): string {
  if (material.feed_path === "external") {
    return de
      ? "Externen Abroller hinter den Drucker stellen (gleiche Höhe, in einer Linie). Abrollrichtung links: Material gegen den Uhrzeigersinn durch den hinteren Schlitz führen"
      : "Place the external unwinder behind the printer (same height, in line). Unwinding to the left: lead the media counter-clockwise through the rear slot";
  }
  return de
    ? "Rolle auf den internen Rollenhalter setzen und das Material durchfädeln"
    : "Put the roll on the internal holder and thread the media";
}

export function rollerText(roller: Roller, de = true): string {
  if (roller === "258-5007") {
    return de
      ? "Andruckwalze 258-5007 (dunkelgrün, gerillt) ist eingesetzt – laut WAGO nur für WMB-Inline 2009-113/-114/-115"
      : "Platen roller 258-5007 (dark green, grooved) is fitted – per WAGO only for WMB-Inline 2009-113/-114/-115";
  }
  return de
    ? "Andruckwalze 258-5006 (schwarz, glatt) ist eingesetzt"
    : "Platen roller 258-5006 (black, smooth) is fitted";
}

/** Short sensor-mode name as the apply text uses it. */
export function sensorModeLabel(mode: SensorMode, de = true): string {
  const labels: Record<SensorMode, [string, string]> = {
    see_through: ["Durchlicht", "see-through"],
    reflective: ["Reflex", "reflective"],
    auto: ["Automatisch", "automatic"],
    none: ["kein Sensor", "no sensor"],
  };
  return labels[mode][de ? 0 : 1];
}

/** What the printer reports as its active sensor. */
export function sensorKindLabel(kind: SensorKind | "see_through" | "reflective", de = true): string {
  if (kind === "see_through") return de ? "Durchlicht" : "see-through";
  if (kind === "reflective") return de ? "Reflex" : "reflective";
  return de ? "unbekannt" : "unknown";
}

export type ChecklistKey = "roller" | "sensor" | "roll" | "guides" | "ribbon" | "lid";

export interface ChecklistItem {
  key: ChecklistKey;
  text: string;
  /** An ℹ line under the item — information, never a checkbox. */
  info?: string;
}

/**
 * The loading order (§7.4, critique M10): the sensor is set BEFORE the media
 * goes in, because the media may hide the scale.
 */
export function checklistItems(material: LabelMaterial, de = true): ChecklistItem[] {
  const scale = formatScaleDe(material.sensor_scale);
  return [
    { key: "roller", text: rollerText(material.roller, de) },
    {
      key: "sensor",
      text: de
        ? `Sensor-Schlitten verschieben, bis der Zeiger auf ${scale} der Skala zeigt`
        : `Slide the sensor carriage until the pointer shows ${scale} on the scale`,
    },
    { key: "roll", text: feedText(material, de) },
    { key: "guides", text: guideText(material, de) },
    { key: "ribbon", text: de ? "Farbband ist eingelegt" : "Ribbon is loaded" },
    {
      key: "lid",
      text: de ? "Deckel ist geschlossen" : "Lid is closed",
      info: de
        ? "Beim Schließen des Deckels kann der Drucker selbst einmessen und Material einziehen (nicht am Drucker geprüft)."
        : "Closing the lid may make the printer sense and feed media by itself (not tested at the printer).",
    },
  ];
}

/** The `<desc>` of the top view (§7.8). */
export function diagramDescription(
  material: LabelMaterial,
  _state: "sensor" | "loaded",
  actualScale: number | null,
  de = true,
): string {
  const x = targetOffsetMm(material);
  const scale = formatScaleDe(material.sensor_scale);
  const parts: string[] = [];
  if (x === 0) {
    parts.push(de ? `Sensor-Zeiger auf ${scale} der Skala, Mitte der Materialbahn` : `Sensor pointer at ${scale}, centre of the media path`);
  } else {
    const side = x > 0 ? (de ? "rechts" : "right") : de ? "links" : "left";
    parts.push(
      de
        ? `Sensor-Zeiger auf ${scale} der Skala, etwa ${formatMmDe(Math.abs(x))} mm ${side} der Mitte`
        : `Sensor pointer at ${scale}, about ${formatMmDe(Math.abs(x))} mm ${side} of centre`,
    );
  }
  const across = formatMmDe(material.web.label_across_mm ?? material.width_mm);
  const gap = formatMmDe(material.gap_mm);
  if (material.continuous) {
    parts.push(de ? `Endlosmaterial ${formatMmDe(material.width_mm)} mm breit` : `Continuous media ${formatMmDe(material.width_mm)} mm wide`);
  } else if (material.mark_width_mm !== null) {
    parts.push(de ? `Etiketten ${across} mm breit, Schwarzmarke ${formatMmDe(material.mark_width_mm)} mm` : `Labels ${across} mm wide, black mark ${formatMmDe(material.mark_width_mm)} mm`);
  } else if (material.web.lanes > 1) {
    parts.push(de ? `${material.web.lanes} Bahnen, Etiketten je ${across} mm breit, Spalt ${gap} mm` : `${material.web.lanes} lanes, labels ${across} mm wide each, gap ${gap} mm`);
  } else {
    parts.push(de ? `Etiketten ${across} mm breit, Spalt ${gap} mm` : `Labels ${across} mm wide, gap ${gap} mm`);
  }
  parts.push(
    material.guide === "max"
      ? de ? "Materialführung ganz offen" : "Media guides fully open"
      : de ? `Materialführung auf ${formatMmDe(webWidthMm(material))} mm + je 1 mm Luft` : `Media guides at ${formatMmDe(webWidthMm(material))} mm + 1 mm each`,
  );
  if (actualScale !== null) {
    const shift = scaleShiftMm(actualScale, material.sensor_scale);
    const now = formatScaleDe(actualScale);
    if (shift === 0) {
      parts.push(de ? `Zeiger steht jetzt auf ${now} – steht richtig` : `Pointer now at ${now} – in place`);
    } else {
      const side = shift > 0 ? (de ? "rechts" : "right") : de ? "links" : "left";
      parts.push(
        de
          ? `Zeiger steht jetzt auf ${now} – etwa ${formatMmDe(Math.abs(shift))} mm nach ${side} schieben`
          : `Pointer now at ${now} – push about ${formatMmDe(Math.abs(shift))} mm to the ${side}`,
      );
    }
  }
  return `${parts.join("; ")}.`;
}

/** dd.mm.yyyy in local time. */
export function formatLocalDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

/** ISO UTC → local "HH:MM". Banners are built from `since`, never from a server message (§5.1). */
export function formatLocalTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export type ChipTone = "none" | "ok" | "warn" | "stale";

/** The per-material chip (§7.10). Never says "checked" — only what was done. */
export function calibrationChip(record: CalibrationSummary | null, de = true): { text: string; tone: ChipTone } {
  if (!record) return { text: de ? "Nicht eingemessen" : "Not sensed", tone: "none" };
  if (record.stale) return { text: de ? "Profil seit Messung geändert" : "Profile changed since", tone: "stale" };
  const date = formatLocalDate(record.at);
  if (record.verdict === "match") {
    return record.kind === "full"
      ? { text: de ? `Kalibriert ${date}` : `Calibrated ${date}`, tone: "ok" }
      : { text: de ? `Eingemessen ${date}` : `Sensed ${date}`, tone: "ok" };
  }
  if (record.verdict === "no_result" || record.verdict === "unchecked") {
    return { text: de ? `Ungeprüft gespeichert ${date}` : `Saved unchecked ${date}`, tone: "warn" };
  }
  return { text: de ? `Gespeichert mit Abweichung ${date}` : `Saved with deviation ${date}`, tone: "warn" };
}

/** The dict `detail` of a calibration-route error, or null (string details, other errors). */
export function apiErrorDetail(err: unknown): LabelPrinterApiErrorDetail | null {
  if (!(err instanceof ApiError) && !(err && typeof err === "object" && "detail" in err)) return null;
  const detail = (err as { detail?: unknown }).detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
  const code = (detail as { code?: unknown }).code;
  return typeof code === "string" ? (detail as LabelPrinterApiErrorDetail) : null;
}

export function apiErrorCode(err: unknown): string | null {
  return apiErrorDetail(err)?.code ?? null;
}

/**
 * What to show for a failed call: the server's German message, and for
 * `printer_not_ready` its action text after it (§6.3) — never a parsed message.
 */
export function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const detail = apiErrorDetail(err);
  if (detail?.code === "printer_not_ready" && typeof detail.action_text === "string" && detail.action_text) {
    return `${message}. ${detail.action_text}`;
  }
  return message;
}
