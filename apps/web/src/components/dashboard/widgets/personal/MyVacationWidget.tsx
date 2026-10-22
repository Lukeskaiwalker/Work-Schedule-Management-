import { useCallback, useMemo } from "react";

import { useAppContext } from "../../../../context/AppContext";
import { useDashboardResource } from "../../../../hooks/useDashboardResource";
import type { Language, TimeCurrent, VacationRequest } from "../../../../types";
import type { DashboardWidgetSize } from "../../../../types/dashboard";
import { parseServerDateTime } from "../../../../utils/dates";
import {
  OWN_VACATION_REQUESTS_KEY,
  TIME_CURRENT_KEY,
  loadOwnVacationRequests,
  loadTimeCurrent,
} from "../../../../utils/dashboardTimeApi";
import { DASHBOARD_POLL_MS } from "../../dashboardPolling";
import { DashboardWidgetFrame } from "../../DashboardWidgetFrame";
import { DASHBOARD_WIDGET_META } from "../../widgetMeta";
import type { DashboardWidgetProps } from "../../widgetTypes";
import {
  combinedFrameState,
  formatDayRange,
  formatDays,
  formatNumber,
  formatShortDay,
  limitRows,
  useFullPageLink,
} from "./widgetShared";
import "./personal.css";

/**
 * „Urlaub“: the remaining days, the next approved leave and, from Mittel, the
 * user's own requests still ahead (docs/DASHBOARD.md §1, §1.1, §8.5).
 *
 * The balance comes from `/time/current`, which computes it fresh, not from
 * `/auth/me`, which is loaded once at login. It is the key „Mein Status“
 * reads too, so with both on the page there is one request, every 30 s. The
 * list names the user: for a `time:view_all` user the bare list would be the
 * whole company's requests.
 */
const AHEAD_STATUSES: ReadonlySet<string> = new Set(["pending", "approved"]);

function statusLabel(status: string, de: boolean): string {
  if (status === "approved") return de ? "Genehmigt" : "Approved";
  return de ? "Offen" : "Pending";
}

/** Pending and approved requests that are not over yet, soonest first. */
function requestsAhead(rows: readonly VacationRequest[], todayIso: string): VacationRequest[] {
  return rows
    .filter((row) => AHEAD_STATUSES.has(String(row.status).toLowerCase()) && row.end_date >= todayIso)
    .sort((left, right) => left.start_date.localeCompare(right.start_date) || left.id - right.id);
}

function NextLeave({ ahead, todayIso, language }: { ahead: VacationRequest[]; todayIso: string; language: Language }) {
  const de = language === "de";
  const next = ahead.find((row) => String(row.status).toLowerCase() === "approved");
  if (!next) return <p className="dw-vacation__next">{de ? "Kein Urlaub geplant." : "No leave planned."}</p>;
  const running = next.start_date <= todayIso;
  return (
    <p className="dw-vacation__next">
      <span>{running ? (de ? "Im Urlaub bis" : "On leave until") : de ? "Nächster Urlaub" : "Next leave"}</span>{" "}
      <strong>
        {running ? formatShortDay(next.end_date, language) : formatDayRange(next.start_date, next.end_date, language)}
      </strong>
    </p>
  );
}

function RequestList({ rows, language }: { rows: VacationRequest[]; language: Language }) {
  const de = language === "de";
  if (rows.length === 0) {
    return <p className="dashboard-widget__note">{de ? "Keine offenen Anträge." : "No open requests."}</p>;
  }
  return (
    <ul className="dw-vacation__list">
      {rows.map((row) => {
        const status = String(row.status).toLowerCase();
        return (
          <li key={row.id} className="dw-vacation__row">
            <span className="dw-vacation__range">{formatDayRange(row.start_date, row.end_date, language)}</span>
            <span className="dw-vacation__days">{formatDays(Number(row.vacation_days_used ?? 0), language)}</span>
            <span className={`dw-vacation__status dw-vacation__status--${status === "approved" ? "approved" : "pending"}`}>
              {statusLabel(status, de)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

type BodyProps = {
  current: TimeCurrent;
  ahead: VacationRequest[];
  listed: VacationRequest[];
  size: DashboardWidgetSize;
  todayIso: string;
  now: Date;
  language: Language;
};

function VacationBody({ current, ahead, listed, size, todayIso, now, language }: BodyProps) {
  const de = language === "de";
  const planned = Number(current.vacation_days_planned_next_year ?? 0);
  // As on the Zeit page: next year's approved days come off next year's
  // allowance at the year change, so they are shown beside the balance, not
  // as part of it. The year follows the server clock the balance is kept by.
  const nextYear = (parseServerDateTime(current.server_time) ?? now).getFullYear() + 1;
  return (
    <div className="dw-vacation">
      <p className="dw-vacation__balance">
        <strong className="dw-vacation__figure">
          {formatNumber(Number(current.vacation_days_total_remaining ?? 0), language, 2)}
        </strong>
        <span>{de ? "Tage Resturlaub" : "days left"}</span>
      </p>
      {planned > 0 ? (
        <p className="dw-vacation__planned">
          {de
            ? `Vorgemerkt ${nextYear}: ${formatDays(planned, language)}`
            : `Planned ${nextYear}: ${formatDays(planned, language)}`}
        </p>
      ) : null}
      <NextLeave ahead={ahead} todayIso={todayIso} language={language} />
      {size !== "small" ? <RequestList rows={listed} language={language} /> : null}
    </div>
  );
}

export default function MyVacationWidget({ size }: DashboardWidgetProps) {
  const { language, user, todayIso, now } = useAppContext();
  const userId = user?.id ?? null;
  // The store keeps the first loader per key and is per user, so this
  // closure always asks for the store owner's own requests.
  const loadRequests = useCallback(
    (token: string | null, signal: AbortSignal) => loadOwnVacationRequests(token, userId ?? 0, signal),
    [userId],
  );
  const balance = useDashboardResource(TIME_CURRENT_KEY, loadTimeCurrent, { pollMs: DASHBOARD_POLL_MS.slow });
  const requests = useDashboardResource(OWN_VACATION_REQUESTS_KEY, loadRequests, {
    pollMs: DASHBOARD_POLL_MS.slow,
    enabled: userId !== null,
  });
  const openTime = useFullPageLink("time");
  const rows = requests.data;
  const ahead = useMemo(() => requestsAhead(rows ?? [], todayIso), [rows, todayIso]);

  const de = language === "de";
  const { visible, more } = limitRows(ahead, size);
  const current = balance.data;

  return (
    <DashboardWidgetFrame
      title={DASHBOARD_WIDGET_META.my_vacation.title[language]}
      action={openTime ? { label: de ? "Alle anzeigen" : "Show all", onClick: openTime } : null}
      state={combinedFrameState(balance, requests)}
      more={openTime && size !== "small" ? { count: more, onClick: openTime } : null}
    >
      {current && rows ? (
        <VacationBody
          current={current}
          ahead={ahead}
          listed={visible}
          size={size}
          todayIso={todayIso}
          now={now}
          language={language}
        />
      ) : null}
    </DashboardWidgetFrame>
  );
}
