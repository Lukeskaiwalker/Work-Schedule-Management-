import { useMemo, useState } from "react";
import { useAppContext } from "../context/AppContext";
import { taskDisplayStatus, isTaskOverdue, taskStatusLabel, taskTypeLabel, normalizeTaskTypeValue, formatTaskTimeRange } from "../utils/tasks";
import { taskMaterialsDisplay } from "../utils/reports";
import { PenIcon } from "../components/icons";
import { PartnerTaskChip } from "../components/partners/PartnerTaskChip";

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

  const [partnerOnly, setPartnerOnly] = useState(false);
  const [nameQuery, setNameQuery] = useState("");
  const visibleTasks = useMemo(() => {
    const trimmed = nameQuery.trim().toLowerCase();
    let rows = officeFilteredTasks;
    if (partnerOnly) {
      rows = rows.filter((task) => (task.partners ?? []).length > 0);
    }
    if (trimmed) {
      // Search title primarily and description as a fallback so users can find
      // a task by either the headline name or a remembered detail in the body.
      // The list is already client-side, so this stays purely local — no
      // backend round-trip on every keystroke.
      rows = rows.filter((task) => {
        const title = (task.title ?? "").toLowerCase();
        if (title.includes(trimmed)) return true;
        const desc = (task.description ?? "").toLowerCase();
        return desc.includes(trimmed);
      });
    }
    return rows;
  }, [officeFilteredTasks, partnerOnly, nameQuery]);

  if (mainView !== "office_tasks") return null;

  return (
    <section className="tasks-page">
      <div className="tasks-page-card">
        <header className="tasks-page-head tasks-page-head--office">
          <h2 className="tasks-page-title">{language === "de" ? "Aufgaben" : "Office Tasks"}</h2>
          {canManageTasks && (
            <button
              type="button"
              className="tasks-page-add-btn"
              onClick={() => openTaskModal({ taskType: "office" })}
              aria-label={language === "de" ? "Aufgabe hinzufügen" : "Add task"}
              title={language === "de" ? "Aufgabe hinzufügen" : "Add task"}
            >
              + {language === "de" ? "Aufgabe" : "Add task"}
            </button>
          )}
        </header>
        <small className="muted office-task-filter-hint">
        {language === "de"
          ? "Zeigt alle verfügbaren Aufgaben, auch ohne Zuweisung."
          : "Shows all available tasks, including unassigned tasks."}
      </small>
      <div className="row wrap office-task-filter-row">
        <label className="office-task-filter-field office-task-filter-field-name">
          {language === "de" ? "Aufgabenname" : "Task name"}
          <input
            type="search"
            value={nameQuery}
            onChange={(event) => setNameQuery(event.target.value)}
            placeholder={
              language === "de"
                ? "Aufgabe suchen…"
                : "Search tasks…"
            }
          />
        </label>
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
            setPartnerOnly(false);
            setNameQuery("");
          }}
        >
          {language === "de" ? "Filter zurücksetzen" : "Reset filters"}
        </button>
      </div>
      <ul className="tasks-page-list">
        {visibleTasks.length === 0 && (
          <li className="tasks-page-empty muted">
            {language === "de" ? "Keine Aufgaben für den Filter." : "No tasks match the filters."}
          </li>
        )}
        {visibleTasks.map((task) => {
          const de = language === "de";
          const isMine = isTaskAssignedToCurrentUser(task);
          const isOverdue = isTaskOverdue(task, todayIso);
          const rawStatus = String(task.status || "open").toLowerCase().trim();
          const displayStatus = taskDisplayStatus(task, todayIso);
          const isDone = rawStatus === "done" || rawStatus === "completed";
          const isInProgress = rawStatus === "in_progress";
          // Unassigned: no assignees at all (neither array nor single field)
          const assigneeIds = task.assignee_ids ?? [];
          const hasAssignees = assigneeIds.length > 0 || task.assignee_id != null;
          const isUnassigned = !hasAssignees && !isDone;

          // Status pill meta — priority order: overdue > unassigned > in progress > done > open
          let pillState: "overdue" | "unassigned" | "in_progress" | "done" | "open" = "open";
          let pillLabel = de ? "OFFEN" : "OPEN";
          if (isOverdue) {
            pillState = "overdue";
            pillLabel = de ? "ÜBERFÄLLIG" : "OVERDUE";
          } else if (isUnassigned) {
            pillState = "unassigned";
            pillLabel = de ? "NICHT ZUGEWIESEN" : "UNASSIGNED";
          } else if (isInProgress) {
            pillState = "in_progress";
            pillLabel = de ? "IN ARBEIT" : "IN PROGRESS";
          } else if (isDone) {
            pillState = "done";
            pillLabel = de ? "ERLEDIGT" : "DONE";
          }

          const taskMaterials = taskMaterialsDisplay(task.materials_required, language);
          const taskProjectLabel = taskProjectTitleParts(task);
          const rowClass = [
            "tasks-page-row",
            "tasks-page-row--office",
            `tasks-page-row--${pillState}`,
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <li key={`office-task-${task.id}`} className={rowClass}>
              <div className="tasks-page-office-row-body">
                <div className="tasks-page-row-title-line">
                  <span className="tasks-page-row-title">{task.title}</span>
                  <span className={`tasks-page-status-pill tasks-page-status-pill--${pillState}`}>
                    {pillLabel}
                  </span>
                </div>
                <span className="tasks-page-row-meta">
                  {de ? "Projekt" : "Project"}:{" "}
                  <button
                    type="button"
                    className="linklike tasks-page-row-project-link"
                    onClick={() => openProjectFromTask(task, "office_tasks")}
                  >
                    {taskProjectLabel.title}
                  </button>
                  {"  ·  "}
                  {de ? "Fällig" : "Due"}: {task.due_date ?? "-"}
                  {task.start_time ? ` ${de ? "um" : "at"} ${formatTaskTimeRange(task)}` : ""}
                  {"  ·  "}
                  {de ? "Mitarbeiter" : "Assignees"}: {hasAssignees ? getTaskAssigneeLabel(task) : "—"}
                  {"  ·  "}
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
                {(task.description || taskMaterials || task.storage_box_number) && (
                  <span className="tasks-page-row-meta">
                    {de ? "Typ" : "Type"}:{" "}
                    {taskTypeLabel(normalizeTaskTypeValue(task.task_type), language)}
                    {task.storage_box_number
                      ? `  ·  ${de ? "Lagerbox" : "Storage box"}: ${task.storage_box_number}`
                      : ""}
                    {task.description ? `  ·  ${de ? "Info" : "Info"}: ${task.description}` : ""}
                    {taskMaterials ? `  ·  ${de ? "Material" : "Materials"}: ${taskMaterials}` : ""}
                  </span>
                )}
              </div>
              <div className="tasks-page-row-actions tasks-page-row-actions--inline">
                {canManageTasks && (
                  <button
                    type="button"
                    className="tasks-page-row-action tasks-page-row-action--icon"
                    onClick={() => openTaskEditModal(task)}
                    aria-label={de ? "Aufgabe bearbeiten" : "Edit task"}
                    title={de ? "Aufgabe bearbeiten" : "Edit task"}
                  >
                    <PenIcon />
                  </button>
                )}
                {!isDone && !isUnassigned && isMine && (
                  <button
                    type="button"
                    className="tasks-page-row-action"
                    onClick={() => void exportTaskCalendar(task)}
                  >
                    {de ? "Kalender" : "Calendar"}
                  </button>
                )}
                {isUnassigned && canManageTasks && (
                  <button
                    type="button"
                    className="tasks-page-row-action tasks-page-row-action--primary"
                    onClick={() => openTaskEditModal(task)}
                  >
                    {de ? "Zuweisen" : "Assign"}
                  </button>
                )}
                {!isDone && !isUnassigned && (
                  <button
                    type="button"
                    className="tasks-page-row-action tasks-page-row-action--primary"
                    onClick={() => void markTaskDone(task)}
                  >
                    {de ? "Erledigt" : "Mark complete"}
                  </button>
                )}
                {isDone && canManageTasks && (
                  <button
                    type="button"
                    className="tasks-page-row-action"
                    onClick={() => openTaskEditModal(task)}
                  >
                    {de ? "Wiedereröffnen" : "Reopen"}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      </div>
    </section>
  );
}
