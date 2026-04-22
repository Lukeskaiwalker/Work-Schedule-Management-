import { Fragment, useMemo, useState, useEffect, useCallback } from "react";
import { useAppContext } from "../context/AppContext";
import { addDaysISO, normalizeWeekStartISO, isoWeekInfo, isoWeekdayMondayFirst } from "../utils/dates";
import { sortTasksByDueTime, formatTaskTimeRange, normalizeTaskTypeValue } from "../utils/tasks";
import { TeamCalendarView } from "./TeamCalendarView";
import type { Language } from "../types";

const EN_DAY_COLS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
const DE_DAY_COLS = ["MO", "DI", "MI", "DO", "FR", "SA", "SO"] as const;

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const DE_MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"] as const;

function monthAbbr(month: number, language: Language): string {
  return ((language === "de" ? DE_MONTHS : EN_MONTHS)[month - 1]) ?? "";
}

const TEAM_USERS_LS_KEY = "smpl_team_calendar_users";

function readStoredTeamUsers(): Set<number> {
  try {
    const raw = localStorage.getItem(TEAM_USERS_LS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as number[];
    return new Set(Array.isArray(parsed) ? parsed.filter(Number.isFinite) : []);
  } catch {
    return new Set();
  }
}

function storeTeamUsers(ids: Set<number>) {
  try {
    localStorage.setItem(TEAM_USERS_LS_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    // ignore
  }
}

export function CalendarPage() {
  const {
    mainView,
    language,
    workspaceMode,
    calendarWeekStart,
    setCalendarWeekStart,
    calendarWeeks,
    calendarLoading,
    calendarRangeLabel,
    todayIso,
    isTaskAssignedToCurrentUser,
    taskProjectTitleParts,
    openTaskFromPlanning,
    menuUserNameById,
    assignableUsers,
    absenceTypes,
    publicHolidays,
  } = useAppContext();

  // ── Team Calendar local state ─────────────────────────────────
  const [viewMode, setViewMode] = useState<"my" | "team">("my");
  const [teamDay, setTeamDay] = useState<string>(todayIso);
  const [teamSelectedUserIds, setTeamSelectedUserIds] = useState<Set<number>>(readStoredTeamUsers);
  const [teamUserPickerOpen, setTeamUserPickerOpen] = useState(false);

  // Persist selected users to localStorage
  useEffect(() => {
    storeTeamUsers(teamSelectedUserIds);
  }, [teamSelectedUserIds]);

  // When teamDay falls outside the loaded calendar window, adjust the window
  useEffect(() => {
    if (viewMode !== "team") return;
    const loadedStart = calendarWeeks[0]?.week_start;
    const loadedEnd = calendarWeeks[calendarWeeks.length - 1]?.week_end;
    if (!loadedStart || !loadedEnd || teamDay < loadedStart || teamDay > loadedEnd) {
      setCalendarWeekStart(normalizeWeekStartISO(teamDay));
    }
  }, [teamDay, viewMode, calendarWeeks, setCalendarWeekStart]);

  // Reset to "my" mode if user switches to construction
  useEffect(() => {
    if (workspaceMode !== "office") {
      setViewMode("my");
    }
  }, [workspaceMode]);

  const toggleTeamUser = useCallback((userId: number) => {
    setTeamSelectedUserIds((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }, []);

  // Find the specific day's data for team view
  const teamDayData = useMemo(() => {
    for (const week of calendarWeeks) {
      const match = week.days.find((d) => d.date === teamDay);
      if (match) return match;
    }
    return null;
  }, [calendarWeeks, teamDay]);

  // Build a lookup map for fast O(1) holiday check per date string
  const holidayByDate = useMemo(() => {
    const map = new Map<string, string>();
    for (const h of publicHolidays) {
      map.set(h.date, h.name);
    }
    return map;
  }, [publicHolidays]);

  if (mainView !== "calendar") return null;

  const dayColLabels = language === "de" ? DE_DAY_COLS : EN_DAY_COLS;
  const absenceTypeLabel = (type: string) => {
    if (type === "vacation") return language === "de" ? "Urlaub" : "Vacation";
    const match = absenceTypes.find((entry) => entry.key === type);
    return match ? (language === "de" ? match.label_de : match.label_en) : type;
  };

  const de = language === "de";
  const showTeamToggle = workspaceMode === "office";
  const isTeamMode = viewMode === "team" && showTeamToggle;

  // Format team day label: "Mon, 14 Apr 2026"
  const teamDayLabel = (() => {
    const d = new Date(`${teamDay}T00:00:00`);
    if (Number.isNaN(d.getTime())) return teamDay;
    const locale = de ? "de-DE" : "en-US";
    return d.toLocaleDateString(locale, {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  })();

  const taskProjectTitle = (task: Parameters<typeof taskProjectTitleParts>[0]) => {
    const parts = taskProjectTitleParts(task);
    return parts.title ?? "";
  };

  return (
    <section className="calendar-page">
      {/* ── Toolbar ── */}
      <div className="calendar-page-toolbar">
        <h2 className="calendar-page-title">
          {isTeamMode
            ? de ? "Team-Kalender" : "Team Calendar"
            : de ? "4-Wochen-Übersicht" : "4-week overview"}
        </h2>

        {/* View mode toggle — only in Office mode */}
        {showTeamToggle && (
          <div className="calendar-view-toggle" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === "my"}
              className={viewMode === "my" ? "active" : ""}
              onClick={() => setViewMode("my")}
            >
              {de ? "Mein Kalender" : "My Calendar"}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === "team"}
              className={viewMode === "team" ? "active" : ""}
              onClick={() => setViewMode("team")}
            >
              {de ? "Team-Kalender" : "Team Calendar"}
            </button>
          </div>
        )}

        {/* Week range nav — only in "my" mode */}
        {!isTeamMode && (
          <div
            className="calendar-page-range-nav"
            role="group"
            aria-label={de ? "Kalenderzeitraum wechseln" : "Switch calendar range"}
          >
            <button
              type="button"
              className="calendar-page-nav-btn"
              aria-label={de ? "Vier Wochen zurück" : "Back four weeks"}
              onClick={() =>
                setCalendarWeekStart(normalizeWeekStartISO(addDaysISO(calendarWeekStart, -28)))
              }
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="m15 6-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <div className="calendar-page-range-label">
              <span>{calendarRangeLabel}</span>
              <input
                type="date"
                className="calendar-page-range-date"
                value={calendarWeekStart}
                onChange={(event) =>
                  setCalendarWeekStart(normalizeWeekStartISO(event.target.value))
                }
                aria-label={de ? "Startwoche wählen" : "Pick start week"}
              />
            </div>
            <button
              type="button"
              className="calendar-page-nav-btn"
              aria-label={de ? "Vier Wochen vor" : "Forward four weeks"}
              onClick={() =>
                setCalendarWeekStart(normalizeWeekStartISO(addDaysISO(calendarWeekStart, 28)))
              }
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        )}

        {/* Day nav — only in team mode */}
        {isTeamMode && (
          <div className="team-calendar-day-nav" role="group" aria-label={de ? "Tag wechseln" : "Change day"}>
            <button
              type="button"
              className="calendar-page-nav-btn"
              onClick={() => setTeamDay(addDaysISO(teamDay, -1))}
              aria-label={de ? "Vorheriger Tag" : "Previous day"}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="m15 6-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <div className="calendar-page-range-label">
              <span>{teamDayLabel}</span>
              <input
                type="date"
                className="calendar-page-range-date"
                value={teamDay}
                onChange={(event) => setTeamDay(event.target.value)}
                aria-label={de ? "Tag wählen" : "Pick day"}
              />
            </div>
            <button
              type="button"
              className="team-calendar-today-btn"
              onClick={() => setTeamDay(todayIso)}
            >
              {de ? "Heute" : "Today"}
            </button>
            <button
              type="button"
              className="calendar-page-nav-btn"
              onClick={() => setTeamDay(addDaysISO(teamDay, 1))}
              aria-label={de ? "Nächster Tag" : "Next day"}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* ── Team Calendar body ── */}
      {isTeamMode && (
        <TeamCalendarView
          day={teamDayData}
          selectedUserIds={teamSelectedUserIds}
          onToggleUser={toggleTeamUser}
          assignableUsers={assignableUsers}
          userPickerOpen={teamUserPickerOpen}
          onSetUserPickerOpen={setTeamUserPickerOpen}
          language={language}
          loading={calendarLoading}
          openTaskFromPlanning={openTaskFromPlanning}
          menuUserNameById={menuUserNameById}
          absenceTypeLabel={absenceTypeLabel}
          taskProjectTitle={taskProjectTitle}
        />
      )}

      {/* ── My Calendar body (existing 4-week grid) ── */}
      {!isTeamMode && (
        <>
          {calendarLoading ? (
            <div className="calendar-page-empty muted">
              {de ? "Lade Kalender…" : "Loading calendar…"}
            </div>
          ) : calendarWeeks.length === 0 ? (
            <div className="calendar-page-empty muted">
              {de ? "Keine Kalendereinträge." : "No calendar entries."}
            </div>
          ) : (
            <div className="calendar-page-card">
              <div className="calendar-page-grid" role="grid">
                <div className="calendar-page-corner" role="columnheader" aria-hidden="true" />
                {dayColLabels.map((label, i) => (
                  <div
                    key={label}
                    className={`calendar-page-col-header${i >= 5 ? " calendar-page-col-header--weekend" : ""}`}
                    role="columnheader"
                  >
                    {label}
                  </div>
                ))}

                {calendarWeeks.map((week) => {
                  const weekInfo = isoWeekInfo(week.week_start);
                  return (
                    <Fragment key={week.week_start}>
                      <div
                        className="calendar-page-week-num"
                        aria-label={`${de ? "Kalenderwoche" : "Week"} ${weekInfo.week}`}
                        role="rowheader"
                      >
                        <span className="calendar-page-week-num-label">{de ? "KW" : "W"}</span>
                        <span className="calendar-page-week-num-value">{weekInfo.week}</span>
                      </div>

                      {week.days.map((day) => {
                        const dayNum = parseInt(day.date.split("-")[2] ?? "1", 10);
                        const monthNum = parseInt(day.date.split("-")[1] ?? "1", 10);
                        const isWeekend = isoWeekdayMondayFirst(day.date) >= 5;
                        const isToday = day.date === todayIso;
                        const holidayName = holidayByDate.get(day.date);
                        const dayTasks = sortTasksByDueTime(day.tasks);
                        const absences = day.absences ?? [];

                        const cellClass = [
                          "calendar-page-day",
                          isWeekend ? "calendar-page-day--weekend" : "",
                          isToday ? "calendar-page-day--today" : "",
                          holidayName ? "calendar-page-day--holiday" : "",
                        ]
                          .filter(Boolean)
                          .join(" ");

                        return (
                          <article key={day.date} className={cellClass} role="gridcell">
                            <header className="calendar-page-day-head">
                              <span className="calendar-page-day-num">{dayNum}</span>
                              {isToday && (
                                <span className="calendar-page-today-pill">
                                  {de ? "heute" : "today"}
                                </span>
                              )}
                              {dayNum === 1 && (
                                <span className="calendar-page-day-month">
                                  {monthAbbr(monthNum, language)}
                                </span>
                              )}
                            </header>
                            <ul className="calendar-page-day-list">
                              {holidayName && (
                                <li
                                  className="calendar-page-event calendar-page-event--holiday"
                                  title={holidayName}
                                >
                                  <span>{holidayName}</span>
                                </li>
                              )}
                              {absences.map((absence: any, idx: number) => (
                                <li
                                  key={`absence-${day.date}-${String(absence.user_id)}-${idx}`}
                                  className="calendar-page-event calendar-page-event--absence"
                                >
                                  <span>
                                    {menuUserNameById(absence.user_id, absence.user_name)} —{" "}
                                    {absenceTypeLabel(absence.type)}
                                  </span>
                                </li>
                              ))}
                              {dayTasks.map((task) => {
                                const isMine = isTaskAssignedToCurrentUser(task);
                                const taskProjectLabel = taskProjectTitleParts(task);
                                const taskType = normalizeTaskTypeValue(task.task_type);
                                const isDone = task.status === "done";
                                const classes = [
                                  "calendar-page-event",
                                  `calendar-page-event--${taskType}`,
                                  isMine ? "calendar-page-event--mine" : "",
                                  isMine ? "calendar-page-event--clickable" : "",
                                  isDone ? "calendar-page-event--done" : "",
                                ]
                                  .filter(Boolean)
                                  .join(" ");
                                const timeSuffix = task.start_time
                                  ? ` ${formatTaskTimeRange(task)}`
                                  : "";
                                return (
                                  <li
                                    key={`task-${day.date}-${task.id}`}
                                    className={classes}
                                    onClick={isMine ? () => openTaskFromPlanning(task) : undefined}
                                    onKeyDown={
                                      isMine
                                        ? (event) => {
                                            if (event.key === "Enter" || event.key === " ") {
                                              event.preventDefault();
                                              openTaskFromPlanning(task);
                                            }
                                          }
                                        : undefined
                                    }
                                    role={isMine ? "button" : undefined}
                                    tabIndex={isMine ? 0 : undefined}
                                    title={
                                      taskProjectLabel.title
                                        ? `${task.title} — ${taskProjectLabel.title}`
                                        : task.title
                                    }
                                  >
                                    <span>
                                      {task.title}
                                      {timeSuffix}
                                    </span>
                                  </li>
                                );
                              })}
                            </ul>
                          </article>
                        );
                      })}
                    </Fragment>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
