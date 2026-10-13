/**
 * "Einmessen" — the printer feeds media and measures label and gap
 * (docs/LABEL_PRINTER_CALIBRATION.md §4.6, §7.4 step 4, §7.7).
 *
 * The stop instruction (open the lid) is on screen from the start of the step,
 * before anything moves: SMPL has no command that stops a running auto-sense,
 * and on continuous stock no source bounds how much it feeds.
 *
 * Two ways in, both behind the feed dialog: the `~S,SENSOR` command, or the
 * calibration button on the back. When the printer does not answer STATUS the
 * server refuses the command method (`no_status_reply`) and the button method
 * is highlighted; with a silent STATUS nothing is polled and the person asks
 * for the result when the printer stands still.
 *
 * Switch mode (`verifyWithoutSensing`): after [Auf „X“ umstellen] the
 * measurement already exists, so this step only re-judges it for X.
 */
import { useState } from "react";

import type { LabelMaterial } from "../../types/labelPrinter";
import { apiErrorCode, errorText, feedStopHint } from "../../utils/labelCalibration";
import { ConfirmFeedDialog, type FeedVariant } from "./ConfirmFeedDialog";
import { canStartSensing, type CalibrationSessionApi } from "./useCalibrationSession";
import "../../styles/label-calibration.css";

export interface SensePanelProps {
  material: LabelMaterial;
  calibration: CalibrationSessionApi;
  onBackToSensor: () => void;
  onError?: (err: unknown) => void;
  de?: boolean;
}

export function SensePanel({ material, calibration, onBackToSensor, onError, de = true }: SensePanelProps) {
  const [dialog, setDialog] = useState<FeedVariant | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [highlightButton, setHighlightButton] = useState(false);
  const { autosense, poll, polling, pollError, busy } = calibration;

  async function confirmed(variant: FeedVariant) {
    setDialog(null);
    setError(null);
    try {
      await calibration.startSense(variant === "button" ? "button" : "command");
      setHighlightButton(false);
    } catch (err) {
      setError(err);
      if (apiErrorCode(err) === "no_status_reply") setHighlightButton(true);
      onError?.(err);
    }
  }

  async function requestResult() {
    setError(null);
    calibration.stopPolling();
    try {
      await calibration.verify();
    } catch (err) {
      setError(err);
      onError?.(err);
    }
  }

  const resultButton = (
    <button type="button" className="werkstatt-action-btn werkstatt-action-btn--primary lc-btn" onClick={() => void requestResult()} disabled={busy === "verify"}>
      {de ? "Ergebnis abfragen" : "Get result"}
    </button>
  );

  if (calibration.verifyWithoutSensing) {
    return (
      <div className="lc-sense">
        <p className="lc-intro">
          {de
            ? `Gemessen wurde bereits – SMPL bewertet die Messung jetzt für „${material.name}“.`
            : `The measurement already exists – SMPL now judges it for "${material.name}".`}
        </p>
        <div className="lc-actions">
          <button type="button" className="werkstatt-action-btn werkstatt-action-btn--primary lc-btn" onClick={() => void requestResult()} disabled={busy === "verify"}>
            {de ? "Ergebnis prüfen" : "Check result"}
          </button>
        </div>
        {error !== null && <p className="lc-error" role="alert">{errorText(error)}</p>}
      </div>
    );
  }

  const buttonMethod = autosense?.method === "button";
  const finished = poll && (poll.phase === "error" || poll.phase === "timeout");
  // After the last poll the result is still being read (seconds on the real
  // printer, T2 13.10.2026) — no second feed may be one click away meanwhile.
  const reading = busy === "verify";
  const running = polling || reading || (buttonMethod && !finished);
  const startCode = apiErrorCode(error);

  return (
    <div className="lc-sense">
      <p className="lc-intro">
        {de
          ? "Der Drucker zieht jetzt Material ein und misst Etikett und Spalt – wie die Kalibriertaste auf der Rückseite."
          : "The printer now feeds media and measures label and gap – like the calibration button on the back."}
      </p>
      <p className="lc-warn">⚠ {feedStopHint(de)}</p>

      {!running && (
        <div className="lc-actions">
          <button
            type="button"
            className="werkstatt-action-btn werkstatt-action-btn--primary lc-btn"
            onClick={() => setDialog("command")}
            disabled={!canStartSensing(calibration.session) || busy === "autosense"}
          >
            {de ? "Einmessen starten" : "Start sensing"}
          </button>
          <button
            type="button"
            className={`lc-link-btn${highlightButton ? " lc-link-btn--highlight" : ""}`}
            onClick={() => setDialog("button")}
            disabled={!canStartSensing(calibration.session) || busy === "autosense"}
          >
            {de ? "Drucker reagiert nicht? Mit der Kalibriertaste einmessen" : "Printer not responding? Sense with the calibration button"}
          </button>
        </div>
      )}

      {polling && (
        <p className="lc-info" role="status">
          <span className="lc-spinner" aria-hidden="true" />
          {de ? "Drucker misst …" : "Printer is measuring …"}
          {poll?.code_text ? ` (${poll.code_text})` : ""} · {Math.round(poll?.elapsed_s ?? 0)} s ·{" "}
          {de ? "erwartet" : "expected"}: {autosense?.cost_hint || material.autosense_cost_hint}
        </p>
      )}
      {polling && poll?.message && <p className="lc-warn">⚠ {poll.message}</p>}
      {reading && !polling && (
        <p className="lc-info" role="status">
          <span className="lc-spinner" aria-hidden="true" />
          {de ? "Messergebnis wird gelesen …" : "Reading the measurement …"}
        </p>
      )}

      {buttonMethod && !finished && (
        <>
          <p className="lc-intro">
            {de
              ? "Jetzt die Kalibriertaste auf der Rückseite des Druckers 1 Sekunde gedrückt halten."
              : "Now hold the calibration button on the back of the printer for 1 second."}
          </p>
          <div className="lc-actions">{resultButton}</div>
        </>
      )}

      {finished && (
        <>
          <p className="lc-error" role="alert">
            {poll.message || poll.code_text}
          </p>
          <div className="lc-actions">
            {resultButton}
            <button type="button" className="werkstatt-action-btn lc-btn" onClick={onBackToSensor}>
              {de ? "Zurück zum Sensor" : "Back to the sensor"}
            </button>
          </div>
        </>
      )}

      {pollError !== null && !finished && (
        <>
          <p className="lc-error" role="alert">{errorText(pollError)}</p>
          {!buttonMethod && <div className="lc-actions">{resultButton}</div>}
        </>
      )}

      {error !== null && (
        <>
          <p className="lc-error" role="alert">{errorText(error)}</p>
          {startCode === "printer_not_ready" && (
            <div className="lc-actions">
              <button type="button" className="werkstatt-action-btn lc-btn" onClick={() => setDialog("command")}>
                {de ? "Erneut versuchen" : "Try again"}
              </button>
            </div>
          )}
        </>
      )}

      {dialog && (
        <ConfirmFeedDialog
          variant={dialog}
          material={material}
          onConfirm={() => void confirmed(dialog)}
          onCancel={() => setDialog(null)}
          de={de}
        />
      )}
    </div>
  );
}
