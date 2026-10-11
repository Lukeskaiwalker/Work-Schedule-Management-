/**
 * The vacation card shows days already approved for next year.
 *
 * A request over New Year deducts only this year's part on approval; next
 * year's part is planned and comes off at the rollover. Without this tile the
 * card would look as if those days were free.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { TimePage } from "../pages/TimePage";
import type { TimeCurrent } from "../types";

function timeCurrent(overrides: Partial<TimeCurrent> = {}): TimeCurrent {
  return {
    server_time: "2026-12-01T10:00:00",
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
    ...overrides,
  };
}

function renderTimePage(current: TimeCurrent, language: "de" | "en" = "de") {
  return render(
    <AppContext.Provider
      value={makeAppContextStub({ overrides: { mainView: "time", language, timeCurrent: current } }) as never}
    >
      <TimePage />
    </AppContext.Provider>,
  );
}

describe("vacation card: days planned for next year", () => {
  it("shows the planned days under the next year's label", () => {
    renderTimePage(timeCurrent({ vacation_days_planned_next_year: 2 }));

    const label = screen.getByText("Vorgemerkt 2027");
    const tile = label.closest(".time-vacation-stat");
    expect(tile).not.toBeNull();
    expect(tile?.querySelector(".time-vacation-stat-value")?.textContent).toBe("2");
  });

  it("takes the year from the server clock, not a fixed one", () => {
    renderTimePage(timeCurrent({ server_time: "2027-03-15T08:00:00", vacation_days_planned_next_year: 4 }));
    expect(screen.getByText("Vorgemerkt 2028")).toBeTruthy();
  });

  it("stays hidden while nothing is planned", () => {
    renderTimePage(timeCurrent({ vacation_days_planned_next_year: 0 }));
    expect(screen.queryByText(/^Vorgemerkt/)).toBeNull();
  });

  it("stays hidden for an older server that does not send the field", () => {
    const { vacation_days_planned_next_year: _omitted, ...older } = timeCurrent();
    renderTimePage(older as TimeCurrent);
    expect(screen.queryByText(/^Vorgemerkt/)).toBeNull();
  });

  it("speaks English when the app does", () => {
    renderTimePage(timeCurrent({ vacation_days_planned_next_year: 1 }), "en");
    expect(screen.getByText("Planned 2027")).toBeTruthy();
  });
});
