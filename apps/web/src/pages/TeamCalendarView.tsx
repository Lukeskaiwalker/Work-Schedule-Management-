import { useMemo, useRef, useEffect } from "react";
import { getUserColor } from "../constants/teamCalendarColors";
import { taskStartTimeMinutes, taskEndTimeMinutes, formatTaskTimeRange } from "../utils/tasks";
import type { Language, Task, PlanningDay, AssignableUser } from "../types";

const HOUR_START = 7;
const HOUR_END = 18;
const HOUR_COUNT = HOUR_END - HOUR_START + 1; // 12 slots (07:00–18:00)
const SLOT_HEIGHT = 60; // px per hour

const HOURS = Array.from({ length: HOUR_COUNT }, (_, i) => HOUR_START + i);

type Props = {
  day: PlanningDay | null;
  selectedUserIds: ReadonlySet<number>;
  onToggleUser: (userId: number) => void;
  assignableUsers: readonly AssignableUser[];
  userPickerOpen: boolean;
  onSetUserPickerOpen: (open: boolean) => void;
  language: Language;
  loading: boolean;
  openTaskFromPlanning: (task: Task) => void;
  menuUserNameById: (userId: number, fallback?: string) => string;
  absenceTypeLabel: (type: string) => string;
  taskProjectTitle: (task: Task) => string;
};

export function TeamCalendarView({
  day,
  selectedUserIds,
  onToggleUser,
  assignableUsers,
  userPickerOpen,
  onSetUserPickerOpen,
  language,
  loading,
  openTaskFromPlanning,
  menuUserNameById,
  absenceTypeLabel,
  taskProjectTitle,
}: Props) {
  const de = language === "de";
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!userPickerOpen) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        onSetUserPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [userPickerOpen, onSetUserPickerOpen]);

  // Sorted selected user IDs for stable color assignment
  const sortedSelectedIds = useMemo(
    () => Array.from(selectedUserIds).sort((a, b) => a - b),
    [selectedUserIds],
  );

  // Map userId → color index
  const userColorIndex = useMemo(() => {
    const map = new Map<number, number>();
    sortedSelectedIds.forEach((id, i) => map.set(id, i));
    return map;
  }, [sortedSelectedIds]);

  // Tasks grouped by user
  const tasksByUser = useMemo(() => {
    const map = new Map<number, Task[]>();
    if (!day) return map;
    for (const userId of sortedSelectedIds) {
      const userTasks = day.tasks.filter(
        (t) => t.assignee_ids?.includes(userId) || t.assignee_id === userId,
      );
      map.set(userId, userTasks);
    }
    return map;
  }, [day, sortedSelectedIds]);

  // Absences by user
  const absencesByUser = useMemo(() => {
    const map = new Map<number, string[]>();
    if (!day?.absences) return map;
    for (const absence of day.absences) {
      if (selectedUserIds.has(absence.user_id)) {
        const list = map.get(absence.user_id) ?? [];
        list.push(absenceTypeLabel(absence.type));
        map.set(absence.user_id, list);
      }
    }
    return map;
  }, [day, selectedUserIds, absenceTypeLabel]);

  // Users not yet selected (for the dropdown)
  const unselectedUsers = useMemo(
    () => assignableUsers.filter((u) => !selectedUserIds.has(u.id)),
    [assignableUsers, selectedUserIds],
  );

  return (
    <div className="team-calendar">
      {/* ── User picker ──────────────────────────────────────────── */}
      <div className="team-calendar-picker" ref={dropdownRef}>
        <div className="team-calendar-chips">
          {sortedSelectedIds.map((userId, index) => {
            const color = getUserColor(index);
            const name = menuUserNameById(userId, `#${userId}`);
            return (
              <button
                key={userId}
                type="button"
                className="team-calendar-chip"
                style={{
                  backgroundColor: color.bg,
                  borderColor: color.border,
                  color: color.text,
                }}
                onClick={() => onToggleUser(userId)}
                title={de ? `${name} entfernen` : `Remove ${name}`}
              >
                <span className="team-calendar-chip-dot" style={{ backgroundColor: color.border }} />
                <span>{name}</span>
                <span className="team-calendar-chip-x" aria-hidden="true">×</span>
              </button>
            );
          })}
          <button
            type="button"
            className="team-calendar-add-btn"
            onClick={() => onSetUserPickerOpen(!userPickerOpen)}
            disabled={unselectedUsers.length === 0}
          >
            + {de ? "Person" : "Person"}
          </button>
        </div>
        {userPickerOpen && unselectedUsers.length > 0 && (
          <div className="team-calendar-dropdown">
            {unselectedUsers.map((u) => (
              <button
                key={u.id}
                type="button"
                className="team-calendar-dropdown-item"
                onClick={() => {
                  onToggleUser(u.id);
                  onSetUserPickerOpen(false);
                }}
              >
                {u.display_name || u.full_name}
                <small className="team-calendar-dropdown-role">{u.role}</small>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Loading / empty states ───────────────────────────────── */}
      {loading && (
        <div className="team-calendar-empty">
          {de ? "Lade…" : "Loading…"}
        </div>
      )}

      {!loading && sortedSelectedIds.length === 0 && (
        <div className="team-calendar-empty">
          {de
            ? "Personen hinzufügen, um deren Termine zu sehen."
            : "Add people to see their schedules."}
        </div>
      )}

      {/* ── Timeline grid ────────────────────────────────────────── */}
      {!loading && sortedSelectedIds.length > 0 && (
        <div
          className="team-calendar-grid-wrap"
          style={{ "--team-cols": sortedSelectedIds.length } as React.CSSProperties}
        >
          {/* Absence bars */}
          {Array.from(absencesByUser).length > 0 && (
            <div className="team-calendar-absences">
              {sortedSelectedIds.map((userId, index) => {
                const absences = absencesByUser.get(userId);
                if (!absences || absences.length === 0) return null;
                const color = getUserColor(index);
                return (
                  <div
                    key={`absence-${userId}`}
                    className="team-calendar-absence-bar"
                    style={{ backgroundColor: color.bg, borderColor: color.border }}
                  >
                    <span className="team-calendar-absence-dot" style={{ backgroundColor: color.border }} />
                    <span>{menuUserNameById(userId)}: {absences.join(", ")}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Column headers */}
          <div className="team-calendar-header-row">
            <div className="team-calendar-time-header" />
            {sortedSelectedIds.map((userId, index) => {
              const color = getUserColor(index);
              const name = menuUserNameById(userId, `#${userId}`);
              return (
                <div
                  key={userId}
                  className="team-calendar-user-header"
                  style={{ borderBottomColor: color.border }}
                >
                  <span className="team-calendar-user-dot" style={{ backgroundColor: color.border }} />
                  <span className="team-calendar-user-name">{name}</span>
                </div>
              );
            })}
          </div>

          {/* Grid body */}
          <div className="team-calendar-grid">
            {/* Time column */}
            <div className="team-calendar-time-col">
              {HOURS.map((hour) => (
                <div key={hour} className="team-calendar-time-slot">
                  {String(hour).padStart(2, "0")}:00
                </div>
              ))}
            </div>

            {/* User columns */}
            {sortedSelectedIds.map((userId, colIndex) => {
              const color = getUserColor(colIndex);
              const tasks = tasksByUser.get(userId) ?? [];
              const scheduled = tasks.filter((t) => taskStartTimeMinutes(t) != null);
              const unscheduled = tasks.filter((t) => taskStartTimeMinutes(t) == null);

              return (
                <div key={userId} className="team-calendar-user-col">
                  {/* Hour grid lines */}
                  {HOURS.map((hour) => (
                    <div
                      key={hour}
                      className="team-calendar-hour-line"
                      style={{ top: (hour - HOUR_START) * SLOT_HEIGHT }}
                    />
                  ))}

                  {/* Task blocks */}
                  {scheduled.map((task) => {
                    const startMin = taskStartTimeMinutes(task)!;
                    const endMin = taskEndTimeMinutes(task) ?? startMin + 60;
                    const gridStartMin = HOUR_START * 60;
                    const gridEndMin = (HOUR_END + 1) * 60;
                    const clampedStart = Math.max(startMin, gridStartMin);
                    const clampedEnd = Math.min(endMin, gridEndMin);
                    const top = ((clampedStart - gridStartMin) / 60) * SLOT_HEIGHT;
                    const height = Math.max(
                      SLOT_HEIGHT / 4,
                      ((clampedEnd - clampedStart) / 60) * SLOT_HEIGHT,
                    );
                    const timeLabel = formatTaskTimeRange(task);
                    const projectLabel = taskProjectTitle(task);

                    return (
                      <button
                        key={task.id}
                        type="button"
                        className="team-calendar-task-block"
                        style={{
                          top,
                          height,
                          backgroundColor: color.bg,
                          borderLeftColor: color.border,
                          color: color.text,
                        }}
                        onClick={() => openTaskFromPlanning(task)}
                        title={`${task.title}${timeLabel ? ` · ${timeLabel}` : ""}${projectLabel ? ` · ${projectLabel}` : ""}`}
                      >
                        <span className="team-calendar-task-title">{task.title}</span>
                        {timeLabel && (
                          <span className="team-calendar-task-time">{timeLabel}</span>
                        )}
                      </button>
                    );
                  })}

                  {/* Unscheduled tasks (at the bottom) */}
                  {unscheduled.length > 0 && (
                    <div
                      className="team-calendar-unscheduled"
                      style={{ top: HOUR_COUNT * SLOT_HEIGHT }}
                    >
                      {unscheduled.map((task) => (
                        <button
                          key={task.id}
                          type="button"
                          className="team-calendar-unsched-item"
                          style={{ backgroundColor: color.bg, borderColor: color.border, color: color.text }}
                          onClick={() => openTaskFromPlanning(task)}
                          title={task.title}
                        >
                          {task.title}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
