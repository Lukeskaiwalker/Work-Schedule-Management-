/**
 * Label printer (WAGO 258-5101) calibration — the wire shapes.
 *
 * A mirror of the API schemas in docs/LABEL_PRINTER_CALIBRATION.md §6.4, field
 * for field. The backend is built against the same contract, so a field that
 * is renamed here and not there fails at the first real request — keep the two
 * identical rather than "nicer".
 *
 * Stored vs resolved (§3.9): `darkness` / `speed_ips` / `stop_mm` on a material
 * are the admin's OVERRIDES (null = "Grundeinstellung"); what a job actually
 * sends is in `resolved`. Writes never send `resolved` back.
 */

export type SensorMode = "see_through" | "reflective" | "auto" | "none";
export type GuideSetting = "max" | "fit";
export type FeedPath = "internal" | "external";
export type Roller = "258-5006" | "258-5007";
export type MediaType = "gap" | "mark" | "continuous";
export type WebSource = "catalogue" | "estimate" | "measured";
export type SessionMode = "quick" | "full";
export type SessionPhase = "open" | "activated" | "applied" | "sensing" | "sensed" | "judged";
export type Verdict =
  | "match"
  | "mismatch"
  | "other_material"
  | "no_gap"
  | "gap_on_continuous"
  | "no_result"
  | "unchecked"
  | "printer_error";
export type Freshness = "busy_seen" | "q_changed" | "qd_changed" | "none";
export type SensorKind = "see_through" | "reflective" | "unknown";
export type Offer = "save" | "accept_anyway" | "resense" | "requery" | "reapply" | "switch_material";
export type HintTopic = "sensor_position" | "sensor_mode" | "geometry" | "web" | "roller" | "printing";

/** The physical roll — drives the guide text, the diagram and verify, never printing. */
export interface MediaWeb {
  lanes: number;
  label_across_mm: number | null;
  label_along_mm: number | null;
  lane_gap_mm: number;
  liner_width_mm: number | null;
  source: WebSource;
}

export interface JobSettings {
  darkness: number;
  speed_ips: number;
  stop_mm: number;
}

export interface MaterialHint {
  topic: HintTopic;
  text: string;
}

export interface CalibrationSummary {
  kind: SessionMode;
  at: string;
  by_name: string;
  verdict: Verdict;
  fresh: boolean;
  accepted: boolean;
  stale: boolean;
  measured_length_mm: number | null;
  measured_gap_mm: number | null;
  notes: string;
}

export interface OffsetLimits {
  x_min: number;
  x_max: number;
  across_min: number;
  across_max: number;
}

export interface LabelMaterial {
  id: string;
  name: string;
  part_no: string;
  width_mm: number;
  length_mm: number | null;
  gap_mm: number;
  x_offset_mm: number;
  darkness: number | null;
  builtin: boolean;
  tier: "voll" | "kompakt" | "mini";
  continuous: boolean;
  media_type: MediaType;
  across_offset_mm: number;
  speed_ips: number | null;
  stop_mm: number | null;
  resolved: JobSettings;
  mark_width_mm: number | null;
  mark_offset_mm: number;
  mark_inside: boolean;
  sensor_mode: SensorMode;
  /** Reading on the housing scale, 0.5–5.5, 3 = centre of the media path (§3.2). */
  sensor_scale: number;
  guide: GuideSetting;
  feed_path: FeedPath;
  roller: Roller;
  web: MediaWeb;
  web_width_mm: number;
  overridden_fields: string[];
  hints: MaterialHint[];
  calibration: CalibrationSummary | null;
  autosense_cost_hint: string;
  pattern_cost_hint: string;
  pattern_supported: boolean;
  offset_limits: OffsetLimits;
}

export interface LastApplied {
  material_id: string;
  at: string;
  by_name: string;
  commands: string[];
  confirmed: boolean | null;
}

export interface SessionInfo {
  mode: SessionMode;
  material_id: string;
  user_name: string;
  acquired_at: string;
  expires_at: string;
  mine: boolean;
  session_id: string | null;
}

export interface LabelPrinterSettings {
  host: string;
  port: number;
  configured: boolean;
  source: "runtime" | "env" | "none";
  materials: LabelMaterial[];
  active_material_id: string;
  active_material_name: string;
  active_tier: string;
  revision: number;
  baseline: JobSettings;
  baseline_overridden: string[];
  row_offset_dots: number | null;
  label_calibration_staff_enabled: boolean;
  session: SessionInfo | null;
  last_applied: LastApplied | null;
}

export interface LabelPrinterOverview {
  configured: boolean;
  printer: string;
  active_material_id: string;
  active_material_name: string;
  materials: LabelMaterial[];
  session: SessionInfo | null;
  last_applied: LastApplied | null;
  can_full: boolean;
  staff_enabled: boolean;
}

export interface PrinterWarning {
  code:
    | "row_offset_drift"
    | "direct_thermal"
    | "sensor_mismatch"
    | "incomplete_reply"
    | "resolution_unexpected"
    | "error_pushed";
  message: string;
}

export interface PrinterConfig {
  complete: boolean;
  firmware: string | null;
  sensor_kind: SensorKind;
  sensor_line: string | null;
  measured_length_dots: number | null;
  measured_gap_dots: number | null;
  measured_pitch_dots: number | null;
  stored_q: string | null;
  width_mm: number | null;
  darkness: number | null;
  speed_ips: number | null;
  stop_mm: number | null;
  left_margin_dots: number | null;
  row_offset_dots: number | null;
  print_mode: "thermal_transfer" | "direct_thermal" | null;
  resolution_dpi: number | null;
}

export interface PrinterStatus {
  printer: string;
  answered: boolean;
  code: string | null;
  code_text: string;
  action_text: string;
  ready: boolean;
  pending: number | null;
  config: PrinterConfig | null;
  raw_config: string | null;
  warnings: PrinterWarning[];
  errors_seen: string[];
}

export interface CalibrationSession {
  session_id: string;
  mode: SessionMode;
  material_id: string;
  phase: SessionPhase;
  user_name: string;
  acquired_at: string;
  expires_at: string;
  /** An apply exists AND it was for the session's current material. */
  applied: boolean;
  sensed: boolean;
  verdict: Verdict | null;
  /** Configuration revision after this call (§5.2) — the wizard's next PUT sends it. */
  config_revision: number;
}

export interface ApplyResult {
  printer: string;
  commands: string[];
  confirmed: boolean | null;
  mismatches: string[];
  config: PrinterConfig | null;
  session: CalibrationSession;
}

export interface AutosenseResult {
  printer: string;
  method: "command" | "button";
  cost_hint: string;
  status_answered: boolean;
  presense: {
    stored_q: string | null;
    measured_length_dots: number | null;
    measured_gap_dots: number | null;
    apply_confirmed: boolean | null;
  } | null;
  session: CalibrationSession;
}

export interface SensePoll {
  phase: "sensing" | "done" | "error" | "timeout";
  answered: boolean;
  code: string | null;
  code_text: string;
  message: string;
  saw_busy: boolean;
  elapsed_s: number;
  session: CalibrationSession;
}

export interface CalibrationVerdict {
  material_id: string;
  verdict: Verdict;
  title: string;
  detail: string;
  notes: string[];
  fresh: boolean;
  freshness: Freshness;
  from_latch: boolean;
  dots_per_mm: number;
  expected_length_mm: number | null;
  expected_gap_mm: number | null;
  expected_pitch_mm: number | null;
  measured_length_mm: number | null;
  measured_gap_mm: number | null;
  measured_pitch_mm: number | null;
  measured_length_dots: number | null;
  measured_gap_dots: number | null;
  delta_length_mm: number | null;
  delta_pitch_mm: number | null;
  tolerance_mm: number | null;
  sensor_kind: SensorKind;
  sensor_expected: "see_through" | "reflective" | null;
  sensor_ok: boolean | null;
  suggested_material_ids: string[];
  status_code: string | null;
  status_text: string;
  offers: Offer[];
  warnings: PrinterWarning[];
  session: CalibrationSession;
}

export interface PatternGeometry {
  kind: "diecut" | "continuous";
  width_mm: number;
  length_mm: number;
  inset_mm: number;
  line_mm: number;
  letters: boolean;
  ruler_from_mm: number | null;
  ruler_to_mm: number | null;
  side_line_inset_mm: number | null;
  bar_inset_mm: number | null;
  feed_measurable: boolean;
  across_measurable: boolean;
}

export interface PatternResult {
  printer: string;
  cost_hint: string;
  geometry: PatternGeometry;
  x_offset_mm: number;
  across_offset_mm: number;
  session: CalibrationSession;
}

export interface PatternMeasurements {
  lead_mm: number | null;
  trail_mm: number | null;
  left_mm: number | null;
  right_mm: number | null;
  ruler_nominal_mm: number | null;
  ruler_measured_mm: number | null;
}

export interface CalibrationSaveIn {
  notes: string;
  accept_verdict: boolean;
  pattern: PatternMeasurements | null;
}

export interface CalibrationRecord {
  material_id: string;
  kind: SessionMode;
  at: string;
  by_name: string;
  verdict: Verdict;
  fresh: boolean;
  freshness: Freshness;
  accepted: boolean;
  stale: boolean;
  measured_length_dots: number | null;
  measured_gap_dots: number | null;
  measured_pitch_dots: number | null;
  sensor_kind: SensorKind;
  firmware: string | null;
  row_offset_dots: number | null;
  pattern: PatternMeasurements | null;
  changes: Record<string, { from: number | null; to: number | null }>;
  notes: string;
}

export type LabelMaterialUpdate = { revision: number; reset_fields?: string[] } & Partial<{
  name: string;
  part_no: string;
  width_mm: number;
  length_mm: number | null;
  gap_mm: number;
  x_offset_mm: number;
  across_offset_mm: number;
  darkness: number | null;
  speed_ips: number | null;
  stop_mm: number | null;
  sensor_mode: SensorMode;
  sensor_scale: number;
  guide: GuideSetting;
  feed_path: FeedPath;
  roller: Roller;
  mark_width_mm: number | null;
  mark_offset_mm: number;
  mark_inside: boolean;
  web: MediaWeb;
}>;

export interface PrinterSettingsUpdate {
  revision: number;
  baseline?: Partial<{ darkness: number | null; speed_ips: number | null; stop_mm: number | null }>;
  row_offset_dots?: number | null;
  label_calibration_staff_enabled?: boolean;
}

export interface LabelPrinterSettingsPatch {
  host?: string | null;
  port?: number | null;
  materials?: Partial<LabelMaterial>[] | null;
  active_material_id?: string | null;
  revision?: number | null;
}

export interface LabelPrinterApiErrorDetail {
  code: string;
  message: string;
  [extra: string]: unknown;
}

/** What the admin Testdruck / Freitext routes answer (unchanged by this build). */
export interface LabelPrinterTestResult {
  ok: boolean;
  printer: string;
  detail: string;
}
