/**
 * Editor for one Ausbildungsnachweis week — the IHK form as a screen.
 *
 * The layout deliberately mirrors the paper sheet (header block, one section
 * per day Mo–Sa with activity lines and hours, weekly total, two signature
 * blocks), because the printed PDF must come out IHK-shaped and the closer
 * the editing surface is to the output, the fewer surprises at print time.
 *
 * Two audiences share this component:
 *   - the apprentice (mode="own"): edits drafts, signs & submits, withdraws;
 *   - the trainer (mode="review"): reads a submitted sheet and countersigns.
 * Sharing one component keeps the two views honest — the trainer signs
 * exactly what the apprentice wrote, rendered exactly the same way.
 *
 * Prefill: on a fresh week the server suggests per-day content from time
 * tracking (net hours, Berufsschule days from approved school absences, task
 * titles and report summaries as lines). Hours are split evenly across a
 * day's suggested lines in quarter-hour steps — a deterministic head start
 * the apprentice then corrects, never a claim of truth.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import {
  createTrainingReport,
  deleteTrainingReport,
  getTrainingPrefill,
  signTrainingReportAsAusbilder,
  signTrainingReportAsAzubi,
  trainingReportPdfUrl,
  updateTrainingReport,
  withdrawTrainingReport,
  type TrainingDayEntry,
  type TrainingReport,
  type TrainingReportDay,
} from "../../utils/trainingApi";
import { addDays, mondayOf } from "../../utils/trainingDates";
import { SignaturePad } from "../shared/SignaturePad";

const DAY_LABELS_DE = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
const DAY_LABELS_EN = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const CATEGORY_LABELS: Record<string, { de: string; en: string }> = {
  betrieb: { de: "Betrieb", en: "Company" },
  unterweisung: { de: "Unterweisung", en: "Instruction" },
  schule: { de: "Berufsschule", en: "Voc. school" },
};

interface DayRow {
  day: string;
  entries: TrainingDayEntry[];
}

function emptyWeek(weekStart: string): DayRow[] {
  return Array.from({ length: 6 }, (_, i) => ({ day: addDays(weekStart, i), entries: [] }));
}

/** The six Mo–Sa rows for a stored report, so screen state always mirrors it. */
function rowsFromReport(report: TrainingReport | null, weekStart: string): DayRow[] {
  const base = emptyWeek(weekStart);
  if (!report) return base;
  return base.map((row) => report.days.find((day) => day.day === row.day) ?? row);
}

/** Split hours across n lines in quarter-hour steps, remainder to the first. */
function splitHours(total: number, count: number): number[] {
  if (count <= 0) return [];
  const quarters = Math.round(total * 4);
  const base = Math.floor(quarters / count);
  const rest = quarters - base * count;
  return Array.from({ length: count }, (_, i) => (base + (i === 0 ? rest : 0)) / 4);
}

function shortDate(iso: string, locale: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString(locale, { day: "2-digit", month: "2-digit" });
}

export function WochenberichtEditor({
  report,
  weekStart,
  mode,
  onClose,
}: {
  /** Existing report to open, or null to start a new week. */
  report: TrainingReport | null;
  /** Week to create (any day of it) when report is null. */
  weekStart: string | null;
  mode: "own" | "review";
  onClose: (changed: boolean) => void;
}) {
  const { token, language, user } = useAppContext();
  const de = language === "de";
  const dayLabels = de ? DAY_LABELS_DE : DAY_LABELS_EN;
  const locale = de ? "de-DE" : "en-US";

  const [current, setCurrent] = useState<TrainingReport | null>(report);
  const week = current?.week_start ?? (weekStart ? mondayOf(weekStart) : mondayOf(new Date().toLocaleDateString("sv-SE")));

  const [days, setDays] = useState<DayRow[]>(() => rowsFromReport(report, week));
  const [remarks, setRemarks] = useState<string>(report?.remarks ?? "");
  const [jahr, setJahr] = useState<number>(report?.ausbildungsjahr ?? 1);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [signature, setSignature] = useState("");
  const [signOpen, setSignOpen] = useState(false);
  const [changedAnything, setChangedAnything] = useState(false);

  const status = current?.status ?? "draft";
  const isOwner = mode === "own";
  const editable = isOwner && status === "draft";

  // Mirrors dirty/current for the async prefill guard, without making the
  // prefill effect depend on (and re-run for) every keystroke.
  const raceRef = useRef({ dirty, current });
  raceRef.current = { dirty, current };

  /**
   * Bumped by every edit. A save reads it before the request and compares
   * after: if the apprentice kept typing while the request was in flight,
   * the server's echo is already stale and must not overwrite the screen.
   */
  const editSeqRef = useRef(0);
  const bumpEdit = useCallback(() => {
    editSeqRef.current += 1;
    setDirty(true);
  }, []);

  // ── Prefill a fresh week ────────────────────────────────────────────
  useEffect(() => {
    if (report || !isOwner) return;
    let cancelled = false;
    void (async () => {
      try {
        const prefill = await getTrainingPrefill(token, week);
        if (cancelled) return;
        // A slow prefill must never clobber what the user typed or saved in
        // the meantime — signing would then attest content the screen no
        // longer shows. The ref mirrors dirty/current without re-firing the
        // effect.
        if (raceRef.current.dirty || raceRef.current.current) return;
        setJahr(prefill.ausbildungsjahr);
        setDays(
          prefill.days.map((day) => {
            if (day.school_day) {
              return {
                day: day.day,
                entries: [
                  {
                    text: "Berufsschule",
                    hours: day.worked_hours || user?.required_daily_hours || 8,
                    category: "schule" as const,
                  },
                ],
              };
            }
            if (day.suggested_lines.length > 0) {
              const hours = splitHours(day.worked_hours, day.suggested_lines.length);
              return {
                day: day.day,
                entries: day.suggested_lines.map((text, i) => ({
                  text,
                  hours: hours[i] ?? 0,
                  category: "betrieb" as const,
                })),
              };
            }
            if (day.worked_hours > 0) {
              // Hours with no suggested activity. This used to prefill blank
              // text, which `cleanedDays` then silently discarded on save —
              // the apprentice watched 7,5 h on screen and signed a sheet
              // without them. Give the row a real placeholder instead, so
              // what is displayed is what gets stored.
              return {
                day: day.day,
                entries: [
                  {
                    text: de ? "Betriebliche Tätigkeit" : "Company work",
                    hours: day.worked_hours,
                    category: "betrieb" as const,
                  },
                ],
              };
            }
            return { day: day.day, entries: [] };
          }),
        );
        setNotice(
          de
            ? "Vorschläge aus der Zeiterfassung übernommen — bitte prüfen und ergänzen."
            : "Suggestions taken from time tracking — please check and complete.",
        );
      } catch {
        // Prefill is a convenience; a fresh empty week is a fine fallback.
        if (!cancelled) setDays(emptyWeek(week));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, week, isOwner, token]);

  const totalHours = useMemo(
    () => days.reduce((sum, d) => sum + d.entries.reduce((s, e) => s + (Number(e.hours) || 0), 0), 0),
    [days],
  );

  const mutateEntry = useCallback(
    (dayIdx: number, entryIdx: number, patch: Partial<TrainingDayEntry>) => {
      setDays((prev) =>
        prev.map((row, i) =>
          i === dayIdx
            ? { ...row, entries: row.entries.map((e, j) => (j === entryIdx ? { ...e, ...patch } : e)) }
            : row,
        ),
      );
      bumpEdit();
    },
    [bumpEdit],
  );

  const addEntry = useCallback((dayIdx: number) => {
    setDays((prev) =>
      prev.map((row, i) =>
        i === dayIdx ? { ...row, entries: [...row.entries, { text: "", hours: 0, category: "betrieb" }] } : row,
      ),
    );
    bumpEdit();
  }, [bumpEdit]);

  const removeEntry = useCallback((dayIdx: number, entryIdx: number) => {
    setDays((prev) =>
      prev.map((row, i) => (i === dayIdx ? { ...row, entries: row.entries.filter((_, j) => j !== entryIdx) } : row)),
    );
    bumpEdit();
  }, [bumpEdit]);

  /** Rows with text; empty scaffold rows are dropped rather than rejected. */
  const cleanedDays = useCallback((): TrainingReportDay[] => {
    return days
      .map((row) => ({
        day: row.day,
        entries: row.entries
          .filter((e) => e.text.trim().length > 0)
          .map((e) => ({ text: e.text.trim(), hours: Number(e.hours) || 0, category: e.category })),
      }))
      .filter((row) => row.entries.length > 0);
  }, [days]);

  const fail = useCallback(
    (err: unknown, fallbackDe: string, fallbackEn: string) => {
      const detail = err instanceof ApiError ? err.message : "";
      setError(detail || (de ? fallbackDe : fallbackEn));
    },
    [de],
  );

  /**
   * Closing used to discard a typed week without a word. There is no autosave
   * here (a half-written legal record should not be persisted behind the
   * apprentice's back), so the confirm is the whole safety net.
   */
  const requestClose = useCallback(() => {
    if (
      dirty &&
      !window.confirm(
        de
          ? "Nicht gespeicherte Änderungen gehen verloren. Trotzdem schließen?"
          : "Unsaved changes will be lost. Close anyway?",
      )
    ) {
      return;
    }
    onClose(changedAnything);
  }, [dirty, de, onClose, changedAnything]);

  // Escape closes, matching every other modal in the app. The signature pad
  // takes precedence: Escape there backs out of signing, not out of the sheet.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (signOpen) {
        setSignOpen(false);
        return;
      }
      requestClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [requestClose, signOpen]);

  // A tab-close or reload mid-week gets the browser's own warning.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const saveDraft = useCallback(async (): Promise<TrainingReport | null> => {
    setBusy(true);
    setError(null);
    // Optimistic: a create/update that reaches the server has changed the
    // list even if this component unmounts before the response lands, so the
    // parent must reload either way. Setting it after the await meant closing
    // mid-save left the list stale and the next create 409'd on a report the
    // apprentice could not see.
    setChangedAnything(true);
    const seqAtSend = editSeqRef.current;
    try {
      const cleaned = cleanedDays();
      const payload = { ausbildungsjahr: jahr, days: cleaned, remarks: remarks.trim() || null };
      const saved = current
        ? await updateTrainingReport(token, current.id, payload)
        : await createTrainingReport(token, { week_start: week, ...payload });
      setCurrent(saved);
      if (editSeqRef.current !== seqAtSend) {
        // The apprentice kept typing while the request was in flight. The
        // server's echo is already stale; keep what is on screen and leave the
        // sheet dirty so the next save carries the newer text.
        setNotice(
          de
            ? "Entwurf gespeichert — weitere Änderungen sind noch ungespeichert."
            : "Draft saved — later changes are still unsaved.",
        );
        return saved;
      }
      // Pull the days back from the response rather than leaving the local
      // copy standing. Rows without text are dropped on the way out, and a
      // screen that still shows them is a screen that lies about what was
      // signed — the trainer countersigns the stored sheet, not this one.
      setDays(rowsFromReport(saved, week));
      setRemarks(saved.remarks ?? "");
      setJahr(saved.ausbildungsjahr);
      setDirty(false);
      const droppedRows =
        days.reduce((sum, row) => sum + row.entries.length, 0) -
        cleaned.reduce((sum, row) => sum + row.entries.length, 0);
      setNotice(
        droppedRows > 0
          ? de
            ? `Entwurf gespeichert. ${droppedRows} Zeile(n) ohne Tätigkeit wurden nicht übernommen.`
            : `Draft saved. ${droppedRows} line(s) without an activity were not kept.`
          : de
            ? "Entwurf gespeichert."
            : "Draft saved.",
      );
      return saved;
    } catch (err) {
      fail(err, "Speichern fehlgeschlagen.", "Saving failed.");
      return null;
    } finally {
      setBusy(false);
    }
  }, [current, token, week, jahr, remarks, cleanedDays, de, fail]);

  const submitWithSignature = useCallback(async () => {
    if (!signature) return;
    setBusy(true);
    setError(null);
    try {
      // Save first so what gets signed is exactly what is on screen.
      let target = current;
      if (dirty || !target) {
        target = await saveDraft();
        if (!target) return;
      }
      const signed = await signTrainingReportAsAzubi(token, target.id, signature);
      setCurrent(signed);
      setSignOpen(false);
      setSignature("");
      setChangedAnything(true);
      setNotice(de ? "Nachweis unterschrieben und eingereicht." : "Report signed and submitted.");
    } catch (err) {
      fail(err, "Einreichen fehlgeschlagen.", "Submitting failed.");
    } finally {
      setBusy(false);
    }
  }, [current, dirty, saveDraft, signature, token, de, fail]);

  const countersign = useCallback(async () => {
    if (!signature || !current) return;
    setBusy(true);
    setError(null);
    try {
      const signed = await signTrainingReportAsAusbilder(token, current.id, signature);
      setCurrent(signed);
      setSignOpen(false);
      setSignature("");
      setChangedAnything(true);
      setNotice(de ? "Nachweis gegengezeichnet." : "Report countersigned.");
    } catch (err) {
      fail(err, "Gegenzeichnen fehlgeschlagen.", "Countersigning failed.");
    } finally {
      setBusy(false);
    }
  }, [current, signature, token, de, fail]);

  const withdraw = useCallback(async () => {
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      const back = await withdrawTrainingReport(token, current.id);
      setCurrent(back);
      setChangedAnything(true);
      setNotice(de ? "Einreichung zurückgezogen — der Nachweis ist wieder ein Entwurf." : "Submission withdrawn.");
    } catch (err) {
      fail(err, "Zurückziehen fehlgeschlagen.", "Withdrawing failed.");
    } finally {
      setBusy(false);
    }
  }, [current, token, de, fail]);

  const removeDraft = useCallback(async () => {
    if (!current) {
      onClose(changedAnything);
      return;
    }
    if (!window.confirm(de ? "Diesen Entwurf wirklich löschen?" : "Really delete this draft?")) return;
    setBusy(true);
    try {
      await deleteTrainingReport(token, current.id);
      onClose(true);
    } catch (err) {
      fail(err, "Löschen fehlgeschlagen.", "Deleting failed.");
      setBusy(false);
    }
  }, [current, token, de, fail, onClose, changedAnything]);

  const statusLabel =
    status === "draft"
      ? de ? "Entwurf" : "Draft"
      : status === "submitted"
        ? de ? "Eingereicht" : "Submitted"
        : de ? "Gegengezeichnet" : "Countersigned";

  const title = de ? "Ausbildungsnachweis" : "Training report";

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => {
        // Backdrop only — a click that started inside the card must not close.
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div className="modal-card wochenbericht-modal">
        <div className="wochenbericht-head">
          <div>
            <span className="wochenbericht-eyebrow">
              {title}
              {current ? ` · Nr. ${current.report_number}` : ""}
            </span>
            <h2 className="wochenbericht-title">
              {de ? "Woche vom" : "Week of"} {shortDate(week, locale)} – {shortDate(addDays(week, 5), locale)}
            </h2>
          </div>
          <span className={`wochenbericht-status wochenbericht-status--${status}`}>{statusLabel}</span>
          <button
            type="button"
            className="wochenbericht-close"
            onClick={requestClose}
            aria-label={de ? "Schließen" : "Close"}
          >
            ×
          </button>
        </div>

        <div className="wochenbericht-body">
          {notice && <p className="wochenbericht-notice">{notice}</p>}
          {error && (
            <p className="wochenbericht-error" role="alert">
              {error}
            </p>
          )}

          <div className="wochenbericht-meta">
            <label className="wochenbericht-jahr">
              {de ? "Ausbildungsjahr" : "Training year"}
              <select
                value={jahr}
                disabled={!editable}
                onChange={(e) => {
                  setJahr(Number(e.target.value));
                  bumpEdit();
                }}
              >
                {[1, 2, 3, 4, 5].map((y) => (
                  <option key={y} value={y}>
                    {y}.
                  </option>
                ))}
              </select>
            </label>
            {mode === "review" && current?.user_display_name && (
              <span className="wochenbericht-owner">
                {de ? "Auszubildende/r:" : "Apprentice:"} <strong>{current.user_display_name}</strong>
              </span>
            )}
            <span className="wochenbericht-total">
              {de ? "Gesamtstunden:" : "Total hours:"} <strong>{totalHours.toLocaleString(locale)}</strong>
            </span>
          </div>

          {/* One grid for the whole week, so Tätigkeit / Art / Std. line up
              down the page instead of zig-zagging per day the way a stack of
              independent flex rows did. */}
          <div className="wochenbericht-week">
            {/* Mirrors .wochenbericht-day exactly — day column, then the same
                four-column entry template — so the headings sit over the
                fields they name. */}
            <div className="wochenbericht-week-head" aria-hidden="true">
              <span>{de ? "Tag" : "Day"}</span>
              <span className="wochenbericht-week-head-cols">
                <span>{de ? "Tätigkeit" : "Activity"}</span>
                <span>{de ? "Art" : "Kind"}</span>
                <span>{de ? "Std." : "Hrs"}</span>
                <span />
              </span>
            </div>

            {days.map((row, dayIdx) => {
              const daySum = row.entries.reduce((sum, entry) => sum + (Number(entry.hours) || 0), 0);
              return (
                <section key={row.day} className="wochenbericht-day">
                  <div className="wochenbericht-day-label">
                    <span className="wochenbericht-day-name">{dayLabels[dayIdx]}</span>
                    <span className="wochenbericht-day-date">{shortDate(row.day, locale)}</span>
                    {daySum > 0 && (
                      <span className="wochenbericht-day-sum">{daySum.toLocaleString(locale)} h</span>
                    )}
                  </div>

                  <div className="wochenbericht-day-entries">
                    {row.entries.length === 0 && (
                      <p className="wochenbericht-day-empty">
                        {editable ? (de ? "Nichts eingetragen" : "Nothing recorded") : "—"}
                      </p>
                    )}
                    {row.entries.map((entry, entryIdx) => (
                      <div key={entryIdx} className="wochenbericht-entry">
                        <textarea
                          className="wochenbericht-entry-text"
                          placeholder={de ? "Tätigkeit / Unterweisung / Thema" : "Activity / instruction / topic"}
                          value={entry.text}
                          rows={1}
                          maxLength={500}
                          disabled={!editable}
                          onChange={(e) => mutateEntry(dayIdx, entryIdx, { text: e.target.value })}
                        />
                        <select
                          className="wochenbericht-entry-cat"
                          value={entry.category}
                          disabled={!editable}
                          onChange={(e) =>
                            mutateEntry(dayIdx, entryIdx, {
                              category: e.target.value as TrainingDayEntry["category"],
                            })
                          }
                          aria-label={de ? "Kategorie" : "Category"}
                        >
                          {Object.entries(CATEGORY_LABELS).map(([key, labels]) => (
                            <option key={key} value={key}>
                              {de ? labels.de : labels.en}
                            </option>
                          ))}
                        </select>
                        <input
                          type="number"
                          inputMode="decimal"
                          className="wochenbericht-entry-hours"
                          min={0}
                          max={24}
                          step={0.25}
                          value={entry.hours}
                          disabled={!editable}
                          onChange={(e) => mutateEntry(dayIdx, entryIdx, { hours: Number(e.target.value) })}
                          aria-label={de ? "Stunden" : "Hours"}
                        />
                        {editable ? (
                          <button
                            type="button"
                            className="wochenbericht-entry-remove"
                            onClick={() => removeEntry(dayIdx, entryIdx)}
                            aria-label={de ? "Zeile entfernen" : "Remove line"}
                          >
                            ×
                          </button>
                        ) : (
                          <span />
                        )}
                      </div>
                    ))}
                    {editable && (
                      <button type="button" className="wochenbericht-add-entry" onClick={() => addEntry(dayIdx)}>
                        + {de ? "Zeile" : "Line"}
                      </button>
                    )}
                  </div>
                </section>
              );
            })}
          </div>

          <label className="wochenbericht-remarks">
            {de ? "Bemerkungen" : "Remarks"}
            <textarea
              value={remarks}
              disabled={!editable}
              rows={2}
              onChange={(e) => {
                setRemarks(e.target.value);
                bumpEdit();
              }}
            />
          </label>

          {(current?.azubi_signed_at || current?.ausbilder_signed_at) && (
            <p className="wochenbericht-signed-info">
              {current.azubi_signed_at &&
                `${de ? "Unterschrieben (Azubi):" : "Signed (apprentice):"} ${new Date(current.azubi_signed_at).toLocaleDateString(locale)}`}
              {current.ausbilder_signed_at &&
                ` · ${de ? "Gegengezeichnet:" : "Countersigned:"} ${new Date(current.ausbilder_signed_at).toLocaleDateString(locale)}${current.ausbilder_name ? ` (${current.ausbilder_name})` : ""}`}
            </p>
          )}

          {signOpen && (
            <div className="wochenbericht-sign-box">
              <SignaturePad
                value={signature}
                onChange={setSignature}
                label={
                  mode === "review"
                    ? de ? "Unterschrift Ausbilder/in" : "Trainer signature"
                    : de ? "Unterschrift Auszubildende/r" : "Apprentice signature"
                }
                language={language}
                required
              />
              <div className="wochenbericht-sign-actions">
                <button type="button" className="wochenbericht-btn" onClick={() => setSignOpen(false)} disabled={busy}>
                  {de ? "Abbrechen" : "Cancel"}
                </button>
                <button
                  type="button"
                  className="wochenbericht-btn wochenbericht-btn--primary"
                  disabled={!signature || busy}
                  onClick={() => void (mode === "review" ? countersign() : submitWithSignature())}
                >
                  {mode === "review"
                    ? de ? "Gegenzeichnen" : "Countersign"
                    : de ? "Unterschreiben & einreichen" : "Sign & submit"}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="wochenbericht-foot">
          {/* The number the Ausbilder checks first, so it sits in the action
              bar rather than scrolling away at the top of the sheet. */}
          <span className="wochenbericht-foot-total">
            <span className="wochenbericht-foot-total-label">
              {de ? "Gesamtstunden" : "Total hours"}
            </span>
            <strong>{totalHours.toLocaleString(locale)}</strong>
          </span>
          {current && (
            <a className="wochenbericht-pdf" href={trainingReportPdfUrl(current.id)} target="_blank" rel="noreferrer">
              PDF
            </a>
          )}
          <span className="wochenbericht-foot-spacer" />
          {editable && current && (
            <button type="button" className="wochenbericht-btn wochenbericht-btn--danger" onClick={() => void removeDraft()} disabled={busy}>
              {de ? "Löschen" : "Delete"}
            </button>
          )}
          {isOwner && status === "submitted" && (
            <button type="button" className="wochenbericht-btn" onClick={() => void withdraw()} disabled={busy}>
              {de ? "Zurückziehen" : "Withdraw"}
            </button>
          )}
          {editable && (
            <>
              <button type="button" className="wochenbericht-btn" onClick={() => void saveDraft()} disabled={busy}>
                {de ? "Entwurf speichern" : "Save draft"}
              </button>
              {!signOpen && (
                <button
                  type="button"
                  className="wochenbericht-btn wochenbericht-btn--primary"
                  onClick={() => setSignOpen(true)}
                  disabled={busy}
                >
                  {de ? "Unterschreiben…" : "Sign…"}
                </button>
              )}
            </>
          )}
          {mode === "review" && status === "submitted" && !signOpen && (
            <button
              type="button"
              className="wochenbericht-btn wochenbericht-btn--primary"
              onClick={() => setSignOpen(true)}
              disabled={busy}
            >
              {de ? "Gegenzeichnen…" : "Countersign…"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
