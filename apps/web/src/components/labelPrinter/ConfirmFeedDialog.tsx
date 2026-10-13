/**
 * The one gate in front of everything that moves paper
 * (docs/LABEL_PRINTER_CALIBRATION.md §7.7).
 *
 * Nothing that feeds is called before the person confirms here, and the dialog
 * makes confirming a deliberate act: Abbrechen has the initial focus and Enter
 * never confirms (an auto-sense on continuous stock has no known length limit,
 * so a stray Enter must not start one). The cost hints come from the server and
 * carry their own "Schätzung"/"unbekannt" — they are shown verbatim.
 */
import { useEffect, useId, useRef, type KeyboardEvent } from "react";

import type { LabelMaterial } from "../../types/labelPrinter";
import { feedStopHint } from "../../utils/labelCalibration";
import "../../styles/label-calibration.css";

export type FeedVariant = "command" | "button" | "pattern";

export interface ConfirmFeedDialogProps {
  variant: FeedVariant;
  material: LabelMaterial;
  onConfirm: () => void;
  onCancel: () => void;
  de?: boolean;
}

interface Copy {
  title: string;
  body: string;
  confirm: string;
  stopHint: boolean;
}

function copyFor(variant: FeedVariant, material: LabelMaterial, de: boolean): Copy {
  const name = material.name;
  if (variant === "command") {
    return {
      title: de ? "Material wird eingezogen" : "Media will be fed",
      body: de
        ? `Beim Einmessen zieht der Drucker Material ein – bei „${name}“: ${material.autosense_cost_hint}. Danach liest SMPL das Messergebnis aus.`
        : `Sensing feeds media – for "${name}": ${material.autosense_cost_hint}. SMPL then reads the result.`,
      confirm: de ? "Einziehen lassen" : "Feed",
      stopHint: true,
    };
  }
  if (variant === "button") {
    return {
      title: de ? "Einmessen mit der Kalibriertaste" : "Sense with the calibration button",
      body: de
        ? `Nach „Los“ die Kalibriertaste auf der Rückseite 1 Sekunde gedrückt halten. Der Drucker zieht dabei Material ein – bei „${name}“: ${material.autosense_cost_hint}.`
        : `After "Go", hold the calibration button on the back for 1 second. The printer feeds media – for "${name}": ${material.autosense_cost_hint}.`,
      confirm: de ? "Los" : "Go",
      stopHint: true,
    };
  }
  return {
    title: de ? "Messmuster drucken" : "Print measuring pattern",
    body: de
      ? `SMPL druckt ein Messmuster auf „${name}“: ${material.pattern_cost_hint}.`
      : `SMPL prints a measuring pattern on "${name}": ${material.pattern_cost_hint}.`,
    confirm: de ? "Drucken" : "Print",
    stopHint: false,
  };
}

export function ConfirmFeedDialog({ variant, material, onConfirm, onCancel, de = true }: ConfirmFeedDialogProps) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const copy = copyFor(variant, material, de);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCancel();
    }
  }

  function blockEnter(event: KeyboardEvent<HTMLButtonElement>) {
    // Space and a click still confirm; Enter is the key people press by reflex.
    if (event.key === "Enter") event.preventDefault();
  }

  return (
    <div className="werkstatt-modal-backdrop lc-scope" role="presentation">
      <div
        className="werkstatt-modal werkstatt-modal--narrow lc-feed-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <header className="werkstatt-modal-head">
          <h2 className="werkstatt-modal-title" id={titleId}>
            {copy.title}
          </h2>
        </header>
        <div className="werkstatt-modal-body">
          <p className="lc-intro">{copy.body}</p>
          {copy.stopHint && <p className="lc-warn">⚠ {feedStopHint(de)}</p>}
        </div>
        <footer className="werkstatt-modal-foot werkstatt-modal-foot--right">
          <div className="werkstatt-modal-foot-actions">
            <button type="button" ref={cancelRef} className="werkstatt-action-btn lc-btn" onClick={onCancel}>
              {de ? "Abbrechen" : "Cancel"}
            </button>
            <button
              type="button"
              className="werkstatt-action-btn werkstatt-action-btn--primary lc-btn"
              onClick={onConfirm}
              onKeyDown={blockEnter}
            >
              {copy.confirm}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
