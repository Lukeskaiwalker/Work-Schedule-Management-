/**
 * A task can span days (Von/Bis). These pin the client-side reading of the
 * window so it cannot drift from the api's: the last day decides overdue, a
 * day is "covered" when it lies inside the window, "Tag 2/3" counts from Von,
 * and the range label stays ISO for single-day rows AND windows alike.
 */
import { describe, expect, it } from "vitest";
import {
  formatTaskDateRange,
  isTaskOverdue,
  taskDayCount,
  taskDayIndexLabel,
  taskEndDate,
  taskNotificationDigest,
  taskSpansDay,
} from "../utils/tasks";
import type { Task } from "../types";

function task(overrides: Partial<Task> = {}): Task {
  return { id: 1, project_id: 1, title: "Montage", status: "open", ...overrides };
}

describe("taskEndDate", () => {
  it("is the end date, falling back to the due date, and empty when undated", () => {
    expect(taskEndDate(task({ due_date: "2026-10-01", end_date: "2026-10-03" }))).toBe("2026-10-03");
    expect(taskEndDate(task({ due_date: "2026-10-01", end_date: null }))).toBe("2026-10-01");
    expect(taskEndDate(task({ due_date: "2026-10-01" }))).toBe("2026-10-01");
    expect(taskEndDate(task({ due_date: null, end_date: "2026-10-03" }))).toBe("");
  });

  it("ignores an end date before the start instead of shrinking the window", () => {
    expect(taskEndDate(task({ due_date: "2026-10-05", end_date: "2026-10-01" }))).toBe("2026-10-05");
  });
});

describe("isTaskOverdue with a window", () => {
  it("is not overdue while the window is still running", () => {
    const running = task({ due_date: "2026-10-01", end_date: "2026-10-03" });
    expect(isTaskOverdue(running, "2026-10-02")).toBe(false);
    expect(isTaskOverdue(running, "2026-10-03")).toBe(false);
  });

  it("is overdue once the last day has passed", () => {
    expect(isTaskOverdue(task({ due_date: "2026-10-01", end_date: "2026-10-03" }), "2026-10-04")).toBe(true);
    expect(isTaskOverdue(task({ due_date: "2026-10-01" }), "2026-10-02")).toBe(true);
  });

  it("still trusts the server flag and the done status first", () => {
    expect(isTaskOverdue(task({ due_date: "2026-10-01", end_date: "2026-10-09", is_overdue: true }), "2026-10-02")).toBe(true);
    expect(isTaskOverdue(task({ due_date: "2026-10-01", end_date: "2026-10-03", status: "done" }), "2026-10-09")).toBe(false);
  });
});

describe("taskSpansDay / taskDayCount / taskDayIndexLabel", () => {
  const window = task({ due_date: "2026-10-01", end_date: "2026-10-03" });

  it("covers every day from Von to Bis inclusive", () => {
    expect(taskSpansDay(window, "2026-09-30")).toBe(false);
    expect(taskSpansDay(window, "2026-10-01")).toBe(true);
    expect(taskSpansDay(window, "2026-10-02")).toBe(true);
    expect(taskSpansDay(window, "2026-10-03")).toBe(true);
    expect(taskSpansDay(window, "2026-10-04")).toBe(false);
    expect(taskSpansDay(task({ due_date: null }), "2026-10-01")).toBe(false);
  });

  it("counts the days, one for a single day and zero when undated", () => {
    expect(taskDayCount(window)).toBe(3);
    expect(taskDayCount(task({ due_date: "2026-10-01" }))).toBe(1);
    expect(taskDayCount(task({ due_date: null }))).toBe(0);
    // Across a DST change the count is still whole days.
    expect(taskDayCount(task({ due_date: "2026-10-24", end_date: "2026-10-26" }))).toBe(3);
  });

  it("labels the day inside the window and nothing outside it or for a single day", () => {
    expect(taskDayIndexLabel(window, "2026-10-01", "de")).toBe("Tag 1/3");
    expect(taskDayIndexLabel(window, "2026-10-02", "de")).toBe("Tag 2/3");
    expect(taskDayIndexLabel(window, "2026-10-03", "en")).toBe("Day 3/3");
    expect(taskDayIndexLabel(window, "2026-10-04", "de")).toBe("");
    expect(taskDayIndexLabel(task({ due_date: "2026-10-01" }), "2026-10-01", "de")).toBe("");
  });
});

describe("formatTaskDateRange", () => {
  it("keeps the plain ISO date for a single day, as every list printed before", () => {
    expect(formatTaskDateRange(task({ due_date: "2026-10-01" }))).toBe("2026-10-01");
    expect(formatTaskDateRange(task({ due_date: "2026-10-01", end_date: "2026-10-01" }))).toBe("2026-10-01");
    expect(formatTaskDateRange(task({ due_date: null }))).toBe("");
  });

  it("prints a window as an ISO pair, so one column never mixes two date systems", () => {
    // "Fällig: 2026-10-01" sits directly above "Fällig: <window>" in the same
    // list; a dotted "01.10. – 03.10.2026" there read as a second date system.
    const window = formatTaskDateRange(task({ due_date: "2026-10-01", end_date: "2026-10-03" }));
    expect(window).toBe("2026-10-01 – 2026-10-03");
    expect(window).not.toMatch(/\d{2}\.\d{2}\./);
    expect(formatTaskDateRange(task({ due_date: "2026-12-30", end_date: "2027-01-02" }))).toBe("2026-12-30 – 2027-01-02");
  });

  it("does not read the language: the format is the same in German and English", () => {
    // The signature takes no language on purpose — one format, one column.
    expect(formatTaskDateRange.length).toBe(1);
  });
});

describe("taskNotificationDigest", () => {
  it("changes when only the end date moves, so a Bis-only reschedule is noticed", () => {
    const before = taskNotificationDigest([task({ due_date: "2026-10-01", end_date: "2026-10-03" })]);
    const after = taskNotificationDigest([task({ due_date: "2026-10-01", end_date: "2026-10-05" })]);
    expect(before).not.toBe(after);
  });
});
