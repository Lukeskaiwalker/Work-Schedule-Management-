import { useEffect, useState } from "react";

/**
 * LocationFormModal — create / edit a Werkstatt location. Handles 4 location
 * types via radio cards:
 *   - hall      (main halls: "Halle 1 — Hauptwerkstatt")
 *   - shelf     (children of a hall, e.g. "Regal A-01")
 *   - vehicle   (mobile storage: "Fahrzeug 01 — Sprinter")
 *   - external  (off-site: "Kunde XYZ Baustelle")
 *
 * Pure presenter — host performs the mutation.
 */

export type LocationKind = "hall" | "shelf" | "vehicle" | "external";

export type LocationStatus = "open" | "closed" | "on_route" | "in_workshop";

export type LocationFormMode = "create" | "edit";

export interface LocationFormPayload {
  id: string | null;
  name: string;
  kind: LocationKind;
  status: LocationStatus;
  parent_id: string | null;
  address: string;
  notes: string;
}

/** Which statuses make sense for a given kind.
 *  - hall / external: accessible vs closed
 *  - vehicle: where the vehicle physically is right now
 *  - shelf: n/a (a shelf inherits from its parent hall)  */
export function validStatusesForKind(kind: LocationKind): ReadonlyArray<LocationStatus> {
  if (kind === "vehicle") return ["in_workshop", "on_route"];
  if (kind === "shelf") return [];
  return ["open", "closed"];
}

/** Default status when a kind is first picked. */
export function defaultStatusForKind(kind: LocationKind): LocationStatus {
  if (kind === "vehicle") return "in_workshop";
  return "open";
}

/** i18n labels. Kept with the type so row-components + modals stay in sync. */
export function statusLabel(status: LocationStatus, de: boolean): string {
  if (de) {
    if (status === "open") return "Geöffnet";
    if (status === "closed") return "Geschlossen";
    if (status === "on_route") return "Unterwegs";
    return "In Werkstatt";
  }
  if (status === "open") return "Open";
  if (status === "closed") return "Closed";
  if (status === "on_route") return "On route";
  return "In workshop";
}

export interface LocationFormModalProps {
  open: boolean;
  mode: LocationFormMode;
  initial: LocationFormPayload;
  /** Halls available as parent for shelves. Usually filtered by the host. */
  parentOptions: ReadonlyArray<{ id: string; name: string }>;
  language: "de" | "en";
  onClose: () => void;
  onSave: (payload: LocationFormPayload) => void;
  onArchive?: () => void;
}

const KIND_DEFS: ReadonlyArray<{
  key: LocationKind;
  label_de: string;
  label_en: string;
  hint_de: string;
  hint_en: string;
}> = [
  {
    key: "hall",
    label_de: "Halle",
    label_en: "Hall",
    hint_de: "Fester Lagerort mit Adresse",
    hint_en: "Fixed location with address",
  },
  {
    key: "shelf",
    label_de: "Regal",
    label_en: "Shelf",
    hint_de: "Platz innerhalb einer Halle",
    hint_en: "Slot inside a hall",
  },
  {
    key: "vehicle",
    label_de: "Fahrzeug",
    label_en: "Vehicle",
    hint_de: "Mobiler Lagerort",
    hint_en: "Mobile storage",
  },
  {
    key: "external",
    label_de: "Extern",
    label_en: "External",
    hint_de: "Werkstatt oder Lager außerhalb",
    hint_en: "Off-site storage",
  },
];

export function LocationFormModal({
  open,
  mode,
  initial,
  parentOptions,
  language,
  onClose,
  onSave,
  onArchive,
}: LocationFormModalProps) {
  const [name, setName] = useState(initial.name);
  const [kind, setKind] = useState<LocationKind>(initial.kind);
  const [status, setStatus] = useState<LocationStatus>(initial.status);
  const [parentId, setParentId] = useState<string | null>(initial.parent_id);
  const [address, setAddress] = useState(initial.address);
  const [notes, setNotes] = useState(initial.notes);

  useEffect(() => {
    setName(initial.name);
    setKind(initial.kind);
    setStatus(initial.status);
    setParentId(initial.parent_id);
    setAddress(initial.address);
    setNotes(initial.notes);
  }, [
    initial.id, initial.name, initial.kind, initial.status,
    initial.parent_id, initial.address, initial.notes,
  ]);

  // When the kind flips, reset derived fields that no longer apply:
  //  - shelves have a parent; everything else doesn't
  //  - status options vary by kind; snap to a default if the current one is
  //    no longer valid for the new kind (e.g. vehicle → hall)
  useEffect(() => {
    if (kind !== "shelf") setParentId(null);
    const allowed = validStatusesForKind(kind);
    setStatus((prev) =>
      allowed.length === 0 || allowed.includes(prev) ? prev : defaultStatusForKind(kind),
    );
  }, [kind]);

  if (!open) return null;

  const de = language === "de";
  const trimmedName = name.trim();
  const canSave =
    trimmedName.length > 0 &&
    (kind !== "shelf" || parentId !== null);

  function handleSave() {
    if (!canSave) return;
    onSave({
      id: initial.id,
      name: trimmedName,
      kind,
      status,
      parent_id: kind === "shelf" ? parentId : null,
      address: address.trim(),
      notes: notes.trim(),
    });
  }

  const statusOptions = validStatusesForKind(kind);

  return (
    <div className="werkstatt-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="werkstatt-modal werkstatt-modal--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="loc-form-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="werkstatt-modal-head">
          <div className="werkstatt-modal-title-block">
            <span className="werkstatt-modal-eyebrow">
              {de ? "WERKSTATT · TAXONOMIE" : "WORKSHOP · TAXONOMY"}
            </span>
            <h2 id="loc-form-title" className="werkstatt-modal-title">
              {mode === "create"
                ? (de ? "Neuer Lagerort" : "New location")
                : (de ? "Lagerort bearbeiten" : "Edit location")}
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
          <fieldset className="werkstatt-radio-card-group">
            <legend className="werkstatt-field-label">
              {de ? "Art" : "Kind"}
            </legend>
            <div className="werkstatt-radio-card-grid">
              {KIND_DEFS.map((def) => (
                <label
                  key={def.key}
                  className={`werkstatt-radio-card${kind === def.key ? " werkstatt-radio-card--active" : ""}`}
                >
                  <input
                    type="radio"
                    name="location-kind"
                    value={def.key}
                    checked={kind === def.key}
                    onChange={() => setKind(def.key)}
                  />
                  <span className="werkstatt-radio-card-label">
                    {de ? def.label_de : def.label_en}
                  </span>
                  <span className="werkstatt-radio-card-hint">
                    {de ? def.hint_de : def.hint_en}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="werkstatt-field">
            <span className="werkstatt-field-label">
              {de ? "Bezeichnung" : "Name"} *
            </span>
            <input
              type="text"
              className="werkstatt-field-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={
                kind === "hall"
                  ? (de ? "z. B. Halle 2 — Materiallager" : "e.g. Hall 2 — Stock room")
                  : kind === "shelf"
                  ? (de ? "z. B. Regal B-03" : "e.g. Shelf B-03")
                  : kind === "vehicle"
                  ? (de ? "z. B. Fahrzeug 04 — Crafter" : "e.g. Vehicle 04 — Crafter")
                  : (de ? "z. B. Kunde XYZ Baustelle" : "e.g. Customer XYZ site")
              }
              autoFocus
              maxLength={255}
            />
          </label>

          {kind === "shelf" && (
            <label className="werkstatt-field">
              <span className="werkstatt-field-label">
                {de ? "In Halle" : "Inside hall"} *
              </span>
              <select
                className="werkstatt-field-select"
                value={parentId ?? ""}
                onChange={(event) =>
                  setParentId(event.target.value === "" ? null : event.target.value)
                }
              >
                <option value="" disabled>
                  {de ? "Halle auswählen…" : "Pick a hall…"}
                </option>
                {parentOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {(kind === "hall" || kind === "external") && (
            <label className="werkstatt-field">
              <span className="werkstatt-field-label">
                {de ? "Adresse (optional)" : "Address (optional)"}
              </span>
              <input
                type="text"
                className="werkstatt-field-input"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                placeholder={
                  de ? "Straße, PLZ Ort" : "Street, ZIP city"
                }
                maxLength={500}
              />
            </label>
          )}

          {statusOptions.length > 0 && (
            <fieldset className="werkstatt-field">
              <legend className="werkstatt-field-label">
                {de ? "Aktueller Status" : "Current status"}
              </legend>
              <div className="werkstatt-segmented werkstatt-segmented--fill" role="radiogroup">
                {statusOptions.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    role="radio"
                    aria-checked={status === opt}
                    className={`werkstatt-segmented-btn${status === opt ? " werkstatt-segmented-btn--active" : ""}`}
                    onClick={() => setStatus(opt)}
                  >
                    <span
                      className={`werkstatt-loc-badge-dot werkstatt-loc-status-dot--${opt}`}
                      aria-hidden="true"
                    />
                    {statusLabel(opt, de)}
                  </button>
                ))}
              </div>
              <small className="werkstatt-field-hint">
                {kind === "vehicle"
                  ? (de
                    ? "Wird beim Entnehmen/Zurückgeben automatisch umgeschaltet."
                    : "Flips automatically when tools are checked out / returned.")
                  : (de
                    ? "Auf „Geschlossen“ setzen, wenn der Lagerort vorübergehend nicht zugänglich ist."
                    : "Set to 'Closed' when the location is temporarily inaccessible.")}
              </small>
            </fieldset>
          )}

          <label className="werkstatt-field">
            <span className="werkstatt-field-label">
              {de ? "Notizen (optional)" : "Notes (optional)"}
            </span>
            <textarea
              className="werkstatt-field-textarea"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={3}
              placeholder={
                de
                  ? "Zugang, Öffnungszeiten, besondere Hinweise…"
                  : "Access, hours, special notes…"
              }
            />
          </label>
        </div>

        <footer className="werkstatt-modal-foot">
          {mode === "edit" && onArchive && (
            <button
              type="button"
              className="werkstatt-action-btn werkstatt-action-btn--danger"
              onClick={onArchive}
            >
              {de ? "Archivieren" : "Archive"}
            </button>
          )}
          <div className="werkstatt-modal-foot-actions">
            <button type="button" className="werkstatt-action-btn" onClick={onClose}>
              {de ? "Abbrechen" : "Cancel"}
            </button>
            <button
              type="button"
              className="werkstatt-action-btn werkstatt-action-btn--primary"
              onClick={handleSave}
              disabled={!canSave}
            >
              {mode === "create"
                ? (de ? "Lagerort anlegen" : "Create location")
                : (de ? "Änderungen speichern" : "Save changes")}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
