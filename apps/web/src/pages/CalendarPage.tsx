import { Fragment, useMemo } from "react";
import { useAppContext } from "../context/AppContext";
import { addDaysISO, normalizeWeekStartISO, isoWeekInfo, isoWeekdayMondayFirst } from "../utils/dates";
import { sortTasksByDueTime, formatTaskTimeRange } from "../utils/tasks";
import type { Language } from "../types";

const EN_DAY_COLS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const DE_DAY_COLS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"] as const;

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const DE_MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"] as const;

function monthAbbr(month: number, language: Language): string {
  return ((language === "de" ? DE_MONTHS : EN_MONTHS)[month - 1]) ?? "";
}

export function CalendarPage() {
  const {
    mainView,
    language,
    calendarWeekStart,
    setCalendarWeekStart,
    calendarWeeks,
    calendarLoading,
    calendarRangeLabel,
    todayIso,
    isTaskAssignedToCurrentUser,
    taskProjectTitleParts,
    openTaskFromPlanning,
    openProjectFromTask,
    menuUserNameById,
    absenceTypes,
    publicHolidays,
  } = useAppContext();

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

  return (
    <section className="card calendar-overview">
      {/* ── Toolbar ── */}
      <div className="row wrap planning-toolbar">
        <h3>{language === "de" ? "4-Wochen-Übersicht" : "4-week overview"}</h3>
        <div
          className="row planning-week-nav"
          role="group"
          aria-label={language === "de" ? "Kalenderzeitraum wechseln" : "Switch calendar range"}
        >
          <button
            type="button"
            className="icon-btn"
            aria-label={language === "de" ? "Vier Wochen zurück" : "Back four weeks"}
            title={language === "de" ? "Vier Wochen zurück" : "Back four weeks"}
            onClick={() => setCalendarWeekStart(normalizeWeekStartISO(addDaysISO(calendarWeekStart, -28)))}
          >
            ←
          </button>
          <div className="calendar-range-pill">{calendarRangeLabel}</div>
          <button
            type="button"
            className="icon-btn"
            aria-label={language === "de" ? "Vier Wochen vor" : "Forward four weeks"}
            title={language === "de" ? "Vier Wochen vor" : "Forward four weeks"}
            onClick={() => setCalendarWeekStart(normalizeWeekStartISO(addDaysISO(calendarWeekStart, 28)))}
          >
            →
          </button>
        </div>
        <label className="planning-week-picker">
          {language === "de" ? "Startwoche (Montag)" : "Start week (Monday)"}
          <input
            type="date"
            value={calendarWeekStart}
            onChange={(event) => setCalendarWeekStart(normalizeWeekStartISO(event.target.value))}
            required
          />
        </label>
      </div>

      {/* ── Body ── */}
      {calendarLoading ? (
        <small className="muted">{language === "de" ? "Lade Kalender…" : "Loading calendar…"}</small>
      ) : calendarWeeks.length === 0 ? (
        <small className="muted">{language === "de" ? "Keine Kalendereinträge." : "No calendar entries."}</small>
      ) : (
        <div className="calendar-grid-scroll">
          <div className="calendar-grid" role="grid">

            {/* Row 0: corner + day-name column headers */}
            <div className="calendar-cell calendar-corner" role="columnheader" aria-hidden="true" />
            {dayColLabels.map((label, i) => (
              <div
                key={label}
                className={`calendar-cell calendar-col-header${i >= 5 ? " calendar-weekend" : ""}`}
                role="columnheader"
              >
                {label}
              </div>
            ))}

            {/* Rows 1-4: one row per week */}
            {calendarWeeks.map((week) => {
              const weekInfo = isoWeekInfo(week.week_start);
              return (
                <Fragment key={week.week_start}>
                  {/* Week-number cell */}
                  <div
                    className="calendar-cell calendar-week-num-cell"
                    aria-label={`${language === "de" ? "Kalenderwoche" : "Week"} ${weekInfo.week}`}
                    role="rowheader"
                  >
                    <span className="calendar-cw-label">{language === "de" ? "KW" : "W"}</span>
                    <span className="calendar-cw-number">{weekInfo.week}</span>
                  </div>

                  {/* 7 day cells */}
                  {week.days.map((day) => {
                    const dayNum = parseInt(day.date.split("-")[2] ?? "1", 10);
                    const monthNum = parseInt(day.date.split("-")[1] ?? "1", 10);
                    const isWeekend = isoWeekdayMondayFirst(day.date) >= 5;
                    const isToday = day.date === todayIso;
                    const holidayName = holidayByDate.get(day.date);
                    const dayTasks = sortTasksByDueTime(day.tasks);
                    const absences = day.absences ?? [];

                    return (
                      <article
                        key={day.date}
                        className={[
                          "calendar-cell calendar-day-cell",
                          isWeekend ? "calendar-weekend" : "",
                          isToday ? "calendar-today" : "",
                          holidayName ? "calendar-holiday" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        role="gridcell"
                      >
                        {/* Day number header */}
                        <div className="calendar-day-head">
                          <span className={isToday ? "calendar-day-num today-num" : "calendar-day-num"}>
                            {dayNum}
                          </span>
                          {dayNum === 1 && (
                            <span className="calendar-day-month-label">
                              {monthAbbr(monthNum, language)}
                            </span>
                          )}
                        </div>

                        {/* Events list */}
                        <ul className="calendar-day-list">
                          {holidayName && (
                            <li className="calendar-public-holiday" title={holidayName}>
                              <span className="calendar-holiday-icon">🎌</span>
                              <b>{holidayName}</b>
                            </li>
                          )}
                          {absences.map((absence: any, idx: number) => (
                            <li
                              key={`absence-${day.date}-${String(absence.user_id)}-${idx}`}
                              className="calendar-absence"
                            >
                              <b>{menuUserNameById(absence.user_id, absence.user_name)}</b>
                              <small>
                                {absenceTypeLabel(absence.type)}
                              </small>
                            </li>
                          ))}
                          {dayTasks.map((task) => {
                            const isMine = isTaskAssignedToCurrentUser(task);
                            const taskProjectLabel = taskProjectTitleParts(task);
                            return (
                              <li
                                key={`task-${day.date}-${task.id}`}
                                className={[
                                  "calendar-task",
                                  isMine ? "calendar-task-mine calendar-task-clickable" : "",
                                  task.status === "done" ? "calendar-task-done" : "",
                                ]
                                  .filter(Boolean)
                                  .join(" ")}
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
                              >
                                <b>{task.title}</b>
                                <small>
                                  <button
                                    type="button"
                                    className="linklike"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      openProjectFromTask(task, null);
                                    }}
                                  >
                                    {taskProjectLabel.title}
                                  </button>
                                  {task.start_time ? ` · ${formatTaskTimeRange(task)}` : ""}
                                </small>
                                {taskProjectLabel.subtitle && (
                                  <small className="project-name-subtle">{taskProjectLabel.subtitle}</small>
                                )}
                              </li>
                            );
                          })}
                          {dayTasks.length === 0 && absences.length === 0 && !holidayName && (
                            <li className="calendar-empty-cell" aria-hidden="true">–</li>
                          )}
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
    </section>
  );
}
