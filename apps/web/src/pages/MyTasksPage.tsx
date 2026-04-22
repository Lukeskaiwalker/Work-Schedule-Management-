import { useMemo, useState } from "react";
import { useAppContext } from "../context/AppContext";
import { taskDisplayStatus, isTaskOverdue, taskStatusLabel, formatTaskTimeRange, isTaskDoneStatus } from "../utils/tasks";
import { taskMaterialsDisplay } from "../utils/reports";
import { estimateTravelMinutesFromAddresses, projectLocationAddress } from "../utils/projects";
import { BackIcon, PenIcon } from "../components/icons";
import { PartnerTaskChip } from "../components/partners/PartnerTaskChip";

export function MyTasksPage() {
  const {
    mainView,
    language,
    projects,
    sortedTasks,
    companySettings,
    todayIso,
    expandedMyTaskId,
    setExpandedMyTaskId,
    myTasksBackProjectId,
    setMyTasksBackProjectId,
    isTaskAssignedToCurrentUser,
    getTaskAssigneeLabel,
    taskProjectTitleParts,
    setActiveProjectId,
    setProjectTab,
    setProjectBackView,
    setMainView,
    canManageTasks,
    openTaskEditModal,
    exportTaskCalendar,
    markTaskDone,
    openProjectFromTask,
    openConstructionReportFromTask,
  } = useAppContext();

  const [partnerOnly, setPartnerOnly] = useState(false);
  const visibleTasks = useMemo(
    () =>
      sortedTasks.filter((task) => {
        if (!isTaskAssignedToCurrentUser(task)) return false;
        if (partnerOnly && (task.partners ?? []).length === 0) return false;
        return true;
      }),
    [isTaskAssignedToCurrentUser, sortedTasks, partnerOnly],
  );
  const openTaskCount = useMemo(
    () => visibleTasks.filter((task) => !isTaskDoneStatus(task.status)).length,
    [visibleTasks],
  );

  const travelHintsByTaskId = useMemo(() => {
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    const companyAddress = String(companySettings?.company_address ?? "").trim();
    const hints = new Map<number, { previous: number | null; next: number | null; previousLabel: string | null }>();
    const scheduledTasks = visibleTasks.filter((task) => String(task.due_date || "").trim() && String(task.start_time || "").trim());

    const tasksByDay = new Map<string, typeof scheduledTasks>();
    scheduledTasks.forEach((task) => {
      const key = String(task.due_date || "").trim();
      const bucket = tasksByDay.get(key) ?? [];
      bucket.push(task);
      tasksByDay.set(key, bucket);
    });

    tasksByDay.forEach((dayTasks) => {
      dayTasks.forEach((task, index) => {
        const previousTask = index > 0 ? dayTasks[index - 1] : null;
        const nextTask = index < dayTasks.length - 1 ? dayTasks[index + 1] : null;
      const previousProject =
        previousTask && previousTask.due_date === task.due_date ? projectsById.get(previousTask.project_id) : null;
        const currentProject = projectsById.get(task.project_id);
        const previousProjectAddress = projectLocationAddress(previousProject);
        const currentProjectAddress = projectLocationAddress(currentProject);
        const previousProjectMinutes =
          previousProjectAddress && currentProjectAddress
            ? estimateTravelMinutesFromAddresses(previousProjectAddress, currentProjectAddress)
            : null;
        const previous =
          previousProjectMinutes != null
            ? previousProjectMinutes
            : companyAddress && currentProjectAddress
              ? estimateTravelMinutesFromAddresses(companyAddress, currentProjectAddress)
              : null;
        const previousLabel =
          previousProjectMinutes != null
            ? (language === "de" ? "Fahrt von vorheriger Aufgabe" : "Travel from previous task")
            : companyAddress && currentProjectAddress
              ? (language === "de" ? "Fahrt vom Firmenstandort" : "Travel from company")
              : null;
        const nextProjectAddress =
          nextTask && nextTask.due_date === task.due_date
            ? projectLocationAddress(projectsById.get(nextTask.project_id))
            : "";
        const next =
          currentProjectAddress && nextProjectAddress
            ? estimateTravelMinutesFromAddresses(currentProjectAddress, nextProjectAddress)
            : null;
        hints.set(task.id, { previous, next, previousLabel });
      });
    });

    return hints;
  }, [companySettings?.company_address, language, projects, visibleTasks]);

  if (mainView !== "my_tasks") return null;
  const de = language === "de";

  return (
    <section className="tasks-page">
      {myTasksBackProjectId && (
        <div className="tasks-page-back-row">
          <button
            type="button"
            className="tasks-page-back-btn"
            onClick={() => {
              setActiveProjectId(myTasksBackProjectId);
              setProjectTab("tasks");
              setProjectBackView(null);
              setMainView("project");
              setMyTasksBackProjectId(null);
            }}
          >
            <BackIcon />
            <span>{de ? "Zurück zum Projekt" : "Back to project"}</span>
          </button>
        </div>
      )}
      <div className="tasks-page-card">
        <header className="tasks-page-head">
          <h2 className="tasks-page-title">{de ? "Meine Aufgaben" : "My Tasks"}</h2>
          <span className="tasks-page-count">
            {openTaskCount} {de ? "offen" : "open"}
          </span>
        </header>
        <div className="tasks-page-filter-row">
          <button
            type="button"
            className={
              partnerOnly
                ? "tasks-page-filter-chip tasks-page-filter-chip--active"
                : "tasks-page-filter-chip"
            }
            onClick={() => setPartnerOnly((current) => !current)}
            aria-pressed={partnerOnly}
          >
            {de ? "Nur Partner-Aufgaben" : "Partner tasks only"}
          </button>
        </div>
        <ul className="tasks-page-list">
          {visibleTasks.length === 0 && (
            <li className="tasks-page-empty muted">{de ? "Keine Aufgaben." : "No tasks."}</li>
          )}
          {visibleTasks.map((task) => {
            const isOverdue = isTaskOverdue(task, todayIso);
            const displayStatus = taskDisplayStatus(task, todayIso);
            const expanded = expandedMyTaskId === task.id;
            const isDone = isTaskDoneStatus(task.status);
            const taskMaterials = taskMaterialsDisplay(task.materials_required, language);
            const taskSubtasks = (task.subtasks ?? [])
              .map((row) => row.trim())
              .filter((row) => row.length > 0);
            const taskProjectLabel = taskProjectTitleParts(task);
            const travelHints =
              travelHintsByTaskId.get(task.id) ?? {
                previous: null,
                next: null,
                previousLabel: null,
              };
            const isInProgress = displayStatus === "in_progress";
            const rowClass = [
              "tasks-page-row",
              isOverdue ? "tasks-page-row--overdue" : "",
              isInProgress && !isOverdue ? "tasks-page-row--in-progress" : "",
              isDone ? "tasks-page-row--done" : "",
              expanded ? "tasks-page-row--expanded" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <li key={task.id} className={rowClass}>
                <button
                  type="button"
                  className="tasks-page-row-header"
                  onClick={() => setExpandedMyTaskId(expanded ? null : task.id)}
                  aria-expanded={expanded}
                >
                  <div className="tasks-page-row-title-block">
                    <div className="tasks-page-row-title-line">
                      <span className="tasks-page-row-title">{task.title}</span>
                      {displayStatus === "overdue" && (
                        <span className="tasks-page-row-badge tasks-page-row-badge--overdue">
                          {de ? "ÜBERFÄLLIG" : "OVERDUE"}
                        </span>
                      )}
                      {displayStatus === "done" && (
                        <span className="tasks-page-row-badge tasks-page-row-badge--done">
                          {de ? "ERLEDIGT" : "DONE"}
                        </span>
                      )}
                    </div>
                    <span className="tasks-page-row-meta">
                      {de ? "Projekt" : "Project"}: {taskProjectLabel.title}
                      {"  |  "}
                      {de ? "Fällig" : "Due"}: {task.due_date ?? "-"}
                      {task.start_time ? ` ${de ? "um" : "at"} ${formatTaskTimeRange(task)}` : ""}
                      {"  |  "}
                      {de ? "Status" : "Status"}: {taskStatusLabel(displayStatus, language)}
                    </span>
                    {task.partners && task.partners.length > 0 && (
                      <span className="tasks-page-row-partner-line">
                        <PartnerTaskChip partners={task.partners} language={de ? "de" : "en"} />
                      </span>
                    )}
                    {taskProjectLabel.subtitle && (
                      <span className="tasks-page-row-subtitle">{taskProjectLabel.subtitle}</span>
                    )}
                  </div>
                  <span className="tasks-page-row-chevron" aria-hidden="true">
                    {expanded ? "▾" : "▸"}
                  </span>
                </button>

                {expanded && (
                  <div className="tasks-page-row-expanded">
                    {(travelHints.previous != null || travelHints.next != null) && (
                      <div className="tasks-page-travel-hints">
                        {travelHints.previous != null && (
                          <span>
                            {travelHints.previousLabel ||
                              (de
                                ? "Fahrt von vorheriger Aufgabe"
                                : "Travel from previous task")}
                            : ~{travelHints.previous} {de ? "Min." : "min"}
                          </span>
                        )}
                        {travelHints.next != null && (
                          <span>
                            {de ? "Fahrt zur nächsten Aufgabe" : "Travel to next task"}: ~
                            {travelHints.next} {de ? "Min." : "min"}
                          </span>
                        )}
                      </div>
                    )}
                    <div className="tasks-page-detail-lines">
                      <span>
                        {de ? "Mitarbeiter" : "Assignees"}: {getTaskAssigneeLabel(task)}
                      </span>
                      <span>
                        {de ? "Information" : "Information"}: {task.description || "-"}
                      </span>
                      <span>
                        {de ? "Material" : "Materials"}: {taskMaterials || "-"}
                      </span>
                      <span>
                        {de ? "Lagerbox" : "Storage box"}:{" "}
                        {task.storage_box_number ?? "-"}
                      </span>
                      <span>
                        {de ? "Unteraufgaben" : "Sub-tasks"}:{" "}
                        {taskSubtasks.length > 0 ? taskSubtasks.length : "-"}
                      </span>
                    </div>
                    {taskSubtasks.length > 0 && (
                      <ul className="tasks-page-subtask-list">
                        {taskSubtasks.map((subtask, index) => (
                          <li key={`task-${task.id}-subtask-${index}`}>{subtask}</li>
                        ))}
                      </ul>
                    )}
                    <div className="tasks-page-row-actions">
                      {canManageTasks && (
                        <button
                          type="button"
                          className="tasks-page-row-action tasks-page-row-action--icon"
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
                      <button
                        type="button"
                        className="tasks-page-row-action"
                        onClick={(event) => {
                          event.stopPropagation();
                          void exportTaskCalendar(task);
                        }}
                      >
                        {de ? "Kalender" : "Calendar"}
                      </button>
                      <button
                        type="button"
                        className="tasks-page-row-action"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (task.status !== "done") {
                            void markTaskDone(task, {
                              openReportFromTask: task,
                              reportBackView: "my_tasks",
                            });
                          } else {
                            openConstructionReportFromTask(task, "my_tasks");
                          }
                        }}
                      >
                        {de ? "Bericht aus Aufgabe" : "Report from task"}
                      </button>
                      {task.status !== "done" && (
                        <button
                          type="button"
                          className="tasks-page-row-action tasks-page-row-action--primary"
                          onClick={(event) => {
                            event.stopPropagation();
                            void markTaskDone(task);
                          }}
                        >
                          {de ? "Als erledigt markieren" : "Mark complete"}
                        </button>
                      )}
                      <button
                        type="button"
                        className="tasks-page-row-action tasks-page-row-action--ghost"
                        onClick={(event) => {
                          event.stopPropagation();
                          openProjectFromTask(task);
                        }}
                      >
                        {de ? "Projekt öffnen" : "Open project"}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
