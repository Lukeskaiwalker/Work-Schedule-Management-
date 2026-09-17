/**
 * The server places a multi-day task on every day it covers. In Einsatz mode
 * the board collapses a day's tasks into one row per customer, so a Mo–Mi
 * installation used to read as three identical "Müller · 1 Aufgabe" rows with
 * nothing saying they are one job. The "Tag n/N" chip on the Einsatz row and
 * next to the task in the day sheet is that sign — the same chip the task
 * board and the calendar already wear.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { PlanningPage } from "../pages/PlanningPage";
import type { Task } from "../types";

const WEEK = ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08"];

const INSTALLATION_FROM = "2026-03-02";
const INSTALLATION_TO = "2026-03-04";
const ABNAHME_DAY = "2026-03-05";

const INSTALLATION: Task = {
  id: 1,
  project_id: null,
  customer_id: 5,
  title: "Installation",
  status: "open",
  due_date: INSTALLATION_FROM,
  end_date: INSTALLATION_TO,
  start_time: "08:00:00",
  assignee_ids: [1],
};

const SINGLE_DAY: Task = {
  id: 2,
  project_id: null,
  customer_id: 5,
  title: "Abnahme",
  status: "open",
  due_date: ABNAHME_DAY,
  assignee_ids: [1],
};

function renderBoard() {
  const context = makeAppContextStub({
    overrides: {
      mainView: "planning",
      // Anything but "office" opens the board in Einsatz mode.
      workspaceMode: "construction",
      user: { id: 1, email: "luca@example.com", role: "employee", display_name: "Luca", preferences: {} },
      planningWeekStart: "2026-03-02",
      planningWeekInfo: { week: 10, year: 2026 },
      planningWeek: {
        week_start: "2026-03-02",
        week_end: "2026-03-08",
        days: WEEK.map((date) => ({
          date,
          tasks: [
            ...(date >= INSTALLATION_FROM && date <= INSTALLATION_TO ? [INSTALLATION] : []),
            ...(date === ABNAHME_DAY ? [SINGLE_DAY] : []),
          ],
          absences: [],
        })),
      },
      planningTaskTypeView: "all",
      todayIso: "2026-03-03",
      canManageTasks: false,
      isTaskAssignedToCurrentUser: () => true,
      getTaskAssigneeLabel: () => "Luca",
      taskProjectTitleParts: () => ({ title: "", subtitle: "" }),
      menuUserNameById: (_id: number, fallback?: string) => fallback ?? "Luca",
      customers: [{ id: 5, name: "Müller" }],
      projects: [],
      absenceTypes: [],
      publicHolidays: [],
    },
  });
  render(
    <AppContext.Provider value={context as never}>
      <PlanningPage />
    </AppContext.Provider>,
  );
}

describe("PlanningPage — Tag n/N in Einsatz mode", () => {
  it("marks each day's Einsatz row with the day of the job, and only those", () => {
    renderBoard();
    expect(screen.getByText("Tag 1/3")).toBeInTheDocument();
    expect(screen.getByText("Tag 2/3")).toBeInTheDocument();
    expect(screen.getByText("Tag 3/3")).toBeInTheDocument();
    // Four Müller rows: three days of the installation plus the single-day
    // Abnahme on Thursday, which wears no chip.
    expect(screen.getAllByText("Müller")).toHaveLength(4);
    expect(screen.queryByText(/Tag 1\/1/)).not.toBeInTheDocument();
  });

  it("repeats the chip next to the task in the Einsatz day sheet", () => {
    renderBoard();
    fireEvent.click(screen.getByRole("button", { name: /Tag 2\/3/ }));
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByText("Installation")).toBeInTheDocument();
    expect(within(sheet).getByText("Tag 2/3")).toBeInTheDocument();
  });

  it("shows no chip in the sheet of a single-day Einsatz", () => {
    renderBoard();
    fireEvent.click(screen.getAllByRole("button", { name: /Müller/ })[3]!);
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByText("Abnahme")).toBeInTheDocument();
    expect(within(sheet).queryByText(/^Tag \d+\/\d+$/)).not.toBeInTheDocument();
  });
});
