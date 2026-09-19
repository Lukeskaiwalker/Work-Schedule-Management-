/**
 * Opening a customer task from any list works like opening a project task.
 *
 * The edit modal's eyebrow named the project, or said "Allgemeine Aufgabe"
 * for anything else — a customer task read as anchored to nothing. It now
 * says "Kunde: Müller Haustechnik GmbH", and "Zum Kunden" closes the modal and
 * opens the customer page, the way the project link on a row opens the
 * project. A project task keeps its project eyebrow and gets no such link.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { TaskEditModal } from "../components/modals/TaskEditModal";
import { buildTaskEditFormState } from "../utils/reports";
import type { Task } from "../types";

vi.mock("../api/client", () => ({ apiFetch: vi.fn() }));

const CUSTOMER_TASK = {
  id: 42,
  project_id: null,
  customer_id: 7,
  customer_name: "Müller Haustechnik GmbH",
  title: "Rückruf wegen Angebot",
  status: "open",
  task_type: "office",
} as Task;

const PROJECT_TASK: Task = { id: 43, project_id: 12, title: "Zählerwechsel", status: "open", task_type: "construction" };

function renderModal(task: Task) {
  const openCustomer = vi.fn();
  const closeTaskEditModal = vi.fn();
  const context = makeAppContextStub({
    overrides: {
      taskEditModalOpen: true,
      canManageTasks: true,
      taskEditForm: buildTaskEditFormState(task),
      taskEditCustomerId: task.customer_id ?? null,
      taskEditMaterialRows: [],
      taskEditOverlapWarning: null,
      taskEditExpectedUpdatedAt: null,
      projects: [{ id: 12, project_number: "2026-0412", name: "Umbau", status: "active", customer_name: "Müller" }],
      menuUserNameById: () => "",
      assigneeAvailabilityHint: () => null,
      taskProjectTitleParts: () => ({ title: "2026-0412 · Müller", subtitle: "" }),
      // What App resolves: the loaded customer's name for a customer-only task.
      taskCustomerLabel: (ref: { project_id: number | null; customer_id?: number | null }) =>
        ref.project_id == null && ref.customer_id === 7 ? "Müller Haustechnik GmbH" : "",
      openCustomer,
      closeTaskEditModal,
    },
  });
  render(
    <AppContext.Provider value={context as never}>
      <TaskEditModal />
    </AppContext.Provider>,
  );
  return { openCustomer, closeTaskEditModal };
}

describe("TaskEditModal customer anchor", () => {
  it("names the customer in the eyebrow and opens the customer page from Zum Kunden", () => {
    const { openCustomer, closeTaskEditModal } = renderModal(CUSTOMER_TASK);
    expect(screen.getByText("Kunde: Müller Haustechnik GmbH")).toBeInTheDocument();
    expect(screen.queryByText("Allgemeine Aufgabe")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Zum Kunden" }));
    expect(closeTaskEditModal).toHaveBeenCalledTimes(1);
    expect(openCustomer).toHaveBeenCalledWith(7);
  });

  it("keeps the project eyebrow, and no customer link, for a project task", () => {
    renderModal(PROJECT_TASK);
    expect(screen.getByText("2026-0412 · Müller")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Zum Kunden" })).not.toBeInTheDocument();
  });
});
