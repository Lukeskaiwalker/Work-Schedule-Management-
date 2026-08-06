import { useEffect, useMemo, useState } from "react";
import { useAppContext } from "../context/AppContext";
import { addDaysISO, normalizeWeekStartISO, formatDayLabel, isoWeekdayMondayFirst } from "../utils/dates";
import { sortTasksByDueTime, formatTaskTimeRange } from "../utils/tasks";
import { PenIcon } from "../components/icons";
import { CustomerConfirmationDot } from "../components/tasks/CustomerConfirmationDot";
import type { Language, Task } from "../types";

/** Weekly board rendering mode. */
type BoardMode = "einsaetze" | "tasks";

/**
 * One customer's deployment on one day — the unit field crews think in
 * ("mein Einsatz"): who the customer is, which Monteure are there, and the
 * tasks behind it.
 */
type Einsatz = {
  key: string;
  date: string;
  customerId: number | null;
  label: string;
  tasks: Task[];
};

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
    workspaceMode,
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
    customers,
    projects,
    openTaskFromPlanning,
    openProjectFromTask,
    openTaskModal,
    openTaskEditModal,
    exportTaskCalendar,
    markTaskDone,
    menuUserNameById,
    absenceTypes,
    publicHolidays,
  } = useAppContext();

  // Map holidays by date once per render so the per-column lookup below is
  // O(1) instead of O(n) for the week. `publicHolidays` covers the year(s)
  // the user is viewing, so a small flat Map is plenty.
  const holidayByDate = useMemo(() => {
    const map = new Map<string, { name: string; date: string }>();
    for (const h of publicHolidays) map.set(h.date, h);
    return map;
  }, [publicHolidays]);

  // ── Einsatz (deployment) board ─────────────────────────────────────────
  // Field crews read the week as "which customer am I at, with whom" — not as
  // a list of individual tasks. In Einsatz mode each day column shows one row
  // per CUSTOMER with the Monteure deployed there; clicking it opens that day's
  // tasks in a sheet. Task mode keeps the flat per-task list (office planners
  // rely on it), so the two audiences aren't traded off against each other.
  const [boardMode, setBoardMode] = useState<BoardMode>(
    workspaceMode === "office" ? "tasks" : "einsaetze",
  );
  const [openEinsatz, setOpenEinsatz] = useState<Einsatz | null>(null);

  // Follow the workspace when the user flips Baustelle/Büro, so each mode lands
  // on the view its audience expects.
  useEffect(() => {
    setBoardMode(workspaceMode === "office" ? "tasks" : "einsaetze");
    setOpenEinsatz(null);
  }, [workspaceMode]);

  const customerNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const c of customers) map.set(c.id, c.name);
    return map;
  }, [customers]);

  const projectById = useMemo(() => {
    const map = new Map<number, (typeof projects)[number]>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  /** Customer a task belongs to: its own link, else its project's. */
  function resolveTaskCustomerId(task: Task): number | null {
    if (task.customer_id != null) return task.customer_id;
    if (task.project_id != null) return projectById.get(task.project_id)?.customer_id ?? null;
    return null;
  }

  /** Assignees (Monteure) on a task, tolerating the legacy single-assignee column. */
  function taskAssigneeIds(task: Task): number[] {
    if (task.assignee_ids && task.assignee_ids.length > 0) return task.assignee_ids;
    return task.assignee_id != null ? [task.assignee_id] : [];
  }

  /**
   * Collapse a day's tasks into one Einsatz per customer.
   *
   * Tasks with no resolvable customer (legacy project-only rows whose project
   * has no customer) fall back to grouping by project so nothing disappears
   * from the board; anything with neither lands in a single "Ohne Kunde" row.
   */
  function buildEinsaetze(dayDate: string, dayTasks: Task[]): Einsatz[] {
    const groups = new Map<string, Einsatz>();
    for (const task of dayTasks) {
      const customerId = resolveTaskCustomerId(task);
      const projectLabel = taskProjectTitleParts(task);
      let key: string;
      let label: string;
      if (customerId != null) {
        key = `customer:${customerId}`;
        label =
          customerNameById.get(customerId) ||
          (task.project_id != null ? projectById.get(task.project_id)?.customer_name : null) ||
          projectLabel.title ||
          (de ? "Unbekannter Kunde" : "Unknown customer");
      } else if (task.project_id != null) {
        key = `project:${task.project_id}`;
        label = projectLabel.title || `#${task.project_id}`;
      } else {
        key = "none";
        label = de ? "Ohne Kunde" : "No customer";
      }

      const existing = groups.get(key);
      if (existing) {
        existing.tasks.push(task);
      } else {
        groups.set(key, {
          key: `${dayDate}-${key}`,
          date: dayDate,
          customerId,
          label,
          tasks: [task],
        });
      }
    }

    // Stable ordering: earliest start time first, then alphabetically.
    return Array.from(groups.values()).sort((a, b) => {
      const aStart = a.tasks.find((t) => t.start_time)?.start_time ?? "99:99";
      const bStart = b.tasks.find((t) => t.start_time)?.start_time ?? "99:99";
      if (aStart !== bStart) return aStart.localeCompare(bStart);
      return a.label.localeCompare(b.label, de ? "de" : "en");
    });
  }

  /** Distinct Monteure across an Einsatz, in stable order. */
  function einsatzAssigneeNames(einsatz: Einsatz): string[] {
    const seen = new Set<number>();
    const names: string[] = [];
    for (const task of einsatz.tasks) {
      for (const id of taskAssigneeIds(task)) {
        if (seen.has(id)) continue;
        seen.add(id);
        names.push(menuUserNameById(id, `#${id}`));
      }
    }
    return names;
  }

  /** "07:30 – 16:00" across an Einsatz, or "" when nothing is timed.
   *  The API sends "HH:MM:SS"; the board only ever wants HH:MM. */
  function einsatzTimeLabel(einsatz: Einsatz): string {
    const hhmm = (value: string) => value.slice(0, 5);
    const starts = einsatz.tasks.map((t) => t.start_time).filter(Boolean) as string[];
    const ends = einsatz.tasks.map((t) => t.end_time).filter(Boolean) as string[];
    if (starts.length === 0) return "";
    const start = starts.slice().sort()[0];
    const end = ends.length > 0 ? ends.slice().sort().reverse()[0] : null;
    return end && end > start ? `${hhmm(start)} – ${hhmm(end)}` : hhmm(start);
  }

  const [isPhoneViewport, setIsPhoneViewport] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(max-width: 767px)").matches;
  });
  const [mobileDayIndex, setMobileDayIndex] = useState(0);
  // Initialise from localStorage for instant paint; server value synced below.
  const [mobileViewMode, setMobileViewMode] = useState<MobileViewMode>(getLocalMobileViewPref);
  const planningDays = planningWeek?.days ?? [];

  const de = language === "de";

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(max-width: 767px)");
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
  const showProjectRows = workspaceMode === "office";
  const absenceTypeLabel = (type: string) => {
    if (type === "vacation") return de ? "Urlaub" : "Vacation";
    const match = absenceTypes.find((entry) => entry.key === type);
    return match ? (de ? match.label_de : match.label_en) : type;
  };

  // Grid modifier class depends on mobile view mode.
  // On mobile (<768px), always use list mode for the Paper flat-card layout.
  const effectiveMobileMode = isPhoneViewport ? "list" : null;
  const gridClass = [
    "planning-grid-unified",
    effectiveMobileMode === "list" ? "planning-grid-mobile-list" : "",
  ].filter(Boolean).join(" ");

  const weekRangeLabel = (() => {
    const startDate = new Date(planningWeekStart + "T00:00:00");
    const endDate = new Date(addDaysISO(planningWeekStart, 6) + "T00:00:00");
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return "";
    const locale = de ? "de-DE" : "en-US";
    const startStr = startDate.toLocaleDateString(locale, { month: "short", day: "numeric" });
    const endStr = endDate.toLocaleDateString(locale, { month: "short", day: "numeric" });
    return `${startStr} – ${endStr}`;
  })();

  return (
    <section className="planning-page">
      {/* Page title — visible on all viewports (added to PAGES_WITH_OWN_TITLE) */}
      <h1 className="planning-page-title">{de ? "Wochenplanung" : "Weekly Planning"}</h1>

      {/* ── Toolbar — matches Paper design WH-0 (single row, no duplicated title) ── */}
      <div className="planning-toolbar">
        <div
          className="planning-filter-pills"
          role="tablist"
          aria-label={de ? "Aufgabenfilter" : "Task filter"}
        >
          <button
            type="button"
            role="tab"
            aria-selected={planningTaskTypeView === "all"}
            className={`planning-filter-pill${planningTaskTypeView === "all" ? " planning-filter-pill--active" : ""}`}
            onClick={() => setPlanningTaskTypeView("all")}
          >
            {de ? "Alle" : "All"}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={planningTaskTypeView === "construction"}
            className={`planning-filter-pill${planningTaskTypeView === "construction" ? " planning-filter-pill--active" : ""}`}
            onClick={() => setPlanningTaskTypeView("construction")}
          >
            {de ? "Baustelle" : "Construction"}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={planningTaskTypeView === "office"}
            className={`planning-filter-pill${planningTaskTypeView === "office" ? " planning-filter-pill--active" : ""}`}
            onClick={() => setPlanningTaskTypeView("office")}
          >
            {de ? "Büro" : "Office"}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={planningTaskTypeView === "customer_appointment"}
            className={`planning-filter-pill${planningTaskTypeView === "customer_appointment" ? " planning-filter-pill--active" : ""}`}
            onClick={() => setPlanningTaskTypeView("customer_appointment")}
          >
            {de ? "Termin" : "Appointment"}
          </button>
        </div>

        {/* Einsätze (customer roster) ↔ Aufgaben (flat task list) */}
        <div
          className="planning-filter-pills planning-board-mode-pills"
          role="tablist"
          aria-label={de ? "Ansicht" : "View"}
        >
          <button
            type="button"
            role="tab"
            aria-selected={boardMode === "einsaetze"}
            className={`planning-filter-pill${boardMode === "einsaetze" ? " planning-filter-pill--active" : ""}`}
            onClick={() => setBoardMode("einsaetze")}
          >
            {de ? "Einsätze" : "Deployments"}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={boardMode === "tasks"}
            className={`planning-filter-pill${boardMode === "tasks" ? " planning-filter-pill--active" : ""}`}
            onClick={() => setBoardMode("tasks")}
          >
            {de ? "Aufgaben" : "Tasks"}
          </button>
        </div>

        <div
          className="planning-week-nav"
          role="group"
          aria-label={de ? "Wochenwechsel" : "Week switch"}
        >
          <button
            type="button"
            className="planning-week-nav-btn"
            aria-label={de ? "Vorherige Woche" : "Previous week"}
            onClick={() =>
              setPlanningWeekStart(normalizeWeekStartISO(addDaysISO(planningWeekStart, -7)))
            }
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="m15 6-6 6 6 6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <div className="planning-week-label">
            <span className="planning-week-label-cw">
              {de ? "KW" : "CW"} {planningWeekInfo.week}
            </span>
            <span aria-hidden="true" className="planning-week-label-sep">·</span>
            <span className="planning-week-label-range">{weekRangeLabel}</span>
            <input
              type="date"
              className="planning-week-date-input"
              value={planningWeekStart}
              onChange={(e) => setPlanningWeekStart(normalizeWeekStartISO(e.target.value))}
              aria-label={de ? "Wochenstart wählen" : "Pick week start"}
            />
          </div>
          <button
            type="button"
            className="planning-week-nav-btn"
            aria-label={de ? "Nächste Woche" : "Next week"}
            onClick={() =>
              setPlanningWeekStart(normalizeWeekStartISO(addDaysISO(planningWeekStart, 7)))
            }
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="m9 6 6 6-6 6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        {canManageTasks && (
          <button
            type="button"
            className="planning-add-task-btn"
            onClick={() =>
              openTaskModal({
                taskType:
                  planningTaskTypeView === "customer_appointment"
                    ? "customer_appointment"
                    : planningTaskTypeView === "office"
                      ? "office"
                      : "construction",
                dueDate: planningWeekStart,
              })
            }
          >
            + {de ? "Aufgabe" : "Add task"}
          </button>
        )}
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

      {/* ── Calendar grid ── */}
      <div className="planning-calendar-scroll">
        <div className={gridClass}>
          {planningDays.map((day, dayIndex) => {
            const isWeekend = isoWeekdayMondayFirst(day.date) >= 5;
            const isToday = day.date === todayIso;
            const dayNum = parseInt(day.date.split("-")[2] ?? "1", 10);
            const monthNum = parseInt(day.date.split("-")[1] ?? "1", 10);
            const holiday = holidayByDate.get(day.date) ?? null;
            const dayTasks = sortTasksByDueTime(day.tasks);
            const visibleTaskRows = showProjectRows ? dayTasks : dayTasks.filter((task) => isTaskAssignedToCurrentUser(task));
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
              holiday ? "planning-holiday-col" : "",
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
                  {holiday && (
                    <span
                      className="planning-col-holiday-label"
                      title={holiday.name}
                      style={{
                        display: "block",
                        fontSize: 10,
                        fontWeight: 600,
                        color: "#b45309",
                        marginTop: 2,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      🎌 {holiday.name}
                    </span>
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
                  {/* Einsatz mode: one row per CUSTOMER with the Monteure on
                      site. Clicking opens that day's tasks in a sheet — the
                      overview stays compact and tasks stay one click away. */}
                  {boardMode === "einsaetze" &&
                    buildEinsaetze(day.date, visibleTaskRows).map((einsatz) => {
                      const names = einsatzAssigneeNames(einsatz);
                      const timeLabel = einsatzTimeLabel(einsatz);
                      const taskCount = einsatz.tasks.length;
                      return (
                        <li
                          key={einsatz.key}
                          className="planning-einsatz planning-task-clickable"
                          onClick={() => setOpenEinsatz(einsatz)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              setOpenEinsatz(einsatz);
                            }
                          }}
                          role="button"
                          tabIndex={0}
                        >
                          <b className="planning-einsatz-customer">{einsatz.label}</b>
                          <span className="planning-einsatz-crew">
                            {names.length > 0
                              ? names.join(", ")
                              : de
                                ? "Niemand zugewiesen"
                                : "Nobody assigned"}
                          </span>
                          <span className="planning-einsatz-meta">
                            {timeLabel ? `${timeLabel} · ` : ""}
                            {taskCount}{" "}
                            {de
                              ? taskCount === 1
                                ? "Aufgabe"
                                : "Aufgaben"
                              : taskCount === 1
                                ? "task"
                                : "tasks"}
                          </span>
                        </li>
                      );
                    })}

                  {/* Task mode: every task as its own click-to-edit row. */}
                  {boardMode === "tasks" &&
                    visibleTaskRows.map((task) => {
                        const projectLabel = taskProjectTitleParts(task);
                        const isMine = isTaskAssignedToCurrentUser(task);
                        // Managers edit any task by clicking its row directly
                        // (opens the shared TaskEditModal — no detour). Non-
                        // manager assignees navigate to their task; everyone
                        // else is non-clickable.
                        const taskClickHandler = canManageTasks
                          ? () => openTaskEditModal(task)
                          : isMine
                            ? () => openTaskFromPlanning(task)
                            : undefined;
                        const isClickable = taskClickHandler !== undefined;
                        return (
                          <li
                            key={`planning-task-${day.date}-${task.id}`}
                            className={
                              isMine
                                ? "planning-task planning-task-mine planning-task-clickable"
                                : isClickable
                                  ? "planning-task planning-task-clickable"
                                  : "planning-task"
                            }
                            data-task-type={task.task_type ?? "construction"}
                            onClick={taskClickHandler}
                            onKeyDown={
                              isClickable
                                ? (event) => {
                                    if (event.key === "Enter" || event.key === " ") {
                                      event.preventDefault();
                                      taskClickHandler!();
                                    }
                                  }
                                : undefined
                            }
                            role={isClickable ? "button" : undefined}
                            tabIndex={isClickable ? 0 : undefined}
                          >
                            <b>
                              {task.title}
                              <CustomerConfirmationDot task={task} language={language} />
                            </b>
                            <small>
                              <button
                                type="button"
                                className="linklike"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  openProjectFromTask(task, null);
                                }}
                              >
                                {projectLabel.title}
                              </button>
                              {task.start_time ? ` · ${formatTaskTimeRange(task)}` : ""}
                              {" · "}
                              {getTaskAssigneeLabel(task)}
                            </small>
                            {projectLabel.subtitle && (
                              <small className="project-name-subtle">{projectLabel.subtitle}</small>
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
                  {visibleTaskRows.length === 0 && absences.length === 0 && (
                    <li className="planning-empty-cell" aria-hidden="true">–</li>
                  )}
                </ul>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Einsatz sheet: that day's tasks for one customer ────────────── */}
      {openEinsatz && (
        <div className="modal-backdrop" onClick={() => setOpenEinsatz(null)}>
          <div
            className="card modal-card planning-einsatz-sheet"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <header className="planning-einsatz-sheet-head">
              <div>
                <h2>{openEinsatz.label}</h2>
                <small className="muted">
                  {formatDayLabel(openEinsatz.date, language)}
                  {einsatzAssigneeNames(openEinsatz).length > 0
                    ? ` · ${einsatzAssigneeNames(openEinsatz).join(", ")}`
                    : ""}
                </small>
              </div>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setOpenEinsatz(null)}
                aria-label={de ? "Schließen" : "Close"}
              >
                ×
              </button>
            </header>

            <ul className="planning-einsatz-sheet-list">
              {sortTasksByDueTime(openEinsatz.tasks).map((task) => {
                const isMine = isTaskAssignedToCurrentUser(task);
                const projectLabel = taskProjectTitleParts(task);
                // Same click rule as the task board: managers edit, assignees
                // open their task. No detour.
                const onOpen = canManageTasks
                  ? () => {
                      setOpenEinsatz(null);
                      openTaskEditModal(task);
                    }
                  : isMine
                    ? () => {
                        setOpenEinsatz(null);
                        openTaskFromPlanning(task);
                      }
                    : undefined;
                return (
                  <li
                    key={`einsatz-task-${task.id}`}
                    className={
                      onOpen
                        ? "planning-einsatz-task planning-task-clickable"
                        : "planning-einsatz-task"
                    }
                    data-task-type={task.task_type ?? "construction"}
                    onClick={onOpen}
                    role={onOpen ? "button" : undefined}
                    tabIndex={onOpen ? 0 : undefined}
                    onKeyDown={
                      onOpen
                        ? (event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              onOpen();
                            }
                          }
                        : undefined
                    }
                  >
                    <b>
                      {task.title}
                      <CustomerConfirmationDot task={task} language={language} />
                    </b>
                    <small>
                      {/* A customer can run several projects in one day — the
                          project is shown per task rather than in the header. */}
                      {projectLabel.title}
                      {task.start_time ? ` · ${formatTaskTimeRange(task)}` : ""}
                      {" · "}
                      {getTaskAssigneeLabel(task)}
                    </small>
                    <div className="row wrap task-actions task-actions-left">
                      {canManageTasks && (
                        <button
                          type="button"
                          className="icon-btn task-edit-icon-btn"
                          onClick={(event) => {
                            event.stopPropagation();
                            setOpenEinsatz(null);
                            openTaskEditModal(task);
                          }}
                          aria-label={de ? "Aufgabe bearbeiten" : "Edit task"}
                          title={de ? "Aufgabe bearbeiten" : "Edit task"}
                        >
                          <PenIcon />
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
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
