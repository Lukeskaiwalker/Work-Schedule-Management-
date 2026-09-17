/**
 * "Meine Aufgaben" on the construction overview.
 *
 * The card exists so the field worker sees what is on for them before
 * anything else; what has to hold is the ORDER (overdue first, done last —
 * the row that needs attention is never below the ones that do not), the
 * filter (each status, and "Erledigt" reaching the done rows the old
 * "my" view never loaded), the fold behind "+n weitere", and what a click
 * does: a non-manager's done row leads to the list without pretending the
 * list could expand it.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import {
  MY_TASKS_CARD_ROW_LIMIT,
  MyTasksOverviewCard,
  filterMyTasks,
  myTasksRowAction,
  sortMyTasksForCard,
} from "../components/tasks/MyTasksOverviewCard";
import type { Task } from "../types";

const TODAY = "2026-09-17";

function task(id: number, overrides: Partial<Task> = {}): Task {
  return { id, project_id: 1, title: `Aufgabe ${id}`, status: "open", assignee_ids: [1], ...overrides };
}

const ROWS: Task[] = [
  task(1, { title: "Erledigt gestern", status: "done", due_date: "2026-09-16" }),
  task(2, { title: "Offen morgen", status: "open", due_date: "2026-09-18" }),
  task(3, { title: "Überfällig", status: "open", due_date: "2026-09-10" }),
  task(4, { title: "In Arbeit heute", status: "in_progress", due_date: "2026-09-17" }),
  task(5, { title: "Pausiert", status: "on_hold", due_date: "2026-09-20" }),
  task(6, { title: "Läuft noch", status: "open", due_date: "2026-09-15", end_date: "2026-09-19" }),
  task(7, { title: "Nicht meins", status: "open", due_date: "2026-09-11", assignee_ids: [2] }),
];

type Spies = {
  openTaskEditModal: ReturnType<typeof vi.fn>;
  setExpandedMyTaskId: ReturnType<typeof vi.fn>;
  setMainView: ReturnType<typeof vi.fn>;
};

function renderCard(overrides: Record<string, unknown> = {}, rows: Task[] = ROWS) {
  const spies: Spies = {
    openTaskEditModal: vi.fn(),
    setExpandedMyTaskId: vi.fn(),
    setMainView: vi.fn(),
  };
  const context = makeAppContextStub({
    overrides: {
      sortedTasks: rows,
      todayIso: TODAY,
      isTaskAssignedToCurrentUser: (row: Task) => (row.assignee_ids ?? []).includes(1),
      taskProjectTitleParts: () => ({ title: "P-1 · Müller", subtitle: "" }),
      canManageTasks: true,
      ...spies,
      ...overrides,
    },
  });
  render(
    <AppContext.Provider value={context as never}>
      <MyTasksOverviewCard />
    </AppContext.Provider>,
  );
  return spies;
}

function renderedTitles(): string[] {
  return screen
    .getAllByRole("listitem")
    .map((li) => li.querySelector(".tasks-page-row-title")?.textContent ?? "");
}

describe("sortMyTasksForCard", () => {
  it("puts overdue rows first, then open work by date, then done", () => {
    const order = sortMyTasksForCard(ROWS, TODAY).map((row) => row.title);
    expect(order).toEqual([
      "Überfällig",
      "Nicht meins",
      "Läuft noch",
      "In Arbeit heute",
      "Offen morgen",
      "Pausiert",
      "Erledigt gestern",
    ]);
  });

  it("does not count a running multi-day task as overdue", () => {
    expect(sortMyTasksForCard(ROWS, TODAY)[0]?.title).toBe("Überfällig");
    expect(filterMyTasks(ROWS, "overdue", TODAY).map((row) => row.title)).toEqual(["Überfällig", "Nicht meins"]);
  });
});

describe("filterMyTasks", () => {
  it.each([
    ["all", 7],
    ["open", 4],
    ["in_progress", 1],
    ["on_hold", 1],
    ["done", 1],
    ["overdue", 2],
  ] as const)("%s keeps %i rows", (filter, count) => {
    expect(filterMyTasks(ROWS, filter, TODAY)).toHaveLength(count);
  });

  it("matches a legacy status spelling through the canonical form", () => {
    expect(filterMyTasks([task(9, { status: "Offen" })], "open", TODAY)).toHaveLength(1);
    expect(filterMyTasks([task(9, { status: "completed" })], "done", TODAY)).toHaveLength(1);
  });
});

describe("myTasksRowAction", () => {
  it("edits for a manager, expands an open row and only lists a done row for everyone else", () => {
    expect(myTasksRowAction(task(1, { status: "done" }), true)).toBe("edit");
    expect(myTasksRowAction(task(1, { status: "open" }), true)).toBe("edit");
    expect(myTasksRowAction(task(1, { status: "open" }), false)).toBe("expand");
    expect(myTasksRowAction(task(1, { status: "in_progress" }), false)).toBe("expand");
    expect(myTasksRowAction(task(1, { status: "done" }), false)).toBe("list");
    // Legacy spelling of done is done too — view=my would not load it either.
    expect(myTasksRowAction(task(1, { status: "completed" }), false)).toBe("list");
  });
});

describe("MyTasksOverviewCard", () => {
  it("renders only my tasks, overdue first and done last, with the overdue count", () => {
    renderCard();
    expect(screen.getByRole("heading", { name: "Meine Aufgaben" })).toBeInTheDocument();
    expect(screen.getByText("1 überfällig")).toBeInTheDocument();
    expect(screen.queryByText("Nicht meins")).not.toBeInTheDocument();
    const titles = renderedTitles();
    expect(titles[0]).toBe("Überfällig");
    expect(titles[titles.length - 1]).toBe("Erledigt gestern");
  });

  it("filters by each status and says so when nothing matches", () => {
    renderCard();
    const select = screen.getByLabelText("Aufgaben nach Status filtern");
    fireEvent.change(select, { target: { value: "done" } });
    expect(renderedTitles()).toEqual(["Erledigt gestern"]);
    fireEvent.change(select, { target: { value: "overdue" } });
    expect(renderedTitles()).toEqual(["Überfällig"]);
    fireEvent.change(select, { target: { value: "on_hold" } });
    expect(renderedTitles()).toEqual(["Pausiert"]);
    fireEvent.change(select, { target: { value: "in_progress" } });
    expect(renderedTitles()).toEqual(["In Arbeit heute"]);
    fireEvent.change(select, { target: { value: "open" } });
    expect(renderedTitles()).toEqual(["Überfällig", "Läuft noch", "Offen morgen"]);
  });

  it("shows the empty state for no tasks, and a different one for an empty filter", () => {
    renderCard({}, []);
    expect(screen.getByText("Keine Aufgaben.")).toBeInTheDocument();
  });

  it("says 'Keine Aufgaben in diesem Status.' when the filter hides everything", () => {
    renderCard({}, [task(1, { status: "open", due_date: "2026-09-18" })]);
    fireEvent.change(screen.getByLabelText("Aufgaben nach Status filtern"), { target: { value: "done" } });
    expect(screen.getByText("Keine Aufgaben in diesem Status.")).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("opens the edit modal for a manager and navigates for everyone else", () => {
    const managerSpies = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Aufgabe bearbeiten: Überfällig" }));
    expect(managerSpies.openTaskEditModal).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }));
    expect(managerSpies.setMainView).not.toHaveBeenCalled();
  });

  it("expands the row on the Meine-Aufgaben page for a non-manager", () => {
    const spies = renderCard({ canManageTasks: false });
    fireEvent.click(screen.getByRole("button", { name: "Aufgabe öffnen: Überfällig" }));
    expect(spies.openTaskEditModal).not.toHaveBeenCalled();
    expect(spies.setExpandedMyTaskId).toHaveBeenCalledWith(3);
    expect(spies.setMainView).toHaveBeenCalledWith("my_tasks");
  });

  it("takes a non-manager to the list WITHOUT expanding a done row, and does not call it 'öffnen'", () => {
    // Meine Aufgaben loads view=my (open only): the done row is not there,
    // and an expanded id would only be cleared by the page's own effect.
    const spies = renderCard({ canManageTasks: false });
    expect(screen.queryByRole("button", { name: "Aufgabe öffnen: Erledigt gestern" })).not.toBeInTheDocument();
    const row = screen.getByRole("button", { name: "Meine Aufgaben öffnen (erledigt: Erledigt gestern)" });
    expect(row).toHaveClass("my-tasks-card-row-header--list-only");
    fireEvent.click(row);
    expect(spies.setExpandedMyTaskId).not.toHaveBeenCalled();
    expect(spies.openTaskEditModal).not.toHaveBeenCalled();
    expect(spies.setMainView).toHaveBeenCalledWith("my_tasks");
  });

  it("still lets a manager edit a done row from the card", () => {
    const spies = renderCard();
    const row = screen.getByRole("button", { name: "Aufgabe bearbeiten: Erledigt gestern" });
    expect(row).not.toHaveClass("my-tasks-card-row-header--list-only");
    fireEvent.click(row);
    expect(spies.openTaskEditModal).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it("folds everything past the row limit behind '+n weitere'", () => {
    const many = Array.from({ length: MY_TASKS_CARD_ROW_LIMIT + 3 }, (_, index) =>
      task(100 + index, { title: `Aufgabe ${100 + index}`, due_date: "2026-09-18" }),
    );
    const spies = renderCard({}, many);
    expect(screen.getAllByRole("listitem")).toHaveLength(MY_TASKS_CARD_ROW_LIMIT);
    const more = screen.getByRole("button", { name: "+3 weitere" });
    fireEvent.click(more);
    expect(spies.setMainView).toHaveBeenCalledWith("my_tasks");
  });

  it("'Alle anzeigen' goes to the Meine-Aufgaben page", () => {
    const spies = renderCard();
    fireEvent.click(screen.getByRole("button", { name: /Alle anzeigen/ }));
    expect(spies.setMainView).toHaveBeenCalledWith("my_tasks");
  });
});
