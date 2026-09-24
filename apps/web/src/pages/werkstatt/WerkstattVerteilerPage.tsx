/**
 * Verteiler — the Kommissionierung lists of every planned panel.
 *
 * ONE responsive page rather than a desktop/mobile pair, like Baustellenkisten:
 * the overview is read at a desk to see which panels are being picked, the
 * detail is opened in the workshop with a phone in one hand when a line has to
 * be checked off by hand instead of at the Regal station.
 *
 * Layout follows the shared Werkstatt design system (`werkstatt-sub-head`,
 * `werkstatt-kpi-strip`, `werkstatt-card` + `werkstatt-card-head`) rather than
 * bare cards. `.werkstatt-card` carries NO padding of its own — content sits
 * inside a head/body wrapper.
 *
 * Data: `GET /schaltplan/material/overview`, one summary per panel with the
 * scanned ones first. The detail embeds the shared `PanelMaterialList`, which
 * owns the per-line booking; this page only reloads the overview when the list
 * reports a change, so the numbers on the row match the list behind it.
 *
 * Self-gates on `mainView === "werkstatt" && werkstattTab === "verteiler"`.
 */
import { useCallback, useMemo, useState } from "react";

import { SearchIcon } from "../../components/icons";
import { PanelMaterialList } from "../../components/schaltplan/PanelMaterialList";
import { WerkstattLoadError } from "../../components/werkstatt/dashboard/WerkstattLoadError";
import { useAppContext } from "../../context/AppContext";
import { useWerkstattOverview } from "../../hooks/useWerkstattOverview";
import type { PanelMaterialSummary } from "../../types/schaltplan";
import { formatServerDateTime } from "../../utils/dates";
import { getPanelMaterialOverview } from "../../utils/schaltplanApi";
import "../../styles/werkstatt-overview.css";
import "../../styles/werkstatt-verteiler.css";

/** The permission that lets somebody book material against a panel — the same
 *  claim the Schaltplan editor gates writes on (`SchaltplanPage`). */
const BOOKING_PERMISSION = "reports:create";

export interface VerteilerTotals {
  panels: number;
  /** Panels that have at least one scan on record. */
  inProgress: number;
  openLines: number;
  scanned: number;
  planned: number;
}

const EMPTY_TOTALS: VerteilerTotals = {
  panels: 0,
  inProgress: 0,
  openLines: 0,
  scanned: 0,
  planned: 0,
};

/** Headline numbers over the WHOLE overview, never the filtered slice. */
export function computeVerteilerTotals(
  rows: ReadonlyArray<PanelMaterialSummary>,
): VerteilerTotals {
  return rows.reduce<VerteilerTotals>(
    (acc, row) => ({
      panels: acc.panels + 1,
      inProgress: acc.inProgress + (row.last_scanned_at ? 1 : 0),
      openLines: acc.openLines + row.open_lines,
      scanned: acc.scanned + row.scanned_total,
      planned: acc.planned + row.planned_total,
    }),
    EMPTY_TOTALS,
  );
}

/** Panel number, designation, name, customer and project — everything a person
 *  at the rack might know about the cabinet in front of them. */
export function filterVerteilerRows(
  rows: ReadonlyArray<PanelMaterialSummary>,
  query: string,
): PanelMaterialSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((row) => {
    const panel = row.panel;
    const haystack = [
      panel.panel_number,
      panel.designation,
      panel.name,
      panel.customer_name ?? "",
      panel.project_number ?? "",
      panel.project_name ?? "",
    ];
    return haystack.some((field) => field.toLowerCase().includes(needle));
  });
}

type OpenTone = "open" | "done" | "none";

function openLinesChip(row: PanelMaterialSummary, de: boolean): { text: string; tone: OpenTone } {
  if (row.open_lines > 0) {
    return { text: de ? `${row.open_lines} offen` : `${row.open_lines} open`, tone: "open" };
  }
  // A panel with nothing planned is not "complete" — it is simply empty, and
  // saying it is done would send somebody to the shelf for nothing.
  if (row.planned_total > 0) return { text: de ? "vollständig" : "complete", tone: "done" };
  return { text: de ? "keine Positionen" : "no lines", tone: "none" };
}

function progressPercent(row: PanelMaterialSummary): number {
  if (row.planned_total <= 0) return 0;
  return Math.min(100, Math.round((row.scanned_total / row.planned_total) * 100));
}

function progressFillClass(row: PanelMaterialSummary): string {
  if (row.planned_total > 0 && row.scanned_total > row.planned_total) {
    return "verteiler-progress-fill verteiler-progress-fill--over";
  }
  if (row.planned_total > 0 && row.open_lines === 0) {
    return "verteiler-progress-fill verteiler-progress-fill--done";
  }
  return "verteiler-progress-fill";
}

/** "Schulze · 381 Neubau Schulze" — whichever parts the panel carries. */
function customerProjectLine(row: PanelMaterialSummary): string {
  const panel = row.panel;
  const project = [panel.project_number, panel.project_name].filter(Boolean).join(" ");
  return [panel.customer_name, project].filter(Boolean).join(" · ");
}

export function WerkstattVerteilerPage() {
  const { mainView, werkstattTab, language, token, user } = useAppContext();
  const de = language === "de";
  const active = mainView === "werkstatt" && werkstattTab === "verteiler";

  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  /** The row as it was when opened, so the detail head survives a reload that
   *  fails and leaves `data` null. */
  const [selectedSnapshot, setSelectedSnapshot] = useState<PanelMaterialSummary | null>(null);

  const { data, loading, error, reload } = useWerkstattOverview(
    active,
    token,
    getPanelMaterialOverview,
    de ? "Verteiler nicht geladen." : "Panels not loaded.",
  );

  const rows = useMemo(() => data ?? [], [data]);
  const totals = useMemo(() => (data ? computeVerteilerTotals(data) : null), [data]);
  const visibleRows = useMemo(() => filterVerteilerRows(rows, search), [rows, search]);

  const selected = useMemo(() => {
    if (selectedId === null) return null;
    return rows.find((row) => row.panel.id === selectedId) ?? selectedSnapshot;
  }, [rows, selectedId, selectedSnapshot]);

  const canManage = (user?.effective_permissions ?? []).includes(BOOKING_PERMISSION);

  const openPanel = useCallback((row: PanelMaterialSummary) => {
    setSelectedId(row.panel.id);
    setSelectedSnapshot(row);
  }, []);

  const closePanel = useCallback(() => {
    setSelectedId(null);
    setSelectedSnapshot(null);
    // The row's numbers are stale after booking in the detail.
    reload();
  }, [reload]);

  if (!active) return null;

  const errorBanner = error ? (
    <WerkstattLoadError
      headline={
        de ? "Die Verteiler konnten nicht geladen werden." : "The panels could not be loaded."
      }
      detail={error}
      retryLabel={de ? "Erneut versuchen" : "Try again"}
      onRetry={reload}
    />
  ) : null;

  /* ── Detail: one panel's material list ──────────────────────────────── */

  if (selected) {
    const panel = selected.panel;
    const chip = openLinesChip(selected, de);
    const meta = customerProjectLine(selected);
    return (
      <section className="werkstatt-tab-page verteiler-page">
        <button type="button" className="werkstatt-card-action verteiler-back" onClick={closePanel}>
          ← {de ? "Zurück zur Übersicht" : "Back to overview"}
        </button>

        {errorBanner}

        <article className="werkstatt-card">
          <header className="werkstatt-card-head">
            <div className="verteiler-detail-head">
              <span className="verteiler-number verteiler-detail-number">{panel.panel_number}</span>
              <div className="verteiler-detail-text">
                <h3 className="werkstatt-card-title">
                  <span className="verteiler-designation">{panel.designation}</span> {panel.name}
                </h3>
                <span className="werkstatt-card-subtitle">
                  {meta || (de ? "Ohne Projekt" : "No project")}
                  {" · "}
                  {selected.scanned_total} / {selected.planned_total}{" "}
                  {de ? "gescannt" : "scanned"}
                </span>
              </div>
            </div>
            <span className={`verteiler-open verteiler-open--${chip.tone}`}>{chip.text}</span>
          </header>
          <div className="verteiler-card-body">
            <PanelMaterialList
              token={token}
              panelId={panel.id}
              canEdit={canManage}
              language={language}
              onChanged={reload}
              hideHeader
            />
          </div>
        </article>
      </section>
    );
  }

  /* ── Overview ───────────────────────────────────────────────────────── */

  const isLoading = data === null && error === null;
  const kpiValue = (value: number | null | undefined) => (value == null ? "–" : String(value));

  return (
    <section className="werkstatt-tab-page verteiler-page">
      <header className="werkstatt-sub-head">
        <div className="werkstatt-sub-head-text">
          <span className="werkstatt-sub-breadcrumb">
            {de ? "WERKSTATT › VERTEILER" : "WORKSHOP › PANELS"}
          </span>
          <h1 className="werkstatt-sub-title">{de ? "Verteiler" : "Panels"}</h1>
          <p className="werkstatt-sub-subtitle">
            {totals
              ? de
                ? `${totals.panels} Verteiler geplant · ${totals.inProgress} in Kommissionierung`
                : `${totals.panels} panels planned · ${totals.inProgress} being picked`
              : de
                ? "Geplantes Material gegen das am Regal gescannte."
                : "Planned material against what was scanned at the rack."}
          </p>
        </div>
        <div className="werkstatt-sub-actions">
          <button
            type="button"
            className="werkstatt-action-btn"
            onClick={reload}
            disabled={loading}
          >
            {de ? "Aktualisieren" : "Refresh"}
          </button>
        </div>
      </header>

      {errorBanner}

      <div className="werkstatt-kpi-strip">
        <div className="werkstatt-kpi werkstatt-kpi--neutral">
          <span className="werkstatt-kpi-label">{de ? "VERTEILER" : "PANELS"}</span>
          <div className="werkstatt-kpi-value-row">
            <span className="werkstatt-kpi-value">{kpiValue(totals?.panels)}</span>
            <span className="werkstatt-kpi-subtitle">{de ? "geplant" : "planned"}</span>
          </div>
        </div>
        <div className="werkstatt-kpi werkstatt-kpi--info">
          <span className="werkstatt-kpi-label werkstatt-kpi-label--info">
            {de ? "IN ARBEIT" : "IN PROGRESS"}
          </span>
          <div className="werkstatt-kpi-value-row">
            <span className="werkstatt-kpi-value">{kpiValue(totals?.inProgress)}</span>
            <span className="werkstatt-kpi-subtitle">{de ? "mit Scans" : "with scans"}</span>
          </div>
        </div>
        <div className="werkstatt-kpi werkstatt-kpi--warning">
          <span className="werkstatt-kpi-label werkstatt-kpi-label--warning">
            {de ? "OFFENE POSITIONEN" : "OPEN LINES"}
          </span>
          <div className="werkstatt-kpi-value-row">
            <span className="werkstatt-kpi-value">{kpiValue(totals?.openLines)}</span>
            <span className="werkstatt-kpi-subtitle">
              {de ? "noch zu scannen" : "still to scan"}
            </span>
          </div>
        </div>
        <div className="werkstatt-kpi werkstatt-kpi--neutral">
          <span className="werkstatt-kpi-label">{de ? "GESCANNT" : "SCANNED"}</span>
          <div className="werkstatt-kpi-value-row">
            <span className="werkstatt-kpi-value">{kpiValue(totals?.scanned)}</span>
            <span className="werkstatt-kpi-subtitle">
              {totals
                ? de
                  ? `von ${totals.planned} geplant`
                  : `of ${totals.planned} planned`
                : de
                  ? "geplant"
                  : "planned"}
            </span>
          </div>
        </div>
      </div>

      <div className="werkstatt-filter-bar werkstatt-filter-bar--slim">
        <div className="werkstatt-search">
          <SearchIcon />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={
              de ? "Verteiler, Kunde oder Projekt suchen…" : "Search panel, customer or project…"
            }
            aria-label={de ? "Verteiler suchen" : "Search panels"}
          />
        </div>
      </div>

      <article className="werkstatt-card">
        <header className="werkstatt-card-head">
          <div className="werkstatt-card-title-block">
            <h3 className="werkstatt-card-title">{de ? "Kommissionierung" : "Picking"}</h3>
            <span className="werkstatt-card-subtitle">
              {de ? "Zuletzt gescannte Verteiler zuerst" : "Most recently scanned panels first"}
            </span>
          </div>
        </header>

        {isLoading && <div className="verteiler-empty">{de ? "Lädt…" : "Loading…"}</div>}

        {!isLoading && error && (
          <div className="verteiler-empty">
            {de
              ? "Nicht geladen — die Zahlen oben zeigen nichts Aktuelles."
              : "Not loaded — the numbers above are not current."}
          </div>
        )}

        {!isLoading && !error && rows.length === 0 && (
          <div className="verteiler-empty">
            {de ? "Noch kein Verteiler geplant." : "No panel planned yet."}
          </div>
        )}

        {!isLoading && !error && rows.length > 0 && visibleRows.length === 0 && (
          <div className="verteiler-empty">
            {de ? "Kein Verteiler passt zur Suche." : "No panel matches the search."}
          </div>
        )}

        {visibleRows.length > 0 && (
          <ul className="verteiler-list">
            {visibleRows.map((row) => {
              const panel = row.panel;
              const chip = openLinesChip(row, de);
              const meta = customerProjectLine(row);
              return (
                <li key={panel.id} className="verteiler-row">
                  <button
                    type="button"
                    className="verteiler-row-btn"
                    onClick={() => openPanel(row)}
                    aria-label={
                      de
                        ? `${panel.panel_number} ${panel.designation} ${panel.name} öffnen`
                        : `Open ${panel.panel_number} ${panel.designation} ${panel.name}`
                    }
                  >
                    <span className="verteiler-number">{panel.panel_number}</span>
                    <span className="verteiler-text">
                      <span className="verteiler-title">
                        <span className="verteiler-designation">{panel.designation}</span>{" "}
                        {panel.name}
                      </span>
                      <span className="verteiler-meta">
                        {meta || (de ? "Ohne Projekt" : "No project")}
                      </span>
                    </span>
                    <span className="verteiler-progress">
                      <span className="verteiler-progress-text">
                        {row.scanned_total} / {row.planned_total}
                      </span>
                      <span className="verteiler-progress-bar" aria-hidden="true">
                        <span
                          className={progressFillClass(row)}
                          style={{ width: `${progressPercent(row)}%` }}
                        />
                      </span>
                    </span>
                    <span className="verteiler-status">
                      <span className={`verteiler-open verteiler-open--${chip.tone}`}>
                        {chip.text}
                      </span>
                      {row.last_scanned_at && (
                        <span className="verteiler-scanned">
                          {de ? "zuletzt gescannt" : "last scanned"}{" "}
                          {formatServerDateTime(row.last_scanned_at, language)}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </article>
    </section>
  );
}
