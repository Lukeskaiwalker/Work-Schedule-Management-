/**
 * The „Persönlich“ widgets of the start page: Mein Status, Meine Aufgaben,
 * Urlaub and Benachrichtigungen (docs/DASHBOARD.md §1, §1.1, §8.5).
 *
 * The server is a stubbed `fetch` that answers what the real routes answer.
 * What has to hold, per widget: the row caps and extras of each size, the
 * empty copy, skeleton or error — never a figure — while nothing has loaded,
 * and navigation through useDashboardNavigation (so „Meine Aufgaben“ lands on
 * the office task list in Büro mode). For the clock: one tap is one request,
 * however fast the second tap comes, and errors stay inside the card. For
 * vacation: the list names the user (a `time:view_all` caller would get
 * everybody's), and the balance shares `/time/current` with Mein Status.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";

import { AppContext, type AppContextValue } from "../context/AppContext";
import type { AppNotification } from "../components/NotificationPanel";
import { PERSONAL_WIDGET_LOADERS } from "../components/dashboard/widgets/personal";
import MyStatusWidget from "../components/dashboard/widgets/personal/MyStatusWidget";
import MyTasksWidget from "../components/dashboard/widgets/personal/MyTasksWidget";
import MyVacationWidget from "../components/dashboard/widgets/personal/MyVacationWidget";
import NotificationsWidget from "../components/dashboard/widgets/personal/NotificationsWidget";
import type { MainView, Task, TimeCurrent, VacationRequest } from "../types";
import { endDashboardSession } from "../utils/dashboardSession";
import { refreshDashboardTimeResources } from "../utils/dashboardTimeApi";
import { makeAppContextStub } from "./appContextStub";

const ME = 7;
const TODAY = "2026-10-21";
const CONSTRUCTION_NAV: MainView[] = ["overview", "my_tasks", "planning", "construction", "werkstatt", "messages", "time", "wiki"];
const OFFICE_NAV: MainView[] = ["overview", "office_tasks", "projects_all", "customers", "planning", "werkstatt", "messages", "time", "wiki"];

// ── Server stub ───────────────────────────────────────────────────────────

type Request = { url: string; method: string };
type Handler = (url: string, method: string) => Response | Promise<Response>;

let requests: Request[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function serve(handler: Handler): void {
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method });
      return handler(url, method);
    }),
  );
}

function count(method: string, path: string): number {
  return requests.filter((request) => request.method === method && request.url === `/api${path}`).length;
}

/** A promise the test resolves by hand: a request still on its way. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const NEVER = new Promise<Response>(() => undefined);

// ── Fixtures (invented) ───────────────────────────────────────────────────

function timeCurrent(overrides: Partial<TimeCurrent> = {}): TimeCurrent {
  return {
    server_time: "2026-10-21T09:00:00",
    clock_entry_id: null,
    clock_in: null,
    break_open: false,
    worked_hours_live: 0,
    break_hours_live: 0,
    required_break_hours_live: 0,
    deducted_break_hours_live: 0,
    net_hours_live: 0,
    required_daily_hours: 8,
    daily_net_hours: 0,
    progress_percent_live: 0,
    vacation_days_per_year: 30,
    vacation_days_available: 10,
    vacation_days_carryover: 2.5,
    vacation_days_total_remaining: 12.5,
    vacation_days_planned_next_year: 0,
    ...overrides,
  };
}

const CLOCKED_IN = timeCurrent({
  clock_entry_id: 55,
  clock_in: "2026-10-21T07:15:00",
  break_hours_live: 0.5,
  daily_net_hours: 1.25,
});

function vacation(id: number, overrides: Partial<VacationRequest> = {}): VacationRequest {
  return {
    id,
    user_id: ME,
    user_name: "Mara Beispiel",
    start_date: "2026-11-02",
    end_date: "2026-11-06",
    vacation_days_used: 5,
    status: "pending",
    created_at: "2026-10-01T10:00:00",
    ...overrides,
  };
}

function task(id: number, overrides: Partial<Task> = {}): Task {
  return { id, project_id: 1, title: `Aufgabe ${id}`, status: "open", assignee_ids: [ME], due_date: "2026-10-22", ...overrides };
}

function notification(id: number, overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id,
    event_type: "task.assigned",
    entity_type: "task",
    entity_id: 100 + id,
    project_id: 1,
    message: `Neue Aufgabe ${id}`,
    read_at: null,
    created_at: "2026-10-21T08:00:00Z",
    actor_name: "Jonas Muster",
    ...overrides,
  };
}

// ── Rendering ─────────────────────────────────────────────────────────────

function renderWidget(element: ReactElement, overrides: Record<string, unknown> = {}) {
  const spies = {
    setMainView: vi.fn(),
    setExpandedMyTaskId: vi.fn(),
    setMyTasksBackProjectId: vi.fn(),
    openTaskEditModal: vi.fn(),
    markAllNotificationsRead: vi.fn(async () => undefined),
    setNotifPanelOpen: vi.fn(),
    setSidebarOpen: vi.fn(),
    setError: vi.fn(),
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
      isTaskAssignedToCurrentUser: (row: Task) => (row.assignee_ids ?? []).includes(ME),
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

afterEach(() => {
  // Unmount first: a widget still mounted when the session ends re-creates
  // its user's store on the re-render that follows, and that store (with a
  // request still pending) would leak into the next test.
  cleanup();
  endDashboardSession();
});

// ── Loaders ───────────────────────────────────────────────────────────────

describe("PERSONAL_WIDGET_LOADERS", () => {
  it("has one lazy loader for each of the four personal widgets", async () => {
    expect(Object.keys(PERSONAL_WIDGET_LOADERS).sort()).toEqual(["my_status", "my_tasks", "my_vacation", "notifications"]);
    for (const load of Object.values(PERSONAL_WIDGET_LOADERS)) {
      const module = await load!();
      expect(typeof module.default).toBe("function");
    }
  });
});

// ── Mein Status ───────────────────────────────────────────────────────────

describe("MyStatusWidget", () => {
  it("shows skeleton rows and no figure while /time/current has not answered", () => {
    serve(() => NEVER);
    const { container } = renderWidget(<MyStatusWidget size="large" settings={null} device="desktop" />);

    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(container.textContent).not.toMatch(/\d/);
    expect(screen.queryByRole("button", { name: "Einstempeln" })).toBeNull();
  });

  it("small: the state line, hours today and the buttons — no gauge, no details", async () => {
    serve(() => json(timeCurrent()));
    const { container } = renderWidget(<MyStatusWidget size="small" settings={null} device="mobile" />);

    expect(await screen.findByText("Nicht eingestempelt")).toBeInTheDocument();
    expect(within(region("Mein Status")).getByText("Heute: 0,0 / 8,0 h")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Einstempeln" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
    expect(container.querySelector(".dw-status__gauge")).toBeNull();
    expect(screen.queryByText("Schicht seit")).toBeNull();
  });

  it("medium adds the hours gauge; large adds shift start, break taken and required hours", async () => {
    serve(() => json(CLOCKED_IN));
    const medium = renderWidget(<MyStatusWidget size="medium" settings={null} device="tablet" />);
    expect(await screen.findByText("Eingestempelt")).toBeInTheDocument();
    expect(medium.container.querySelector(".dw-status__gauge")).not.toBeNull();
    expect(screen.queryByText("Schicht seit")).toBeNull();
    medium.unmount();

    const large = renderWidget(<MyStatusWidget size="large" settings={null} device="desktop" />);
    expect(await screen.findByText("Schicht seit")).toBeInTheDocument();
    expect(large.container.querySelector(".dw-status__gauge")).not.toBeNull();
    const details = within(large.container.querySelector(".dw-status__details") as HTMLElement);
    // The server sends naive UTC; the card shows the device's local time.
    const shiftStart = new Date("2026-10-21T07:15:00Z").toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
    expect(details.getByText(shiftStart)).toBeInTheDocument();
    expect(details.getByText("30 min")).toBeInTheDocument();
    expect(details.getByText("8,0 h")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ausstempeln" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
  });

  it("clocks in once even when tapped twice, then reloads time:current", async () => {
    const post = deferred<Response>();
    let clockedIn = false;
    serve((url, method) => {
      if (method === "POST" && url === "/api/time/clock-in") return post.promise;
      return json(clockedIn ? CLOCKED_IN : timeCurrent());
    });
    renderWidget(<MyStatusWidget size="small" settings={null} device="mobile" />);

    const button = await screen.findByRole("button", { name: "Einstempeln" });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(count("POST", "/time/clock-in")).toBe(1);
    expect(button).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();

    clockedIn = true;
    post.resolve(json({ id: 55 }));

    expect(await screen.findByRole("button", { name: "Ausstempeln" })).toBeEnabled();
    expect(count("POST", "/time/clock-in")).toBe(1);
    expect(count("GET", "/time/current")).toBe(2);
  });

  it("keeps the buttons off until /time/current shows the state after the action", async () => {
    // A weak connection: the POST answers, the reload behind it does not yet.
    // Until it does the card still shows „Einstempeln“, and a second tap
    // would be a second clock-in the server refuses.
    const reload = deferred<Response>();
    let gets = 0;
    serve((url, method) => {
      if (method === "POST") return json({ id: 55 });
      gets += 1;
      return gets === 1 ? json(timeCurrent()) : reload.promise;
    });
    renderWidget(<MyStatusWidget size="small" settings={null} device="mobile" />);

    const button = await screen.findByRole("button", { name: "Einstempeln" });
    fireEvent.click(button);
    await waitFor(() => expect(count("GET", "/time/current")).toBe(2));

    expect(screen.getByRole("button", { name: "Einstempeln" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Einstempeln" }));
    expect(count("POST", "/time/clock-in")).toBe(1);

    reload.resolve(json(CLOCKED_IN));
    expect(await screen.findByRole("button", { name: "Ausstempeln" })).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a clock-in made on the Zeit page when the user comes back to „Start“", async () => {
    let clockedIn = false;
    serve(() => json(clockedIn ? CLOCKED_IN : timeCurrent()));
    const first = renderWidget(<MyStatusWidget size="small" settings={null} device="mobile" />);
    expect(await screen.findByText("Nicht eingestempelt")).toBeInTheDocument();
    first.unmount();

    // On the Zeit page, within the 30 s poll interval: App clocks in and
    // refreshes its own time data and the start page's (refreshTimeData).
    clockedIn = true;
    refreshDashboardTimeResources(ME);

    renderWidget(<MyStatusWidget size="small" settings={null} device="mobile" />);
    expect(await screen.findByText("Eingestempelt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ausstempeln" })).toBeEnabled();
    expect(count("GET", "/time/current")).toBe(2);
  });

  it("keeps a failed clock-in inside the card and lets the user try again", async () => {
    serve((url, method) =>
      method === "POST" ? json({ detail: "Already clocked in" }, 400) : json(timeCurrent()),
    );
    const { spies } = renderWidget(<MyStatusWidget size="small" settings={null} device="mobile" />);

    fireEvent.click(await screen.findByRole("button", { name: "Einstempeln" }));

    expect(await within(region("Mein Status")).findByText("Einstempeln fehlgeschlagen.")).toBeInTheDocument();
    expect(spies.setError).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Einstempeln" })).toBeEnabled());
  });

  it("ends a running break through /time/break-end", async () => {
    serve((url, method) => (method === "POST" ? json({}) : json({ ...CLOCKED_IN, break_open: true })));
    renderWidget(<MyStatusWidget size="small" settings={null} device="mobile" />);

    expect(await screen.findByText("In der Pause")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pause beenden" }));

    await waitFor(() => expect(count("POST", "/time/break-end")).toBe(1));
    expect(count("POST", "/time/break-start")).toBe(0);
  });

  it("shows the widget error with a retry when the first load fails", async () => {
    serve(() => json({ detail: "boom" }, 500));
    renderWidget(<MyStatusWidget size="small" settings={null} device="mobile" />);

    expect(await screen.findByText("Konnte nicht geladen werden.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Erneut versuchen" })).toBeInTheDocument();
  });
});

// ── Meine Aufgaben ────────────────────────────────────────────────────────

describe("MyTasksWidget", () => {
  const MANY = Array.from({ length: 12 }, (_, index) => task(index + 1, { title: `Aufgabe ${index + 1}` }));

  it("small shows 3 rows and no status filter", () => {
    renderWidget(<MyTasksWidget size="small" settings={null} device="mobile" />, { sortedTasks: MANY });

    const card = region("Meine Aufgaben");
    expect(within(card).getAllByRole("listitem")).toHaveLength(3);
    expect(within(card).getByRole("button", { name: "+9 weitere" })).toBeInTheDocument();
    expect(within(card).queryByLabelText("Aufgaben nach Status filtern")).toBeNull();
  });

  it("large shows 10 rows and the status filter", () => {
    renderWidget(<MyTasksWidget size="large" settings={null} device="desktop" />, { sortedTasks: MANY });

    const card = region("Meine Aufgaben");
    expect(within(card).getAllByRole("listitem")).toHaveLength(10);
    expect(within(card).getByRole("button", { name: "+2 weitere" })).toBeInTheDocument();
    expect(within(card).getByLabelText("Aufgaben nach Status filtern")).toBeInTheDocument();
  });

  it("shows the card's empty copy", () => {
    renderWidget(<MyTasksWidget size="medium" settings={null} device="tablet" />, { sortedTasks: [] });
    expect(within(region("Meine Aufgaben")).getByText("Keine Aufgaben.")).toBeInTheDocument();
  });

  it("sends rows, „+n weitere“ and „Alle anzeigen“ to the office task list in Büro mode", () => {
    const { spies } = renderWidget(<MyTasksWidget size="small" settings={null} device="desktop" />, {
      sortedTasks: MANY,
      workspaceMode: "office",
      navViews: OFFICE_NAV,
      canManageTasks: false,
    });

    fireEvent.click(screen.getByRole("button", { name: "Aufgabe öffnen: Aufgabe 1" }));
    expect(spies.setExpandedMyTaskId).toHaveBeenCalledWith(1);
    expect(spies.setMainView).toHaveBeenLastCalledWith("office_tasks");

    fireEvent.click(screen.getByRole("button", { name: "+9 weitere" }));
    fireEvent.click(screen.getByRole("button", { name: "Alle anzeigen" }));
    expect(spies.setMainView.mock.calls.map(([view]) => view)).toEqual(["office_tasks", "office_tasks", "office_tasks"]);
  });
});

// ── Urlaub ────────────────────────────────────────────────────────────────

describe("MyVacationWidget", () => {
  const AHEAD = Array.from({ length: 12 }, (_, index) =>
    vacation(index + 1, { start_date: `2026-12-${String(index + 1).padStart(2, "0")}`, end_date: `2026-12-${String(index + 1).padStart(2, "0")}`, vacation_days_used: 1 }),
  );

  function serveVacation(rows: VacationRequest[], current: TimeCurrent = timeCurrent()) {
    serve((url) => {
      if (url === "/api/time/current") return json(current);
      if (url.startsWith("/api/time/vacation-requests")) return json(rows);
      return json({ detail: "not found" }, 404);
    });
  }

  it("names the user in the request list and reads the balance from /time/current", async () => {
    serveVacation(
      [vacation(1, { status: "approved" }), vacation(2, { start_date: "2026-10-01", end_date: "2026-10-02", status: "approved" })],
      timeCurrent({ vacation_days_planned_next_year: 2 }),
    );
    renderWidget(<MyVacationWidget size="small" settings={null} device="mobile" />);

    const card = region("Urlaub");
    expect(await within(card).findByText("12,5")).toBeInTheDocument();
    expect(within(card).getByText(/Vorgemerkt 2027/)).toBeInTheDocument();
    expect(within(card).getByText("02.11. – 06.11.")).toBeInTheDocument();
    expect(count("GET", `/time/vacation-requests?user_id=${ME}`)).toBe(1);
    expect(requests.filter((request) => request.url.startsWith("/api/time/vacation-requests"))).toHaveLength(1);
    // Small: balance and next leave only.
    expect(within(card).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("medium lists 5 own requests ahead, large 10, each with „+n weitere“", async () => {
    serveVacation(AHEAD);
    const medium = renderWidget(<MyVacationWidget size="medium" settings={null} device="tablet" />);
    expect(await within(region("Urlaub")).findAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByRole("button", { name: "+7 weitere" })).toBeInTheDocument();
    medium.unmount();

    renderWidget(<MyVacationWidget size="large" settings={null} device="desktop" />);
    expect(await within(region("Urlaub")).findAllByRole("listitem")).toHaveLength(10);
    expect(screen.getByRole("button", { name: "+2 weitere" })).toBeInTheDocument();
  });

  it("says „Keine offenen Anträge.“ when nothing lies ahead", async () => {
    serveVacation([
      vacation(1, { start_date: "2026-09-01", end_date: "2026-09-03", status: "approved" }),
      vacation(2, { status: "rejected" }),
    ]);
    renderWidget(<MyVacationWidget size="medium" settings={null} device="tablet" />);

    expect(await within(region("Urlaub")).findByText("Keine offenen Anträge.")).toBeInTheDocument();
    expect(screen.getByText("Kein Urlaub geplant.")).toBeInTheDocument();
  });

  it("shares one /time/current request with „Mein Status“ on the same page", async () => {
    serveVacation([]);
    renderWidget(
      <>
        <MyStatusWidget size="medium" settings={null} device="desktop" />
        <MyVacationWidget size="medium" settings={null} device="desktop" />
      </>,
    );

    expect(await screen.findByText("Nicht eingestempelt")).toBeInTheDocument();
    expect(await within(region("Urlaub")).findByText("12,5")).toBeInTheDocument();
    expect(count("GET", "/time/current")).toBe(1);
  });

  it("shows skeleton rows and no figure while the balance is on its way", () => {
    serve(() => NEVER);
    const { container } = renderWidget(<MyVacationWidget size="large" settings={null} device="desktop" />);

    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(container.textContent).not.toMatch(/\d/);
  });
});

// ── Benachrichtigungen ────────────────────────────────────────────────────

describe("NotificationsWidget", () => {
  const MANY = Array.from({ length: 12 }, (_, index) =>
    notification(index + 1, { read_at: index < 4 ? null : "2026-10-21T08:30:00Z" }),
  );

  it("small shows 3 rows, the unread count and no „Alle gelesen“", () => {
    renderWidget(<NotificationsWidget size="small" settings={null} device="mobile" />, { notifications: MANY });

    const card = region("Benachrichtigungen");
    expect(within(card).getAllByRole("listitem")).toHaveLength(3);
    expect(within(card).getByText("4")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Alle gelesen" })).toBeNull();
    expect(within(card).getByRole("button", { name: "+9 weitere" })).toBeInTheDocument();
  });

  it("large shows 10 rows and „Alle gelesen“ marks everything read", () => {
    const { spies } = renderWidget(<NotificationsWidget size="large" settings={null} device="desktop" />, { notifications: MANY });

    const card = region("Benachrichtigungen");
    expect(within(card).getAllByRole("listitem")).toHaveLength(10);
    fireEvent.click(within(card).getByRole("button", { name: "Alle gelesen" }));
    expect(spies.markAllNotificationsRead).toHaveBeenCalledTimes(1);
  });

  it("shows its empty copy", () => {
    renderWidget(<NotificationsWidget size="medium" settings={null} device="tablet" />, { notifications: [] });
    expect(within(region("Benachrichtigungen")).getByText("Keine Benachrichtigungen.")).toBeInTheDocument();
  });

  it("opens a task notification on the office task list in Büro mode", () => {
    const { spies } = renderWidget(<NotificationsWidget size="small" settings={null} device="desktop" />, {
      notifications: [notification(1, { message: "Kabel verlegen zugewiesen" })],
      workspaceMode: "office",
      navViews: OFFICE_NAV,
    });

    fireEvent.click(screen.getByRole("button", { name: /Kabel verlegen zugewiesen/ }));
    expect(spies.setMyTasksBackProjectId).toHaveBeenCalledWith(null);
    expect(spies.setMainView).toHaveBeenCalledWith("office_tasks");
  });

  it("opens the notification panel for the rows beyond the limit", () => {
    const { spies } = renderWidget(<NotificationsWidget size="small" settings={null} device="mobile" />, { notifications: MANY });

    fireEvent.click(screen.getByRole("button", { name: "+9 weitere" }));
    expect(spies.setSidebarOpen).toHaveBeenCalledWith(true);
    expect(spies.setNotifPanelOpen).toHaveBeenCalledWith(true);
  });
});
