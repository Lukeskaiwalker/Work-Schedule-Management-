import { useState, type FormEvent } from "react";

/** Wall-clock values the user typed, still scoped to the clicked day. */
export type AddDayEntryValues = {
  /** "HH:mm" local time on the clicked day. */
  startTime: string;
  /** "HH:mm" local time on the clicked day. */
  endTime: string;
  breakMinutes: number;
};

/** Matches the backend's `break_minutes` bound (schemas/time.py: ge=0, le=720). */
const MAX_BREAK_MINUTES = 720;

type Props = {
  de: boolean;
  /** True when the day already has at least one shift on record. */
  hasEntries: boolean;
  /** Set only when a manager is writing for somebody else; null when self. */
  otherPersonName: string | null;
  /**
   * Localised "you may fill in X…Y" sentence for the self-service path.
   * Null for managers, whose window is every day and needs no explanation.
   */
  windowLabel: string | null;
  /** Resolves true when the entry was written, so the form can reset. */
  onSubmit: (values: AddDayEntryValues) => Promise<boolean>;
};

/**
 * "This day was worked but never clocked" — the create counterpart to the Edit
 * Day modal's per-shift editors.
 *
 * Deliberately takes a **time** and not a datetime: the day comes from the cell
 * the user clicked, and the backend derives the entry's day from `clock_in`. A
 * date field here would let someone type a day they are not permitted to write
 * and walk into a 403 the caller already gated against. As a consequence a
 * shift running past midnight cannot be entered here — the existing per-shift
 * editor (full `datetime-local`) is where that gets corrected.
 *
 * Collapsed by default so a day with entries is not dominated by an empty form;
 * on a day with none it is the emphasised affordance, since that is the case the
 * feature exists for.
 */
export function AddDayEntryForm({
  de,
  hasEntries,
  otherPersonName,
  windowLabel,
  onSubmit,
}: Props) {
  const [open, setOpen] = useState(false);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [breakMinutes, setBreakMinutes] = useState("0");
  const [submitting, setSubmitting] = useState(false);

  function close() {
    setStartTime("");
    setEndTime("");
    setBreakMinutes("0");
    setOpen(false);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    // Clamped rather than validated: an out-of-range number would come back as
    // a Pydantic 422 whose detail is a list, which the API client cannot turn
    // into a readable sentence. The real rules (overlap, break vs. worked
    // duration, clock order) stay with the backend and surface verbatim.
    const parsedBreak = Number(breakMinutes);
    const safeBreak = Number.isFinite(parsedBreak)
      ? Math.min(Math.max(Math.round(parsedBreak), 0), MAX_BREAK_MINUTES)
      : 0;
    setSubmitting(true);
    try {
      const created = await onSubmit({ startTime, endTime, breakMinutes: safeBreak });
      if (created) close();
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className={
          hasEntries
            ? "edit-day-add-trigger"
            : "edit-day-add-trigger edit-day-add-trigger--primary"
        }
        onClick={() => setOpen(true)}
      >
        {hasEntries
          ? de
            ? "Weitere Schicht nachtragen"
            : "Add another shift"
          : de
            ? "Zeiteintrag nachtragen"
            : "Add a time entry"}
      </button>
    );
  }

  const canSubmit = startTime !== "" && endTime !== "" && !submitting;

  return (
    <form className="edit-day-add-card" onSubmit={(event) => void handleSubmit(event)}>
      <div className="edit-day-add-head">
        <span className="edit-day-add-title">
          {de ? "Zeiteintrag nachtragen" : "Add a time entry"}
        </span>
        {otherPersonName && (
          <span className="edit-day-add-subject">
            {de ? `für ${otherPersonName}` : `for ${otherPersonName}`}
          </span>
        )}
      </div>
      <p className="edit-day-add-hint">
        {otherPersonName
          ? de
            ? "Der Eintrag wird auf den angeklickten Tag gebucht und im Prüfprotokoll festgehalten."
            : "The entry is booked on the clicked day and recorded in the audit log."
          : (windowLabel ??
            (de
              ? "Der Eintrag wird auf den angeklickten Tag gebucht."
              : "The entry is booked on the clicked day."))}
      </p>
      <div className="edit-day-entry-grid">
        <label className="edit-day-entry-field">
          <span className="edit-day-entry-field-label">{de ? "Beginn" : "Start"}</span>
          <input
            type="time"
            className="edit-day-entry-input"
            required
            value={startTime}
            onChange={(event) => setStartTime(event.target.value)}
            disabled={submitting}
          />
        </label>
        <label className="edit-day-entry-field">
          <span className="edit-day-entry-field-label">{de ? "Ende" : "End"}</span>
          <input
            type="time"
            className="edit-day-entry-input"
            required
            value={endTime}
            onChange={(event) => setEndTime(event.target.value)}
            disabled={submitting}
          />
        </label>
        <label className="edit-day-entry-field">
          <span className="edit-day-entry-field-label">
            {de ? "Pause (Min)" : "Break (min)"}
          </span>
          <input
            type="number"
            className="edit-day-entry-input"
            min={0}
            max={MAX_BREAK_MINUTES}
            step={1}
            value={breakMinutes}
            onChange={(event) => setBreakMinutes(event.target.value)}
            disabled={submitting}
          />
        </label>
      </div>
      <div className="edit-day-add-actions">
        <button
          type="button"
          className="edit-day-add-cancel"
          onClick={close}
          disabled={submitting}
        >
          {de ? "Abbrechen" : "Cancel"}
        </button>
        <button type="submit" className="edit-day-add-submit" disabled={!canSubmit}>
          {submitting
            ? de
              ? "Wird gespeichert …"
              : "Saving …"
            : de
              ? "Eintrag anlegen"
              : "Create entry"}
        </button>
      </div>
    </form>
  );
}
