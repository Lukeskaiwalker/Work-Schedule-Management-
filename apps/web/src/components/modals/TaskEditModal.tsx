import { useAppContext } from "../../context/AppContext";
import { HHMM_PATTERN } from "../../constants";
import { taskTypeLabel, normalizeTaskTypeValue, formatTimeInputForTyping, formatTimeInputForBlur } from "../../utils/tasks";
import { formatServerDateTime } from "../../utils/dates";

export function TaskEditModal() {
  const {
    language,
    taskEditModalOpen,
    taskEditForm,
    setTaskEditForm,
    taskEditMaterialRows,
    taskEditProjectClassTemplates,
    taskEditAssigneeSuggestions,
    taskEditExpectedUpdatedAt,
    assignableUsers,
    taskStatusOptions,
    canManageTasks,
    closeTaskEditModal,
    saveTaskEdit,
    deleteTaskFromEdit,
    updateTaskEditField,
    updateTaskEditMaterialRow,
    addTaskEditMaterialRow,
    removeTaskEditMaterialRow,
    selectTaskEditClassTemplate,
    addTaskEditAssignee,
    removeTaskEditAssignee,
    addFirstMatchingTaskEditAssignee,
    enrichTaskEditMaterialRowFromCatalog,
    assigneeAvailabilityHint,
    menuUserNameById,
    onTaskEditModalBackdropPointerDown,
    onTaskEditModalBackdropPointerUp,
    resetTaskEditModalBackdropPointerState,
  } = useAppContext();

  if (!taskEditModalOpen) return null;

  return (
    <div
      className="modal-backdrop"
      onPointerDown={onTaskEditModalBackdropPointerDown}
      onPointerUp={onTaskEditModalBackdropPointerUp}
      onPointerCancel={resetTaskEditModalBackdropPointerState}
      onPointerLeave={resetTaskEditModalBackdropPointerState}
    >
      <div className="card modal-card" onClick={(event) => event.stopPropagation()}>
        <h3>{language === "de" ? "Aufgabe bearbeiten" : "Edit task"}</h3>
        <form
          className="modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveTaskEdit();
          }}
        >
          <label>
            {language === "de" ? "Titel" : "Title"}
            <input
              value={taskEditForm.title}
              onChange={(event) => updateTaskEditField("title", event.target.value)}
              placeholder={language === "de" ? "Aufgabentitel" : "Task title"}
              required
            />
          </label>
          <label>
            {language === "de" ? "Information" : "Information"}
            <textarea
              value={taskEditForm.description}
              onChange={(event) => updateTaskEditField("description", event.target.value)}
              placeholder={language === "de" ? "Beschreibung der Aufgabe" : "Task description"}
            />
          </label>
          <label>
            {language === "de" ? "Unteraufgaben" : "Sub-tasks"}
            <textarea
              value={taskEditForm.subtasks_raw}
              onChange={(event) => updateTaskEditField("subtasks_raw", event.target.value)}
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
              {taskEditMaterialRows.map((row, index) => (
                <div key={row.id} className="report-material-grid-row">
                  <input
                    value={row.item}
                    onChange={(event) => updateTaskEditMaterialRow(index, "item", event.target.value)}
                    onBlur={() => {
                      void enrichTaskEditMaterialRowFromCatalog(index, "item");
                    }}
                    placeholder={language === "de" ? "z.B. Kabel NYM" : "e.g. cable NYM"}
                  />
                  <input
                    value={row.qty}
                    onChange={(event) => updateTaskEditMaterialRow(index, "qty", event.target.value)}
                    placeholder="1"
                  />
                  <input
                    value={row.unit}
                    list="material-unit-options"
                    onChange={(event) => updateTaskEditMaterialRow(index, "unit", event.target.value)}
                    placeholder={language === "de" ? "Stk" : "pcs"}
                  />
                  <input
                    value={row.article_no}
                    onChange={(event) => updateTaskEditMaterialRow(index, "article_no", event.target.value)}
                    onBlur={() => {
                      void enrichTaskEditMaterialRowFromCatalog(index, "article_no");
                    }}
                    placeholder="A-1001"
                  />
                  <button type="button" onClick={() => removeTaskEditMaterialRow(index)} aria-label="Remove">
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button type="button" onClick={addTaskEditMaterialRow}>
              {language === "de" ? "Materialzeile hinzufügen" : "Add material row"}
            </button>
          </div>
          <label>
            {language === "de" ? "Aufgabentyp" : "Task type"}
            <select
              value={taskEditForm.task_type}
              onChange={(event) => updateTaskEditField("task_type", normalizeTaskTypeValue(event.target.value))}
            >
              <option value="construction">{taskTypeLabel("construction", language)}</option>
              <option value="office">{taskTypeLabel("office", language)}</option>
              <option value="customer_appointment">{taskTypeLabel("customer_appointment", language)}</option>
            </select>
          </label>
          <label>
            {language === "de" ? "Projektklasse (optional)" : "Project class (optional)"}
            <select
              value={taskEditForm.class_template_id}
              onChange={(event) => selectTaskEditClassTemplate(event.target.value)}
            >
              <option value="">{language === "de" ? "Keine Klasse" : "No class"}</option>
              {taskEditProjectClassTemplates.map((entry) => (
                <option key={`task-edit-class-template-${entry.id}`} value={String(entry.id)}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox-inline">
            <input
              type="checkbox"
              checked={taskEditForm.has_storage_box}
              onChange={(event) =>
                setTaskEditForm((current) => ({
                  ...current,
                  has_storage_box: event.target.checked,
                  storage_box_number: event.target.checked ? current.storage_box_number : "",
                }))
              }
            />
            {language === "de" ? "Material aus Lagerbox verwenden" : "Use materials from warehouse box"}
          </label>
          {taskEditForm.has_storage_box && (
            <label>
              {language === "de" ? "Lagerbox-Nummer" : "Storage box number"}
              <input
                type="number"
                min={1}
                step={1}
                value={taskEditForm.storage_box_number}
                onChange={(event) => updateTaskEditField("storage_box_number", event.target.value)}
                required
              />
            </label>
          )}
          <div className="row wrap">
            <label>
              {language === "de" ? "Status" : "Status"}
              <select
                value={taskEditForm.status}
                onChange={(event) => updateTaskEditField("status", event.target.value)}
                required
              >
                {taskStatusOptions.map((statusValue) => (
                  <option key={statusValue} value={statusValue}>
                    {statusValue}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {language === "de" ? "Zuletzt bearbeitet" : "Last edited"}
              <input
                type="text"
                value={
                  taskEditExpectedUpdatedAt
                    ? formatServerDateTime(taskEditExpectedUpdatedAt, language)
                    : language === "de"
                      ? "Unbekannt"
                      : "Unknown"
                }
                readOnly
              />
            </label>
          </div>
          <div className="row wrap">
            <label>
              {language === "de" ? "Fälligkeitsdatum" : "Due date"}
              <input
                type="date"
                value={taskEditForm.due_date}
                onChange={(event) => updateTaskEditField("due_date", event.target.value)}
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
                value={taskEditForm.start_time}
                onChange={(event) => updateTaskEditField("start_time", formatTimeInputForTyping(event.target.value))}
                onBlur={(event) => updateTaskEditField("start_time", formatTimeInputForBlur(event.target.value))}
              />
            </label>
          </div>
          <div className="assignee-search-block">
            <b>{language === "de" ? "Personen zuweisen" : "Assign people"}</b>
            <input
              value={taskEditForm.assignee_query}
              onChange={(event) => updateTaskEditField("assignee_query", event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                addFirstMatchingTaskEditAssignee();
              }}
              placeholder={
                language === "de" ? "Namen eingeben und auswählen" : "Type user name and select"
              }
            />
            {taskEditAssigneeSuggestions.length > 0 && (
              <div className="assignee-suggestions">
                {taskEditAssigneeSuggestions.map((assignee) => {
                  const hint = assigneeAvailabilityHint(assignee.id, taskEditForm.due_date);
                  return (
                    <button
                      key={assignee.id}
                      type="button"
                      className="assignee-suggestion-btn task-assignee-suggestion-btn"
                      onClick={() => addTaskEditAssignee(assignee.id)}
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
              {taskEditForm.assignee_ids.map((assigneeId) => {
                const assignee = assignableUsers.find((entry) => entry.id === assigneeId);
                const hint = assignee ? assigneeAvailabilityHint(assignee.id, taskEditForm.due_date) : "";
                return (
                  <button
                    key={assigneeId}
                    type="button"
                    className="assignee-chip task-assignee-chip"
                    onClick={() => removeTaskEditAssignee(assigneeId)}
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
              {taskEditForm.assignee_ids.length === 0 && (
                <small className="muted">
                  {language === "de" ? "Noch keine Personen ausgewählt." : "No people selected yet."}
                </small>
              )}
            </div>
          </div>
          <div className="row wrap">
            <button type="submit">{language === "de" ? "Speichern" : "Save"}</button>
            {canManageTasks && (
              <button type="button" className="danger-btn" onClick={() => void deleteTaskFromEdit()}>
                {language === "de" ? "Löschen" : "Delete"}
              </button>
            )}
            <button type="button" onClick={closeTaskEditModal}>
              {language === "de" ? "Abbrechen" : "Cancel"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
