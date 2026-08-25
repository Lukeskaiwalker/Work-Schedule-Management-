/**
 * Ausbildungsnachweis — the apprentice's Berichtsheft, as its own page.
 *
 * Two audiences share it, because they are looking at the same record from
 * opposite sides:
 *
 *   - the apprentice (`user.is_apprentice`) sees their own Heft: every week
 *     they have written, grouped by Ausbildungsjahr, with the gaps called out
 *     and the whole thing downloadable as one PDF;
 *   - the trainer (`training:manage`) sees the roster of apprentices, picks
 *     one, and gets the same Heft view plus the countersign queue.
 *
 * The Kammer inspects the *collection*, not individual sheets, so the page is
 * built around the collection: what is filed, what is missing, what is waiting
 * for a signature. A single week is a detail you open from here, not the
 * top-level object.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAppContext } from "../context/AppContext";
import {
  listApprentices,
  listTrainingReports,
  trainingHeftPdfUrl,
  trainingReportPdfUrl,
  type Apprentice,
  type TrainingReport,
} from "../utils/trainingApi";
import { addDays, currentWeekMonday } from "../utils/trainingDates";
import { WochenberichtEditor } from "../components/training/WochenberichtEditor";

type EditorState =
  | { mode: "own"; report: TrainingReport | null; weekStart: string | null }
  | { mode: "review"; report: TrainingReport; weekStart: null }
  | null;

type LoadState = "idle" | "loading" | "error";

function weekLabel(iso: string, locale: string): string {
  const fmt = (value: string) =>
    new Date(`${value}T12:00:00`).toLocaleDateString(locale, { day: "2-digit", month: "2-digit" });
  return `${fmt(iso)} – ${fmt(addDays(iso, 5))}`;
}

function yearLabel(iso: string, locale: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString(locale, { year: "numeric" });
}

/**
 * Mondays with no sheet, between the oldest and newest that exist. Mirrors the
 * server's `_missing_weeks`: only gaps *inside* the covered span count, because
 * weeks the apprentice has not reached yet are not gaps.
 */
function missingWeeks(reports: TrainingReport[]): string[] {
  if (reports.length < 2) return [];
  const covered = new Set(reports.map((report) => report.week_start));
  const sorted = [...covered].sort();
  const last = sorted[sorted.length - 1];
  const gaps: string[] = [];
  let cursor = sorted[0];
  while (cursor < last) {
    cursor = addDays(cursor, 7);
    if (cursor !== last && !covered.has(cursor)) gaps.push(cursor);
  }
  return gaps;
}

export function AusbildungPage() {
  const { token, language, user } = useAppContext();
  const de = language === "de";
  const locale = de ? "de-DE" : "en-US";

  const isApprentice = Boolean(user?.is_apprentice);
  const canReview = Boolean(user?.effective_permissions?.includes("training:manage"));

  // Whose Heft is on screen. Apprentices only ever see their own; a trainer
  // starts on the queue and picks somebody.
  const [selectedUserId, setSelectedUserId] = useState<number | null>(
    isApprentice ? (user?.id ?? null) : null,
  );
  const [reports, setReports] = useState<TrainingReport[]>([]);
  const [queue, setQueue] = useState<TrainingReport[]>([]);
  const [apprentices, setApprentices] = useState<Apprentice[]>([]);
  const [state, setState] = useState<LoadState>("idle");
  const [trainerFailed, setTrainerFailed] = useState(false);
  const [editor, setEditor] = useState<EditorState>(null);

  const viewingOwn = selectedUserId != null && selectedUserId === user?.id;

  /**
   * Loads the selected person's Heft.
   *
   * Takes a cancellation token because a trainer clicking between apprentices
   * has two requests in flight: without it the slower response wins and the
   * page renders one apprentice's weeks under another's name — on a record
   * the trainer is about to countersign.
   */
  const loadReports = useCallback(
    async (isStale?: () => boolean) => {
      if (selectedUserId == null) {
        setReports([]);
        return;
      }
      setState("loading");
      try {
        const rows = await listTrainingReports(
          token,
          viewingOwn ? { view: "own" } : { userId: selectedUserId },
        );
        if (isStale?.()) return;
        setReports(rows);
        setState("idle");
      } catch {
        if (isStale?.()) return;
        // A failed fetch must not read as "nothing filed yet" — that would send
        // an apprentice off to rewrite a week they already have.
        setReports([]);
        setState("error");
      }
    },
    [token, selectedUserId, viewingOwn],
  );

  const loadTrainerData = useCallback(async () => {
    if (!canReview) return;
    try {
      const [roster, pending] = await Promise.all([
        listApprentices(token),
        listTrainingReports(token, { view: "review" }),
      ]);
      setApprentices(roster);
      setQueue(pending.filter((row) => row.status === "submitted"));
      setTrainerFailed(false);
    } catch {
      // An empty queue and a failed queue look identical, and one of them
      // means "nothing to countersign" while the other means "you have no
      // idea". Say which.
      setApprentices([]);
      setQueue([]);
      setTrainerFailed(true);
    }
  }, [token, canReview]);

  useEffect(() => {
    let cancelled = false;
    void loadReports(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadReports]);

  useEffect(() => {
    void loadTrainerData();
  }, [loadTrainerData]);

  const reload = useCallback(() => {
    void loadReports();
    void loadTrainerData();
  }, [loadReports, loadTrainerData]);

  // The Heft download link must reflect what is on screen; a trainer viewing
  // their own record downloads it as the owner, drafts included.
  const heftHref = trainingHeftPdfUrl({
    userId: viewingOwn ? undefined : (selectedUserId ?? undefined),
    includeDrafts: viewingOwn,
  });

  const thisWeek = currentWeekMonday();
  const currentReport = useMemo(
    () => reports.find((report) => report.week_start === thisWeek) ?? null,
    [reports, thisWeek],
  );
  const gaps = useMemo(() => missingWeeks(reports), [reports]);

  // Grouped by Ausbildungsjahr, newest first — the Heft is read as years.
  const byYear = useMemo(() => {
    const groups = new Map<number, TrainingReport[]>();
    for (const report of reports) {
      const list = groups.get(report.ausbildungsjahr) ?? [];
      list.push(report);
      groups.set(report.ausbildungsjahr, list);
    }
    return [...groups.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([jahr, rows]) => ({
        jahr,
        rows: [...rows].sort((a, b) => b.week_start.localeCompare(a.week_start)),
      }));
  }, [reports]);

  const totalHours = useMemo(
    () => reports.reduce((sum, report) => sum + (report.total_hours || 0), 0),
    [reports],
  );

  const statusLabel = (status: TrainingReport["status"]) =>
    status === "draft"
      ? de ? "Entwurf" : "Draft"
      : status === "submitted"
        ? de ? "Eingereicht" : "Submitted"
        : de ? "Gegengezeichnet" : "Countersigned";

  const selectedApprentice = apprentices.find((row) => row.id === selectedUserId) ?? null;
  const heftName = viewingOwn ? (user?.full_name ?? "") : (selectedApprentice?.display_name ?? "");

  return (
    <div className="ausbildung-page">
      <header className="ausbildung-header">
        <div>
          <span className="ausbildung-eyebrow">{de ? "Ausbildung" : "Training"}</span>
          <h1 className="ausbildung-title">
            {de ? "Ausbildungsnachweise" : "Training records"}
            {!viewingOwn && heftName ? ` — ${heftName}` : ""}
          </h1>
        </div>
        {/* Only while looking at your OWN Heft. A trainer who is also an
            apprentice would otherwise get this button while browsing a
            colleague — and `currentReport` would be that colleague's sheet,
            opened in mode="own". */}
        {isApprentice && viewingOwn && (
          <button
            type="button"
            className="ausbildung-btn ausbildung-btn--primary"
            onClick={() =>
              setEditor({ mode: "own", report: currentReport, weekStart: thisWeek })
            }
          >
            {currentReport
              ? de ? "Aktuelle Woche öffnen" : "Open current week"
              : de ? "+ Aktuelle Woche" : "+ Current week"}
          </button>
        )}
        {isApprentice && !viewingOwn && (
          <button
            type="button"
            className="ausbildung-btn"
            onClick={() => setSelectedUserId(user?.id ?? null)}
          >
            {de ? "Mein Berichtsheft" : "My training record"}
          </button>
        )}
      </header>

      {canReview && trainerFailed && (
        <p className="ausbildung-error" role="alert">
          {de
            ? "Die Gegenzeichnungs-Liste konnte nicht geladen werden — sie ist nicht zwingend leer."
            : "The countersign queue could not be loaded — it is not necessarily empty."}{" "}
          <button type="button" className="ausbildung-link-btn" onClick={() => void loadTrainerData()}>
            {de ? "Erneut versuchen" : "Try again"}
          </button>
        </p>
      )}

      {/* ── Trainer: countersign queue ─────────────────────────────────── */}
      {canReview && queue.length > 0 && (
        <section className="ausbildung-panel ausbildung-panel--queue">
          <h2 className="ausbildung-panel-title">
            {de ? "Zur Gegenzeichnung" : "Awaiting countersign"}
            <span className="ausbildung-count">{queue.length}</span>
          </h2>
          <ul className="ausbildung-rows">
            {queue.map((report) => (
              <li key={report.id} className="ausbildung-row">
                <button
                  type="button"
                  className="ausbildung-row-open"
                  onClick={() => setEditor({ mode: "review", report, weekStart: null })}
                >
                  <span className="ausbildung-row-main">
                    <strong>{report.user_display_name}</strong>
                    <span className="ausbildung-row-sub">
                      {de ? "Nr." : "No."} {report.report_number} · {weekLabel(report.week_start, locale)}
                    </span>
                  </span>
                  <span className="ausbildung-chip ausbildung-chip--submitted">
                    {statusLabel(report.status)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── Trainer: apprentice roster ─────────────────────────────────── */}
      {canReview && apprentices.length > 0 && (
        <section className="ausbildung-panel">
          <h2 className="ausbildung-panel-title">{de ? "Auszubildende" : "Apprentices"}</h2>
          <ul className="ausbildung-roster">
            {apprentices.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className={
                    row.id === selectedUserId
                      ? "ausbildung-roster-card ausbildung-roster-card--active"
                      : "ausbildung-roster-card"
                  }
                  onClick={() => setSelectedUserId(row.id === selectedUserId ? null : row.id)}
                >
                  <span className="ausbildung-roster-name">{row.display_name}</span>
                  <span className="ausbildung-roster-meta">
                    {row.report_count} {de ? "Nachweise" : "records"}
                    {row.pending_count > 0 && (
                      <span className="ausbildung-chip ausbildung-chip--submitted">
                        {row.pending_count} {de ? "offen" : "pending"}
                      </span>
                    )}
                    {row.missing_week_count > 0 && (
                      <span className="ausbildung-chip ausbildung-chip--missing">
                        {row.missing_week_count} {de ? "fehlend" : "missing"}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── The Heft itself ────────────────────────────────────────────── */}
      {selectedUserId == null ? (
        canReview && (
          <p className="ausbildung-hint">
            {de
              ? "Auszubildende/n auswählen, um das Berichtsheft zu öffnen."
              : "Pick an apprentice to open their training record."}
          </p>
        )
      ) : (
        <section className="ausbildung-panel">
          <div className="ausbildung-heft-head">
            <h2 className="ausbildung-panel-title">{de ? "Berichtsheft" : "Training record"}</h2>
            <a
              className="ausbildung-btn"
              href={heftHref}
              target="_blank"
              rel="noreferrer"
            >
              {de ? "Ganzes Heft als PDF" : "Whole record as PDF"}
            </a>
          </div>

          <dl className="ausbildung-stats">
            <div>
              <dt>{de ? "Nachweise" : "Records"}</dt>
              <dd>{reports.length}</dd>
            </div>
            <div>
              <dt>{de ? "Gegengezeichnet" : "Countersigned"}</dt>
              <dd>{reports.filter((report) => report.status === "signed").length}</dd>
            </div>
            <div>
              <dt>{de ? "Gesamtstunden" : "Total hours"}</dt>
              <dd>{totalHours.toLocaleString(locale)}</dd>
            </div>
            <div className={gaps.length > 0 ? "ausbildung-stat--warn" : undefined}>
              <dt>{de ? "Fehlende Wochen" : "Missing weeks"}</dt>
              <dd>{gaps.length}</dd>
            </div>
          </dl>

          {gaps.length > 0 && (
            <p className="ausbildung-gap-note">
              {de
                ? "Ein Berichtsheft muss lückenlos sein. Fehlend: "
                : "A training record must be gapless. Missing: "}
              {gaps.slice(0, 8).map((week) => (
                <span key={week}>
                  {viewingOwn ? (
                    <button
                      type="button"
                      className="ausbildung-gap-btn"
                      onClick={() => setEditor({ mode: "own", report: null, weekStart: week })}
                    >
                      {weekLabel(week, locale)}
                    </button>
                  ) : (
                    weekLabel(week, locale)
                  )}
                </span>
              ))}
              {gaps.length > 8 && ` … +${gaps.length - 8}`}
            </p>
          )}

          {state === "loading" && (
            <p className="ausbildung-hint">{de ? "Wird geladen…" : "Loading…"}</p>
          )}
          {state === "error" && (
            <p className="ausbildung-error" role="alert">
              {de
                ? "Die Nachweise konnten nicht geladen werden."
                : "The records could not be loaded."}{" "}
              <button type="button" className="ausbildung-link-btn" onClick={reload}>
                {de ? "Erneut versuchen" : "Try again"}
              </button>
            </p>
          )}
          {state === "idle" && reports.length === 0 && (
            <p className="ausbildung-hint">
              {de
                ? "Noch keine Wochenberichte. Die aktuelle Woche wird aus der Zeiterfassung vorbefüllt."
                : "No weekly records yet. The current week is prefilled from time tracking."}
            </p>
          )}

          {byYear.map((group) => (
            <div key={group.jahr} className="ausbildung-year">
              <h3 className="ausbildung-year-title">
                {group.jahr}. {de ? "Ausbildungsjahr" : "training year"}
                <span className="ausbildung-count">{group.rows.length}</span>
              </h3>
              <ul className="ausbildung-rows">
                {group.rows.map((report) => (
                  <li key={report.id} className="ausbildung-row">
                    <button
                      type="button"
                      className="ausbildung-row-open"
                      onClick={() =>
                        setEditor(
                          viewingOwn
                            ? { mode: "own", report, weekStart: null }
                            : { mode: "review", report, weekStart: null },
                        )
                      }
                    >
                      <span className="ausbildung-row-main">
                        <strong>
                          {de ? "Nr." : "No."} {report.report_number}
                        </strong>
                        <span className="ausbildung-row-sub">
                          {weekLabel(report.week_start, locale)} ·{" "}
                          {yearLabel(report.week_start, locale)} ·{" "}
                          {report.total_hours.toLocaleString(locale)} h
                        </span>
                      </span>
                      <span className={`ausbildung-chip ausbildung-chip--${report.status}`}>
                        {statusLabel(report.status)}
                      </span>
                    </button>
                    <a
                      className="ausbildung-row-pdf"
                      href={trainingReportPdfUrl(report.id)}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`${de ? "PDF von Nachweis" : "PDF of record"} ${report.report_number}`}
                    >
                      PDF
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {editor && (
        <WochenberichtEditor
          report={editor.report}
          weekStart={editor.weekStart}
          mode={editor.mode}
          onClose={(changed) => {
            setEditor(null);
            if (changed) reload();
          }}
        />
      )}
    </div>
  );
}
