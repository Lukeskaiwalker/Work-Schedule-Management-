/**
 * Step 1 of the quick flow: which material is (or is about to be) in the
 * printer (docs/LABEL_PRINTER_CALIBRATION.md §7.4).
 *
 * The printer can sense gaps, not identity — this choice is the software's
 * only truth about the roll, so every card shows what a person checks against
 * the box: name, part number, size, and when it was last calibrated.
 *
 * When someone else holds the printer the banner names them and the time from
 * `since`/`acquired_at`, formatted locally — the server's message text is never
 * parsed for it.
 */
import type { LabelMaterial } from "../../types/labelPrinter";
import { dimensionLabel, formatLocalTime } from "../../utils/labelCalibration";
import { CalibrationChip } from "./CalibrationChip";
import "../../styles/label-calibration.css";

export interface LockHolder {
  name: string;
  since: string;
}

export interface MaterialPickStepProps {
  materials: LabelMaterial[];
  activeId: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  holder: LockHolder | null;
  /** Offered only to `settings:manage` (the server refuses staff takeovers). */
  onTakeover: (() => void) | null;
  busy?: boolean;
  de?: boolean;
}

/** "Der Etikettendrucker wird gerade von … eingerichtet (seit HH:MM)." with the takeover offer. */
export function LockBanner({
  holder,
  onTakeover,
  busy = false,
  de = true,
}: {
  holder: LockHolder;
  onTakeover: (() => void) | null;
  busy?: boolean;
  de?: boolean;
}) {
  return (
    <div className="lc-warn" role="status">
      <p className="lc-intro">
        {de
          ? `Der Etikettendrucker wird gerade von ${holder.name} eingerichtet (seit ${formatLocalTime(holder.since)}).`
          : `The label printer is being set up by ${holder.name} (since ${formatLocalTime(holder.since)}).`}
      </p>
      {onTakeover && (
        <div className="lc-actions">
          <button type="button" className="werkstatt-action-btn lc-btn" onClick={onTakeover} disabled={busy}>
            {de ? "Einrichtung übernehmen" : "Take over the setup"}
          </button>
        </div>
      )}
    </div>
  );
}

export function MaterialPickStep({
  materials,
  activeId,
  selectedId,
  onSelect,
  holder,
  onTakeover,
  busy = false,
  de = true,
}: MaterialPickStepProps) {
  return (
    <div className="lc-pick">
      <p className="lc-intro">
        {de
          ? "Wähle das Material, das jetzt im Drucker liegt oder gleich eingelegt wird."
          : "Pick the material that is in the printer now or is about to be loaded."}
      </p>
      {holder && <LockBanner holder={holder} onTakeover={onTakeover} busy={busy} de={de} />}
      <fieldset className="lc-cards">
        <legend className="lc-sr">{de ? "Material" : "Material"}</legend>
        {materials.map((material) => (
          <label key={material.id} className="lc-card">
            <input
              type="radio"
              name="lc-material"
              value={material.id}
              checked={selectedId === material.id}
              onChange={() => onSelect(material.id)}
            />
            <span className="lc-card-body">
              <span className="lc-card-name">{material.name}</span>
              <span className="lc-card-meta">
                {material.part_no ? `${material.part_no} · ` : ""}
                {dimensionLabel(material, de)}
              </span>
              <span className="lc-card-tags">
                <CalibrationChip calibration={material.calibration} de={de} />
                {material.id === activeId && <span className="lc-badge">{de ? "zurzeit gewählt" : "currently selected"}</span>}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}
