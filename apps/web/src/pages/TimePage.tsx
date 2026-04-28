import { useEffect, useMemo, useRef, useState } from "react";
import { useAppContext } from "../context/AppContext";
import { isoToLocalDateTimeInput } from "../utils/dates";
import { shiftMonthStart, schoolWeekdayLabel } from "../utils/dates";
import { formatHours, clamp } from "../utils/misc";
import { formatServerDateTime, parseServerDateTime } from "../utils/dates";

// ── Paper-style KPI donut ────────────────────────────────────────────────────
function TimeKpiDonut({
  worked,
  required,
  size = 72,
  stroke = 8,
}: {
  worked: number;
  required: number;
  size?: number;
  stroke?: number;
}) {
  const safeRequired = required > 0 ? required : 1;
  const percent = clamp((worked / safeRequired) * 100, 0, 100);
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (percent / 100) * circumference;
  const centerLabel = `${worked.toFixed(worked >= 10 ? 1 : 2)}h`;
  const subLabel = `of ${required.toFixed(0)}h`;
  return (
    <div className="time-kpi-donut" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#E2ECF7"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#2F70B7"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="time-kpi-donut-center">
        <span className="time-kpi-donut-value">{centerLabel}</span>
        <span className="time-kpi-donut-sub">{subLabel}</span>
      </div>
    </div>
  );
}

export function TimePage() {
  const {
    mainView,
    language,
    now,
    user,
    timeCurrent,
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
    editingSchoolAbsenceId,
    submitSchoolAbsence,
    startSchoolAbsenceEdit,
    cancelSchoolAbsenceEdit,
    assignableUsers,
    toggleSchoolRecurrenceWeekday,
    schoolAbsences,
    reviewSchoolAbsence,
    removeSchoolAbsence,
    absenceTypes,
    publicHolidays,
    setTimeEntriesStartDate,
    setTimeEntriesEndDate,
  } = useAppContext();

  // Holidays that fall within the currently displayed month
  const monthHolidays = useMemo(() => {
    return publicHolidays.filter((h) => h.date.startsWith(monthCursorISO));
  }, [publicHolidays, monthCursorISO]);

  const de = language === "de";
  const [editEntriesDate, setEditEntriesDate] = useState<string | null>(null);
  const employeeSearchRef = useRef<HTMLDivElement | null>(null);

  // Keep the entries date range synced to the currently displayed month so the
  // calendar / recent-entries / edit modal always have data for that month.
  useEffect(() => {
    const monthEnd = new Date(timeMonthCursor.getFullYear(), timeMonthCursor.getMonth() + 1, 0);
    setTimeEntriesStartDate(`${monthCursorISO}-01`);
    setTimeEntriesEndDate(`${monthCursorISO}-${String(monthEnd.getDate()).padStart(2, "0")}`);
  }, [timeMonthCursor, monthCursorISO, setTimeEntriesStartDate, setTimeEntriesEndDate]);

  if (mainView !== "time") return null;

  // Build export URL — always scope by user_id so the XLSX never accidentally
  // aggregates every employee. Managers with no explicit selection get their
  // own timesheet (matching what the calendar now shows). Non-managers don't
  // need the param; the backend resolves it to the session user.
  const exportTargetUserId: number | null = isTimeManager
    ? timeTargetUserId
      ? Number(timeTargetUserId)
      : user?.id ?? null
    : null;
  const exportUrl = `/api/time/timesheet/export.xlsx?month=${monthCursorISO}${
    exportTargetUserId != null ? `&user_id=${exportTargetUserId}` : ""
  }`;

  // Manager employee picker helpers
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

  // Absence type label helper
  function absenceTypeLabel(key: string) {
    const t = absenceTypes.find((a) => a.key === key);
    if (!t) return key;
    return de ? t.label_de : t.label_en;
  }

  function absenceStatusLabel(status: string) {
    if (status === "pending") return de ? "Offen" : "Pending";
    if (status === "rejected") return de ? "Abgelehnt" : "Rejected";
    return de ? "Genehmigt" : "Approved";
  }

  const todayIso = now.toISOString().slice(0, 10);
  const pendingAbsenceRequests = schoolAbsences.filter((row) => row.status === "pending");
  const activeApprovedAbsences = schoolAbsences.filter((row) => {
    if (row.status !== "approved") return false;
    const effectiveEnd = row.recurrence_until ?? row.end_date;
    return effectiveEnd >= todayIso;
  });
  const pastAbsenceRows = schoolAbsences
    .filter((row) => {
      const effectiveEnd = row.recurrence_until ?? row.end_date;
      return row.status !== "pending" && effectiveEnd < todayIso;
    })
    .slice(0, 10);

  // Calculate current week hours from the month rows (for the "This week" donut)
  const currentWeekRow = useMemo(() => {
    const todayIsoLocal = now.toISOString().slice(0, 10);
    return timeMonthRows.find((row) => row.weekStart <= todayIsoLocal && row.weekEnd >= todayIsoLocal)
      ?? timeMonthRows[0]
      ?? null;
  }, [timeMonthRows, now]);

  // Build day-by-day calendar data for the current month from timeEntries,
  // approved absences (vacation + school/sick/etc.), and the configured
  // region's public holidays. The personal time-tracking calendar previously
  // only summed entries; the user reported absences not showing up — they're
  // now merged in here, scoped to whichever user the page is currently
  // viewing (self, or another user when a manager has switched targets).
  // Public holidays do NOT scope by user since they apply to everyone in
  // the region.
  const monthCalendar = useMemo(() => {
    const monthDate = timeMonthCursor;
    const year = monthDate.getFullYear();
    const month = monthDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const daysInMonth = lastDay.getDate();

    // Group entry hours by YYYY-MM-DD — use parseServerDateTime so naive UTC
    // strings from the backend are read as UTC (not local), then converted
    // to the user's timezone via the Date object's getFullYear/Month/Date.
    const hoursByDate = new Map<string, number>();
    for (const entry of timeEntries) {
      const entryDate = parseServerDateTime(entry.clock_in);
      if (!entryDate) continue;
      if (entryDate.getFullYear() !== year || entryDate.getMonth() !== month) continue;
      // Build the local-time YYYY-MM-DD key manually — toISOString() would
      // give back the UTC date, which can be off by a day for late-evening
      // clock-ins in positive-offset timezones.
      const localIso =
        `${entryDate.getFullYear()}-` +
        `${String(entryDate.getMonth() + 1).padStart(2, "0")}-` +
        `${String(entryDate.getDate()).padStart(2, "0")}`;
      hoursByDate.set(localIso, (hoursByDate.get(localIso) ?? 0) + entry.net_hours);
    }

    // ── Absences by date ────────────────────────────────────────────────
    // The personal calendar shows the active target user's own absences:
    // self when no target is set, otherwise the manager's selected target.
    // School absences with `recurrence_weekday` repeat on that weekday from
    // start_date until min(end_date, recurrence_until). We mirror the
    // backend's `_expand_school_absence_days` rule client-side so the same
    // days light up that the planning endpoint would surface.
    type AbsenceMarker = { type: string; label: string };
    // timeTargetUserId is a string (form value, "" when no manager target
    // is selected). Coerce explicitly so the empty string doesn't fall
    // through to NaN/0 and match the wrong user.
    const explicitTarget =
      typeof timeTargetUserId === "string" && timeTargetUserId.trim() !== ""
        ? Number(timeTargetUserId)
        : null;
    const targetUserId: number | null =
      explicitTarget != null && Number.isFinite(explicitTarget)
        ? explicitTarget
        : (user?.id ?? null);
    const absencesByDate = new Map<string, AbsenceMarker[]>();
    const monthFirstIso = `${year}-${String(month + 1).padStart(2, "0")}-01`;
    const monthLastIso =
      `${year}-${String(month + 1).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;

    function pushAbsence(iso: string, marker: AbsenceMarker) {
      const list = absencesByDate.get(iso) ?? [];
      // Avoid duplicate markers for the same (type, label) on the same day.
      if (!list.some((m) => m.type === marker.type && m.label === marker.label)) {
        list.push(marker);
        absencesByDate.set(iso, list);
      }
    }

    function isoOfDate(d: Date): string {
      return (
        `${d.getFullYear()}-` +
        `${String(d.getMonth() + 1).padStart(2, "0")}-` +
        `${String(d.getDate()).padStart(2, "0")}`
      );
    }

    function clampIso(value: string, lo: string, hi: string): string | null {
      const lower = value < lo ? lo : value;
      if (lower > hi) return null;
      return lower;
    }

    function spanDays(startIso: string, endIso: string, push: (iso: string) => void) {
      const cursor = new Date(`${startIso}T00:00:00`);
      const stop = new Date(`${endIso}T00:00:00`);
      while (cursor <= stop) {
        push(isoOfDate(cursor));
        cursor.setDate(cursor.getDate() + 1);
      }
    }

    // Public holidays apply to everyone in the configured region (NRW today),
    // so we merge them into the day cells without a targetUserId scope. Type
    // is "holiday" so the cell picks up the existing .time-calendar-cell--
    // absence-holiday styling and matches the shape of school-absence rows
    // whose absence_type is also "holiday". The separate "Feiertage" callout
    // below the calendar still summarises them as a list — the pill on the
    // cell is purely additive.
    for (const holiday of publicHolidays) {
      if (!holiday.date.startsWith(monthCursorISO)) continue;
      pushAbsence(holiday.date, { type: "holiday", label: holiday.name });
    }

    // Vacation rows: only "approved" status comes through approvedVacationRequests.
    for (const row of approvedVacationRequests) {
      if (targetUserId != null && row.user_id !== targetUserId) continue;
      const lo = clampIso(row.start_date, monthFirstIso, monthLastIso);
      if (lo === null) continue;
      const hiCandidate = row.end_date > monthLastIso ? monthLastIso : row.end_date;
      if (hiCandidate < lo) continue;
      const label = de ? "Urlaub" : "Vacation";
      spanDays(lo, hiCandidate, (iso) => pushAbsence(iso, { type: "vacation", label }));
    }

    // School / sick / Berufsschule / etc. — drop pending+rejected.
    for (const row of schoolAbsences) {
      if (row.status !== "approved") continue;
      if (targetUserId != null && row.user_id !== targetUserId) continue;
      const typeMeta = absenceTypes.find((t) => t.key === row.absence_type);
      const label = typeMeta ? (de ? typeMeta.label_de : typeMeta.label_en) : row.title;

      if (row.recurrence_weekday == null) {
        const lo = clampIso(row.start_date, monthFirstIso, monthLastIso);
        if (lo === null) continue;
        const hiCandidate = row.end_date > monthLastIso ? monthLastIso : row.end_date;
        if (hiCandidate < lo) continue;
        spanDays(lo, hiCandidate, (iso) =>
          pushAbsence(iso, { type: row.absence_type, label }),
        );
        continue;
      }

      // Recurring: include only days where weekday matches recurrence_weekday.
      // The DB convention is Python's date.weekday() (0=Mon..6=Sun); JS's
      // Date.getDay() is 0=Sun..6=Sat. Convert via (jsDay + 6) % 7.
      const recurUpper =
        row.recurrence_until && row.recurrence_until < monthLastIso
          ? row.recurrence_until
          : monthLastIso;
      const lo = clampIso(row.start_date, monthFirstIso, monthLastIso);
      if (lo === null) continue;
      const hiCandidate = row.end_date > recurUpper ? recurUpper : row.end_date;
      if (hiCandidate < lo) continue;
      spanDays(lo, hiCandidate, (iso) => {
        const cursorDate = new Date(`${iso}T00:00:00`);
        const pyWeekday = (cursorDate.getDay() + 6) % 7;
        if (pyWeekday === row.recurrence_weekday) {
          pushAbsence(iso, { type: row.absence_type, label });
        }
      });
    }

    // Build 6-row × 7-col grid starting on Monday
    type CalendarCell = {
      date: number | null;
      iso: string;
      hours: number;
      isToday: boolean;
      isPast: boolean;
      absences: AbsenceMarker[];
    };
    const cells: CalendarCell[] = [];
    // JS: 0 = Sunday, 1 = Monday, ..., 6 = Saturday. We want Monday as first.
    const firstWeekdayJs = firstDay.getDay(); // 0..6 (Sun..Sat)
    const leadingBlanks = firstWeekdayJs === 0 ? 6 : firstWeekdayJs - 1;
    for (let i = 0; i < leadingBlanks; i += 1) {
      cells.push({ date: null, iso: "", hours: 0, isToday: false, isPast: false, absences: [] });
    }
    const todayIso = now.toISOString().slice(0, 10);
    for (let d = 1; d <= daysInMonth; d += 1) {
      const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      cells.push({
        date: d,
        iso,
        hours: hoursByDate.get(iso) ?? 0,
        isToday: iso === todayIso,
        isPast: iso < todayIso,
        absences: absencesByDate.get(iso) ?? [],
      });
    }
    // Pad to full rows of 7
    while (cells.length % 7 !== 0) {
      cells.push({ date: null, iso: "", hours: 0, isToday: false, isPast: false, absences: [] });
    }
    return cells;
  }, [
    timeMonthCursor,
    timeEntries,
    now,
    approvedVacationRequests,
    schoolAbsences,
    absenceTypes,
    publicHolidays,
    monthCursorISO,
    timeTargetUserId,
    user?.id,
    de,
  ]);

  // Group recent entries by date for the Paper-style Recent Entries list (latest 4-6 days)
  const recentEntriesGrouped = useMemo(() => {
    const sorted = [...timeEntries].sort((a, b) => (a.clock_in < b.clock_in ? 1 : -1));
    const groups = new Map<string, typeof timeEntries>();
    for (const entry of sorted) {
      const parsed = parseServerDateTime(entry.clock_in);
      if (!parsed) continue;
      const iso =
        `${parsed.getFullYear()}-` +
        `${String(parsed.getMonth() + 1).padStart(2, "0")}-` +
        `${String(parsed.getDate()).padStart(2, "0")}`;
      const arr = groups.get(iso) ?? [];
      arr.push(entry);
      groups.set(iso, arr);
    }
    return Array.from(groups.entries()).slice(0, 6);
  }, [timeEntries]);

  function formatTimeHHMM(iso: string | null | undefined): string {
    const d = parseServerDateTime(iso);
    if (!d) return "--:--";
    return d.toLocaleTimeString(de ? "de-DE" : "en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  function recentGroupLabel(iso: string): string {
    const date = new Date(iso + "T00:00:00");
    const today = new Date(now.toISOString().slice(0, 10) + "T00:00:00");
    const diffDays = Math.round((today.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return (de ? "HEUTE" : "TODAY") + ", " + date.toLocaleDateString(de ? "de-DE" : "en-US", { month: "short", day: "numeric" }).toUpperCase();
    if (diffDays === 1) return (de ? "GESTERN" : "YESTERDAY") + ", " + date.toLocaleDateString(de ? "de-DE" : "en-US", { month: "short", day: "numeric" }).toUpperCase();
    const weekday = date.toLocaleDateString(de ? "de-DE" : "en-US", { weekday: "long" }).toUpperCase();
    const rest = date.toLocaleDateString(de ? "de-DE" : "en-US", { month: "short", day: "numeric" }).toUpperCase();
    return `${weekday}, ${rest}`;
  }

  function entriesForDate(iso: string) {
    return timeEntries.filter((entry) => {
      const parsed = parseServerDateTime(entry.clock_in);
      if (!parsed) return false;
      const local =
        `${parsed.getFullYear()}-` +
        `${String(parsed.getMonth() + 1).padStart(2, "0")}-` +
        `${String(parsed.getDate()).padStart(2, "0")}`;
      return local === iso;
    });
  }

  function formatDayHeading(iso: string): string {
    const d = new Date(iso + "T00:00:00");
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(de ? "de-DE" : "en-US", {
      weekday: "long",
      day: "2-digit",
      month: "long",
      year: "numeric",
    });
  }
  const weekWorkedHours = currentWeekRow?.workedHours ?? 0;
  const weekRequiredHours = currentWeekRow?.requiredHours ?? 40;
  const weekPercent = weekRequiredHours > 0 ? (weekWorkedHours / weekRequiredHours) * 100 : 0;
  const weekLabel = currentWeekRow ? `KW ${currentWeekRow.weekNumber}` : "";

  const monthPercent = monthlyRequiredHours > 0 ? (monthlyWorkedHours / monthlyRequiredHours) * 100 : 0;
  const todayPercent = requiredDailyHours > 0 ? (gaugeNetHours / requiredDailyHours) * 100 : 0;
  const clockedInParsed = parseServerDateTime(timeCurrent?.clock_in);
  const clockedInLabel = clockedInParsed
    ? clockedInParsed.toLocaleTimeString(de ? "de-DE" : "en-US", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  const bigTimeDisplay = (() => {
    const hours = Math.floor(gaugeNetHours);
    const minutes = Math.round((gaugeNetHours - hours) * 60);
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  })();
  const todayDateLabel = now.toLocaleDateString(de ? "de-DE" : "en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const monthDayInfo = (() => {
    const monthDate = timeMonthCursor;
    const lastDay = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0).getDate();
    const todayInMonth =
      now.getFullYear() === monthDate.getFullYear() && now.getMonth() === monthDate.getMonth()
        ? now.getDate()
        : lastDay;
    return { lastDay, todayInMonth, daysLeft: Math.max(lastDay - todayInMonth, 0) };
  })();

  return (
    <section className="time-page">
      {/* ── Manager toolbar (employee picker + export) ─────────────── */}
      {isTimeManager && (
        <div className="time-manager-toolbar">
          <div ref={employeeSearchRef} className="time-employee-search">
            <label className="time-employee-search-label">
              {de ? "Mitarbeiter" : "Employee"}
            </label>
            <div className="time-employee-search-input-wrap">
              <svg
                className="time-employee-search-icon"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="6.3" stroke="#5C7895" strokeWidth="1.8" />
                <path
                  d="m15.6 15.6 4 4"
                  stroke="#5C7895"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
              <input
                type="text"
                className="time-employee-search-input"
                placeholder={de ? "Mitarbeiter suchen…" : "Search employee…"}
                value={timeTargetSearch}
                onChange={(event) => {
                  setTimeTargetSearch(event.target.value);
                  setTimeTargetDropdownOpen(true);
                  if (!event.target.value) setTimeTargetUserId("");
                }}
                onFocus={() => setTimeTargetDropdownOpen(true)}
                onBlur={() => setTimeout(() => setTimeTargetDropdownOpen(false), 150)}
                autoComplete="off"
              />
              {timeTargetSearch && (
                <button
                  type="button"
                  className="time-employee-search-clear"
                  onClick={clearEmployeeFilter}
                  aria-label={de ? "Filter zurücksetzen" : "Clear filter"}
                >
                  ×
                </button>
              )}
            </div>
            {timeTargetDropdownOpen && filteredEmployees.length > 0 && (
              <ul className="time-employee-search-dropdown">
                {filteredEmployees.slice(0, 10).map((u) => {
                  const name = menuUserNameById(u.id, u.display_name || u.full_name);
                  return (
                    <li
                      key={`emp-${u.id}`}
                      className="time-employee-search-option"
                      onMouseDown={() => selectEmployee(u.id, name)}
                    >
                      {name}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {!timeTargetUserId ? (
            <span className="time-manager-toolbar-status muted">
              {de ? "Sie sehen Ihre eigenen Daten." : "Viewing your own data."}
            </span>
          ) : (
            <span className="time-manager-toolbar-status time-manager-toolbar-status--alt">
              {de ? "Mitarbeitendenansicht aktiv" : "Employee view active"}
            </span>
          )}
          <a
            href={exportUrl}
            target="_blank"
            rel="noreferrer"
            className="time-manager-toolbar-export"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M12 4v12m0 0-4-4m4 4 4-4M5 18h14"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {de ? "Export" : "Export"} {monthCursorLabel}
          </a>
        </div>
      )}

      {/* ── Row 1: KPI cards ───────────────────────────────────────── */}
      <div className="time-kpi-row">
        <div className="time-kpi-card time-kpi-card--clocked">
          <div className="time-kpi-clocked-head">
            {timeCurrent?.clock_entry_id ? (
              <span className="time-kpi-clocked-status time-kpi-clocked-status--active">
                <span aria-hidden="true" className="time-kpi-clocked-dot" />
                {de ? "Eingestempelt" : "Clocked in"}
                {clockedInLabel && <> · {clockedInLabel}</>}
              </span>
            ) : (
              <span className="time-kpi-clocked-status">
                <span aria-hidden="true" className="time-kpi-clocked-dot time-kpi-clocked-dot--off" />
                {de ? "Nicht eingestempelt" : "Not clocked in"}
              </span>
            )}
          </div>
          <div className="time-kpi-clocked-value-wrap">
            <div
              className="time-kpi-clocked-value"
              tabIndex={0}
              role="button"
              aria-label={de ? "Schichtdetails anzeigen" : "Show shift details"}
            >
              {bigTimeDisplay}
            </div>
            <div className="time-kpi-clocked-popover" role="tooltip">
              {timeCurrent?.clock_entry_id ? (
                <>
                  <div className="time-kpi-clocked-popover-row">
                    <span>{de ? "Schicht-ID" : "Shift ID"}</span>
                    <b>#{timeCurrent.clock_entry_id}</b>
                  </div>
                  <div className="time-kpi-clocked-popover-row">
                    <span>{de ? "Eingestempelt" : "Clocked in"}</span>
                    <b>{formatServerDateTime(timeCurrent.clock_in || "", language)}</b>
                  </div>
                  <div className="time-kpi-clocked-popover-row">
                    <span>{de ? "Arbeitszeit" : "Worked"}</span>
                    <b>{timeCurrent.worked_hours_live}h</b>
                  </div>
                  <div className="time-kpi-clocked-popover-row">
                    <span>{de ? "Pause" : "Break"}</span>
                    <b>{timeCurrent.break_hours_live}h</b>
                  </div>
                  <div className="time-kpi-clocked-popover-row">
                    <span>{de ? "Gesetzliche Pause" : "Legal break"}</span>
                    <b>{timeCurrent.required_break_hours_live}h</b>
                  </div>
                  <div className="time-kpi-clocked-popover-row">
                    <span>{de ? "Nettozeit Schicht" : "Net shift hours"}</span>
                    <b>{timeCurrent.net_hours_live}h</b>
                  </div>
                </>
              ) : (
                <div className="time-kpi-clocked-popover-empty muted">
                  {de ? "Keine offene Schicht." : "No open shift."}
                </div>
              )}
              <div className="time-kpi-clocked-popover-foot">
                <a
                  href={exportUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="time-kpi-clocked-popover-export"
                >
                  {de ? `Export ${monthCursorLabel}` : `Export ${monthCursorLabel}`}
                </a>
                <small className="muted">
                  {de
                    ? "Gesetzl. Pause: > 6h = 30 Min, > 9h = 45 Min."
                    : "Legal break: > 6h = 30m, > 9h = 45m."}
                </small>
              </div>
            </div>
          </div>
          <div className="time-kpi-clocked-date">
            {de ? "Heute" : "Today"} · {todayDateLabel}
          </div>
          <div className="time-kpi-clocked-actions">
            {timeCurrent?.clock_entry_id ? (
              <button
                type="button"
                className="time-kpi-btn time-kpi-btn--primary"
                onClick={clockOut}
                disabled={!viewingOwnTime}
              >
                {de ? "Ausstempeln" : "Clock out"}
              </button>
            ) : (
              <button
                type="button"
                className="time-kpi-btn time-kpi-btn--primary"
                onClick={clockIn}
                disabled={!viewingOwnTime}
              >
                {de ? "Einstempeln" : "Clock in"}
              </button>
            )}
            {Boolean(timeCurrent?.clock_entry_id) &&
              (timeCurrent?.break_open ? (
                <button
                  type="button"
                  className="time-kpi-btn time-kpi-btn--ghost"
                  onClick={endBreak}
                  disabled={!viewingOwnTime}
                >
                  {de ? "Pause Ende" : "Break end"}
                </button>
              ) : (
                <button
                  type="button"
                  className="time-kpi-btn time-kpi-btn--ghost"
                  onClick={startBreak}
                  disabled={!viewingOwnTime}
                >
                  {de ? "Pause" : "Break"}
                </button>
              ))}
          </div>
        </div>

        <div className="time-kpi-card time-kpi-card--donut">
          <TimeKpiDonut worked={gaugeNetHours} required={requiredDailyHours} />
          <div className="time-kpi-info">
            <span className="time-kpi-info-label">{de ? "Heute" : "Today"}</span>
            <span className="time-kpi-info-value">
              {formatHours(gaugeNetHours)} / {formatHours(requiredDailyHours)}{" "}
              {de ? "benötigt" : "req."}
            </span>
            <span
              className={`time-kpi-info-foot${todayPercent >= 100 ? " time-kpi-info-foot--good" : todayPercent >= 50 ? " time-kpi-info-foot--ontrack" : ""}`}
            >
              {todayPercent >= 100
                ? de
                  ? "Ziel erreicht"
                  : "target hit"
                : todayPercent >= 50
                  ? de
                    ? "im Plan"
                    : "on track"
                  : de
                    ? "unter Plan"
                    : "behind"}
            </span>
          </div>
        </div>

        <div className="time-kpi-card time-kpi-card--donut">
          <TimeKpiDonut worked={weekWorkedHours} required={weekRequiredHours} />
          <div className="time-kpi-info">
            <span className="time-kpi-info-label">
              {de ? "Diese Woche" : "This week"}
              {weekLabel && ` (${weekLabel})`}
            </span>
            <span className="time-kpi-info-value">
              {formatHours(weekWorkedHours)} / {formatHours(weekRequiredHours)}{" "}
              {de ? "benötigt" : "req."}
            </span>
            <span className="time-kpi-info-foot">
              {weekPercent.toFixed(1)}%
            </span>
          </div>
        </div>

        <div className="time-kpi-card time-kpi-card--donut">
          <TimeKpiDonut worked={monthlyWorkedHours} required={monthlyRequiredHours} />
          <div className="time-kpi-info">
            <span className="time-kpi-info-label">{monthCursorLabel}</span>
            <span className="time-kpi-info-value">
              {formatHours(monthlyWorkedHours)} / {formatHours(monthlyRequiredHours)}{" "}
              {de ? "benötigt" : "req."}
            </span>
            <span className="time-kpi-info-foot">
              {monthPercent.toFixed(1)}% ·{" "}
              {de
                ? `${monthDayInfo.daysLeft} Tage übrig`
                : `${monthDayInfo.daysLeft} days left`}
            </span>
          </div>
        </div>
      </div>

      {!viewingOwnTime && (
        <small className="muted time-shift-viewer-note">
          {de
            ? "Sie sehen die Zeitdaten eines Mitarbeiters. Clock-In/Out ist deaktiviert."
            : "You are viewing another employee. Clock actions are disabled."}
        </small>
      )}

      {/* ── Row 2: Calendar + Recent Entries ──────────────────────── */}
      <div className="time-calendar-row">
        <div className="time-calendar-card">
          <div className="time-calendar-head">
            <button
              type="button"
              className="time-calendar-nav-btn"
              onClick={() => setTimeMonthCursor(shiftMonthStart(timeMonthCursor, -1))}
              aria-label={de ? "Vorheriger Monat" : "Previous month"}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="m15 6-6 6 6 6"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <h3 className="time-calendar-title">{monthCursorLabel}</h3>
            <button
              type="button"
              className="time-calendar-nav-btn"
              onClick={() => setTimeMonthCursor(shiftMonthStart(timeMonthCursor, 1))}
              aria-label={de ? "Nächster Monat" : "Next month"}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="m9 6 6 6-6 6"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <a
              href={exportUrl}
              target="_blank"
              rel="noreferrer"
              className="time-calendar-export-btn"
              aria-label={de ? `Export ${monthCursorLabel}` : `Export ${monthCursorLabel}`}
              title={de ? `Export ${monthCursorLabel}` : `Export ${monthCursorLabel}`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M12 4v12m0 0-4-4m4 4 4-4M5 18h14"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>{de ? "Export" : "Export"}</span>
            </a>
          </div>
          <div className="time-calendar-grid">
            <div className="time-calendar-weekday">Mo</div>
            <div className="time-calendar-weekday">Tu</div>
            <div className="time-calendar-weekday">We</div>
            <div className="time-calendar-weekday">Th</div>
            <div className="time-calendar-weekday">Fr</div>
            <div className="time-calendar-weekday">Sa</div>
            <div className="time-calendar-weekday">Su</div>
            {monthCalendar.map((cell, idx) => {
              if (cell.date === null) {
                return <div key={`cal-blank-${idx}`} className="time-calendar-cell time-calendar-cell--blank" />;
              }
              // Managers can click any day in the calendar to edit. Regular users can
              // only edit days that have at least one editable entry (handled via
              // recent-entries hours click below).
              const isClickable = isTimeManager;
              const hasAbsence = cell.absences.length > 0;
              const primaryAbsenceType = hasAbsence ? cell.absences[0].type : null;
              // Stable hover/aria summary: comma-joined absence labels.
              const absenceTitle = hasAbsence
                ? cell.absences.map((m) => m.label).join(", ")
                : "";
              const classes = [
                "time-calendar-cell",
                cell.hours > 0 ? "time-calendar-cell--has-hours" : "time-calendar-cell--empty",
                cell.isToday ? "time-calendar-cell--today" : "",
                cell.isPast ? "time-calendar-cell--past" : "",
                isClickable ? "time-calendar-cell--clickable" : "",
                hasAbsence ? "time-calendar-cell--has-absence" : "",
                primaryAbsenceType
                  ? `time-calendar-cell--absence-${primaryAbsenceType}`
                  : "",
              ]
                .filter((v) => v)
                .join(" ");
              const cellInner = (
                <>
                  <span className="time-calendar-cell-date">{cell.date}</span>
                  {hasAbsence && (
                    <span
                      className="time-calendar-cell-absence"
                      title={absenceTitle}
                      aria-label={absenceTitle}
                    >
                      {cell.absences[0].label}
                      {cell.absences.length > 1 ? ` +${cell.absences.length - 1}` : ""}
                    </span>
                  )}
                  {cell.hours > 0 && (
                    <span className="time-calendar-cell-hours">{formatHours(cell.hours)}</span>
                  )}
                </>
              );
              if (isClickable) {
                return (
                  <button
                    key={`cal-${cell.iso}`}
                    type="button"
                    className={classes}
                    onClick={() => setEditEntriesDate(cell.iso)}
                    aria-label={`${de ? "Bearbeiten" : "Edit"} ${cell.iso}${
                      absenceTitle ? ` (${absenceTitle})` : ""
                    }`}
                  >
                    {cellInner}
                  </button>
                );
              }
              return (
                <div key={`cal-${cell.iso}`} className={classes} title={absenceTitle || undefined}>
                  {cellInner}
                </div>
              );
            })}
          </div>
          {monthHolidays.length > 0 && (
            <div className="time-calendar-holidays">
              <small className="muted">{de ? "Feiertage (NRW)" : "Public holidays (NRW)"}</small>
              <div className="time-calendar-holidays-list">
                {monthHolidays.map((h) => (
                  <div key={h.date} className="time-calendar-holiday-row">
                    <span className="time-calendar-holiday-date">
                      {new Date(h.date + "T00:00:00").toLocaleDateString(de ? "de-DE" : "en-GB", {
                        day: "2-digit",
                        month: "2-digit",
                      })}
                    </span>
                    <span className="time-calendar-holiday-name">{h.name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="time-recent-card">
          <div className="time-recent-head">
            <h3 className="time-recent-title">{de ? "Letzte Einträge" : "Recent Entries"}</h3>
          </div>
          <div className="time-recent-list">
            {recentEntriesGrouped.length === 0 && (
              <div className="time-recent-empty muted">
                {de ? "Keine Einträge im Zeitraum." : "No entries in this range."}
              </div>
            )}
            {recentEntriesGrouped.map(([iso, entries]) => {
              const dayEditable = entries.some((entry) => entry.can_edit);
              return (
                <div key={`recent-${iso}`} className="time-recent-group">
                  <div className="time-recent-group-label">{recentGroupLabel(iso)}</div>
                  {entries.map((entry) => {
                    const start = formatTimeHHMM(entry.clock_in);
                    const end = entry.is_open
                      ? de
                        ? "läuft"
                        : "running"
                      : formatTimeHHMM(entry.clock_out);
                    const timeRange = `${start} – ${end}`;
                    const breakLabel =
                      entry.break_hours > 0
                        ? `${de ? "Pause" : "Break"}: ${Math.round(entry.break_hours * 60)} min`
                        : de
                          ? "Keine Pause aufgezeichnet"
                          : "No break recorded";
                    const entryUserLabel =
                      menuUserNameById(entry.user_id, entry.user_name || "") ||
                      entry.user_name ||
                      (de ? `Benutzer #${entry.user_id}` : `User #${entry.user_id}`);
                    return (
                      <div key={`recent-entry-${entry.id}`} className="time-recent-entry">
                        <div className="time-recent-entry-body">
                          <span className="time-recent-entry-range">
                            {timeRange}
                            {entry.is_open && (
                              <span className="time-recent-entry-running"> ({de ? "läuft" : "running"})</span>
                            )}
                          </span>
                          <span
                            className="time-recent-entry-user muted"
                            style={{ fontSize: 11, marginTop: 2 }}
                          >
                            {entryUserLabel}
                          </span>
                          <span className="time-recent-entry-break">{breakLabel}</span>
                        </div>
                        {entry.can_edit ? (
                          <button
                            type="button"
                            className={`time-recent-entry-hours time-recent-entry-hours--clickable${entry.is_open ? " time-recent-entry-hours--live" : ""}`}
                            onClick={() => setEditEntriesDate(iso)}
                            aria-label={de ? "Bearbeiten" : "Edit"}
                            title={de ? "Bearbeiten" : "Edit"}
                          >
                            {formatHours(entry.net_hours)}
                          </button>
                        ) : (
                          <span
                            className={`time-recent-entry-hours${entry.is_open ? " time-recent-entry-hours--live" : ""}`}
                          >
                            {formatHours(entry.net_hours)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {!dayEditable && entries.length > 0 && (
                    <div className="time-recent-locked-hint muted">
                      {de ? "Nur zur Ansicht" : "View only"}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Row 3: Vacation requests card ──────────────────────── */}
      <div className="time-vacation-card">
        <h2 className="time-vacation-title">{de ? "Urlaubsanträge" : "Vacation requests"}</h2>

        <div className="time-vacation-stats">
          <div className="time-vacation-stat">
            <span className="time-vacation-stat-label">{de ? "Tage/Jahr" : "Days / year"}</span>
            <span className="time-vacation-stat-value">{timeCurrent?.vacation_days_per_year ?? 0}</span>
          </div>
          <div className="time-vacation-stat">
            <span className="time-vacation-stat-label">{de ? "Aktuell offen" : "Currently left"}</span>
            <span className="time-vacation-stat-value">{timeCurrent?.vacation_days_available ?? 0}</span>
          </div>
          <div className="time-vacation-stat">
            <span className="time-vacation-stat-label">{de ? "Übertrag" : "Carryover"}</span>
            <span className="time-vacation-stat-value">{timeCurrent?.vacation_days_carryover ?? 0}</span>
          </div>
          <div className="time-vacation-stat">
            <span className="time-vacation-stat-label">{de ? "Gesamt offen" : "Total left"}</span>
            <span className="time-vacation-stat-value time-vacation-stat-value--accent">
              {timeCurrent?.vacation_days_total_remaining ?? 0}
            </span>
          </div>
        </div>

        <form className="time-vacation-form" onSubmit={submitVacationRequest}>
          <div className="time-vacation-form-grid">
            <label className="time-vacation-field">
              <span className="time-vacation-field-label">{de ? "Von" : "From"}</span>
              <input
                type="date"
                className="time-vacation-input"
                value={vacationRequestForm.start_date}
                onChange={(event) =>
                  setVacationRequestForm({ ...vacationRequestForm, start_date: event.target.value })
                }
                required
              />
            </label>
            <label className="time-vacation-field">
              <span className="time-vacation-field-label">{de ? "Bis" : "Until"}</span>
              <input
                type="date"
                className="time-vacation-input"
                value={vacationRequestForm.end_date}
                onChange={(event) =>
                  setVacationRequestForm({ ...vacationRequestForm, end_date: event.target.value })
                }
                required
              />
            </label>
          </div>
          <label className="time-vacation-field">
            <span className="time-vacation-field-label">{de ? "Notiz (optional)" : "Note (optional)"}</span>
            <textarea
              className="time-vacation-input time-vacation-textarea"
              value={vacationRequestForm.note}
              onChange={(event) =>
                setVacationRequestForm({ ...vacationRequestForm, note: event.target.value })
              }
              rows={2}
              placeholder={de ? "z. B. Sommerurlaub" : "e.g. Summer holiday"}
            />
          </label>
          <div>
            <button type="submit" className="time-vacation-submit-btn">
              {de ? "Antrag senden" : "Submit request"}
            </button>
          </div>
        </form>

        {approvedVacationRequests.length > 0 && (
          <div className="time-vacation-section">
            <span className="time-vacation-section-label">
              {de ? "Genehmigter Urlaub" : "Approved vacation"}
            </span>
            <div className="time-vacation-approved-list">
              {approvedVacationRequests.map((row) => (
                <div key={`vacation-approved-${row.id}`} className="time-vacation-approved-row">
                  <span className="time-vacation-approved-name">
                    {menuUserNameById(row.user_id, row.user_name)}
                    {" — "}
                    {row.start_date} – {row.end_date}
                  </span>
                  <span className="time-vacation-approved-days">
                    {row.vacation_days_used} {de ? "Tage" : "days"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {canApproveVacation && pendingVacationRequests.length > 0 && (
          <div className="time-vacation-section">
            <span className="time-vacation-section-label">
              {de ? "Offene Urlaubsanträge" : "Pending vacation requests"}
            </span>
            <div className="time-vacation-pending-list">
              {pendingVacationRequests.map((row) => (
                <div key={`vacation-pending-${row.id}`} className="time-vacation-pending-row">
                  <div className="time-vacation-pending-main">
                    <b>{menuUserNameById(row.user_id, row.user_name)}</b>
                    <small>
                      {row.start_date} – {row.end_date} · {row.vacation_days_used}{" "}
                      {de ? "Tage" : "days"}
                    </small>
                    {row.note && <small className="muted">{row.note}</small>}
                  </div>
                  <div className="time-vacation-pending-actions">
                    <button
                      type="button"
                      className="time-absence-action-btn time-absence-action-btn--approve"
                      onClick={() => void reviewVacationRequest(row.id, "approved")}
                    >
                      {de ? "Genehmigen" : "Approve"}
                    </button>
                    <button
                      type="button"
                      className="time-absence-action-btn time-absence-action-btn--reject"
                      onClick={() => void reviewVacationRequest(row.id, "rejected")}
                    >
                      {de ? "Ablehnen" : "Reject"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Absences subsection nested inside vacation card ────── */}
        <div className="time-absences-nested">
          <h3 className="time-absences-title">{de ? "Abwesenheiten" : "Absences"}</h3>
          <form className="time-vacation-form" onSubmit={submitSchoolAbsence}>
            {canManageSchoolAbsences && (
              <label className="time-vacation-field">
                <span className="time-vacation-field-label">{de ? "Mitarbeiter" : "Employee"}</span>
                <select
                  className="time-vacation-input"
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
            )}
            {!canManageSchoolAbsences && (
              <small className="muted">
                {de
                  ? "Neue Abwesenheiten werden als Antrag zur Freigabe gesendet."
                  : "New absences are sent as requests for approval."}
              </small>
            )}
            <div className="time-vacation-form-grid">
              <label className="time-vacation-field">
                <span className="time-vacation-field-label">{de ? "Typ" : "Type"}</span>
                <select
                  className="time-vacation-input"
                  value={schoolAbsenceForm.absence_type}
                  onChange={(event) => {
                    const selectedType = absenceTypes.find((t) => t.key === event.target.value);
                    const defaultTitle = selectedType
                      ? de
                        ? selectedType.label_de
                        : selectedType.label_en
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
                      {t.counts_as_hours ? "" : de ? " (keine Stundenanrechnung)" : " (no hours credit)"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="time-vacation-field">
                <span className="time-vacation-field-label">{de ? "Bezeichnung" : "Title"}</span>
                <input
                  className="time-vacation-input"
                  value={schoolAbsenceForm.title}
                  onChange={(event) =>
                    setSchoolAbsenceForm({ ...schoolAbsenceForm, title: event.target.value })
                  }
                  placeholder={de ? "z. B. Berufsschule" : "e.g. School"}
                  required
                />
              </label>
            </div>
            <div className="time-vacation-form-grid">
              <label className="time-vacation-field">
                <span className="time-vacation-field-label">{de ? "Start" : "Start"}</span>
                <input
                  type="date"
                  className="time-vacation-input"
                  value={schoolAbsenceForm.start_date}
                  onChange={(event) =>
                    setSchoolAbsenceForm({ ...schoolAbsenceForm, start_date: event.target.value })
                  }
                  required
                />
              </label>
              <label className="time-vacation-field">
                <span className="time-vacation-field-label">{de ? "Ende" : "End"}</span>
                <input
                  type="date"
                  className="time-vacation-input"
                  value={schoolAbsenceForm.end_date}
                  onChange={(event) =>
                    setSchoolAbsenceForm({ ...schoolAbsenceForm, end_date: event.target.value })
                  }
                  required
                />
              </label>
            </div>
            <div className="time-absence-recurring">
              <span className="time-vacation-field-label">
                {de ? "Wiederholung (Mo-Fr)" : "Recurring days (Mon-Fri)"}
              </span>
              <div className="time-absence-recurring-chips">
                {[0, 1, 2, 3, 4].map((day) => {
                  const active = schoolAbsenceForm.recurrence_weekdays.includes(day);
                  return (
                    <button
                      key={`school-day-${day}`}
                      type="button"
                      className={`time-absence-chip${active ? " time-absence-chip--active" : ""}`}
                      onClick={() => toggleSchoolRecurrenceWeekday(day, !active)}
                      aria-pressed={active}
                    >
                      {schoolWeekdayLabel(day, language)}
                    </button>
                  );
                })}
              </div>
            </div>
            {schoolAbsenceForm.recurrence_weekdays.length > 0 && (
              <label className="time-vacation-field">
                <span className="time-vacation-field-label">
                  {de ? "Intervall bis (optional)" : "Recurring until (optional)"}
                </span>
                <input
                  type="date"
                  className="time-vacation-input"
                  value={schoolAbsenceForm.recurrence_until}
                  onChange={(event) =>
                    setSchoolAbsenceForm({ ...schoolAbsenceForm, recurrence_until: event.target.value })
                  }
                />
              </label>
            )}
            <div className="time-absence-form-actions">
              <button type="submit" className="time-vacation-submit-btn">
                {editingSchoolAbsenceId !== null
                  ? de
                    ? "Abwesenheit aktualisieren"
                    : "Update absence"
                  : canManageSchoolAbsences
                    ? de
                      ? "Abwesenheit speichern"
                      : "Save absence"
                    : de
                      ? "Antrag senden"
                      : "Submit request"}
              </button>
              {editingSchoolAbsenceId !== null && (
                <button
                  type="button"
                  className="time-absence-cancel-btn"
                  onClick={cancelSchoolAbsenceEdit}
                >
                  {de ? "Bearbeitung abbrechen" : "Cancel edit"}
                </button>
              )}
            </div>
          </form>

          {activeApprovedAbsences.length > 0 && (
            <div className="time-vacation-section">
              <span className="time-vacation-section-label">
                {de ? "Aktuelle und kommende Abwesenheiten" : "Current & upcoming"}
              </span>
              <div className="time-absence-active-list">
                {activeApprovedAbsences.map((row) => (
                  <div key={`absence-active-${row.id}`} className="time-absence-active-row">
                    <div className="time-absence-active-main">
                      <b>{menuUserNameById(row.user_id, row.user_name)}</b>
                      <div>
                        <span
                          className={`time-absence-type-badge ${row.counts_as_hours ? "" : "time-absence-type-badge--muted"}`}
                        >
                          {absenceTypeLabel(row.absence_type)}
                        </span>
                        <span className="time-absence-active-meta">
                          {row.title} · {row.start_date} – {row.end_date}
                          {row.recurrence_weekday !== null && row.recurrence_weekday !== undefined
                            ? ` · ${de ? "wöchentlich" : "every"} ${schoolWeekdayLabel(row.recurrence_weekday, language)}${row.recurrence_until ? ` ${de ? "bis" : "until"} ${row.recurrence_until}` : ""}`
                            : ""}
                        </span>
                      </div>
                    </div>
                    {canManageSchoolAbsences && (
                      <div className="time-absence-row-actions">
                        <button
                          type="button"
                          className="time-absence-action-btn"
                          onClick={() => startSchoolAbsenceEdit(row)}
                        >
                          {de ? "Bearbeiten" : "Edit"}
                        </button>
                        <button
                          type="button"
                          className="time-absence-action-btn time-absence-action-btn--reject"
                          onClick={() => void removeSchoolAbsence(row.id)}
                        >
                          {de ? "Löschen" : "Delete"}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {pendingAbsenceRequests.length > 0 && (
            <div className="time-vacation-section">
              <span className="time-vacation-section-label">
                {de ? "Offene Abwesenheitsanträge" : "Pending requests"}
              </span>
              <div className="time-absence-pending-list">
                {pendingAbsenceRequests.map((row) => (
                  <div key={`absence-pending-${row.id}`} className="time-absence-pending-row">
                    <div className="time-absence-pending-main">
                      <b>{menuUserNameById(row.user_id, row.user_name)}</b>
                      <div>
                        <span
                          className={`time-absence-type-badge ${row.counts_as_hours ? "" : "time-absence-type-badge--muted"}`}
                        >
                          {absenceTypeLabel(row.absence_type)}
                        </span>
                        <span className="time-absence-active-meta">
                          {row.title} · {row.start_date} – {row.end_date}
                        </span>
                      </div>
                    </div>
                    <div className="time-absence-row-actions">
                      {canManageSchoolAbsences && (
                        <>
                          <button
                            type="button"
                            className="time-absence-action-btn time-absence-action-btn--approve"
                            onClick={() => void reviewSchoolAbsence(row.id, "approved")}
                          >
                            {de ? "Genehmigen" : "Approve"}
                          </button>
                          <button
                            type="button"
                            className="time-absence-action-btn time-absence-action-btn--reject"
                            onClick={() => void reviewSchoolAbsence(row.id, "rejected")}
                          >
                            {de ? "Ablehnen" : "Reject"}
                          </button>
                        </>
                      )}
                      {(canManageSchoolAbsences || row.user_id === user?.id) && (
                        <button
                          type="button"
                          className="time-absence-action-btn time-absence-action-btn--reject"
                          onClick={() => void removeSchoolAbsence(row.id)}
                        >
                          {de ? "Löschen" : "Delete"}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {pastAbsenceRows.length > 0 && (
            <div className="time-vacation-section">
              <span className="time-vacation-section-label">{de ? "Letzte Einträge" : "Recent history"}</span>
              <div className="time-absence-active-list">
                {pastAbsenceRows.map((row) => (
                  <div key={`absence-history-${row.id}`} className="time-absence-active-row">
                    <div className="time-absence-active-main">
                      <b>{menuUserNameById(row.user_id, row.user_name)}</b>
                      <div>
                        <span
                          className={`time-absence-type-badge ${row.counts_as_hours ? "" : "time-absence-type-badge--muted"}`}
                        >
                          {absenceTypeLabel(row.absence_type)}
                        </span>
                        <span className="time-absence-active-meta">
                          {row.title} · {row.start_date} – {row.end_date} · {absenceStatusLabel(row.status)}
                        </span>
                      </div>
                    </div>
                    {canManageSchoolAbsences && (
                      <div className="time-absence-row-actions">
                        <button
                          type="button"
                          className="time-absence-action-btn"
                          onClick={() => startSchoolAbsenceEdit(row)}
                        >
                          {de ? "Bearbeiten" : "Edit"}
                        </button>
                        <button
                          type="button"
                          className="time-absence-action-btn time-absence-action-btn--reject"
                          onClick={() => void removeSchoolAbsence(row.id)}
                        >
                          {de ? "Löschen" : "Delete"}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {editEntriesDate &&
        (() => {
          const dayEntries = entriesForDate(editEntriesDate);
          return (
            <div
              className="modal-backdrop"
              onClick={() => setEditEntriesDate(null)}
              role="dialog"
              aria-modal="true"
            >
              <div
                className="modal-card edit-day-modal"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="edit-day-modal-head">
                  <div className="edit-day-modal-title-block">
                    <span className="edit-day-modal-eyebrow">
                      {de ? "ZEITEINTRAG BEARBEITEN" : "EDIT TIME ENTRY"}
                    </span>
                    <h2 className="edit-day-modal-title">{formatDayHeading(editEntriesDate)}</h2>
                  </div>
                  <button
                    type="button"
                    className="edit-day-modal-close"
                    onClick={() => setEditEntriesDate(null)}
                    aria-label={de ? "Schließen" : "Close"}
                  >
                    ×
                  </button>
                </div>
                <div className="edit-day-modal-body">
                  {dayEntries.length === 0 && (
                    <p className="muted edit-day-modal-empty">
                      {de
                        ? "Keine Zeiteinträge für diesen Tag gefunden."
                        : "No time entries for this day."}
                    </p>
                  )}
                  {dayEntries.map((entry, index) => (
                    <form
                      key={entry.id}
                      className="edit-day-entry-form"
                      onSubmit={(event) => {
                        void updateTimeEntry(event, entry.id);
                      }}
                    >
                      <div className="edit-day-entry-head">
                        <span className="edit-day-entry-title">
                          {de ? "Schicht" : "Shift"} #{index + 1}
                        </span>
                        <span className="edit-day-entry-id">ID #{entry.id}</span>
                        <span className="edit-day-entry-net">{formatHours(entry.net_hours)}</span>
                      </div>
                      <div className="edit-day-entry-grid">
                        <label className="edit-day-entry-field">
                          <span className="edit-day-entry-field-label">
                            {de ? "Eingestempelt" : "Clock in"}
                          </span>
                          <input
                            type="datetime-local"
                            name="clock_in"
                            className="edit-day-entry-input"
                            required
                            defaultValue={isoToLocalDateTimeInput(entry.clock_in)}
                            disabled={!entry.can_edit}
                          />
                        </label>
                        <label className="edit-day-entry-field">
                          <span className="edit-day-entry-field-label">
                            {de ? "Ausgestempelt" : "Clock out"}
                          </span>
                          <input
                            type="datetime-local"
                            name="clock_out"
                            className="edit-day-entry-input"
                            defaultValue={isoToLocalDateTimeInput(entry.clock_out)}
                            disabled={!entry.can_edit}
                          />
                        </label>
                        <label className="edit-day-entry-field">
                          <span className="edit-day-entry-field-label">
                            {de ? "Pause (Min)" : "Break (min)"}
                          </span>
                          <input
                            type="number"
                            name="break_minutes"
                            className="edit-day-entry-input"
                            min={0}
                            defaultValue={Math.round(entry.break_hours * 60)}
                            disabled={!entry.can_edit}
                          />
                        </label>
                      </div>
                      <div className="edit-day-entry-foot">
                        <small className="muted">
                          {de ? "Pause" : "Break"}: {entry.break_hours}h ·{" "}
                          {de ? "Gesetzlich" : "Legal"}: {entry.required_break_hours}h ·{" "}
                          {de ? "Abgezogen" : "Deducted"}: {entry.deducted_break_hours}h
                        </small>
                        {!entry.can_edit && (
                          <small className="muted">
                            {de ? "Nicht bearbeitbar" : "Not editable"}
                          </small>
                        )}
                        <button
                          type="submit"
                          className="edit-day-entry-save-btn"
                          disabled={!entry.can_edit}
                        >
                          {de ? "Speichern" : "Save"}
                        </button>
                      </div>
                    </form>
                  ))}
                </div>
                <div className="edit-day-modal-foot">
                  <a
                    className="edit-day-modal-export"
                    href={exportUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {de ? `Monatsexport (${monthCursorLabel})` : `Export month (${monthCursorLabel})`}
                  </a>
                  <button
                    type="button"
                    className="edit-day-modal-close-btn"
                    onClick={() => setEditEntriesDate(null)}
                  >
                    {de ? "Fertig" : "Done"}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
    </section>
  );
}
