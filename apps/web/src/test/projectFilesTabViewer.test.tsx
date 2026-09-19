/**
 * The project files tab after the switch to the in-app viewer: a click on a
 * row or a tile opens the FileLightbox on that file, with the tab's rows as
 * the sequence and the folder as the caption — and the project-specific
 * parts, the upload modal and the drop target, still reach the app context.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { ProjectFilesTab } from "../pages/project/ProjectFilesTab";
import type { StoredFile } from "../types";

function file(id: number, file_name: string, folder: string, content_type = "image/jpeg"): StoredFile {
  return { id, project_id: 1, folder, file_name, content_type, created_at: "2026-09-17T10:00:00" };
}

const NOTIZ = file(1, "Notiz.txt", "", "text/plain");
const BERICHT = file(2, "Bericht.pdf", "Berichte", "application/pdf");
const ZAEHLER = file(3, "Zählerschrank.jpg", "Bilder");
const KABEL = file(4, "Kabelweg.jpg", "Bilder");
const ROWS: StoredFile[] = [KABEL, ZAEHLER, BERICHT, NOTIZ];

function renderTab(overrides: Record<string, unknown> = {}) {
  const spies = {
    setFileQuery: vi.fn(),
    setFileUploadModalOpen: vi.fn(),
    setFileUploadFolder: vi.fn(),
    requestFileUploadWithFiles: vi.fn(),
    deleteFile: vi.fn(async () => undefined),
    copyToClipboard: vi.fn(async () => undefined),
  };
  const context = makeAppContextStub({
    overrides: {
      mainView: "project",
      projectTab: "files",
      activeProject: { id: 1, project_number: "2026-0001", name: "Müller", status: "active" },
      files: ROWS,
      fileQuery: "",
      projectFolders: [
        { path: "Verwaltung", is_protected: true },
        { path: "Bilder", is_protected: false },
      ],
      fileUploadFolder: "",
      canManageFiles: true,
      canUseProtectedFolders: false,
      activeProjectDavUrl: "http://localhost/api/dav/projects/2026-0001/",
      ...spies,
      ...overrides,
    },
  });
  const view = render(
    <AppContext.Provider value={context as never}>
      <ProjectFilesTab />
    </AppContext.Provider>,
  );
  return { ...spies, ...view };
}

describe("ProjectFilesTab", () => {
  it("renders nothing while another tab is open", () => {
    const { container } = renderTab({ projectTab: "overview" });
    expect(container).toBeEmptyDOMElement();
  });

  it("opens the viewer on the clicked row, with the folder as its caption", () => {
    renderTab();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Bilder/ }));
    fireEvent.click(screen.getByRole("button", { name: "Zählerschrank.jpg" }));

    const dialog = screen.getByRole("dialog", { name: "Zählerschrank.jpg" });
    // Group order: Hauptordner, Berichte, then Bilder in API order.
    expect(within(dialog).getByText("4 / 4")).toBeInTheDocument();
    expect(within(dialog).getByText("Bilder")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Löschen" })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Schließen" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens the same viewer from a gallery tile, in gallery order", () => {
    renderTab();
    fireEvent.click(screen.getByRole("tab", { name: "Galerie" }));
    fireEvent.click(screen.getByRole("button", { name: /Notiz\.txt/ }));
    const dialog = screen.getByRole("dialog", { name: "Notiz.txt" });
    expect(within(dialog).getByText("4 / 4")).toBeInTheDocument();
    expect(within(dialog).getByText("Hauptordner")).toBeInTheDocument();
    window.localStorage.removeItem("smpl_project_files_view_mode");
  });

  it("hides the viewer's Löschen from someone who may not delete", () => {
    renderTab({ canManageFiles: false, query: "" });
    fireEvent.click(screen.getByRole("button", { name: /Berichte/ }));
    expect(screen.queryByRole("button", { name: "Löschen" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Bericht.pdf" }));
    const dialog = screen.getByRole("dialog", { name: "Bericht.pdf" });
    expect(within(dialog).queryByRole("button", { name: "Löschen" })).not.toBeInTheDocument();
  });

  it("asks before a row's Löschen reaches the context", () => {
    const { deleteFile } = renderTab();
    fireEvent.click(screen.getByRole("button", { name: /Berichte/ }));
    const row = screen.getByRole("button", { name: "Bericht.pdf" }).closest(".file-browser-row");
    if (!(row instanceof HTMLElement)) throw new Error("no row");
    fireEvent.click(within(row).getByRole("button", { name: "Löschen" }));
    expect(deleteFile).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByRole("button", { name: "Löschen" }));
    expect(deleteFile).toHaveBeenCalledWith(2);
  });

  it("opens the upload modal from ↑ with the first folder this user may use", () => {
    const { setFileUploadFolder, setFileUploadModalOpen } = renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Datei hochladen" }));
    expect(setFileUploadFolder).toHaveBeenCalledWith("Bilder");
    expect(setFileUploadModalOpen).toHaveBeenCalledWith(true);
  });

  it("queues dropped files for the upload modal", () => {
    const { container, requestFileUploadWithFiles } = renderTab();
    const card = container.querySelector(".file-browser");
    if (!card) throw new Error("no browser card");
    const dropped = new File(["x"], "Plan.pdf", { type: "application/pdf" });
    fireEvent.drop(card, { dataTransfer: { files: [dropped], types: ["Files"] } });
    expect(requestFileUploadWithFiles).toHaveBeenCalledWith([dropped]);
  });

  it("offers both WebDAV links and copies through the context", () => {
    const { copyToClipboard } = renderTab();
    const copyButtons = screen.getAllByRole("button", { name: "Kopieren" });
    expect(copyButtons).toHaveLength(2);
    fireEvent.click(copyButtons[1]);
    expect(copyToClipboard).toHaveBeenCalledWith(
      "http://localhost/api/dav/projects/2026-0001/",
      "project",
    );
  });
});
