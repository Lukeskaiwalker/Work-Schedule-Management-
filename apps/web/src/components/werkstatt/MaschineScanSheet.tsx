/**
 * MaschineScanSheet — what the scanner shows once a label resolves to a machine.
 *
 * The whole design goal is ONE TAP. Somebody is standing at the rack with a
 * drill in one hand and a phone in the other; if taking it costs four decisions
 * the log stops being kept and the register goes back to being fiction. So the
 * common case — "I'm taking this now, back tonight" — is a single big button,
 * and everything else (a colleague, a van, a longer period) is behind
 * "Andere Optionen".
 *
 * A machine that is already out flips the sheet to the opposite action:
 * scanning the tool you are holding when you get back is how it comes in.
 */
import type { Language } from "../../types";
import type { Machine } from "../../types/werkstattMachines";
import {
  formatMachineDate,
  machineStatusLabel,
  MACHINE_STATUS_TONES,
  relativeDayLabel,
} from "./machineStatus";

export interface MaschineScanSheetProps {
  machine: Machine;
  language: Language;
  /** Who is scanning — the default target of the one-tap booking. */
  currentUserId: number | null;
  currentUserName: string;
  busy: boolean;
  onBookToday: () => void;
  onOpenOptions: () => void;
  onReturn: () => void;
  onOpenDetail: () => void;
  onDismiss: () => void;
}

export function MaschineScanSheet({
  machine,
  language,
  currentUserId,
  currentUserName,
  busy,
  onBookToday,
  onOpenOptions,
  onReturn,
  onOpenDetail,
  onDismiss,
}: MaschineScanSheetProps) {
  const de = language === "de";

  const isOut = machine.status === "ausgegeben";
  const isAvailable = machine.status === "verfuegbar";
  const heldByMe = machine.holder_user_id != null && machine.holder_user_id === currentUserId;
  const cascade = machine.components.filter((c) => c.status === machine.status).length;

  return (
    <div className="scan-sheet" role="dialog" aria-modal="true">
      <div className="scan-sheet-panel">
        <button
          type="button"
          className="scan-sheet-close"
          onClick={onDismiss}
          aria-label={de ? "Schließen" : "Close"}
        >
          ✕
        </button>

        <span className="scan-sheet-eyebrow">{de ? "MASCHINE ERKANNT" : "MACHINE FOUND"}</span>
        <h2 className="scan-sheet-title">
          {machine.article_name ?? (de ? "Maschine" : "Machine")}
        </h2>
        <p className="scan-sheet-sub">
          <span className="werkstatt-machine-number">{machine.unit_number}</span>
          {machine.manufacturer ? ` · ${machine.manufacturer}` : ""}
          {machine.serial_number ? ` · SN ${machine.serial_number}` : ""}
        </p>

        <div className="scan-sheet-status">
          <span
            className={`werkstatt-machine-pill werkstatt-machine-pill--${
              MACHINE_STATUS_TONES[machine.status]
            }`}
          >
            <span className="werkstatt-machine-pill-dot" aria-hidden="true" />
            {machineStatusLabel(machine.status, language)}
          </span>
          {isOut && (
            <span className="scan-sheet-holder">
              {heldByMe
                ? de
                  ? "bei dir"
                  : "with you"
                : `${de ? "bei" : "with"} ${machine.holder_name ?? machine.current_location_name ?? "?"}`}
            </span>
          )}
          {!isOut && machine.current_location_name && (
            <span className="scan-sheet-holder">{machine.current_location_name}</span>
          )}
        </div>

        {/* Inspection is surfaced BEFORE the action, not after: a machine whose
            DGUV3 has lapsed is one somebody is about to pick up. */}
        {machine.inspection_overdue && (
          <p className="scan-sheet-warn">
            {de ? "Prüfung überfällig" : "Inspection overdue"}
            {machine.next_inspection_due_at
              ? ` — ${formatMachineDate(machine.next_inspection_due_at, language)} (${
                  relativeDayLabel(machine.next_inspection_due_at, language) ?? ""
                })`
              : ""}
          </p>
        )}

        {isOut && machine.is_overdue && (
          <p className="scan-sheet-warn">
            {de ? "Rückgabe überfällig" : "Return overdue"}
            {machine.booked_until
              ? ` — ${relativeDayLabel(machine.booked_until, language) ?? ""}`
              : ""}
          </p>
        )}

        {cascade > 0 && (
          <p className="scan-sheet-note">
            {de
              ? `${cascade} Komponente(n) gehören dazu und werden mitgebucht.`
              : `${cascade} component(s) belong to it and move with it.`}
          </p>
        )}

        <div className="scan-sheet-actions">
          {isAvailable && (
            <>
              <button
                type="button"
                className="scan-sheet-primary"
                onClick={onBookToday}
                disabled={busy || currentUserId == null}
              >
                {busy
                  ? de
                    ? "Buche…"
                    : "Booking…"
                  : de
                    ? `Für heute auf ${currentUserName}`
                    : `Take for today — ${currentUserName}`}
              </button>
              <button
                type="button"
                className="scan-sheet-secondary"
                onClick={onOpenOptions}
                disabled={busy}
              >
                {de ? "Andere Optionen (Person, Fahrzeug, Zeitraum)" : "Other options"}
              </button>
            </>
          )}

          {isOut && (
            <button
              type="button"
              className="scan-sheet-primary"
              onClick={onReturn}
              disabled={busy}
            >
              {busy ? (de ? "Buche…" : "Working…") : de ? "Zurückbuchen" : "Check back in"}
            </button>
          )}

          {!isAvailable && !isOut && (
            <p className="scan-sheet-blocked">
              {de
                ? `Status „${machineStatusLabel(machine.status, language)}“ — Ausgabe gesperrt.`
                : `Status "${machineStatusLabel(machine.status, language)}" — checkout blocked.`}
            </p>
          )}

          <button type="button" className="scan-sheet-tertiary" onClick={onOpenDetail}>
            {de ? "Im Maschinenregister öffnen" : "Open in the machine register"}
          </button>
        </div>
      </div>
    </div>
  );
}
