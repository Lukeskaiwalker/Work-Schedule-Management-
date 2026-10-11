/**
 * The office side of the partner portal.
 *
 * PartnerPortalAccessSection (partner slide-over) — what must hold: the
 * section lists the partner's logins with their state; an invite needs name
 * and e-mail, posts them, and shows the minted link — as "send it yourself"
 * when the mail did not go out — with a copy button; "Sperren" locks a login
 * and the row says so; an archived partner gets no invite form.
 *
 * ProjectPartnersCard (project overview) — what must hold: it lists the
 * partners the project is handed to with the office's note and whether they
 * have portal access, and those who see it only through tasks (no note, no
 * "Entfernen", but "Hinweis hinzufügen" hands it over); "Zuweisen" offers
 * only partners not yet handed the project and saves the chosen one with its
 * note; "Entfernen" asks first, removes and re-reads; reported hours show per
 * partner on demand and can be removed; "Unterlagen hochladen" opens the
 * upload dialog on the project's "Partnerportal" folder; without project
 * rights the card is read-only and hidden when empty.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { PartnerPortalAccessSection } from "../components/partners/PartnerPortalAccessSection";
import { ProjectPartnersCard } from "../components/project/ProjectPartnersCard";
import { apiFetch } from "../api/client";
import {
  deletePartnerHours,
  invitePartnerPortalUser,
  listPartnerPortalUsers,
  listProjectPartnerHours,
  listProjectPartners,
  removeProjectPartner,
  saveProjectPartner,
  sendPartnerPortalLink,
  setPartnerPortalUserActive,
} from "../utils/partnersApi";
import type { PartnerHoursEntry, PartnerListItem, PartnerPortalUser, ProjectPartnerLink } from "../types";

vi.mock("../utils/partnersApi", () => ({
  listPartnerPortalUsers: vi.fn(),
  invitePartnerPortalUser: vi.fn(),
  sendPartnerPortalLink: vi.fn(),
  setPartnerPortalUserActive: vi.fn(),
  listProjectPartners: vi.fn(),
  saveProjectPartner: vi.fn(),
  removeProjectPartner: vi.fn(),
  listProjectPartnerHours: vi.fn(),
  deletePartnerHours: vi.fn(),
}));

vi.mock("../api/client", () => ({
  apiFetch: vi.fn(),
  apiUploadWithProgress: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

const PARTNER: PartnerListItem = {
  id: 3,
  name: "Bedachungen Hoffmann KG",
  contact_person: "Andreas Hoffmann",
  email: null,
  phone: null,
  address: null,
  trade: "Dachdecker",
  tax_id: null,
  notes: null,
  archived_at: null,
  created_by: 1,
  created_at: "2026-10-01T08:00:00",
  updated_at: "2026-10-01T08:00:00",
  task_count: 3,
  open_task_count: 2,
  last_task_activity_at: null,
  portal_user_count: 1,
};

function login(fields: Partial<PartnerPortalUser> = {}): PartnerPortalUser {
  return {
    id: 7,
    partner_id: 3,
    full_name: "Andreas Hoffmann",
    email: "a.hoffmann@hoffmann-dach.de",
    is_active: true,
    status: "active",
    invite_sent_at: "2026-10-01T08:00:00",
    invite_accepted_at: "2026-10-01T09:00:00",
    last_login_at: null,
    created_at: "2026-10-01T08:00:00",
    ...fields,
  };
}

function withContext(node: React.ReactNode, overrides: Record<string, unknown> = {}) {
  const value = makeAppContextStub({ overrides: { token: "tok", language: "de", canCreateProject: true, ...overrides } });
  return <AppContext.Provider value={value as never}>{node}</AppContext.Provider>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PartnerPortalAccessSection", () => {
  it("lists logins, invites a person and shows the link to hand over", async () => {
    vi.mocked(listPartnerPortalUsers).mockResolvedValue([login(), login({ id: 8, full_name: "Jonas Becker", email: "j.becker@hoffmann-dach.de", status: "invited", invite_accepted_at: null })]);
    vi.mocked(invitePartnerPortalUser).mockResolvedValue({
      user: login({ id: 9, full_name: "Mario Kunz", email: "m.kunz@hoffmann-dach.de", status: "invited", invite_accepted_at: null }),
      kind: "invite",
      invite_link: "https://smpl.example/partner/einladung?token=abc",
      expires_at: "2026-10-12T08:00:00",
      sent: false,
      email_error_type: "not_configured",
      email_error_detail: null,
    });
    render(withContext(<PartnerPortalAccessSection partner={PARTNER} />));

    expect(await screen.findByText("Andreas Hoffmann")).toBeInTheDocument();
    expect(screen.getByText("Eingeladen")).toBeInTheDocument();
    expect(screen.getByText("1 aktiv · 1 eingeladen")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Einladung senden" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Bitte Name und E-Mail angeben.");
    expect(invitePartnerPortalUser).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Mario Kunz" } });
    fireEvent.change(screen.getByLabelText("E-Mail"), { target: { value: "m.kunz@hoffmann-dach.de" } });
    fireEvent.click(screen.getByRole("button", { name: "Einladung senden" }));
    await waitFor(() => expect(invitePartnerPortalUser).toHaveBeenCalledWith("tok", 3, { full_name: "Mario Kunz", email: "m.kunz@hoffmann-dach.de" }));
    expect(await screen.findByText(/E-Mail konnte nicht gesendet werden/)).toBeInTheDocument();
    expect(screen.getByLabelText("Link")).toHaveValue("https://smpl.example/partner/einladung?token=abc");
    expect(screen.getByText("Mario Kunz")).toBeInTheDocument();
  });

  it("locks a login and offers a fresh link to active ones", async () => {
    vi.mocked(listPartnerPortalUsers).mockResolvedValue([login()]);
    vi.mocked(setPartnerPortalUserActive).mockResolvedValue(login({ is_active: false, status: "disabled" }));
    vi.mocked(sendPartnerPortalLink).mockResolvedValue({
      user: login(),
      kind: "password_reset",
      invite_link: "https://smpl.example/partner/passwort?token=xyz",
      expires_at: "2026-10-10T08:00:00",
      sent: true,
      email_error_type: null,
      email_error_detail: null,
    });
    render(withContext(<PartnerPortalAccessSection partner={PARTNER} />));
    fireEvent.click(await screen.findByRole("button", { name: "Passwort-Link" }));
    expect(await screen.findByText(/Passwort-Link an a.hoffmann@hoffmann-dach.de gesendet/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sperren" }));
    await waitFor(() => expect(setPartnerPortalUserActive).toHaveBeenCalledWith("tok", 3, 7, false));
    expect(await screen.findByText("Gesperrt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Entsperren" })).toBeInTheDocument();
  });

  it("has no invite form for an archived partner", async () => {
    vi.mocked(listPartnerPortalUsers).mockResolvedValue([]);
    render(withContext(<PartnerPortalAccessSection partner={{ ...PARTNER, archived_at: "2026-10-05T00:00:00" }} />));
    expect(await screen.findByText(/Partner ist archiviert/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Einladung senden" })).toBeNull();
  });
});

function link(fields: Partial<ProjectPartnerLink> = {}): ProjectPartnerLink {
  return {
    project_id: 11,
    partner_id: 3,
    partner: { id: 3, name: "Bedachungen Hoffmann KG", trade: "Dachdecker", archived_at: null },
    assigned: true,
    note: "Material über die Hofeinfahrt.",
    portal_user_count: 2,
    task_count: 3,
    hours_total: 0,
    created_at: "2026-10-01T08:00:00",
    updated_at: "2026-10-01T08:00:00",
    ...fields,
  };
}

describe("ProjectPartnersCard", () => {
  it("lists the partners, assigns another with a note and removes one", async () => {
    vi.mocked(listProjectPartners).mockResolvedValue([link()]);
    vi.mocked(saveProjectPartner).mockResolvedValue(
      link({ partner_id: 4, partner: { id: 4, name: "Wagner Sanitär e.K.", trade: "Sanitär", archived_at: null }, note: "Bad im OG", portal_user_count: 0, task_count: 0 }),
    );
    vi.mocked(removeProjectPartner).mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const partners = [PARTNER, { ...PARTNER, id: 4, name: "Wagner Sanitär e.K.", trade: "Sanitär" }];
    render(withContext(<ProjectPartnersCard projectId={11} />, { partners }));

    expect(await screen.findByText("Material über die Hofeinfahrt.")).toBeInTheDocument();
    expect(screen.getByText("Dachdecker · 3 Aufgaben · 2 Portal-Zugänge")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "+ Zuweisen" }));
    const select = screen.getByLabelText("Partner") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["Partner wählen…", "Wagner Sanitär e.K. (Sanitär)"]);
    fireEvent.change(select, { target: { value: "4" } });
    const noteFields = screen.getAllByLabelText("Hinweis für den Partner");
    fireEvent.change(noteFields[noteFields.length - 1], { target: { value: "Bad im OG" } });
    fireEvent.click(screen.getByRole("button", { name: "Zuweisen" }));
    await waitFor(() => expect(saveProjectPartner).toHaveBeenCalledWith("tok", 11, 4, "Bad im OG"));
    expect(await screen.findByText("Sanitär · 0 Aufgaben · noch kein Portal-Zugang")).toBeInTheDocument();

    // After removing, the card re-reads: the server's list no longer has Hoffmann.
    vi.mocked(listProjectPartners).mockResolvedValue([
      link({ partner_id: 4, partner: { id: 4, name: "Wagner Sanitär e.K.", trade: "Sanitär", archived_at: null }, note: "Bad im OG", portal_user_count: 0, task_count: 0 }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Bedachungen Hoffmann KG entfernen" }));
    await waitFor(() => expect(removeProjectPartner).toHaveBeenCalledWith("tok", 11, 3));
    await waitFor(() => expect(screen.queryByText("Material über die Hofeinfahrt.")).toBeNull());
    expect(screen.getByText("Bad im OG")).toBeInTheDocument();
  });

  it("lists a partner who sees the project only through tasks, and hands it over with a note", async () => {
    vi.mocked(listProjectPartners).mockResolvedValue([
      link({ assigned: false, note: null, task_count: 1, hours_total: 15, created_at: null, updated_at: null }),
    ]);
    vi.mocked(saveProjectPartner).mockResolvedValue(link({ note: "Gerüst steht ab Montag", task_count: 1, hours_total: 15 }));
    render(withContext(<ProjectPartnersCard projectId={11} />));

    expect(await screen.findByText("Dachdecker · über 1 Aufgabe · 2 Portal-Zugänge · 15 Std gemeldet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Bedachungen Hoffmann KG entfernen" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hinweis hinzufügen" }));
    fireEvent.change(screen.getByLabelText("Hinweis für den Partner"), { target: { value: "Gerüst steht ab Montag" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(saveProjectPartner).toHaveBeenCalledWith("tok", 11, 3, "Gerüst steht ab Montag"));
    expect(await screen.findByText("Gerüst steht ab Montag")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bedachungen Hoffmann KG entfernen" })).toBeInTheDocument();
  });

  it("shows a partner's reported hours on demand and removes one", async () => {
    const entry: PartnerHoursEntry = {
      id: 301,
      partner: { id: 3, name: "Bedachungen Hoffmann KG", trade: "Dachdecker", archived_at: null },
      project_id: 11,
      task: { id: 21, title: "Dachrinne und Fallrohre erneuern" },
      work_date: "2026-10-08",
      workers: 2,
      hours: 7.5,
      total_hours: 15,
      note: "Rinne gesetzt",
      reported_by: "Andreas Hoffmann",
      created_at: "2026-10-08T16:00:00",
    };
    vi.mocked(listProjectPartners).mockResolvedValue([link({ hours_total: 15 })]);
    vi.mocked(listProjectPartnerHours).mockResolvedValue([entry]);
    vi.mocked(deletePartnerHours).mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(withContext(<ProjectPartnersCard projectId={11} />));

    fireEvent.click(await screen.findByRole("button", { name: "Stunden ansehen" }));
    expect(await screen.findByText("2 × 7,5 Std = 15 Std")).toBeInTheDocument();
    expect(screen.getByText("Dachrinne und Fallrohre erneuern")).toBeInTheDocument();
    expect(screen.getByText("gemeldet von Andreas Hoffmann")).toBeInTheDocument();

    vi.mocked(listProjectPartnerHours).mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: "Stunden vom 08.10.2026 entfernen" }));
    await waitFor(() => expect(deletePartnerHours).toHaveBeenCalledWith("tok", 301));
    await waitFor(() => expect(screen.queryByText("2 × 7,5 Std = 15 Std")).toBeNull());
  });

  it("opens the upload dialog on the project's Partnerportal folder", async () => {
    vi.mocked(listProjectPartners).mockResolvedValue([link()]);
    vi.mocked(apiFetch).mockResolvedValue({ path: "Partnerportal", is_protected: false, portal_shared: true });
    const loadProjectFolders = vi.fn(async () => undefined);
    const setFileUploadFolder = vi.fn();
    const setProjectTab = vi.fn();
    const setFileUploadModalOpen = vi.fn();
    render(withContext(<ProjectPartnersCard projectId={11} />, { loadProjectFolders, setFileUploadFolder, setProjectTab, setFileUploadModalOpen }));

    fireEvent.click(await screen.findByRole("button", { name: "Unterlagen hochladen" }));
    await waitFor(() => expect(setFileUploadModalOpen).toHaveBeenCalledWith(true));
    expect(apiFetch).toHaveBeenCalledWith("/projects/11/folders", "tok", {
      method: "POST",
      body: JSON.stringify({ path: "Partnerportal" }),
    });
    expect(loadProjectFolders).toHaveBeenCalledWith(11);
    expect(setFileUploadFolder).toHaveBeenCalledWith("Partnerportal");
    expect(setProjectTab).toHaveBeenCalledWith("files");
  });

  it("is read-only without project rights and hidden when empty", async () => {
    vi.mocked(listProjectPartners).mockResolvedValue([link()]);
    const { unmount } = render(withContext(<ProjectPartnersCard projectId={11} />, { canCreateProject: false }));
    expect(await screen.findByText("Material über die Hofeinfahrt.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ Zuweisen" })).toBeNull();
    expect(screen.queryByRole("button", { name: /entfernen/ })).toBeNull();
    unmount();

    vi.mocked(listProjectPartners).mockResolvedValue([]);
    const { container } = render(withContext(<ProjectPartnersCard projectId={11} />, { canCreateProject: false }));
    await waitFor(() => expect(listProjectPartners).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(container).queryByText("Partner")).toBeNull());
  });
});
