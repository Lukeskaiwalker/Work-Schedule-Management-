import { useMemo } from "react";

import { useAppContext } from "../../../../context/AppContext";
import { useDashboardResource } from "../../../../hooks/useDashboardResource";
import type { Language, VacationRequest } from "../../../../types";
import { formatShortIsoDate } from "../../../../utils/dates";
import { DASHBOARD_POLL_MS } from "../../dashboardPolling";
import { DashboardWidgetFrame } from "../../DashboardWidgetFrame";
import { DASHBOARD_WIDGET_META } from "../../widgetMeta";
import type { DashboardWidgetProps } from "../../widgetTypes";
import { PENDING_VACATION_KEY, loadPendingVacationRequests } from "./officeResources";
import { formatDays, frameStateOf, limitRows, useFullPageLink } from "./officeShared";
import "./office.css";

/**
 * Soonest leave first, not newest request first as the server sends them: the
 * request that starts next is the one that cannot wait for a decision.
 */
function bySoonestStart(a: VacationRequest, b: VacationRequest): number {
  return a.start_date.localeCompare(b.start_date) || a.id - b.id;
}

/** „26.10. – 28.10. · 2,5 Tage“, one date for a single day. */
function requestSummary(request: VacationRequest, language: Language): string {
  const start = formatShortIsoDate(request.start_date, language);
  const range =
    request.end_date && request.end_date !== request.start_date
      ? `${start} – ${formatShortIsoDate(request.end_date, language)}`
      : start;
  return `${range} · ${formatDays(Number(request.vacation_days_used), language)}`;
}

/**
 * „Offene Urlaubsanträge“: vacation requests waiting for approval
 * (docs/DASHBOARD.md §1). The server offers it only to people who may both
 * approve and see everyone's requests; for anyone else the list would hold
 * just their own and the title would mislead. Approving stays on the
 * Zeiterfassung, where the balance check runs, so a row opens that page.
 */
export default function VacationApprovalsWidget({ size }: DashboardWidgetProps) {
  const { language } = useAppContext();
  const resource = useDashboardResource(PENDING_VACATION_KEY, loadPendingVacationRequests, {
    pollMs: DASHBOARD_POLL_MS.vacationPending,
  });
  const openTime = useFullPageLink("time");
  const pending = useMemo(() => [...(resource.data ?? [])].sort(bySoonestStart), [resource.data]);

  const de = language === "de";
  const { visible, more } = limitRows(pending, size);

  return (
    <DashboardWidgetFrame
      title={DASHBOARD_WIDGET_META.vacation_approvals.title[language]}
      badge={resource.data === null ? null : pending.length}
      action={openTime ? { label: de ? "Alle anzeigen" : "Show all", onClick: openTime } : null}
      state={frameStateOf(resource)}
      isEmpty={resource.data !== null && pending.length === 0}
      emptyText={de ? "Keine offenen Anträge." : "No pending requests."}
      more={openTime ? { count: more, onClick: openTime } : null}
    >
      <ul className="dashboard-office__list">
        {visible.map((request) => (
          <li key={request.id} className="dashboard-office__row">
            <button
              type="button"
              className="dashboard-office__row-button"
              onClick={openTime ?? undefined}
              disabled={!openTime}
            >
              <span className="dashboard-office__main">
                <span className="dashboard-office__primary">{request.user_name}</span>
                <span className="dashboard-office__secondary">{requestSummary(request, language)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </DashboardWidgetFrame>
  );
}
