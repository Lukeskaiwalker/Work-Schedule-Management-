/**
 * Meine Aufgaben is the OPEN list (view=my). The overview loads my_all — done
 * rows of the last 30 days included — into the same `tasks` state. loadTasks
 * drops a response that is no longer the newest request's, but the page must
 * not depend on that alone: whatever payload is in the state, a done row is
 * filtered out here, so ERLEDIGT badges never appear on a list that cannot
 * expand them.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { MyTasksPage } from "../pages/MyTasksPage";
import type { Task } from "../types";

function task(id: number, overrides: Partial<Task> = {}): Task {
  return { id, project_id: 1, title: `Aufgabe ${id}`, status: "open", assignee_ids: [1], ...overrides };
}

function renderPage(rows: Task[]) {
  const context = makeAppContextStub({
    overrides: {
      mainView: "my_tasks",
      todayIso: "2026-09-17",
      sortedTasks: rows,
      isTaskAssignedToCurrentUser: (row: Task) => (row.assignee_ids ?? []).includes(1),
      taskProjectTitleParts: () => ({ title: "P-1 · Müller", subtitle: "" }),
      projects: [],
    },
  });
  render(
    <AppContext.Provider value={context as never}>
      <MyTasksPage />
    </AppContext.Provider>,
  );
}

describe("MyTasksPage", () => {
  it("never lists a done row, even when a my_all payload left one in the shared tasks state", () => {
    renderPage([
      task(1, { title: "Offen morgen", due_date: "2026-09-18" }),
      task(2, { title: "Erledigt gestern", status: "done", due_date: "2026-09-16" }),
      task(3, { title: "Abgeschlossen (legacy)", status: "completed", due_date: "2026-09-15" }),
      task(4, { title: "In Arbeit", status: "in_progress", due_date: "2026-09-17" }),
    ]);
    expect(screen.getByText("Offen morgen")).toBeInTheDocument();
    expect(screen.getByText("In Arbeit")).toBeInTheDocument();
    expect(screen.queryByText("Erledigt gestern")).not.toBeInTheDocument();
    expect(screen.queryByText("Abgeschlossen (legacy)")).not.toBeInTheDocument();
    expect(screen.queryByText("ERLEDIGT")).not.toBeInTheDocument();
    expect(screen.getByText(/2 offen/)).toBeInTheDocument();
  });

  it("shows the empty state when only done rows arrived", () => {
    renderPage([task(2, { title: "Erledigt gestern", status: "done", due_date: "2026-09-16" })]);
    expect(screen.getByText("Keine Aufgaben.")).toBeInTheDocument();
    expect(screen.getByText(/0 offen/)).toBeInTheDocument();
  });
});
