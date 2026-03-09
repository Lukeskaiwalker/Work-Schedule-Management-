import { useAppContext } from "../context/AppContext";
import { taskDisplayStatus, isTaskOverdue, taskStatusLabel, formatTaskStartTime } from "../utils/tasks";
import { taskMaterialsDisplay } from "../utils/reports";
import { BackIcon, PenIcon } from "../components/icons";

export function MyTasksPage() {
  const {
    mainView,
    language,
    sortedTasks,
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

  if (mainView !== "my_tasks") return null;

  return (
    <section className="card my-tasks-section">
      <div className="tasks-list-head tasks-header-row">
        <h3>{language === "de" ? "Meine Aufgaben" : "My tasks"}</h3>
        {myTasksBackProjectId && (
          <button
            type="button"
            className="icon-btn header-back-btn"
            onClick={() => {
              setActiveProjectId(myTasksBackProjectId);
              setProjectTab("tasks");
              setProjectBackView(null);
              setMainView("project");
              setMyTasksBackProjectId(null);
            }}
          >
            <BackIcon />
            <span>{language === "de" ? "Zurück zum Projekt" : "Back to project"}</span>
          </button>
        )}
      </div>
      <ul className="task-list">
        {sortedTasks.map((task) => {
          const isMine = isTaskAssignedToCurrentUser(task);
          const isOverdue = isTaskOverdue(task, todayIso);
          const displayStatus = taskDisplayStatus(task, todayIso);
          const expanded = expandedMyTaskId === task.id;
          const taskMaterials = taskMaterialsDisplay(task.materials_required, language);
          const taskSubtasks = (task.subtasks ?? []).map((row) => row.trim()).filter((row) => row.length > 0);
          const taskProjectLabel = taskProjectTitleParts(task);
          return (
            <li
              key={task.id}
              className={[
                "task-list-item",
                isMine ? "task-list-item-mine" : "",
                isOverdue ? "task-list-item-overdue" : "",
              ]
                .filter((value) => value.length > 0)
                .join(" ")}
            >
              <div className="task-list-main">
                <button
                  type="button"
                  className="task-expand-header"
                  onClick={() => setExpandedMyTaskId(expanded ? null : task.id)}
                  aria-expanded={expanded}
                >
                  <b>
                    {task.title}
                  </b>
                  <span className="task-expand-chevron" aria-hidden="true">
                    {expanded ? "▾" : "▸"}
                  </span>
                </button>
                <small>
                  {language === "de" ? "Projekt" : "Project"}:{" "}
                  <button type="button" className="linklike" onClick={() => openProjectFromTask(task)}>
                    {taskProjectLabel.title}
                  </button>{" "}
                  |{" "}
                  {language === "de" ? "Fällig" : "Due"}: {task.due_date ?? "-"}
                  {task.start_time ? ` ${language === "de" ? "um" : "at"} ${formatTaskStartTime(task.start_time)}` : ""} |{" "}
                  {language === "de" ? "Status" : "Status"}: {taskStatusLabel(displayStatus, language)}
                </small>
                {taskProjectLabel.subtitle && <small className="project-name-subtle">{taskProjectLabel.subtitle}</small>}
                {expanded && (
                  <div className="task-expanded-content">
                    <small>
                      {language === "de" ? "Mitarbeiter" : "Assignees"}: <b>{getTaskAssigneeLabel(task)}</b>
                    </small>
                    <small>
                      {language === "de" ? "Information" : "Information"}: <b>{task.description || "-"}</b>
                    </small>
                    <small>
                      {language === "de" ? "Material" : "Materials"}: <b>{taskMaterials || "-"}</b>
                    </small>
                    <small>
                      {language === "de" ? "Lagerbox" : "Storage box"}: <b>{task.storage_box_number ?? "-"}</b>
                    </small>
                    <div className="task-subtask-list">
                      <small>
                        {language === "de" ? "Unteraufgaben" : "Sub-tasks"}:{" "}
                        <b>{taskSubtasks.length > 0 ? taskSubtasks.length : "-"}</b>
                      </small>
                      {taskSubtasks.length > 0 && (
                        <ul>
                          {taskSubtasks.map((subtask, index) => (
                            <li key={`task-${task.id}-subtask-${index}`}>{subtask}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <div className="row wrap task-actions">
                {canManageTasks && (
                  <button
                    type="button"
                    className="icon-btn task-edit-icon-btn"
                    onClick={() => openTaskEditModal(task)}
                    aria-label={language === "de" ? "Aufgabe bearbeiten" : "Edit task"}
                    title={language === "de" ? "Aufgabe bearbeiten" : "Edit task"}
                  >
                    <PenIcon />
                  </button>
                )}
                {isMine && (
                  <button type="button" onClick={() => void exportTaskCalendar(task)}>
                    {language === "de" ? "Kalender" : "Calendar"}
                  </button>
                )}
                {isMine && (
                  <button
                    type="button"
                    onClick={() =>
                      task.status !== "done"
                        ? void markTaskDone(task, { openReportFromTask: task, reportBackView: "my_tasks" })
                        : openConstructionReportFromTask(task, "my_tasks")
                    }
                  >
                    {language === "de" ? "Bericht aus Aufgabe" : "Report from task"}
                  </button>
                )}
                {isMine && task.status !== "done" && (
                  <button type="button" onClick={() => void markTaskDone(task)}>
                    {language === "de" ? "Als erledigt markieren" : "Mark complete"}
                  </button>
                )}
              </div>
            </li>
          );
        })}
        {sortedTasks.length === 0 && <li className="muted">{language === "de" ? "Keine Aufgaben." : "No tasks."}</li>}
      </ul>
    </section>
  );
}
