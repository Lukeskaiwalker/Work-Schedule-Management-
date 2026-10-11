/**
 * The partner portal app.
 *
 * What must hold: /partner without a session is the partner login; a
 * partner login lands on the task list grouped by day, an office login typed
 * there is handed to the office app; the invite link sets a password and
 * signs straight in; a session whose partner was archived sees "Zugang
 * gesperrt"; a job opens on tap and "Als erledigt melden" posts once with
 * the typed message and shows the done banner; photos chosen on the job go
 * to the upload endpoint; signing out returns to the login.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiError } from "../api/client";
import { PortalApp } from "./PortalApp";
import * as api from "./portalApi";
import type { PortalMe, PortalTask, PortalTaskDetail } from "./portalTypes";

vi.mock("./portalApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./portalApi")>();
  return {
    ...actual,
    portalLogin: vi.fn(),
    portalLoginMfa: vi.fn(),
    portalLogout: vi.fn(async () => undefined),
    acceptPortalInvite: vi.fn(),
    confirmPortalPasswordReset: vi.fn(),
    getPortalMe: vi.fn(),
    listPortalTasks: vi.fn(),
    getPortalTask: vi.fn(),
    completePortalTask: vi.fn(),
    uploadPortalFiles: vi.fn(),
    listPortalProjects: vi.fn(),
    getPortalProject: vi.fn(),
    changePortalPassword: vi.fn(),
  };
});

vi.mock("../utils/imageCompression", () => ({ compressReportImage: vi.fn(async (file: File) => file) }));

const mocked = vi.mocked(api);

const ME: PortalMe = {
  user: { id: 7, full_name: "Andreas Hoffmann", email: "a.hoffmann@hoffmann-dach.de" },
  partner: { id: 3, name: "Bedachungen Hoffmann KG", trade: "Dachdecker" },
  company: { name: "SMPL", logo_url: "", phone: "02302 91 44 0", email: "" },
};

function iso(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function task(id: number, fields: Partial<PortalTask> = {}): PortalTask {
  return {
    id,
    title: `Aufgabe ${id}`,
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
    ...fields,
  };
}

function detail(fields: Partial<PortalTaskDetail> = {}): PortalTaskDetail {
  return {
    ...task(21, { title: "Dachrinne und Fallrohre erneuern", due_date: iso(0), start_time: "07:30:00", estimated_hours: 6 }),
    description: "Alte Zinkrinne entfernen.",
    subtasks: ["Altrinne demontieren"],
    materials: null,
    site_access_type: "key_pickup",
    site_access_note: "Nachbar Haus Nr. 7",
    project_note: "Bauleitung: Herr Kaiser",
    team: ["Kai Monteur"],
    files: [],
    documents: [],
    hours: [],
    hours_total: 0,
    can_complete: true,
    ...fields,
  };
}

const replaceSpy = vi.fn();

// jsdom's location cannot be navigated, so the app reads a stub: the path
// and query the test names, plus a spy for the hand-over to the office app.
const realLocation = window.location;

function setPath(path: string) {
  window.history.pushState({}, "", path);
  const url = new URL(path, "https://smpl.example");
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...realLocation, replace: replaceSpy, pathname: url.pathname, search: url.search },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setPath("/partner");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ company_name: "SMPL", logo_url: "" }), { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
});

describe("PortalApp", () => {
  it("signs a partner in and shows their jobs grouped by day", async () => {
    mocked.portalLogin.mockResolvedValue({ kind: "session", token: "tok", role: "external" });
    mocked.getPortalMe.mockResolvedValue(ME);
    mocked.listPortalTasks.mockResolvedValue([
      task(1, { title: "Ortgang verkleiden", due_date: iso(-2), is_overdue: true }),
      task(2, { title: "Dachrinne erneuern", due_date: iso(0), start_time: "07:30:00", estimated_hours: 6 }),
      task(3, { title: "Aufmaß Gaube" }),
    ]);
    render(<PortalApp />);

    fireEvent.change(screen.getByLabelText("E-Mail"), { target: { value: "a.hoffmann@hoffmann-dach.de" } });
    fireEvent.change(screen.getByLabelText("Passwort"), { target: { value: "Dachrinne2026!" } });
    fireEvent.click(screen.getByRole("button", { name: "Anmelden" }));

    expect(await screen.findByRole("heading", { name: "Aufgaben" })).toBeInTheDocument();
    expect(mocked.portalLogin).toHaveBeenCalledWith("a.hoffmann@hoffmann-dach.de", "Dachrinne2026!");
    expect(localStorage.getItem("smpl_token")).toBe("tok");
    expect(await screen.findByText("Ortgang verkleiden")).toBeInTheDocument();
    const overdue = screen.getByRole("region", { name: "Überfällig" });
    expect(within(overdue).getByText("Ortgang verkleiden")).toBeInTheDocument();
    const today = screen.getByRole("region", { name: "Heute" });
    expect(within(today).getByText("07:30")).toBeInTheDocument();
    expect(within(today).getByText("6 Std.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Ohne Termin" })).toBeInTheDocument();
    expect(screen.getByText(/3 offen · heute 1 Einsatz/)).toBeInTheDocument();
  });

  it("hands an office login typed on the partner page to the office app", async () => {
    mocked.portalLogin.mockResolvedValue({ kind: "session", token: "office-tok", role: "employee" });
    render(<PortalApp />);
    fireEvent.change(screen.getByLabelText("E-Mail"), { target: { value: "kai@example.com" } });
    fireEvent.change(screen.getByLabelText("Passwort"), { target: { value: "Password123!" } });
    fireEvent.click(screen.getByRole("button", { name: "Anmelden" }));
    await waitFor(() => expect(replaceSpy).toHaveBeenCalledWith("/"));
    expect(mocked.getPortalMe).not.toHaveBeenCalled();
  });

  it("shows a wrong password plainly", async () => {
    mocked.portalLogin.mockRejectedValue(new ApiError("Invalid credentials", 401));
    render(<PortalApp />);
    fireEvent.change(screen.getByLabelText("E-Mail"), { target: { value: "x@example.com" } });
    fireEvent.change(screen.getByLabelText("Passwort"), { target: { value: "falsch" } });
    fireEvent.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("E-Mail oder Passwort stimmen nicht.");
  });

  it("sets the password from the invite link and signs straight in", async () => {
    setPath("/partner/einladung?token=abc");
    mocked.acceptPortalInvite.mockResolvedValue({ email: "a.hoffmann@hoffmann-dach.de" });
    mocked.portalLogin.mockResolvedValue({ kind: "session", token: "tok", role: "external" });
    mocked.getPortalMe.mockResolvedValue(ME);
    mocked.listPortalTasks.mockResolvedValue([]);
    render(<PortalApp />);

    fireEvent.change(screen.getByLabelText(/^Neues Passwort/), { target: { value: "Dachrinne2026!" } });
    fireEvent.change(screen.getByLabelText("Passwort wiederholen"), { target: { value: "anders123" } });
    fireEvent.click(screen.getByRole("button", { name: "Passwort speichern" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("stimmen nicht überein");
    expect(mocked.acceptPortalInvite).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Passwort wiederholen"), { target: { value: "Dachrinne2026!" } });
    fireEvent.click(screen.getByRole("button", { name: "Passwort speichern" }));
    expect(await screen.findByText("Keine offenen Aufgaben")).toBeInTheDocument();
    expect(mocked.acceptPortalInvite).toHaveBeenCalledWith("abc", "Dachrinne2026!");
    expect(mocked.portalLogin).toHaveBeenCalledWith("a.hoffmann@hoffmann-dach.de", "Dachrinne2026!");
  });

  it("tells a partner whose access was closed, and lets them sign out", async () => {
    localStorage.setItem("smpl_token", "tok");
    mocked.getPortalMe.mockRejectedValue(new ApiError("Partner access is closed", 403));
    render(<PortalApp />);
    expect(await screen.findByRole("heading", { name: "Zugang gesperrt" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Abmelden/ }));
    expect(await screen.findByRole("heading", { name: "Anmelden" })).toBeInTheDocument();
    expect(localStorage.getItem("smpl_token")).toBeNull();
  });

  it("goes back to the job list from a job opened by link, without leaving the portal", async () => {
    setPath("/partner/aufgaben/21");
    localStorage.setItem("smpl_token", "tok");
    mocked.getPortalMe.mockResolvedValue(ME);
    mocked.getPortalTask.mockResolvedValue(detail());
    mocked.listPortalTasks.mockResolvedValue([task(21, { title: "Dachrinne und Fallrohre erneuern" })]);
    const back = vi.spyOn(window.history, "back");
    render(<PortalApp />);
    expect(await screen.findByText("Bauleitung: Herr Kaiser")).toBeInTheDocument();
    fireEvent.click(document.querySelector(".pp-back") as HTMLElement);
    expect(await screen.findByRole("heading", { name: "Aufgaben" })).toBeInTheDocument();
    expect(back).not.toHaveBeenCalled();
    back.mockRestore();
  });

  it("opens a job, reports it done once with the message, and uploads photos", async () => {
    localStorage.setItem("smpl_token", "tok");
    mocked.getPortalMe.mockResolvedValue(ME);
    mocked.listPortalTasks.mockResolvedValue([task(21, { title: "Dachrinne und Fallrohre erneuern", due_date: iso(0) })]);
    mocked.getPortalTask.mockResolvedValue(detail());
    mocked.completePortalTask.mockResolvedValue(detail({ status: "done", can_complete: false }));
    mocked.uploadPortalFiles.mockResolvedValue([]);
    render(<PortalApp />);

    fireEvent.click(await screen.findByText("Dachrinne und Fallrohre erneuern"));
    expect(await screen.findByText("Bauleitung: Herr Kaiser")).toBeInTheDocument();
    expect(screen.getByText("Schlüssel abholen bei: Nachbar Haus Nr. 7")).toBeInTheDocument();
    expect(screen.getByText("Vor Ort von SMPL: Kai Monteur")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Route/ })).toHaveAttribute("href", expect.stringContaining("Lindenstr.%205"));
    expect(screen.getByRole("link", { name: "SMPL anrufen" })).toHaveAttribute("href", "tel:0230291440");

    const photo = new File([new Uint8Array([0xff, 0xd8, 0xff])], "rinne.jpg", { type: "image/jpeg" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [photo] } });
    await waitFor(() => expect(mocked.uploadPortalFiles).toHaveBeenCalledWith("tok", 21, [photo]));
    expect(await screen.findByText("Foto hochgeladen.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Als erledigt melden/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Rückmeldung/), { target: { value: "Ein Fallrohr fehlt noch." } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Erledigt melden/ }));
    expect(await screen.findByText("Erledigt gemeldet – danke!")).toBeInTheDocument();
    expect(mocked.completePortalTask).toHaveBeenCalledTimes(1);
    expect(mocked.completePortalTask).toHaveBeenCalledWith("tok", 21, "Ein Fallrohr fehlt noch.");
    expect(screen.queryByRole("button", { name: /Als erledigt melden/ })).toBeNull();
  });
});
