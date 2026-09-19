/**
 * The "Projektbericht" card of the project overview. What must hold: the
 * card says what the report is and offers the preview; the preview opens
 * the file viewer on the live rendering — a frame whose src is the report's
 * own preview endpoint, not a file's; a finalized report shows its date
 * with open and download controls on the stored attachment; the finalize
 * control exists for managers only, POSTs after confirmation and reloads
 * the overview.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { ProjectReportCard } from "../components/project/ProjectReportCard";
import { apiFetch } from "../api/client";
import { formatServerDateTime } from "../utils/dates";
import type { ProjectReportState } from "../types";

vi.mock("../api/client", () => ({ apiFetch: vi.fn() }));

const apiFetchMock = vi.mocked(apiFetch);

const PROJECT_ID = 42;
const TOKEN = "test-token";
const LEAD =
  "Wird laufend aus Stammdaten, Aufgaben, internen Notizen und Baustellenberichten zusammengestellt und beim Abschluss oder Archivieren des Projekts als PDF in Berichte abgelegt.";

const NOT_FINALIZED: ProjectReportState = { finalized_at: null, attachment_id: null, file_name: null };
const FINALIZED: ProjectReportState = {
  finalized_at: "2026-09-19T14:05:00",
  attachment_id: 77,
  file_name: "Projektbericht_2026-3001_2026-09-19.pdf",
};

function renderCard(state: ProjectReportState, overrides: Record<string, unknown> = {}) {
  const spies = {
    loadProjectOverview: vi.fn(async () => undefined),
    setNotice: vi.fn(),
    setError: vi.fn(),
  };
  const context = makeAppContextStub({
    overrides: {
      activeProjectId: PROJECT_ID,
      activeProject: { id: PROJECT_ID, project_number: "2026-3001", name: "Zählerschrank" },
      projectOverviewDetails: { project_report: state },
      canCreateProject: false,
      ...spies,
      ...overrides,
    },
  });
  render(
    <AppContext.Provider value={context as never}>
      <ProjectReportCard />
    </AppContext.Provider>,
  );
  return spies;
}

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue(undefined as never);
  vi.restoreAllMocks();
  Object.defineProperty(navigator, "pdfViewerEnabled", { value: true, configurable: true });
});

describe("ProjectReportCard", () => {
  it("says what the report is and offers the preview", () => {
    renderCard(NOT_FINALIZED);
    expect(screen.getByRole("heading", { name: "Projektbericht" })).toBeInTheDocument();
    expect(screen.getByText(LEAD)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Vorschau anzeigen" })).toBeInTheDocument();
    expect(screen.queryByText(/Abschlussbericht vom/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Jetzt finalisieren" })).not.toBeInTheDocument();
  });

  it("opens the live rendering in the viewer, framed from the report's own endpoint", () => {
    renderCard(NOT_FINALIZED);
    fireEvent.click(screen.getByRole("button", { name: "Vorschau anzeigen" }));

    const name = "Projektbericht 2026-3001 (Vorschau).pdf";
    const dialog = screen.getByRole("dialog", { name });
    expect(within(dialog).getByText("Vorschau – Stand jetzt")).toBeInTheDocument();
    const frame = within(dialog).getByTitle(name);
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("src")).toMatch(/\/api\/projects\/42\/report\/preview$/);
    expect(within(dialog).getByRole("link", { name: "Herunterladen" }).getAttribute("href")).toMatch(
      /\/api\/projects\/42\/report\/preview\?download=1$/,
    );
    // No attachment is involved, so nothing is fetched by id.
    expect(apiFetchMock).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Schließen" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows a finalized report with its date, and opens and downloads the stored file", () => {
    renderCard(FINALIZED);
    const line = screen.getByText(/Abschlussbericht vom/);
    expect(line).toHaveTextContent(formatServerDateTime(FINALIZED.finalized_at, "de"));
    expect(screen.getByRole("link", { name: "Herunterladen" }).getAttribute("href")).toMatch(/\/api\/files\/77\/download$/);
    expect(screen.getByRole("link", { name: "Herunterladen" })).toHaveAttribute("download", FINALIZED.file_name);

    fireEvent.click(screen.getByRole("button", { name: "Öffnen" }));
    const dialog = screen.getByRole("dialog", { name: FINALIZED.file_name ?? "" });
    expect(within(dialog).getByTitle(FINALIZED.file_name ?? "").getAttribute("src")).toMatch(/\/api\/files\/77\/preview$/);
  });

  it("does not call a date a report when the file behind it is gone", () => {
    renderCard({ ...FINALIZED, attachment_id: null, file_name: null });
    expect(screen.queryByText(/Abschlussbericht vom/)).not.toBeInTheDocument();
  });

  it("lets a manager finalize after confirmation, then reloads the overview", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { loadProjectOverview, setNotice } = renderCard(NOT_FINALIZED, { canCreateProject: true });

    const button = screen.getByRole("button", { name: "Jetzt finalisieren" });
    fireEvent.click(button);
    expect(confirmSpy).toHaveBeenCalledWith("Projektbericht jetzt als PDF in Berichte ablegen?");
    expect(apiFetchMock).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(button);
    await waitFor(() => expect(loadProjectOverview).toHaveBeenCalledWith(PROJECT_ID));
    expect(apiFetchMock).toHaveBeenCalledWith(`/projects/${PROJECT_ID}/report/finalize`, TOKEN, { method: "POST" });
    expect(setNotice).toHaveBeenCalledWith("Projektbericht abgelegt");
  });

  it("offers a manager a fresh copy once one is filed, and reports a failure", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    apiFetchMock.mockRejectedValueOnce(new Error("Project access denied"));
    const { loadProjectOverview, setError } = renderCard(FINALIZED, { canCreateProject: true });

    fireEvent.click(screen.getByRole("button", { name: "Neu erstellen" }));
    await waitFor(() => expect(setError).toHaveBeenCalledWith("Project access denied"));
    expect(loadProjectOverview).not.toHaveBeenCalled();
  });
});
