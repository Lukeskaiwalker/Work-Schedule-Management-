// Working hours in the portal: the list on a task or project, the sheet that
// reports one day of one crew, and the state both pages share. A crew enters
// people × hours per person — the way a Regiezettel is written — and sees the
// total before sending. The server checks everything again.

import { useState, type ReactNode } from "react";
import { ApiError } from "../api/client";
import { CheckIcon, ClockIcon, MinusIcon, PlusIcon, TrashIcon } from "./PortalIcons";
import { deletePortalHours, reportPortalHours } from "./portalApi";
import { formatShortDate, localTodayIso, shiftDayIso } from "./portalDates";
import {
  HOURS_MAX_WORKERS,
  HOURS_QUICK_PICKS,
  entryAmount,
  formatHours,
  hoursProblem,
  parseHoursInput,
  stepHours,
} from "./portalHoursDocs";
import type { PortalHoursEntry, PortalHoursInput, PortalHoursTaskRef } from "./portalTypes";

/** What the sheet hands back; the page adds the task or project it belongs to. */
export type HoursDraft = Omit<PortalHoursInput, "project_id">;

function serverMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 400 && /future/i.test(error.message)) return "Das Datum liegt in der Zukunft.";
    if (error.status === 400 && /year/i.test(error.message)) return "Das Datum liegt mehr als ein Jahr zurück.";
    if (error.status === 404) return "Diese Aufgabe oder dieses Projekt ist Ihnen nicht (mehr) zugewiesen.";
    if (error.status === 422) return "Bitte die Angaben prüfen.";
    if (error.status === 429) return "Heute wurden schon sehr viele Stunden gemeldet. Bitte im Büro anrufen.";
  }
  return "Das hat nicht geklappt. Bitte erneut versuchen.";
}

/** Reporting and removing hours, for a page that reloads its data afterwards. */
export function useHoursReporting(token: string, reload: () => Promise<void>) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  function open() {
    setError(null);
    setMessage(null);
    setSheetOpen(true);
  }

  async function submit(input: PortalHoursInput) {
    setBusy(true);
    setError(null);
    try {
      await reportPortalHours(token, input);
      setSheetOpen(false);
      setMessage("Stunden gemeldet – danke!");
      await reload();
    } catch (err) {
      setError(serverMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(entry: PortalHoursEntry) {
    if (!window.confirm(`Eintrag vom ${formatShortDate(entry.work_date)} (${entryAmount(entry)}) löschen?`)) return;
    setDeletingId(entry.id);
    setMessage(null);
    try {
      await deletePortalHours(token, entry.id);
      setMessage("Eintrag gelöscht.");
    } catch (err) {
      setMessage(
        err instanceof ApiError && err.status === 409
          ? "Diesen Eintrag kann nur noch das Büro ändern."
          : "Löschen hat nicht geklappt. Bitte erneut versuchen.",
      );
    } finally {
      setDeletingId(null);
      await reload();
    }
  }

  return { sheetOpen, open, close: () => setSheetOpen(false), busy, error, message, deletingId, submit, remove };
}

export function HoursSection({
  entries,
  total,
  showTask,
  message,
  deletingId,
  onAdd,
  onDelete,
}: {
  entries: PortalHoursEntry[];
  total: number;
  showTask: boolean;
  message: string | null;
  deletingId: number | null;
  onAdd: () => void;
  onDelete: (entry: PortalHoursEntry) => void;
}) {
  return (
    <section className="pp-card pp-card--padded" aria-label="Arbeitsstunden">
      <div className="pp-section-head">
        <span className="pp-kicker">Arbeitsstunden</span>
        {entries.length > 0 && <span className="pp-section-meta">{formatHours(total)} gemeldet</span>}
      </div>
      {entries.length === 0 ? (
        <p className="pp-info-detail">Noch keine Stunden gemeldet. Tragen Sie hier ein, wie lange Ihr Team gearbeitet hat.</p>
      ) : (
        <ul className="pp-hours-list">
          {entries.map((entry) => (
            <li key={entry.id} className="pp-hours-row">
              <span className="pp-hours-date">{formatShortDate(entry.work_date)}</span>
              <span className="pp-hours-body">
                <span className="pp-hours-amount">{entryAmount(entry)}</span>
                {showTask && <span className="pp-hours-meta">{entry.task ? entry.task.title : "Ohne bestimmte Aufgabe"}</span>}
                {entry.note && <span className="pp-hours-note">{entry.note}</span>}
                {entry.reported_by && <span className="pp-hours-meta">gemeldet von {entry.reported_by}</span>}
              </span>
              {entry.can_delete && (
                <button
                  type="button"
                  className="pp-icon-btn"
                  disabled={deletingId === entry.id}
                  onClick={() => onDelete(entry)}
                  aria-label={`Eintrag vom ${formatShortDate(entry.work_date)} löschen`}
                >
                  <TrashIcon size={18} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {message && <p className="pp-info-detail" role="status">{message}</p>}
      <button type="button" className="pp-btn pp-btn--dashed" onClick={onAdd}>
        <ClockIcon size={20} />
        Stunden melden
      </button>
    </section>
  );
}

function Stepper({
  label,
  value,
  onMinus,
  onPlus,
  children,
}: {
  label: string;
  value: string;
  onMinus: () => void;
  onPlus: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="pp-stepper" role="group" aria-label={label}>
      <button type="button" className="pp-stepper-btn" onClick={onMinus} aria-label={`${label} weniger`}>
        <MinusIcon size={20} />
      </button>
      {children ?? <span className="pp-stepper-value" aria-live="polite">{value}</span>}
      <button type="button" className="pp-stepper-btn" onClick={onPlus} aria-label={`${label} mehr`}>
        <PlusIcon size={20} />
      </button>
    </div>
  );
}

export function HoursSheet({
  tasks,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  /** On a project page: the partner's tasks there, one may be picked. */
  tasks?: PortalHoursTaskRef[];
  busy: boolean;
  error: string | null;
  onSubmit: (draft: HoursDraft) => void;
  onCancel: () => void;
}) {
  const todayIso = localTodayIso();
  const yesterdayIso = shiftDayIso(todayIso, -1);
  const [workDate, setWorkDate] = useState(todayIso);
  const [workers, setWorkers] = useState(1);
  const [hoursText, setHoursText] = useState("");
  const [note, setNote] = useState("");
  const [taskId, setTaskId] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const hours = parseHoursInput(hoursText);
  const total = hours != null ? workers * hours : null;

  function setHours(value: number) {
    setHoursText(String(value).replace(".", ","));
  }

  function submit() {
    const issue = hoursProblem({ workers, hours, workDate, todayIso });
    setProblem(issue);
    if (issue || hours == null) return;
    onSubmit({ work_date: workDate, workers, hours, note: note.trim() || null, task_id: taskId ? Number(taskId) : null });
  }

  return (
    <div className="pp-dialog-backdrop" role="presentation" onClick={busy ? undefined : onCancel}>
      <div
        className="pp-dialog pp-dialog--scroll"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pp-hours-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="pp-hours-title" className="pp-dialog-title">Stunden melden</h2>

        <div className="pp-field">
          <span id="pp-hours-day">Tag</span>
          <div className="pp-chips" role="group" aria-labelledby="pp-hours-day">
            <button type="button" className="pp-chip" aria-pressed={workDate === todayIso} onClick={() => setWorkDate(todayIso)}>
              Heute
            </button>
            <button type="button" className="pp-chip" aria-pressed={workDate === yesterdayIso} onClick={() => setWorkDate(yesterdayIso)}>
              Gestern
            </button>
            <input
              className="pp-input pp-input--date"
              type="date"
              value={workDate}
              max={todayIso}
              min={shiftDayIso(todayIso, -365)}
              onChange={(event) => setWorkDate(event.target.value)}
              aria-label="Anderes Datum"
            />
          </div>
        </div>

        <div className="pp-field">
          <span>Personen</span>
          <Stepper
            label="Personen"
            value={String(workers)}
            onMinus={() => setWorkers((n) => Math.max(1, n - 1))}
            onPlus={() => setWorkers((n) => Math.min(HOURS_MAX_WORKERS, n + 1))}
          />
        </div>

        <div className="pp-field">
          <label htmlFor="pp-hours-input">Stunden je Person</label>
          <div className="pp-chips" role="group" aria-label="Schnellauswahl Stunden">
            {HOURS_QUICK_PICKS.map((pick) => (
              <button key={pick} type="button" className="pp-chip" aria-pressed={hours === pick} onClick={() => setHours(pick)}>
                {pick}
              </button>
            ))}
          </div>
          <Stepper
            label="Stunden"
            value={hoursText}
            onMinus={() => setHours(stepHours(hours ?? 0.5, -1))}
            onPlus={() => setHours(stepHours(hours ?? 0, 1))}
          >
            <input
              id="pp-hours-input"
              className="pp-input pp-stepper-input"
              inputMode="decimal"
              value={hoursText}
              placeholder="z. B. 7,5"
              onChange={(event) => setHoursText(event.target.value)}
            />
          </Stepper>
        </div>

        <p className={total != null ? "pp-hours-total" : "pp-hours-total pp-hours-total--empty"} aria-live="polite">
          {total != null ? `Zusammen ${formatHours(total)}` : "Stunden wählen oder eintragen"}
        </p>

        {tasks && tasks.length > 0 && (
          <label className="pp-field" htmlFor="pp-hours-task">
            Aufgabe (optional)
            <select id="pp-hours-task" className="pp-input" value={taskId} onChange={(event) => setTaskId(event.target.value)}>
              <option value="">Keine bestimmte Aufgabe</option>
              {tasks.map((task) => (
                <option key={task.id} value={task.id}>{task.title}</option>
              ))}
            </select>
          </label>
        )}

        <label className="pp-field" htmlFor="pp-hours-note">
          Was wurde gemacht? (optional)
          <textarea
            id="pp-hours-note"
            className="pp-textarea pp-textarea--short"
            value={note}
            maxLength={2000}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>

        {(problem || error) && <div className="pp-alert" role="alert">{problem ?? error}</div>}
        <div className="pp-dialog-actions">
          <button type="button" className="pp-btn pp-btn--primary" disabled={busy} onClick={submit}>
            <CheckIcon size={22} />
            {busy ? "Wird gemeldet …" : "Stunden melden"}
          </button>
          <button type="button" className="pp-btn pp-btn--soft" disabled={busy} onClick={onCancel}>
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  );
}
