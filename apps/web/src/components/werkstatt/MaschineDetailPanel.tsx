/**
 * MaschineDetailPanel — everything about one machine on one screen.
 *
 * Deliberately not a modal. A machine's detail view is where somebody stands
 * with the tool in their hand deciding whether to take it, so it has to survive
 * a page refresh, be linkable, and show the custody log without a second click.
 *
 * The two write actions that field staff perform — hand out, hand back — are
 * the first thing in the first column. Registration data (serial, purchase
 * date) is last, because it is read once a year.
 */
import { useState } from "react";

import type { AssignableUser, Language } from "../../types";
import type { WerkstattLocation } from "../../types/werkstatt";
import type {
  Machine,
  MachineComponent,
  MachineInspectionPayload,
  MachineMovement,
  MachineReturnPayload,
  MachineStatus,
} from "../../types/werkstattMachines";
import {
  formatMachineDate,
  formatMachineDateTime,
  machineStatusLabel,
  MACHINE_STATUS_TONES,
  relativeDayLabel,
} from "./machineStatus";

/** Movement types this domain writes, in the words the workshop uses. */
const MOVEMENT_LABELS: Record<string, { de: string; en: string }> = {
  checkout: { de: "Ausgegeben", en: "Checked out" },
  return: { de: "Zurückgegeben", en: "Returned" },
  correction: { de: "Prüfung / Korrektur", en: "Inspection / correction" },
  intake: { de: "Zugang", en: "Intake" },
  repair_out: { de: "Zur Reparatur", en: "To repair" },
  repair_back: { de: "Aus Reparatur", en: "Back from repair" },
};

/** Statuses a machine can come back in. `ausgemustert` is not a return. */
const RETURN_STATUSES: ReadonlyArray<MachineStatus> = ["verfuegbar", "wartung", "defekt"];

export interface MaschineDetailPanelProps {
  machine: Machine;
  history: ReadonlyArray<MachineMovement>;
  language: Language;
  users: ReadonlyArray<AssignableUser>;
  locations: ReadonlyArray<WerkstattLocation>;
  /** `werkstatt:machines_create` (or the werkstatt:manage umbrella). */
  canCreate: boolean;
  /** `werkstatt:machines_edit` (or the werkstatt:manage umbrella). */
  canEdit: boolean;
  busy: boolean;
  onBack: () => void;
  onBook: () => void;
  onEdit: () => void;
  /** "We just bought another one of these" — opens create with this as blueprint. */
  onAddAnother: () => void;
  onReturn: (payload: MachineReturnPayload) => void;
  onInspect: (payload: MachineInspectionPayload) => void;
  onPrintLabel: () => void;
  /** False when the loaded printer material cannot take the full label. */
  grossPrintable: boolean;
  /** German reason shown as tooltip while `grossPrintable` is false. */
  grossHint: string | null;
  /** Adds this machine to the klein-label print queue (4 per sheet). */
  onQueueLabel: () => void;
  onAddComponent: () => void;
  onOpenComponent: (component: MachineComponent) => void;
}

function StatusPill({ status, language }: { status: MachineStatus; language: Language }) {
  return (
    <span className={`werkstatt-machine-pill werkstatt-machine-pill--${MACHINE_STATUS_TONES[status]}`}>
      <span className="werkstatt-machine-pill-dot" aria-hidden="true" />
      {machineStatusLabel(status, language)}
    </span>
  );
}

export function MaschineDetailPanel({
  machine,
  history,
  language,
  users,
  locations,
  canCreate,
  canEdit,
  busy,
  onBack,
  onBook,
  onEdit,
  onAddAnother,
  onReturn,
  onInspect,
  onPrintLabel,
  grossPrintable,
  grossHint,
  onQueueLabel,
  onAddComponent,
  onOpenComponent,
}: MaschineDetailPanelProps) {
  const de = language === "de";

  const [returnStatus, setReturnStatus] = useState<MachineStatus>("verfuegbar");
  const [returnLocationId, setReturnLocationId] = useState<number | null>(null);
  const [returnNotes, setReturnNotes] = useState("");
  const [inspectionPassed, setInspectionPassed] = useState(true);
  const [inspectionNotes, setInspectionNotes] = useState("");

  const isOut = machine.status === "ausgegeben";
  const liveLocations = locations.filter((location) => !location.is_archived);
  const dueLabel = relativeDayLabel(machine.next_inspection_due_at, language);

  function submitReturn() {
    if (busy) return;
    onReturn({
      to_location_id: returnLocationId,
      status: returnStatus,
      notes: returnNotes.trim() || null,
    });
    setReturnNotes("");
  }

  function submitInspection() {
    if (busy) return;
    onInspect({
      passed: inspectionPassed,
      notes: inspectionNotes.trim() || null,
    });
    setInspectionNotes("");
    setInspectionPassed(true);
  }

  return (
    <section className="werkstatt-tab-page werkstatt-machines-page">
      <button type="button" className="werkstatt-card-action kisten-back" onClick={onBack}>
        ← {de ? "Alle Maschinen" : "All machines"}
      </button>

      <header className="werkstatt-sub-head">
        <div className="werkstatt-sub-head-text">
          <span className="werkstatt-sub-breadcrumb">
            {de ? "WERKSTATT › MASCHINEN" : "WORKSHOP › MACHINES"}
          </span>
          <h1 className="werkstatt-sub-title">
            {machine.article_name ?? (de ? "Maschine" : "Machine")}
            <span className="werkstatt-machine-number-badge">{machine.unit_number}</span>
          </h1>
          <p className="werkstatt-sub-subtitle">
            {machine.manufacturer ? `${machine.manufacturer} · ` : ""}
            {machine.serial_number
              ? `SN ${machine.serial_number}`
              : de
                ? "keine Seriennummer"
                : "no serial number"}
          </p>
        </div>
        <div className="werkstatt-sub-actions">
          {machine.is_overdue && (
            <span className="werkstatt-machine-flag werkstatt-machine-flag--overdue">
              {de ? "Überfällig" : "Overdue"}
            </span>
          )}
          {machine.inspection_overdue && (
            <span className="werkstatt-machine-flag werkstatt-machine-flag--inspection">
              {de ? "Prüfung fällig" : "Inspection due"}
            </span>
          )}
          <StatusPill status={machine.status} language={language} />
          {/* The everyday case for a workshop that just took delivery: one more
              of a thing already on the shelf. Sits here rather than only on the
              list, because this screen is where you are when you notice. */}
          {canCreate && (
            <button
              type="button"
              className="werkstatt-action-btn"
              onClick={onAddAnother}
              disabled={busy}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              {de ? "Weitere anlegen" : "Add another"}
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              className="werkstatt-action-btn"
              onClick={onEdit}
              disabled={busy}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                />
                <path d="m14.5 6.5 3 3" stroke="currentColor" strokeWidth="1.8" />
              </svg>
              {de ? "Bearbeiten" : "Edit"}
            </button>
          )}
        </div>
      </header>

      <div className="werkstatt-content-grid">
        <div className="werkstatt-column">
          {/* ── Custody ─────────────────────────────────────────────────── */}
          <article className="werkstatt-card">
            <header className="werkstatt-card-head">
              <div className="werkstatt-card-title-block">
                <h3 className="werkstatt-card-title">{de ? "Ausgabe" : "Custody"}</h3>
                <span className="werkstatt-card-subtitle">
                  {isOut
                    ? de
                      ? "Wer sie hat und bis wann"
                      : "Who has it and until when"
                    : de
                      ? "An eine Person oder ein Fahrzeug ausgeben"
                      : "Hand out to a person or a vehicle"}
                </span>
              </div>
            </header>
            <div className="werkstatt-machine-card-body">
              <dl className="werkstatt-machine-facts">
                <dt>{de ? "Bei" : "With"}</dt>
                <dd>
                  {machine.holder_name ??
                    machine.current_location_name ??
                    (de ? "— Werkstatt —" : "— workshop —")}
                </dd>
                {isOut && (
                  <>
                    <dt>{de ? "Seit" : "Since"}</dt>
                    <dd>{formatMachineDateTime(machine.booked_from, language)}</dd>
                    <dt>{de ? "Zurück bis" : "Back by"}</dt>
                    <dd className={machine.is_overdue ? "werkstatt-machine-fact--late" : undefined}>
                      {machine.booked_until
                        ? `${formatMachineDateTime(machine.booked_until, language)}${
                            machine.is_overdue
                              ? ` · ${relativeDayLabel(machine.booked_until, language) ?? ""}`
                              : ""
                          }`
                        : de
                          ? "offen"
                          : "open-ended"}
                    </dd>
                  </>
                )}
              </dl>

              {isOut ? (
                <div className="werkstatt-machine-return">
                  <div className="werkstatt-modal-form-split">
                    <label className="werkstatt-field werkstatt-field--grow">
                      <span className="werkstatt-field-label">
                        {de ? "Zustand" : "Condition"}
                      </span>
                      <select
                        className="werkstatt-field-select"
                        value={returnStatus}
                        onChange={(event) =>
                          setReturnStatus(event.target.value as MachineStatus)
                        }
                      >
                        {RETURN_STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {machineStatusLabel(status, language)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="werkstatt-field werkstatt-field--grow">
                      <span className="werkstatt-field-label">
                        {de ? "Zurück nach" : "Back to"}
                      </span>
                      <select
                        className="werkstatt-field-select"
                        value={returnLocationId ?? ""}
                        onChange={(event) =>
                          setReturnLocationId(
                            event.target.value ? Number(event.target.value) : null,
                          )
                        }
                      >
                        <option value="">{de ? "— unverändert —" : "— unchanged —"}</option>
                        {liveLocations.map((location) => (
                          <option key={location.id} value={location.id}>
                            {location.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <input
                    type="text"
                    className="werkstatt-field-input"
                    value={returnNotes}
                    onChange={(event) => setReturnNotes(event.target.value)}
                    placeholder={
                      de ? "Notiz, z. B. Akku schwach" : "Note, e.g. battery weak"
                    }
                  />
                  <button
                    type="button"
                    className="werkstatt-action-btn werkstatt-action-btn--primary"
                    onClick={submitReturn}
                    disabled={busy}
                  >
                    {de ? "Zurückbuchen" : "Check back in"}
                  </button>
                  {returnStatus !== "verfuegbar" && (
                    <p className="werkstatt-field-hint werkstatt-machine-hint--warn">
                      {de
                        ? "Als „nicht verfügbar“ zurückgebucht — die Maschine lässt sich dann nicht mehr ausgeben."
                        : "Returned as unavailable — the machine can no longer be checked out."}
                    </p>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  className="werkstatt-action-btn werkstatt-action-btn--primary"
                  onClick={onBook}
                  disabled={busy || machine.status !== "verfuegbar"}
                >
                  {de ? "Ausgeben" : "Check out"}
                </button>
              )}

              {!isOut && machine.status !== "verfuegbar" && (
                <p className="werkstatt-field-hint werkstatt-machine-hint--warn">
                  {de
                    ? `Status „${machineStatusLabel(machine.status, language)}“ — Ausgabe gesperrt.`
                    : `Status "${machineStatusLabel(machine.status, language)}" — checkout blocked.`}
                </p>
              )}
            </div>
          </article>

          {/* ── Components ──────────────────────────────────────────────── */}
          {machine.parent_unit_id === null && (
            <article className="werkstatt-card">
              <header className="werkstatt-card-head">
                <div className="werkstatt-card-title-block">
                  <h3 className="werkstatt-card-title">
                    {de ? "Komponenten" : "Components"} ({machine.components.length})
                  </h3>
                  <span className="werkstatt-card-subtitle">
                    {de
                      ? "Akkus, Ladegerät, Koffer — werden mit ausgebucht"
                      : "Batteries, charger, case — they go out with the machine"}
                  </span>
                </div>
                {/* Adding a component registers a NEW machine under this one,
                    so it is a create grant, not an edit grant. */}
                {canCreate && (
                  <button type="button" className="werkstatt-card-action" onClick={onAddComponent}>
                    + {de ? "Komponente" : "Component"}
                  </button>
                )}
              </header>
              {machine.components.length === 0 ? (
                <div className="werkstatt-machine-card-body">
                  <p className="muted">
                    {de ? "Keine Komponenten erfasst." : "No components recorded."}
                  </p>
                </div>
              ) : (
                <ul className="werkstatt-machine-components">
                  {machine.components.map((component) => (
                    <li key={component.id}>
                      <button
                        type="button"
                        className="werkstatt-machine-component"
                        onClick={() => onOpenComponent(component)}
                      >
                        <span className="werkstatt-machine-component-main">
                          <b>{component.article_name ?? component.unit_number}</b>
                          <small>
                            {component.unit_number}
                            {component.serial_number ? ` · SN ${component.serial_number}` : ""}
                          </small>
                        </span>
                        <StatusPill status={component.status} language={language} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          )}

          {/* ── Log ─────────────────────────────────────────────────────── */}
          <article className="werkstatt-card">
            <header className="werkstatt-card-head">
              <div className="werkstatt-card-title-block">
                <h3 className="werkstatt-card-title">{de ? "Verlauf" : "History"}</h3>
                <span className="werkstatt-card-subtitle">
                  {de ? "Wer sie zuletzt hatte" : "Who had it last"}
                </span>
              </div>
            </header>
            {history.length === 0 ? (
              <div className="werkstatt-machine-card-body">
                <p className="muted">
                  {de ? "Noch keine Bewegungen." : "No movements yet."}
                </p>
              </div>
            ) : (
              <ul className="werkstatt-machine-log">
                {history.map((entry) => {
                  const label = MOVEMENT_LABELS[entry.movement_type];
                  return (
                    <li key={entry.id} className="werkstatt-machine-log-row">
                      <span className={`werkstatt-machine-log-type werkstatt-machine-log-type--${entry.movement_type}`}>
                        {label ? (de ? label.de : label.en) : entry.movement_type}
                      </span>
                      <span className="werkstatt-machine-log-main">
                        <b>
                          {entry.assignee_name ??
                            entry.to_location_name ??
                            (de ? "Werkstatt" : "Workshop")}
                        </b>
                        <small>
                          {formatMachineDateTime(entry.created_at, language)}
                          {entry.user_name ? ` · ${de ? "gebucht von" : "by"} ${entry.user_name}` : ""}
                          {entry.notes ? ` · ${entry.notes}` : ""}
                        </small>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </article>
        </div>

        <div className="werkstatt-column">
          {/* ── Inspection ──────────────────────────────────────────────── */}
          <article className="werkstatt-card">
            <header className="werkstatt-card-head">
              <div className="werkstatt-card-title-block">
                <h3 className="werkstatt-card-title">{de ? "Prüfung" : "Inspection"}</h3>
                <span className="werkstatt-card-subtitle">DGUV3 / BG-Prüfung</span>
              </div>
            </header>
            <div className="werkstatt-machine-card-body">
              {machine.inspection_required ? (
                <>
                  <dl className="werkstatt-machine-facts">
                    <dt>{de ? "Nächste fällig" : "Next due"}</dt>
                    <dd
                      className={
                        machine.inspection_overdue ? "werkstatt-machine-fact--late" : undefined
                      }
                    >
                      {machine.next_inspection_due_at
                        ? `${formatMachineDate(machine.next_inspection_due_at, language)}${
                            dueLabel ? ` · ${dueLabel}` : ""
                          }`
                        : de
                          ? "noch nie geprüft"
                          : "never inspected"}
                    </dd>
                    <dt>{de ? "Zuletzt" : "Last"}</dt>
                    <dd>{formatMachineDate(machine.last_inspected_at, language)}</dd>
                    <dt>{de ? "Intervall" : "Interval"}</dt>
                    <dd>
                      {machine.inspection_interval_days
                        ? `${machine.inspection_interval_days} ${de ? "Tage" : "days"}`
                        : "—"}
                    </dd>
                  </dl>

                  <div className="werkstatt-machine-inspect">
                    <div className="werkstatt-segmented werkstatt-segmented--fill" role="tablist">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={inspectionPassed}
                        className={`werkstatt-segmented-btn${
                          inspectionPassed ? " werkstatt-segmented-btn--active" : ""
                        }`}
                        onClick={() => setInspectionPassed(true)}
                      >
                        {de ? "Bestanden" : "Passed"}
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={!inspectionPassed}
                        className={`werkstatt-segmented-btn${
                          !inspectionPassed ? " werkstatt-segmented-btn--active" : ""
                        }`}
                        onClick={() => setInspectionPassed(false)}
                      >
                        {de ? "Nicht bestanden" : "Failed"}
                      </button>
                    </div>
                    <input
                      type="text"
                      className="werkstatt-field-input"
                      value={inspectionNotes}
                      onChange={(event) => setInspectionNotes(event.target.value)}
                      placeholder={de ? "Prüfer, Bemerkung…" : "Inspector, remark…"}
                    />
                    <button
                      type="button"
                      className="werkstatt-action-btn"
                      onClick={submitInspection}
                      disabled={busy}
                    >
                      {de ? "Prüfung eintragen" : "Record inspection"}
                    </button>
                    {!inspectionPassed && (
                      <p className="werkstatt-field-hint werkstatt-machine-hint--warn">
                        {de
                          ? "Nicht bestanden setzt die Maschine auf „Defekt“ — sie kann dann nicht mehr ausgegeben werden."
                          : "A failed check sets the machine to broken — it can no longer be checked out."}
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <p className="muted">
                  {de
                    ? "Für diese Maschine ist keine wiederkehrende Prüfung hinterlegt."
                    : "No recurring inspection is configured for this machine."}
                </p>
              )}
            </div>
          </article>

          {/* ── Registration data ───────────────────────────────────────── */}
          <article className="werkstatt-card">
            <header className="werkstatt-card-head">
              <div className="werkstatt-card-title-block">
                <h3 className="werkstatt-card-title">{de ? "Stammdaten" : "Registration"}</h3>
              </div>
              {/* Deliberately not manage-gated: reprinting a worn label is the
                  same shop-floor act as booking — the server allows any
                  authenticated user. */}
              <div className="werkstatt-card-head-actions">
                <button
                  type="button"
                  className="werkstatt-card-action"
                  onClick={onQueueLabel}
                  disabled={busy}
                  title={
                    de
                      ? "Klein-Etikett (¼ Bogen) zur Druckliste — 4 verschiedene Maschinen pro Bogen"
                      : "Small label (¼ sheet) to print queue — 4 different machines per sheet"
                  }
                >
                  + {de ? "Druckliste (klein)" : "Queue (small)"}
                </button>
                <button
                  type="button"
                  className="werkstatt-card-action"
                  onClick={onPrintLabel}
                  disabled={busy || !grossPrintable}
                  title={!grossPrintable ? (grossHint ?? undefined) : undefined}
                >
                  {de ? "Etikett drucken" : "Print label"}
                </button>
              </div>
            </header>
            <div className="werkstatt-machine-card-body">
              <dl className="werkstatt-machine-facts">
                <dt>{de ? "Maschinen-Nr." : "Machine no."}</dt>
                <dd className="werkstatt-machine-number">{machine.unit_number}</dd>
                <dt>{de ? "Seriennummer" : "Serial number"}</dt>
                <dd>{machine.serial_number ?? "—"}</dd>
                <dt>{de ? "Lagerort" : "Location"}</dt>
                <dd>{machine.current_location_name ?? "—"}</dd>
                <dt>{de ? "Angeschafft" : "Purchased"}</dt>
                <dd>{formatMachineDate(machine.purchased_at, language)}</dd>
                <dt>{de ? "Erfasst" : "Registered"}</dt>
                <dd>{formatMachineDate(machine.created_at, language)}</dd>
              </dl>
              {machine.notes && <p className="werkstatt-machine-notes">{machine.notes}</p>}
              {users.length === 0 && (
                <p className="werkstatt-field-hint">
                  {de
                    ? "Keine buchbaren Personen geladen."
                    : "No bookable people loaded."}
                </p>
              )}
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}
