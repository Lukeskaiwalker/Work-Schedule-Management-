import { useRef, useMemo } from "react";
import { useAppContext } from "../context/AppContext";
import { WorkHoursGauge, WeeklyHoursGauge, MonthlyHoursGauge } from "../components/gauges";
import { isoToLocalDateTimeInput } from "../utils/dates";
import { shiftMonthStart, schoolWeekdayLabel } from "../utils/dates";
import { formatHours } from "../utils/misc";
import { formatServerDateTime } from "../utils/dates";

export function TimePage() {
  const {
    mainView,
    language,
    now,
    timeCurrent,
    timeInfoOpen,
    setTimeInfoOpen,
    gaugeNetHours,
    requiredDailyHours,
    clockIn,
    clockOut,
    startBreak,
    endBreak,
    viewingOwnTime,
    isTimeManager,
    timeTargetUserId,
    setTimeTargetUserId,
    timeTargetSearch,
    setTimeTargetSearch,
    timeTargetDropdownOpen,
    setTimeTargetDropdownOpen,
    timeTargetUser,
    menuUserNameById,
    timeMonthCursor,
    setTimeMonthCursor,
    monthCursorLabel,
    monthCursorISO,
    monthlyWorkedHours,
    monthlyRequiredHours,
    timeMonthRows,
    timeEntries,
    updateTimeEntry,
    vacationRequestForm,
    setVacationRequestForm,
    submitVacationRequest,
    canApproveVacation,
    pendingVacationRequests,
    reviewVacationRequest,
    approvedVacationRequests,
    canManageSchoolAbsences,
    schoolAbsenceForm,
    setSchoolAbsenceForm,
    submitSchoolAbsence,
    assignableUsers,
    toggleSchoolRecurrenceWeekday,
    schoolAbsences,
    removeSchoolAbsence,
    absenceTypes,
    publicHolidays,
  } = useAppContext();

  // Holidays that fall within the currently displayed month
  const monthHolidays = useMemo(() => {
    return publicHolidays.filter((h) => h.date.startsWith(monthCursorISO));
  }, [publicHolidays, monthCursorISO]);

  const de = language === "de";
  const timeInfoRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLDivElement | null>(null);

  if (mainView !== "time") return null;

  // Employee combobox helpers
  const filteredEmployees = assignableUsers.filter((u) => {
    const name = menuUserNameById(u.id, u.display_name || u.full_name).toLowerCase();
    return name.includes(timeTargetSearch.toLowerCase());
  });

  function selectEmployee(userId: number, displayName: string) {
    setTimeTargetUserId(String(userId));
    setTimeTargetSearch(displayName);
    setTimeTargetDropdownOpen(false);
  }

  function clearEmployeeFilter() {
    setTimeTargetUserId("");
    setTimeTargetSearch("");
    setTimeTargetDropdownOpen(false);
  }

  // Build export URL
  const exportUrl = `/api/time/timesheet/export.xlsx?month=${monthCursorISO}${isTimeManager && timeTargetUserId ? `&user_id=${Number(timeTargetUserId)}` : ""}`;

  // Absence type label helper
  function absenceTypeLabel(key: string) {
    const t = absenceTypes.find((a) => a.key === key);
    if (!t) return key;
    return de ? t.label_de : t.label_en;
  }

  return (
    <section className="grid time-grid">
      <div className="card time-current-card">
        <div className="row wrap time-current-head">
          <h3>{de ? "Aktuelle Schicht" : "Current shift"}</h3>
          <div ref={timeInfoRef} className={timeInfoOpen ? "time-info-wrap open" : "time-info-wrap"}>
            <button
              type="button"
              className="time-info-trigger"
              onClick={() => setTimeInfoOpen(!timeInfoOpen)}
              aria-expanded={timeInfoOpen}
              aria-label={de ? "Schichtdetails anzeigen" : "Show shift details"}
            >
              <small className="muted">
                {de ? "Aktuelle Uhrzeit" : "Current time"}:{" "}
                <b>{now.toLocaleTimeString(de ? "de-DE" : "en-US")}</b>
              </small>
            </button>
            <div className="time-info-popover">
              {timeCurrent?.clock_entry_id ? (
                <div className="metric-grid time-info-metrics">
                  <div><b>{de ? "Schicht-ID" : "Shift ID"}:</b> {timeCurrent.clock_entry_id}</div>
                  <div>
                    <b>{de ? "Eingestempelt" : "Clocked in"}:</b>{" "}
                    {formatServerDateTime(timeCurrent.clock_in || "", language)}
                  </div>
                  <div><b>{de ? "Arbeitszeit" : "Worked"}:</b> {timeCurrent.worked_hours_live}h</div>
                  <div><b>{de ? "Pause" : "Break"}:</b> {timeCurrent.break_hours_live}h</div>
                  <div><b>{de ? "Gesetzliche Pause" : "Legal break"}:</b> {timeCurrent.required_break_hours_live}h</div>
                  <div><b>{de ? "Nettozeit Schicht" : "Net shift hours"}:</b> {timeCurrent.net_hours_live}h</div>
                </div>
              ) : (
                <p className="muted">{de ? "Keine offene Schicht." : "No open shift."}</p>
              )}
              <small className="muted">
                {de
                  ? "Gesetzliche Pause: über 6h = 30 Min, über 9h = 45 Min."
                  : "German legal break defaults: over 6h = 30m, over 9h = 45m."}
              </small>
            </div>
          </div>
        </div>
        <div className="time-current-main">
          <WorkHoursGauge language={language} netHours={gaugeNetHours} requiredHours={requiredDailyHours} />
        </div>
        <div className="row wrap time-current-actions">
          {timeCurrent?.clock_entry_id ? (
            <button onClick={clockOut} disabled={!viewingOwnTime}>
              {de ? "Ausstempeln" : "Clock out"}
            </button>
          ) : (
            <button onClick={clockIn} disabled={!viewingOwnTime}>
              {de ? "Einstempeln" : "Clock in"}
            </button>
          )}
          {Boolean(timeCurrent?.clock_entry_id) &&
            (timeCurrent?.break_open ? (
              <button onClick={endBreak} disabled={!viewingOwnTime}>
                {de ? "Pause Ende" : "Break end"}
              </button>
            ) : (
              <button onClick={startBreak} disabled={!viewingOwnTime}>
                {de ? "Pause Start" : "Break start"}
              </button>
            ))}
          <a href={exportUrl} target="_blank" rel="noreferrer" className="btn-secondary">
            {de ? `Export ${monthCursorLabel}` : `Export ${monthCursorLabel}`}
          </a>
        </div>
        {!viewingOwnTime && (
          <small className="muted">
            {de
              ? "Sie sehen die Zeitdaten eines Mitarbeiters. Clock-In/Out ist deaktiviert."
              : "You are viewing another employee. Clock actions are disabled."}
          </small>
        )}
      </div>

      <div className="card time-month-card">
        <h3>{de ? "Monats- und Wochenstunden" : "Monthly and weekly hours"}</h3>
        <div className="time-month-nav">
          <button
            type="button"
            className="icon-btn"
            onClick={() => setTimeMonthCursor(shiftMonthStart(timeMonthCursor, -1))}
            aria-label={de ? "Vorheriger Monat" : "Previous month"}
          >
            ←
          </button>
          <b>{monthCursorLabel}</b>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setTimeMonthCursor(shiftMonthStart(timeMonthCursor, 1))}
            aria-label={de ? "Nächster Monat" : "Next month"}
          >
            →
          </button>
        </div>
        <MonthlyHoursGauge
          language={language}
          workedHours={monthlyWorkedHours}
          requiredHours={monthlyRequiredHours}
        />
        {monthlyWorkedHours > monthlyRequiredHours && (
          <small className="muted">
            {de ? "Überstunden" : "Overtime"}: {formatHours(monthlyWorkedHours - monthlyRequiredHours)}
          </small>
        )}
        <div className="weekly-hours-list">
          {timeMonthRows.map((row) => (
            <WeeklyHoursGauge key={`${row.weekYear}-${row.weekNumber}-${row.weekStart}`} language={language} row={row} />
          ))}
        </div>
        {monthHolidays.length > 0 && (
          <div className="month-holidays-list">
            <small className="muted">{de ? "Feiertage (NRW)" : "Public holidays (NRW)"}</small>
            {monthHolidays.map((h) => (
              <div key={h.date} className="month-holiday-row">
                <span className="month-holiday-date">
                  {new Date(h.date + "T00:00:00").toLocaleDateString(de ? "de-DE" : "en-GB", { day: "2-digit", month: "2-digit" })}
                </span>
                <span className="month-holiday-name">{h.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card time-entries-card">
        <div className="row wrap">
          <h3>{de ? "Wochenbuchungen" : "Weekly entries"}</h3>
          {isTimeManager && (
            <div ref={searchRef} className="employee-search-wrap">
              <div className="employee-search-input-row">
                <input
                  type="text"
                  className="employee-search-input"
                  placeholder={de ? "Mitarbeiter suchen…" : "Search employee…"}
                  value={timeTargetSearch}
                  onChange={(e) => {
                    setTimeTargetSearch(e.target.value);
                    setTimeTargetDropdownOpen(true);
                    if (!e.target.value) setTimeTargetUserId("");
                  }}
                  onFocus={() => setTimeTargetDropdownOpen(true)}
                  onBlur={() => setTimeout(() => setTimeTargetDropdownOpen(false), 150)}
                  autoComplete="off"
                />
                {timeTargetSearch && (
                  <button
                    type="button"
                    className="employee-search-clear"
                    onClick={clearEmployeeFilter}
                    aria-label={de ? "Filter zurücksetzen" : "Clear filter"}
                  >
                    ×
                  </button>
                )}
              </div>
              {timeTargetDropdownOpen && filteredEmployees.length > 0 && (
                <ul className="employee-search-dropdown">
                  {filteredEmployees.map((u) => {
                    const name = menuUserNameById(u.id, u.display_name || u.full_name);
                    return (
                      <li
                        key={u.id}
                        className="employee-search-option"
                        onMouseDown={() => selectEmployee(u.id, name)}
                      >
                        {name}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
        <div className="time-entry-list">
          {timeEntries.map((entry) => (
            <form key={entry.id} className="time-entry" onSubmit={(event) => updateTimeEntry(event, entry.id)}>
              <div className="row wrap">
                <b>#{entry.id}</b>
                <span>user {entry.user_id}</span>
                <span>{entry.net_hours}h</span>
              </div>
              <div className="grid compact">
                <label>
                  Clock in
                  <input type="datetime-local" name="clock_in" required defaultValue={isoToLocalDateTimeInput(entry.clock_in)} />
                </label>
                <label>
                  Clock out
                  <input type="datetime-local" name="clock_out" defaultValue={isoToLocalDateTimeInput(entry.clock_out)} />
                </label>
                <label>
                  Break min
                  <input type="number" name="break_minutes" min={0} defaultValue={Math.round(entry.break_hours * 60)} />
                </label>
              </div>
              <div className="row wrap">
                <small>
                  break: {entry.break_hours}h | legal: {entry.required_break_hours}h | deducted: {entry.deducted_break_hours}h
                </small>
                <button type="submit">{de ? "Ändern" : "Update"}</button>
              </div>
            </form>
          ))}
        </div>
      </div>

      <div className="card time-requests-card">
        <h3>{de ? "Urlaubsanträge" : "Vacation requests"}</h3>
        <form className="modal-form" onSubmit={submitVacationRequest}>
          <div className="row wrap">
            <label>
              {de ? "Von" : "From"}
              <input
                type="date"
                value={vacationRequestForm.start_date}
                onChange={(event) =>
                  setVacationRequestForm({ ...vacationRequestForm, start_date: event.target.value })
                }
                required
              />
            </label>
            <label>
              {de ? "Bis" : "Until"}
              <input
                type="date"
                value={vacationRequestForm.end_date}
                onChange={(event) =>
                  setVacationRequestForm({ ...vacationRequestForm, end_date: event.target.value })
                }
                required
              />
            </label>
          </div>
          <label>
            {de ? "Notiz" : "Note"}
            <textarea
              value={vacationRequestForm.note}
              onChange={(event) =>
                setVacationRequestForm({ ...vacationRequestForm, note: event.target.value })
              }
            />
          </label>
          <button type="submit">{de ? "Antrag senden" : "Submit request"}</button>
        </form>

        {canApproveVacation && (
          <div className="metric-stack">
            <b>{de ? "Offene Anträge" : "Pending requests"}</b>
            <ul className="overview-list">
              {pendingVacationRequests.map((row) => (
                <li key={`vacation-pending-${row.id}`} className="task-list-item">
                  <div className="task-list-main">
                    <b>{menuUserNameById(row.user_id, row.user_name)}</b>
                    <small>
                      {row.start_date} - {row.end_date}
                    </small>
                    {row.note && <small>{row.note}</small>}
                  </div>
                  <div className="row wrap task-actions">
                    <button type="button" onClick={() => void reviewVacationRequest(row.id, "approved")}>
                      {de ? "Genehmigen" : "Approve"}
                    </button>
                    <button type="button" onClick={() => void reviewVacationRequest(row.id, "rejected")}>
                      {de ? "Ablehnen" : "Reject"}
                    </button>
                  </div>
                </li>
              ))}
              {pendingVacationRequests.length === 0 && (
                <li className="muted">{de ? "Keine offenen Anträge." : "No pending requests."}</li>
              )}
            </ul>
          </div>
        )}

        <div className="metric-stack">
          <b>{de ? "Genehmigter Urlaub" : "Approved vacation"}</b>
          <ul className="overview-list">
            {approvedVacationRequests.map((row) => (
              <li key={`vacation-approved-${row.id}`}>
                <small>
                  {menuUserNameById(row.user_id, row.user_name)}: {row.start_date} - {row.end_date}
                </small>
              </li>
            ))}
            {approvedVacationRequests.length === 0 && (
              <li className="muted">{de ? "Keine genehmigten Urlaube." : "No approved vacations."}</li>
            )}
          </ul>
        </div>
      </div>

      <div className="card time-school-card">
        <h3>{de ? "Abwesenheiten" : "Absences"}</h3>
        {canManageSchoolAbsences && (
          <form className="modal-form" onSubmit={submitSchoolAbsence}>
            <label>
              {de ? "Mitarbeiter" : "Employee"}
              <select
                value={schoolAbsenceForm.user_id}
                onChange={(event) =>
                  setSchoolAbsenceForm({ ...schoolAbsenceForm, user_id: event.target.value })
                }
                required
              >
                <option value="">{de ? "Bitte auswählen" : "Please select"}</option>
                {assignableUsers.map((entry) => (
                  <option key={`school-user-${entry.id}`} value={String(entry.id)}>
                    {menuUserNameById(entry.id, entry.display_name || entry.full_name)} (#{entry.id})
                  </option>
                ))}
              </select>
            </label>
            <div className="row wrap">
              <label>
                {de ? "Abwesenheitsart" : "Absence type"}
                <select
                  value={schoolAbsenceForm.absence_type}
                  onChange={(event) => {
                    const selectedType = absenceTypes.find((t) => t.key === event.target.value);
                    const defaultTitle = selectedType
                      ? (de ? selectedType.label_de : selectedType.label_en)
                      : schoolAbsenceForm.title;
                    setSchoolAbsenceForm({
                      ...schoolAbsenceForm,
                      absence_type: event.target.value,
                      title: defaultTitle,
                    });
                  }}
                  required
                >
                  {absenceTypes.map((t) => (
                    <option key={t.key} value={t.key}>
                      {de ? t.label_de : t.label_en}
                      {t.counts_as_hours ? "" : (de ? " (keine Stundenanrechnung)" : " (no hours credit)")}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {de ? "Bezeichnung" : "Title"}
                <input
                  value={schoolAbsenceForm.title}
                  onChange={(event) =>
                    setSchoolAbsenceForm({ ...schoolAbsenceForm, title: event.target.value })
                  }
                  required
                />
              </label>
            </div>
            <div className="row wrap">
              <label>
                {de ? "Start" : "Start"}
                <input
                  type="date"
                  value={schoolAbsenceForm.start_date}
                  onChange={(event) =>
                    setSchoolAbsenceForm({ ...schoolAbsenceForm, start_date: event.target.value })
                  }
                  required
                />
              </label>
              <label>
                {de ? "Ende" : "End"}
                <input
                  type="date"
                  value={schoolAbsenceForm.end_date}
                  onChange={(event) =>
                    setSchoolAbsenceForm({ ...schoolAbsenceForm, end_date: event.target.value })
                  }
                  required
                />
              </label>
            </div>
            <div className="row wrap">
              <div className="weekday-checkbox-group">
                <small>{de ? "Wiederholung (Mo-Fr)" : "Recurring days (Mon-Fri)"}</small>
                <div className="weekday-checkbox-row">
                  {[0, 1, 2, 3, 4].map((day) => (
                    <label key={`school-day-${day}`} className="weekday-checkbox-item">
                      <input
                        type="checkbox"
                        checked={schoolAbsenceForm.recurrence_weekdays.includes(day)}
                        onChange={(event) => toggleSchoolRecurrenceWeekday(day, event.target.checked)}
                      />
                      <span>{schoolWeekdayLabel(day, language)}</span>
                    </label>
                  ))}
                </div>
              </div>
              <label>
                {de ? "Intervall bis (optional)" : "Recurring until (optional)"}
                <input
                  type="date"
                  value={schoolAbsenceForm.recurrence_until}
                  onChange={(event) =>
                    setSchoolAbsenceForm({ ...schoolAbsenceForm, recurrence_until: event.target.value })
                  }
                />
              </label>
            </div>
            <button type="submit">{de ? "Abwesenheit speichern" : "Save absence"}</button>
          </form>
        )}
        <ul className="overview-list">
          {schoolAbsences.map((row) => (
            <li key={`school-${row.id}`} className="task-list-item">
              <div className="task-list-main">
                <b>{menuUserNameById(row.user_id, row.user_name)}</b>
                <small>
                  <span className={`absence-type-badge ${row.counts_as_hours ? "counts" : "no-counts"}`}>
                    {absenceTypeLabel(row.absence_type)}
                  </span>
                  {" "}{row.title}: {row.start_date} – {row.end_date}
                </small>
                {row.recurrence_weekday !== null && row.recurrence_weekday !== undefined && (
                  <small>
                    {de ? "Wöchentlich" : "Weekly"}:{" "}
                    {schoolWeekdayLabel(row.recurrence_weekday, language)}
                    {row.recurrence_until ? ` | ${de ? "bis" : "until"} ${row.recurrence_until}` : ""}
                  </small>
                )}
                {!row.counts_as_hours && (
                  <small className="muted">{de ? "Keine Stundenanrechnung" : "No hours credited"}</small>
                )}
              </div>
              {canManageSchoolAbsences && (
                <div className="row wrap task-actions">
                  <button type="button" className="danger-btn" onClick={() => void removeSchoolAbsence(row.id)}>
                    {de ? "Löschen" : "Delete"}
                  </button>
                </div>
              )}
            </li>
          ))}
          {schoolAbsences.length === 0 && (
            <li className="muted">{de ? "Keine Abwesenheiten vorhanden." : "No absences found."}</li>
          )}
        </ul>
      </div>
    </section>
  );
}
