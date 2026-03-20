import { useEffect, useState } from "react";
import { useAppContext } from "../context/AppContext";
import { addDaysISO, normalizeWeekStartISO, formatDayLabel, isoWeekdayMondayFirst } from "../utils/dates";
import { sortTasksByDueTime, formatTaskTimeRange } from "../utils/tasks";
import { PenIcon } from "../components/icons";
import type { Language } from "../types";

const EN_DAY_COLS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const DE_DAY_COLS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"] as const;

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const DE_MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"] as const;

type MobileViewMode = "single" | "list" | "scroll";
const MOBILE_VIEW_LS_KEY = "planning-mobile-view";

/** Read from localStorage as a local fallback (used before server data loads). */
function getLocalMobileViewPref(): MobileViewMode {
  try {
    const v = localStorage.getItem(MOBILE_VIEW_LS_KEY);
    if (v === "single" || v === "list" || v === "scroll") return v;
  } catch {}
  return "single";
}

/** Keep localStorage in sync so the value is available instantly on next load
 *  before the user object arrives from the server. */
function cacheLocalMobileViewPref(mode: MobileViewMode) {
  try { localStorage.setItem(MOBILE_VIEW_LS_KEY, mode); } catch {}
}

function monthAbbr(month: number, language: Language): string {
  return ((language === "de" ? DE_MONTHS : EN_MONTHS)[month - 1]) ?? "";
}

export function PlanningPage() {
  const {
    mainView,
    language,
    user,
    saveUserPreference,
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
    absenceTypes,
  } = useAppContext();

  const [isPhoneViewport, setIsPhoneViewport] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(max-width: 480px)").matches;
  });
  const [mobileDayIndex, setMobileDayIndex] = useState(0);
  // Initialise from localStorage for instant paint; server value synced below.
  const [mobileViewMode, setMobileViewMode] = useState<MobileViewMode>(getLocalMobileViewPref);
  const planningDays = planningWeek?.days ?? [];

  const de = language === "de";

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

  // Sync the authoritative server value whenever the user object arrives/updates.
  useEffect(() => {
    const serverPref = user?.preferences?.planning_mobile_view;
    if (serverPref) {
      setMobileViewMode(serverPref);
      cacheLocalMobileViewPref(serverPref); // keep LS in sync
    }
  }, [user?.preferences?.planning_mobile_view]);

  function switchMobileView(mode: MobileViewMode) {
    setMobileViewMode(mode);
    cacheLocalMobileViewPref(mode);          // instant local cache
    void saveUserPreference("planning_mobile_view", mode); // persist to server
  }

  if (mainView !== "planning") return null;

  const dayColLabels = de ? DE_DAY_COLS : EN_DAY_COLS;
  const absenceTypeLabel = (type: string) => {
    if (type === "vacation") return de ? "Urlaub" : "Vacation";
    const match = absenceTypes.find((entry) => entry.key === type);
    return match ? (de ? match.label_de : match.label_en) : type;
  };

  // Grid modifier class depends on mobile view mode
  const gridClass = [
    "planning-grid-unified",
    isPhoneViewport && mobileViewMode === "list" ? "planning-grid-mobile-list" : "",
    isPhoneViewport && mobileViewMode === "scroll" ? "planning-grid-mobile-scroll" : "",
  ].filter(Boolean).join(" ");

  return (
    <section className="card planning-only">
      {/* ── Toolbar ── */}
      <div className="row wrap planning-toolbar">
        <h3>{de ? "Kalenderansicht" : "Calendar view"}</h3>
        <div className="row planning-week-nav" role="group" aria-label={de ? "Wochenwechsel" : "Week switch"}>
          <button
            type="button"
            className="icon-btn"
            aria-label={de ? "Vorherige Woche" : "Previous week"}
            title={de ? "Vorherige Woche" : "Previous week"}
            onClick={() => setPlanningWeekStart(normalizeWeekStartISO(addDaysISO(planningWeekStart, -7)))}
          >
            ←
          </button>
          <div className="planning-week-number">
            {de ? "KW" : "CW"} {planningWeekInfo.week}/{planningWeekInfo.year}
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label={de ? "Nächste Woche" : "Next week"}
            title={de ? "Nächste Woche" : "Next week"}
            onClick={() => setPlanningWeekStart(normalizeWeekStartISO(addDaysISO(planningWeekStart, 7)))}
          >
            →
          </button>
        </div>
        <label className="planning-week-picker">
          {de ? "Wochenstart (Montag)" : "Week start (Monday)"}
          <input
            type="date"
            value={planningWeekStart}
            onChange={(e) => setPlanningWeekStart(normalizeWeekStartISO(e.target.value))}
            required
          />
        </label>
      </div>

      {/* ── Mobile view mode toggle (phone only) ── */}
      {isPhoneViewport && (
        <div className="planning-mobile-view-toggle" role="group" aria-label={de ? "Anzeigemodus" : "Display mode"}>
          <button
            type="button"
            className={mobileViewMode === "single" ? "active" : ""}
            onClick={() => switchMobileView("single")}
            title={de ? "Ein Tag" : "Single day"}
          >
            ◱ {de ? "Tag" : "Day"}
          </button>
          <button
            type="button"
            className={mobileViewMode === "list" ? "active" : ""}
            onClick={() => switchMobileView("list")}
            title={de ? "Alle Tage als Liste" : "All days as list"}
          >
            ☰ {de ? "Liste" : "List"}
          </button>
          <button
            type="button"
            className={mobileViewMode === "scroll" ? "active" : ""}
            onClick={() => switchMobileView("scroll")}
            title={de ? "Woche horizontal scrollen" : "Horizontal week scroll"}
          >
            ⟷ {de ? "Woche" : "Week"}
          </button>
        </div>
      )}

      {/* ── Single-day nav (only in "single" mode on phone) ── */}
      {isPhoneViewport && mobileViewMode === "single" && planningDays.length > 0 && (
        <div className="row planning-mobile-day-nav" role="group" aria-label={de ? "Tag wechseln" : "Change day"}>
          <button
            type="button"
            className="icon-btn"
            aria-label={de ? "Vorheriger Tag" : "Previous day"}
            title={de ? "Vorheriger Tag" : "Previous day"}
            onClick={() => setMobileDayIndex((c) => Math.max(0, c - 1))}
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
            aria-label={de ? "Nächster Tag" : "Next day"}
            title={de ? "Nächster Tag" : "Next day"}
            onClick={() => setMobileDayIndex((c) => Math.min(planningDays.length - 1, c + 1))}
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
          {de ? "Baustellenaufgaben" : "Construction tasks"}
        </button>
        <button
          type="button"
          className={planningTaskTypeView === "office" ? "active" : ""}
          onClick={() => setPlanningTaskTypeView("office")}
        >
          {de ? "Büroaufgaben" : "Office tasks"}
        </button>
        <button
          type="button"
          className={planningTaskTypeView === "customer_appointment" ? "active" : ""}
          onClick={() => setPlanningTaskTypeView("customer_appointment")}
        >
          {de ? "Kundentermine" : "Customer appointments"}
        </button>
      </div>

      {/* ── Calendar grid ── */}
      <div className="planning-calendar-scroll">
        <div className={gridClass}>
          {planningDays.map((day, dayIndex) => {
            const isWeekend = isoWeekdayMondayFirst(day.date) >= 5;
            const isToday = day.date === todayIso;
            const dayNum = parseInt(day.date.split("-")[2] ?? "1", 10);
            const monthNum = parseInt(day.date.split("-")[1] ?? "1", 10);
            const dayTasks = sortTasksByDueTime(day.tasks);
            const absences = day.absences ?? [];

            // Hide/show logic: only in "single" mobile mode
            const mobileVisClass =
              isPhoneViewport && mobileViewMode === "single"
                ? dayIndex === mobileDayIndex
                  ? "planning-day-mobile-active"
                  : "planning-day-mobile-hidden"
                : "";

            const colClass = [
              "planning-col",
              isWeekend ? "planning-weekend-col" : "",
              isToday ? "planning-today-col" : "",
              mobileVisClass,
            ]
              .filter(Boolean)
              .join(" ");

            return (
              <div key={day.date} className={colClass}>
                {/* Column header */}
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
                        {absenceTypeLabel(absence.type)}
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
                          {task.start_time ? ` · ${formatTaskTimeRange(task)}` : ""}
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
                              aria-label={de ? "Aufgabe bearbeiten" : "Edit task"}
                              title={de ? "Aufgabe bearbeiten" : "Edit task"}
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
                              {de ? "Kalender" : "Calendar"}
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
                              {de ? "Erledigt" : "Complete"}
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
