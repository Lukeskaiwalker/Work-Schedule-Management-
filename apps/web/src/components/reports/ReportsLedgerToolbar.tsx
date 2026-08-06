import type { Language } from "../../types";
import type { ReportAxis } from "../../utils/reportsLedger";
import { ReportsChipClearIcon, ReportsSearchIcon } from "./ReportsIcons";

export type ReportsAlertFilter = "pending" | "failed" | null;

type Props = {
  language: Language;
  /** Inert while the window is still loading, or when it is genuinely empty. */
  disabled: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  axis: ReportAxis;
  onAxisChange: (axis: ReportAxis) => void;
  alertFilter: ReportsAlertFilter;
  onAlertFilterChange: (filter: ReportsAlertFilter) => void;
  pendingCount: number;
  failedCount: number;
  /** Rows passing the current filters. */
  visibleCount: number;
  /** Rows in the loaded window. */
  totalCount: number;
  filtersActive: boolean;
  /** The window hit the API's 500-row clamp, so the total is a floor. */
  atApiCap: boolean;
  /** `14.07.–10.08.2026`. */
  windowRange: string;
  /** Polling gave up; offer a manual refresh instead of a silent stall. */
  showRefresh: boolean;
  onRefresh: () => void;
};

/**
 * The sticky toolbar. It is the only element on the page that never scrolls
 * away, which is why the period and the counts live here rather than in a stat
 * strip in the page head that would be gone after one screen.
 *
 * Opaque `--surface`, never frosted: `backdrop-filter` appears exactly once in
 * this product's stylesheet (a modal backdrop), so a blurred bar would read at
 * a glance as the one page from a different application.
 */
export function ReportsLedgerToolbar({
  language,
  disabled,
  query,
  onQueryChange,
  axis,
  onAxisChange,
  alertFilter,
  onAlertFilterChange,
  pendingCount,
  failedCount,
  visibleCount,
  totalCount,
  filtersActive,
  atApiCap,
  windowRange,
  showRefresh,
  onRefresh,
}: Props) {
  const de = language === "de";
  const totalText = atApiCap ? `${totalCount}+` : String(totalCount);
  const noun = de ? "Berichte" : "reports";
  const countText = disabled
    ? `— ${noun} · ${windowRange}`
    : filtersActive
      ? `${visibleCount} ${de ? "von" : "of"} ${totalText} · ${windowRange}`
      : `${totalText} ${noun} · ${windowRange}`;

  const axisOptions: ReadonlyArray<{ key: ReportAxis; de: string; en: string }> = [
    { key: "filed", de: "Eingang", en: "Filed" },
    { key: "site", de: "Einsatztag", en: "Site visit" },
  ];

  return (
    <div className={disabled ? "reports-toolbar reports-toolbar--inert" : "reports-toolbar"}>
      <div className="reports-search">
        <ReportsSearchIcon />
        <input
          type="search"
          className="reports-search-input"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          disabled={disabled}
          aria-label={de ? "Berichte durchsuchen" : "Search reports"}
          placeholder={
            de
              ? "Kunde, Projekt, Nummer oder Ersteller"
              : "Customer, project, number or filer"
          }
        />
      </div>

      <div
        className="reports-segmented"
        role="group"
        aria-label={de ? "Gruppierung" : "Grouping"}
      >
        {axisOptions.map((option) => (
          <button
            key={option.key}
            type="button"
            className={
              axis === option.key
                ? "reports-segmented-btn reports-segmented-btn--active"
                : "reports-segmented-btn"
            }
            onClick={() => onAxisChange(option.key)}
            aria-pressed={axis === option.key}
            disabled={disabled}
          >
            {de ? option.de : option.en}
          </button>
        ))}
      </div>

      {pendingCount > 0 ? (
        <AlertChip
          tone="pending"
          active={alertFilter === "pending"}
          label={
            de ? `${pendingCount} in Arbeit` : `${pendingCount} in progress`
          }
          onToggle={() => onAlertFilterChange(alertFilter === "pending" ? null : "pending")}
          disabled={disabled}
        />
      ) : null}

      {failedCount > 0 ? (
        <AlertChip
          tone="failed"
          active={alertFilter === "failed"}
          label={de ? `${failedCount} fehlgeschlagen` : `${failedCount} failed`}
          onToggle={() => onAlertFilterChange(alertFilter === "failed" ? null : "failed")}
          disabled={disabled}
        />
      ) : null}

      {showRefresh ? (
        <button type="button" className="reports-refresh-btn" onClick={onRefresh}>
          {de ? "Aktualisieren" : "Refresh"}
        </button>
      ) : null}

      <span className="reports-toolbar-spacer" />

      <span
        className="reports-toolbar-count"
        title={
          atApiCap
            ? de
              ? "Nur die letzten 500 Berichte sind geladen."
              : "Only the most recent 500 reports are loaded."
            : undefined
        }
      >
        {countText}
      </span>
    </div>
  );
}

type AlertChipProps = {
  tone: "pending" | "failed";
  active: boolean;
  label: string;
  onToggle: () => void;
  disabled: boolean;
};

/** A toggle filter, not a badge — the count is only useful if it is reachable. */
function AlertChip({ tone, active, label, onToggle, disabled }: AlertChipProps) {
  const classes = [
    "reports-alert-chip",
    `reports-alert-chip--${tone}`,
    active ? "reports-alert-chip--active" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      className={classes}
      onClick={onToggle}
      aria-pressed={active}
      disabled={disabled}
    >
      <span className="reports-alert-dot" aria-hidden="true" />
      {label}
      {active ? <ReportsChipClearIcon /> : null}
    </button>
  );
}
