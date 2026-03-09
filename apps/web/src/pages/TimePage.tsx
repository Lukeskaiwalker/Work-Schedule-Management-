import { useRef } from "react";
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
    timeTargetUser,
    menuUserNameById,
    timeMonthCursor,
    setTimeMonthCursor,
    monthCursorLabel,
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
  } = useAppContext();

  // timeInfoRef is local to this component — not needed in global context
  const timeInfoRef = useRef<HTMLDivElement | null>(null);

  if (mainView !== "time") return null;

  return (
    <section className="grid time-grid">
      <div className="card time-current-card">
        <div className="row wrap time-current-head">
          <h3>{language === "de" ? "Aktuelle Schicht" : "Current shift"}</h3>
          <div ref={timeInfoRef} className={timeInfoOpen ? "time-info-wrap open" : "time-info-wrap"}>
            <button
              type="button"
              className="time-info-trigger"
              onClick={() => setTimeInfoOpen(!timeInfoOpen)}
              aria-expanded={timeInfoOpen}
              aria-label={language === "de" ? "Schichtdetails anzeigen" : "Show shift details"}
            >
              <small className="muted">
                {language === "de" ? "Aktuelle Uhrzeit" : "Current time"}:{" "}
                <b>{now.toLocaleTimeString(language === "de" ? "de-DE" : "en-US")}</b>
              </small>
            </button>
            <div className="time-info-popover">
              {timeCurrent?.clock_entry_id ? (
                <div className="metric-grid time-info-metrics">
                  <div><b>{language === "de" ? "Schicht-ID" : "Shift ID"}:</b> {timeCurrent.clock_entry_id}</div>
                  <div>
                    <b>{language === "de" ? "Eingestempelt" : "Clocked in"}:</b>{" "}
                    {formatServerDateTime(timeCurrent.clock_in || "", language)}
                  </div>
                  <div><b>{language === "de" ? "Arbeitszeit" : "Worked"}:</b> {timeCurrent.worked_hours_live}h</div>
                  <div><b>{language === "de" ? "Pause" : "Break"}:</b> {timeCurrent.break_hours_live}h</div>
                  <div><b>{language === "de" ? "Gesetzliche Pause" : "Legal break"}:</b> {timeCurrent.required_break_hours_live}h</div>
                  <div><b>{language === "de" ? "Nettozeit Schicht" : "Net shift hours"}:</b> {timeCurrent.net_hours_live}h</div>
                </div>
              ) : (
                <p className="muted">{language === "de" ? "Keine offene Schicht." : "No open shift."}</p>
              )}
              <small className="muted">
                {language === "de"
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
              {language === "de" ? "Ausstempeln" : "Clock out"}
            </button>
          ) : (
            <button onClick={clockIn} disabled={!viewingOwnTime}>
              {language === "de" ? "Einstempeln" : "Clock in"}
            </button>
          )}
          {Boolean(timeCurrent?.clock_entry_id) &&
            (timeCurrent?.break_open ? (
              <button onClick={endBreak} disabled={!viewingOwnTime}>
                {language === "de" ? "Pause Ende" : "Break end"}
              </button>
            ) : (
              <button onClick={startBreak} disabled={!viewingOwnTime}>
                {language === "de" ? "Pause Start" : "Break start"}
              </button>
            ))}
          <a
            href={`/api/time/timesheet/export.csv${isTimeManager && timeTargetUserId ? `?user_id=${Number(timeTargetUserId)}` : ""}`}
            target="_blank"
            rel="noreferrer"
          >
            {language === "de" ? "CSV Export" : "CSV export"}
          </a>
        </div>
        {!viewingOwnTime && (
          <small className="muted">
            {language === "de"
              ? "Sie sehen die Zeitdaten eines Mitarbeiters. Clock-In/Out ist deaktiviert."
              : "You are viewing another employee. Clock actions are disabled."}
          </small>
        )}
      </div>

      <div className="card time-month-card">
        <h3>{language === "de" ? "Monats- und Wochenstunden" : "Monthly and weekly hours"}</h3>
        <div className="time-month-nav">
          <button
            type="button"
            className="icon-btn"
            onClick={() => setTimeMonthCursor(shiftMonthStart(timeMonthCursor, -1))}
            aria-label={language === "de" ? "Vorheriger Monat" : "Previous month"}
          >
            ←
          </button>
          <b>{monthCursorLabel}</b>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setTimeMonthCursor(shiftMonthStart(timeMonthCursor, 1))}
            aria-label={language === "de" ? "Nächster Monat" : "Next month"}
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
            {language === "de" ? "Überstunden" : "Overtime"}: {formatHours(monthlyWorkedHours - monthlyRequiredHours)}
          </small>
        )}
        <div className="weekly-hours-list">
          {timeMonthRows.map((row) => (
            <WeeklyHoursGauge key={`${row.weekYear}-${row.weekNumber}-${row.weekStart}`} language={language} row={row} />
          ))}
        </div>
      </div>

      <div className="card time-entries-card">
        <div className="row wrap">
          <h3>{language === "de" ? "Wochenbuchungen" : "Weekly entries"}</h3>
          {isTimeManager && (
            <input
              type="number"
              placeholder={language === "de" ? "Mitarbeiter-ID filtern" : "Filter by user ID"}
              value={timeTargetUserId}
              onChange={(e) => setTimeTargetUserId(e.target.value)}
            />
          )}
          {isTimeManager && timeTargetUser && (
            <small className="muted">
              {language === "de" ? "Filter aktiv" : "Filter active"}:{" "}
              {menuUserNameById(timeTargetUser.id, timeTargetUser.display_name || timeTargetUser.full_name)}
            </small>
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
                <button type="submit">{language === "de" ? "Ändern" : "Update"}</button>
              </div>
            </form>
          ))}
        </div>
      </div>

      <div className="card time-requests-card">
        <h3>{language === "de" ? "Urlaubsanträge" : "Vacation requests"}</h3>
        <form className="modal-form" onSubmit={submitVacationRequest}>
          <div className="row wrap">
            <label>
              {language === "de" ? "Von" : "From"}
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
              {language === "de" ? "Bis" : "Until"}
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
            {language === "de" ? "Notiz" : "Note"}
            <textarea
              value={vacationRequestForm.note}
              onChange={(event) =>
                setVacationRequestForm({ ...vacationRequestForm, note: event.target.value })
              }
            />
          </label>
          <button type="submit">{language === "de" ? "Antrag senden" : "Submit request"}</button>
        </form>

        {canApproveVacation && (
          <div className="metric-stack">
            <b>{language === "de" ? "Offene Anträge" : "Pending requests"}</b>
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
                      {language === "de" ? "Genehmigen" : "Approve"}
                    </button>
                    <button type="button" onClick={() => void reviewVacationRequest(row.id, "rejected")}>
                      {language === "de" ? "Ablehnen" : "Reject"}
                    </button>
                  </div>
                </li>
              ))}
              {pendingVacationRequests.length === 0 && (
                <li className="muted">{language === "de" ? "Keine offenen Anträge." : "No pending requests."}</li>
              )}
            </ul>
          </div>
        )}

        <div className="metric-stack">
          <b>{language === "de" ? "Genehmigter Urlaub" : "Approved vacation"}</b>
          <ul className="overview-list">
            {approvedVacationRequests.map((row) => (
              <li key={`vacation-approved-${row.id}`}>
                <small>
                  {menuUserNameById(row.user_id, row.user_name)}: {row.start_date} - {row.end_date}
                </small>
              </li>
            ))}
            {approvedVacationRequests.length === 0 && (
              <li className="muted">{language === "de" ? "Keine genehmigten Urlaube." : "No approved vacations."}</li>
            )}
          </ul>
        </div>
      </div>

      <div className="card time-school-card">
        <h3>{language === "de" ? "Schulzeiten / Abwesenheiten" : "School dates / absences"}</h3>
        {canManageSchoolAbsences && (
          <form className="modal-form" onSubmit={submitSchoolAbsence}>
            <label>
              {language === "de" ? "Mitarbeiter" : "Employee"}
              <select
                value={schoolAbsenceForm.user_id}
                onChange={(event) =>
                  setSchoolAbsenceForm({ ...schoolAbsenceForm, user_id: event.target.value })
                }
                required
              >
                <option value="">{language === "de" ? "Bitte auswählen" : "Please select"}</option>
                {assignableUsers.map((entry) => (
                  <option key={`school-user-${entry.id}`} value={String(entry.id)}>
                    {menuUserNameById(entry.id, entry.display_name || entry.full_name)} (#{entry.id})
                  </option>
                ))}
              </select>
            </label>
            <label>
              {language === "de" ? "Titel" : "Title"}
              <input
                value={schoolAbsenceForm.title}
                onChange={(event) =>
                  setSchoolAbsenceForm({ ...schoolAbsenceForm, title: event.target.value })
                }
                required
              />
            </label>
            <div className="row wrap">
              <label>
                {language === "de" ? "Start" : "Start"}
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
                {language === "de" ? "Ende" : "End"}
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
                <small>{language === "de" ? "Wiederholung (Mo-Fr)" : "Recurring days (Mon-Fri)"}</small>
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
                {language === "de" ? "Intervall bis (optional)" : "Recurring until (optional)"}
                <input
                  type="date"
                  value={schoolAbsenceForm.recurrence_until}
                  onChange={(event) =>
                    setSchoolAbsenceForm({ ...schoolAbsenceForm, recurrence_until: event.target.value })
                  }
                />
              </label>
            </div>
            <button type="submit">{language === "de" ? "Schulzeit speichern" : "Save school date"}</button>
          </form>
        )}
        <ul className="overview-list">
          {schoolAbsences.map((row) => (
            <li key={`school-${row.id}`} className="task-list-item">
              <div className="task-list-main">
                <b>{menuUserNameById(row.user_id, row.user_name)}</b>
                <small>
                  {row.title}: {row.start_date} - {row.end_date}
                </small>
                {row.recurrence_weekday !== null && row.recurrence_weekday !== undefined && (
                  <small>
                    {language === "de" ? "Woechentlich" : "Weekly"}:{" "}
                    {schoolWeekdayLabel(row.recurrence_weekday, language)}
                    {row.recurrence_until ? ` | ${language === "de" ? "bis" : "until"} ${row.recurrence_until}` : ""}
                  </small>
                )}
              </div>
              {canManageSchoolAbsences && (
                <div className="row wrap task-actions">
                  <button type="button" className="danger-btn" onClick={() => void removeSchoolAbsence(row.id)}>
                    {language === "de" ? "Löschen" : "Delete"}
                  </button>
                </div>
              )}
            </li>
          ))}
          {schoolAbsences.length === 0 && (
            <li className="muted">{language === "de" ? "Keine Schulzeiten vorhanden." : "No school dates found."}</li>
          )}
        </ul>
      </div>
    </section>
  );
}
