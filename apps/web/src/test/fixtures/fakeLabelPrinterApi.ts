/**
 * A fake of the label-printer API behind a mocked `apiFetch`, for the
 * calibration UI tests.
 *
 * It keeps a little session state (phase, applied, sensed, verdict, revision)
 * so a flow can be clicked through end to end with consistent responses, and
 * it records every call so a test can assert what was — and was NOT — sent.
 * Any route can be overridden per test with `on("POST …/autosense", fn)`;
 * session ids in paths are normalised to `:sid` for that.
 */
import { ApiError } from "../../api/client";
import type {
  CalibrationSession,
  CalibrationVerdict,
  LabelPrinterOverview,
  LabelPrinterSettings,
  SessionPhase,
  Verdict,
} from "../../types/labelPrinter";
import { overviewFixture, settingsFixture } from "./labelPrinterMaterials";

export interface RecordedCall {
  key: string;
  method: string;
  path: string;
  body: unknown;
}

// Request bodies are parsed JSON; handlers read whatever fields their route takes.
type Handler = (body: any, call: RecordedCall) => unknown;

export const W = "/werkstatt/label-printer";
export const A = "/admin/settings/label-printer";

/** A rejected call the way apiFetch reports a `{detail: {code, message, …}}` answer. */
export function apiError(status: number, detail: Record<string, unknown> | string): ApiError {
  const message = typeof detail === "string" ? detail : String(detail.message ?? "");
  return new ApiError(message, status, detail);
}

export function verdictFixture(session: CalibrationSession, overrides: Partial<CalibrationVerdict> = {}): CalibrationVerdict {
  return {
    material_id: session.material_id,
    verdict: "match",
    title: "Passt zu „Typenschilder 99 × 44 (silber)“",
    detail: "Gemessen 97 + 2,5 mm (Teilung 99,5 mm), Abweichung −2,5 mm bei ± 3,1 mm Toleranz.",
    notes: [],
    fresh: true,
    freshness: "busy_seen",
    from_latch: false,
    dots_per_mm: 12,
    expected_length_mm: 99,
    expected_gap_mm: 3,
    expected_pitch_mm: 102,
    measured_length_mm: 97,
    measured_gap_mm: 2.5,
    measured_pitch_mm: 99.5,
    measured_length_dots: 1164,
    measured_gap_dots: 30,
    delta_length_mm: -2,
    delta_pitch_mm: -2.5,
    tolerance_mm: 3.1,
    sensor_kind: "see_through",
    sensor_expected: "see_through",
    sensor_ok: true,
    suggested_material_ids: [],
    status_code: "00",
    status_text: "Bereit",
    offers: ["save"],
    warnings: [],
    session,
    ...overrides,
  };
}

export function createFakeLabelApi(options: {
  overview?: Partial<LabelPrinterOverview>;
  settings?: Partial<LabelPrinterSettings>;
  mode?: "quick" | "full";
} = {}) {
  const calls: RecordedCall[] = [];
  const state = {
    sid: "sid-1",
    mode: options.mode ?? "quick",
    material_id: "",
    phase: "open" as SessionPhase,
    applied: false,
    sensed: false,
    verdict: null as Verdict | null,
    revision: options.settings?.revision ?? 5,
  };
  let settings = settingsFixture(options.settings);

  const session = (): CalibrationSession => ({
    session_id: state.sid,
    mode: state.mode,
    material_id: state.material_id,
    phase: state.phase,
    user_name: "Test",
    acquired_at: "2026-10-20T07:05:00Z",
    expires_at: "2026-10-20T07:15:00Z",
    applied: state.applied,
    sensed: state.sensed,
    verdict: state.verdict,
    config_revision: state.revision,
  });
  const nextVerdict = { current: (s: CalibrationSession) => verdictFixture(s) };

  const defaults: Record<string, Handler> = {
    [`GET ${W}`]: () => overviewFixture(options.overview),
    [`GET ${W}/status?full=true`]: () => ({
      printer: "192.168.2.158:9100", answered: true, code: "00", code_text: "Bereit", action_text: "", ready: true,
      pending: 0, config: null, raw_config: null, warnings: [], errors_seen: [],
    }),
    [`POST ${W}/session`]: (body) => {
      state.mode = body.mode;
      state.material_id = body.material_id;
      state.phase = "open";
      return session();
    },
    [`POST ${W}/session/:sid/heartbeat`]: () => session(),
    [`DELETE ${W}/session/:sid`]: () => ({}),
    [`POST ${W}/session/:sid/activate`]: (body) => {
      if (body.material_id !== settings.active_material_id) {
        state.revision += 1;
        settings = { ...settings, active_material_id: body.material_id, revision: state.revision };
      }
      state.material_id = body.material_id;
      state.phase = "activated";
      state.applied = false;
      state.verdict = null;
      return session();
    },
    [`POST ${W}/session/:sid/apply`]: () => {
      state.phase = "applied";
      state.applied = true;
      return {
        printer: "192.168.2.158:9100",
        commands: ["^G1", "^XSET,SENSING,1", "^Q99,3", "^W44"],
        confirmed: true,
        mismatches: [],
        config: null,
        session: session(),
      };
    },
    [`POST ${W}/session/:sid/autosense`]: (body) => {
      state.phase = "sensing";
      state.sensed = true;
      state.verdict = null;
      return {
        printer: "192.168.2.158:9100", method: body.method, cost_hint: "voraussichtlich 2–3 Etiketten (≈ 20–30 cm, Schätzung)",
        status_answered: true, presense: null, session: session(),
      };
    },
    [`POST ${W}/session/:sid/poll`]: () => {
      state.phase = "sensed";
      return { phase: "done", answered: true, code: "00", code_text: "Bereit", message: "", saw_busy: true, elapsed_s: 7, session: session() };
    },
    [`POST ${W}/session/:sid/verify`]: () => {
      state.phase = "judged";
      const verdict = nextVerdict.current(session());
      state.verdict = verdict.verdict;
      return { ...verdict, session: session() };
    },
    [`POST ${W}/session/:sid/pattern`]: () => ({
      printer: "192.168.2.158:9100",
      cost_hint: "1 Etikett",
      geometry: {
        kind: "diecut", width_mm: 44, length_mm: 99, inset_mm: 2, line_mm: 0.25, letters: true, ruler_from_mm: 10,
        ruler_to_mm: 90, side_line_inset_mm: null, bar_inset_mm: null, feed_measurable: true, across_measurable: false,
      },
      x_offset_mm: 2,
      across_offset_mm: 0,
      session: session(),
    }),
    [`POST ${W}/session/:sid/save`]: (body) => ({
      material_id: state.material_id, kind: state.mode, at: "2026-10-20T09:12:00Z", by_name: "Test", verdict: state.verdict,
      fresh: true, freshness: "busy_seen", accepted: body.accept_verdict, stale: false, measured_length_dots: 1164,
      measured_gap_dots: 30, measured_pitch_dots: 1194, sensor_kind: "see_through", firmware: null, row_offset_dots: -19,
      pattern: body.pattern, changes: {}, notes: body.notes,
    }),
    [`GET ${A}`]: () => settings,
    [`PATCH ${A}`]: () => {
      state.revision += 1;
      settings = { ...settings, revision: state.revision };
      return settings;
    },
    [`PUT ${A}/printer`]: (body) => {
      state.revision += 1;
      settings = { ...settings, ...body, revision: state.revision };
      return settings;
    },
    [`PUT ${A}/materials/:id`]: () => {
      state.revision += 1;
      settings = { ...settings, revision: state.revision };
      return settings;
    },
  };
  const overrides: Record<string, Handler> = {};

  function normalise(method: string, path: string): string {
    const p = path
      .replace(/\/session\/[^/?]+/, "/session/:sid")
      .replace(/\/materials\/[^/?]+/, "/materials/:id");
    return `${method} ${p}`;
  }

  async function handle(path: string, _token: unknown, init?: RequestInit): Promise<unknown> {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { key: normalise(method, path), method, path, body };
    calls.push(call);
    const handler = overrides[call.key] ?? defaults[call.key];
    if (!handler) throw new Error(`fake label API: no route for ${call.key}`);
    return handler(body, call);
  }

  return {
    handle,
    calls,
    state,
    session,
    /** Override one route; the handler may throw `apiError(…)`. */
    on(key: string, handler: Handler) {
      overrides[key] = handler;
    },
    /** What the next verify answers (built from the current session). */
    verdict(build: (s: CalibrationSession) => CalibrationVerdict) {
      nextVerdict.current = build;
    },
    count(key: string): number {
      return calls.filter((call) => call.key === key).length;
    },
    bodies(key: string): unknown[] {
      return calls.filter((call) => call.key === key).map((call) => call.body);
    },
    get settings() {
      return settings;
    },
    setSettings(next: LabelPrinterSettings) {
      settings = next;
    },
  };
}

export type FakeLabelApi = ReturnType<typeof createFakeLabelApi>;
