/**
 * MaschineBearbeitenModal — correct a machine's master data.
 *
 * Everything here is a fact about the object that was wrong or has changed:
 * a mistyped serial, a tool that moved shelves, a drill that went for repair,
 * an inspection cycle the supplier revised. None of it is custody — handing a
 * machine out and taking it back go through book/return, which write the
 * ledger. Editing must never be a back door around that, so `status` here
 * deliberately does NOT offer "ausgegeben": you cannot give a machine to
 * somebody by editing a dropdown.
 *
 * The machine number is shown but never editable. It is printed on a label
 * stuck to the tool, and changing it would orphan every scan of that label.
 */
import { useEffect, useMemo, useState } from "react";

import type { Language } from "../../types";
import type { WerkstattLocation } from "../../types/werkstatt";
import type {
  Machine,
  MachineStatus,
  MachineUpdatePayload,
} from "../../types/werkstattMachines";
import { machineStatusLabel } from "./machineStatus";

/**
 * Statuses settable by hand.
 *
 * `ausgegeben` is missing on purpose — see the module note. A machine is out
 * because somebody booked it out, and the holder plus the ledger entry that
 * proves it cannot be conjured from this form.
 */
const EDITABLE_STATUSES: ReadonlyArray<MachineStatus> = [
  "verfuegbar",
  "wartung",
  "defekt",
  "ausgemustert",
];

export interface MaschineBearbeitenModalProps {
  open: boolean;
  language: Language;
  machine: Machine;
  /** Possible parents — top-level machines only; components cannot nest. */
  parentCandidates: ReadonlyArray<Machine>;
  locations: ReadonlyArray<WerkstattLocation>;
  busy?: boolean;
  onClose: () => void;
  onConfirm: (patch: MachineUpdatePayload) => void;
}

export function MaschineBearbeitenModal({
  open,
  language,
  machine,
  parentCandidates,
  locations,
  busy = false,
  onClose,
  onConfirm,
}: MaschineBearbeitenModalProps) {
  const de = language === "de";

  const [serial, setSerial] = useState("");
  const [parentId, setParentId] = useState<number | null>(null);
  const [locationId, setLocationId] = useState<number | null>(null);
  const [status, setStatus] = useState<MachineStatus>("verfuegbar");
  const [inspectionRequired, setInspectionRequired] = useState(false);
  const [intervalDays, setIntervalDays] = useState("");
  const [notes, setNotes] = useState("");
  const [archived, setArchived] = useState(false);

  // Re-seed from the machine every time the dialog opens, so it always shows
  // what is currently true rather than the last edit that was cancelled.
  useEffect(() => {
    if (!open) return;
    setSerial(machine.serial_number ?? "");
    setParentId(machine.parent_unit_id);
    setLocationId(machine.current_location_id);
    setStatus(machine.status);
    setInspectionRequired(machine.inspection_required);
    setIntervalDays(
      machine.inspection_interval_days != null
        ? String(machine.inspection_interval_days)
        : "",
    );
    setNotes(machine.notes ?? "");
    setArchived(machine.is_archived);
  }, [open, machine]);

  const liveLocations = useMemo(
    () => locations.filter((l) => !l.is_archived || l.id === machine.current_location_id),
    [locations, machine.current_location_id],
  );

  // A machine cannot be its own parent, and its own components cannot become
  // its parent — either would make the tree eat itself.
  const componentIds = useMemo(
    () => new Set(machine.components.map((c) => c.id)),
    [machine.components],
  );
  const parents = useMemo(
    () => parentCandidates.filter((c) => c.id !== machine.id && !componentIds.has(c.id)),
    [parentCandidates, machine.id, componentIds],
  );

  if (!open) return null;

  const isOut = machine.status === "ausgegeben";
  const parsedInterval = Number.parseInt(intervalDays, 10);
  const intervalInvalid =
    inspectionRequired &&
    intervalDays.trim() !== "" &&
    (!Number.isFinite(parsedInterval) || parsedInterval < 1 || parsedInterval > 3650);

  function submit() {
    if (busy || intervalInvalid) return;

    // Send only what actually changed. A PATCH that echoes every field back
    // would overwrite a concurrent booking's status with the value this form
    // was opened with.
    const patch: MachineUpdatePayload = {};
    const trimmedSerial = serial.trim() || null;
    if (trimmedSerial !== (machine.serial_number ?? null)) patch.serial_number = trimmedSerial;
    if (parentId !== machine.parent_unit_id) patch.parent_unit_id = parentId;
    if (locationId !== machine.current_location_id) patch.current_location_id = locationId;
    if (!isOut && status !== machine.status) patch.status = status;
    if (inspectionRequired !== machine.inspection_required) {
      patch.inspection_required = inspectionRequired;
    }
    const nextInterval = inspectionRequired && intervalDays.trim() ? parsedInterval : null;
    if (nextInterval !== machine.inspection_interval_days) {
      patch.inspection_interval_days = nextInterval;
    }
    const trimmedNotes = notes.trim() || null;
    if (trimmedNotes !== (machine.notes ?? null)) patch.notes = trimmedNotes;
    if (archived !== machine.is_archived) patch.is_archived = archived;

    onConfirm(patch);
  }

  return (
    <div className="werkstatt-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="werkstatt-modal"
        role="dialog"
        aria-modal="true"
        aria-label={de ? "Maschine bearbeiten" : "Edit machine"}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="werkstatt-modal-head">
          <div>
            <span className="werkstatt-sub-breadcrumb">
              {de ? "MASCHINE BEARBEITEN" : "EDIT MACHINE"}
            </span>
            <h2 className="werkstatt-modal-title">
              {machine.article_name ?? machine.unit_number}
            </h2>
          </div>
          <button
            type="button"
            className="werkstatt-modal-close"
            onClick={onClose}
            aria-label={de ? "Schließen" : "Close"}
          >
            ✕
          </button>
        </header>

        <div className="werkstatt-modal-body werkstatt-modal-body--stacked">
          <p className="werkstatt-machine-modal-sub">
            <span className="werkstatt-machine-number">{machine.unit_number}</span>
            {" · "}
            {de
              ? "Nummer und Artikel sind fest — sie stehen auf dem Etikett."
              : "Number and article are fixed — they are on the label."}
          </p>

          <div className="werkstatt-modal-form-split">
            <label className="werkstatt-field werkstatt-field--grow">
              <span className="werkstatt-field-label">
                {de ? "Seriennummer" : "Serial number"}
              </span>
              <input
                type="text"
                className="werkstatt-field-input"
                value={serial}
                onChange={(event) => setSerial(event.target.value)}
                placeholder={de ? "vom Typenschild" : "from the nameplate"}
              />
            </label>

            <label className="werkstatt-field werkstatt-field--grow">
              <span className="werkstatt-field-label">{de ? "Status" : "Status"}</span>
              <select
                className="werkstatt-field-select"
                value={status}
                disabled={isOut}
                onChange={(event) => setStatus(event.target.value as MachineStatus)}
              >
                {isOut && (
                  <option value="ausgegeben">
                    {machineStatusLabel("ausgegeben", language)}
                  </option>
                )}
                {EDITABLE_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {machineStatusLabel(value, language)}
                  </option>
                ))}
              </select>
              {isOut && (
                <span className="werkstatt-field-hint">
                  {de
                    ? "Maschine ist ausgegeben — Status ändert sich beim Zurückbuchen."
                    : "Machine is checked out — the status changes when it is booked back in."}
                </span>
              )}
            </label>
          </div>

          <div className="werkstatt-modal-form-split">
            <label className="werkstatt-field werkstatt-field--grow">
              <span className="werkstatt-field-label">{de ? "Lagerort" : "Location"}</span>
              <select
                className="werkstatt-field-select"
                value={locationId ?? ""}
                onChange={(event) =>
                  setLocationId(event.target.value ? Number(event.target.value) : null)
                }
              >
                <option value="">{de ? "— keiner —" : "— none —"}</option>
                {liveLocations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="werkstatt-field werkstatt-field--grow">
              <span className="werkstatt-field-label">
                {de ? "Gehört zu" : "Belongs to"}
              </span>
              <select
                className="werkstatt-field-select"
                value={parentId ?? ""}
                onChange={(event) =>
                  setParentId(event.target.value ? Number(event.target.value) : null)
                }
              >
                <option value="">
                  {de ? "— eigenständige Maschine —" : "— standalone machine —"}
                </option>
                {parents.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.unit_number} · {candidate.article_name ?? ""}
                  </option>
                ))}
              </select>
              {machine.components.length > 0 && (
                <span className="werkstatt-field-hint">
                  {de
                    ? `Hat ${machine.components.length} Komponente(n) und kann daher nicht selbst zugeordnet werden.`
                    : `Has ${machine.components.length} component(s), so it cannot become a component itself.`}
                </span>
              )}
            </label>
          </div>

          <label className="werkstatt-machine-check">
            <input
              type="checkbox"
              checked={inspectionRequired}
              onChange={(event) => setInspectionRequired(event.target.checked)}
            />
            <span>
              {de
                ? "Wiederkehrende Prüfung (DGUV3 / BG-Prüfung)"
                : "Recurring inspection (DGUV3)"}
            </span>
          </label>

          {inspectionRequired && (
            <label className="werkstatt-field">
              <span className="werkstatt-field-label">
                {de ? "Intervall (Tage)" : "Interval (days)"}
              </span>
              <input
                type="number"
                className="werkstatt-field-input"
                min={1}
                max={3650}
                value={intervalDays}
                onChange={(event) => setIntervalDays(event.target.value)}
                placeholder="365"
              />
              <span
                className={`werkstatt-field-hint${
                  intervalInvalid ? " werkstatt-machine-hint--warn" : ""
                }`}
              >
                {intervalInvalid
                  ? de
                    ? "1 bis 3650 Tage."
                    : "1 to 3650 days."
                  : de
                    ? "Ändern verschiebt den nächsten Prüftermin ab der letzten Prüfung."
                    : "Changing this moves the next due date, counted from the last inspection."}
              </span>
            </label>
          )}

          <label className="werkstatt-field">
            <span className="werkstatt-field-label">{de ? "Notiz" : "Note"}</span>
            <textarea
              className="werkstatt-field-textarea"
              rows={3}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </label>

          <label className="werkstatt-machine-check">
            <input
              type="checkbox"
              checked={archived}
              onChange={(event) => setArchived(event.target.checked)}
            />
            <span>{de ? "Archiviert (aus dem Register nehmen)" : "Archived (hide from the register)"}</span>
          </label>
          {archived && !machine.is_archived && (
            <p className="werkstatt-field-hint">
              {de
                ? "Die Maschinen-Nummer bleibt vergeben — ein altes Etikett findet die Maschine weiterhin."
                : "The machine number stays taken — an old label still resolves to this machine."}
            </p>
          )}
        </div>

        <footer className="werkstatt-modal-foot werkstatt-modal-foot--right">
          <div className="werkstatt-modal-foot-actions">
            <button type="button" className="werkstatt-action-btn" onClick={onClose}>
              {de ? "Abbrechen" : "Cancel"}
            </button>
            <button
              type="button"
              className="werkstatt-action-btn werkstatt-action-btn--primary"
              onClick={submit}
              disabled={busy || intervalInvalid}
            >
              {busy ? (de ? "Speichere…" : "Saving…") : de ? "Speichern" : "Save"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
