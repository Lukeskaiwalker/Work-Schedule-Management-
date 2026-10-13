/**
 * The profile form's draft and the PUT it turns into
 * (docs/LABEL_PRINTER_CALIBRATION.md §6.4 "PUT material semantics", §7.9).
 *
 * The form edits strings (so "3,6" can be typed) and sends only what changed:
 * an unchanged builtin field must stay "not overridden", otherwise a later
 * change of the code default would never reach it (critique M6). Ranges are
 * NOT checked here — the server owns them and answers in German (§3.8); the
 * draft only refuses what cannot be sent at all (a word in a number field).
 */
import type {
  FeedPath,
  GuideSetting,
  LabelMaterial,
  LabelMaterialUpdate,
  MediaWeb,
  Roller,
  SensorMode,
} from "../../types/labelPrinter";
import { parseDecimalInput } from "../../utils/labelCalibration";

export interface MaterialDraft {
  name: string;
  part_no: string;
  width_mm: string;
  length_mm: string;
  gap_mm: string;
  has_mark: boolean;
  mark_width_mm: string;
  mark_offset_mm: string;
  mark_inside: boolean;
  sensor_mode: SensorMode;
  sensor_scale: string;
  guide: GuideSetting;
  feed_path: FeedPath;
  roller: Roller;
  lanes: string;
  label_across_mm: string;
  label_along_mm: string;
  lane_gap_mm: string;
  liner_width_mm: string;
  web_measured: boolean;
  darkness: string;
  speed_ips: string;
  stop_mm: string;
  x_offset_mm: string;
  across_offset_mm: string;
}

/** A number as the person would type it: decimal comma, empty for null. */
export function numText(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value).replace(".", ",");
}

export function draftFromMaterial(material: LabelMaterial): MaterialDraft {
  const { web } = material;
  return {
    name: material.name,
    part_no: material.part_no,
    width_mm: numText(material.width_mm),
    length_mm: numText(material.length_mm),
    gap_mm: numText(material.gap_mm),
    has_mark: material.mark_width_mm !== null,
    mark_width_mm: numText(material.mark_width_mm),
    mark_offset_mm: numText(material.mark_offset_mm),
    mark_inside: material.mark_inside,
    sensor_mode: material.sensor_mode,
    sensor_scale: numText(material.sensor_scale),
    guide: material.guide,
    feed_path: material.feed_path,
    roller: material.roller,
    lanes: numText(web.lanes),
    label_across_mm: numText(web.label_across_mm),
    label_along_mm: numText(web.label_along_mm),
    lane_gap_mm: numText(web.lane_gap_mm),
    liner_width_mm: numText(web.liner_width_mm),
    web_measured: web.source === "measured",
    darkness: numText(material.darkness),
    speed_ips: numText(material.speed_ips),
    stop_mm: numText(material.stop_mm),
    x_offset_mm: numText(material.x_offset_mm),
    across_offset_mm: numText(material.across_offset_mm),
  };
}

export type DraftErrors = Partial<Record<keyof MaterialDraft, string>>;

export interface DraftResult {
  update: LabelMaterialUpdate;
  /** Field names in the PUT besides `revision` / `reset_fields`. */
  changed: string[];
  errors: DraftErrors;
}

/** Draft keys the person changed since the form opened. */
export function touchedKeys(initial: MaterialDraft, draft: MaterialDraft): Set<keyof MaterialDraft> {
  return new Set((Object.keys(draft) as Array<keyof MaterialDraft>).filter((key) => draft[key] !== initial[key]));
}

/**
 * The PUT body for `draft` against `material`: changed fields only, fields in
 * `reset` left out (they go back to the builtin default), web as a whole.
 *
 * With `touched`, only fields the person edited are considered: after a
 * [Neu laden] the form keeps its draft, and a field someone else changed in
 * the meantime must not be written back with the old value.
 */
export function buildMaterialUpdate(
  material: LabelMaterial,
  draft: MaterialDraft,
  reset: string[],
  revision: number,
  de = true,
  touched?: Set<keyof MaterialDraft>,
): DraftResult {
  const errors: DraftErrors = {};
  const notNumber = de ? "Bitte eine Zahl eingeben" : "Please enter a number";
  const notInteger = de ? "Bitte eine ganze Zahl eingeben" : "Please enter a whole number";
  const body: Record<string, unknown> = {};

  const number = (key: keyof MaterialDraft, optional: boolean, integer = false): number | null | undefined => {
    const text = String(draft[key]).trim();
    if (text === "") {
      if (!optional) errors[key] = notNumber;
      return optional ? null : undefined;
    }
    const value = parseDecimalInput(text);
    if (value === null) {
      errors[key] = notNumber;
      return undefined;
    }
    if (integer && !Number.isInteger(value)) {
      errors[key] = notInteger;
      return undefined;
    }
    return value;
  };
  const put = (field: string, value: unknown, current: unknown, keys: Array<keyof MaterialDraft> = [field as keyof MaterialDraft]) => {
    if (value === undefined || reset.includes(field)) return;
    if (touched && !keys.some((key) => touched.has(key))) return;
    if (JSON.stringify(value) !== JSON.stringify(current)) body[field] = value;
  };

  put("name", draft.name.trim(), material.name);
  put("part_no", draft.part_no.trim(), material.part_no);
  put("width_mm", number("width_mm", false), material.width_mm);
  const length = number("length_mm", true);
  put("length_mm", length, material.length_mm);
  put("gap_mm", number("gap_mm", false), material.gap_mm);
  const continuous = length === null;
  const markKeys: Array<keyof MaterialDraft> = ["has_mark", "mark_width_mm", "length_mm"];
  if (draft.has_mark && !continuous) {
    put("mark_width_mm", number("mark_width_mm", false), material.mark_width_mm, markKeys);
    put("mark_offset_mm", number("mark_offset_mm", false), material.mark_offset_mm, ["has_mark", "mark_offset_mm"]);
    put("mark_inside", draft.mark_inside, material.mark_inside, ["has_mark", "mark_inside"]);
  } else {
    put("mark_width_mm", null, material.mark_width_mm, markKeys);
  }
  put("sensor_mode", draft.sensor_mode, material.sensor_mode);
  put("sensor_scale", number("sensor_scale", false), material.sensor_scale);
  put("guide", draft.guide, material.guide);
  put("feed_path", draft.feed_path, material.feed_path);
  put("roller", draft.roller, material.roller);

  const lanes = number("lanes", false, true);
  const web: Partial<MediaWeb> = {
    lanes: lanes ?? undefined,
    label_across_mm: number("label_across_mm", true) ?? null,
    label_along_mm: number("label_along_mm", true) ?? null,
    lane_gap_mm: number("lane_gap_mm", false) ?? undefined,
    liner_width_mm: number("liner_width_mm", true) ?? null,
    source: draft.web_measured
      ? "measured"
      : material.web.source === "measured"
        ? "catalogue"
        : material.web.source,
  };
  if (!errors.lanes && !errors.lane_gap_mm && !errors.label_across_mm && !errors.label_along_mm && !errors.liner_width_mm) {
    put("web", web, material.web, ["lanes", "label_across_mm", "label_along_mm", "lane_gap_mm", "liner_width_mm", "web_measured"]);
  }

  put("darkness", number("darkness", true, true), material.darkness);
  put("speed_ips", number("speed_ips", true, true), material.speed_ips);
  put("stop_mm", number("stop_mm", true, true), material.stop_mm);
  put("x_offset_mm", number("x_offset_mm", false), material.x_offset_mm);
  put("across_offset_mm", number("across_offset_mm", false), material.across_offset_mm);

  const update = { revision, ...body, ...(reset.length ? { reset_fields: reset } : {}) } as LabelMaterialUpdate;
  return { update, changed: Object.keys(body), errors };
}
