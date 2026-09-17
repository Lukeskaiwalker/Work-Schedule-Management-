/**
 * One status, one spelling.
 *
 * The office task page built its Status dropdown from the raw strings in the
 * loaded rows, so a legacy "Offen" or "completed" next to "open"/"done" gave
 * the same German label twice. Everything that labels, checks or lists a
 * status now goes through canonicalTaskStatus first; these pin the alias
 * table and the dedup.
 */
import { describe, expect, it } from "vitest";
import {
  buildTaskStatusOptions,
  canonicalTaskStatus,
  isTaskDoneStatus,
  taskDisplayStatus,
  taskStatusLabel,
} from "../utils/tasks";
import type { Task } from "../types";

describe("canonicalTaskStatus", () => {
  it.each([
    ["open", "open"],
    ["Offen", "open"],
    ["  offen ", "open"],
    ["todo", "open"],
    ["to-do", "open"],
    ["new", "open"],
    ["in_progress", "in_progress"],
    ["In Arbeit", "in_progress"],
    ["in bearbeitung", "in_progress"],
    ["in-progress", "in_progress"],
    ["inprogress", "in_progress"],
    ["on_hold", "on_hold"],
    ["on-hold", "on_hold"],
    ["Pausiert", "on_hold"],
    ["onhold", "on_hold"],
    ["paused", "on_hold"],
    ["done", "done"],
    ["Erledigt", "done"],
    ["fertig", "done"],
    ["abgeschlossen", "done"],
    ["completed", "done"],
    ["complete", "done"],
    ["finished", "done"],
    ["closed", "done"],
    ["overdue", "overdue"],
    ["OVERDUE", "overdue"],
  ])("maps %j to %j", (input, expected) => {
    expect(canonicalTaskStatus(input)).toBe(expected);
  });

  it("returns the cleaned string for an unknown value and '' for nothing", () => {
    expect(canonicalTaskStatus("Wartet auf Teile")).toBe("wartet_auf_teile");
    expect(canonicalTaskStatus("")).toBe("");
    expect(canonicalTaskStatus(null)).toBe("");
    expect(canonicalTaskStatus(undefined)).toBe("");
  });
});

describe("buildTaskStatusOptions", () => {
  it("folds legacy spellings into one key each", () => {
    expect(buildTaskStatusOptions(["open", "Offen", "completed", "done"])).toEqual(["open", "done"]);
  });

  it("keeps the fixed order regardless of input order and appends overdue on request", () => {
    expect(
      buildTaskStatusOptions(["done", "on_hold", "open", "in_progress"], { includeOverdue: true }),
    ).toEqual(["open", "in_progress", "on_hold", "done", "overdue"]);
  });

  it("lists unknown leftovers alphabetically after the known keys and drops blanks", () => {
    expect(buildTaskStatusOptions(["zzz", "open", "", null, "abc", "done"])).toEqual([
      "open",
      "done",
      "abc",
      "zzz",
    ]);
  });
});

describe("labels and done-checks agree on the canonical form", () => {
  it("labels a legacy 'Offen' row exactly like an 'open' one", () => {
    expect(taskStatusLabel("Offen", "de")).toBe("Offen");
    expect(taskStatusLabel("open", "de")).toBe("Offen");
    expect(taskStatusLabel("completed", "de")).toBe("Erledigt");
    expect(taskStatusLabel("in-progress", "en")).toBe("In progress");
  });

  it("treats every done alias as done", () => {
    expect(isTaskDoneStatus("Erledigt")).toBe(true);
    expect(isTaskDoneStatus("completed")).toBe(true);
    expect(isTaskDoneStatus("closed")).toBe(true);
    expect(isTaskDoneStatus("open")).toBe(false);
  });

  it("does not flag a legacy 'Erledigt' task with a past due date as overdue", () => {
    const task = { id: 1, project_id: 1, title: "T", status: "Erledigt", due_date: "2026-01-01" } as Task;
    expect(taskDisplayStatus(task, "2026-09-12")).toBe("done");
  });

  it("keeps a multi-day task in its plain status until its last day has passed", () => {
    const window = { id: 2, project_id: 1, title: "T", status: "open", due_date: "2026-09-10", end_date: "2026-09-14" } as Task;
    expect(taskDisplayStatus(window, "2026-09-12")).toBe("open");
    expect(taskDisplayStatus(window, "2026-09-15")).toBe("overdue");
  });
});
