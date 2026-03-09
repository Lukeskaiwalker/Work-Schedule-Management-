import { useAppContext } from "../context/AppContext";
import { addDaysISO, normalizeWeekStartISO, isoWeekInfo, formatDayLabel } from "../utils/dates";
import { sortTasksByDueTime, formatTaskStartTime } from "../utils/tasks";

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
  } = useAppContext();

  if (mainView !== "calendar") return null;

  return (
    <section className="card calendar-overview">
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

      {calendarLoading ? (
        <small className="muted">{language === "de" ? "Lade Kalender..." : "Loading calendar..."}</small>
      ) : (
        <div className="calendar-weeks-grid">
          {calendarWeeks.map((week) => {
            const weekInfo = isoWeekInfo(week.week_start);
            return (
              <section key={`calendar-week-${week.week_start}`} className="calendar-week-card">
                <div className="calendar-week-head">
                  <b>
                    {language === "de" ? "KW" : "CW"} {weekInfo.week}/{weekInfo.year}
                  </b>
                  <small>
                    {formatDayLabel(week.week_start, language)} - {formatDayLabel(week.week_end, language)}
                  </small>
                </div>
                <div className="calendar-week-days">
                  {week.days.map((day) => {
                    const dayTasks = sortTasksByDueTime(day.tasks);
                    return (
                      <article
                        key={`calendar-day-${week.week_start}-${day.date}`}
                        className={day.date === todayIso ? "calendar-day-cell today" : "calendar-day-cell"}
                      >
                        <div className="calendar-day-head">{formatDayLabel(day.date, language)}</div>
                        <ul className="calendar-day-list">
                        {(day.absences ?? []).map((absence: any, index: number) => (
                          <li
                            key={`calendar-absence-${day.date}-${absence.type}-${absence.user_id}-${index}`}
                            className="calendar-absence"
                          >
                            <b>
                              {menuUserNameById(absence.user_id, absence.user_name)}: {absence.label}
                            </b>
                            <small>
                              {absence.type === "vacation"
                                ? language === "de"
                                  ? "Urlaub"
                                  : "Vacation"
                                : language === "de"
                                  ? "Schule"
                                  : "School"}
                            </small>
                          </li>
                        ))}
                        {dayTasks.map((task) => {
                          const isMine = isTaskAssignedToCurrentUser(task);
                          const taskProjectLabel = taskProjectTitleParts(task);
                          return (
                            <li
                              key={`calendar-task-${day.date}-${task.id}`}
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
                                {task.start_time ? ` | ${formatTaskStartTime(task.start_time)}` : ""}
                              </small>
                              {taskProjectLabel.subtitle && <small className="project-name-subtle">{taskProjectLabel.subtitle}</small>}
                            </li>
                          );
                        })}
                        {dayTasks.length === 0 && (day.absences ?? []).length === 0 && (
                          <li className="muted">-</li>
                        )}
                        </ul>
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })}
          {calendarWeeks.length === 0 && (
            <small className="muted">{language === "de" ? "Keine Kalendereinträge." : "No calendar entries."}</small>
          )}
        </div>
      )}
    </section>
  );
}
