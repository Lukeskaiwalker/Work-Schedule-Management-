/**
 * The read-only "Anhänge" strip in the expanded row of Meine Aufgaben.
 *
 * What has to hold: a task without attachments costs nothing — no request,
 * no block; a task with some reads ITS files (GET /tasks/{id}/files) and
 * shows one tile per file, with no remove control for anybody; a tile opens
 * the viewer on that file with the task named under it and no delete; a
 * failed load says so and can try again; and a row folded and opened again
 * is served from memory — unless the task's count moved in the meantime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { TaskAttachmentStrip, resetTaskAttachmentStripCache } from "../components/tasks/TaskAttachmentStrip";
import { apiFetch } from "../api/client";
import type { StoredFile, Task } from "../types";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  apiFetch: vi.fn(),
}));

const apiFetchMock = vi.mocked(apiFetch);

const TASK: Task = { id: 42, project_id: 7, title: "Zählerwechsel", status: "open", attachment_count: 2 };
const FILES_PATH = "/tasks/42/files";
const TOKEN = "test-token";

const FILES: StoredFile[] = [
  {
    id: 11,
    project_id: 7,
    task_id: TASK.id,
    uploaded_by: 1,
    folder: "Aufgaben",
    file_name: "Plan.pdf",
    content_type: "application/pdf",
    created_at: "2026-09-18T10:12:00",
  },
  {
    id: 12,
    project_id: 7,
    task_id: TASK.id,
    uploaded_by: 2,
    folder: "Aufgaben",
    file_name: "Zählerschrank.jpg",
    content_type: "image/jpeg",
    created_at: "2026-09-17T08:00:00",
  },
];

function renderStrip(task: Task) {
  // The uploader of Plan.pdf, and a files manager: the strip must offer no
  // removal even to the people the modal would offer it to.
  const context = makeAppContextStub({ overrides: { user: { id: 1 }, canManageFiles: true } });
  return render(
    <AppContext.Provider value={context as never}>
      <TaskAttachmentStrip task={task} />
    </AppContext.Provider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  resetTaskAttachmentStripCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TaskAttachmentStrip", () => {
  it.each([
    ["a count of zero", 0],
    ["a task from before the count existed", undefined],
  ])("renders nothing and asks the server nothing for %s", (_label, attachmentCount) => {
    const { container } = renderStrip({ ...TASK, attachment_count: attachmentCount });
    expect(container).toBeEmptyDOMElement();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("reads the task's files and shows one tile per file, with no remove control", async () => {
    apiFetchMock.mockResolvedValue(FILES);
    renderStrip(TASK);
    expect(screen.getByText("Anhänge")).toBeInTheDocument();
    expect(screen.getByText("Plan oder Foto zu dieser Aufgabe")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Anhänge werden geladen…");
    expect(await screen.findByText("Plan.pdf")).toBeInTheDocument();
    expect(screen.getByText("Zählerschrank.jpg")).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith(FILES_PATH, TOKEN);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Anhang entfernen/ })).not.toBeInTheDocument();
  });

  it("opens the viewer on the clicked file, with the task named under it and no delete", async () => {
    apiFetchMock.mockResolvedValue(FILES);
    renderStrip(TASK);
    fireEvent.click(await screen.findByRole("button", { name: /Zählerschrank\.jpg/ }));
    const dialog = screen.getByRole("dialog", { name: "Zählerschrank.jpg" });
    // The sequence is the task's files, so the second tile is 2 of 2.
    expect(within(dialog).getByText("2 / 2")).toBeInTheDocument();
    expect(within(dialog).getByText("Aufgabe: Zählerwechsel")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Löschen" })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Schließen" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("names a failed load and can try again, instead of showing nothing", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(FILES);
    renderStrip(TASK);
    expect(await screen.findByRole("alert")).toHaveTextContent("Anhänge konnten nicht geladen werden.");
    expect(screen.getByText("Anhänge")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Erneut laden" }));
    expect(await screen.findByText("Plan.pdf")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it("serves a row opened again from memory, and reads afresh once the count moved", async () => {
    apiFetchMock.mockResolvedValue(FILES);
    const first = renderStrip(TASK);
    await screen.findByText("Plan.pdf");
    first.unmount();

    const second = renderStrip(TASK);
    // Synchronous: the tiles are there before any effect could have run.
    expect(screen.getByText("Plan.pdf")).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    second.unmount();

    renderStrip({ ...TASK, attachment_count: 3 });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
  });

  it("shows no block once the server answers with no files — a count that was stale", async () => {
    apiFetchMock.mockResolvedValue([]);
    const { container } = renderStrip(TASK);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
