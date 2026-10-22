/**
 * The seven „Werkstatt“ widgets of the start page (docs/DASHBOARD.md §1, §1.1,
 * §8.5, §12 W4).
 *
 * The network is stubbed with what the SERVER answers — at most 10 preview
 * rows from `/werkstatt/dashboard?preview_limit=10`, ten recent panels — so
 * the row caps tested here are the widgets' own, not an artefact of a fixture
 * shorter than the cap. What each test pins:
 *
 * - the size decides the rows (3 / 5 / 10) and „+n weitere“ counts against
 *   the server's total, not against the slice it happened to send;
 * - while nothing has arrived, a widget shows skeletons or the error, never a
 *   digit — the house rule from useWerkstattOverview, where a „0“ nobody
 *   fetched reads as „alles in Ordnung“;
 * - the three widgets fed by `/werkstatt/dashboard` share ONE request;
 * - every row and link goes through useDashboardNavigation, so a Verteiler
 *   opens the editor in Baustelle mode and the Kommissionierung in Büro mode.
 *
 * All names and numbers are invented; the repository is public.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";

import { AppContext } from "../context/AppContext";
import type { DashboardWidgetProps } from "../components/dashboard/widgetTypes";
import { WERKSTATT_WIDGET_LOADERS } from "../components/dashboard/widgets/werkstatt";
import BoxesWidget from "../components/dashboard/widgets/werkstatt/BoxesWidget";
import InspectionsWidget from "../components/dashboard/widgets/werkstatt/InspectionsWidget";
import MyCheckoutsWidget from "../components/dashboard/widgets/werkstatt/MyCheckoutsWidget";
import RecentPanelsWidget from "../components/dashboard/widgets/werkstatt/RecentPanelsWidget";
import WerkstattKpisWidget from "../components/dashboard/widgets/werkstatt/WerkstattKpisWidget";
import WerkstattOnSiteWidget from "../components/dashboard/widgets/werkstatt/WerkstattOnSiteWidget";
import WerkstattReorderWidget from "../components/dashboard/widgets/werkstatt/WerkstattReorderWidget";
import type { DashboardDevice, DashboardWidgetSize } from "../types/dashboard";
import type { MainView, WorkspaceMode } from "../types";
import { endDashboardSession } from "../utils/dashboardSession";
import { clearPendingPanel, peekPendingPanel } from "../utils/schaltplanHandoff";
import { makeAppContextStub } from "./appContextStub";

const NOW = new Date("2026-10-22T09:00:00Z");
const CONSTRUCTION_NAV: MainView[] = ["overview", "my_tasks", "planning", "construction", "schaltplan", "werkstatt", "messages", "time", "wiki"];
const OFFICE_NAV: MainView[] = ["overview", "office_tasks", "projects_all", "customers", "planning", "werkstatt", "messages", "time", "wiki"];

// ── Server answers ──────────────────────────────────────────────────────────

const KPIS = {
  total_articles: 120,
  total_categories: 8,
  below_min_count: 14,
  on_site_count: 9,
  on_site_project_count: 12,
  unavailable_count: 3,
  in_repair_count: 2,
};

const range = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

function reorderLine(n: number) {
  return {
    article_id: 100 + n,
    article_number: `SP-${1000 + n}`,
    article_name: `Testkabel ${n}`,
    image_url: null,
    stock_available: n === 1 ? 0 : 2,
    stock_min: 10,
    suggested_quantity: 8,
    unit: "m",
    unit_price_cents: null,
    line_total_cents: null,
  };
}

function onSiteGroup(n: number) {
  return {
    project_id: 200 + n,
    project_number: `P-${300 + n}`,
    project_title: `Baustelle Beispiel ${n}`,
    item_count: n + 1,
    items: [
      {
        article_id: 400 + n,
        article_number: `SP-${500 + n}`,
        article_name: `Bohrhammer ${n}`,
        quantity: 1,
        assignee_display_name: "Mara Beispiel",
        expected_return_at: n === 1 ? "2026-10-20T12:00:00Z" : null,
        is_overdue: n === 1,
      },
    ],
  };
}

function dashboard(overrides: Record<string, unknown> = {}) {
  return {
    kpis: KPIS,
    reorder_preview: range(10).map(reorderLine),
    recent_movements: [],
    on_site_groups: range(10).map(onSiteGroup),
    maintenance_entries: [],
    ...overrides,
  };
}

function checkout(n: number) {
  return {
    article_id: 600 + n,
    article_number: `SP-${700 + n}`,
    article_name: `Akkuschrauber ${n}`,
    image_url: null,
    unit: "Stk",
    quantity_out: 1,
    earliest_checkout_at: "2026-10-15T07:00:00Z",
    latest_expected_return_at: n === 1 ? "2026-10-20T12:00:00Z" : null,
    project_id: n === 2 ? null : 800 + n,
    project_number: n === 2 ? null : `P-${900 + n}`,
    project_name: n === 2 ? null : `Musterhaus ${n}`,
  };
}

function box(n: number, status: "gepackt" | "zugewiesen") {
  return {
    id: n,
    box_number: `K${n}`,
    label: `Kiste ${n}`,
    slot: n,
    status,
    customer_id: 10 + n,
    customer_name: `Beispielkunde ${n}`,
    project_id: null,
    project_name: null,
    item_count: n,
    packed_at: "2026-10-21T07:00:00Z",
    assigned_at: status === "zugewiesen" ? "2026-10-21T09:00:00Z" : null,
    returned_at: null,
    notes: null,
    created_at: "2026-10-01T07:00:00Z",
    items: [],
  };
}

function inspection(n: number, daysUntilDue: number | null) {
  return {
    article_id: 1000 + n,
    article_number: `SP-${1100 + n}`,
    article_name: `Leiter ${n}`,
    category_name: "Leitern",
    location_name: "Regal A",
    last_bg_inspected_at: null,
    next_bg_due_at: null,
    days_until_due: daysUntilDue,
    urgency: daysUntilDue !== null && daysUntilDue < 0 ? "overdue" : "due_soon",
  };
}

function panel(n: number) {
  return {
    id: 40 + n,
    panel_number: `VT-${String(40 + n).padStart(4, "0")}`,
    customer_id: 3,
    customer_name: "Beispiel GmbH",
    project_id: 7,
    project_number: "P-0007",
    project_name: "Musterhaus",
    name: `Keller ${n}`,
    designation: `UV${n}`,
    panel_type: "sub",
    location: null,
    fed_from_panel_id: null,
    fed_from_designation: null,
    status: "draft",
    revision: 1,
    device_count: 4,
    circuit_count: 2,
    rcd_count: 1,
    used_slots: 6,
    total_slots: 12,
    row_count: 1,
    updated_at: "2026-10-22T08:30:00Z",
    updated_by_name: "Mara Beispiel",
  };
}

// ── Network stub ────────────────────────────────────────────────────────────

/** A status the stub answers with instead of a body. */
type Failure = { fail: number };
type Answer = unknown | Failure | (() => Promise<Response>);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function isFailure(answer: Answer): answer is Failure {
  return typeof answer === "object" && answer !== null && "fail" in answer;
}

/**
 * Answers by full URL first ("/api/werkstatt/boxes?status=gepackt&limit=50"),
 * then by path alone. A function answer is called per request, so a test can
 * hold one back or change it between attempts.
 */
function serve(answers: Record<string, Answer>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      const answer = url in answers ? answers[url] : answers[url.split("?")[0]];
      if (answer === undefined) return json({ detail: "not stubbed" }, 404);
      if (typeof answer === "function") return (answer as () => Promise<Response>)();
      if (isFailure(answer)) return json({ detail: "Serverfehler" }, answer.fail);
      return json(answer);
    }),
  );
  return calls;
}

function held(): { answer: () => Promise<Response>; release: (response: Response) => void } {
  let release: (response: Response) => void = () => undefined;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { answer: () => pending, release };
}

// ── Rendering ───────────────────────────────────────────────────────────────

function renderWithContext(node: ReactNode, mode: WorkspaceMode = "construction") {
  const spies = {
    setMainView: vi.fn(),
    setWerkstattTab: vi.fn(),
    setProjectBackView: vi.fn(),
    setOverviewShortcutBackVisible: vi.fn(),
    setConstructionBackView: vi.fn(),
    openProjectById: vi.fn(),
    setActiveThreadId: vi.fn(),
  };
  const context = makeAppContextStub({
    overrides: {
      token: "test-token",
      language: "de",
      user: { id: 5, email: "a@example.com", role: "employee" },
      now: NOW,
      workspaceMode: mode,
      navViews: mode === "office" ? OFFICE_NAV : CONSTRUCTION_NAV,
      ...spies,
    },
  });
  render(<AppContext.Provider value={context as never}>{node}</AppContext.Provider>);
  return spies;
}

function widget(
  Component: ComponentType<DashboardWidgetProps>,
  size: DashboardWidgetSize = "medium",
  device: DashboardDevice = "desktop",
) {
  return <Component size={size} settings={null} device={device} />;
}

const region = (name: string) => screen.getByRole("region", { name });
const rowsOf = (name: string) => within(region(name)).queryAllByRole("listitem");

afterEach(() => {
  // Unmount before ending the session. Hooks run in reverse order, so the
  // global cleanup would come last: a widget still mounted when its store is
  // dropped renders once more, opens a fresh store with the test token and
  // carries its keys into the next test.
  cleanup();
  endDashboardSession();
  clearPendingPanel();
  vi.unstubAllGlobals();
});

// ── Shared request ──────────────────────────────────────────────────────────

describe("the /werkstatt/dashboard widgets", () => {
  it("make one request between the three of them, asking for 10 preview rows", async () => {
    const calls = serve({ "/api/werkstatt/dashboard": dashboard() });

    renderWithContext(
      <>
        {widget(WerkstattKpisWidget)}
        {widget(WerkstattReorderWidget)}
        {widget(WerkstattOnSiteWidget)}
      </>,
    );

    await screen.findByText("Testkabel 1");
    await screen.findByText(/Baustelle Beispiel 1/);
    expect(calls.filter((url) => url.startsWith("/api/werkstatt/dashboard"))).toEqual([
      "/api/werkstatt/dashboard?preview_limit=10",
    ]);
  });
});

// ── Lager-Kennzahlen ────────────────────────────────────────────────────────

describe("werkstatt_kpis", () => {
  it("shows two figures at Klein", async () => {
    serve({ "/api/werkstatt/dashboard": dashboard() });

    renderWithContext(widget(WerkstattKpisWidget, "small"));

    const card = within(await screen.findByRole("region", { name: "Lager-Kennzahlen" }));
    expect(await card.findByRole("button", { name: /Unter Mindestbestand.*14/ })).toBeInTheDocument();
    expect(card.getByRole("button", { name: /Auf Baustelle.*9/ })).toBeInTheDocument();
    expect(card.queryByText("Nicht verfügbar")).toBeNull();
    expect(card.queryByText("In Reparatur")).toBeNull();
  });

  it("shows four figures at Mittel, and their sub-labels only at Groß", async () => {
    serve({ "/api/werkstatt/dashboard": dashboard() });

    renderWithContext(
      <>
        <section aria-label="mittel">{widget(WerkstattKpisWidget, "medium")}</section>
        <section aria-label="gross">{widget(WerkstattKpisWidget, "large")}</section>
      </>,
    );

    const medium = within(screen.getByRole("region", { name: "mittel" }));
    const large = within(screen.getByRole("region", { name: "gross" }));
    expect(await medium.findByRole("button", { name: /Nicht verfügbar.*3/ })).toBeInTheDocument();
    expect(medium.getByRole("button", { name: /In Reparatur.*2/ })).toBeInTheDocument();
    expect(medium.queryByText("Artikel außer Haus")).toBeNull();
    expect(await large.findByText("Artikel außer Haus")).toBeInTheDocument();
    expect(large.getAllByRole("button", { name: /Unter Mindestbestand|Auf Baustelle|Nicht verfügbar|In Reparatur/ })).toHaveLength(4);
  });

  it("opens the matching Werkstatt tab from a figure", async () => {
    serve({ "/api/werkstatt/dashboard": dashboard() });
    const spies = renderWithContext(widget(WerkstattKpisWidget, "small"));

    fireEvent.click(await screen.findByRole("button", { name: /Unter Mindestbestand/ }));

    expect(spies.setWerkstattTab).toHaveBeenLastCalledWith("nachbestellen");
    expect(spies.setMainView).toHaveBeenLastCalledWith("werkstatt");
  });
});

// ── Nachbestellen / Auf Baustelle ───────────────────────────────────────────

describe("werkstatt_reorder", () => {
  it("caps at 3 rows at Klein and counts the rest against the below-minimum figure", async () => {
    serve({ "/api/werkstatt/dashboard": dashboard() });

    renderWithContext(widget(WerkstattReorderWidget, "small"));

    await screen.findByText("Testkabel 1");
    expect(rowsOf("Nachbestellen")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "+11 weitere" })).toBeInTheDocument();
  });

  it("shows all 10 server rows at Groß", async () => {
    serve({ "/api/werkstatt/dashboard": dashboard() });

    renderWithContext(widget(WerkstattReorderWidget, "large"));

    await screen.findByText("Testkabel 10");
    expect(rowsOf("Nachbestellen")).toHaveLength(10);
    expect(screen.getByRole("button", { name: "+4 weitere" })).toBeInTheDocument();
  });

  it("says when nothing is to be ordered", async () => {
    serve({
      "/api/werkstatt/dashboard": dashboard({ kpis: { ...KPIS, below_min_count: 0 }, reorder_preview: [] }),
    });

    renderWithContext(widget(WerkstattReorderWidget, "small"));

    expect(await screen.findByText("Nichts nachzubestellen.")).toBeInTheDocument();
  });

  it("opens Nachbestellen from a row", async () => {
    serve({ "/api/werkstatt/dashboard": dashboard() });
    const spies = renderWithContext(widget(WerkstattReorderWidget, "small"));

    fireEvent.click(await screen.findByRole("button", { name: /Testkabel 2/ }));

    expect(spies.setWerkstattTab).toHaveBeenLastCalledWith("nachbestellen");
    expect(spies.setMainView).toHaveBeenLastCalledWith("werkstatt");
  });
});

describe("werkstatt_on_site", () => {
  it("shows one row per project and counts the rest against the on-site project figure", async () => {
    serve({ "/api/werkstatt/dashboard": dashboard() });

    renderWithContext(
      <>
        <section aria-label="klein">{widget(WerkstattOnSiteWidget, "small")}</section>
        <section aria-label="gross">{widget(WerkstattOnSiteWidget, "large")}</section>
      </>,
    );

    const small = within(screen.getByRole("region", { name: "klein" }));
    const large = within(screen.getByRole("region", { name: "gross" }));
    await small.findByText(/Baustelle Beispiel 1/);
    expect(small.getAllByRole("listitem")).toHaveLength(3);
    expect(small.getByRole("button", { name: "+9 weitere" })).toBeInTheDocument();
    expect(large.getAllByRole("listitem")).toHaveLength(10);
    expect(large.getByRole("button", { name: "+2 weitere" })).toBeInTheDocument();
  });

  it("opens „Auf Baustelle“ from a row", async () => {
    serve({ "/api/werkstatt/dashboard": dashboard() });
    const spies = renderWithContext(widget(WerkstattOnSiteWidget, "small"));

    fireEvent.click(await screen.findByRole("button", { name: /Baustelle Beispiel 2/ }));

    expect(spies.setWerkstattTab).toHaveBeenLastCalledWith("on_site");
  });

  it("shows its empty copy", async () => {
    serve({
      "/api/werkstatt/dashboard": dashboard({ kpis: { ...KPIS, on_site_project_count: 0 }, on_site_groups: [] }),
    });

    renderWithContext(widget(WerkstattOnSiteWidget, "small"));

    expect(await screen.findByText("Nichts auf Baustelle.")).toBeInTheDocument();
  });
});

// ── Meine Ausleihen ─────────────────────────────────────────────────────────

describe("werkstatt_my_checkouts", () => {
  it("reads the caller's own checkouts and caps the rows by size", async () => {
    const calls = serve({ "/api/werkstatt/mobile/my-checkouts": range(12).map(checkout) });

    renderWithContext(widget(MyCheckoutsWidget, "small"));

    await screen.findByText("Akkuschrauber 1");
    expect(calls).toContain("/api/werkstatt/mobile/my-checkouts");
    expect(rowsOf("Meine Ausleihen")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "+9 weitere" })).toBeInTheDocument();
    expect(screen.getByText("2 Tage überfällig")).toBeInTheDocument();
    expect(screen.getByText("ohne Projekt")).toBeInTheDocument();
  });

  it("shows its empty copy", async () => {
    serve({ "/api/werkstatt/mobile/my-checkouts": [] });

    renderWithContext(widget(MyCheckoutsWidget, "small"));

    expect(await screen.findByText("Du hast nichts ausgeliehen.")).toBeInTheDocument();
  });

  it("retries after a failed first load", async () => {
    let attempts = 0;
    serve({
      "/api/werkstatt/mobile/my-checkouts": async () => {
        attempts += 1;
        return attempts === 1 ? json({ detail: "Serverfehler" }, 500) : json([checkout(1)]);
      },
    });

    renderWithContext(widget(MyCheckoutsWidget, "small"));

    fireEvent.click(await screen.findByRole("button", { name: "Erneut versuchen" }));

    expect(await screen.findByText("Akkuschrauber 1")).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it("opens the phone's Werkstatt home („Meine Entnahmen“) on a phone", async () => {
    serve({ "/api/werkstatt/mobile/my-checkouts": [checkout(1)] });
    const phone = renderWithContext(widget(MyCheckoutsWidget, "small", "mobile"));
    fireEvent.click(await screen.findByRole("button", { name: /Akkuschrauber 1/ }));
    expect(phone.setWerkstattTab).toHaveBeenLastCalledWith("dashboard");
  });

  it("opens „Auf Baustelle“ on a desktop", async () => {
    serve({ "/api/werkstatt/mobile/my-checkouts": [checkout(1)] });
    const desk = renderWithContext(widget(MyCheckoutsWidget, "small", "desktop"));
    fireEvent.click(await screen.findByRole("button", { name: /Akkuschrauber 1/ }));
    expect(desk.setWerkstattTab).toHaveBeenLastCalledWith("on_site");
  });
});

// ── Baustellenkisten ────────────────────────────────────────────────────────

describe("werkstatt_boxes", () => {
  const PACKED = "/api/werkstatt/boxes?status=gepackt&limit=50";
  const ASSIGNED = "/api/werkstatt/boxes?status=zugewiesen&limit=50";

  it("reads packed and assigned crates, packed first", async () => {
    const calls = serve({ [PACKED]: [box(1, "gepackt"), box(2, "gepackt")], [ASSIGNED]: [box(3, "zugewiesen")] });

    renderWithContext(widget(BoxesWidget, "medium"));

    await screen.findByText(/Kiste 3/);
    expect(calls).toEqual(expect.arrayContaining([PACKED, ASSIGNED]));
    const rows = rowsOf("Baustellenkisten");
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("Gepackt – bereit");
    expect(rows[2].textContent).toContain("Beim Kunden");
    expect(rows[2].textContent).toContain("Beispielkunde 3");
  });

  it("caps the rows at Klein and opens Kisten", async () => {
    serve({ [PACKED]: range(4).map((n) => box(n, "gepackt")), [ASSIGNED]: [box(5, "zugewiesen")] });
    const spies = renderWithContext(widget(BoxesWidget, "small"));

    await screen.findByText(/Kiste 1/);
    expect(rowsOf("Baustellenkisten")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "+2 weitere" }));

    expect(spies.setWerkstattTab).toHaveBeenLastCalledWith("kisten");
  });

  it("shows its empty copy", async () => {
    serve({ [PACKED]: [], [ASSIGNED]: [] });

    renderWithContext(widget(BoxesWidget, "small"));

    expect(await screen.findByText("Keine gepackten oder zugewiesenen Kisten.")).toBeInTheDocument();
  });

  it("shows the error, not half a list, when one of the two reads fails", async () => {
    serve({ [PACKED]: [box(1, "gepackt")], [ASSIGNED]: { fail: 500 } });

    renderWithContext(widget(BoxesWidget, "small"));

    expect(await screen.findByText("Konnte nicht geladen werden.")).toBeInTheDocument();
    expect(screen.queryByText(/Kiste 1/)).toBeNull();
  });
});

// ── Fällige Prüfungen ───────────────────────────────────────────────────────

describe("werkstatt_inspections", () => {
  it("reads the next 30 days and labels what is overdue", async () => {
    const calls = serve({
      "/api/werkstatt/inspections/due": [inspection(1, -3), inspection(2, 0), inspection(3, 12), inspection(4, null)],
    });

    renderWithContext(widget(InspectionsWidget, "small"));

    await screen.findByText("Leiter 1");
    expect(calls).toContain("/api/werkstatt/inspections/due?days_ahead=30");
    expect(rowsOf("Fällige Prüfungen")).toHaveLength(3);
    expect(screen.getByText("3 T. überfällig")).toBeInTheDocument();
    expect(screen.getByText("Heute fällig")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+1 weitere" })).toBeInTheDocument();
  });

  it("shows its empty copy", async () => {
    serve({ "/api/werkstatt/inspections/due": [] });

    renderWithContext(widget(InspectionsWidget, "small"));

    expect(await screen.findByText("Keine Prüfungen in den nächsten 30 Tagen.")).toBeInTheDocument();
  });

  it("opens the Werkstatt dashboard tab, whose „Prüfung & Reparatur“ card lists these articles", async () => {
    serve({ "/api/werkstatt/inspections/due": [inspection(1, -3)] });
    const spies = renderWithContext(widget(InspectionsWidget, "small"));

    fireEvent.click(await screen.findByRole("button", { name: /Leiter 1/ }));

    expect(spies.setWerkstattTab).toHaveBeenLastCalledWith("dashboard");
    expect(spies.setMainView).toHaveBeenLastCalledWith("werkstatt");
  });

  it("says „Keine Berechtigung.“ on a 403", async () => {
    serve({ "/api/werkstatt/inspections/due": { fail: 403 } });

    renderWithContext(widget(InspectionsWidget, "small"));

    expect(await screen.findByText("Keine Berechtigung.")).toBeInTheDocument();
  });
});

// ── Zuletzt bearbeitete Verteiler ───────────────────────────────────────────

describe("recent_panels", () => {
  const RECENT = "/api/schaltplan/panels/recent";

  it("reads the ten newest panels and caps the rows by size", async () => {
    const calls = serve({ [RECENT]: range(10).map(panel) });

    renderWithContext(
      <>
        <section aria-label="klein">{widget(RecentPanelsWidget, "small")}</section>
        <section aria-label="gross">{widget(RecentPanelsWidget, "large")}</section>
      </>,
    );

    const small = within(screen.getByRole("region", { name: "klein" }));
    const large = within(screen.getByRole("region", { name: "gross" }));
    await small.findByText(/VT-0041/);
    expect(calls).toContain("/api/schaltplan/panels/recent?limit=10");
    expect(small.getAllByRole("listitem")).toHaveLength(3);
    expect(large.getAllByRole("listitem")).toHaveLength(10);
  });

  it("shows its empty copy", async () => {
    serve({ [RECENT]: [] });

    renderWithContext(widget(RecentPanelsWidget, "small"));

    expect(await screen.findByText("Noch keine Verteilerpläne.")).toBeInTheDocument();
  });

  it("hands the panel to the Schaltplan editor in Baustelle mode", async () => {
    serve({ [RECENT]: [panel(1), panel(2)] });
    const spies = renderWithContext(widget(RecentPanelsWidget, "small"), "construction");

    fireEvent.click(await screen.findByRole("button", { name: /VT-0042/ }));

    expect(spies.setMainView).toHaveBeenLastCalledWith("schaltplan");
    expect(peekPendingPanel()?.id).toBe(42);
  });

  it("opens the Kommissionierung in Büro mode, with no handoff", async () => {
    serve({ [RECENT]: [panel(1), panel(2)] });
    const spies = renderWithContext(widget(RecentPanelsWidget, "small"), "office");

    fireEvent.click(await screen.findByRole("button", { name: /VT-0042.*In der Kommissionierung öffnen/ }));

    expect(spies.setWerkstattTab).toHaveBeenLastCalledWith("verteiler");
    expect(spies.setMainView).toHaveBeenLastCalledWith("werkstatt");
    expect(peekPendingPanel()).toBeNull();
  });
});

// ── Row caps of the other list widgets ──────────────────────────────────────

const TWELVE_ROWS: Array<[string, ComponentType<DashboardWidgetProps>, Record<string, Answer>]> = [
  ["Meine Ausleihen", MyCheckoutsWidget, { "/api/werkstatt/mobile/my-checkouts": range(12).map(checkout) }],
  [
    "Baustellenkisten",
    BoxesWidget,
    {
      "/api/werkstatt/boxes?status=gepackt&limit=50": range(6).map((n) => box(n, "gepackt")),
      "/api/werkstatt/boxes?status=zugewiesen&limit=50": range(6).map((n) => box(n + 6, "zugewiesen")),
    },
  ],
  ["Fällige Prüfungen", InspectionsWidget, { "/api/werkstatt/inspections/due": range(12).map((n) => inspection(n, n)) }],
];

describe.each(TWELVE_ROWS)("%s with twelve rows", (title, Component, answers) => {
  it.each([
    ["small", 3, "+9 weitere"],
    ["medium", 5, "+7 weitere"],
    ["large", 10, "+2 weitere"],
  ] as const)("shows %s: %i rows and „%s“", async (size, rows, more) => {
    serve(answers);

    renderWithContext(widget(Component, size));

    await waitFor(() => expect(rowsOf(title)).toHaveLength(rows));
    expect(within(region(title)).getByRole("button", { name: more })).toBeInTheDocument();
  });
});

// ── Every widget: nothing loaded is never a „0“ ─────────────────────────────

const ALL: Array<[string, ComponentType<DashboardWidgetProps>]> = [
  ["Lager-Kennzahlen", WerkstattKpisWidget],
  ["Nachbestellen", WerkstattReorderWidget],
  ["Auf Baustelle", WerkstattOnSiteWidget],
  ["Meine Ausleihen", MyCheckoutsWidget],
  ["Baustellenkisten", BoxesWidget],
  ["Fällige Prüfungen", InspectionsWidget],
  ["Zuletzt bearbeitete Verteiler", RecentPanelsWidget],
];

const EVERY_READ = [
  "/api/werkstatt/dashboard",
  "/api/werkstatt/mobile/my-checkouts",
  "/api/werkstatt/boxes",
  "/api/werkstatt/inspections/due",
  "/api/schaltplan/panels/recent",
];

describe.each(ALL)("%s while its data is null", (title, Component) => {
  it("shows skeleton rows and no digit while loading", async () => {
    const pending = held();
    serve(Object.fromEntries(EVERY_READ.map((path) => [path, pending.answer])));

    renderWithContext(widget(Component, "large"));

    const card = region(title);
    expect(card.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(card.textContent).not.toMatch(/\d/);
    await act(async () => pending.release(json({ detail: "spät" }, 500)));
  });

  it("shows the error and no digit after a failed load", async () => {
    serve(Object.fromEntries(EVERY_READ.map((path) => [path, { fail: 500 }])));

    renderWithContext(widget(Component, "large"));

    await waitFor(() => expect(within(region(title)).getByText("Konnte nicht geladen werden.")).toBeInTheDocument());
    expect(region(title).textContent).not.toMatch(/\d/);
  });
});

// ── Loaders ─────────────────────────────────────────────────────────────────

describe("WERKSTATT_WIDGET_LOADERS", () => {
  it("has exactly the seven Werkstatt widgets, each a component module", async () => {
    expect(Object.keys(WERKSTATT_WIDGET_LOADERS).sort()).toEqual(
      [
        "recent_panels",
        "werkstatt_boxes",
        "werkstatt_inspections",
        "werkstatt_kpis",
        "werkstatt_my_checkouts",
        "werkstatt_on_site",
        "werkstatt_reorder",
      ].sort(),
    );
    for (const load of Object.values(WERKSTATT_WIDGET_LOADERS)) {
      const module = await load!();
      expect(typeof module.default).toBe("function");
    }
  });
});
