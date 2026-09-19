/**
 * The "Dateien" card of the customer page. What must hold: it loads the
 * customer's folders, files and projects for the id it was given; the
 * project folders come first and open lazily, exactly once; a click opens
 * the viewer; an upload is a multipart POST with the folder and refreshes
 * the list; and a 403 is shown in the API's words, never as an empty card.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { CustomerFilesCard } from "../components/customers/CustomerFilesCard";
import { apiFetch, apiUploadWithProgress } from "../api/client";
import type { ProjectFolder, StoredFile } from "../types";

vi.mock("../api/client", () => ({ apiFetch: vi.fn(), apiUploadWithProgress: vi.fn() }));

const apiFetchMock = vi.mocked(apiFetch);
const uploadMock = vi.mocked(apiUploadWithProgress);

const CUSTOMER_ID = 7;
const TOKEN = "test-token";

function file(
  id: number,
  file_name: string,
  folder: string,
  content_type: string,
  scope: Pick<StoredFile, "project_id" | "customer_id">,
): StoredFile {
  return { id, file_name, folder, content_type, created_at: "2026-09-17T10:00:00", ...scope };
}

const ANGEBOT = file(11, "Angebot.pdf", "Dokumente", "application/pdf", { project_id: null, customer_id: 7 });
const VERTRAG = file(12, "Vertrag.pdf", "Verwaltung", "application/pdf", { project_id: null, customer_id: 7 });
const CUSTOMER_FILES = [VERTRAG, ANGEBOT];
const FOLDERS: ProjectFolder[] = [
  { path: "Dokumente", is_protected: false },
  { path: "Verwaltung", is_protected: true },
];
const PROJECTS = [
  { id: 1, project_number: "2026-0001", name: "Müller", status: "active", last_state: null, last_updated_at: null, customer_id: 7 },
  { id: 2, project_number: "2026-0002", name: "Müller Garage", status: "planning", last_state: null, last_updated_at: null, customer_id: 7 },
];
const PROJECT_FILES = [
  file(21, "Zählerschrank.jpg", "Bilder", "image/jpeg", { project_id: 1, customer_id: null }),
  file(22, "Plan.pdf", "Anträge", "application/pdf", { project_id: 1, customer_id: null }),
];

type Routes = Record<string, () => unknown>;

const DEFAULT_ROUTES: Routes = {
  "/customers/7/files": () => CUSTOMER_FILES,
  "/customers/7/folders": () => FOLDERS,
  "/customers/7/projects": () => PROJECTS,
  "/projects/1/files": () => PROJECT_FILES,
};

function routeApi(routes: Routes) {
  apiFetchMock.mockImplementation((async (path: string) => {
    const route = routes[path];
    if (!route) throw new Error(`unexpected apiFetch: ${path}`);
    return route();
  }) as typeof apiFetch);
}

function callsTo(path: string): number {
  return apiFetchMock.mock.calls.filter(([calledPath]) => calledPath === path).length;
}

function renderCard(overrides: Record<string, unknown> = {}) {
  const spies = {
    openProjectById: vi.fn(),
    setProjectTab: vi.fn(),
    setNotice: vi.fn(),
    setError: vi.fn(),
  };
  const context = makeAppContextStub({
    overrides: { canManageFiles: true, canUseProtectedFolders: true, ...spies, ...overrides },
  });
  const view = render(
    <AppContext.Provider value={context as never}>
      <CustomerFilesCard customerId={CUSTOMER_ID} />
    </AppContext.Provider>,
  );
  return { ...spies, ...view };
}

function folderNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".file-browser-folder")).map(
    (folder) => folder.querySelector(".file-folder-name")?.textContent ?? "",
  );
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByRole("button", { name }).closest(".file-browser-row");
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${name}`);
  return row;
}

beforeEach(() => {
  apiFetchMock.mockReset();
  uploadMock.mockReset();
  routeApi(DEFAULT_ROUTES);
  window.localStorage.removeItem("smpl_customer_files_view_mode");
  window.localStorage.removeItem("smpl_customer_files_gallery_size");
});

describe("CustomerFilesCard", () => {
  it("loads folders, files and projects for its customer, project folders first", async () => {
    const { container } = renderCard();
    expect(screen.getByRole("status")).toHaveTextContent("Dateien werden geladen…");

    await screen.findByText("📁 2026-0001 – Müller");
    expect(apiFetchMock).toHaveBeenCalledWith("/customers/7/files", TOKEN);
    expect(apiFetchMock).toHaveBeenCalledWith("/customers/7/folders", TOKEN);
    expect(apiFetchMock).toHaveBeenCalledWith("/customers/7/projects", TOKEN);

    expect(folderNames(container)).toEqual([
      "📁 2026-0001 – Müller",
      "📁 2026-0002 – Müller Garage",
      "📁 Dokumente",
      "📁 Verwaltung",
    ]);
    expect(screen.getByText("Projektordner")).toBeInTheDocument();
    expect(screen.getByText("Kundenordner")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("Dateien (2)");
    // Nothing of a project is fetched before its folder is opened.
    expect(callsTo("/projects/1/files")).toBe(0);
  });

  it("opens a project folder lazily and fetches its files once", async () => {
    renderCard();
    const project = await screen.findByRole("button", { name: /2026-0001 – Müller/ });
    fireEvent.click(project);
    await screen.findByText("📁 Bilder");
    expect(callsTo("/projects/1/files")).toBe(1);
    expect(project).toHaveTextContent("2 Dateien");

    fireEvent.click(project);
    expect(screen.queryByText("📁 Bilder")).not.toBeInTheDocument();
    fireEvent.click(project);
    expect(await screen.findByText("📁 Bilder")).toBeInTheDocument();
    expect(callsTo("/projects/1/files")).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: /📁 Bilder/ }));
    expect(screen.getByRole("button", { name: "Zählerschrank.jpg" })).toBeInTheDocument();
  });

  it("reports a project folder that failed to load, with a retry", async () => {
    let failures = 1;
    routeApi({
      ...DEFAULT_ROUTES,
      "/projects/1/files": () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("Kein Zugriff auf dieses Projekt");
        }
        return PROJECT_FILES;
      },
    });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /2026-0001 – Müller/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Kein Zugriff auf dieses Projekt");
    fireEvent.click(within(alert).getByRole("button", { name: "Erneut versuchen" }));
    expect(await screen.findByText("📁 Bilder")).toBeInTheDocument();
  });

  it("opens the viewer on a clicked customer file, with Löschen for a manager", async () => {
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /📁 Dokumente/ }));
    fireEvent.click(screen.getByRole("button", { name: "Angebot.pdf" }));
    const dialog = screen.getByRole("dialog", { name: "Angebot.pdf" });
    expect(within(dialog).getByText("Dokumente")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Löschen" })).toBeInTheDocument();
  });

  it("opens a project's file read-only, captioned with the project", async () => {
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /2026-0001 – Müller/ }));
    fireEvent.click(await screen.findByRole("button", { name: /📁 Anträge/ }));
    // The project rows have no delete control at all on this card.
    expect(screen.queryByRole("button", { name: "Löschen" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Plan.pdf" }));
    const dialog = screen.getByRole("dialog", { name: "Plan.pdf" });
    expect(within(dialog).getByText("2026-0001 · Anträge")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Löschen" })).not.toBeInTheDocument();
  });

  it("leads to the project's files tab from a project folder", async () => {
    const { openProjectById, setProjectTab } = renderCard();
    await screen.findByText("📁 2026-0001 – Müller");
    fireEvent.click(screen.getAllByRole("button", { name: "Im Projekt öffnen" })[0]);
    expect(openProjectById).toHaveBeenCalledWith(1, "customer_detail");
    expect(setProjectTab).toHaveBeenCalledWith("files");
  });

  it("uploads as multipart into the chosen folder and reloads the list", async () => {
    uploadMock.mockImplementation((async (_path, _token, _body, onProgress) => {
      onProgress?.({ loaded: 3, total: 3, percent: 100 });
      return [];
    }) as typeof apiUploadWithProgress);
    const { setNotice } = renderCard();
    await screen.findByText("📁 Dokumente");

    fireEvent.click(screen.getByRole("button", { name: "Datei hochladen" }));
    const dialog = screen.getByRole("dialog", { name: "Dateien hochladen" });
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "Dokumente" } });
    const picked = new File(["abc"], "Vollmacht.pdf", { type: "application/pdf" });
    fireEvent.change(within(dialog).getByLabelText("Dateien auswählen"), {
      target: { files: [picked] },
    });
    expect(within(dialog).getByText("Vollmacht.pdf")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Hochladen" }));

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    const [path, token, body] = uploadMock.mock.calls[0];
    expect(path).toBe("/customers/7/files");
    expect(token).toBe(TOKEN);
    expect(body.getAll("files")).toEqual([picked]);
    expect(body.get("folder")).toBe("Dokumente");

    await waitFor(() => expect(callsTo("/customers/7/files")).toBe(2));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(setNotice).toHaveBeenCalledWith("Dateien hochgeladen");
  });

  it("keeps the dialog open with the API's message when the upload fails", async () => {
    uploadMock.mockRejectedValue(new Error("Datei zu groß"));
    renderCard();
    await screen.findByText("📁 Dokumente");
    fireEvent.click(screen.getByRole("button", { name: "Datei hochladen" }));
    const dialog = screen.getByRole("dialog", { name: "Dateien hochladen" });
    fireEvent.change(within(dialog).getByLabelText("Dateien auswählen"), {
      target: { files: [new File(["abc"], "Groß.pdf", { type: "application/pdf" })] },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Hochladen" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Datei zu groß");
    expect(within(dialog).getByText("Groß.pdf")).toBeInTheDocument();
  });

  it("creates a folder from the dialog and selects it", async () => {
    let folders = FOLDERS;
    routeApi({
      ...DEFAULT_ROUTES,
      "/customers/7/folders": () => folders,
    });
    renderCard();
    await screen.findByText("📁 Dokumente");
    fireEvent.click(screen.getByRole("button", { name: "Datei hochladen" }));
    const dialog = screen.getByRole("dialog", { name: "Dateien hochladen" });

    apiFetchMock.mockImplementationOnce((async () => {
      folders = [...FOLDERS, { path: "Angebote", is_protected: false }];
      return { path: "Angebote", is_protected: false };
    }) as typeof apiFetch);
    fireEvent.change(within(dialog).getByPlaceholderText(/Neuer Ordnerpfad/), {
      target: { value: "Angebote" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Ordner anlegen" }));

    await waitFor(() => expect(within(dialog).getByRole("combobox")).toHaveValue("Angebote"));
    expect(apiFetchMock).toHaveBeenCalledWith("/customers/7/folders", TOKEN, {
      method: "POST",
      body: JSON.stringify({ path: "Angebote" }),
    });
  });

  it("asks before a row's Löschen, then DELETEs and drops the row", async () => {
    routeApi({ ...DEFAULT_ROUTES, "/files/11": () => ({}) });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /📁 Dokumente/ }));
    const row = rowOf("Angebot.pdf");
    fireEvent.click(within(row).getByRole("button", { name: "Löschen" }));
    expect(callsTo("/files/11")).toBe(0);
    fireEvent.click(within(row).getByRole("button", { name: "Löschen" }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/files/11", TOKEN, { method: "DELETE" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Angebot.pdf" })).not.toBeInTheDocument(),
    );
  });

  it("shows the API's 403 text instead of an empty card, and can retry", async () => {
    let denied = true;
    routeApi({
      ...DEFAULT_ROUTES,
      "/customers/7/files": () => {
        if (denied) throw new Error("Kein Zugriff auf die Dateien dieses Kunden");
        return CUSTOMER_FILES;
      },
    });
    renderCard();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Dateien konnten nicht geladen werden.");
    expect(alert).toHaveTextContent("Kein Zugriff auf die Dateien dieses Kunden");
    // No count that was never loaded.
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent(/^Dateien$/);

    denied = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Erneut versuchen" }));
    expect(await screen.findByText("📁 Dokumente")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("Dateien (2)");
  });

  it("says where files belong when the customer has none", async () => {
    routeApi({ ...DEFAULT_ROUTES, "/customers/7/files": () => [] });
    renderCard();
    expect(
      await screen.findByText(
        "Noch keine Dateien — was für alle Projekte dieses Kunden gilt, gehört hierher.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("Dateien (0)");
  });

  it("hides delete and drop-upload from someone without files:manage", async () => {
    renderCard({ canManageFiles: false });
    fireEvent.click(await screen.findByRole("button", { name: /📁 Dokumente/ }));
    expect(screen.queryByRole("button", { name: "Löschen" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Datei hochladen" })).toBeInTheDocument();
  });
});
