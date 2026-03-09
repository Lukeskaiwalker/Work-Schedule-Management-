import { useAppContext } from "../../context/AppContext";
import { HHMM_PATTERN } from "../../constants";
import { taskTypeLabel, normalizeTaskTypeValue, formatTimeInputForTyping, formatTimeInputForBlur } from "../../utils/tasks";

export function TaskModal() {
  const {
    language,
    taskModalOpen,
    taskModalForm,
    setTaskModalForm,
    taskModalMaterialRows,
    taskModalProjectSuggestions,
    selectedTaskModalProject,
    taskModalProjectClassTemplates,
    taskModalAssigneeSuggestions,
    assignableUsers,
    projects,
    canCreateProject,
    closeTaskModal,
    createWeeklyPlanTask,
    updateTaskModalField,
    updateTaskModalMaterialRow,
    addTaskModalMaterialRow,
    removeTaskModalMaterialRow,
    selectTaskModalClassTemplate,
    addTaskModalAssignee,
    removeTaskModalAssignee,
    addFirstMatchingTaskModalAssignee,
    selectTaskModalProject,
    projectSearchLabel,
    enrichTaskModalMaterialRowFromCatalog,
    assigneeAvailabilityHint,
    menuUserNameById,
    onTaskModalBackdropPointerDown,
    onTaskModalBackdropPointerUp,
    resetTaskModalBackdropPointerState,
  } = useAppContext();

  if (!taskModalOpen) return null;

  return (
    <div
      className="modal-backdrop"
      onPointerDown={onTaskModalBackdropPointerDown}
      onPointerUp={onTaskModalBackdropPointerUp}
      onPointerCancel={resetTaskModalBackdropPointerState}
      onPointerLeave={resetTaskModalBackdropPointerState}
    >
      <div className="card modal-card" onClick={(event) => event.stopPropagation()}>
        <h3>{language === "de" ? "Neue Aufgabe" : "New task"}</h3>
        <form
          className="modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            void createWeeklyPlanTask();
          }}
        >
          <label>
            {language === "de" ? "Titel" : "Title"}
            <input
              value={taskModalForm.title}
              onChange={(event) => updateTaskModalField("title", event.target.value)}
              placeholder={language === "de" ? "Aufgabentitel" : "Task title"}
              required
            />
          </label>
          <label>
            {language === "de" ? "Information" : "Information"}
            <textarea
              value={taskModalForm.description}
              onChange={(event) => updateTaskModalField("description", event.target.value)}
              placeholder={language === "de" ? "Beschreibung der Aufgabe" : "Task description"}
            />
          </label>
          <label>
            {language === "de" ? "Unteraufgaben" : "Sub-tasks"}
            <textarea
              value={taskModalForm.subtasks_raw}
              onChange={(event) => updateTaskModalField("subtasks_raw", event.target.value)}
              placeholder={
                language === "de"
                  ? "Eine Unteraufgabe pro Zeile"
                  : "One sub-task per line"
              }
            />
          </label>
          <div className="report-material-block">
            <b>{language === "de" ? "Benötigte Materialien" : "Required materials"}</b>
            <div className="report-material-grid">
              <div className="report-material-grid-head">
                <span>{language === "de" ? "Artikel" : "Item"}</span>
                <span>{language === "de" ? "Menge" : "Qty"}</span>
                <span>{language === "de" ? "Einheit" : "Unit"}</span>
                <span>{language === "de" ? "Artikel-Nr." : "Article no."}</span>
                <span />
              </div>
              {taskModalMaterialRows.map((row, index) => (
                <div key={row.id} className="report-material-grid-row">
                  <input
                    value={row.item}
                    onChange={(event) => updateTaskModalMaterialRow(index, "item", event.target.value)}
                    onBlur={() => {
                      void enrichTaskModalMaterialRowFromCatalog(index, "item");
                    }}
                    placeholder={language === "de" ? "z.B. Kabel NYM" : "e.g. cable NYM"}
                  />
                  <input
                    value={row.qty}
                    onChange={(event) => updateTaskModalMaterialRow(index, "qty", event.target.value)}
                    placeholder="1"
                  />
                  <input
                    value={row.unit}
                    list="material-unit-options"
                    onChange={(event) => updateTaskModalMaterialRow(index, "unit", event.target.value)}
                    placeholder={language === "de" ? "Stk" : "pcs"}
                  />
                  <input
                    value={row.article_no}
                    onChange={(event) => updateTaskModalMaterialRow(index, "article_no", event.target.value)}
                    onBlur={() => {
                      void enrichTaskModalMaterialRowFromCatalog(index, "article_no");
                    }}
                    placeholder="A-1001"
                  />
                  <button type="button" onClick={() => removeTaskModalMaterialRow(index)} aria-label="Remove">
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button type="button" onClick={addTaskModalMaterialRow}>
              {language === "de" ? "Materialzeile hinzufügen" : "Add material row"}
            </button>
          </div>
          <label>
            {language === "de" ? "Aufgabentyp" : "Task type"}
            <select
              value={taskModalForm.task_type}
              onChange={(event) => updateTaskModalField("task_type", normalizeTaskTypeValue(event.target.value))}
            >
              <option value="construction">{taskTypeLabel("construction", language)}</option>
              <option value="office">{taskTypeLabel("office", language)}</option>
              <option value="customer_appointment">{taskTypeLabel("customer_appointment", language)}</option>
            </select>
          </label>
          <label>
            {language === "de" ? "Projektklasse (optional)" : "Project class (optional)"}
            <select
              value={taskModalForm.class_template_id}
              onChange={(event) => selectTaskModalClassTemplate(event.target.value)}
            >
              <option value="">{language === "de" ? "Keine Klasse" : "No class"}</option>
              {taskModalProjectClassTemplates.map((entry) => (
                <option key={`task-modal-class-template-${entry.id}`} value={String(entry.id)}>
                  {entry.name}
                </option>
              ))}
            </select>
            {Number(taskModalForm.project_id) > 0 && taskModalProjectClassTemplates.length === 0 && (
              <small className="muted">
                {language === "de"
                  ? "Dem ausgewählten Projekt sind keine Klassen zugewiesen."
                  : "No classes are assigned to the selected project."}
              </small>
            )}
          </label>
          <label className="checkbox-inline">
            <input
              type="checkbox"
              checked={taskModalForm.has_storage_box}
              onChange={(event) =>
                setTaskModalForm((current) => ({
                  ...current,
                  has_storage_box: event.target.checked,
                  storage_box_number: event.target.checked ? current.storage_box_number : "",
                }))
              }
            />
            {language === "de" ? "Material aus Lagerbox verwenden" : "Use materials from warehouse box"}
          </label>
          {taskModalForm.has_storage_box && (
            <label>
              {language === "de" ? "Lagerbox-Nummer" : "Storage box number"}
              <input
                type="number"
                min={1}
                step={1}
                value={taskModalForm.storage_box_number}
                onChange={(event) => updateTaskModalField("storage_box_number", event.target.value)}
                required
              />
            </label>
          )}
          <div className="assignee-search-block">
            <b>{language === "de" ? "Projekt zuweisen" : "Assign project"}</b>
            <input
              value={taskModalForm.project_query}
              onChange={(event) => {
                const nextQuery = event.target.value;
                setTaskModalForm((current) => {
                  if (!current.project_id) return { ...current, project_query: nextQuery };
                  const currentProject = projects.find((project) => String(project.id) === current.project_id);
                  if (!currentProject) {
                    return { ...current, project_query: nextQuery, project_id: "", class_template_id: "" };
                  }
                  return projectSearchLabel(currentProject) === nextQuery
                    ? { ...current, project_query: nextQuery }
                    : { ...current, project_query: nextQuery, project_id: "", class_template_id: "" };
                });
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                const first = taskModalProjectSuggestions[0];
                if (first) selectTaskModalProject(first);
              }}
              placeholder={
                language === "de"
                  ? "Projektnummer, Kunde oder Projektname"
                  : "Project number, customer, or project name"
              }
            />
            {taskModalProjectSuggestions.length > 0 && (
              <div className="assignee-suggestions">
                {taskModalProjectSuggestions.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    className="assignee-suggestion-btn"
                    onClick={() => selectTaskModalProject(project)}
                  >
                    {projectSearchLabel(project)}
                  </button>
                ))}
              </div>
            )}
            <div className="assignee-chip-list">
              {selectedTaskModalProject ? (
                <button
                  type="button"
                  className="assignee-chip"
                  onClick={() =>
                    setTaskModalForm((current) => ({
                      ...current,
                      project_id: "",
                      project_query: "",
                      class_template_id: "",
                    }))
                  }
                  title={language === "de" ? "Entfernen" : "Remove"}
                >
                  {projectSearchLabel(selectedTaskModalProject) + " ×"}
                </button>
              ) : (
                <small className="muted">
                  {language === "de" ? "Noch kein Projekt ausgewählt." : "No project selected yet."}
                </small>
              )}
            </div>
          </div>
          {!selectedTaskModalProject && canCreateProject && (
            <>
              <label className="checkbox-inline">
                <input
                  type="checkbox"
                  checked={taskModalForm.create_project_from_task}
                  onChange={(event) => updateTaskModalField("create_project_from_task", event.target.checked)}
                />
                {language === "de"
                  ? "Falls nötig, neues Projekt aus dieser Aufgabe erstellen"
                  : "Create a new project from this task if needed"}
              </label>
              {taskModalForm.create_project_from_task && (
                <div className="row wrap modal-subgrid">
                  <label>
                    {language === "de" ? "Projektname" : "Project name"}
                    <input
                      value={taskModalForm.new_project_name}
                      onChange={(event) => updateTaskModalField("new_project_name", event.target.value)}
                      placeholder={language === "de" ? "Standard: Aufgabentitel" : "Default: task title"}
                    />
                  </label>
                  <label>
                    {language === "de" ? "Projektnummer" : "Project number"}
                    <input
                      value={taskModalForm.new_project_number}
                      onChange={(event) => updateTaskModalField("new_project_number", event.target.value)}
                      placeholder={language === "de" ? "Optional (auto: T...)" : "Optional (auto: T...)"}
                    />
                  </label>
                </div>
              )}
            </>
          )}
          <div className="row wrap">
            <label>
              {language === "de" ? "Fälligkeitsdatum" : "Due date"}
              <input
                type="date"
                value={taskModalForm.due_date}
                onChange={(event) => updateTaskModalField("due_date", event.target.value)}
              />
            </label>
            <label>
              {language === "de" ? "Startzeit" : "Start time"}
              <input
                type="text"
                inputMode="numeric"
                placeholder="HH:MM"
                pattern={HHMM_PATTERN}
                title="HH:MM (24h)"
                maxLength={5}
                value={taskModalForm.start_time}
                onChange={(event) => updateTaskModalField("start_time", formatTimeInputForTyping(event.target.value))}
                onBlur={(event) => updateTaskModalField("start_time", formatTimeInputForBlur(event.target.value))}
              />
            </label>
          </div>
          <div className="assignee-search-block">
            <b>{language === "de" ? "Personen zuweisen" : "Assign people"}</b>
            <input
              value={taskModalForm.assignee_query}
              onChange={(event) => updateTaskModalField("assignee_query", event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                addFirstMatchingTaskModalAssignee();
              }}
              placeholder={
                language === "de"
                  ? "Namen eingeben und auswählen"
                  : "Type user name and select"
              }
            />
            {taskModalAssigneeSuggestions.length > 0 && (
              <div className="assignee-suggestions">
                {taskModalAssigneeSuggestions.map((assignee) => {
                  const hint = assigneeAvailabilityHint(assignee.id, taskModalForm.due_date);
                  return (
                    <button
                      key={assignee.id}
                      type="button"
                      className="assignee-suggestion-btn task-assignee-suggestion-btn"
                      onClick={() => addTaskModalAssignee(assignee.id)}
                    >
                      <span className="assignee-primary-label">
                        {menuUserNameById(assignee.id, assignee.display_name || assignee.full_name)} (#{assignee.id})
                      </span>
                      {hint ? <small className="assignee-availability-note">{hint}</small> : null}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="assignee-chip-list">
              {taskModalForm.assignee_ids.map((assigneeId) => {
                const assignee = assignableUsers.find((entry) => entry.id === assigneeId);
                const hint = assignee ? assigneeAvailabilityHint(assignee.id, taskModalForm.due_date) : "";
                return (
                  <button
                    key={assigneeId}
                    type="button"
                    className="assignee-chip task-assignee-chip"
                    onClick={() => removeTaskModalAssignee(assigneeId)}
                    title={language === "de" ? "Entfernen" : "Remove"}
                  >
                    <span>
                      {(assignee
                        ? menuUserNameById(assignee.id, assignee.display_name || assignee.full_name)
                        : `#${assigneeId}`) + " ×"}
                    </span>
                    {hint ? <small className="assignee-availability-note">{hint}</small> : null}
                  </button>
                );
              })}
              {taskModalForm.assignee_ids.length === 0 && (
                <small className="muted">
                  {language === "de"
                    ? "Noch keine Personen ausgewählt."
                    : "No people selected yet."}
                </small>
              )}
            </div>
          </div>
          <div className="row wrap">
            <button type="submit">{language === "de" ? "Speichern" : "Save"}</button>
            <button type="button" onClick={closeTaskModal}>
              {language === "de" ? "Abbrechen" : "Cancel"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
