/**
 * The „Büro“ widgets of the start page: Neueste Berichte, Offene
 * Urlaubsanträge, Wer ist eingestempelt and Ungelesene Chats
 * (docs/DASHBOARD.md §1, §1.1, §8.4, §8.5; part W5).
 *
 * `fetch` answers what the server answers (`/construction-reports/recent`
 * caps at the `limit` it is asked for, 10 here), so the row caps per size are
 * tested against real list lengths. Each widget: its request, its row cap at
 * Klein and Groß with „+n weitere“, its empty copy, skeleton or error — never
 * a „0“ — while there is no data, and where its rows and links go.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";

import { AppContext, type AppContextValue } from "../context/AppContext";
import { OFFICE_WIDGET_LOADERS } from "../components/dashboard/widgets/office";
import ClockedInWidget from "../components/dashboard/widgets/office/ClockedInWidget";
import RecentReportsWidget from "../components/dashboard/widgets/office/RecentReportsWidget";
import UnreadChatsWidget from "../components/dashboard/widgets/office/UnreadChatsWidget";
import VacationApprovalsWidget from "../components/dashboard/widgets/office/VacationApprovalsWidget";
import type { DashboardWidgetProps } from "../components/dashboard/widgetTypes";
import { endDashboardSession } from "../utils/dashboardSession";
import type { MainView, RecentConstructionReport, Thread, VacationRequest } from "../types";
import { makeAppContextStub } from "./appContextStub";

const OFFICE_NAV: MainView[] = [
  "overview", "projects_all", "projects_map", "customers", "office_tasks", "calendar", "planning",
  "construction", "reports", "werkstatt", "wiki", "messages", "time", "profile",
];

type Route = { status: number; body: unknown } | "pending";

/** A fake server: one answer per path, and every path asked for, in order. */
function serve(routes: Record<string, Route>) {
  const requested: string[] = [];
  const fetchMock = vi.fn((url: string) => {
    requested.push(url);
    const route = routes[url];
    if (route === "pending") return new Promise<Response>(() => undefined);
    if (!route) return Promise.resolve(new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 }));
    return Promise.resolve(
      new Response(JSON.stringify(route.body), { status: route.status, headers: { "Content-Type": "application/json" } }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return requested;
}

function setup(element: ReactElement, overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const record = (name: string) =>
    vi.fn((...args: unknown[]) => calls.push(`${name}(${args.map((arg) => JSON.stringify(arg)).join(",")})`));
  const context = makeAppContextStub({
    overrides: {
      workspaceMode: "office",
      navViews: OFFICE_NAV,
      user: { id: 1, email: "buero@example.com", role: "admin" },
      threads: [],
      recentReportProjectTitleParts: (report: RecentConstructionReport) => ({
        title: report.project_name ?? "",
        subtitle: "",
      }),
      threadProjectTitleParts: (row: Thread) => ({ title: row.project_name ?? "", subtitle: "" }),
      filePreviewUrl: (fileId: number) => `/api/files/${fileId}/preview`,
      setProjectBackView: record("setProjectBackView"),
      setOverviewShortcutBackVisible: record("setOverviewShortcutBackVisible"),
      setConstructionBackView: record("setConstructionBackView"),
      setMainView: record("setMainView"),
      openProjectById: record("openProjectById"),
      setActiveThreadId: record("setActiveThreadId"),
      ...overrides,
    },
  }) as AppContextValue;
  const view = render(<AppContext.Provider value={context}>{element}</AppContext.Provider>);
  const navigation = () => calls.filter((call) => !/^set(ProjectBackView|OverviewShortcutBackVisible|ConstructionBackView)\(/.test(call));
  return { calls, navigation, ...view };
}

function props(size: DashboardWidgetProps["size"]): DashboardWidgetProps {
  return { size, settings: null, device: "desktop" };
}

function rows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".dashboard-office__row"));
}

afterEach(() => {
  // Unmount first: ending the session under a mounted widget that still has
  // a token would let it create a fresh store and hand the next test this
  // test's answers (App clears the token together with the session).
  cleanup();
  endDashboardSession();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const REPORTS_PATH = "/api/construction-reports/recent?limit=10";
const PENDING_PATH = "/api/time/vacation-requests?status=pending";
const CLOCK_PATH = "/api/time/clock-summary";

function report(id: number, fields: Partial<RecentConstructionReport> = {}): RecentConstructionReport {
  return {
    id,
    report_number: 100 + id,
    project_id: 7,
    project_name: "Musterhaus Beispielweg",
    user_display_name: "Theo Testmann",
    report_date: "2026-10-20",
    created_at: `2026-10-20T0${id % 10}:00:00Z`,
    processing_status: "done",
    attachment_id: 500 + id,
    ...fields,
  };
}

const TEN_REPORTS = Array.from({ length: 10 }, (_, index) => report(index + 1));

describe("Neueste Berichte (recent_reports)", () => {
  it("asks for the newest ten and shows three at Klein with „+7 weitere“", async () => {
    const requested = serve({ [REPORTS_PATH]: { status: 200, body: TEN_REPORTS } });

    const { container } = setup(<RecentReportsWidget {...props("small")} />);

    expect(await screen.findByText("Bericht #101")).toBeInTheDocument();
    expect(rows(container)).toHaveLength(3);
    expect(screen.getByRole("button", { name: "+7 weitere" })).toBeInTheDocument();
    expect(requested).toEqual([REPORTS_PATH]);
  });

  it("shows all ten at Groß and no „weitere“", async () => {
    serve({ [REPORTS_PATH]: { status: 200, body: TEN_REPORTS } });

    const { container } = setup(<RecentReportsWidget {...props("large")} />);

    await screen.findByText("Bericht #110");
    expect(rows(container)).toHaveLength(10);
    expect(screen.queryByText(/weitere/)).not.toBeInTheDocument();
  });

  it("opens the PDF in a new tab without a referrer, the project in the app, and the full list from the header", async () => {
    serve({ [REPORTS_PATH]: { status: 200, body: [report(1), report(2, { attachment_id: null, processing_status: "queued" })] } });

    const { container, navigation } = setup(<RecentReportsWidget {...props("medium")} />);
    await screen.findByText("Bericht #101");
    const [first, second] = rows(container);

    const pdf = within(first).getByRole("link", { name: /Öffnen/ });
    expect(pdf).toHaveAttribute("href", "/api/files/501/preview");
    expect(pdf).toHaveAttribute("target", "_blank");
    expect(pdf).toHaveAttribute("rel", "noreferrer");
    expect(within(second).queryByRole("link")).toBeNull();
    expect(within(second).getByText("Wird verarbeitet")).toBeInTheDocument();
    expect(within(first).getByText(/Musterhaus Beispielweg/)).toBeInTheDocument();

    fireEvent.click(within(first).getByRole("button", { name: /Projekt/ }));
    fireEvent.click(screen.getByRole("button", { name: "Alle anzeigen" }));

    expect(navigation()).toEqual(["openProjectById(7,null)", 'setMainView("reports")']);
  });

  it("names the customer of a report without a project", async () => {
    serve({ [REPORTS_PATH]: { status: 200, body: [report(1, { project_id: null, project_name: null, customer_name: "Beispiel GmbH" })] } });

    const { container } = setup(<RecentReportsWidget {...props("small")} />);

    await screen.findByText("Bericht #101");
    expect(within(rows(container)[0]).getByText(/Beispiel GmbH/)).toBeInTheDocument();
    expect(within(rows(container)[0]).queryByRole("button", { name: /Projekt/ })).toBeNull();
  });

  it("shows its empty copy", async () => {
    serve({ [REPORTS_PATH]: { status: 200, body: [] } });

    setup(<RecentReportsWidget {...props("small")} />);

    expect(await screen.findByText("Keine Berichte vorhanden.")).toBeInTheDocument();
  });

  it("shows the error with a retry that asks again", async () => {
    const requested = serve({ [REPORTS_PATH]: { status: 500, body: { detail: "kaputt" } } });

    setup(<RecentReportsWidget {...props("small")} />);

    expect(await screen.findByText("Konnte nicht geladen werden.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    await act(async () => undefined);
    expect(requested).toEqual([REPORTS_PATH, REPORTS_PATH]);
  });
});

function vacation(id: number, name: string, start: string, end: string, days: number): VacationRequest {
  return {
    id,
    user_id: 10 + id,
    user_name: name,
    start_date: start,
    end_date: end,
    vacation_days_used: days,
    status: "pending",
    created_at: `2026-10-0${id}T08:00:00Z`,
  };
}

// Newest request first, as the server sorts them (created_at desc).
const SEVEN_PENDING = [
  vacation(7, "Gerd Gans", "2026-12-21", "2026-12-31", 7),
  vacation(6, "Fiona Fink", "2026-11-02", "2026-11-02", 1),
  vacation(5, "Emil Eule", "2026-11-16", "2026-11-20", 5),
  vacation(4, "Dora Dachs", "2026-10-26", "2026-10-28", 2.5),
  vacation(3, "Cem Kranich", "2027-01-04", "2027-01-08", 5),
  vacation(2, "Bea Biber", "2026-11-09", "2026-11-13", 5),
  vacation(1, "Anna Amsel", "2026-12-01", "2026-12-04", 4),
];

describe("Offene Urlaubsanträge (vacation_approvals)", () => {
  it("asks for pending requests, counts all of them, and shows the soonest three first at Klein", async () => {
    const requested = serve({ [PENDING_PATH]: { status: 200, body: SEVEN_PENDING } });

    const { container } = setup(<VacationApprovalsWidget {...props("small")} />);

    await screen.findByText("Dora Dachs");
    expect(rows(container).map((row) => row.querySelector(".dashboard-office__primary")?.textContent)).toEqual([
      "Dora Dachs",
      "Fiona Fink",
      "Bea Biber",
    ]);
    expect(within(rows(container)[0]).getByText(/26\.10\. – 28\.10\. · 2,5 Tage/)).toBeInTheDocument();
    expect(within(rows(container)[1]).getByText(/02\.11\. · 1 Tag/)).toBeInTheDocument();
    expect(container.querySelector(".dashboard-widget__badge")?.textContent).toBe("7");
    expect(screen.getByRole("button", { name: "+4 weitere" })).toBeInTheDocument();
    expect(requested).toEqual([PENDING_PATH]);
  });

  it("shows all seven at Groß", async () => {
    serve({ [PENDING_PATH]: { status: 200, body: SEVEN_PENDING } });

    const { container } = setup(<VacationApprovalsWidget {...props("large")} />);

    await screen.findByText("Cem Kranich");
    expect(rows(container)).toHaveLength(7);
    expect(screen.queryByText(/weitere/)).not.toBeInTheDocument();
  });

  it("opens the Zeiterfassung, where requests are approved, from a row", async () => {
    serve({ [PENDING_PATH]: { status: 200, body: SEVEN_PENDING } });

    const { navigation } = setup(<VacationApprovalsWidget {...props("small")} />);
    fireEvent.click(await screen.findByRole("button", { name: /Dora Dachs/ }));

    expect(navigation()).toEqual(['setMainView("time")']);
  });

  it("shows skeleton rows and no count while loading", () => {
    serve({ [PENDING_PATH]: "pending" });

    const { container } = setup(<VacationApprovalsWidget {...props("small")} />);

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelector(".dashboard-widget__badge")).toBeNull();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("shows its empty copy", async () => {
    serve({ [PENDING_PATH]: { status: 200, body: [] } });

    setup(<VacationApprovalsWidget {...props("small")} />);

    expect(await screen.findByText("Keine offenen Anträge.")).toBeInTheDocument();
  });
});

function clockSummary(people: Array<[string, string, number]>) {
  return {
    target_local_date: "2026-10-22",
    clocked_in: people.map(([name, since, hours], index) => ({
      user_id: index + 20,
      name,
      clocked_in_since: since,
      hours_today: hours,
    })),
    total_users_with_entries: people.length + 1,
    total_hours_today: 12.5,
  };
}

describe("Wer ist eingestempelt (clocked_in)", () => {
  it("lists who is clocked in, since when and for how long, capped at Klein", async () => {
    const requested = serve({
      [CLOCK_PATH]: {
        status: 200,
        body: clockSummary([
          ["Anna Amsel", "06:45", 3.5],
          ["Bea Biber", "07:00", 3.25],
          ["Cem Kranich", "07:15", 3],
          ["Dora Dachs", "08:30", 1.75],
        ]),
      },
    });

    const { container } = setup(<ClockedInWidget {...props("small")} />);

    await screen.findByText("Anna Amsel");
    expect(rows(container)).toHaveLength(3);
    expect(within(rows(container)[0]).getByText(/seit 06:45/)).toBeInTheDocument();
    expect(within(rows(container)[0]).getByText("3,5 h")).toBeInTheDocument();
    expect(container.querySelector(".dashboard-widget__badge")?.textContent).toBe("4");
    expect(screen.getByRole("button", { name: "+1 weitere" })).toBeInTheDocument();
    expect(requested).toEqual([CLOCK_PATH]);
  });

  it("shows all of them at Groß", async () => {
    serve({ [CLOCK_PATH]: { status: 200, body: clockSummary([["Anna Amsel", "06:45", 3.5], ["Bea Biber", "07:00", 3.25], ["Cem Kranich", "07:15", 3], ["Dora Dachs", "08:30", 1.75]]) } });

    const { container } = setup(<ClockedInWidget {...props("large")} />);

    await screen.findByText("Dora Dachs");
    expect(rows(container)).toHaveLength(4);
  });

  it("shows its empty copy", async () => {
    serve({ [CLOCK_PATH]: { status: 200, body: clockSummary([]) } });

    setup(<ClockedInWidget {...props("small")} />);

    expect(await screen.findByText("Niemand ist eingestempelt.")).toBeInTheDocument();
  });

  it("says „Keine Berechtigung.“ on a 403", async () => {
    serve({ [CLOCK_PATH]: { status: 403, body: { detail: "Forbidden" } } });

    setup(<ClockedInWidget {...props("small")} />);

    expect(await screen.findByText("Keine Berechtigung.")).toBeInTheDocument();
  });
});

function chat(id: number, unread: number, lastAt: string, fields: Partial<Thread> = {}): Thread {
  return {
    id,
    name: `Baustelle ${id}`,
    message_count: 20,
    unread_count: unread,
    last_message_at: lastAt,
    last_message_preview: `Nachricht ${id}`,
    ...fields,
  };
}

describe("Ungelesene Chats (unread_chats)", () => {
  const THREADS = [
    chat(1, 2, "2026-10-22T08:00:00Z"),
    chat(2, 0, "2026-10-22T12:00:00Z"),
    chat(3, 5, "2026-10-22T11:00:00Z"),
    chat(4, 1, "2026-10-21T16:00:00Z"),
    chat(5, 3, "2026-10-22T09:30:00Z"),
  ];

  it("lists only chats with unread messages, newest first, from the context and without a request", () => {
    const requested = serve({});

    const { container } = setup(<UnreadChatsWidget {...props("small")} />, { threads: THREADS });

    expect(rows(container).map((row) => row.querySelector(".dashboard-office__primary")?.textContent)).toEqual([
      "Baustelle 3",
      "Baustelle 5",
      "Baustelle 1",
    ]);
    expect(within(rows(container)[0]).getByText("5")).toBeInTheDocument();
    expect(container.querySelector(".dashboard-widget__badge")?.textContent).toBe("4");
    expect(screen.getByRole("button", { name: "+1 weitere" })).toBeInTheDocument();
    expect(requested).toEqual([]);
  });

  it("shows all four at Groß", () => {
    const { container } = setup(<UnreadChatsWidget {...props("large")} />, { threads: THREADS });

    expect(rows(container)).toHaveLength(4);
  });

  it("opens the chat from a row", () => {
    const { navigation } = setup(<UnreadChatsWidget {...props("small")} />, { threads: THREADS });

    fireEvent.click(screen.getByRole("button", { name: /Baustelle 5/ }));

    expect(navigation()).toEqual(["setActiveThreadId(5)", 'setMainView("messages")']);
  });

  it("shows its empty copy", () => {
    setup(<UnreadChatsWidget {...props("small")} />, { threads: [chat(2, 0, "2026-10-22T12:00:00Z")] });

    expect(screen.getByText("Keine ungelesenen Nachrichten.")).toBeInTheDocument();
  });
});

describe("group loaders", () => {
  it("load the four widgets lazily", async () => {
    expect(Object.keys(OFFICE_WIDGET_LOADERS).sort()).toEqual(
      ["clocked_in", "recent_reports", "unread_chats", "vacation_approvals"],
    );
    expect((await OFFICE_WIDGET_LOADERS.recent_reports!()).default).toBe(RecentReportsWidget);
    expect((await OFFICE_WIDGET_LOADERS.vacation_approvals!()).default).toBe(VacationApprovalsWidget);
    expect((await OFFICE_WIDGET_LOADERS.clocked_in!()).default).toBe(ClockedInWidget);
    expect((await OFFICE_WIDGET_LOADERS.unread_chats!()).default).toBe(UnreadChatsWidget);
  });
});
