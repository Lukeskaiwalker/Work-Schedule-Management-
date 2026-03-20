import { useAppContext } from "../../context/AppContext";
import { taskDisplayStatus, isTaskOverdue, taskStatusLabel, formatTaskTimeRange } from "../../utils/tasks";
import { taskMaterialsDisplay } from "../../utils/reports";
import { PenIcon } from "../../components/icons";

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

  if (mainView !== "project" || !activeProject || projectTab !== "tasks") return null;

  return (
    <section className="grid">
      <div className="card tasks-list-card">
        <div className="tasks-list-head">
          <h3>{language === "de" ? "Aufgaben" : "Tasks"}</h3>
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
        <div className="row wrap task-view-toggle">
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
        <ul>
          {sortedTasks.map((task) => {
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
                  <b>
                    {task.title} [{taskStatusLabel(displayStatus, language)}]
                  </b>
                  <small>
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
                    </button>{" "}
                    |{" "}
                    {language === "de" ? "Fällig" : "Due"}: {task.due_date ?? "-"}
                    {task.start_time ? ` ${language === "de" ? "um" : "at"} ${formatTaskTimeRange(task)}` : ""} |{" "}
                    {language === "de" ? "Mitarbeiter" : "Assignees"}: {getTaskAssigneeLabel(task)}
                  </small>
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
          {sortedTasks.length === 0 && (
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
