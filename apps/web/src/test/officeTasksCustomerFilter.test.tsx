/**
 * The office Aufgaben page finds customer tasks.
 *
 * Its "Projekte" filter offered only projects, and a customer-only task has
 * no project id — so a picked project silently dropped every customer task,
 * and the row itself read "Projekt: " with nothing after the colon. The box
 * is "Projekt / Kunde" now: it suggests customers next to projects, a chosen
 * customer becomes a chip, and the row's anchor names the customer and opens
 * the customer page like the project link opens the project.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { OfficeTasksPage } from "../pages/OfficeTasksPage";
import type { Task } from "../types";

const CUSTOMER_TASK = {
  id: 1,
  project_id: null,
  customer_id: 7,
  customer_name: "Müller Haustechnik GmbH",
  title: "Rückruf wegen Angebot",
  status: "open",
  task_type: "office",
  due_date: "2026-09-22",
  assignee_ids: [1],
} as Task;

const PROJECT_TASK: Task = {
  id: 2,
  project_id: 12,
  title: "Zählerwechsel",
  status: "open",
  task_type: "office",
  due_date: "2026-09-23",
  assignee_ids: [1],
};

function renderPage(overrides: Record<string, unknown> = {}) {
  const setOfficeTaskCustomerFilterIds = vi.fn();
  const openProjectFromTask = vi.fn();
  const context = makeAppContextStub({
    overrides: {
      mainView: "office_tasks",
      tasks: [CUSTOMER_TASK, PROJECT_TASK],
      officeFilteredTasks: [CUSTOMER_TASK, PROJECT_TASK],
      todayIso: "2026-09-20",
      canManageTasks: true,
      isTaskAssignedToCurrentUser: () => true,
      getTaskAssigneeLabel: () => "Test",
      taskProjectTitleParts: (task: Task) =>
        task.project_id != null ? { title: "2026-0412 · Müller", subtitle: "" } : { title: "", subtitle: "" },
      taskCustomerLabel: (task: { project_id: number | null; customer_id?: number | null; customer_name?: string | null }) =>
        task.project_id == null && task.customer_id != null ? (task.customer_name ?? `Kunde #${task.customer_id}`) : "",
      officeTaskStatusFilter: "all",
      officeTaskAssigneeFilter: "all",
      officeTaskDueDateFilter: "",
      officeTaskNoDueDateFilter: false,
      officeTaskProjectFilterQuery: "",
      officeTaskProjectSuggestions: [],
      officeTaskSelectedProjectFilters: [],
      officeTaskStatusOptions: [],
      officeTaskAssigneeOptions: [],
      officeTaskProjectFilterIds: [],
      officeTaskCustomerFilterIds: [],
      setOfficeTaskCustomerFilterIds,
      openProjectFromTask,
      ...overrides,
    },
  });
  render(
    <AppContext.Provider value={context as never}>
      <OfficeTasksPage />
    </AppContext.Provider>,
  );
  return { setOfficeTaskCustomerFilterIds, openProjectFromTask };
}

describe("OfficeTasksPage customer tasks", () => {
  it("labels a customer task with Kunde: and opens the customer from it", () => {
    const { openProjectFromTask } = renderPage();
    const link = screen.getByRole("button", { name: "Müller Haustechnik GmbH" });
    expect(link.parentElement).toHaveTextContent(/Kunde:\s*Müller Haustechnik GmbH/);
    fireEvent.click(link);
    expect(openProjectFromTask).toHaveBeenCalledWith(CUSTOMER_TASK, "office_tasks");
    // The project task still reads Projekt:.
    expect(screen.getByRole("button", { name: "2026-0412 · Müller" }).parentElement).toHaveTextContent(/Projekt:/);
  });

  it("suggests the customer in the Projekt / Kunde box and adds it as a filter", () => {
    const { setOfficeTaskCustomerFilterIds } = renderPage({ officeTaskProjectFilterQuery: "müll" });
    fireEvent.click(screen.getByRole("button", { name: "Kunde: Müller Haustechnik GmbH" }));
    expect(setOfficeTaskCustomerFilterIds).toHaveBeenCalledTimes(1);
    const updater = setOfficeTaskCustomerFilterIds.mock.calls[0][0] as (current: number[]) => number[];
    expect(updater([])).toEqual([7]);
    expect(updater([7])).toEqual([7]);
  });

  it("picks the customer on Enter when no project matches", () => {
    const { setOfficeTaskCustomerFilterIds } = renderPage({ officeTaskProjectFilterQuery: "müll" });
    fireEvent.keyDown(screen.getByPlaceholderText(/Projekt oder Kunde suchen/), { key: "Enter" });
    expect(setOfficeTaskCustomerFilterIds).toHaveBeenCalledTimes(1);
  });

  it("shows a picked customer as a chip that removes itself", () => {
    const { setOfficeTaskCustomerFilterIds } = renderPage({ officeTaskCustomerFilterIds: [7] });
    fireEvent.click(screen.getByRole("button", { name: "Kunde: Müller Haustechnik GmbH ×" }));
    const updater = setOfficeTaskCustomerFilterIds.mock.calls[0][0] as (current: number[]) => number[];
    expect(updater([7, 8])).toEqual([8]);
    expect(screen.queryByText("Alle Projekte und Kunden")).not.toBeInTheDocument();
  });

  it("says that nothing is filtered when neither a project nor a customer is picked", () => {
    renderPage();
    expect(screen.getByText("Alle Projekte und Kunden")).toBeInTheDocument();
  });
});
