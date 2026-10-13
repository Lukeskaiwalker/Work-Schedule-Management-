/**
 * Label printer client — the werkstatt calibration routes and the admin
 * settings routes (docs/LABEL_PRINTER_CALIBRATION.md §6.2, §7.3).
 *
 * Every call goes through `apiFetch`, which already turns a `{detail: {code,
 * message}}` error into an `ApiError` whose `message` is the server's German
 * text; callers branch on `apiErrorCode(err)` and show `err.message`.
 *
 * The two calls that move paper (`startAutosense`, `printMeasuringPattern`)
 * always send `confirm_feed: true`. They are only reachable from the feed
 * confirmation dialog — the flag states that the dialog was confirmed, and the
 * server refuses the call without it rather than assuming consent.
 */
import { apiFetch } from "../api/client";
import type {
  ApplyResult,
  AutosenseResult,
  CalibrationRecord,
  CalibrationSaveIn,
  CalibrationSession,
  CalibrationVerdict,
  LabelMaterialUpdate,
  LabelPrinterOverview,
  LabelPrinterSettings,
  LabelPrinterSettingsPatch,
  LabelPrinterTestResult,
  PatternResult,
  PrinterSettingsUpdate,
  PrinterStatus,
  SensePoll,
  SessionMode,
} from "../types/labelPrinter";

const W = "/werkstatt/label-printer";
const A = "/admin/settings/label-printer";

type Token = string | null;

function post(body?: unknown): RequestInit {
  return body === undefined ? { method: "POST" } : { method: "POST", body: JSON.stringify(body) };
}

function session(sid: string, action = ""): string {
  return `${W}/session/${encodeURIComponent(sid)}${action ? `/${action}` : ""}`;
}

export function getLabelPrinterOverview(token: Token): Promise<LabelPrinterOverview> {
  return apiFetch<LabelPrinterOverview>(W, token);
}

/** Read-only on the printer: STATUS, and with `full` also CONFIG. */
export function getPrinterStatus(token: Token, full: boolean): Promise<PrinterStatus> {
  return apiFetch<PrinterStatus>(`${W}/status?full=${full ? "true" : "false"}`, token);
}

export function startCalibrationSession(
  token: Token,
  body: { mode: SessionMode; material_id: string; takeover?: boolean },
): Promise<CalibrationSession> {
  return apiFetch<CalibrationSession>(`${W}/session`, token, post(body));
}

export function heartbeatSession(token: Token, sid: string): Promise<CalibrationSession> {
  return apiFetch<CalibrationSession>(session(sid, "heartbeat"), token, post());
}

/** Idempotent on the server (always 204), so a stale tab can call it safely. */
export async function endCalibrationSession(token: Token, sid: string): Promise<void> {
  await apiFetch<unknown>(session(sid), token, { method: "DELETE" });
}

export function activateMaterial(token: Token, sid: string, materialId: string): Promise<CalibrationSession> {
  return apiFetch<CalibrationSession>(session(sid, "activate"), token, post({ material_id: materialId }));
}

export function applyMaterialSettings(token: Token, sid: string): Promise<ApplyResult> {
  return apiFetch<ApplyResult>(session(sid, "apply"), token, post());
}

export function startAutosense(
  token: Token,
  sid: string,
  method: "command" | "button",
): Promise<AutosenseResult> {
  return apiFetch<AutosenseResult>(session(sid, "autosense"), token, post({ confirm_feed: true, method }));
}

export function pollSensing(token: Token, sid: string): Promise<SensePoll> {
  return apiFetch<SensePoll>(session(sid, "poll"), token, post());
}

export function verifyMeasurement(token: Token, sid: string): Promise<CalibrationVerdict> {
  return apiFetch<CalibrationVerdict>(session(sid, "verify"), token, post());
}

export function printMeasuringPattern(token: Token, sid: string): Promise<PatternResult> {
  return apiFetch<PatternResult>(session(sid, "pattern"), token, post({ confirm_feed: true }));
}

export function saveCalibration(
  token: Token,
  sid: string,
  body: CalibrationSaveIn,
): Promise<CalibrationRecord> {
  return apiFetch<CalibrationRecord>(session(sid, "save"), token, post(body));
}

export function getLabelPrinterSettings(token: Token): Promise<LabelPrinterSettings> {
  return apiFetch<LabelPrinterSettings>(A, token);
}

export function patchLabelPrinterSettings(
  token: Token,
  body: LabelPrinterSettingsPatch,
): Promise<LabelPrinterSettings> {
  return apiFetch<LabelPrinterSettings>(A, token, { method: "PATCH", body: JSON.stringify(body) });
}

export function updateLabelMaterial(
  token: Token,
  id: string,
  body: LabelMaterialUpdate,
): Promise<LabelPrinterSettings> {
  return apiFetch<LabelPrinterSettings>(`${A}/materials/${encodeURIComponent(id)}`, token, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function updatePrinterSettings(
  token: Token,
  body: PrinterSettingsUpdate,
): Promise<LabelPrinterSettings> {
  return apiFetch<LabelPrinterSettings>(`${A}/printer`, token, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function printTestLabel(token: Token): Promise<LabelPrinterTestResult> {
  return apiFetch<LabelPrinterTestResult>(`${A}/test`, token, post());
}

export function printFreetext(token: Token, text: string, copies: number): Promise<LabelPrinterTestResult> {
  return apiFetch<LabelPrinterTestResult>(`${A}/freetext`, token, post({ text, copies }));
}
