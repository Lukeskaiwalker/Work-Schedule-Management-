/**
 * The „Planung & Projekte“ widgets of the start page: Mein Einsatz, Meine
 * Projekte, Kritische Projekte and Wer fehlt heute (docs/DASHBOARD.md §1,
 * §1.1, §4.3, §8.5).
 *
 * Mein Einsatz is personal (D21, owner answer Q2): built from the context's
 * tasks, so an admin — whose context can hold other people's tasks — still
 * sees only their own, done work is left out and a multi-day job shows on
 * every day it covers. Its toggle exists only from „Mittel“ and starts on
 * „Woche“ at „Groß“. Wer fehlt heute comes from the minimised server route
 * and shows its generic labels, with EN twins by type.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";

import { AppContext, type AppContextValue } from "../context/AppContext";
import { PLANNING_WIDGET_LOADERS } from "../components/dashboard/widgets/planning";
import AbsentTodayWidget from "../components/dashboard/widgets/planning/AbsentTodayWidget";
import CriticalProjectsWidget from "../components/dashboard/widgets/planning/CriticalProjectsWidget";
import MyProjectsWidget from "../components/dashboard/widgets/planning/MyProjectsWidget";
import PlanningTodayWidget from "../components/dashboard/widgets/planning/PlanningTodayWidget";
import type { AbsentToday } from "../types/dashboard";
import type { MainView, Project, Task } from "../types";
import { endDashboardSession } from "../utils/dashboardSession";
import { makeAppContextStub } from "./appContextStub";

const ME = 7;
const TODAY = "2026-10-21"; // a Wednesday; the week is 19–25 Oct
const CONSTRUCTION_NAV: MainView[] = ["overview", "my_tasks", "planning", "construction", "projects_all", "werkstatt", "messages", "time"];
const OFFICE_NAV: MainView[] = ["overview", "office_tasks", "projects_all", "customers", "planning", "werkstatt", "messages", "time"];

let requests: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function serve(handler: (url: string) => Response | Promise<Response>): void {
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return handler(String(input));
    }),
  );
}

function task(id: number, overrides: Partial<Task> = {}): Task {
  return { id, project_id: 1, title: `Einsatz ${id}`, status: "open", assignee_ids: [ME], due_date: TODAY, ...overrides };
}

function project(id: number, overrides: Partial<Project> = {}): Project {
  return { id, project_number: `P-${id}`, name: `Projekt ${id}`, status: "active", ...overrides };
}

function renderWidget(element: ReactElement, overrides: Record<string, unknown> = {}) {
  const spies = {
    setMainView: vi.fn(),
    setExpandedMyTaskId: vi.fn(),
    openTaskEditModal: vi.fn(),
    openProjectById: vi.fn(),
  };
  const context = makeAppContextStub({
    overrides: {
      user: { id: ME, email: "mara@example.com", role: "employee", display_name: "Mara Beispiel" },
      token: "test-token",
      todayIso: TODAY,
      now: new Date("2026-10-21T09:00:00"),
      workspaceMode: "construction",
      navViews: CONSTRUCTION_NAV,
      taskProjectTitleParts: () => ({ title: "P-1 · Beispielbau", subtitle: "" }),
      projectTitleParts: (row: Project | null | undefined) => ({ title: row ? `${row.project_number} · ${row.name}` : "", subtitle: "Musterstraße 1" }),
      ...spies,
      ...overrides,
    },
  }) as AppContextValue;
  const view = render(<AppContext.Provider value={context}>{element}</AppContext.Provider>);
  return { ...view, spies };
}

function region(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

function rowTitles(card: HTMLElement): string[] {
  return within(card)
    .getAllByRole("listitem")
    .map((item) => item.querySelector(".dw-plan-row__title")?.textContent ?? "");
}

afterEach(() => {
  // Unmount first: a widget still mounted when the session ends re-creates
  // its user's store on the re-render that follows, and that store (with a
  // request still pending) would leak into the next test.
  cleanup();
  endDashboardSession();
});

describe("PLANNING_WIDGET_LOADERS", () => {
  it("has one lazy loader for each of the four planning widgets", async () => {
    expect(Object.keys(PLANNING_WIDGET_LOADERS).sort()).toEqual(["absent_today", "critical_projects", "my_projects", "planning_today"]);
    for (const load of Object.values(PLANNING_WIDGET_LOADERS)) {
      const module = await load!();
      expect(typeof module.default).toBe("function");
    }
  });
});

// ── Mein Einsatz ──────────────────────────────────────────────────────────

describe("PlanningTodayWidget", () => {
  const TODAYS = Array.from({ length: 5 }, (_, index) => task(index + 1, { start_time: `0${index + 6}:00` }));
  const MIXED = [
    ...TODAYS,
    task(20, { title: "Morgen", due_date: "2026-10-22" }),
    task(21, { title: "Fremder Einsatz", assignee_ids: [3] }),
    task(22, { title: "Schon erledigt", status: "done" }),
    task(23, { title: "Nächste Woche", due_date: "2026-10-26" }),
  ];

  it("small shows today's own tasks only, 3 rows, without the toggle", () => {
    renderWidget(<PlanningTodayWidget size="small" settings={null} device="mobile" />, { tasks: MIXED });

    const card = region("Mein Einsatz");
    expect(rowTitles(card)).toEqual(["Einsatz 1", "Einsatz 2", "Einsatz 3"]);
    expect(within(card).getByRole("button", { name: "+2 weitere" })).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Woche" })).toBeNull();
  });

  it("medium starts on „Heute“ with 5 rows and switches to the week", () => {
    renderWidget(<PlanningTodayWidget size="medium" settings={null} device="tablet" />, { tasks: MIXED });

    const card = region("Mein Einsatz");
    expect(within(card).getByRole("button", { name: "Heute" })).toHaveAttribute("aria-pressed", "true");
    expect(rowTitles(card)).toHaveLength(5);
    expect(within(card).queryByText("Morgen")).toBeNull();

    fireEvent.click(within(card).getByRole("button", { name: "Woche" }));
    expect(within(card).getByRole("button", { name: "Woche" })).toHaveAttribute("aria-pressed", "true");
    expect(rowTitles(card)).toHaveLength(5);
    expect(within(card).getByRole("button", { name: "+1 weitere" })).toBeInTheDocument();
  });

  it("large starts on the week, grouped by day, capped at 10 rows", () => {
    const week = [
      ...Array.from({ length: 6 }, (_, index) => task(index + 1)),
      ...Array.from({ length: 6 }, (_, index) => task(index + 11, { due_date: "2026-10-23" })),
    ];
    renderWidget(<PlanningTodayWidget size="large" settings={null} device="desktop" />, { tasks: week });

    const card = region("Mein Einsatz");
    expect(within(card).getByRole("button", { name: "Woche" })).toHaveAttribute("aria-pressed", "true");
    expect(rowTitles(card)).toHaveLength(10);
    expect(within(card).getByRole("button", { name: "+2 weitere" })).toBeInTheDocument();
    const days = within(card).getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent);
    expect(days).toHaveLength(2);
    expect(days[0]).toMatch(/Heute/);
  });

  it("shows an admin only the tasks assigned to them, and never done ones", () => {
    renderWidget(<PlanningTodayWidget size="large" settings={null} device="desktop" />, {
      user: { id: ME, email: "chef@example.com", role: "admin", display_name: "Chef Beispiel" },
      tasks: MIXED,
    });

    const card = region("Mein Einsatz");
    expect(within(card).queryByText("Fremder Einsatz")).toBeNull();
    expect(within(card).queryByText("Schon erledigt")).toBeNull();
    expect(within(card).queryByText("Nächste Woche")).toBeNull();
    expect(within(card).getByText("Morgen")).toBeInTheDocument();
  });

  it("shows a multi-day job under every day it covers", () => {
    renderWidget(<PlanningTodayWidget size="large" settings={null} device="desktop" />, {
      tasks: [task(1, { title: "Zählerschrank tauschen", due_date: "2026-10-20", end_date: "2026-10-22" })],
    });

    const card = region("Mein Einsatz");
    expect(within(card).getAllByText("Zählerschrank tauschen")).toHaveLength(3);
    expect(within(card).getAllByRole("heading", { level: 4 })).toHaveLength(3);
  });

  it("says when there is nothing today, and when there is nothing this week", () => {
    renderWidget(<PlanningTodayWidget size="medium" settings={null} device="tablet" />, {
      tasks: [task(1, { due_date: "2026-10-27" })],
    });

    const card = region("Mein Einsatz");
    expect(within(card).getByText("Heute bist du nicht eingeplant.")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Woche" }));
    expect(within(card).getByText("Diese Woche bist du nicht eingeplant.")).toBeInTheDocument();
  });

  it("opens a row on the office task list in Büro mode, and edits it for a manager", () => {
    const office = renderWidget(<PlanningTodayWidget size="small" settings={null} device="desktop" />, {
      tasks: TODAYS,
      workspaceMode: "office",
      navViews: OFFICE_NAV,
      canManageTasks: false,
    });
    fireEvent.click(screen.getByRole("button", { name: /Einsatz 1/ }));
    expect(office.spies.setExpandedMyTaskId).toHaveBeenCalledWith(1);
    expect(office.spies.setMainView).toHaveBeenCalledWith("office_tasks");
    office.unmount();

    const manager = renderWidget(<PlanningTodayWidget size="small" settings={null} device="desktop" />, {
      tasks: TODAYS,
      canManageTasks: true,
    });
    fireEvent.click(screen.getByRole("button", { name: /Einsatz 1/ }));
    expect(manager.spies.openTaskEditModal).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    expect(manager.spies.setMainView).not.toHaveBeenCalled();
  });
});

// ── Meine Projekte / Kritische Projekte ───────────────────────────────────

describe("MyProjectsWidget", () => {
  const TWELVE = Array.from({ length: 12 }, (_, index) => project(index + 1));

  it("caps the rows by size and links on with „+n weitere“", () => {
    const small = renderWidget(<MyProjectsWidget size="small" settings={null} device="mobile" />, { recentAssignedProjects: TWELVE });
    expect(rowTitles(region("Meine Projekte"))).toEqual(["P-1 · Projekt 1", "P-2 · Projekt 2", "P-3 · Projekt 3"]);
    expect(screen.getByRole("button", { name: "+9 weitere" })).toBeInTheDocument();
    small.unmount();

    renderWidget(<MyProjectsWidget size="large" settings={null} device="desktop" />, { recentAssignedProjects: TWELVE });
    expect(rowTitles(region("Meine Projekte"))).toHaveLength(10);
  });

  it("shows its empty copy", () => {
    renderWidget(<MyProjectsWidget size="medium" settings={null} device="tablet" />, { recentAssignedProjects: [] });
    expect(within(region("Meine Projekte")).getByText("Keine zugewiesenen Projekte.")).toBeInTheDocument();
  });

  it("opens a project row and the project list", () => {
    const { spies } = renderWidget(<MyProjectsWidget size="small" settings={null} device="desktop" />, {
      recentAssignedProjects: TWELVE,
      workspaceMode: "office",
      navViews: OFFICE_NAV,
    });

    fireEvent.click(screen.getByRole("button", { name: /P-2 · Projekt 2/ }));
    expect(spies.openProjectById).toHaveBeenCalledWith(2, null);
    fireEvent.click(screen.getByRole("button", { name: "Alle anzeigen" }));
    expect(spies.setMainView).toHaveBeenCalledWith("projects_all");
  });
});

describe("CriticalProjectsWidget", () => {
  it("lists only critical projects that are not archived, newest flag first, with the count", () => {
    renderWidget(<CriticalProjectsWidget size="medium" settings={null} device="tablet" />, {
      projects: [
        project(1, { is_critical: true, critical_since: "2026-10-01T08:00:00" }),
        project(2),
        project(3, { is_critical: true, critical_since: "2026-10-20T08:00:00" }),
        project(4, { is_critical: true, status: "archived" }),
      ],
    });

    const card = region("Kritische Projekte");
    expect(rowTitles(card)).toEqual(["P-3 · Projekt 3", "P-1 · Projekt 1"]);
    expect(within(card).getByText("2")).toBeInTheDocument();
  });

  it("shows its empty copy", () => {
    renderWidget(<CriticalProjectsWidget size="small" settings={null} device="mobile" />, { projects: [project(1)] });
    expect(within(region("Kritische Projekte")).getByText("Keine kritischen Projekte.")).toBeInTheDocument();
  });
});

// ── Wer fehlt heute ───────────────────────────────────────────────────────

describe("AbsentTodayWidget", () => {
  const ABSENT: AbsentToday = {
    date: TODAY,
    absences: [
      { user_id: 3, user_name: "Anna Beispiel", type: "vacation", label: "Urlaub" },
      { user_id: 4, user_name: "Ben Muster", type: "absent", label: "Abwesend" },
      { user_id: 5, user_name: "Cem Probe", type: "school", label: "Berufsschule" },
      { user_id: 6, user_name: "Dora Test", type: "training", label: "Fortbildung" },
    ],
  };

  it("lists who is absent with the generic label, 3 rows at small, from one request", async () => {
    serve(() => json(ABSENT));
    renderWidget(<AbsentTodayWidget size="small" settings={null} device="mobile" />);

    const card = region("Wer fehlt heute");
    expect(await within(card).findByText("Anna Beispiel")).toBeInTheDocument();
    expect(rowTitles(card)).toEqual(["Anna Beispiel", "Ben Muster", "Cem Probe"]);
    expect(within(card).getByText("Abwesend")).toBeInTheDocument();
    expect(within(card).getByText("4")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "+1 weitere" })).toBeInTheDocument();
    expect(requests).toEqual(["/api/dashboard/absent-today"]);
  });

  it("speaks English by type", async () => {
    serve(() => json(ABSENT));
    renderWidget(<AbsentTodayWidget size="large" settings={null} device="desktop" />, { language: "en" });

    const card = region("Absent today");
    expect(await within(card).findByText("Vacation")).toBeInTheDocument();
    expect(within(card).getByText("Absent")).toBeInTheDocument();
    expect(within(card).getByText("Vocational school")).toBeInTheDocument();
  });

  it("shows „Heute fehlt niemand.“ for an empty day", async () => {
    serve(() => json({ date: TODAY, absences: [] }));
    renderWidget(<AbsentTodayWidget size="medium" settings={null} device="tablet" />);
    expect(await within(region("Wer fehlt heute")).findByText("Heute fehlt niemand.")).toBeInTheDocument();
  });

  it("reads „Keine Berechtigung.“ on a 403", async () => {
    serve(() => json({ detail: "Forbidden" }, 403));
    renderWidget(<AbsentTodayWidget size="medium" settings={null} device="tablet" />);
    expect(await within(region("Wer fehlt heute")).findByText("Keine Berechtigung.")).toBeInTheDocument();
  });

  it("shows skeleton rows and no figure while loading, and the error with a retry after a failure", async () => {
    serve(() => new Promise<Response>(() => undefined));
    const loading = renderWidget(<AbsentTodayWidget size="medium" settings={null} device="tablet" />);
    expect(loading.container.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(loading.container.textContent).not.toMatch(/\d/);
    loading.unmount();
    endDashboardSession();

    serve(() => json({ detail: "boom" }, 500));
    renderWidget(<AbsentTodayWidget size="medium" settings={null} device="tablet" />);
    expect(await screen.findByText("Konnte nicht geladen werden.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Erneut versuchen" })).toBeInTheDocument();
  });
});
