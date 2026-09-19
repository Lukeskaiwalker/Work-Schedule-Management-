/**
 * The "Anhänge" section of the task modals.
 *
 * What has to hold: the tiles are the task's own files (GET /tasks/{id}/files,
 * nothing else); a tile opens the viewer on THAT file with the task named
 * under it; the remove control follows DELETE /files/{id}'s rule — the office
 * (files:manage) or the uploader, nobody else; adding goes multipart to the
 * task's endpoint and the list is re-read afterwards, never patched by hand;
 * a failed upload keeps the selection so a retry is one tap; a failed load
 * says so instead of showing an empty grid; and before the task exists the
 * same section only collects files and hands them to the parent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { TaskAttachments } from "../components/tasks/TaskAttachments";
import { buildTaskFilesFormData, uploadTaskAttachments } from "../components/tasks/taskAttachmentsApi";
import {
  attachmentsAddedNotice,
  canRemoveTaskAttachment,
  mergePickedFiles,
} from "../components/tasks/taskAttachmentsModel";
import { apiFetch, apiUploadWithProgress } from "../api/client";
import type { StoredFile } from "../types";

vi.mock("../api/client", () => ({ apiFetch: vi.fn(), apiUploadWithProgress: vi.fn() }));

const apiFetchMock = vi.mocked(apiFetch);
const uploadMock = vi.mocked(apiUploadWithProgress);

const TASK_ID = 42;
const FILES_PATH = "/tasks/42/files";
const TOKEN = "test-token";

const FILES: StoredFile[] = [
  {
    id: 11,
    project_id: 7,
    task_id: TASK_ID,
    uploaded_by: 1,
    folder: "Aufgaben",
    file_name: "Plan.pdf",
    content_type: "application/pdf",
    created_at: "2026-09-18T10:12:00",
  },
  {
    id: 12,
    project_id: 7,
    task_id: TASK_ID,
    uploaded_by: 2,
    folder: "Aufgaben",
    file_name: "Zählerschrank.jpg",
    content_type: "image/jpeg",
    created_at: "2026-09-17T08:00:00",
  },
];

/** The api as the section sees it: the task's list, and DELETE answering 204. */
function routeApi(rows: StoredFile[] = FILES) {
  apiFetchMock.mockImplementation(async (path, _token, options) => {
    if (path === FILES_PATH && !options?.method) return rows;
    if (options?.method === "DELETE") return {};
    throw new Error(`unexpected call: ${options?.method ?? "GET"} ${path}`);
  });
}

function listReads(): number {
  return apiFetchMock.mock.calls.filter(([path, , options]) => path === FILES_PATH && !options?.method).length;
}

type Spies = { setError: ReturnType<typeof vi.fn>; setNotice: ReturnType<typeof vi.fn> };

function renderStored(
  overrides: Record<string, unknown> = {},
  props: { canAdd?: boolean } = {},
): Spies {
  const spies: Spies = { setError: vi.fn(), setNotice: vi.fn() };
  const context = makeAppContextStub({
    overrides: { canManageFiles: false, ...spies, ...overrides },
  });
  render(
    <AppContext.Provider value={context as never}>
      <TaskAttachments taskId={TASK_ID} taskTitle="Zählerwechsel" canAdd={props.canAdd ?? true} />
    </AppContext.Provider>,
  );
  return spies;
}

function pick(files: File[]) {
  fireEvent.change(screen.getByLabelText("Dateien auswählen"), { target: { files } });
}

beforeEach(() => {
  apiFetchMock.mockReset();
  uploadMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TaskAttachments — an existing task", () => {
  it("reads the task's files and shows one tile per file", async () => {
    routeApi();
    renderStored();
    expect(screen.getByText("Anhänge werden geladen…")).toBeInTheDocument();
    expect(await screen.findByText("Plan.pdf")).toBeInTheDocument();
    expect(screen.getByText("Zählerschrank.jpg")).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith(FILES_PATH, TOKEN);
    expect(screen.queryByText("Anhänge werden geladen…")).not.toBeInTheDocument();
  });

  it("says so when there is nothing attached", async () => {
    routeApi([]);
    renderStored();
    expect(await screen.findByText("Noch keine Anhänge.")).toBeInTheDocument();
  });

  it("opens the viewer on the clicked file, with the task named under it", async () => {
    routeApi();
    renderStored();
    fireEvent.click(await screen.findByRole("button", { name: /Zählerschrank\.jpg/ }));
    const dialog = screen.getByRole("dialog", { name: "Zählerschrank.jpg" });
    // The sequence is the task's files, so the second tile is 2 of 2.
    expect(within(dialog).getByText("2 / 2")).toBeInTheDocument();
    expect(within(dialog).getByText("Aufgabe: Zählerwechsel")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Schließen" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("offers removal to the uploader of a file", async () => {
    routeApi();
    renderStored({ user: { id: 1 }, canManageFiles: false });
    await screen.findByText("Plan.pdf");
    expect(screen.getByRole("button", { name: "Anhang entfernen: Plan.pdf" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Anhang entfernen: Zählerschrank.jpg" })).not.toBeInTheDocument();
  });

  it("offers removal of every file to a files manager", async () => {
    routeApi();
    renderStored({ user: { id: 3 }, canManageFiles: true });
    await screen.findByText("Plan.pdf");
    expect(screen.getByRole("button", { name: "Anhang entfernen: Plan.pdf" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Anhang entfernen: Zählerschrank.jpg" })).toBeInTheDocument();
  });

  it("offers no removal to anybody else", async () => {
    routeApi();
    renderStored({ user: { id: 3 }, canManageFiles: false });
    await screen.findByText("Plan.pdf");
    expect(screen.queryByRole("button", { name: /Anhang entfernen/ })).not.toBeInTheDocument();
  });

  it("removes after a confirm: DELETE /files/{id}, then the list is re-read", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    routeApi();
    const { setNotice } = renderStored({ user: { id: 1 } });
    fireEvent.click(await screen.findByRole("button", { name: "Anhang entfernen: Plan.pdf" }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/files/11", TOKEN, { method: "DELETE" }));
    await waitFor(() => expect(listReads()).toBe(2));
    expect(setNotice).toHaveBeenCalledWith("Anhang entfernt");
  });

  it("deletes nothing when the confirm is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    routeApi();
    renderStored({ user: { id: 1 } });
    fireEvent.click(await screen.findByRole("button", { name: "Anhang entfernen: Plan.pdf" }));
    expect(apiFetchMock).not.toHaveBeenCalledWith("/files/11", TOKEN, { method: "DELETE" });
    expect(listReads()).toBe(1);
  });

  it("uploads a picked file multipart to the task's endpoint and re-reads the list", async () => {
    routeApi();
    uploadMock.mockResolvedValue([]);
    const { setNotice } = renderStored();
    await screen.findByText("Plan.pdf");
    pick([new File(["skizze"], "Skizze.png", { type: "image/png" })]);
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    const [path, token, body] = uploadMock.mock.calls[0];
    expect(path).toBe(FILES_PATH);
    expect(token).toBe(TOKEN);
    expect(body).toBeInstanceOf(FormData);
    expect(body.getAll("files").map((entry) => (entry as File).name)).toEqual(["Skizze.png"]);
    await waitFor(() => expect(listReads()).toBe(2));
    expect(setNotice).toHaveBeenCalledWith("Anhang hinzugefügt");
  });

  it("keeps a failed selection so the retry needs no second pick", async () => {
    routeApi();
    uploadMock.mockRejectedValueOnce(new Error("Datei zu groß")).mockResolvedValueOnce([]);
    const { setError } = renderStored();
    await screen.findByText("Plan.pdf");
    pick([new File(["foto"], "Foto.jpg", { type: "image/jpeg" })]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Datei zu groß");
    expect(setError).toHaveBeenCalledWith("Datei zu groß");
    // Still one read: a failed upload is not a change to the list.
    expect(listReads()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(2));
    expect(uploadMock.mock.calls[1][2].getAll("files").map((entry) => (entry as File).name)).toEqual(["Foto.jpg"]);
    await waitFor(() => expect(listReads()).toBe(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows no add controls to someone who may not edit the task", async () => {
    routeApi();
    renderStored({}, { canAdd: false });
    await screen.findByText("Plan.pdf");
    expect(screen.queryByRole("button", { name: /Datei hinzufügen/ })).not.toBeInTheDocument();
  });

  it("names a failed load and can try again, instead of showing an empty grid", async () => {
    routeApi();
    apiFetchMock.mockRejectedValueOnce(new Error("offline"));
    renderStored();
    expect(await screen.findByText("Anhänge konnten nicht geladen werden.")).toBeInTheDocument();
    expect(screen.queryByText("Noch keine Anhänge.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Erneut laden" }));
    expect(await screen.findByText("Plan.pdf")).toBeInTheDocument();
    expect(screen.queryByText("Anhänge konnten nicht geladen werden.")).not.toBeInTheDocument();
  });
});

describe("TaskAttachments — before the task exists", () => {
  function renderPending(files: File[], onChange: (next: File[]) => void, uploading = false) {
    const context = makeAppContextStub();
    return render(
      <AppContext.Provider value={context as never}>
        <TaskAttachments pendingFiles={files} onPendingFilesChange={onChange} uploading={uploading} />
      </AppContext.Provider>,
    );
  }

  it("collects picked files for the parent and calls no api", () => {
    const onChange = vi.fn();
    const file = new File(["foto"], "Foto.jpg", { type: "image/jpeg" });
    const view = renderPending([], onChange);
    expect(screen.getByText("Noch keine Anhänge.")).toBeInTheDocument();
    pick([file]);
    expect(onChange).toHaveBeenCalledWith([file]);

    view.rerender(
      <AppContext.Provider value={makeAppContextStub() as never}>
        <TaskAttachments pendingFiles={[file]} onPendingFilesChange={onChange} uploading={false} />
      </AppContext.Provider>,
    );
    expect(screen.getByText("Foto.jpg")).toBeInTheDocument();
    expect(screen.getByText("wird nach dem Anlegen hochgeladen")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Entfernen: Foto.jpg" }));
    expect(onChange).toHaveBeenLastCalledWith([]);

    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("blocks picking and removing while the created task is receiving the files", () => {
    const file = new File(["foto"], "Foto.jpg", { type: "image/jpeg" });
    renderPending([file], vi.fn(), true);
    expect(screen.getByRole("status")).toHaveTextContent("Anhänge werden hochgeladen…");
    expect(screen.getByRole("button", { name: /Datei hinzufügen/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Entfernen: Foto.jpg" })).toBeDisabled();
  });
});

describe("the rules behind the section", () => {
  it("lets the office and the uploader remove a task file, nobody else", () => {
    const file = { uploaded_by: 5 };
    expect(canRemoveTaskAttachment(file, { canManageFiles: true, userId: 9 })).toBe(true);
    expect(canRemoveTaskAttachment(file, { canManageFiles: false, userId: 5 })).toBe(true);
    expect(canRemoveTaskAttachment(file, { canManageFiles: false, userId: 9 })).toBe(false);
    expect(canRemoveTaskAttachment({ uploaded_by: null }, { canManageFiles: false, userId: null })).toBe(false);
  });

  it("counts one file picked twice once", () => {
    const a = new File(["a"], "a.jpg", { type: "image/jpeg", lastModified: 1 });
    const b = new File(["bb"], "b.jpg", { type: "image/jpeg", lastModified: 2 });
    expect(mergePickedFiles([a], [a, b])).toEqual([a, b]);
  });

  it("puts every file under `files`, the field the endpoint reads", () => {
    const form = buildTaskFilesFormData([new File(["1"], "eins.txt"), new File(["2"], "zwei.txt")]);
    expect(form.getAll("files").map((entry) => (entry as File).name)).toEqual(["eins.txt", "zwei.txt"]);
  });

  it("uploads to the task's own endpoint — what createWeeklyPlanTask calls after the POST", async () => {
    uploadMock.mockResolvedValue([]);
    await uploadTaskAttachments(7, TOKEN, [new File(["1"], "eins.txt")]);
    expect(uploadMock.mock.calls[0][0]).toBe("/tasks/7/files");
    expect(uploadMock.mock.calls[0][1]).toBe(TOKEN);
  });

  it("words the notice by count", () => {
    expect(attachmentsAddedNotice(1, "de")).toBe("Anhang hinzugefügt");
    expect(attachmentsAddedNotice(3, "de")).toBe("3 Anhänge hinzugefügt");
    expect(attachmentsAddedNotice(2, "en")).toBe("2 attachments added");
  });
});
