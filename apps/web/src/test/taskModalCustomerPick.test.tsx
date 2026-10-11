/**
 * "+ Aufgabe" can anchor a task to a customer instead of a project.
 *
 * A customer-only task ("Rückruf wegen Angebot" — there is no project yet)
 * could be created only by copying an existing one: the modal had a project
 * search and nothing else. It now has a customer search over the loaded
 * customers, with the project search's UX; picking one sets customer_id and
 * clears the project, and the POST carries customer_id and no project_id.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { TaskModal } from "../components/modals/TaskModal";
import { buildTaskModalFormState } from "../utils/reports";
import { buildTaskAnchorPayload } from "../utils/tasks";
import type { TaskModalState } from "../types";

const CUSTOMERS = [
  { id: 7, name: "Müller Haustechnik GmbH", address: "Hauptstr. 1, 12345 Berlin", phone: null, email: null, contact_person: null },
  { id: 8, name: "Schmidt Elektro", address: null, phone: null, email: null, contact_person: null },
];

function renderModal(form: TaskModalState, extra: Record<string, unknown> = {}) {
  // The stub's setter is a no-op; this one applies the updater so the test
  // can read the form the modal asked for.
  let nextForm: TaskModalState = form;
  const setTaskModalForm = vi.fn((update: TaskModalState | ((current: TaskModalState) => TaskModalState)) => {
    nextForm = typeof update === "function" ? update(nextForm) : update;
  });
  const context = makeAppContextStub({
    overrides: {
      taskModalOpen: true,
      taskModalForm: form,
      setTaskModalForm,
      taskModalMaterialRows: [],
      taskModalProjectSuggestions: [],
      taskModalProjectClassTemplates: [],
      taskModalSelectableBoxes: [],
      taskModalAssigneeSuggestions: [],
      taskModalBoxesLoading: false,
      taskModalCustomerId: null,
      taskModalOverlapWarning: null,
      selectedTaskModalProject: null,
      assignableUsers: [],
      projects: [],
      customers: CUSTOMERS,
      partners: [],
      canCreateProject: true,
      canManageTasks: true,
      projectSearchLabel: (project: { name: string }) => project.name,
      menuUserNameById: (_id: number, fallback?: string) => fallback ?? "",
      assigneeAvailabilityHint: () => "",
      ...extra,
    },
  });
  render(
    <AppContext.Provider value={context as never}>
      <TaskModal />
    </AppContext.Provider>,
  );
  return { form: () => nextForm, setTaskModalForm };
}

describe("TaskModal customer pick", () => {
  it("offers matching customers while typing and anchors the task to the picked one", () => {
    const { form } = renderModal(buildTaskModalFormState());
    fireEvent.change(screen.getByLabelText("Kunde suchen"), { target: { value: "Müll" } });
    fireEvent.click(screen.getByRole("button", { name: /Müller Haustechnik GmbH/ }));
    expect(form().customer_id).toBe(7);
    expect(form().project_id).toBe("");
    expect(form().create_project_from_task).toBe(false);
  });

  it("picks the first match on Enter, like the project search", () => {
    const { form } = renderModal(buildTaskModalFormState());
    const input = screen.getByLabelText("Kunde suchen");
    fireEvent.change(input, { target: { value: "Schmidt" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(form().customer_id).toBe(8);
  });

  it("shows the picked customer as a removable chip and hides the create-a-project toggle", () => {
    const { form } = renderModal({ ...buildTaskModalFormState(), customer_id: 7 });
    expect(screen.getByText("Kunde: Müller Haustechnik GmbH")).toBeInTheDocument();
    expect(screen.queryByText(/neues Projekt aus dieser Aufgabe/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Kunde: Müller Haustechnik GmbH ×" }));
    expect(form().customer_id).toBeNull();
  });

  it("hides the customer search once a project is set — the project decides the customer", () => {
    renderModal(buildTaskModalFormState({ projectId: 12, projectQuery: "2026-0412 · Müller" }));
    expect(screen.queryByLabelText("Kunde suchen")).not.toBeInTheDocument();
  });
});

describe("buildTaskAnchorPayload", () => {
  it("sends customer_id and a null project_id for a customer-only task", () => {
    expect(buildTaskAnchorPayload({ customer_id: 7 }, 0)).toEqual({ project_id: null, customer_id: 7 });
  });

  it("sends the project alone, without a customer_id key, for a project task", () => {
    const payload = buildTaskAnchorPayload({ customer_id: 7 }, 12);
    expect(payload).toEqual({ project_id: 12 });
    expect("customer_id" in payload).toBe(false);
  });

  it("sends neither when nothing is picked, so the caller can refuse", () => {
    expect(buildTaskAnchorPayload({ customer_id: null }, 0)).toEqual({ project_id: null });
  });
});

describe("TaskModal opened from a customer's page", () => {
  const PROJECTS = [
    { id: 31, project_number: "2026-0031", name: "Müller Wallbox", status: "in_durchfuehrung", customer_id: 7 },
    { id: 32, project_number: "2025-0102", name: "Müller Altbau", status: "archived", customer_id: 7 },
    { id: 33, project_number: "2026-0040", name: "Schmidt Neubau", status: "in_durchfuehrung", customer_id: 8 },
  ];

  it("starts anchored to that customer — a project given as well wins", () => {
    expect(buildTaskModalFormState({ customerId: 7 }).customer_id).toBe(7);
    expect(buildTaskModalFormState({ customerId: 7 }).project_id).toBe("");
    expect(buildTaskModalFormState({ customerId: 7, projectId: 31 }).customer_id).toBeNull();
  });

  it("shows the customer and offers only their open projects as one-tap alternatives", () => {
    const selectTaskModalProject = vi.fn();
    renderModal(buildTaskModalFormState({ customerId: 7 }), { projects: PROJECTS, selectTaskModalProject });
    expect(screen.getByRole("button", { name: "Kunde: Müller Haustechnik GmbH ×" })).toBeInTheDocument();
    const offer = screen.getByRole("group", { name: "Projekte dieses Kunden" });
    expect(offer).toHaveTextContent("Müller Wallbox");
    expect(offer).not.toHaveTextContent("Müller Altbau");
    expect(offer).not.toHaveTextContent("Schmidt Neubau");
    fireEvent.click(screen.getByRole("button", { name: "Müller Wallbox" }));
    expect(selectTaskModalProject).toHaveBeenCalledWith(PROJECTS[0]);
  });

  it("offers nothing extra when the customer has no open project", () => {
    renderModal(buildTaskModalFormState({ customerId: 8 }), { projects: PROJECTS.slice(0, 2) });
    expect(screen.queryByRole("group", { name: "Projekte dieses Kunden" })).toBeNull();
  });
});
