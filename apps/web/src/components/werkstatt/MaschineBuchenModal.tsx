/**
 * MaschineBuchenModal — hand a machine to a person, a vehicle, or both.
 *
 * The default is one tap: "für heute", to the person who opened the dialog.
 * That is the overwhelmingly common case ("I am taking this now and bringing it
 * back tonight"), and making it the default is the difference between the log
 * being kept and the log being skipped because it asked four questions.
 *
 * Everything else — a different person, a van, a longer period, a note — is
 * available but never in the way.
 */
import { useEffect, useMemo, useState } from "react";

import type { AssignableUser, Language } from "../../types";
import type { WerkstattLocation } from "../../types/werkstatt";
import type { Machine, MachineBookPayload } from "../../types/werkstattMachines";
import { localDateTimeInputToIso } from "../../utils/dates";

/** How long the machine is out for. */
type PeriodMode = "today" | "until" | "open";

export interface MaschineBuchenModalProps {
  open: boolean;
  language: Language;
  machine: Machine;
  users: ReadonlyArray<AssignableUser>;
  locations: ReadonlyArray<WerkstattLocation>;
  /** Id of the signed-in user — pre-selected, because they are usually the one taking it. */
  currentUserId: number | null;
  busy?: boolean;
  onClose: () => void;
  onConfirm: (payload: MachineBookPayload) => void;
}

/** Two hours from now, rounded to the next full hour — a sane "bis" default. */
function defaultUntilInput(): string {
  const target = new Date();
  target.setHours(target.getHours() + 2, 0, 0, 0);
  const offset = target.getTimezoneOffset();
  return new Date(target.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

export function MaschineBuchenModal({
  open,
  language,
  machine,
  users,
  locations,
  currentUserId,
  busy = false,
  onClose,
  onConfirm,
}: MaschineBuchenModalProps) {
  const de = language === "de";

  const [holderId, setHolderId] = useState<number | null>(currentUserId);
  const [locationId, setLocationId] = useState<number | null>(null);
  const [period, setPeriod] = useState<PeriodMode>("today");
  const [until, setUntil] = useState<string>(defaultUntilInput);
  const [notes, setNotes] = useState("");

  // Re-arm on every open. A dialog that reopens holding the previous booking's
  // person and note would quietly attribute the next machine to the wrong crew.
  useEffect(() => {
    if (!open) return;
    setHolderId(currentUserId);
    setLocationId(null);
    setPeriod("today");
    setUntil(defaultUntilInput());
    setNotes("");
  }, [open, currentUserId, machine.id]);

  /** Vehicles first — "book it to the van" is the second-most common action. */
  const { vehicles, otherLocations } = useMemo(() => {
    const live = locations.filter((location) => !location.is_archived);
    return {
      vehicles: live.filter((location) => location.location_type === "vehicle"),
      otherLocations: live.filter((location) => location.location_type !== "vehicle"),
    };
  }, [locations]);

  const cascadeCount = machine.components.filter(
    (component) => component.status === "verfuegbar",
  ).length;

  if (!open) return null;

  const targetMissing = holderId === null && locationId === null;
  const untilInvalid = period === "until" && !until;

  function submit() {
    if (targetMissing || untilInvalid || busy) return;
    onConfirm({
      holder_user_id: holderId,
      to_location_id: locationId,
      for_today: period === "today",
      // `for_today` is resolved server-side to the end of the workshop's local
      // day; sending our own timestamp for it would put the client's clock in
      // charge of what "today" means.
      booked_until: period === "until" ? localDateTimeInputToIso(until) : null,
      notes: notes.trim() || null,
    });
  }

  return (
    <div className="werkstatt-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="werkstatt-modal werkstatt-modal--narrow"
        role="dialog"
        aria-modal="true"
        aria-label={de ? "Maschine ausgeben" : "Check machine out"}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="werkstatt-modal-head">
          <div>
            <span className="werkstatt-sub-breadcrumb">
              {de ? "MASCHINE AUSGEBEN" : "CHECK OUT MACHINE"}
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
            {machine.serial_number ? ` · SN ${machine.serial_number}` : ""}
          </p>

          <label className="werkstatt-field">
            <span className="werkstatt-field-label">{de ? "An Person" : "To person"}</span>
            <select
              className="werkstatt-field-select"
              value={holderId ?? ""}
              onChange={(event) =>
                setHolderId(event.target.value ? Number(event.target.value) : null)
              }
            >
              <option value="">{de ? "— niemand —" : "— nobody —"}</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.display_name || user.full_name}
                </option>
              ))}
            </select>
          </label>

          <label className="werkstatt-field">
            <span className="werkstatt-field-label">
              {de ? "Auf Fahrzeug / Lagerort" : "To vehicle / location"}
            </span>
            <select
              className="werkstatt-field-select"
              value={locationId ?? ""}
              onChange={(event) =>
                setLocationId(event.target.value ? Number(event.target.value) : null)
              }
            >
              <option value="">{de ? "— unverändert —" : "— unchanged —"}</option>
              {vehicles.length > 0 && (
                <optgroup label={de ? "Fahrzeuge" : "Vehicles"}>
                  {vehicles.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {otherLocations.length > 0 && (
                <optgroup label={de ? "Weitere Lagerorte" : "Other locations"}>
                  {otherLocations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>

          <div className="werkstatt-field">
            <span className="werkstatt-field-label">{de ? "Zeitraum" : "Period"}</span>
            <div className="werkstatt-segmented werkstatt-segmented--fill" role="tablist">
              {(
                [
                  { key: "today", de: "Für heute", en: "For today" },
                  { key: "until", de: "Bis…", en: "Until…" },
                  { key: "open", de: "Offen", en: "Open-ended" },
                ] as const
              ).map((option) => (
                <button
                  key={option.key}
                  type="button"
                  role="tab"
                  aria-selected={period === option.key}
                  className={`werkstatt-segmented-btn${
                    period === option.key ? " werkstatt-segmented-btn--active" : ""
                  }`}
                  onClick={() => setPeriod(option.key)}
                >
                  {de ? option.de : option.en}
                </button>
              ))}
            </div>
          </div>

          {period === "until" && (
            <label className="werkstatt-field">
              <span className="werkstatt-field-label">
                {de ? "Zurück bis" : "Back by"}
              </span>
              <input
                type="datetime-local"
                className="werkstatt-field-input"
                value={until}
                onChange={(event) => setUntil(event.target.value)}
              />
            </label>
          )}

          {period === "open" && (
            <p className="werkstatt-field-hint">
              {de
                ? "Ohne Rückgabetermin taucht die Maschine nie in „Überfällig“ auf."
                : "Without a return date the machine never shows up as overdue."}
            </p>
          )}

          <label className="werkstatt-field">
            <span className="werkstatt-field-label">
              {de ? "Notiz (optional)" : "Note (optional)"}
            </span>
            <textarea
              className="werkstatt-field-textarea"
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder={de ? "z. B. Baustelle Meier" : "e.g. Meier site"}
            />
          </label>

          {cascadeCount > 0 && (
            <p className="werkstatt-field-hint werkstatt-machine-cascade-hint">
              {de
                ? `${cascadeCount} Komponente(n) werden mit ausgebucht — Akkus, Ladegerät, Koffer.`
                : `${cascadeCount} component(s) go out with it — batteries, charger, case.`}
            </p>
          )}

          {targetMissing && (
            <p className="werkstatt-field-hint werkstatt-machine-hint--warn">
              {de
                ? "Bitte eine Person oder ein Fahrzeug auswählen."
                : "Pick a person or a vehicle."}
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
              disabled={targetMissing || untilInvalid || busy}
            >
              {busy ? (de ? "Buche…" : "Booking…") : de ? "Ausgeben" : "Check out"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
