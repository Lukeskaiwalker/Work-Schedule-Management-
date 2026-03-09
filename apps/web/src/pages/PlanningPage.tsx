import { useAppContext } from "../context/AppContext";
import { addDaysISO, normalizeWeekStartISO, formatDayLabel } from "../utils/dates";
import { sortTasksByDueTime, formatTaskStartTime } from "../utils/tasks";
import { PenIcon } from "../components/icons";

export function PlanningPage() {
  const {
    mainView,
    language,
    planningWeekStart,
    setPlanningWeekStart,
    planningWeek,
    planningWeekInfo,
    planningTaskTypeView,
    setPlanningTaskTypeView,
    todayIso,
    canManageTasks,
    isTaskAssignedToCurrentUser,
    getTaskAssigneeLabel,
    taskProjectTitleParts,
    openTaskFromPlanning,
    openProjectFromTask,
    openTaskEditModal,
    exportTaskCalendar,
    markTaskDone,
    menuUserNameById,
  } = useAppContext();

  if (mainView !== "planning") return null;

  return (
    <section className="card planning-only">
      <div className="row wrap planning-toolbar">
        <h3>{language === "de" ? "Kalenderansicht" : "Calendar view"}</h3>
        <div className="row planning-week-nav" role="group" aria-label={language === "de" ? "Wochenwechsel" : "Week switch"}>
          <button
            type="button"
            className="icon-btn"
            aria-label={language === "de" ? "Vorherige Woche" : "Previous week"}
            title={language === "de" ? "Vorherige Woche" : "Previous week"}
            onClick={() => setPlanningWeekStart(normalizeWeekStartISO(addDaysISO(planningWeekStart, -7)))}
          >
            ←
          </button>
          <div className="planning-week-number">
            {language === "de" ? "KW" : "CW"} {planningWeekInfo.week}/{planningWeekInfo.year}
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label={language === "de" ? "Nächste Woche" : "Next week"}
            title={language === "de" ? "Nächste Woche" : "Next week"}
            onClick={() => setPlanningWeekStart(normalizeWeekStartISO(addDaysISO(planningWeekStart, 7)))}
          >
            →
          </button>
        </div>
        <label className="planning-week-picker">
          {language === "de" ? "Wochenstart (Montag)" : "Week start (Monday)"}
          <input
            type="date"
            value={planningWeekStart}
            onChange={(e) => setPlanningWeekStart(normalizeWeekStartISO(e.target.value))}
            required
          />
        </label>
      </div>
      <div className="row wrap task-view-toggle planning-task-type-toggle">
        <button
          type="button"
          className={planningTaskTypeView === "construction" ? "active" : ""}
          onClick={() => setPlanningTaskTypeView("construction")}
        >
          {language === "de" ? "Baustellenaufgaben" : "Construction tasks"}
        </button>
        <button
          type="button"
          className={planningTaskTypeView === "office" ? "active" : ""}
          onClick={() => setPlanningTaskTypeView("office")}
        >
          {language === "de" ? "Büroaufgaben" : "Office tasks"}
        </button>
        <button
          type="button"
          className={planningTaskTypeView === "customer_appointment" ? "active" : ""}
          onClick={() => setPlanningTaskTypeView("customer_appointment")}
        >
          {language === "de" ? "Kundentermine" : "Customer appointments"}
        </button>
      </div>
      <div className="planning-calendar-scroll">
        <div className="planning-calendar">
        {(planningWeek?.days ?? []).map((day) => {
          const dayTasks = sortTasksByDueTime(day.tasks);
          return (
            <div key={day.date} className={day.date === todayIso ? "planning-day planning-day-today" : "planning-day"}>
              <div className="planning-day-head">{formatDayLabel(day.date, language)}</div>
              <ul>
              {(day.absences ?? []).map((absence: any, index: number) => (
                <li key={`absence-${day.date}-${absence.type}-${absence.user_id}-${index}`} className="planning-absence">
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
                    key={task.id}
                    className={isMine ? "planning-task planning-task-mine planning-task-clickable" : "planning-task"}
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
                      </button>{" "}
                      {task.start_time ? ` | ${formatTaskStartTime(task.start_time)}` : ""} | {getTaskAssigneeLabel(task)}
                    </small>
                    {taskProjectLabel.subtitle && <small className="project-name-subtle">{taskProjectLabel.subtitle}</small>}
                    <div className="row wrap task-actions task-actions-left">
                      {canManageTasks && (
                        <button
                          type="button"
                          className="icon-btn task-edit-icon-btn"
                          onClick={(event) => {
                            event.stopPropagation();
                            openTaskEditModal(task);
                          }}
                          aria-label={language === "de" ? "Aufgabe bearbeiten" : "Edit task"}
                          title={language === "de" ? "Aufgabe bearbeiten" : "Edit task"}
                        >
                          <PenIcon />
                        </button>
                      )}
                      {isMine && (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void exportTaskCalendar(task);
                          }}
                        >
                          {language === "de" ? "Kalender" : "Calendar"}
                        </button>
                      )}
                      {isMine && task.status !== "done" && (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void markTaskDone(task);
                          }}
                        >
                          {language === "de" ? "Erledigt" : "Complete"}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
              {dayTasks.length === 0 && (day.absences ?? []).length === 0 && <li className="muted">-</li>}
              </ul>
            </div>
          );
        })}
        </div>
      </div>
    </section>
  );
}
