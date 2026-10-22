/**
 * „Mein Einsatz“ on the start page: what the signed-in user is scheduled for
 * today and this week (docs/DASHBOARD.md D21, §1 notes; owner answer Q2).
 *
 * Built from the tasks the app already holds on the overview (view `my_all`)
 * instead of `/planning/week`: that call returns the whole company's week for
 * `tasks:view_all` users, and it is the heaviest request on the page. So the
 * filter has to be explicit — an admin's context can hold other people's
 * tasks, and `my_all` carries recently finished ones.
 *
 * Pure, and dates are ISO strings computed in UTC, so neither the device's
 * timezone nor a daylight-saving change can shift a day.
 */
import type { Task } from "../types";
import { isTaskDoneStatus, taskEndDate, taskSpansDay, taskStartTimeMinutes } from "./tasks";

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Days of a schedule, each with the tasks it holds. Only days that hold any. */
export type ScheduleDay = { day: string; tasks: Task[] };

function utcMidnight(day: string): number | null {
  const match = ISO_DAY.exec(day);
  if (!match) return null;
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(time) ? null : time;
}

function isoOf(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function addDays(day: string, days: number): string {
  const time = utcMidnight(day);
  return time === null ? day : isoOf(time + days * DAY_MS);
}

/** The Monday of the week holding `day` (ISO). Hands back what it cannot read. */
export function mondayOf(day: string): string {
  const time = utcMidnight(day);
  if (time === null) return day;
  const weekday = (new Date(time).getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
  return isoOf(time - weekday * DAY_MS);
}

/** Assigned through the assignee list, or the single assignee older rows carry. */
function isAssignedTo(task: Task, userId: number): boolean {
  return (task.assignee_ids ?? []).includes(userId) || task.assignee_id === userId;
}

function isOwnOpenWork(task: Task, userId: number): boolean {
  return isAssignedTo(task, userId) && !isTaskDoneStatus(task.status);
}

/** Within a day: by start time, untimed work last, then by title. */
function byStartTime(left: Task, right: Task): number {
  const leftStart = taskStartTimeMinutes(left);
  const rightStart = taskStartTimeMinutes(right);
  if (leftStart !== rightStart) {
    if (leftStart === null) return 1;
    if (rightStart === null) return -1;
    return leftStart - rightStart;
  }
  return left.title.localeCompare(right.title, undefined, { sensitivity: "base" }) || left.id - right.id;
}

function byFirstDayThenStart(left: Task, right: Task): number {
  const leftDay = String(left.due_date ?? "");
  const rightDay = String(right.due_date ?? "");
  return leftDay === rightDay ? byStartTime(left, right) : leftDay.localeCompare(rightDay);
}

/** The user's open tasks on `day`; a multi-day task counts on every day it covers. */
export function myTasksForDay(tasks: readonly Task[], day: string, userId: number): Task[] {
  return tasks.filter((task) => isOwnOpenWork(task, userId) && taskSpansDay(task, day)).sort(byStartTime);
}

/**
 * The user's open tasks overlapping Monday–Sunday of the week holding
 * `monday`, each once, by first day. Any day of the week may be passed.
 */
export function myTasksForWeek(tasks: readonly Task[], monday: string, userId: number): Task[] {
  const first = mondayOf(monday);
  const last = addDays(first, 6);
  return tasks
    .filter((task) => {
      if (!isOwnOpenWork(task, userId)) return false;
      const start = String(task.due_date ?? "").trim();
      return Boolean(start) && start <= last && taskEndDate(task) >= first;
    })
    .sort(byFirstDayThenStart);
}

/** The week of `monday` as days with work, Monday first: what „Woche“ lists. */
export function myWeekByDay(tasks: readonly Task[], monday: string, userId: number): ScheduleDay[] {
  const first = mondayOf(monday);
  const week = myTasksForWeek(tasks, first, userId);
  return Array.from({ length: 7 }, (_, offset) => addDays(first, offset))
    .map((day) => ({ day, tasks: myTasksForDay(week, day, userId) }))
    .filter((entry) => entry.tasks.length > 0);
}
