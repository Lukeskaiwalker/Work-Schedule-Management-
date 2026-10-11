/**
 * The Zeiterfassung page speaks German end to end.
 *
 * The month calendar's header read "Mo Tu We Th Fr Sa Su" whatever the
 * language, and the KPI donuts said "of 8h". German weekday abbreviations
 * are Mo Di Mi Do Fr Sa So; the donut says "von 8h".
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { TimePage } from "../pages/TimePage";
import type { TimeCurrent } from "../types";

const CURRENT: TimeCurrent = {
  server_time: "2026-10-12T10:00:00",
  break_open: false,
  worked_hours_live: 0,
  break_hours_live: 0,
  required_break_hours_live: 0,
  deducted_break_hours_live: 0,
  net_hours_live: 0,
  required_daily_hours: 8,
  daily_net_hours: 0,
  progress_percent_live: 0,
  vacation_days_per_year: 30,
  vacation_days_available: 0,
  vacation_days_carryover: 0,
  vacation_days_total_remaining: 0,
  vacation_days_planned_next_year: 0,
};

function renderTimePage(language: "de" | "en", overrides: Record<string, unknown> = {}) {
  return render(
    <AppContext.Provider
      value={
        makeAppContextStub({
          overrides: { mainView: "time", language, timeCurrent: CURRENT, requiredDailyHours: 8, ...overrides },
        }) as never
      }
    >
      <TimePage />
    </AppContext.Provider>,
  );
}

function weekdayHeader(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".time-calendar-weekday")].map((cell) => cell.textContent ?? "");
}

describe("Zeiterfassung month calendar", () => {
  it("heads the weeks with German weekday abbreviations", () => {
    const { container } = renderTimePage("de");
    expect(weekdayHeader(container)).toEqual(["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]);
  });

  it("keeps the English abbreviations in the English UI", () => {
    const { container } = renderTimePage("en");
    expect(weekdayHeader(container)).toEqual(["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]);
  });
});

describe("Zeiterfassung KPI donuts", () => {
  it("say how much of the target in German", () => {
    const { container } = renderTimePage("de");
    const subs = [...container.querySelectorAll(".time-kpi-donut-sub")].map((node) => node.textContent);
    expect(subs[0]).toBe("von 8h");
    expect(subs.every((text) => text?.startsWith("von "))).toBe(true);
  });

  it("say it in English in the English UI", () => {
    const { container } = renderTimePage("en");
    expect(container.querySelector(".time-kpi-donut-sub")?.textContent).toBe("of 8h");
  });
});

describe("viewing another employee's time", () => {
  it("says in German that clocking is off", () => {
    const { container } = renderTimePage("de", { viewingOwnTime: false });
    const note = container.querySelector(".time-shift-viewer-note")?.textContent ?? "";
    expect(note).toContain("Ein- und Ausstempeln ist deaktiviert");
    expect(note).not.toMatch(/Clock/);
  });
});
