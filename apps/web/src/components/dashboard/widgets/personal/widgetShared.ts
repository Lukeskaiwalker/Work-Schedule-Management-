/**
 * What the „Persönlich“ and „Planung & Projekte“ widgets share (part W3):
 * the row cap per size, the frame state from one or two resources, the link
 * to a full page, and German/English number and date formatting.
 *
 * No React components and no CSS here, so a widget importing it pulls in
 * nothing but these few functions.
 */
import { useMemo } from "react";

import { useDashboardNavigation } from "../../../../hooks/useDashboardNavigation";
import type { DashboardResourceState } from "../../../../hooks/useDashboardResource";
import type { Language, MainView } from "../../../../types";
import type { DashboardWidgetSize } from "../../../../types/dashboard";
import { DASHBOARD_ROW_LIMIT } from "../../../../utils/dashboardLayout";
import type { DashboardWidgetFrameState } from "../../DashboardWidgetFrame";

/** The rows a size shows and how many are left over for „+{n} weitere“. */
export function limitRows<T>(rows: readonly T[], size: DashboardWidgetSize): { visible: T[]; more: number } {
  const limit = DASHBOARD_ROW_LIMIT[size];
  return { visible: rows.slice(0, limit), more: Math.max(0, rows.length - limit) };
}

/** One resource as the frame reads it; the retry is the resource's reload. */
export function frameStateOf(resource: DashboardResourceState<unknown>): DashboardWidgetFrameState {
  return {
    loading: resource.loading,
    error: resource.error,
    stale: resource.stale,
    forbidden: resource.forbidden,
    onRetry: resource.reload,
  };
}

/**
 * Two resources a widget needs both of, as one frame state: skeleton until
 * both have answered, the error while either has nothing to show (the retry
 * asks both again), „Nicht aktuell“ only when neither is in error.
 */
export function combinedFrameState(
  first: DashboardResourceState<unknown>,
  second: DashboardResourceState<unknown>,
): DashboardWidgetFrameState {
  const forbidden = first.forbidden || second.forbidden;
  const error = first.error ?? second.error;
  return {
    loading: !forbidden && !error && (first.data === null || second.data === null),
    error,
    stale: !error && (first.stale || second.stale),
    forbidden,
    onRetry: () => {
      first.reload();
      second.reload();
    },
  };
}

/**
 * Opens the page behind a widget, for „Alle anzeigen“ and „+n weitere“. Null
 * when the sidebar hides that page in the current mode, so neither shows.
 */
export function useFullPageLink(view: MainView): (() => void) | null {
  const { open, resolveView } = useDashboardNavigation();
  const offered = resolveView(view) !== null;
  return useMemo(() => (offered ? () => open({ kind: "view", view }) : null), [offered, open, view]);
}

export function localeOf(language: Language): string {
  return language === "de" ? "de-DE" : "en-US";
}

/** „12,5“: a figure with at most `digits` decimals in the UI language. */
export function formatNumber(value: number, language: Language, digits = 1): string {
  const safe = Number.isFinite(value) ? value : 0;
  return safe.toLocaleString(localeOf(language), { maximumFractionDigits: digits });
}

/** „3,5 h“: hours with exactly one decimal. */
export function formatHours(hours: number, language: Language): string {
  const safe = Number.isFinite(hours) ? hours : 0;
  return `${safe.toLocaleString(localeOf(language), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h`;
}

/** „1 Tag“, „2,5 Tage“: vacation days, which come in halves. */
export function formatDays(days: number, language: Language): string {
  const safe = Number.isFinite(days) ? days : 0;
  const amount = formatNumber(safe, language);
  if (language === "de") return `${amount} ${safe === 1 ? "Tag" : "Tage"}`;
  return `${amount} ${safe === 1 ? "day" : "days"}`;
}

/** „02.11.“ / „11/02“ for an ISO date; what it cannot read comes back as is. */
export function formatShortDay(isoDay: string, language: Language): string {
  const date = new Date(`${isoDay}T12:00:00`);
  if (Number.isNaN(date.getTime())) return isoDay;
  return date.toLocaleDateString(localeOf(language), { day: "2-digit", month: "2-digit" });
}

/** „02.11. – 06.11.“, or one day when start and end are the same. */
export function formatDayRange(start: string, end: string, language: Language): string {
  const first = formatShortDay(start, language);
  return !end || end === start ? first : `${first} – ${formatShortDay(end, language)}`;
}
