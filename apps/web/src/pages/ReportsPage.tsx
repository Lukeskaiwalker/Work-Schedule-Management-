import { useEffect, useMemo, useRef, useState } from "react";
import { useAppContext } from "../context/AppContext";
import { ReportLedgerRow } from "../components/reports/ReportLedgerRow";
import { ReportsDayHeader } from "../components/reports/ReportsDayHeader";
import {
  ReportsEmptyWindowState,
  ReportsLoadingState,
  ReportsNoResultsState,
} from "../components/reports/ReportsLedgerStates";
import {
  ReportsLedgerToolbar,
  type ReportsAlertFilter,
} from "../components/reports/ReportsLedgerToolbar";
import {
  REPORTS_API_ROW_LIMIT,
  REPORTS_INITIAL_ROW_CAP,
  REPORTS_MAX_POLLS,
  REPORTS_POLL_INTERVAL_MS,
  REPORTS_ROW_CAP_STEP,
  REPORTS_WINDOW_DAYS,
  ensureTodayGroup,
  formatWindowRange,
  groupReportsByAxis,
  reportDocumentBranch,
  reportsWindowStartKey,
  sortReportsForAxis,
  todayDayKey,
  yesterdayDayKey,
  type ReportAxis,
} from "../utils/reportsLedger";
import {
  buildSearchHaystack,
  buildSearchTokens,
  haystackMatchesTokens,
} from "../utils/searchNormalize";
import type { RecentConstructionReport } from "../types";

/**
 * "Berichte" — the construction-report filing ledger.
 *
 * A full-width record list in the shape of `.customers-table-wrap`, the app's
 * only other full-page record list: one card, a sticky toolbar, a column-header
 * strip, and sticky day-group headers over 5-lane rows.
 *
 * The page's spine is the **axis control**, which switches the *grouping* axis
 * rather than a sort order. "Which reports came in yesterday?" is answered by
 * the second group from the top in `Eingang` mode; "did the Müller job get a
 * report on Tuesday?" by `Einsatztag` mode plus one search. Both dates are
 * always on screen and always labelled, because the backend goes out of its way
 * to support both (`workflow_reports.py:176-186`).
 *
 * Self-gates on `mainView === "reports"`; the window itself is loaded by App's
 * per-view effect into `reportsWindow`.
 */
export function ReportsPage() {
  const {
    mainView,
    language,
    reportsWindow,
    reportsWindowLoading,
    loadReportsWindow,
    filePreviewUrl,
    openProjectById,
    now,
  } = useAppContext();

  const [query, setQuery] = useState("");
  const [axis, setAxis] = useState<ReportAxis>("filed");
  const [alertFilter, setAlertFilter] = useState<ReportsAlertFilter>(null);
  const [rowCap, setRowCap] = useState(REPORTS_INITIAL_ROW_CAP);
  const [pollCount, setPollCount] = useState(0);

  const isActive = mainView === "reports";
  const de = language === "de";

  // The window boundaries are recomputed from the same arithmetic the loader
  // uses, so the stated period can never contradict the data on screen. `now`
  // ticks every second in App, so this stays correct across midnight; all four
  // are plain strings, so the memos below that depend on them stay stable.
  const today = todayDayKey(now);
  const yesterday = yesterdayDayKey(now);
  const windowStart = reportsWindowStartKey(now);
  const windowRange = formatWindowRange(windowStart, today);
  // Quantised to the minute: the ageing sub-label has no finer resolution, and
  // a second-resolution prop would churn every row once a second for nothing.
  const nowMs = Math.floor(now.getTime() / 60_000) * 60_000;

  // Pre-fold each report once; re-folding per keystroke over 500 rows is the
  // difference between a search that feels instant and one that does not.
  const haystacks = useMemo(() => {
    const map = new Map<number, ReturnType<typeof buildSearchHaystack>>();
    for (const report of reportsWindow) {
      map.set(
        report.id,
        buildSearchHaystack(
          [report.customer_name, report.project_name, report.project_number, report.user_display_name],
          [report.project_number, report.report_number, report.id],
        ),
      );
    }
    return map;
  }, [reportsWindow]);

  const tokens = useMemo(() => buildSearchTokens(query), [query]);

  // Alert counts describe the *window*, not the current filter: a coloured chip
  // in the toolbar means this screen needs attention, full stop.
  const pendingCount = useMemo(
    () => reportsWindow.filter((row) => reportDocumentBranch(row) === "pending").length,
    [reportsWindow],
  );
  const failedCount = useMemo(
    () => reportsWindow.filter((row) => reportDocumentBranch(row) === "failed").length,
    [reportsWindow],
  );

  const filtersActive = tokens.length > 0 || alertFilter !== null;

  const filteredReports = useMemo<RecentConstructionReport[]>(() => {
    if (!filtersActive) return [...reportsWindow];
    return reportsWindow.filter((report) => {
      if (alertFilter !== null && reportDocumentBranch(report) !== alertFilter) return false;
      if (tokens.length === 0) return true;
      const haystack = haystacks.get(report.id);
      return haystack ? haystackMatchesTokens(haystack, tokens) : false;
    });
  }, [reportsWindow, tokens, alertFilter, filtersActive, haystacks]);

  // Sort first, then cap, then group: the cap must take the newest N by the
  // active axis, not the newest N of whatever order the payload arrived in.
  const sortedReports = useMemo(
    () => sortReportsForAxis(filteredReports, axis),
    [filteredReports, axis],
  );
  const renderedReports = useMemo(
    () => sortedReports.slice(0, rowCap),
    [sortedReports, rowCap],
  );

  const groups = useMemo(() => {
    const grouped = groupReportsByAxis(renderedReports, axis, windowStart, today);
    // An honest zero for "what came in today" beats silence, and it guarantees
    // the page's one accent mark exists at a fixed position every day.
    const showTodayPlaceholder = axis === "filed" && !filtersActive;
    return showTodayPlaceholder ? ensureTodayGroup(grouped, today) : grouped;
  }, [renderedReports, axis, windowStart, today, filtersActive]);

  // Reset the render cap whenever the filtered set changes shape, so a search
  // never lands the user halfway down a stale "show more" sequence.
  useEffect(() => {
    setRowCap(REPORTS_INITIAL_ROW_CAP);
  }, [query, alertFilter, axis]);

  // ── Polling ────────────────────────────────────────────────────────────
  // One bounded refetch of a call the app already makes, never N per-report
  // requests. Only *rendered* pending rows count, and the "PDF fehlt" branch is
  // excluded — it will never resolve on its own, so polling for it would
  // refetch 500 rows every 20 seconds forever.
  const pendingKey = useMemo(
    () =>
      renderedReports
        .filter((row) => reportDocumentBranch(row) === "pending")
        .map((row) => row.id)
        .join(","),
    [renderedReports],
  );

  const loaderRef = useRef(loadReportsWindow);
  useEffect(() => {
    loaderRef.current = loadReportsWindow;
  }, [loadReportsWindow]);

  useEffect(() => {
    setPollCount(0);
  }, [pendingKey]);

  useEffect(() => {
    if (!isActive || !pendingKey || pollCount >= REPORTS_MAX_POLLS) return;
    const timer = window.setTimeout(() => {
      void loaderRef.current(REPORTS_WINDOW_DAYS);
      setPollCount((count) => count + 1);
    }, REPORTS_POLL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [isActive, pendingKey, pollCount]);

  if (!isActive) return null;

  const isLoading = reportsWindowLoading && reportsWindow.length === 0;
  const isEmptyWindow = !reportsWindowLoading && reportsWindow.length === 0;
  const isNoResults = !isLoading && !isEmptyWindow && sortedReports.length === 0;
  const withheldCount = sortedReports.length - renderedReports.length;

  function handleReset() {
    setQuery("");
    setAlertFilter(null);
  }

  function handleRefresh() {
    setPollCount(0);
    void loaderRef.current(REPORTS_WINDOW_DAYS);
  }

  return (
    <section className="reports-page">
      <header className="reports-page-head">
        <div className="reports-page-title-block">
          <span className="reports-page-eyebrow">{de ? "BERICHTE" : "REPORTS"}</span>
          <h2 className="reports-page-title">
            {de ? "Baustellenberichte" : "Construction reports"}
          </h2>
        </div>
      </header>

      <div className="reports-ledger">
        <ReportsLedgerToolbar
          language={language}
          disabled={isLoading || isEmptyWindow}
          query={query}
          onQueryChange={setQuery}
          axis={axis}
          onAxisChange={setAxis}
          alertFilter={alertFilter}
          onAlertFilterChange={setAlertFilter}
          pendingCount={pendingCount}
          failedCount={failedCount}
          visibleCount={sortedReports.length}
          totalCount={reportsWindow.length}
          filtersActive={filtersActive}
          atApiCap={reportsWindow.length >= REPORTS_API_ROW_LIMIT}
          windowRange={windowRange}
          showRefresh={Boolean(pendingKey) && pollCount >= REPORTS_MAX_POLLS}
          onRefresh={handleRefresh}
        />

        {isEmptyWindow ? null : (
          <div className="reports-colhead" aria-hidden="true">
            <span className="reports-colhead-label reports-colhead-label--date">
              {axis === "filed"
                ? de
                  ? "EINSATZ"
                  : "SITE VISIT"
                : de
                  ? "EINGANG"
                  : "FILED"}
            </span>
            <span className="reports-colhead-label reports-colhead-label--customer">
              {de ? "KUNDE" : "CUSTOMER"}
            </span>
            <span className="reports-colhead-label reports-colhead-label--project">
              {de ? "PROJEKT" : "PROJECT"}
            </span>
            <span className="reports-colhead-label reports-colhead-label--filer">
              {de ? "ERFASST VON" : "FILED BY"}
            </span>
            <span className="reports-colhead-label reports-colhead-label--doc" />
          </div>
        )}

        {isLoading ? (
          <ReportsLoadingState language={language} />
        ) : isEmptyWindow ? (
          <ReportsEmptyWindowState language={language} />
        ) : isNoResults ? (
          <ReportsNoResultsState
            language={language}
            query={query}
            totalCount={reportsWindow.length}
            windowRange={windowRange}
            onReset={handleReset}
          />
        ) : (
          groups.map((group) => (
            <div className="reports-group" key={`${axis}-${group.key}`}>
              <ReportsDayHeader
                group={group}
                axis={axis}
                language={language}
                today={today}
                yesterday={yesterday}
                windowStart={windowStart}
              />
              {group.reports.length === 0 ? (
                <div className="reports-day-empty">
                  {de ? "Noch keine Berichte" : "No reports yet"}
                </div>
              ) : (
                group.reports.map((report) => (
                  <ReportLedgerRow
                    key={`report-${report.id}`}
                    report={report}
                    axis={axis}
                    language={language}
                    nowMs={nowMs}
                    filePreviewUrl={filePreviewUrl}
                    openProjectById={openProjectById}
                  />
                ))
              )}
            </div>
          ))
        )}

        {withheldCount > 0 ? (
          <div className="reports-foot">
            <button
              type="button"
              className="reports-foot-btn"
              onClick={() => setRowCap((cap) => cap + REPORTS_ROW_CAP_STEP)}
            >
              {de
                ? `Weitere ${Math.min(withheldCount, REPORTS_ROW_CAP_STEP)} Berichte anzeigen`
                : `Show ${Math.min(withheldCount, REPORTS_ROW_CAP_STEP)} more reports`}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
