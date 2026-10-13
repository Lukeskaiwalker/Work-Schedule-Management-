/**
 * "Sensor stellen und Material einlegen" — the step where a person stands at
 * the open printer (docs/LABEL_PRINTER_CALIBRATION.md §7.4 step 2, §7.8).
 *
 * The order is the point: roller → sensor carriage → roll → guides → ribbon →
 * lid. The sensor is set BEFORE the media goes in because the media may cover
 * the printed scale (critique M10), so the diagram starts without media and
 * switches to "Mit Material" only once the sensor box is ticked.
 *
 * "Zeiger steht jetzt auf …" is a reading aid only: it draws the "Ist" pointer
 * and says how far to push. It is never sent, never stored and never gates
 * [Weiter] — the checklist does that, and the parent owns the button.
 */
import { useEffect, useState } from "react";

import type { LabelMaterial } from "../../types/labelPrinter";
import {
  checklistItems,
  parseScaleInput,
  scaleShiftText,
  sensorTrack,
  targetText,
  visibleHints,
  type ChecklistKey,
} from "../../utils/labelCalibration";
import { LabelPathSideView } from "./LabelPathSideView";
import { LabelSensorDiagram } from "./LabelSensorDiagram";
import "../../styles/label-calibration.css";

export interface LoadingChecklistProps {
  material: LabelMaterial;
  /** Reports whether every box is ticked; the parent enables its [Weiter]. */
  onReadyChange: (ready: boolean) => void;
  de?: boolean;
}

export function LoadingChecklist({ material, onReadyChange, de = true }: LoadingChecklistProps) {
  const [checked, setChecked] = useState<Partial<Record<ChecklistKey, boolean>>>({});
  const [view, setView] = useState<"sensor" | "loaded">("sensor");
  const [current, setCurrent] = useState("");

  const items = checklistItems(material, de);
  const ready = items.every((item) => checked[item.key]);
  useEffect(() => {
    onReadyChange(ready);
  }, [ready, onReadyChange]);

  const typed = current.trim() !== "";
  const actual = typed ? parseScaleInput(current) : null;
  const track = sensorTrack(material, undefined, de);
  const hints = visibleHints(material);

  function toggle(key: ChecklistKey, value: boolean) {
    setChecked((previous) => ({ ...previous, [key]: value }));
    // Once the carriage is set, the person loads the media: show it drawn.
    if (key === "sensor" && value) setView("loaded");
  }

  return (
    <div className="lc-loading">
      <div className="lc-diagram-area">
        <div className="lc-toggle" role="group" aria-label={de ? "Ansicht" : "View"}>
          <button type="button" aria-pressed={view === "sensor"} onClick={() => setView("sensor")}>
            Sensor
          </button>
          <button type="button" aria-pressed={view === "loaded"} onClick={() => setView("loaded")}>
            {de ? "Mit Material" : "With media"}
          </button>
        </div>
        <div className="lc-diagram-grid">
          <LabelSensorDiagram material={material} state={view} actualScale={actual} de={de} />
          <LabelSensorDiagram material={material} state={view} actualScale={actual} zoom de={de} />
        </div>
        <p className="lc-target-line">{targetText(material, de)}</p>
        <label className="lc-field">
          <span>{de ? "Zeiger steht jetzt auf …" : "Pointer is now at …"}</span>
          <input
            type="text"
            inputMode="decimal"
            placeholder={de ? "z. B. 3,0" : "e.g. 3.0"}
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            autoComplete="off"
          />
        </label>
        {typed && actual !== null && <p className="lc-info">{scaleShiftText(actual, material.sensor_scale, de)}</p>}
        {typed && actual === null && (
          <p className="lc-field-error" role="alert">
            {de ? "Bitte einen Wert zwischen 0,5 und 5,5 eingeben" : "Please enter a value between 0.5 and 5.5"}
          </p>
        )}
        <p className="lc-small">
          {de
            ? "Skala und Sensor-Schlitten nach Foto des Druckers (13.10.2026). Zielposition: WAGO-Handhabungshinweis, auf die Skala Ihres Druckers übertragen (ca.)."
            : "Scale and sensor carriage after a photo of the printer (13.10.2026). Target position: WAGO handling sheet, transferred to your printer's scale (approx.)."}
        </p>
        <details className="lc-details">
          <summary>{de ? "Materialweg (Seitenansicht)" : "Media path (side view)"}</summary>
          <LabelPathSideView material={material} de={de} />
        </details>
      </div>

      <h4 className="lc-subhead">{de ? "In dieser Reihenfolge:" : "In this order:"}</h4>
      <ol className="lc-checklist">
        {items.map((item) => (
          <li key={item.key}>
            <label className="lc-check">
              <input
                type="checkbox"
                checked={!!checked[item.key]}
                onChange={(event) => toggle(item.key, event.target.checked)}
              />
              <span>{item.text}</span>
            </label>
            {item.info && <p className="lc-info lc-check-info">ℹ {item.info}</p>}
          </li>
        ))}
      </ol>

      <ul className="lc-list lc-hints">
        <li className="lc-small">ℹ {track.text}</li>
        {hints.map((hint) => (
          <li key={`${hint.topic}-${hint.text}`} className="lc-small">
            ℹ {hint.text}
          </li>
        ))}
      </ul>
      <p className="lc-small">{de ? "Einschätzung von SMPL, keine WAGO-Angabe." : "SMPL's estimate, not a WAGO statement."}</p>
    </div>
  );
}
