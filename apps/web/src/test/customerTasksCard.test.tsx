/**
 * The customer page's task list.
 *
 * What must hold: a task is created the way it is everywhere else — "+
 * Aufgabe" opens the full task modal with this customer already set, there
 * is no separate title-only quick-add; a row opens the task in the edit
 * modal and its checkbox still completes it; the list re-reads whenever a
 * task changes anywhere (taskRevision), so a task saved in the modal shows
 * up without a reload.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { CustomerTasksCard } from "../components/customers/CustomerTasksCard";
import { apiFetch } from "../api/client";
import type { Task } from "../types";

vi.mock("../api/client", () => ({
  apiFetch: vi.fn(),
  apiUploadWithProgress: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

const apiFetchMock = vi.mocked(apiFetch);
const LIST_PATH = "/tasks?view=all_open&customer_id=7";

function task(id: number, title: string, fields: Partial<Task> = {}): Task {
  return {
    id,
    title,
    status: "open",
    customer_id: 7,
    project_id: null,
    due_date: "2026-10-13",
    ...fields,
  } as Task;
}

function card(overrides: Record<string, unknown> = {}) {
  const context = makeAppContextStub({
    overrides: {
      token: "tok",
      language: "de",
      taskRevision: 0,
      setError: vi.fn(),
      setNotice: vi.fn(),
      ...overrides,
    },
  });
  return (
    <AppContext.Provider value={context as never}>
      <CustomerTasksCard customerId={7} />
    </AppContext.Provider>
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe("CustomerTasksCard", () => {
  it("opens the full task modal with this customer set, instead of a quick-add field", async () => {
    apiFetchMock.mockResolvedValue([]);
    const openTaskModal = vi.fn();
    render(card({ openTaskModal }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith(LIST_PATH, "tok"));
    expect(screen.queryByPlaceholderText(/Neue Aufgabe/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "+ Aufgabe" }));
    expect(openTaskModal).toHaveBeenCalledWith({ customerId: 7 });
  });

  it("opens a task in the edit modal and still completes it from the checkbox", async () => {
    const snow = task(5, "Schneefanggitter montieren");
    apiFetchMock.mockImplementation((async (path: string) => {
      if (path === LIST_PATH) return [snow];
      if (path === "/tasks/5") return { ...snow, status: "done" };
      throw new Error(`unexpected apiFetch: ${path}`);
    }) as typeof apiFetch);
    const openTaskEditModal = vi.fn();
    render(card({ openTaskEditModal }));

    fireEvent.click(await screen.findByRole("button", { name: /Schneefanggitter montieren/ }));
    expect(openTaskEditModal).toHaveBeenCalledWith(snow);

    fireEvent.click(screen.getByRole("checkbox", { name: "Erledigt" }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/tasks/5", "tok", expect.objectContaining({ method: "PATCH" })),
    );
    await waitFor(() => expect(screen.queryByText("Schneefanggitter montieren")).toBeNull());
  });

  it("re-reads the list when a task changes anywhere", async () => {
    apiFetchMock.mockResolvedValueOnce([]).mockResolvedValueOnce([task(9, "Rückruf wegen Angebot")]);
    const { rerender } = render(card({ taskRevision: 0 }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    rerender(card({ taskRevision: 1 }));
    expect(await screen.findByText("Rückruf wegen Angebot")).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });
});
