/**
 * "Einrichtung abbrechen?" (docs/LABEL_PRINTER_CALIBRATION.md §7.4, §7.6).
 *
 * Cancelling does not undo anything on the printer — the settings that were
 * sent stay there — so the dialog names exactly what has already happened
 * (critique H3): a material selected, settings transferred, a measurement that
 * will not be saved. The wizard adds the offsets it already saved.
 */
import { useEffect, useId, useRef } from "react";

import type { CalibrationSession } from "../../types/labelPrinter";
import "../../styles/label-calibration.css";

export interface CancelCalibrationDialogProps {
  session: CalibrationSession;
  materialName: string;
  /** Extra line, e.g. offsets the wizard already saved. */
  extra?: string | null;
  onEnd: () => void;
  onContinue: () => void;
  de?: boolean;
}

function stateText(session: CalibrationSession, name: string, de: boolean): string {
  if (session.sensed) {
    return de ? "Die Messung wird nicht gespeichert." : "The measurement will not be saved.";
  }
  if (session.applied) {
    return de
      ? `„${name}“ ist gewählt und die Einstellungen wurden an den Drucker übertragen. Das Einmessen fehlt noch.`
      : `"${name}" is selected and the settings were sent to the printer. Sensing is still missing.`;
  }
  return de
    ? `„${name}“ ist jetzt als eingelegtes Material gewählt. Die Sensor-Einstellung wurde noch nicht übertragen.`
    : `"${name}" is now selected as the loaded material. The sensor setting was not sent yet.`;
}

export function CancelCalibrationDialog({ session, materialName, extra, onEnd, onContinue, de = true }: CancelCalibrationDialogProps) {
  const titleId = useId();
  const continueRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    continueRef.current?.focus();
  }, []);

  return (
    <div className="werkstatt-modal-backdrop lc-scope" role="presentation">
      <div className="werkstatt-modal werkstatt-modal--narrow" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="werkstatt-modal-head">
          <h2 className="werkstatt-modal-title" id={titleId}>
            {de ? "Einrichtung abbrechen?" : "Cancel the setup?"}
          </h2>
        </header>
        <div className="werkstatt-modal-body">
          <p className="lc-intro">{stateText(session, materialName, de)}</p>
          {extra && <p className="lc-intro">{extra}</p>}
        </div>
        <footer className="werkstatt-modal-foot werkstatt-modal-foot--right">
          <div className="werkstatt-modal-foot-actions">
            <button type="button" className="werkstatt-action-btn lc-btn" onClick={onEnd}>
              {de ? "Einrichtung beenden" : "End the setup"}
            </button>
            <button type="button" ref={continueRef} className="werkstatt-action-btn werkstatt-action-btn--primary lc-btn" onClick={onContinue}>
              {de ? "Weiter einrichten" : "Continue the setup"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
