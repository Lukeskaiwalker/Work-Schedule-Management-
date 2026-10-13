/**
 * The frame both calibration flows share: the existing `werkstatt-modal`
 * markup with the step line in the header, [Abbrechen] top right and the
 * step buttons in a footer that stays at the bottom while the body scrolls.
 * Below 640 px it becomes a full-height sheet (label-calibration.css) — the
 * quick flow is used on a phone standing next to the printer.
 *
 * No click-outside close: a stray tap must not drop a running session.
 */
import { useId, type ReactNode } from "react";

import "../../styles/label-calibration.css";

export interface CalibrationSheetFrameProps {
  title: string;
  subtitle: string;
  stepLine: string | null;
  onCancel: () => void;
  footer: ReactNode;
  children: ReactNode;
  de?: boolean;
}

export function CalibrationSheetFrame({ title, subtitle, stepLine, onCancel, footer, children, de = true }: CalibrationSheetFrameProps) {
  const titleId = useId();
  return (
    <div className="werkstatt-modal-backdrop lc-backdrop lc-scope" role="presentation">
      <div className="werkstatt-modal werkstatt-modal--wide lc-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="werkstatt-modal-head">
          <div>
            <p className="lc-sheet-sub">{subtitle}</p>
            <h2 className="werkstatt-modal-title" id={titleId}>
              {title}
            </h2>
            {stepLine && <p className="lc-steps">{stepLine}</p>}
          </div>
          <button type="button" className="werkstatt-action-btn lc-btn" onClick={onCancel}>
            {de ? "Abbrechen" : "Cancel"}
          </button>
        </header>
        <div className="werkstatt-modal-body">{children}</div>
        <footer className="werkstatt-modal-foot">{footer}</footer>
      </div>
    </div>
  );
}
