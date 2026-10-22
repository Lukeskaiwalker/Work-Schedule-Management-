/**
 * The Schrank tab's toolbar (docs/PANEL_ENCLOSURE.md §11): the view switch
 * Offen / Geschlossen / 3D, the stepped 2D zoom (buttons, so nothing needs
 * a pinch with gloves on), "Reihen ordnen" and "Aufbau als PDF".
 *
 * Once the rows follow the cabinet there is nothing to order: the button
 * stays where it is, off, and says "Reihen geordnet" — its label is the
 * reason, because a workshop tablet shows no title tooltip.
 *
 * The PDF stays a link — long-press "in neuem Tab öffnen" keeps working —
 * and carries the in-app viewer opt-out every Verteilerplan PDF link
 * carries; the tab hands in `savedPdfClick(...)` as `onPdfClick`, so a plain
 * tap waits for autosave before the server draws the sheet.
 */
import type { MouseEventHandler } from "react";

import { OWN_OPENER_PROPS } from "../../../utils/openAfterSave";
import { ENCLOSURE_ZOOM_STEPS, clampZoomStep } from "./enclosureFrontLayout";
import "../../../styles/schaltplan-enclosure.css";

export type EnclosureViewMode = "open" | "closed" | "3d";

export interface EnclosureToolbarProps {
  view: EnclosureViewMode;
  onViewChange: (view: EnclosureViewMode) => void;
  /** Index into ENCLOSURE_ZOOM_STEPS. */
  zoomStep: number;
  onZoomStepChange: (step: number) => void;
  /** `orderRowsPhysically`; null hides the button (read-only board). */
  onOrderRows: (() => void) | null;
  /** The rows already follow the cabinet (no `encl.row_order` finding): the button is off and reads "Reihen geordnet". */
  rowsInOrder: boolean;
  /** `aufbauPdfUrl(panel.id)`. */
  pdfHref: string;
  /** `savedPdfClick(pdfHref, settleSaves, report, "Aufbau")`. */
  onPdfClick: MouseEventHandler<HTMLAnchorElement>;
}

const VIEWS: readonly { id: EnclosureViewMode; label: string }[] = [
  { id: "open", label: "Offen" },
  { id: "closed", label: "Geschlossen" },
  { id: "3d", label: "3D" },
];

function ViewSwitch({ view, onViewChange }: Pick<EnclosureToolbarProps, "view" | "onViewChange">) {
  return (
    <div className="sp-encl-views" role="group" aria-label="Ansicht">
      {VIEWS.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className={`sp-encl-view${entry.id === view ? " is-on" : ""}`}
          aria-pressed={entry.id === view}
          onClick={() => onViewChange(entry.id)}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}

function ZoomButtons({ zoomStep, onZoomStepChange }: Pick<EnclosureToolbarProps, "zoomStep" | "onZoomStepChange">) {
  const step = clampZoomStep(zoomStep);
  const last = ENCLOSURE_ZOOM_STEPS.length - 1;
  return (
    <div className="sp-encl-zoom" role="group" aria-label="Zoom">
      <button
        type="button"
        className="sp-encl-tool sp-encl-tool--icon"
        aria-label="Verkleinern"
        title="Verkleinern"
        disabled={step <= 0}
        onClick={() => onZoomStepChange(step - 1)}
      >
        <span aria-hidden="true">−</span>
      </button>
      <span className="sp-encl-zoom-step" aria-live="polite">{`${step + 1} / ${ENCLOSURE_ZOOM_STEPS.length}`}</span>
      <button
        type="button"
        className="sp-encl-tool sp-encl-tool--icon"
        aria-label="Vergrößern"
        title="Vergrößern"
        disabled={step >= last}
        onClick={() => onZoomStepChange(step + 1)}
      >
        <span aria-hidden="true">+</span>
      </button>
    </div>
  );
}

export function EnclosureToolbar({
  view,
  onViewChange,
  zoomStep,
  onZoomStepChange,
  onOrderRows,
  rowsInOrder,
  pdfHref,
  onPdfClick,
}: EnclosureToolbarProps) {
  return (
    <div className="sp-encl-toolbar">
      <ViewSwitch view={view} onViewChange={onViewChange} />
      {view !== "3d" && <ZoomButtons zoomStep={zoomStep} onZoomStepChange={onZoomStepChange} />}
      <div className="sp-encl-toolbar-actions">
        {onOrderRows && (
          <button
            type="button"
            className="sp-encl-tool"
            disabled={rowsInOrder}
            title={rowsInOrder ? undefined : "Reihen in die Reihenfolge des Schranks bringen — jeder Stromkreis behält seine Einspeisung."}
            onClick={onOrderRows}
          >
            {rowsInOrder ? "Reihen geordnet" : "Reihen ordnen"}
          </button>
        )}
        {/* OWN_OPENER_PROPS: on the app surfaces the in-app viewer must not open it before the saves settled. */}
        <a className="sp-encl-tool sp-encl-tool--pdf" href={pdfHref} target="_blank" rel="noreferrer" {...OWN_OPENER_PROPS} onClick={onPdfClick}>
          Aufbau als PDF
        </a>
      </div>
    </div>
  );
}
