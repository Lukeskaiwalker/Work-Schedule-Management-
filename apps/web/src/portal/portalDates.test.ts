/**
 * The partner portal's calendar words.
 *
 * What must hold: open jobs fall into Überfällig / Heute / Diese Woche /
 * Später / Ohne Termin by the server's overdue flag and the local calendar
 * week (Monday to Sunday), a multi-day job that covers today is today's;
 * groups keep their order and drop when empty; the time lane shows the start
 * time and duration today, the weekday and date otherwise; durations, time
 * ranges and long dates read the way a German site foreman writes them.
 */
import { describe, expect, it } from "vitest";
import type { PortalTask } from "./portalTypes";
import {
  formatDuration,
  formatLongDate,
  formatShortDate,
  formatTimeRange,
  groupOpenTasks,
  timeLane,
  whenLines,
} from "./portalDates";

function task(id: number, fields: Partial<PortalTask> = {}): PortalTask {
  return {
    id,
    title: `Aufgabe ${id}`,
    status: "open",
    due_date: null,
    end_date: null,
    start_time: null,
    estimated_hours: null,
    is_overdue: false,
    project: null,
    customer_name: null,
    address: null,
    attachment_count: 0,
    ...fields,
  };
}

// Friday, 9 October 2026; the week runs to Sunday the 11th.
const TODAY = "2026-10-09";

describe("groupOpenTasks", () => {
  it("sorts jobs into the five groups in their fixed order and drops empty ones", () => {
    const groups = groupOpenTasks(
      [
        task(1, { due_date: "2026-10-07", is_overdue: true }),
        task(2, { due_date: TODAY, start_time: "07:30:00" }),
        task(3, { due_date: "2026-10-10" }),
        task(4, { due_date: "2026-10-11" }),
        task(5, { due_date: "2026-10-12" }),
        task(6),
      ],
      TODAY,
    );
    expect(groups.map((g) => [g.key, g.tasks.map((t) => t.id)])).toEqual([
      ["overdue", [1]],
      ["today", [2]],
      ["week", [3, 4]],
      ["later", [5]],
      ["undated", [6]],
    ]);
    expect(groupOpenTasks([task(7, { due_date: "2026-11-02" })], TODAY).map((g) => g.key)).toEqual(["later"]);
  });

  it("puts a multi-day job that covers today under Heute", () => {
    const groups = groupOpenTasks([task(1, { due_date: "2026-10-08", end_date: "2026-10-10" })], TODAY);
    expect(groups[0].key).toBe("today");
  });

  it("labels the groups for the reader", () => {
    const groups = groupOpenTasks(
      [task(1, { is_overdue: true, due_date: "2026-10-01" }), task(2, { due_date: TODAY }), task(3, { due_date: "2026-10-11" })],
      TODAY,
    );
    expect(groups.map((g) => [g.label, g.hint])).toEqual([
      ["Überfällig", "bitte erledigen oder im Büro melden"],
      ["Heute", "Freitag, 9. Oktober"],
      ["Diese Woche", "bis Sonntag, 11. Oktober"],
    ]);
  });

  it("on a Sunday has no rest of the week, so tomorrow is later", () => {
    const groups = groupOpenTasks([task(1, { due_date: "2026-10-12" })], "2026-10-11");
    expect(groups.map((g) => g.key)).toEqual(["later"]);
  });
});

describe("timeLane", () => {
  it("shows start time and duration for today, weekday and date otherwise", () => {
    expect(timeLane(task(1, { due_date: TODAY, start_time: "07:30:00", estimated_hours: 6 }), TODAY)).toEqual({ primary: "07:30", secondary: "6 Std." });
    expect(timeLane(task(2, { due_date: TODAY }), TODAY)).toEqual({ primary: "Heute", secondary: "" });
    expect(timeLane(task(3, { due_date: "2026-10-10" }), TODAY)).toEqual({ primary: "Sa", secondary: "10.10." });
    expect(timeLane(task(4), TODAY)).toEqual({ primary: "—", secondary: "" });
  });
});

describe("formatters", () => {
  it("write durations, ranges and dates the German way", () => {
    expect(formatDuration(6)).toBe("6 Std.");
    expect(formatDuration(1.5)).toBe("1,5 Std.");
    expect(formatDuration(0.5)).toBe("30 Min.");
    expect(formatDuration(null)).toBe("");
    expect(formatTimeRange("07:30:00", 6)).toBe("07:30 – 13:30");
    expect(formatTimeRange("07:30:00", null)).toBe("ab 07:30");
    expect(formatTimeRange(null, 6)).toBe("");
    expect(formatLongDate("2026-10-09")).toBe("Freitag, 9. Oktober");
    expect(formatShortDate("2026-10-09")).toBe("Fr 9.10.");
  });

  it("describe when a job happens in one or two lines", () => {
    expect(whenLines(task(1, { due_date: TODAY, start_time: "07:30:00", estimated_hours: 6 }))).toEqual({
      title: "Freitag, 9. Oktober",
      detail: "07:30 – 13:30 · ca. 6 Std.",
    });
    expect(whenLines(task(2, { due_date: "2026-10-13", end_date: "2026-10-15", start_time: "07:00:00", estimated_hours: 8 }))).toEqual({
      title: "Di 13.10. – Do 15.10.",
      detail: "täglich 07:00 – 15:00 · ca. 8 Std.",
    });
    expect(whenLines(task(3))).toEqual({ title: "Noch kein Termin", detail: "Das Büro meldet sich mit einem Termin." });
  });
});
