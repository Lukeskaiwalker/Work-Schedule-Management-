/**
 * What the expanded row of Meine Aufgaben shows the person doing the task.
 *
 * The edit modal — where the office attaches a plan or a photo, and where the
 * box material is listed outright — is closed to anyone without tasks:manage.
 * So the row itself has to carry both: an "Anhänge" block with the task's
 * files, and the material list open at first sight rather than folded behind
 * a tap. A task without attachments gets no block at all, and a folded row
 * asks the server for nothing.
 *
 * This is also the state the construction overview card lands in: it sets the
 * expanded id and switches the view, and the row is rendered exactly as here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { MyTasksPage } from "../pages/MyTasksPage";
import { resetTaskAttachmentStripCache } from "../components/tasks/TaskAttachmentStrip";
import { apiFetch } from "../api/client";
import type { StoredFile, Task, TaskMaterial } from "../types";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  apiFetch: vi.fn(),
}));

const apiFetchMock = vi.mocked(apiFetch);

const FILES: StoredFile[] = [
  {
    id: 11,
    project_id: 1,
    task_id: 1,
    uploaded_by: 2,
    folder: "Aufgaben",
    file_name: "Plan.pdf",
    content_type: "application/pdf",
    created_at: "2026-09-18T10:12:00",
  },
  {
    id: 12,
    project_id: 1,
    task_id: 1,
    uploaded_by: 2,
    folder: "Aufgaben",
    file_name: "Zählerschrank.jpg",
    content_type: "image/jpeg",
    created_at: "2026-09-17T08:00:00",
  },
];

function task(id: number, overrides: Partial<Task> = {}): Task {
  return { id, project_id: 1, title: `Aufgabe ${id}`, status: "open", assignee_ids: [1], ...overrides };
}

function material(id: number, itemName: string): TaskMaterial {
  return {
    id,
    item_name: itemName,
    article_no: null,
    ean: null,
    unit: "m",
    quantity: 100,
    quantity_used: null,
    article_id: null,
    source_box_id: null,
    notes: null,
    settled_at: null,
  };
}

/** The page as a field worker sees it: assigned, without tasks:manage. */
function renderPage(rows: Task[], expandedMyTaskId: number | null) {
  const context = makeAppContextStub({
    overrides: {
      mainView: "my_tasks",
      todayIso: "2026-09-17",
      sortedTasks: rows,
      expandedMyTaskId,
      canManageTasks: false,
      isTaskAssignedToCurrentUser: (row: Task) => (row.assignee_ids ?? []).includes(1),
      getTaskAssigneeLabel: () => "Max",
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

beforeEach(() => {
  apiFetchMock.mockReset();
  resetTaskAttachmentStripCache();
});

describe("MyTasksPage — the expanded row", () => {
  it("shows the Anhänge block with the task's files, and no way to edit or remove", async () => {
    apiFetchMock.mockResolvedValue(FILES);
    renderPage([task(1, { title: "Zählerwechsel", attachment_count: 2 })], 1);
    expect(screen.getByText("Anhänge")).toBeInTheDocument();
    expect(screen.getByText("Plan oder Foto zu dieser Aufgabe")).toBeInTheDocument();
    expect(await screen.findByText("Plan.pdf")).toBeInTheDocument();
    expect(screen.getByText("Zählerschrank.jpg")).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith("/tasks/1/files", "test-token");
    expect(screen.queryByRole("button", { name: "Aufgabe bearbeiten" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Anhang entfernen/ })).not.toBeInTheDocument();
  });

  it("shows no Anhänge block — and asks nothing — for a task without attachments", () => {
    renderPage([task(1, { attachment_count: 0 })], 1);
    // The row IS expanded: its detail lines are there, the block is not.
    expect(screen.getByText(/Mitarbeiter: Max/)).toBeInTheDocument();
    expect(screen.queryByText("Anhänge")).not.toBeInTheDocument();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("loads nothing for a folded row, however many files it has", () => {
    renderPage([task(1, { attachment_count: 2 })], null);
    expect(screen.queryByText("Anhänge")).not.toBeInTheDocument();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("opens the material list at first sight under 'Material (n)', and keeps it foldable", () => {
    renderPage([task(1, { materials: [material(1, "NYM-J 3x1,5"), material(2, "Schuko-Dose")] })], 1);
    const toggle = screen.getByRole("button", { name: /Material \(2\)/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("NYM-J 3x1,5")).toBeInTheDocument();
    expect(screen.getByText("Schuko-Dose")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
