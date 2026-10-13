/**
 * The six builtin label materials as GET /api/werkstatt/label-printer returns
 * them (docs/LABEL_PRINTER_CALIBRATION.md §3.3, §4.9, §6.4) — what the
 * calibration UI tests render against.
 *
 * Hand-written from the contract rather than captured, because the backend is
 * built in parallel; the numbers that matter to the UI (sensor readings, web
 * geometry, offset limits, cost hints) are the contract's.
 */
import type {
  LabelMaterial,
  LabelPrinterOverview,
  LabelPrinterSettings,
  MaterialHint,
} from "../../types/labelPrinter";

const ROLLER_HINT: MaterialHint = {
  topic: "roller",
  text: "Andruckwalze 258-5006 laut WAGO-Zuordnungstabelle (12.2016)",
};
const PHOTO_HINT: MaterialHint = {
  topic: "sensor_position",
  text: "Foto 13.10.2026: Etiketten werden so korrekt erkannt (Rolle 210-804)",
};
const SEE_THROUGH_HINT: MaterialHint = {
  topic: "sensor_mode",
  text: "Sensor Durchlicht: abgeleitet, nicht am Drucker geprüft",
};

function base(overrides: Partial<LabelMaterial>): LabelMaterial {
  return {
    id: "x",
    name: "x",
    part_no: "",
    width_mm: 44,
    length_mm: 99,
    gap_mm: 3,
    x_offset_mm: 2,
    darkness: null,
    builtin: true,
    tier: "voll",
    continuous: false,
    media_type: "gap",
    across_offset_mm: 0,
    speed_ips: null,
    stop_mm: null,
    resolved: { darkness: 12, speed_ips: 2, stop_mm: 0 },
    mark_width_mm: null,
    mark_offset_mm: 0,
    mark_inside: false,
    sensor_mode: "see_through",
    sensor_scale: 3.4,
    guide: "max",
    feed_path: "internal",
    roller: "258-5006",
    web: {
      lanes: 1,
      label_across_mm: null,
      label_along_mm: null,
      lane_gap_mm: 0,
      liner_width_mm: null,
      source: "catalogue",
    },
    web_width_mm: 44,
    overridden_fields: [],
    hints: [ROLLER_HINT],
    calibration: null,
    autosense_cost_hint: "voraussichtlich 2–3 Etiketten (≈ 20–30 cm, Schätzung)",
    pattern_cost_hint: "1 Etikett",
    pattern_supported: true,
    offset_limits: { x_min: -2, x_max: 10, across_min: -2.6, across_max: 1 },
    ...overrides,
  };
}

export const M804 = base({
  id: "wago-210-804",
  name: "Typenschilder 99 × 44 (silber)",
  part_no: "WAGO 210-804",
  hints: [
    ROLLER_HINT,
    PHOTO_HINT,
    {
      topic: "sensor_position",
      text: "Sensorposition ca. 3,4 der Skala: WAGO-Handhabungshinweis 210-804 (08.2020), auf die Skala Ihres Druckers übertragen",
    },
    SEE_THROUGH_HINT,
    {
      topic: "geometry",
      text: "99 × 44 mm, Spalt 3 mm: von SMPL am Drucker eingestellt (WAGO veröffentlicht Spalt und Trägerbreite nicht)",
    },
  ],
});

export const M824 = base({
  id: "wago-210-824",
  name: "Sicherheitsetiketten 99 × 44 (silber)",
  part_no: "WAGO 210-824",
});

export const M812 = base({
  id: "wago-210-812",
  name: "Typenschilder 50 × 25 (silber)",
  part_no: "WAGO 210-812",
  width_mm: 25,
  length_mm: 50,
  tier: "kompakt",
  web_width_mm: 25,
  autosense_cost_hint: "voraussichtlich 2–3 Etiketten (≈ 11–16 cm, Schätzung)",
  offset_limits: { x_min: -2, x_max: 10, across_min: -4, across_max: 1.2 },
});

export const M805 = base({
  id: "wago-210-805",
  name: "Etiketten 15 × 6 (weiß)",
  part_no: "WAGO 210-805",
  width_mm: 6,
  length_mm: 15,
  tier: "mini",
  guide: "fit",
  web: {
    lanes: 2,
    label_across_mm: 15,
    label_along_mm: 6,
    lane_gap_mm: 1,
    liner_width_mm: 34,
    source: "estimate",
  },
  web_width_mm: 34,
  hints: [
    ROLLER_HINT,
    PHOTO_HINT,
    { topic: "web", text: "WAGO: 3.000 Etiketten pro Rolle, 2 Bahnen" },
    {
      topic: "web",
      text: "Maße der Rolle (≈ 15 × 6 mm je Etikett, Träger ≈ 34 mm) aus einem WAGO-Foto geschätzt, nicht am Material gemessen",
    },
  ],
  autosense_cost_hint: "voraussichtlich einige Etikettenreihen (wenige cm, Schätzung)",
  pattern_cost_hint: "",
  pattern_supported: false,
  offset_limits: { x_min: -1, x_max: 10, across_min: -0.5, across_max: 0.5 },
});

export const M211 = base({
  id: "wago-211-501",
  name: "Schrumpfschlauch Ø 3,2 (weiß, Endlos)",
  part_no: "WAGO 211-501",
  width_mm: 5,
  length_mm: null,
  tier: "mini",
  continuous: true,
  media_type: "continuous",
  sensor_scale: 3,
  guide: "fit",
  feed_path: "external",
  web: {
    lanes: 1,
    label_across_mm: null,
    label_along_mm: null,
    lane_gap_mm: 0,
    liner_width_mm: 5,
    source: "estimate",
  },
  web_width_mm: 5,
  autosense_cost_hint: "Menge unbekannt – für Endlosschlauch nennt keine Quelle eine Grenze",
  pattern_cost_hint: "≈ 32 mm Schlauch (Schätzung)",
  offset_limits: { x_min: -2, x_max: 10, across_min: -0.7, across_max: 0.6 },
});

export const M2009 = base({
  id: "wago-2009-110",
  name: "Beschriftungsstreifen 11 mm (TopJob, Endlos)",
  part_no: "WAGO 2009-110",
  width_mm: 11,
  length_mm: null,
  tier: "mini",
  continuous: true,
  media_type: "continuous",
  sensor_scale: 3,
  guide: "fit",
  feed_path: "external",
  web: {
    lanes: 1,
    label_across_mm: null,
    label_along_mm: null,
    lane_gap_mm: 0,
    liner_width_mm: 11,
    source: "catalogue",
  },
  web_width_mm: 11,
  autosense_cost_hint: "Menge unbekannt – für Endlosstreifen nennt keine Quelle eine Grenze",
  pattern_cost_hint: "≈ 42 mm Streifen (Schätzung)",
  offset_limits: { x_min: -2, x_max: 10, across_min: -0.5, across_max: 0.2 },
});

export const BUILTINS: LabelMaterial[] = [M804, M824, M812, M805, M211, M2009];

export function settingsFixture(overrides: Partial<LabelPrinterSettings> = {}): LabelPrinterSettings {
  return {
    host: "192.168.2.158",
    port: 9100,
    configured: true,
    source: "runtime",
    materials: BUILTINS,
    active_material_id: "wago-210-804",
    active_material_name: M804.name,
    active_tier: "voll",
    revision: 5,
    baseline: { darkness: 12, speed_ips: 2, stop_mm: 0 },
    baseline_overridden: [],
    row_offset_dots: null,
    label_calibration_staff_enabled: false,
    session: null,
    last_applied: null,
    ...overrides,
  };
}

export function overviewFixture(overrides: Partial<LabelPrinterOverview> = {}): LabelPrinterOverview {
  return {
    configured: true,
    printer: "192.168.2.158:9100",
    active_material_id: "wago-210-804",
    active_material_name: M804.name,
    materials: BUILTINS,
    session: null,
    last_applied: null,
    can_full: true,
    staff_enabled: false,
    ...overrides,
  };
}
