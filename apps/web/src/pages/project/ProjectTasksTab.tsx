import { useMemo, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import { taskDisplayStatus, isTaskOverdue, taskStatusLabel, formatTaskTimeRange } from "../../utils/tasks";
import { taskMaterialsDisplay } from "../../utils/reports";
import { PenIcon } from "../../components/icons";
import { PartnerTaskChip } from "../../components/partners/PartnerTaskChip";

export function ProjectTasksTab() {
  const {
    mainView,
    projectTab,
    activeProject,
    language,
    sortedTasks,
    todayIso,
    taskView,
    setTaskView,
    canManageTasks,
    user,
    openTaskModal,
    openTaskEditModal,
    openProjectFromTask,
    openTaskFromProject,
    exportTaskCalendar,
    markTaskDone,
    getTaskAssigneeIds,
    getTaskAssigneeLabel,
    taskProjectTitleParts,
    isTaskAssignedToCurrentUser,
  } = useAppContext();

  const [partnerOnly, setPartnerOnly] = useState(false);
  const visibleTasks = useMemo(() => {
    if (!partnerOnly) return sortedTasks;
    return sortedTasks.filter((task) => (task.partners ?? []).length > 0);
  }, [sortedTasks, partnerOnly]);

  if (mainView !== "project" || !activeProject || projectTab !== "tasks") return null;

  const visibleTaskCount = visibleTasks.length;

  return (
    <section className="grid">
      <div className="card tasks-list-card">
        <div className="tasks-list-head">
          <h3>{language === "de" ? "Aufgaben" : "Tasks"}</h3>
          <div className="project-tasks-toolbar-actions">
            <small className="muted">
              {visibleTaskCount} {language === "de" ? "Aufgaben" : "tasks"}
            </small>
            {sortedTasks.length > 0 && (
              <button
                type="button"
                className="project-tasks-export-btn"
                onClick={() => {
                  const exportTask = sortedTasks[0];
                  if (exportTask) void exportTaskCalendar(exportTask);
                }}
              >
                {language === "de" ? "Kalender exportieren" : "Export calendar"}
              </button>
            )}
            {canManageTasks && (
              <button
                type="button"
                className="icon-btn task-add-icon-btn"
                onClick={() => openTaskModal({ projectId: activeProject.id })}
                aria-label={language === "de" ? "Aufgabe hinzufügen" : "Add task"}
                title={language === "de" ? "Aufgabe hinzufügen" : "Add task"}
              >
                +
              </button>
            )}
          </div>
        </div>
        <div className="row wrap task-view-toggle project-task-toggle-paper">
          <button
            type="button"
            className={taskView === "my" ? "active" : ""}
            onClick={() => setTaskView("my")}
          >
            {language === "de" ? "Meine Aufgaben" : "My tasks"}
          </button>
          <button
            type="button"
            className={taskView === "all_open" ? "active" : ""}
            onClick={() => setTaskView("all_open")}
          >
            {language === "de" ? "Alle offenen Aufgaben" : "All open tasks"}
          </button>
          <button
            type="button"
            className={taskView === "completed" ? "active" : ""}
            onClick={() => setTaskView("completed")}
          >
            {language === "de" ? "Abgeschlossene Aufgaben" : "Completed tasks"}
          </button>
        </div>
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
            {language === "de" ? "Nur Partner-Aufgaben" : "Partner tasks only"}
          </button>
        </div>
        <ul>
          {visibleTasks.map((task) => {
            const isMine = isTaskAssignedToCurrentUser(task);
            const isOverdue = isTaskOverdue(task, todayIso);
            const displayStatus = taskDisplayStatus(task, todayIso);
            const canOpenInMyTasks = isMine && task.status !== "done";
            const taskMaterials = taskMaterialsDisplay(task.materials_required, language);
            const taskProjectLabel = taskProjectTitleParts(task);
            return (
              <li
                key={task.id}
                className={[
                  "task-list-item",
                  canOpenInMyTasks ? "task-list-item-mine task-list-item-clickable" : "",
                  isOverdue ? "task-list-item-overdue" : "",
                ]
                  .filter((value) => value.length > 0)
                  .join(" ")}
                onClick={canOpenInMyTasks ? () => openTaskFromProject(task) : undefined}
                onKeyDown={
                  canOpenInMyTasks
                    ? (event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          openTaskFromProject(task);
                        }
                      }
                    : undefined
                }
                role={canOpenInMyTasks ? "button" : undefined}
                tabIndex={canOpenInMyTasks ? 0 : undefined}
              >
                <div className="task-list-main">
                  <div className="task-list-title-row">
                    <b>{task.title}</b>
                    <span
                      className={[
                        "project-task-type-pill",
                        String(task.task_type || "").trim() === "office" ? "project-task-type-pill-office" : "",
                        String(task.task_type || "").trim() === "customer_appointment" ? "project-task-type-pill-appointment" : "",
                      ].filter(Boolean).join(" ")}
                    >
                      {task.task_type === "office"
                        ? language === "de" ? "Büro" : "Office"
                        : task.task_type === "customer_appointment"
                          ? language === "de" ? "Termin" : "Appointment"
                          : language === "de" ? "Baustelle" : "Construction"}
                    </span>
                  </div>
                  <small className="task-meta-line">
                    <span>
                      {language === "de" ? "Projekt" : "Project"}:{" "}
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
                    </span>
                    <span>
                      {language === "de" ? "Fällig" : "Due"}: {task.due_date ?? "-"}
                      {task.start_time ? ` ${language === "de" ? "um" : "at"} ${formatTaskTimeRange(task)}` : ""}
                    </span>
                    <span>
                      {language === "de" ? "Status" : "Status"}: {taskStatusLabel(displayStatus, language)}
                    </span>
                    <span>
                      {language === "de" ? "Mitarbeiter" : "Assignees"}: {getTaskAssigneeLabel(task)}
                    </span>
                  </small>
                  {task.partners && task.partners.length > 0 && (
                    <small className="tasks-page-row-partner-line">
                      <PartnerTaskChip partners={task.partners} language={language === "de" ? "de" : "en"} />
                    </small>
                  )}
                  {taskProjectLabel.subtitle && <small className="project-name-subtle">{taskProjectLabel.subtitle}</small>}
                  {(task.description || taskMaterials || task.storage_box_number) && (
                    <small>
                      {task.description ? `${language === "de" ? "Info" : "Info"}: ${task.description}` : ""}
                      {task.description && (taskMaterials || task.storage_box_number) ? " | " : ""}
                      {taskMaterials
                        ? `${language === "de" ? "Material" : "Materials"}: ${taskMaterials}`
                        : ""}
                      {task.storage_box_number
                        ? ` | ${language === "de" ? "Lagerbox" : "Storage box"}: ${task.storage_box_number}`
                        : ""}
                    </small>
                  )}
                </div>
                <div className="row wrap task-actions">
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
                  {getTaskAssigneeIds(task).includes(user!.id) && (
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
                  {getTaskAssigneeIds(task).includes(user!.id) && task.status !== "done" && (
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
          {visibleTasks.length === 0 && (
            <li className="muted">
              {taskView === "completed"
                ? language === "de"
                  ? "Keine abgeschlossenen Aufgaben."
                  : "No completed tasks."
                : taskView === "all_open"
                  ? language === "de"
                    ? "Keine offenen Aufgaben."
                    : "No open tasks."
                  : language === "de"
                    ? "Keine Aufgaben."
                    : "No tasks."}
            </li>
          )}
        </ul>
      </div>
    </section>
  );
}
