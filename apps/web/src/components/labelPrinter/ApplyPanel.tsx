/**
 * "Einstellungen übertragen" — sensor type and label size to the printer,
 * without paper (docs/LABEL_PRINTER_CALIBRATION.md §4.5, §7.4 step 3).
 *
 * The readback afterwards is shown as the printer reported it. A mismatch is a
 * warning with a retry, not an error: whether the sensor line switches on
 * `^G0` is not tested at the printer, and the auto-sense that follows checks
 * the result anyway. "kein Material" is attributed to the EZPL manual, never
 * claimed as observed.
 */
import { useState } from "react";

import type { LabelMaterial } from "../../types/labelPrinter";
import { errorText, formatMmDe, sensorKindLabel, sensorModeLabel } from "../../utils/labelCalibration";
import type { CalibrationSessionApi } from "./useCalibrationSession";
import "../../styles/label-calibration.css";

export interface ApplyPanelProps {
  material: LabelMaterial;
  calibration: CalibrationSessionApi;
  /** Every failure is also reported up, so the shell can react to codes like `not_configured`. */
  onError?: (err: unknown) => void;
  de?: boolean;
}

export function ApplyPanel({ material, calibration, onError, de = true }: ApplyPanelProps) {
  const [error, setError] = useState<unknown>(null);
  const result = calibration.applyResult;
  const busy = calibration.busy === "apply";

  async function send() {
    setError(null);
    try {
      await calibration.apply();
    } catch (err) {
      setError(err);
      onError?.(err);
    }
  }

  const config = result?.config ?? null;
  const width = config?.width_mm != null ? formatMmDe(config.width_mm) : "?";
  return (
    <div className="lc-apply">
      <p className="lc-intro">
        {de
          ? `SMPL stellt den Drucker auf „${material.name}“ ein: Sensor ${sensorModeLabel(material.sensor_mode)} und Etikettengröße. Laut EZPL-Handbuch bewegt dieser Schritt kein Material.`
          : `SMPL sets the printer to "${material.name}": sensor ${sensorModeLabel(material.sensor_mode, false)} and label size. Per the EZPL manual this step moves no media.`}
      </p>
      {!result && (
        <div className="lc-actions">
          <button type="button" className="werkstatt-action-btn werkstatt-action-btn--primary lc-btn" onClick={() => void send()} disabled={busy}>
            {busy ? (de ? "Überträgt …" : "Sending …") : de ? "Übertragen" : "Send"}
          </button>
        </div>
      )}
      {result && (
        <>
          <pre className="lc-mono-box" aria-label={de ? "Gesendete Befehle" : "Commands sent"}>
            {result.commands.join("\n")}
          </pre>
          {result.confirmed === true && (
            <p className="lc-ok">
              {de
                ? `✓ Drucker meldet: Breite ${width} mm, Etikett/Spalt ${config?.stored_q ?? "?"}, Sensor ${sensorKindLabel(config?.sensor_kind ?? "unknown")}`
                : `✓ Printer reports: width ${width} mm, label/gap ${config?.stored_q ?? "?"}, sensor ${sensorKindLabel(config?.sensor_kind ?? "unknown", false)}`}
            </p>
          )}
          {result.confirmed === false && (
            <div className="lc-warn">
              <p className="lc-intro">⚠ {de ? "Drucker meldet andere Werte:" : "Printer reports other values:"}</p>
              <ul className="lc-list">
                {result.mismatches.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <div className="lc-actions">
                <button type="button" className="werkstatt-action-btn lc-btn" onClick={() => void send()} disabled={busy}>
                  {de ? "Erneut übertragen" : "Send again"}
                </button>
              </div>
            </div>
          )}
          {result.confirmed === null && (
            <p className="lc-info">
              ℹ{" "}
              {de
                ? "Der Drucker hat keine Werte zurückgemeldet – das Einmessen prüft das Ergebnis."
                : "The printer reported no values – sensing checks the result."}
            </p>
          )}
        </>
      )}
      {error !== null && (
        <p className="lc-error" role="alert">
          {errorText(error)}
        </p>
      )}
    </div>
  );
}
