import { useMemo, useRef, useEffect } from "react";
import { useAppContext } from "../../context/AppContext";
import { addDaysISO, formatDayLabel, formatShortIsoDate, startOfWeekISO } from "../../utils/dates";
import {
  formatTaskTimeRange,
  isTaskDoneStatus,
  isTaskOverdue,
  sortTasksByDueTime,
  taskEstimatedMinutes,
} from "../../utils/tasks";
import { formatDurationLabel } from "../../utils/gantt";

function buildTimelineDays(startIso: string, endIso: string) {
  const days: string[] = [];
  let cursor = startIso;
  let guard = 0;
  while (cursor <= endIso && guard < 120) {
    days.push(cursor);
    cursor = addDaysISO(cursor, 1);
    guard += 1;
  }
  return days;
}

export function ProjectGanttTab() {
  const {
    mainView,
    projectTab,
    activeProject,
    activeProjectAddress,
    language,
    tasks,
    canManageTasks,
    openTaskModal,
    openTaskEditModal,
    openTaskFromProject,
    openConstructionReportFromTask,
    exportTaskCalendar,
    markTaskDone,
    getTaskAssigneeLabel,
    isTaskAssignedToCurrentUser,
    todayIso,
    projectBackView,
    setMainView,
  } = useAppContext();

  const de = language === "de";
  const scrollRef = useRef<HTMLDivElement>(null);

  /* ── Derived data ────────────────────────────────────────────── */

  const scheduledTasks = useMemo(
    () => sortTasksByDueTime(tasks.filter((t) => String(t.due_date || "").trim().length > 0)),
    [tasks],
  );
  const unscheduledTasks = useMemo(
    () => sortTasksByDueTime(tasks.filter((t) => String(t.due_date || "").trim().length === 0)),
    [tasks],
  );

  const timelineDays = useMemo(() => {
    const firstDate = scheduledTasks[0]?.due_date ?? "";
    const lastDate = scheduledTasks[scheduledTasks.length - 1]?.due_date ?? "";
    if (!firstDate || !lastDate) {
      const fallbackStart = startOfWeekISO(new Date());
      return buildTimelineDays(fallbackStart, addDaysISO(fallbackStart, 6));
    }
    const paddedStart = addDaysISO(firstDate, -1);
    let paddedEnd = addDaysISO(lastDate, 1);
    let days = buildTimelineDays(paddedStart, paddedEnd);
    while (days.length < 9) {
      paddedEnd = addDaysISO(paddedEnd, 1);
      days = buildTimelineDays(paddedStart, paddedEnd);
    }
    return days;
  }, [scheduledTasks]);

  const timelineColumns = `repeat(${timelineDays.length}, minmax(172px, 1fr))`;

  const doneCount = useMemo(
    () => tasks.filter((t) => isTaskDoneStatus(t.status)).length,
    [tasks],
  );
  const completionPct = tasks.length > 0 ? Math.round((doneCount / tasks.length) * 100) : 0;

  const totalEstimatedHours = useMemo(
    () => tasks.reduce((sum, t) => sum + (Number(t.estimated_hours) || 0), 0),
    [tasks],
  );
  const assignedPeopleCount = useMemo(() => {
    const ids = new Set<number>();
    tasks.forEach((t) => (t.assignee_ids ?? []).forEach((id) => ids.add(id)));
    return ids.size;
  }, [tasks]);

  /* ── Auto-scroll to today column ─────────────────────────────── */
  useEffect(() => {
    if (!scrollRef.current) return;
    const todayIdx = timelineDays.indexOf(todayIso);
    if (todayIdx < 0) return;
    const labelWidth = 260;
    const colWidth = 172;
    const targetScroll = Math.max(0, labelWidth + todayIdx * colWidth - scrollRef.current.clientWidth / 3);
    scrollRef.current.scrollLeft = targetScroll;
  }, [timelineDays, todayIso]);

  if (mainView !== "project" || !activeProject || projectTab !== "gantt") return null;

  /* ── Render ──────────────────────────────────────────────────── */

  return (
    <section className="gantt-layout">
      {/* ── Compact summary strip ───────────────────────────── */}
      <div className="gantt-strip">
        <div className="gantt-strip-left">
          <h3>{de ? "Gantt-Plan" : "Gantt Chart"}</h3>
          <div className="gantt-strip-progress">
            <div className="gantt-strip-progress-track">
              <div
                className={`gantt-strip-progress-fill${completionPct >= 100 ? " gantt-strip-progress-complete" : ""}`}
                style={{ width: `${completionPct}%` }}
              />
            </div>
            <span className="gantt-strip-pct">{completionPct}%</span>
          </div>
        </div>
        <div className="gantt-strip-metrics">
          <div className="gantt-chip">
            <span className="gantt-chip-val">{tasks.length}</span>
            <span className="gantt-chip-lbl">{de ? "Aufg." : "Tasks"}</span>
          </div>
          <div className="gantt-chip">
            <span className="gantt-chip-val">{doneCount}</span>
            <span className="gantt-chip-lbl">{de ? "Erledigt" : "Done"}</span>
          </div>
          <div className="gantt-chip">
            <span className="gantt-chip-val">{assignedPeopleCount}</span>
            <span className="gantt-chip-lbl">{de ? "Leute" : "People"}</span>
          </div>
          <div className="gantt-chip">
            <span className="gantt-chip-val">{totalEstimatedHours > 0 ? `${totalEstimatedHours.toFixed(0)}h` : "-"}</span>
            <span className="gantt-chip-lbl">{de ? "Geplant" : "Planned"}</span>
          </div>
        </div>
        <div className="gantt-strip-actions">
          {projectBackView === "planning" && (
            <button type="button" className="gantt-action-btn" onClick={() => setMainView("planning")}>
              {de ? "Wochenplanung" : "Weekly Plan"}
            </button>
          )}
          {canManageTasks && (
            <button
              type="button"
              className="gantt-action-btn gantt-action-btn-primary"
              onClick={() => openTaskModal({ projectId: activeProject.id })}
            >
              + {de ? "Aufgabe" : "Task"}
            </button>
          )}
        </div>
      </div>

      {/* ── Gantt board ──────────────────────────────────────── */}
      <div className="gantt-board-card">
        {scheduledTasks.length > 0 ? (
          <div className="gantt-scroll" ref={scrollRef}>
            <div className="gantt-board">
              {/* Header */}
              <div className="gantt-head-row">
                <div className="gantt-corner">
                  <span>{de ? "Aufgabe" : "Task"}</span>
                  <small>{scheduledTasks.length} {de ? "geplant" : "scheduled"}</small>
                </div>
                <div className="gantt-date-strip" style={{ gridTemplateColumns: timelineColumns }}>
                  {timelineDays.map((dayIso) => {
                    const day = new Date(`${dayIso}T12:00:00`);
                    const isToday = dayIso === todayIso;
                    const isWeekend = day.getDay() === 0 || day.getDay() === 6;
                    return (
                      <div
                        key={`head-${dayIso}`}
                        className={[
                          "gantt-date-cell",
                          isToday ? "gantt-date-cell-today" : "",
                          isWeekend ? "gantt-date-cell-weekend" : "",
                        ].filter(Boolean).join(" ")}
                      >
                        <small>{formatDayLabel(dayIso, language)}</small>
                        <b>{formatShortIsoDate(dayIso, language)}</b>
                        {isToday && <span className="gantt-today-dot" />}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Body */}
              <div className="gantt-body">
                {scheduledTasks.map((task, rowIdx) => {
                  const dayIndex = timelineDays.indexOf(task.due_date!);
                  const isMine = isTaskAssignedToCurrentUser(task);
                  const isDone = isTaskDoneStatus(task.status);
                  const isOverdueTask = isTaskOverdue(task, todayIso);
                  const canOpenBar = canManageTasks || (isMine && !isDone);
                  const canOpenReport = isMine;
                  const canComplete = isMine && !isDone;
                  const actionLabel = canManageTasks
                    ? (de ? "Aufgabe bearbeiten" : "Edit task")
                    : (de ? "Aufgabe öffnen" : "Open task");
                  const durationMin = taskEstimatedMinutes(task);
                  const durationText = formatDurationLabel(durationMin);
                  const timeText = task.start_time ? formatTaskTimeRange(task) : "";
                  const subtaskCount = (task.subtasks ?? []).length;

                  const statusClass = isDone
                    ? "gantt-row-done"
                    : isOverdueTask
                      ? "gantt-row-overdue"
                      : "";

                  return (
                    <div
                      key={`row-${task.id}`}
                      className={`gantt-row ${statusClass}`}
                      style={{ animationDelay: `${rowIdx * 30}ms` }}
                    >
                      {/* Left label (sticky) */}
                      <div className="gantt-label" title={task.title}>
                        <div className="gantt-label-status-pip">
                          {isDone ? (
                            <span className="gantt-pip gantt-pip-done">&#x2713;</span>
                          ) : isOverdueTask ? (
                            <span className="gantt-pip gantt-pip-overdue">!</span>
                          ) : (
                            <span className="gantt-pip gantt-pip-open" />
                          )}
                        </div>
                        <div className="gantt-label-content">
                          <div className="gantt-label-title">{task.title}</div>
                          <div className="gantt-label-meta">
                            {timeText && <small>{timeText}</small>}
                            {durationText && <span className="gantt-duration-badge">{durationText}</span>}
                            {subtaskCount > 0 && (
                              <span className="gantt-subtask-badge">
                                {isDone ? "\u2713" : "\u25A1"}{" "}
                                {subtaskCount} {subtaskCount === 1 ? (de ? "Teil" : "sub") : (de ? "Teile" : "subs")}
                              </span>
                            )}
                          </div>
                          <div className="gantt-label-assignee">{getTaskAssigneeLabel(task)}</div>
                        </div>
                      </div>

                      {/* Timeline track */}
                      <div className="gantt-track" style={{ gridTemplateColumns: timelineColumns }}>
                        {timelineDays.map((dayIso) => {
                          const isToday = dayIso === todayIso;
                          const dayObj = new Date(`${dayIso}T12:00:00`);
                          const isWeekend = dayObj.getDay() === 0 || dayObj.getDay() === 6;
                          return (
                            <div
                              key={`slot-${task.id}-${dayIso}`}
                              className={[
                                "gantt-day-slot",
                                isToday ? "gantt-day-slot-today" : "",
                                isWeekend ? "gantt-day-slot-weekend" : "",
                              ].filter(Boolean).join(" ")}
                            />
                          );
                        })}
                        {dayIndex >= 0 && (
                          <div
                            className={[
                              "gantt-bar",
                              isMine ? "gantt-bar-mine" : "",
                              isDone ? "gantt-bar-done" : isOverdueTask ? "gantt-bar-overdue" : "",
                            ].filter(Boolean).join(" ")}
                            style={{ gridColumn: `${dayIndex + 1} / span 1` }}
                          >
                            <button
                              type="button"
                              className="gantt-bar-main"
                              disabled={!canOpenBar}
                              onClick={() => {
                                if (canManageTasks) {
                                  openTaskEditModal(task);
                                  return;
                                }
                                if (isMine && !isDone) openTaskFromProject(task);
                              }}
                              aria-label={actionLabel}
                              title={`${task.title}\n${timeText}${durationText ? ` \u00B7 ${durationText}` : ""}`}
                            >
                              <b className="gantt-bar-title">{task.title}</b>
                              <small className="gantt-bar-detail">
                                {timeText || (de ? "Ohne Uhrzeit" : "No time")}
                                {durationText ? ` \u00B7 ${durationText}` : ""}
                              </small>
                            </button>

                            {/* Floating action overlay */}
                            {(isMine || canComplete || canOpenReport) && (
                              <div className="gantt-bar-actions">
                                {isMine && (
                                  <button
                                    type="button"
                                    className="gantt-bar-act"
                                    onClick={() => void exportTaskCalendar(task)}
                                    title={de ? "Kalender" : "Calendar"}
                                  >
                                    &#x1F4C5;
                                  </button>
                                )}
                                {canOpenReport && (
                                  <button
                                    type="button"
                                    className="gantt-bar-act"
                                    onClick={() => {
                                      if (task.status !== "done") {
                                        void markTaskDone(task, { openReportFromTask: task, reportBackView: "project" });
                                        return;
                                      }
                                      openConstructionReportFromTask(task, "project");
                                    }}
                                    title={de ? "Bericht" : "Report"}
                                  >
                                    &#x1F4CB;
                                  </button>
                                )}
                                {canComplete && (
                                  <button
                                    type="button"
                                    className="gantt-bar-act gantt-bar-act-done"
                                    onClick={() => void markTaskDone(task)}
                                    title={de ? "Erledigt" : "Complete"}
                                  >
                                    &#x2713;
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <div className="gantt-empty">
            <span className="gantt-empty-icon">&#x1F4C5;</span>
            <p>
              {de
                ? "Noch keine terminierten Aufgaben."
                : "No scheduled tasks yet."}
            </p>
            {canManageTasks && (
              <button
                type="button"
                className="gantt-action-btn gantt-action-btn-primary"
                onClick={() => openTaskModal({ projectId: activeProject.id })}
              >
                + {de ? "Erste Aufgabe anlegen" : "Create first task"}
              </button>
            )}
          </div>
        )}

        {unscheduledTasks.length > 0 && (
          <div className="gantt-unscheduled">
            <h4>{de ? "Ohne Termin" : "Unscheduled"} ({unscheduledTasks.length})</h4>
            <ul className="task-list">
              {unscheduledTasks.map((task) => (
                <li key={`unscheduled-${task.id}`} className="task-list-item">
                  <div className="task-list-main">
                    <b>{task.title}</b>
                    <small>{getTaskAssigneeLabel(task)}</small>
                  </div>
                  {canManageTasks && (
                    <button
                      type="button"
                      className="icon-btn task-edit-icon-btn"
                      onClick={() => openTaskEditModal(task)}
                      aria-label={de ? "Aufgabe bearbeiten" : "Edit task"}
                      title={de ? "Aufgabe bearbeiten" : "Edit task"}
                    >
                      &#x270E;
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
