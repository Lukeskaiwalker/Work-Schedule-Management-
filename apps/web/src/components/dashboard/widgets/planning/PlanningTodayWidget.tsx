import { useMemo, useState } from "react";

import { useAppContext } from "../../../../context/AppContext";
import { useDashboardNavigation } from "../../../../hooks/useDashboardNavigation";
import type { Language, Task } from "../../../../types";
import type { DashboardWidgetSize } from "../../../../types/dashboard";
import { formatDayLabel } from "../../../../utils/dates";
import { myTasksForDay, myWeekByDay, type ScheduleDay } from "../../../../utils/dashboardPlanning";
import { DASHBOARD_ROW_LIMIT } from "../../../../utils/dashboardLayout";
import { formatTaskTimeRange, taskDayIndexLabel } from "../../../../utils/tasks";
import { myTasksRowAction } from "../../../tasks/MyTasksOverviewCard";
import { DashboardWidgetFrame } from "../../DashboardWidgetFrame";
import { DASHBOARD_WIDGET_META } from "../../widgetMeta";
import type { DashboardWidgetProps } from "../../widgetTypes";
import { useFullPageLink } from "../personal/widgetShared";
import "./planning.css";

/**
 * „Mein Einsatz“: what the user is scheduled for today and this week
 * (docs/DASHBOARD.md D21, §1.1; owner answer Q2: the user's own schedule).
 *
 * Built from the context's tasks (view `my_all`, already loaded on the
 * overview): no request, no poll. dashboardPlanning.ts keeps it personal —
 * an admin's context may hold other people's tasks — and leaves done work
 * out. Klein is today only; Mittel toggles „Heute“ / „Woche“ starting on
 * today; Groß starts on the week, grouped by day. The toggle is not saved.
 *
 * A row opens the task the way the task card does: managers edit it in
 * place, everyone else lands on their task list with the row expanded (the
 * office list in Büro mode).
 */
type Range = "today" | "week";

function defaultRange(size: DashboardWidgetSize): Range {
  return size === "large" ? "week" : "today";
}

/** The first `limit` rows across the days, and how many are left over. */
function capDays(days: readonly ScheduleDay[], limit: number): { shown: ScheduleDay[]; more: number } {
  const total = days.reduce((sum, entry) => sum + entry.tasks.length, 0);
  const shown: ScheduleDay[] = [];
  let left = limit;
  for (const entry of days) {
    if (left <= 0) break;
    const tasks = entry.tasks.slice(0, left);
    shown.push({ day: entry.day, tasks });
    left -= tasks.length;
  }
  return { shown, more: Math.max(0, total - limit) };
}

function rowLabel(task: Task, canManageTasks: boolean, de: boolean): string {
  if (myTasksRowAction(task, canManageTasks) === "edit") {
    return de ? `Aufgabe bearbeiten: ${task.title}` : `Edit task: ${task.title}`;
  }
  return de ? `Aufgabe öffnen: ${task.title}` : `Open task: ${task.title}`;
}

function RangeToggle({ range, onChange, de }: { range: Range; onChange: (next: Range) => void; de: boolean }) {
  return (
    <div className="dw-einsatz__toggle" role="group" aria-label={de ? "Zeitraum" : "Range"}>
      <button type="button" aria-pressed={range === "today"} onClick={() => onChange("today")}>
        {de ? "Heute" : "Today"}
      </button>
      <button type="button" aria-pressed={range === "week"} onClick={() => onChange("week")}>
        {de ? "Woche" : "Week"}
      </button>
    </div>
  );
}

type DayListProps = {
  days: ScheduleDay[];
  range: Range;
  todayIso: string;
  language: Language;
  canManageTasks: boolean;
  projectLabel: (task: Task) => string;
  onOpen: (task: Task) => void;
};

function DayList({ days, range, todayIso, language, canManageTasks, projectLabel, onOpen }: DayListProps) {
  const de = language === "de";
  return (
    <div className="dw-einsatz__days">
      {days.map(({ day, tasks }) => (
        <section key={day} className="dw-einsatz__day">
          {range === "week" ? (
            <h4 className={day === todayIso ? "dw-einsatz__heading dw-einsatz__heading--today" : "dw-einsatz__heading"}>
              {day === todayIso ? `${de ? "Heute" : "Today"} · ${formatDayLabel(day, language)}` : formatDayLabel(day, language)}
            </h4>
          ) : null}
          <ul className="dw-plan-list">
            {tasks.map((task) => {
              const time = formatTaskTimeRange(task);
              const dayIndex = taskDayIndexLabel(task, day, language);
              const where = projectLabel(task);
              return (
                <li key={`${day}-${task.id}`} className="dw-plan-list__item">
                  <button
                    type="button"
                    className="dw-plan-row"
                    onClick={() => onOpen(task)}
                    aria-label={rowLabel(task, canManageTasks, de)}
                  >
                    {/* A dash for untimed work keeps the titles in one column. */}
                    <span className="dw-einsatz__time">{time || "–"}</span>
                    <span className="dw-plan-row__main">
                      <span className="dw-plan-row__title">{task.title}</span>
                      {where || dayIndex ? (
                        <span className="dw-plan-row__meta">
                          {where}
                          {dayIndex ? <span className="dw-plan-row__chip">{dayIndex}</span> : null}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

export default function PlanningTodayWidget({ size }: DashboardWidgetProps) {
  const {
    language,
    user,
    tasks,
    todayIso,
    canManageTasks,
    openTaskEditModal,
    setExpandedMyTaskId,
    taskProjectTitleParts,
    taskCustomerLabel,
  } = useAppContext();
  const { open } = useDashboardNavigation();
  const openList = useFullPageLink("my_tasks");
  // Null until the user picks: a size change (edit mode, another device)
  // then still starts on that size's default.
  const [picked, setPicked] = useState<Range | null>(null);

  const range: Range = size === "small" ? "today" : (picked ?? defaultRange(size));
  const userId = user?.id ?? null;
  const days = useMemo<ScheduleDay[]>(() => {
    if (userId === null) return [];
    if (range === "week") return myWeekByDay(tasks ?? [], todayIso, userId);
    const today = myTasksForDay(tasks ?? [], todayIso, userId);
    return today.length > 0 ? [{ day: todayIso, tasks: today }] : [];
  }, [tasks, todayIso, userId, range]);

  const de = language === "de";
  const { shown, more } = capDays(days, DASHBOARD_ROW_LIMIT[size]);

  function openTask(task: Task) {
    if (myTasksRowAction(task, canManageTasks) === "edit") {
      openTaskEditModal(task);
      return;
    }
    setExpandedMyTaskId(task.id);
    open({ kind: "view", view: "my_tasks" });
  }

  function projectLabel(task: Task): string {
    return taskProjectTitleParts(task).title || taskCustomerLabel(task);
  }

  const emptyText =
    range === "week"
      ? de ? "Diese Woche bist du nicht eingeplant." : "You are not scheduled this week."
      : de ? "Heute bist du nicht eingeplant." : "You are not scheduled today.";

  return (
    <DashboardWidgetFrame
      title={DASHBOARD_WIDGET_META.planning_today.title[language]}
      action={openList ? { label: de ? "Alle anzeigen" : "Show all", onClick: openList } : null}
      more={{ count: more, onClick: () => open({ kind: "view", view: "my_tasks" }) }}
    >
      {/* The empty copy sits under the toggle rather than replacing it (the
          frame's own empty state would): „Heute“ being empty is exactly when
          the user wants to look at the week. */}
      <div className="dw-einsatz">
        {size !== "small" ? <RangeToggle range={range} onChange={setPicked} de={de} /> : null}
        {shown.length > 0 ? (
          <DayList
            days={shown}
            range={range}
            todayIso={todayIso}
            language={language}
            canManageTasks={canManageTasks}
            projectLabel={projectLabel}
            onOpen={openTask}
          />
        ) : (
          <p className="dashboard-widget__note">{emptyText}</p>
        )}
      </div>
    </DashboardWidgetFrame>
  );
}
