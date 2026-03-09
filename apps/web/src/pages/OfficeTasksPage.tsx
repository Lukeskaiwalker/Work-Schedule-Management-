import { useAppContext } from "../context/AppContext";
import { taskDisplayStatus, isTaskOverdue, taskStatusLabel, taskTypeLabel, normalizeTaskTypeValue, formatTaskStartTime } from "../utils/tasks";
import { taskMaterialsDisplay } from "../utils/reports";
import { PenIcon } from "../components/icons";

export function OfficeTasksPage() {
  const {
    mainView,
    language,
    officeFilteredTasks,
    todayIso,
    canManageTasks,
    openTaskModal,
    openTaskEditModal,
    isTaskAssignedToCurrentUser,
    getTaskAssigneeLabel,
    taskProjectTitleParts,
    openProjectFromTask,
    exportTaskCalendar,
    markTaskDone,
    officeTaskStatusFilter,
    setOfficeTaskStatusFilter,
    officeTaskAssigneeFilter,
    setOfficeTaskAssigneeFilter,
    officeTaskDueDateFilter,
    setOfficeTaskDueDateFilter,
    officeTaskNoDueDateFilter,
    setOfficeTaskNoDueDateFilter,
    officeTaskProjectFilterQuery,
    setOfficeTaskProjectFilterQuery,
    officeTaskProjectSuggestions,
    officeTaskSelectedProjectFilters,
    officeTaskStatusOptions,
    officeTaskAssigneeOptions,
    addOfficeTaskProjectFilter,
    removeOfficeTaskProjectFilter,
    addFirstMatchingOfficeTaskProjectFilter,
    setOfficeTaskProjectFilterIds,
  } = useAppContext();

  if (mainView !== "office_tasks") return null;

  return (
    <section className="card my-tasks-section">
      <div className="tasks-list-head tasks-header-row">
        <h3>{language === "de" ? "Aufgaben" : "Tasks"}</h3>
        {canManageTasks && (
          <button
            type="button"
            className="icon-btn task-add-icon-btn"
            onClick={() => openTaskModal({ taskType: "office" })}
            aria-label={language === "de" ? "Aufgabe hinzufügen" : "Add task"}
            title={language === "de" ? "Aufgabe hinzufügen" : "Add task"}
          >
            +
          </button>
        )}
      </div>
      <small className="muted office-task-filter-hint">
        {language === "de"
          ? "Zeigt alle verfügbaren Aufgaben, auch ohne Zuweisung."
          : "Shows all available tasks, including unassigned tasks."}
      </small>
      <div className="row wrap office-task-filter-row">
        <label className="office-task-filter-field">
          {language === "de" ? "Status" : "Status"}
          <select value={officeTaskStatusFilter} onChange={(event) => setOfficeTaskStatusFilter(event.target.value)}>
            <option value="all">{language === "de" ? "Alle" : "All"}</option>
            {officeTaskStatusOptions.map((statusValue) => (
              <option key={`office-task-status-${statusValue}`} value={statusValue}>
                {taskStatusLabel(statusValue, language)}
              </option>
            ))}
          </select>
        </label>
        <label className="office-task-filter-field">
          {language === "de" ? "Zugewiesen an" : "Assigned to"}
          <select
            value={officeTaskAssigneeFilter}
            onChange={(event) => setOfficeTaskAssigneeFilter(event.target.value)}
          >
            <option value="all">{language === "de" ? "Alle" : "All"}</option>
            <option value="unassigned">{language === "de" ? "Nicht zugewiesen" : "Unassigned"}</option>
            {officeTaskAssigneeOptions.map((entry) => (
              <option key={`office-task-assignee-${entry.id}`} value={String(entry.id)}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <label className="office-task-filter-field">
          {language === "de" ? "Fälligkeitsdatum" : "Due date"}
          <input
            type="date"
            value={officeTaskDueDateFilter}
            onChange={(event) => {
              const nextValue = event.target.value;
              setOfficeTaskDueDateFilter(nextValue);
              if (nextValue) setOfficeTaskNoDueDateFilter(false);
            }}
            disabled={officeTaskNoDueDateFilter}
          />
          <label className="checkbox-inline office-task-no-date-toggle">
            <input
              type="checkbox"
              checked={officeTaskNoDueDateFilter}
              onChange={(event) => {
                const nextChecked = event.target.checked;
                setOfficeTaskNoDueDateFilter(nextChecked);
                if (nextChecked) setOfficeTaskDueDateFilter("");
              }}
            />
            {language === "de" ? "Ohne Fälligkeitsdatum" : "No due date"}
          </label>
        </label>
        <div className="office-task-filter-field office-task-filter-field-project">
          <span>{language === "de" ? "Projekte" : "Projects"}</span>
          <input
            value={officeTaskProjectFilterQuery}
            onChange={(event) => setOfficeTaskProjectFilterQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              addFirstMatchingOfficeTaskProjectFilter();
            }}
            placeholder={language === "de" ? "Projekt suchen und auswählen" : "Search and select project"}
          />
          {officeTaskProjectSuggestions.length > 0 && (
            <div className="assignee-suggestions">
              {officeTaskProjectSuggestions.map((entry) => (
                <button
                  key={`office-task-project-suggestion-${entry.id}`}
                  type="button"
                  className="assignee-suggestion-btn"
                  onClick={() => addOfficeTaskProjectFilter(entry.id)}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          )}
          <div className="assignee-chip-list">
            {officeTaskSelectedProjectFilters.map((entry) => (
              <button
                key={`office-task-project-chip-${entry.id}`}
                type="button"
                className="assignee-chip"
                onClick={() => removeOfficeTaskProjectFilter(entry.id)}
                title={language === "de" ? "Entfernen" : "Remove"}
              >
                {entry.label} ×
              </button>
            ))}
            {officeTaskSelectedProjectFilters.length === 0 && (
              <small className="muted">{language === "de" ? "Alle Projekte" : "All projects"}</small>
            )}
          </div>
        </div>
        <button
          type="button"
          className="office-task-filter-reset"
          onClick={() => {
            setOfficeTaskStatusFilter("all");
            setOfficeTaskAssigneeFilter("all");
            setOfficeTaskDueDateFilter("");
            setOfficeTaskNoDueDateFilter(false);
            setOfficeTaskProjectFilterQuery("");
            setOfficeTaskProjectFilterIds([]);
          }}
        >
          {language === "de" ? "Filter zurücksetzen" : "Reset filters"}
        </button>
      </div>
      <ul className="task-list">
        {officeFilteredTasks.map((task) => {
          const isMine = isTaskAssignedToCurrentUser(task);
          const isOverdue = isTaskOverdue(task, todayIso);
          const displayStatus = taskDisplayStatus(task, todayIso);
          const taskMaterials = taskMaterialsDisplay(task.materials_required, language);
          const taskProjectLabel = taskProjectTitleParts(task);
          return (
            <li
              key={`office-task-${task.id}`}
              className={[
                "task-list-item",
                isMine ? "task-list-item-mine" : "",
                isOverdue ? "task-list-item-overdue" : "",
              ]
                .filter((value) => value.length > 0)
                .join(" ")}
            >
              <div className="task-list-main">
                <b>
                  {task.title} [{taskStatusLabel(displayStatus, language)}]
                </b>
                <small>
                  {language === "de" ? "Projekt" : "Project"}:{" "}
                  <button type="button" className="linklike" onClick={() => openProjectFromTask(task, "office_tasks")}>
                    {taskProjectLabel.title}
                  </button>{" "}
                  | {language === "de" ? "Fällig" : "Due"}: {task.due_date ?? "-"}
                  {task.start_time ? ` ${language === "de" ? "um" : "at"} ${formatTaskStartTime(task.start_time)}` : ""} |{" "}
                  {language === "de" ? "Mitarbeiter" : "Assignees"}: {getTaskAssigneeLabel(task)}
                </small>
                {taskProjectLabel.subtitle && <small className="project-name-subtle">{taskProjectLabel.subtitle}</small>}
                <small>
                  {language === "de" ? "Typ" : "Type"}: {taskTypeLabel(normalizeTaskTypeValue(task.task_type), language)}
                  {task.storage_box_number
                    ? ` | ${language === "de" ? "Lagerbox" : "Storage box"}: ${task.storage_box_number}`
                    : ""}
                </small>
                {(task.description || taskMaterials) && (
                  <small>
                    {task.description ? `${language === "de" ? "Info" : "Info"}: ${task.description}` : ""}
                    {task.description && taskMaterials ? " | " : ""}
                    {taskMaterials ? `${language === "de" ? "Material" : "Materials"}: ${taskMaterials}` : ""}
                  </small>
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
                {isMine && task.status !== "done" && (
                  <button type="button" onClick={() => void markTaskDone(task)}>
                    {language === "de" ? "Als erledigt markieren" : "Mark complete"}
                  </button>
                )}
              </div>
            </li>
          );
        })}
        {officeFilteredTasks.length === 0 && (
          <li className="muted">{language === "de" ? "Keine Aufgaben für den Filter." : "No tasks match the filters."}</li>
        )}
      </ul>
    </section>
  );
}
