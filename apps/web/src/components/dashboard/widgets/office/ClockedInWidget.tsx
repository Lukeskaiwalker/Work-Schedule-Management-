import { useAppContext } from "../../../../context/AppContext";
import { useDashboardResource } from "../../../../hooks/useDashboardResource";
import { DASHBOARD_POLL_MS } from "../../dashboardPolling";
import { DashboardWidgetFrame } from "../../DashboardWidgetFrame";
import { DASHBOARD_WIDGET_META } from "../../widgetMeta";
import type { DashboardWidgetProps } from "../../widgetTypes";
import { CLOCK_SUMMARY_KEY, loadClockSummary } from "./officeResources";
import { formatHours, frameStateOf, limitRows, useFullPageLink } from "./officeShared";
import "./office.css";

/**
 * „Wer ist eingestempelt“: who has an open shift right now, since when, and
 * their hours today (docs/DASHBOARD.md §1). The answer is the end-of-day
 * summary's (`/time/clock-summary`), already sorted by name and with the
 * start in local time, so the widget only caps and formats it. The rows are
 * read-only; „Alle anzeigen“ opens the Zeiterfassung.
 */
export default function ClockedInWidget({ size }: DashboardWidgetProps) {
  const { language } = useAppContext();
  const resource = useDashboardResource(CLOCK_SUMMARY_KEY, loadClockSummary, {
    pollMs: DASHBOARD_POLL_MS.clockSummary,
  });
  const openTime = useFullPageLink("time");

  const de = language === "de";
  const people = resource.data?.clocked_in ?? [];
  const { visible, more } = limitRows(people, size);

  return (
    <DashboardWidgetFrame
      title={DASHBOARD_WIDGET_META.clocked_in.title[language]}
      badge={resource.data === null ? null : people.length}
      action={openTime ? { label: de ? "Alle anzeigen" : "Show all", onClick: openTime } : null}
      state={frameStateOf(resource)}
      isEmpty={resource.data !== null && people.length === 0}
      emptyText={de ? "Niemand ist eingestempelt." : "Nobody is clocked in."}
      more={openTime ? { count: more, onClick: openTime } : null}
    >
      <ul className="dashboard-office__list">
        {visible.map((person) => (
          <li key={person.user_id} className="dashboard-office__row dashboard-office__row--static">
            <span className="dashboard-office__main">
              <span className="dashboard-office__primary">{person.name}</span>
              <span className="dashboard-office__secondary">
                {de ? `seit ${person.clocked_in_since}` : `since ${person.clocked_in_since}`}
              </span>
            </span>
            <span className="dashboard-office__figure">{formatHours(Number(person.hours_today), language)}</span>
          </li>
        ))}
      </ul>
    </DashboardWidgetFrame>
  );
}
