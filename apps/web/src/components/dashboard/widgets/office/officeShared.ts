/**
 * What the four „Büro“ widgets share: the row cap per size, the frame state
 * from a resource, the link to the full page, and number formatting.
 */
import { useMemo } from "react";

import { useDashboardNavigation } from "../../../../hooks/useDashboardNavigation";
import type { DashboardResourceState } from "../../../../hooks/useDashboardResource";
import type { Language, MainView } from "../../../../types";
import type { DashboardWidgetSize } from "../../../../types/dashboard";
import { DASHBOARD_ROW_LIMIT } from "../../../../utils/dashboardLayout";
import type { DashboardWidgetFrameState } from "../../DashboardWidgetFrame";

/**
 * The rows a size shows and how many are left for „+{n} weitere“. A capped
 * answer (the newest ten reports) makes `more` a lower bound; the link opens
 * the full page either way.
 */
export function limitRows<T>(rows: readonly T[], size: DashboardWidgetSize): { visible: T[]; more: number } {
  const limit = DASHBOARD_ROW_LIMIT[size];
  return { visible: rows.slice(0, limit), more: Math.max(0, rows.length - limit) };
}

/** A resource as the frame reads it; the retry is the resource's reload. */
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
 * Opens the page behind a widget, for the header's „Alle anzeigen“ and for
 * „+n weitere“. Null when the sidebar hides that page, so neither link shows.
 */
export function useFullPageLink(view: MainView): (() => void) | null {
  const { open, resolveView } = useDashboardNavigation();
  const offered = resolveView(view) !== null;
  return useMemo(() => (offered ? () => open({ kind: "view", view }) : null), [offered, open, view]);
}

export function localeOf(language: Language): string {
  return language === "de" ? "de-DE" : "en-US";
}

/** „3,5 h“: hours with one decimal. */
export function formatHours(hours: number, language: Language): string {
  const value = Number.isFinite(hours) ? hours : 0;
  return `${value.toLocaleString(localeOf(language), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h`;
}

/** „1 Tag“, „2,5 Tage“: vacation days, which come in halves. */
export function formatDays(days: number, language: Language): string {
  const value = Number.isFinite(days) ? days : 0;
  const amount = value.toLocaleString(localeOf(language), { maximumFractionDigits: 1 });
  if (language === "de") return `${amount} ${value === 1 ? "Tag" : "Tage"}`;
  return `${amount} ${value === 1 ? "day" : "days"}`;
}
