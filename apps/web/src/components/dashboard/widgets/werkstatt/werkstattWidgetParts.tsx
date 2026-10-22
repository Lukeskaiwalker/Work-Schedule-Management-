/**
 * Pieces the seven „Werkstatt“ widgets share: the row list, the frame state of
 * a resource, the row limit of a size, and the way into the Werkstatt page.
 *
 * One row component for all of them, so a phone user meets the same 44 px
 * target, the same „·“-separated details and the same overdue colour on every
 * card. Sizing follows the card (`@container` in werkstatt.css), never the
 * viewport: a „Klein“ widget on a desktop is as narrow as a phone.
 */
import { useMemo } from "react";

import { useDashboardNavigation } from "../../../../hooks/useDashboardNavigation";
import type { DashboardResourceState } from "../../../../hooks/useDashboardResource";
import type { WerkstattTab } from "../../../../types";
import type { DashboardWidgetId, DashboardWidgetSize } from "../../../../types/dashboard";
import { DASHBOARD_ROW_LIMIT } from "../../../../utils/dashboardLayout";
import type { DashboardWidgetFrameState } from "../../DashboardWidgetFrame";
import { DASHBOARD_WIDGET_META } from "../../widgetMeta";
import "./werkstatt.css";

export type WerkstattRowTone = "danger" | "warn";

export type WerkstattRow = {
  key: string | number;
  primary: string;
  /** Short facts under the title, each its own span (number, project, count …). */
  details?: ReadonlyArray<string | null | undefined>;
  /** The right-hand status: a due date, a stock figure, a crate state. */
  meta?: string | null;
  tone?: WerkstattRowTone | null;
  /** Null renders a plain row: the page it would open is hidden in this mode. */
  onOpen?: (() => void) | null;
  /** Only where the visible text does not say where the row goes. */
  ariaLabel?: string;
};

export function rowLimit(size: DashboardWidgetSize): number {
  return DASHBOARD_ROW_LIMIT[size];
}

export function widgetTitle(id: DashboardWidgetId, de: boolean): string {
  const { title } = DASHBOARD_WIDGET_META[id];
  return de ? title.de : title.en;
}

export function showAllLabel(de: boolean): string {
  return de ? "Alle anzeigen" : "Show all";
}

/** A resource snapshot as the frame takes it, with its reload as the retry. */
export function frameState<T>(resource: DashboardResourceState<T>): DashboardWidgetFrameState {
  return {
    loading: resource.loading,
    error: resource.error,
    stale: resource.stale,
    forbidden: resource.forbidden,
    onRetry: resource.reload,
  };
}

/**
 * Opens a Werkstatt tab through the start page's navigation (back button,
 * no stale back targets), or null when the sidebar hides the Werkstatt —
 * then the widget's rows and links stay plain instead of leading nowhere.
 */
export function useWerkstattTabOpener(): ((tab: WerkstattTab) => void) | null {
  const { open, resolveView } = useDashboardNavigation();
  const reachable = resolveView("werkstatt") !== null;
  return useMemo(() => (reachable ? (tab: WerkstattTab) => open({ kind: "werkstatt", tab }) : null), [reachable, open]);
}

function RowContent({ row }: { row: WerkstattRow }) {
  const details = (row.details ?? []).filter((detail): detail is string => Boolean(detail));
  return (
    <>
      <span className="dashboard-ws-row__primary">{row.primary}</span>
      {details.length > 0 ? (
        <span className="dashboard-ws-row__details">
          {details.map((detail, index) => (
            <span key={`${index}-${detail}`} className="dashboard-ws-row__detail">
              {detail}
            </span>
          ))}
        </span>
      ) : null}
      {row.meta ? (
        <span className={`dashboard-ws-row__meta${row.tone ? ` dashboard-ws-row__meta--${row.tone}` : ""}`}>
          {row.meta}
        </span>
      ) : null}
    </>
  );
}

export function WerkstattRowList({ rows }: { rows: ReadonlyArray<WerkstattRow> }) {
  return (
    <ul className="dashboard-ws-list">
      {rows.map((row) => (
        <li key={row.key} className="dashboard-ws-row">
          {row.onOpen ? (
            <button type="button" className="dashboard-ws-row__body" onClick={row.onOpen} aria-label={row.ariaLabel}>
              <RowContent row={row} />
            </button>
          ) : (
            <div className="dashboard-ws-row__body">
              <RowContent row={row} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/** „+n weitere“ beyond the rows shown, or nothing when all are shown or there is no page to open. */
export function moreLink(count: number, onClick: (() => void) | null): { count: number; onClick: () => void } | null {
  return count > 0 && onClick ? { count, onClick } : null;
}
