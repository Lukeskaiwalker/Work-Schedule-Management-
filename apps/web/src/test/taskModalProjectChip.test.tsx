/**
 * A copy of a task whose project is not in the loaded `projects` list (an
 * archived project, or one opened from a customer/partner page) carries the
 * project id — the POST will succeed — but the modal has no project object to
 * build its chip from. It renders the chip from the row's own label instead
 * of claiming "Noch kein Projekt ausgewählt." over a project that is set.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { TaskModal } from "../components/modals/TaskModal";
import { buildTaskModalFormState } from "../utils/reports";
import type { TaskModalState } from "../types";

function renderModal(form: TaskModalState) {
  const context = makeAppContextStub({
    overrides: {
      taskModalOpen: true,
      taskModalForm: form,
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
      customers: [],
      partners: [],
      canCreateProject: false,
      canManageTasks: true,
      projectSearchLabel: (project: { name: string }) => project.name,
      menuUserNameById: (_id: number, fallback?: string) => fallback ?? "",
      assigneeAvailabilityHint: () => "",
    },
  });
  render(
    <AppContext.Provider value={context as never}>
      <TaskModal />
    </AppContext.Provider>,
  );
}

describe("TaskModal project chip", () => {
  // The empty state names both anchors since the modal gained a customer picker.
  const NOTHING_PICKED = "Noch kein Projekt oder Kunde ausgewählt.";

  it("shows the copied task's project label when the project itself is not loaded", () => {
    renderModal(buildTaskModalFormState({ projectId: 123, projectQuery: "2024-0815 - Archiv GmbH" }));
    expect(screen.getByRole("button", { name: "2024-0815 - Archiv GmbH ×" })).toBeInTheDocument();
    expect(screen.queryByText(NOTHING_PICKED)).not.toBeInTheDocument();
  });

  it("still says so when there is genuinely no project", () => {
    renderModal(buildTaskModalFormState());
    expect(screen.getByText(NOTHING_PICKED)).toBeInTheDocument();
  });

  it("shows the customer chip for a copied customer-only task", () => {
    renderModal({ ...buildTaskModalFormState(), customer_id: 7 });
    // The chip is removable now, like the project chip.
    expect(screen.getByRole("button", { name: "Kunde: Kunde #7 ×" })).toBeInTheDocument();
    expect(screen.queryByText(NOTHING_PICKED)).not.toBeInTheDocument();
  });
});
