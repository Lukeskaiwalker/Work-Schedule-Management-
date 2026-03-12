import { useEffect, useState } from "react";
import { useAppContext } from "../context/AppContext";
import { addDaysISO, normalizeWeekStartISO, formatDayLabel, isoWeekdayMondayFirst } from "../utils/dates";
import { sortTasksByDueTime, formatTaskStartTime } from "../utils/tasks";
import { PenIcon } from "../components/icons";
import type { Language } from "../types";

const EN_DAY_COLS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const DE_DAY_COLS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"] as const;

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const DE_MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"] as const;

function monthAbbr(month: number, language: Language): string {
  return ((language === "de" ? DE_MONTHS : EN_MONTHS)[month - 1]) ?? "";
}

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

  const [isPhoneViewport, setIsPhoneViewport] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(max-width: 480px)").matches;
  });
  const [mobileDayIndex, setMobileDayIndex] = useState(0);
  const planningDays = planningWeek?.days ?? [];

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(max-width: 480px)");
    const onChange = () => setIsPhoneViewport(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!planningDays.length) {
      setMobileDayIndex(0);
      return;
    }
    setMobileDayIndex((current) => (current < planningDays.length ? current : 0));
  }, [planningDays.length]);

  if (mainView !== "planning") return null;

  const dayColLabels = language === "de" ? DE_DAY_COLS : EN_DAY_COLS;

  return (
    <section className="card planning-only">
      {/* ── Toolbar ── */}
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

      {/* ── Mobile day navigation ── */}
      {isPhoneViewport && planningDays.length > 0 && (
        <div className="row planning-mobile-day-nav" role="group" aria-label={language === "de" ? "Tag wechseln" : "Change day"}>
          <button
            type="button"
            className="icon-btn"
            aria-label={language === "de" ? "Vorheriger Tag" : "Previous day"}
            title={language === "de" ? "Vorheriger Tag" : "Previous day"}
            onClick={() => setMobileDayIndex((current) => Math.max(0, current - 1))}
            disabled={mobileDayIndex <= 0}
          >
            ←
          </button>
          <div className="planning-mobile-day-label">
            {formatDayLabel(planningDays[mobileDayIndex]?.date ?? "", language)}
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label={language === "de" ? "Nächster Tag" : "Next day"}
            title={language === "de" ? "Nächster Tag" : "Next day"}
            onClick={() => setMobileDayIndex((current) => Math.min(planningDays.length - 1, current + 1))}
            disabled={mobileDayIndex >= planningDays.length - 1}
          >
            →
          </button>
        </div>
      )}

      {/* ── Task type toggle ── */}
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

      {/* ── Calendar grid ── */}
      <div className="planning-calendar-scroll">
        <div className="planning-grid-unified">
          {planningDays.map((day, dayIndex) => {
            const isWeekend = isoWeekdayMondayFirst(day.date) >= 5;
            const isToday = day.date === todayIso;
            const dayNum = parseInt(day.date.split("-")[2] ?? "1", 10);
            const monthNum = parseInt(day.date.split("-")[1] ?? "1", 10);
            const dayTasks = sortTasksByDueTime(day.tasks);
            const absences = day.absences ?? [];

            const colClass = [
              "planning-col",
              isWeekend ? "planning-weekend-col" : "",
              isToday ? "planning-today-col" : "",
              isPhoneViewport
                ? dayIndex === mobileDayIndex
                  ? "planning-day-mobile-active"
                  : "planning-day-mobile-hidden"
                : "",
            ]
              .filter(Boolean)
              .join(" ");

            return (
              <div key={day.date} className={colClass}>
                {/* Column header: day name + date number badge */}
                <div className="planning-col-head">
                  <span className="planning-col-day-name">{dayColLabels[dayIndex]}</span>
                  <span className={isToday ? "planning-col-day-num today-num" : "planning-col-day-num"}>
                    {dayNum}
                  </span>
                  {dayNum === 1 && (
                    <span className="planning-col-month-label">{monthAbbr(monthNum, language)}</span>
                  )}
                </div>

                {/* Task / absence list */}
                <ul>
                  {absences.map((absence: any, index: number) => (
                    <li
                      key={`absence-${day.date}-${absence.type}-${String(absence.user_id)}-${index}`}
                      className="planning-absence"
                    >
                      <b>
                        {menuUserNameById(absence.user_id, absence.user_name)}: {absence.label}
                      </b>
                      <small>
                        {absence.type === "vacation"
                          ? language === "de" ? "Urlaub" : "Vacation"
                          : language === "de" ? "Schule" : "School"}
                      </small>
                    </li>
                  ))}
                  {dayTasks.map((task) => {
                    const isMine = isTaskAssignedToCurrentUser(task);
                    const taskProjectLabel = taskProjectTitleParts(task);
                    return (
                      <li
                        key={task.id}
                        className={
                          isMine
                            ? "planning-task planning-task-mine planning-task-clickable"
                            : "planning-task"
                        }
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
                          {task.start_time ? ` · ${formatTaskStartTime(task.start_time)}` : ""}
                          {" · "}
                          {getTaskAssigneeLabel(task)}
                        </small>
                        {taskProjectLabel.subtitle && (
                          <small className="project-name-subtle">{taskProjectLabel.subtitle}</small>
                        )}
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
                  {dayTasks.length === 0 && absences.length === 0 && (
                    <li className="planning-empty-cell" aria-hidden="true">–</li>
                  )}
                </ul>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
