import { useMemo, useState } from "react";
import { useAppContext } from "../context/AppContext";
import {
  taskDisplayStatus,
  isTaskOverdue,
  isTaskDoneStatus,
  isCustomerOnlyTask,
  taskCustomerAddress,
} from "../utils/tasks";
import type { Task } from "../types";
import { taskMaterialsDisplay } from "../utils/reports";
import { estimateTravelMinutesFromAddresses, projectLocationAddress } from "../utils/projects";
import { BackIcon, PenIcon } from "../components/icons";
import { TaskRowSummary } from "../components/tasks/TaskRowSummary";
import { TaskMaterialList } from "../components/tasks/TaskMaterialList";
import { TaskAttachmentStrip } from "../components/tasks/TaskAttachmentStrip";
import { taskBoxSummary } from "../utils/boxes";

export function MyTasksPage() {
  const {
    mainView,
    language,
    projects,
    customers,
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
    taskCustomerLabel,
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
        // This page is the open list (view=my). The overview loads my_all into
        // the same `tasks` state, and although loadTasks drops a stale
        // response, a done row must never show here whatever arrived.
        if (isTaskDoneStatus(task.status)) return false;
        if (partnerOnly && (task.partners ?? []).length === 0) return false;
        return true;
      }),
    [isTaskAssignedToCurrentUser, sortedTasks, partnerOnly],
  );
  const openTaskCount = visibleTasks.length;

  const travelHintsByTaskId = useMemo(() => {
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    const customersById = new Map(customers.map((customer) => [customer.id, customer]));
    const companyAddress = String(companySettings?.company_address ?? "").trim();
    // Where the task takes place: the project's site, or — for a customer-only
    // task — the customer's address, which the api sends on the row and the
    // loaded customers still know for a row that predates that.
    const taskAddress = (task: Task): string => {
      if (task.project_id != null) return projectLocationAddress(projectsById.get(task.project_id));
      if (!isCustomerOnlyTask(task)) return "";
      return taskCustomerAddress(task) || String(customersById.get(task.customer_id ?? 0)?.address ?? "").trim();
    };
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
        const previousProjectAddress =
          previousTask && previousTask.due_date === task.due_date ? taskAddress(previousTask) : "";
        const currentProjectAddress = taskAddress(task);
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
        const nextProjectAddress = nextTask && nextTask.due_date === task.due_date ? taskAddress(nextTask) : "";
        const next =
          currentProjectAddress && nextProjectAddress
            ? estimateTravelMinutesFromAddresses(currentProjectAddress, nextProjectAddress)
            : null;
        hints.set(task.id, { previous, next, previousLabel });
      });
    });

    return hints;
  }, [companySettings?.company_address, language, projects, customers, visibleTasks]);

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
                  {/* Shared with the overview card, so both surfaces agree
                      on badges and on how a date window reads. */}
                  <TaskRowSummary
                    task={task}
                    language={language}
                    todayIso={todayIso}
                    projectLabel={taskProjectLabel}
                    customerLabel={taskCustomerLabel(task)}
                  />
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
                        {de ? "Baustellenkiste" : "Construction box"}:{" "}
                        {taskBoxSummary(task, de) ?? "-"}
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
                    {/* The plan or the photo the office attached. The edit
                        modal is closed to most of the crew, so the row is
                        where they see it; a task without files shows no
                        block, and a folded row loads none. */}
                    <TaskAttachmentStrip task={task} />
                    <TaskMaterialList
                      taskId={task.id}
                      materials={task.materials}
                      language={language}
                      collapsible
                    />
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
                        {isCustomerOnlyTask(task)
                          ? de
                            ? "Kunde öffnen"
                            : "Open customer"
                          : de
                            ? "Projekt öffnen"
                            : "Open project"}
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
