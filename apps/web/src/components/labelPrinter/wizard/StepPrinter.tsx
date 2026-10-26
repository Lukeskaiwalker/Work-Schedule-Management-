/**
 * Wizard step 1 "Drucker prüfen" (docs/LABEL_PRINTER_CALIBRATION.md §7.6).
 *
 * Shows what the printer has stored and lets the admin set SMPL's baseline —
 * the `^H ^S ^E` every SMPL job states, so values another program left on the
 * printer cannot change SMPL prints. The row offset (`~Q`) is never written in
 * this build; it can only be pinned as the reference the drift warning
 * compares against.
 */
import { useCallback, useState } from "react";

import { useAppContext } from "../../../context/AppContext";
import type { LabelPrinterSettings, PrinterSettingsUpdate, PrinterStatus } from "../../../types/labelPrinter";
import { apiErrorCode, errorText, parseDecimalInput } from "../../../utils/labelCalibration";
import { updatePrinterSettings } from "../../../utils/labelPrinterApi";
import { PrinterStatusPanel } from "../PrinterStatusPanel";

export interface StepPrinterProps {
  settings: LabelPrinterSettings;
  revision: number;
  onSettings: (settings: LabelPrinterSettings) => void;
  onPutError: (err: unknown) => void;
}

const intOrNull = (text: string): number | null => {
  const value = parseDecimalInput(text);
  return value === null ? null : Math.round(value);
};

export function StepPrinter({ settings, revision, onSettings, onPutError }: StepPrinterProps) {
  const { token, language } = useAppContext();
  const de = language === "de";
  const [status, setStatus] = useState<PrinterStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ darkness: "", speed: "", stop: "" });
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const onStatus = useCallback((next: PrinterStatus) => setStatus(next), []);

  const base = settings.baseline;
  const config = status?.config ?? null;

  async function put(body: Omit<PrinterSettingsUpdate, "revision">) {
    setSaving(true);
    setError(null);
    try {
      onSettings(await updatePrinterSettings(token, { revision, ...body }));
      setEditing(false);
    } catch (err) {
      // A stale revision is shown once, by the wizard, with its [Neu laden].
      setError(apiErrorCode(err) === "stale_revision" ? null : err);
      onPutError(err);
    } finally {
      setSaving(false);
    }
  }

  const differs =
    config &&
    config.darkness !== null &&
    config.speed_ips !== null &&
    config.stop_mm !== null &&
    (config.darkness !== base.darkness || config.speed_ips !== base.speed_ips || config.stop_mm !== base.stop_mm);
  const live = config?.row_offset_dots ?? null;
  const pinned = settings.row_offset_dots;

  return (
    <div className="lc-step-printer">
      <PrinterStatusPanel autoLoad onStatus={onStatus} />

      <p className="lc-intro">
        {de
          ? `Grundeinstellung für alle SMPL-Drucke: Schwärzung ${base.darkness} · Geschwindigkeit ${base.speed_ips} · Stopp ${base.stop_mm} mm`
          : `Baseline for every SMPL print: darkness ${base.darkness} · speed ${base.speed_ips} · stop ${base.stop_mm} mm`}
      </p>
      {!editing ? (
        <div className="lc-actions">
          <button
            type="button"
            className="werkstatt-action-btn lc-btn"
            onClick={() => {
              setDraft({ darkness: String(base.darkness), speed: String(base.speed_ips), stop: String(base.stop_mm) });
              setEditing(true);
            }}
          >
            {de ? "Ändern" : "Change"}
          </button>
        </div>
      ) : (
        <div className="lc-form-grid">
          <label className="lc-field">
            <span>{de ? "Schwärzung" : "Darkness"}</span>
            <input type="text" inputMode="numeric" value={draft.darkness} onChange={(e) => setDraft({ ...draft, darkness: e.target.value })} />
          </label>
          <label className="lc-field">
            <span>{de ? "Geschwindigkeit" : "Speed"}</span>
            <input type="text" inputMode="numeric" value={draft.speed} onChange={(e) => setDraft({ ...draft, speed: e.target.value })} />
          </label>
          <label className="lc-field">
            <span>{de ? "Stopp (mm)" : "Stop (mm)"}</span>
            <input type="text" inputMode="numeric" value={draft.stop} onChange={(e) => setDraft({ ...draft, stop: e.target.value })} />
          </label>
          <div className="lc-actions">
            <button
              type="button"
              className="werkstatt-action-btn werkstatt-action-btn--primary lc-btn"
              disabled={saving}
              onClick={() =>
                void put({
                  baseline: { darkness: intOrNull(draft.darkness), speed_ips: intOrNull(draft.speed), stop_mm: intOrNull(draft.stop) },
                })
              }
            >
              {de ? "Speichern" : "Save"}
            </button>
          </div>
        </div>
      )}

      {differs && config && (
        <div className="lc-info">
          <p className="lc-intro">
            {de
              ? `Der Drucker steht auf Schwärzung ${config.darkness} · Geschwindigkeit ${config.speed_ips} · Stopp ${config.stop_mm} mm – SMPL sendet mit jedem Druck die Grundeinstellung.`
              : `The printer is set to darkness ${config.darkness} · speed ${config.speed_ips} · stop ${config.stop_mm} mm – SMPL sends the baseline with every print.`}
          </p>
          <button
            type="button"
            className="werkstatt-action-btn lc-btn"
            disabled={saving}
            onClick={() => void put({ baseline: { darkness: config.darkness, speed_ips: config.speed_ips, stop_mm: config.stop_mm } })}
          >
            {de ? "Druckerwerte als Grundeinstellung übernehmen" : "Use the printer's values as baseline"}
          </button>
        </div>
      )}

      {live !== null && pinned === null && (
        <div className="lc-info">
          <p className="lc-intro">{de ? `Zeilenversatz am Drucker: ${live} Punkte.` : `Row offset on the printer: ${live} dots.`}</p>
          <button type="button" className="werkstatt-action-btn lc-btn" disabled={saving} onClick={() => void put({ row_offset_dots: live })}>
            {de ? "Als Bezugswert merken" : "Pin as reference"}
          </button>
        </div>
      )}
      {live !== null && pinned !== null && live === pinned && (
        <p className="lc-ok">
          {de ? `Zeilenversatz ${live} Punkte entspricht dem Bezugswert ✓` : `Row offset ${live} dots matches the reference ✓`}
        </p>
      )}

      {error !== null && (
        <p className="lc-error" role="alert">
          {errorText(error)}
        </p>
      )}
    </div>
  );
}
