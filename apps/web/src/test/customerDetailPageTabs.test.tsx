/**
 * The customer page's tabs. What must hold: the page opens on Übersicht
 * with the five tabs and only the overview's cards mounted — the tasks,
 * reports, boxes, files and activity requests are not made; a click on
 * Dateien mounts the files card (its requests fire) and unmounts the
 * overview; the chosen tab is remembered in sessionStorage for the session
 * and read back on mount, an unknown value falling back to Übersicht; a
 * change of customer keeps the remembered tab and returns to Übersicht only
 * when nothing is remembered; the arrow keys move the choice along the
 * strip; Berichte & Kisten shows both cards in one panel; the strip wraps
 * rather than clips; and the page survives being hidden and shown again on
 * the same instance.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { CustomerDetailPage } from "../pages/CustomerDetailPage";
import { CUSTOMER_TAB_STORAGE_KEY } from "../components/customers/CustomerDetailTabs";
import { apiFetch } from "../api/client";
import type { CustomerListItem } from "../types";

vi.mock("../api/client", () => ({
  apiFetch: vi.fn(),
  apiUploadWithProgress: vi.fn(),
  // The reports and boxes cards ask `instanceof ApiError` when a request
  // fails. None below does, but the name has to resolve to a class.
  ApiError: class ApiError extends Error {},
}));

const apiFetchMock = vi.mocked(apiFetch);

const TOKEN = "test-token";
const TASKS_PATH = "/tasks?view=all_open&customer_id=7";
const REPORTS_PATH = "/customers/7/construction-reports";
const BOXES_PATH = "/customers/7/boxes";
const FILES_PATH = "/customers/7/files";
const FOLDERS_PATH = "/customers/7/folders";
const ACTIVITY_PATH = "/customers/7/activity?limit=30";
const NOTES_PATH = "/customers/7/notes?limit=20";
/** What the panels other than Übersicht request on mount. */
const OFF_OVERVIEW_PATHS = [TASKS_PATH, REPORTS_PATH, BOXES_PATH, FILES_PATH, FOLDERS_PATH, ACTIVITY_PATH];

function customer(id: number, name: string): CustomerListItem {
  return {
    id,
    name,
    address: "Hauptstraße 1, 12345 Musterstadt",
    contact_person: "Max Müller",
    email: null,
    phone: null,
    tax_id: null,
    notes: "Ruft nur vormittags an.",
    birthday: null,
    marktakteur_nummer: null,
    archived_at: null,
    created_by: 1,
    created_at: "2026-09-01T08:00:00",
    updated_at: "2026-09-01T08:00:00",
    project_count: 1,
    active_project_count: 1,
    last_project_activity_at: null,
  };
}

const MUELLER = customer(7, "Müller GmbH");
const PROJECTS = [
  { id: 1, project_number: "2026-0001", name: "Müller Garage", status: "active", last_state: null, last_updated_at: null, customer_id: 7 },
];

type Routes = Record<string, () => unknown>;

/** Every request the page and its panels can make for customer `id`. */
function routesFor(id: number, detail: CustomerListItem): Routes {
  return {
    [`/customers/${id}`]: () => detail,
    [`/customers/${id}/projects`]: () => PROJECTS,
    [`/customers/${id}/files`]: () => [],
    [`/customers/${id}/folders`]: () => [],
    [`/tasks?view=all_open&customer_id=${id}`]: () => [],
    [`/customers/${id}/construction-reports`]: () => [],
    [`/customers/${id}/boxes`]: () => [],
    [`/customers/${id}/activity?limit=30`]: () => [],
    // The old notes text is the feed's first entry (migration 0092).
    [`/customers/${id}/notes?limit=20`]: () => [
      { id: 1, customer_id: id, author_user_id: null, author_name: null, body: detail.notes, created_at: "2026-09-01T08:00:00" },
    ],
    [`/customers/${id}/visits`]: () => [],
  };
}

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

function makeContext(overrides: Record<string, unknown> = {}): unknown {
  return makeAppContextStub({
    overrides: { mainView: "customer_detail", activeCustomerId: 7, customers: [], ...overrides },
  });
}

function pageWith(context: unknown) {
  return (
    <AppContext.Provider value={context as never}>
      <CustomerDetailPage />
    </AppContext.Provider>
  );
}

function page(overrides: Record<string, unknown> = {}) {
  return pageWith(makeContext(overrides));
}

function strip(): HTMLElement {
  return screen.getByRole("tablist", { name: "Kundenbereiche" });
}

function tab(name: string): HTMLElement {
  return within(strip()).getByRole("tab", { name });
}

function selectedTab(): string {
  return within(strip()).getByRole("tab", { selected: true }).textContent ?? "";
}

function findContactCard() {
  return screen.findByRole("heading", { level: 3, name: "Kontaktdaten" });
}

beforeEach(() => {
  apiFetchMock.mockReset();
  routeApi(routesFor(7, MUELLER));
  window.sessionStorage.clear();
});

describe("CustomerDetailPage tabs", () => {
  it("opens on Übersicht with the five tabs and only the overview's cards mounted", async () => {
    render(page());
    await screen.findByRole("heading", { level: 2, name: "Müller GmbH" });

    expect(within(strip()).getAllByRole("tab").map((item) => item.textContent)).toEqual([
      "Übersicht",
      "Aufgaben",
      "Berichte & Kisten",
      "Dateien",
      "Änderungen",
    ]);
    expect(selectedTab()).toBe("Übersicht");
    expect(screen.getByRole("tabpanel", { name: "Übersicht" })).toBeInTheDocument();

    // Kontaktdaten, the visit feed, the note feed and Projekte with its own
    // filter: the overview.
    expect(screen.getByRole("heading", { level: 3, name: "Kontaktdaten" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Kundenbesuche" })).toBeInTheDocument();
    expect(await screen.findByText("Ruft nur vormittags an.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: /^Notizen/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: /^Projekte/ })).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Projektfilter" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Müller Garage/ })).toBeInTheDocument();

    expect(apiFetchMock).toHaveBeenCalledWith("/customers/7", TOKEN);
    expect(apiFetchMock).toHaveBeenCalledWith("/customers/7/projects", TOKEN);
    expect(apiFetchMock).toHaveBeenCalledWith(NOTES_PATH, TOKEN);
    expect(apiFetchMock).toHaveBeenCalledWith("/customers/7/visits", TOKEN);
    // Nothing of the other panels is fetched while they are closed.
    OFF_OVERVIEW_PATHS.forEach((path) => expect(callsTo(path)).toBe(0));
  });

  it("mounts the files card on Dateien, with its requests, and unmounts the overview", async () => {
    render(page());
    await findContactCard();

    fireEvent.click(tab("Dateien"));
    await screen.findByRole("heading", { level: 3, name: /^Dateien/ });
    expect(selectedTab()).toBe("Dateien");
    expect(screen.getByRole("tabpanel", { name: "Dateien" })).toBeInTheDocument();
    expect(callsTo(FILES_PATH)).toBe(1);
    expect(callsTo(FOLDERS_PATH)).toBe(1);

    expect(screen.queryByRole("heading", { level: 3, name: "Kontaktdaten" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "Projektfilter" })).not.toBeInTheDocument();
    expect(callsTo(TASKS_PATH)).toBe(0);
    expect(callsTo(ACTIVITY_PATH)).toBe(0);
  });

  it("remembers the chosen tab for the session and reads it back on mount", async () => {
    const context = makeContext();
    const { rerender, unmount } = render(pageWith(context));
    await findContactCard();

    fireEvent.click(tab("Aufgaben"));
    await screen.findByRole("heading", { level: 3, name: /^Kundenaufgaben/ });
    expect(window.sessionStorage.getItem(CUSTOMER_TAB_STORAGE_KEY)).toBe("tasks");

    rerender(pageWith(context));
    expect(selectedTab()).toBe("Aufgaben");
    expect(screen.getByRole("heading", { level: 3, name: /^Kundenaufgaben/ })).toBeInTheDocument();

    // A fresh mount in the same session lands on the remembered tab.
    unmount();
    render(page());
    await screen.findByRole("heading", { level: 3, name: /^Kundenaufgaben/ });
    expect(selectedTab()).toBe("Aufgaben");
    expect(screen.queryByRole("heading", { level: 3, name: "Kontaktdaten" })).not.toBeInTheDocument();
  });

  it("falls back to Übersicht when the remembered tab is unknown", async () => {
    window.sessionStorage.setItem(CUSTOMER_TAB_STORAGE_KEY, "bogus");
    render(page());
    await findContactCard();
    expect(selectedTab()).toBe("Übersicht");
  });

  it("keeps the remembered tab across customers, and returns to Übersicht only when nothing is remembered", async () => {
    routeApi({
      ...routesFor(7, MUELLER),
      ...routesFor(8, customer(8, "Schulze KG")),
      ...routesFor(9, customer(9, "Weber AG")),
    });
    const { rerender } = render(page());
    await findContactCard();
    fireEvent.click(tab("Dateien"));
    await screen.findByRole("heading", { level: 3, name: /^Dateien/ });

    rerender(page({ activeCustomerId: 8 }));
    await screen.findByRole("heading", { level: 2, name: "Schulze KG" });
    expect(selectedTab()).toBe("Dateien");
    await waitFor(() => expect(callsTo("/customers/8/files")).toBe(1));

    window.sessionStorage.removeItem(CUSTOMER_TAB_STORAGE_KEY);
    rerender(page({ activeCustomerId: 9 }));
    await screen.findByRole("heading", { level: 2, name: "Weber AG" });
    expect(selectedTab()).toBe("Übersicht");
    expect(await findContactCard()).toBeInTheDocument();
  });

  it("moves the choice along the strip with the arrow keys, Home and End", async () => {
    render(page());
    await findContactCard();

    const overview = tab("Übersicht");
    overview.focus();
    fireEvent.keyDown(overview, { key: "ArrowRight" });
    expect(selectedTab()).toBe("Aufgaben");
    expect(tab("Aufgaben")).toHaveFocus();
    // Roving tabindex: only the chosen tab is in the Tab order.
    expect(tab("Aufgaben")).toHaveAttribute("tabindex", "0");
    expect(tab("Übersicht")).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(tab("Aufgaben"), { key: "End" });
    expect(selectedTab()).toBe("Änderungen");
    fireEvent.keyDown(tab("Änderungen"), { key: "ArrowRight" });
    expect(selectedTab()).toBe("Übersicht");
    fireEvent.keyDown(tab("Übersicht"), { key: "ArrowLeft" });
    expect(selectedTab()).toBe("Änderungen");
    fireEvent.keyDown(tab("Änderungen"), { key: "Home" });
    expect(selectedTab()).toBe("Übersicht");
    expect(tab("Übersicht")).toHaveFocus();
    expect(await findContactCard()).toBeInTheDocument();
  });

  it("shows Baustellenberichte and Baustellenkisten together on Berichte & Kisten", async () => {
    render(page());
    await findContactCard();

    fireEvent.click(tab("Berichte & Kisten"));
    const panel = screen.getByRole("tabpanel", { name: "Berichte & Kisten" });
    expect(panel).toHaveClass("customer-tab-panel--reports");
    expect(
      await within(panel).findByRole("heading", { level: 3, name: "Baustellenberichte" }),
    ).toBeInTheDocument();
    expect(within(panel).getByRole("heading", { level: 3, name: "Baustellenkisten" })).toBeInTheDocument();
    await waitFor(() => expect(callsTo(REPORTS_PATH)).toBe(1));
    expect(callsTo(BOXES_PATH)).toBe(1);
  });

  it("wraps its strip rather than clipping it on narrow screens", async () => {
    render(page());
    await findContactCard();
    expect(strip()).toHaveClass("customer-detail-tabs--wrap");
  });

  it("survives being hidden and shown again on the same instance", async () => {
    const shown = makeContext();
    const hidden = makeContext({ mainView: "customers" });
    const { container, rerender } = render(pageWith(shown));
    await findContactCard();

    rerender(pageWith(hidden));
    expect(container).toBeEmptyDOMElement();
    rerender(pageWith(shown));
    expect(await findContactCard()).toBeInTheDocument();
  });
});
