/**
 * The label-printer client is a thin layer over apiFetch, but it is the one
 * place the web app names the calibration routes. These pin every function's
 * method, path (ids encoded) and body against the contract — and above all
 * that the two calls that feed paper always say `confirm_feed: true`, because
 * the server refuses them otherwise and never assumes consent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "../api/client";
import {
  activateMaterial,
  applyMaterialSettings,
  endCalibrationSession,
  getLabelPrinterOverview,
  getLabelPrinterSettings,
  getPrinterStatus,
  heartbeatSession,
  patchLabelPrinterSettings,
  pollSensing,
  printFreetext,
  printMeasuringPattern,
  printTestLabel,
  saveCalibration,
  startAutosense,
  startCalibrationSession,
  updateLabelMaterial,
  updatePrinterSettings,
  verifyMeasurement,
} from "../utils/labelPrinterApi";

vi.mock("../api/client", () => ({ apiFetch: vi.fn() }));

const apiFetchMock = vi.mocked(apiFetch);
const TOKEN = "test-token";
const SID = "a b/c";
const SID_ENC = "a%20b%2Fc";

/** [path, method, parsed body] of the single call made. */
function lastCall(): [string, string, unknown] {
  expect(apiFetchMock).toHaveBeenCalledTimes(1);
  const [path, token, init] = apiFetchMock.mock.calls[0];
  expect(token).toBe(TOKEN);
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  return [path, method, body];
}

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue({});
});

describe("werkstatt label-printer routes", () => {
  it("reads the overview", async () => {
    await getLabelPrinterOverview(TOKEN);
    expect(lastCall()).toEqual(["/werkstatt/label-printer", "GET", undefined]);
  });

  it("reads the status, short or full", async () => {
    await getPrinterStatus(TOKEN, true);
    expect(lastCall()).toEqual(["/werkstatt/label-printer/status?full=true", "GET", undefined]);
    apiFetchMock.mockClear();
    await getPrinterStatus(TOKEN, false);
    expect(lastCall()).toEqual(["/werkstatt/label-printer/status?full=false", "GET", undefined]);
  });

  it("starts a session with mode, material and takeover", async () => {
    await startCalibrationSession(TOKEN, { mode: "quick", material_id: "wago-210-804", takeover: true });
    expect(lastCall()).toEqual([
      "/werkstatt/label-printer/session",
      "POST",
      { mode: "quick", material_id: "wago-210-804", takeover: true },
    ]);
  });

  it("heartbeats and ends the session under its encoded id", async () => {
    await heartbeatSession(TOKEN, SID);
    expect(lastCall()).toEqual([`/werkstatt/label-printer/session/${SID_ENC}/heartbeat`, "POST", undefined]);
    apiFetchMock.mockClear();
    await endCalibrationSession(TOKEN, SID);
    expect(lastCall()).toEqual([`/werkstatt/label-printer/session/${SID_ENC}`, "DELETE", undefined]);
  });

  it("activates a material", async () => {
    await activateMaterial(TOKEN, SID, "wago-210-812");
    expect(lastCall()).toEqual([
      `/werkstatt/label-printer/session/${SID_ENC}/activate`,
      "POST",
      { material_id: "wago-210-812" },
    ]);
  });

  it("applies without a body (no paper, nothing to confirm)", async () => {
    await applyMaterialSettings(TOKEN, SID);
    expect(lastCall()).toEqual([`/werkstatt/label-printer/session/${SID_ENC}/apply`, "POST", undefined]);
  });

  it("starts the auto-sense only with confirm_feed true, for either method", async () => {
    await startAutosense(TOKEN, SID, "command");
    expect(lastCall()).toEqual([
      `/werkstatt/label-printer/session/${SID_ENC}/autosense`,
      "POST",
      { confirm_feed: true, method: "command" },
    ]);
    apiFetchMock.mockClear();
    await startAutosense(TOKEN, SID, "button");
    expect(lastCall()[2]).toEqual({ confirm_feed: true, method: "button" });
  });

  it("polls and verifies", async () => {
    await pollSensing(TOKEN, SID);
    expect(lastCall()).toEqual([`/werkstatt/label-printer/session/${SID_ENC}/poll`, "POST", undefined]);
    apiFetchMock.mockClear();
    await verifyMeasurement(TOKEN, SID);
    expect(lastCall()).toEqual([`/werkstatt/label-printer/session/${SID_ENC}/verify`, "POST", undefined]);
  });

  it("prints the measuring pattern only with confirm_feed true", async () => {
    await printMeasuringPattern(TOKEN, SID);
    expect(lastCall()).toEqual([
      `/werkstatt/label-printer/session/${SID_ENC}/pattern`,
      "POST",
      { confirm_feed: true },
    ]);
  });

  it("saves the calibration record", async () => {
    const body = { notes: "Rolle neu", accept_verdict: false, pattern: null };
    await saveCalibration(TOKEN, SID, body);
    expect(lastCall()).toEqual([`/werkstatt/label-printer/session/${SID_ENC}/save`, "POST", body]);
  });
});

describe("admin label-printer routes", () => {
  it("reads and patches the settings", async () => {
    await getLabelPrinterSettings(TOKEN);
    expect(lastCall()).toEqual(["/admin/settings/label-printer", "GET", undefined]);
    apiFetchMock.mockClear();
    await patchLabelPrinterSettings(TOKEN, { active_material_id: "wago-210-812", revision: 4 });
    expect(lastCall()).toEqual([
      "/admin/settings/label-printer",
      "PATCH",
      { active_material_id: "wago-210-812", revision: 4 },
    ]);
  });

  it("puts one material under its encoded id", async () => {
    await updateLabelMaterial(TOKEN, "custom/ä 1", { revision: 7, x_offset_mm: 1.6 });
    expect(lastCall()).toEqual([
      "/admin/settings/label-printer/materials/custom%2F%C3%A4%201",
      "PUT",
      { revision: 7, x_offset_mm: 1.6 },
    ]);
  });

  it("puts the printer-level settings", async () => {
    await updatePrinterSettings(TOKEN, { revision: 3, label_calibration_staff_enabled: true });
    expect(lastCall()).toEqual([
      "/admin/settings/label-printer/printer",
      "PUT",
      { revision: 3, label_calibration_staff_enabled: true },
    ]);
  });

  it("prints the test label and free text", async () => {
    await printTestLabel(TOKEN);
    expect(lastCall()).toEqual(["/admin/settings/label-printer/test", "POST", undefined]);
    apiFetchMock.mockClear();
    await printFreetext(TOKEN, "F1 Herd", 3);
    expect(lastCall()).toEqual([
      "/admin/settings/label-printer/freetext",
      "POST",
      { text: "F1 Herd", copies: 3 },
    ]);
  });
});
