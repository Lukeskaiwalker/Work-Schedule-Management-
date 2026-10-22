/**
 * „Mein Einsatz“ is built from the signed-in user's own tasks (docs/
 * DASHBOARD.md D21), so these pure helpers decide what a worker reads as
 * "where am I today and this week".
 *
 * What has to hold: only tasks assigned to that user (an admin's context
 * holds other people's tasks too), never done ones, a multi-day task on
 * every day it covers, and a week that runs Monday to Sunday whatever day
 * it is asked from — across month, year and daylight-saving boundaries.
 */
import { describe, expect, it } from "vitest";

import type { Task } from "../types";
import { mondayOf, myTasksForDay, myTasksForWeek, myWeekByDay } from "../utils/dashboardPlanning";

const ME = 7;

function task(id: number, overrides: Partial<Task> = {}): Task {
  return { id, project_id: 1, title: `Aufgabe ${id}`, status: "open", assignee_ids: [ME], ...overrides };
}

describe("mondayOf", () => {
  it.each([
    ["2026-10-19", "2026-10-19"], // Monday stays
    ["2026-10-21", "2026-10-19"], // Wednesday
    ["2026-10-25", "2026-10-19"], // Sunday belongs to the week before it
    ["2026-11-01", "2026-10-26"], // across a month, and the DST change (25 Oct)
    ["2027-01-01", "2026-12-28"], // across a year
    ["2026-03-29", "2026-03-23"], // spring DST Sunday
  ])("%s → %s", (day, monday) => {
    expect(mondayOf(day)).toBe(monday);
  });

  it("hands back what it cannot read instead of inventing a date", () => {
    expect(mondayOf("")).toBe("");
    expect(mondayOf("kein Datum")).toBe("kein Datum");
  });
});

describe("myTasksForDay", () => {
  it("keeps only tasks assigned to the user, by assignee list or the legacy single assignee", () => {
    const rows = [
      task(1, { due_date: "2026-10-21" }),
      task(2, { due_date: "2026-10-21", assignee_ids: [3] }),
      task(3, { due_date: "2026-10-21", assignee_ids: [], assignee_id: ME }),
      task(4, { due_date: "2026-10-21", assignee_ids: [3, ME] }),
    ];
    expect(myTasksForDay(rows, "2026-10-21", ME).map((row) => row.id)).toEqual([1, 3, 4]);
  });

  it("leaves done tasks out, in every spelling the app knows", () => {
    const rows = [
      task(1, { due_date: "2026-10-21", status: "done" }),
      task(2, { due_date: "2026-10-21", status: "completed" }),
      task(3, { due_date: "2026-10-21", status: "in_progress" }),
    ];
    expect(myTasksForDay(rows, "2026-10-21", ME).map((row) => row.id)).toEqual([3]);
  });

  it("shows a multi-day task on every day it covers, and undated tasks on none", () => {
    const rows = [task(1, { due_date: "2026-10-20", end_date: "2026-10-22" }), task(2, { due_date: null })];
    expect(myTasksForDay(rows, "2026-10-19", ME)).toEqual([]);
    expect(myTasksForDay(rows, "2026-10-20", ME).map((row) => row.id)).toEqual([1]);
    expect(myTasksForDay(rows, "2026-10-21", ME).map((row) => row.id)).toEqual([1]);
    expect(myTasksForDay(rows, "2026-10-22", ME).map((row) => row.id)).toEqual([1]);
    expect(myTasksForDay(rows, "2026-10-23", ME)).toEqual([]);
  });

  it("orders the day by start time, untimed work last, and never reorders its input", () => {
    const rows = [
      task(1, { title: "Ohne Uhrzeit", due_date: "2026-10-21" }),
      task(2, { title: "Nachmittag", due_date: "2026-10-21", start_time: "13:00:00" }),
      task(3, { title: "Früh", due_date: "2026-10-21", start_time: "07:30" }),
    ];
    const before = rows.map((row) => row.id);
    expect(myTasksForDay(rows, "2026-10-21", ME).map((row) => row.title)).toEqual(["Früh", "Nachmittag", "Ohne Uhrzeit"]);
    expect(rows.map((row) => row.id)).toEqual(before);
  });
});

describe("myTasksForWeek", () => {
  const rows = [
    task(1, { title: "Montag", due_date: "2026-10-19" }),
    task(2, { title: "Sonntag", due_date: "2026-10-25" }),
    task(3, { title: "Ragt hinein", due_date: "2026-10-15", end_date: "2026-10-19" }),
    task(4, { title: "Ragt hinaus", due_date: "2026-10-24", end_date: "2026-10-28" }),
    task(5, { title: "Letzte Woche", due_date: "2026-10-18" }),
    task(6, { title: "Nächste Woche", due_date: "2026-10-26" }),
    task(7, { title: "Fremd", due_date: "2026-10-21", assignee_ids: [3] }),
    task(8, { title: "Erledigt", due_date: "2026-10-21", status: "done" }),
  ];

  it("keeps each own open task overlapping Monday–Sunday once", () => {
    expect(myTasksForWeek(rows, "2026-10-19", ME).map((row) => row.title)).toEqual([
      "Ragt hinein",
      "Montag",
      "Ragt hinaus",
      "Sonntag",
    ]);
  });

  it("reads the week of any day it is given", () => {
    expect(myTasksForWeek(rows, "2026-10-22", ME).map((row) => row.id)).toEqual(
      myTasksForWeek(rows, "2026-10-19", ME).map((row) => row.id),
    );
  });
});

describe("myWeekByDay", () => {
  it("lists the days that have work, Monday first, a multi-day task under each day", () => {
    const rows = [
      task(1, { title: "Zwei Tage", due_date: "2026-10-20", end_date: "2026-10-21" }),
      task(2, { title: "Freitag", due_date: "2026-10-23" }),
    ];
    expect(myWeekByDay(rows, "2026-10-19", ME).map(({ day, tasks }) => [day, tasks.map((row) => row.id)])).toEqual([
      ["2026-10-20", [1]],
      ["2026-10-21", [1]],
      ["2026-10-23", [2]],
    ]);
  });
});
