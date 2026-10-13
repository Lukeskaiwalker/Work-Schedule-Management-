/**
 * Wizard step 6 "Druckwerte und Abschluss" (docs/LABEL_PRINTER_CALIBRATION.md
 * §7.6): per-material print values (empty = SMPL's baseline), an optional
 * note, and the calibration record. Range errors come back from the server as
 * 422 `invalid_material` in German and are shown above the buttons.
 */
import { useState } from "react";

import { useAppContext } from "../../../context/AppContext";
import type {
  CalibrationVerdict,
  JobSettings,
  LabelMaterial,
  LabelMaterialUpdate,
  LabelPrinterSettings,
  PatternMeasurements,
} from "../../../types/labelPrinter";
import { apiErrorCode, errorText, parseDecimalInput } from "../../../utils/labelCalibration";
import { updateLabelMaterial } from "../../../utils/labelPrinterApi";
import { ConfirmFeedDialog } from "../ConfirmFeedDialog";
import type { CalibrationSessionApi } from "../useCalibrationSession";

export interface StepFinishProps {
  material: LabelMaterial;
  baseline: JobSettings;
  revision: number;
  calibration: CalibrationSessionApi;
  verdict: CalibrationVerdict | null;
  acceptVerdict: boolean;
  pattern: PatternMeasurements | null;
  offsetSummary: string[];
  onSettings: (settings: LabelPrinterSettings) => void;
  onPutError: (err: unknown) => void;
  onDone: () => void;
}

const text = (value: number | null) => (value === null ? "" : String(value));
/** Empty → null (baseline); a number → that number; anything else → undefined (refused). */
const value = (input: string): number | null | undefined => {
  if (input.trim() === "") return null;
  const parsed = parseDecimalInput(input);
  return parsed === null || !Number.isInteger(parsed) ? undefined : parsed;
};

export function StepFinish(props: StepFinishProps) {
  const { material, baseline, calibration } = props;
  const { token, language, setNotice } = useAppContext();
  const de = language === "de";
  const [darkness, setDarkness] = useState(text(material.darkness));
  const [speed, setSpeed] = useState(text(material.speed_ips));
  const [stop, setStop] = useState(text(material.stop_mm));
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [dialog, setDialog] = useState(false);
  const [busy, setBusy] = useState(false);

  const parsed = { darkness: value(darkness), speed_ips: value(speed), stop_mm: value(stop) };
  const bad = Object.values(parsed).some((v) => v === undefined);
  const effective = {
    darkness: parsed.darkness ?? baseline.darkness,
    speed: parsed.speed_ips ?? baseline.speed_ips,
    stop: parsed.stop_mm ?? baseline.stop_mm,
  };

  /** PUT the print values when they differ from the stored overrides. */
  async function saveValues(): Promise<boolean> {
    if (bad) return false;
    const body: LabelMaterialUpdate = { revision: props.revision };
    if (parsed.darkness !== material.darkness) body.darkness = parsed.darkness ?? null;
    if (parsed.speed_ips !== material.speed_ips) body.speed_ips = parsed.speed_ips ?? null;
    if (parsed.stop_mm !== material.stop_mm) body.stop_mm = parsed.stop_mm ?? null;
    if (Object.keys(body).length === 1) return true;
    try {
      props.onSettings(await updateLabelMaterial(token, material.id, body));
      return true;
    } catch (err) {
      // A stale revision is shown once, by the wizard, with its [Neu laden].
      setError(apiErrorCode(err) === "stale_revision" ? null : err);
      props.onPutError(err);
      return false;
    }
  }

  async function testPrint() {
    setError(null);
    setBusy(true);
    const ok = await saveValues();
    setBusy(false);
    if (ok) setDialog(true);
  }

  async function printPattern() {
    setDialog(false);
    try {
      await calibration.printPattern();
    } catch (err) {
      setError(err);
    }
  }

  async function finish() {
    setError(null);
    setBusy(true);
    try {
      if (!(await saveValues())) return;
      await calibration.save({ notes: notes.trim(), accept_verdict: props.acceptVerdict, pattern: props.pattern });
      setNotice(de ? `Gespeichert – „${material.name}“ ist kalibriert.` : `Saved – "${material.name}" is calibrated.`);
      props.onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const input = (label: string, current: string, set: (v: string) => void) => (
    <label className="lc-field">
      <span>{label}</span>
      <input type="text" inputMode="numeric" value={current} onChange={(e) => set(e.target.value)} />
    </label>
  );

  return (
    <div className="lc-step-finish">
      <div className="lc-form-grid">
        {input(de ? `Schwärzung (leer = Grundeinstellung ${baseline.darkness})` : `Darkness (empty = baseline ${baseline.darkness})`, darkness, setDarkness)}
        {input(de ? `Geschwindigkeit (leer = Grundeinstellung ${baseline.speed_ips})` : `Speed (empty = baseline ${baseline.speed_ips})`, speed, setSpeed)}
        {input(de ? `Stopp-Position in mm (leer = Grundeinstellung ${baseline.stop_mm})` : `Stop position in mm (empty = baseline ${baseline.stop_mm})`, stop, setStop)}
      </div>
      {bad && <p className="lc-field-error">{de ? "Bitte ganze Zahlen eingeben" : "Please enter whole numbers"}</p>}
      {effective.darkness > 12 && (
        <p className="lc-warn">
          ⚠ {de ? "WAGO Smart Script warnt ab Schwärzung 12, WAGO ab 14 – das Farbband kann beschädigt werden." : "WAGO Smart Script warns above darkness 12, WAGO from 14 – the ribbon can be damaged."}
        </p>
      )}
      {effective.speed > 2 && (
        <p className="lc-warn">⚠ {de ? "WAGO empfiehlt Geschwindigkeit 2 (50,8 mm/s)." : "WAGO recommends speed 2 (50.8 mm/s)."}</p>
      )}
      {material.pattern_supported && (
        <div className="lc-actions">
          <button type="button" className="werkstatt-action-btn lc-btn" onClick={() => void testPrint()} disabled={busy || calibration.busy === "pattern"}>
            {de ? "Probedruck" : "Test print"}
          </button>
        </div>
      )}
      <label className="lc-field">
        <span>{de ? "Notiz (optional, max. 200 Zeichen)" : "Note (optional, max. 200 characters)"}</span>
        <textarea maxLength={200} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>

      <div className="lc-info">
        <p className="lc-intro">
          <b>{props.verdict?.title ?? (de ? "Kein Ergebnis" : "No result")}</b>
        </p>
        {props.offsetSummary.map((line) => (
          <p key={line} className="lc-small">
            {line}
          </p>
        ))}
        <p className="lc-small">
          {de
            ? `Druckwerte: Schwärzung ${effective.darkness} · Geschwindigkeit ${effective.speed} · Stopp ${effective.stop} mm`
            : `Print values: darkness ${effective.darkness} · speed ${effective.speed} · stop ${effective.stop} mm`}
        </p>
      </div>

      {error !== null && (
        <p className="lc-error" role="alert">
          {errorText(error)}
        </p>
      )}
      <div className="lc-actions">
        <button type="button" className="werkstatt-action-btn werkstatt-action-btn--primary lc-btn" onClick={() => void finish()} disabled={busy || bad}>
          {de ? "Speichern" : "Save"}
        </button>
      </div>
      {dialog && <ConfirmFeedDialog variant="pattern" material={material} onConfirm={() => void printPattern()} onCancel={() => setDialog(false)} de={de} />}
    </div>
  );
}
