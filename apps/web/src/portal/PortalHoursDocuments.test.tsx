/**
 * Plans and hours on the partner's job and project pages.
 *
 * What must hold: the project's shared files are listed by subfolder and
 * open through the portal's document route; the hours list shows the crew
 * and the total; "Stunden melden" sends exactly what the sheet shows (date,
 * people, hours each, note) for the task, or for the project with an
 * optional task; a report the server would refuse is stopped in the sheet;
 * only entries the server marks deletable offer the bin, and removing one
 * asks first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiError } from "../api/client";
import { PortalProjectPage } from "./PortalProjectPage";
import { PortalTaskPage } from "./PortalTaskPage";
import * as api from "./portalApi";
import { localTodayIso } from "./portalDates";
import type { PortalHoursEntry, PortalMe, PortalProjectDetail, PortalTaskDetail } from "./portalTypes";

vi.mock("./portalApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./portalApi")>();
  return {
    ...actual,
    getPortalTask: vi.fn(),
    getPortalProject: vi.fn(),
    reportPortalHours: vi.fn(),
    deletePortalHours: vi.fn(),
    completePortalTask: vi.fn(),
    uploadPortalFiles: vi.fn(),
  };
});

vi.mock("../utils/imageCompression", () => ({ compressReportImage: vi.fn(async (file: File) => file) }));

const mocked = vi.mocked(api);

const ME: PortalMe = {
  user: { id: 7, full_name: "Andreas Hoffmann", email: "a.hoffmann@hoffmann-dach.de" },
  partner: { id: 3, name: "Bedachungen Hoffmann KG", trade: "Dachdecker" },
  company: { name: "SMPL", logo_url: "", phone: "", email: "" },
};

function hours(id: number, fields: Partial<PortalHoursEntry> = {}): PortalHoursEntry {
  return {
    id,
    work_date: "2026-10-08",
    workers: 2,
    hours: 7.5,
    total_hours: 15,
    note: "Rinne gesetzt",
    task: { id: 21, title: "Dachrinne und Fallrohre erneuern" },
    reported_by: "Andreas Hoffmann",
    created_at: "2026-10-08T16:00:00",
    can_delete: true,
    ...fields,
  };
}

function taskDetail(fields: Partial<PortalTaskDetail> = {}): PortalTaskDetail {
  return {
    id: 21,
    title: "Dachrinne und Fallrohre erneuern",
    status: "open",
    due_date: null,
    end_date: null,
    start_time: null,
    estimated_hours: null,
    is_overdue: false,
    project: { id: 11, number: "2024-008", name: "Neubau EFH König" },
    customer_name: null,
    address: "Lindenstr. 5, 58452 Witten",
    attachment_count: 0,
    description: null,
    subtasks: [],
    materials: null,
    site_access_type: null,
    site_access_note: null,
    project_note: null,
    team: [],
    files: [],
    documents: [
      { id: 91, file_name: "Dachplan.pdf", content_type: "application/pdf", folder: "", created_at: "2026-10-07T09:00:00" },
      { id: 92, file_name: "Schnitt A-A.pdf", content_type: "application/pdf", folder: "Pläne", created_at: "2026-10-07T09:00:00" },
    ],
    hours: [hours(301), hours(302, { workers: 1, hours: 4, total_hours: 4, note: null, can_delete: false })],
    hours_total: 19,
    can_complete: true,
    ...fields,
  };
}

function projectDetail(fields: Partial<PortalProjectDetail> = {}): PortalProjectDetail {
  return {
    id: 11,
    number: "2024-008",
    name: "Neubau EFH König",
    address: "Lindenstr. 5, 58452 Witten",
    phase: "running",
    open_task_count: 1,
    overdue_task_count: 0,
    next_task: null,
    site_access_type: null,
    site_access_note: null,
    partner_note: null,
    tasks: [
      {
        id: 21,
        title: "Dachrinne und Fallrohre erneuern",
        status: "open",
        due_date: null,
        end_date: null,
        start_time: null,
        estimated_hours: null,
        is_overdue: false,
        project: { id: 11, number: "2024-008", name: "Neubau EFH König" },
        customer_name: null,
        address: null,
        attachment_count: 0,
      },
    ],
    documents: [],
    hours: [hours(303, { task: null, note: "Gerüst gestellt" })],
    hours_total: 15,
    ...fields,
  };
}

function renderTask() {
  return render(
    <PortalTaskPage token="tok" me={ME} taskId={21} onBack={vi.fn()} onNavigate={vi.fn()} onOpenProject={vi.fn()} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("plans on the job", () => {
  it("lists the project's shared files by subfolder and opens them through the portal", async () => {
    mocked.getPortalTask.mockResolvedValue(taskDetail());
    renderTask();
    const section = await screen.findByRole("region", { name: "Pläne und Unterlagen" });
    expect(within(section).getByText("2 Dateien")).toBeInTheDocument();
    expect(within(section).getByRole("link", { name: "Dachplan.pdf öffnen" })).toHaveAttribute("href", "/api/portal/documents/91");
    expect(within(section).getByText("Pläne")).toBeInTheDocument();
    expect(within(section).getByRole("link", { name: "Schnitt A-A.pdf öffnen" })).toHaveAttribute("target", "_blank");
  });

  it("shows no plans section when the office shared nothing", async () => {
    mocked.getPortalTask.mockResolvedValue(taskDetail({ documents: [] }));
    renderTask();
    await screen.findByRole("region", { name: "Arbeitsstunden" });
    expect(screen.queryByRole("region", { name: "Pläne und Unterlagen" })).toBeNull();
  });
});

describe("hours on the job", () => {
  it("lists the crew's entries with the total and offers the bin only where allowed", async () => {
    mocked.getPortalTask.mockResolvedValue(taskDetail());
    renderTask();
    const section = await screen.findByRole("region", { name: "Arbeitsstunden" });
    expect(within(section).getByText("19 Std gemeldet")).toBeInTheDocument();
    expect(within(section).getByText("2 × 7,5 Std = 15 Std")).toBeInTheDocument();
    expect(within(section).getByText("Rinne gesetzt")).toBeInTheDocument();
    expect(within(section).getAllByRole("button", { name: /löschen/ })).toHaveLength(1);
  });

  it("reports what the sheet shows, for this job", async () => {
    mocked.getPortalTask.mockResolvedValue(taskDetail({ hours: [], hours_total: 0 }));
    mocked.reportPortalHours.mockResolvedValue(hours(304));
    renderTask();
    fireEvent.click(await screen.findByRole("button", { name: /Stunden melden/ }));
    const sheet = await screen.findByRole("dialog", { name: "Stunden melden" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Personen mehr" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "8" }));
    expect(within(sheet).getByText("Zusammen 16 Std")).toBeInTheDocument();
    fireEvent.change(within(sheet).getByLabelText(/Was wurde gemacht/), { target: { value: "Fallrohre montiert" } });
    fireEvent.click(within(sheet).getByRole("button", { name: /Stunden melden/ }));

    await waitFor(() => expect(mocked.reportPortalHours).toHaveBeenCalledTimes(1));
    expect(mocked.reportPortalHours).toHaveBeenCalledWith("tok", {
      task_id: 21,
      work_date: localTodayIso(),
      workers: 2,
      hours: 8,
      note: "Fallrohre montiert",
    });
    expect(await screen.findByText("Stunden gemeldet – danke!")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocked.getPortalTask).toHaveBeenCalledTimes(2); // reloaded after the report
  });

  it("stops a report without hours in the sheet and shows the server's refusal", async () => {
    mocked.getPortalTask.mockResolvedValue(taskDetail({ hours: [], hours_total: 0 }));
    mocked.reportPortalHours.mockRejectedValue(new ApiError("The work date lies in the future", 400));
    renderTask();
    fireEvent.click(await screen.findByRole("button", { name: /Stunden melden/ }));
    const sheet = await screen.findByRole("dialog", { name: "Stunden melden" });
    fireEvent.click(within(sheet).getByRole("button", { name: /Stunden melden/ }));
    expect(within(sheet).getByRole("alert")).toHaveTextContent(/Viertelstunden/);
    expect(mocked.reportPortalHours).not.toHaveBeenCalled();

    fireEvent.change(within(sheet).getByLabelText("Stunden je Person"), { target: { value: "6,5" } });
    fireEvent.click(within(sheet).getByRole("button", { name: /Stunden melden/ }));
    expect(await within(sheet).findByText("Das Datum liegt in der Zukunft.")).toBeInTheDocument();
  });

  it("asks before removing an entry and reloads afterwards", async () => {
    mocked.getPortalTask.mockResolvedValue(taskDetail());
    mocked.deletePortalHours.mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderTask();
    const bin = await screen.findByRole("button", { name: /löschen/ });
    fireEvent.click(bin);
    expect(mocked.deletePortalHours).not.toHaveBeenCalled();
    fireEvent.click(bin);
    await waitFor(() => expect(mocked.deletePortalHours).toHaveBeenCalledWith("tok", 301));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("Eintrag gelöscht.")).toBeInTheDocument();
  });
});

describe("hours on the project", () => {
  it("names the job of each entry and reports for the project with an optional job", async () => {
    mocked.getPortalProject.mockResolvedValue(projectDetail());
    mocked.reportPortalHours.mockResolvedValue(hours(305));
    render(<PortalProjectPage token="tok" me={ME} projectId={11} onBack={vi.fn()} onNavigate={vi.fn()} onOpenTask={vi.fn()} />);
    const section = await screen.findByRole("region", { name: "Arbeitsstunden" });
    expect(within(section).getByText("Ohne bestimmte Aufgabe")).toBeInTheDocument();
    fireEvent.click(within(section).getByRole("button", { name: /Stunden melden/ }));
    const sheet = await screen.findByRole("dialog", { name: "Stunden melden" });
    fireEvent.click(within(sheet).getByRole("button", { name: "4" }));
    fireEvent.change(within(sheet).getByLabelText(/Aufgabe/), { target: { value: "21" } });
    fireEvent.click(within(sheet).getByRole("button", { name: /Stunden melden/ }));
    await waitFor(() =>
      expect(mocked.reportPortalHours).toHaveBeenCalledWith("tok", {
        project_id: 11,
        task_id: 21,
        work_date: localTodayIso(),
        workers: 1,
        hours: 4,
        note: null,
      }),
    );
  });
});
