/**
 * "Einrichtung abbrechen?" (docs/LABEL_PRINTER_CALIBRATION.md §7.4, §7.6).
 *
 * Cancelling does not undo anything on the printer — the settings that were
 * sent stay there — so the dialog names exactly what has already happened
 * (critique H3): a material selected, settings transferred, a measurement that
 * will not be saved. The wizard adds the offsets it already saved.
 *
 * While the printer may still be feeding (`feed`), closing the sheet would take
 * the only on-screen stop instruction with it, so the dialog repeats it. While
 * the poll still reports a running sense, [Einrichtung beenden] waits: ending
 * frees the lock, and a workshop print shipped mid-sense would land in the
 * measurement. The poll is bounded by the server's sense timeout (45 s / 120 s),
 * so the wait is too. Without a poll (silent STATUS) nothing would ever unlock
 * the button, so it stays usable there.
 */
import { useEffect, useId, useRef } from "react";

import type { CalibrationSession } from "../../types/labelPrinter";
import { feedStopHint } from "../../utils/labelCalibration";
import type { FeedState } from "./useCalibrationSession";
import "../../styles/label-calibration.css";

export interface CancelCalibrationDialogProps {
  session: CalibrationSession;
  materialName: string;
  /** Extra line, e.g. offsets the wizard already saved. */
  extra?: string | null;
  /** Whether the printer may still be moving media (`useCalibrationSession().feed`). */
  feed?: FeedState;
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

function feedText(feed: Exclude<FeedState, null>, de: boolean): string {
  if (feed === "measuring") {
    return de ? "Der Drucker misst gerade und kann dabei noch Material einziehen." : "The printer is measuring and may still be feeding media.";
  }
  return de ? "Möglicherweise zieht der Drucker noch Material ein." : "The printer may still be feeding media.";
}

export function CancelCalibrationDialog({ session, materialName, extra, feed = null, onEnd, onContinue, de = true }: CancelCalibrationDialogProps) {
  const titleId = useId();
  const waitId = useId();
  const continueRef = useRef<HTMLButtonElement>(null);
  const waiting = feed === "measuring";
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
          {feed && (
            <>
              <p className="lc-warn">⚠ {feedText(feed, de)}</p>
              <p className="lc-warn">⚠ {feedStopHint(de)}</p>
            </>
          )}
          <p className="lc-intro">{stateText(session, materialName, de)}</p>
          {extra && <p className="lc-intro">{extra}</p>}
          {waiting && (
            <p className="lc-small" id={waitId}>
              {de
                ? "„Einrichtung beenden“ geht, sobald das Einmessen abgeschlossen ist – bis dahin bleibt der Drucker für andere Drucke gesperrt."
                : "\"End the setup\" is possible once sensing has finished – until then the printer stays locked for other prints."}
            </p>
          )}
        </div>
        <footer className="werkstatt-modal-foot werkstatt-modal-foot--right">
          <div className="werkstatt-modal-foot-actions">
            <button
              type="button"
              className="werkstatt-action-btn lc-btn"
              onClick={onEnd}
              disabled={waiting}
              aria-describedby={waiting ? waitId : undefined}
            >
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
