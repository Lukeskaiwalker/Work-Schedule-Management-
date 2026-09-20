/**
 * The "Letzte Änderungen" card of the customer page. What must hold: it
 * loads the customer's merged log for the id it was given; each project
 * row shows the event's label, time and actor, the message and a chip
 * naming the project, and the customer's own rows the same without a chip;
 * the chip opens that project from the customer page; "Mehr laden" hands
 * the last row's cursor back and disappears once a page comes back short
 * or its last row has no cursor; a failed load is shown with a retry; an
 * empty log says so; and another customer id starts the feed afresh.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { CustomerActivityCard } from "../components/customers/CustomerActivityCard";
import { apiFetch } from "../api/client";
import type { CustomerActivity } from "../types";

vi.mock("../api/client", () => ({ apiFetch: vi.fn() }));

const apiFetchMock = vi.mocked(apiFetch);

const CUSTOMER_ID = 7;
const TOKEN = "test-token";
const PAGE_SIZE = 30;
const FIRST_PAGE_PATH = `/customers/${CUSTOMER_ID}/activity?limit=${PAGE_SIZE}`;

function activity(id: number, overrides: Partial<CustomerActivity> = {}): CustomerActivity {
  return {
    id,
    project_id: 1,
    actor_user_id: 3,
    actor_name: "Anna Admin",
    event_type: "task.created",
    message: `Task created: Aufgabe ${id}`,
    details: {},
    created_at: "2026-09-18T09:30:00",
    project_number: "2026-0001",
    project_name: "Müller",
    source: "project",
    cursor: `c${id}`,
    ...overrides,
  };
}

/** One of the customer's own events: no project behind it. */
function customerEvent(id: number, overrides: Partial<CustomerActivity> = {}): CustomerActivity {
  return activity(id, {
    source: "customer",
    project_id: null,
    project_number: null,
    project_name: null,
    customer_id: CUSTOMER_ID,
    ...overrides,
  });
}

const TASK_IN_MUELLER = activity(42);
const FILE_IN_GARAGE = activity(41, {
  project_id: 2,
  project_number: "2026-0002",
  project_name: "Müller Garage",
  event_type: "file.uploaded",
  message: "File uploaded: plan.pdf",
  actor_name: "Bernd Bau",
  created_at: "2026-09-17T16:05:00",
});
const NOTE_WITHOUT_ACTOR = activity(40, {
  event_type: "project.note_posted",
  message: "Kunde ruft zurück",
  actor_name: null,
});

/** Ids counting down from `firstId`: a page the server would return. */
function page(firstId: number, length: number): CustomerActivity[] {
  return Array.from({ length }, (_, index) => activity(firstId - index));
}

type Routes = Record<string, () => unknown>;

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

function renderCard(customerId = CUSTOMER_ID) {
  const openProjectById = vi.fn();
  const context = makeAppContextStub({ overrides: { openProjectById } });
  const view = render(
    <AppContext.Provider value={context as never}>
      <CustomerActivityCard customerId={customerId} />
    </AppContext.Provider>,
  );
  return { openProjectById, ...view };
}

function rowTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".customer-activity-row")).map((row) => row.textContent ?? "");
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe("CustomerActivityCard", () => {
  it("loads the customer's log and renders label, time, actor, message and project chip", async () => {
    routeApi({ [FIRST_PAGE_PATH]: () => [TASK_IN_MUELLER, FILE_IN_GARAGE, NOTE_WITHOUT_ACTOR] });
    const { container } = renderCard();
    expect(screen.getByRole("status")).toHaveTextContent("Änderungen werden geladen…");

    await screen.findByText("Task created: Aufgabe 42");
    expect(apiFetchMock).toHaveBeenCalledWith(FIRST_PAGE_PATH, TOKEN);
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("Letzte Änderungen");
    expect(screen.getByText("der Kunde und alle seine Projekte")).toBeInTheDocument();

    const rows = container.querySelectorAll(".customer-activity-row");
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByText("Aufgabe erstellt")).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent("· Anna Admin");
    expect(within(rows[0] as HTMLElement).getByRole("button", { name: "2026-0001 · Müller" })).toBeInTheDocument();

    expect(within(rows[1] as HTMLElement).getByText("Datei hochgeladen")).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent("· Bernd Bau");
    expect(rows[1]).toHaveTextContent("File uploaded: plan.pdf");
    expect(within(rows[1] as HTMLElement).getByRole("button", { name: "2026-0002 · Müller Garage" })).toBeInTheDocument();

    // No actor: the time stands alone, without a dangling separator.
    expect(within(rows[2] as HTMLElement).getByText("Notiz gepostet")).toBeInTheDocument();
    expect(rows[2]).not.toHaveTextContent("·  ");
    expect(rows[2]).toHaveTextContent("Kunde ruft zurück");

    // Three rows is a short page: nothing more to load.
    expect(screen.queryByRole("button", { name: "Mehr laden" })).not.toBeInTheDocument();
  });

  it("renders the customer's own events without a project chip", async () => {
    const visit = customerEvent(50, { event_type: "customer.visit_posted", message: "Kundenbesuch: Dach prüfen" });
    const archived = customerEvent(49, { event_type: "customer.archived", message: "Archiviert: Müller GmbH", actor_name: null });
    routeApi({ [FIRST_PAGE_PATH]: () => [visit, TASK_IN_MUELLER, archived] });
    const { container } = renderCard();

    await screen.findByText("Kundenbesuch: Dach prüfen");
    const rows = container.querySelectorAll(".customer-activity-row");
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByText("Kundenbesuch erfasst")).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent("· Anna Admin");
    expect(within(rows[0] as HTMLElement).queryByRole("button")).not.toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByRole("button", { name: "2026-0001 · Müller" })).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText("Kunde archiviert")).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).queryByRole("button")).not.toBeInTheDocument();
  });

  it("opens the row's project from the customer page when the chip is clicked", async () => {
    routeApi({ [FIRST_PAGE_PATH]: () => [FILE_IN_GARAGE] });
    const { openProjectById } = renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "2026-0002 · Müller Garage" }));
    expect(openProjectById).toHaveBeenCalledWith(2, "customer_detail");
  });

  it("loads more after the last row and stops offering once a page comes back short", async () => {
    const firstPage = page(130, PAGE_SIZE);
    const secondPage = page(100, 2);
    const secondPagePath = `${FIRST_PAGE_PATH}&cursor=c101`;
    routeApi({ [FIRST_PAGE_PATH]: () => firstPage, [secondPagePath]: () => secondPage });
    const { container } = renderCard();

    const more = await screen.findByRole("button", { name: "Mehr laden" });
    expect(rowTexts(container)).toHaveLength(PAGE_SIZE);

    fireEvent.click(more);
    await screen.findByText("Task created: Aufgabe 99");
    expect(apiFetchMock).toHaveBeenCalledWith(secondPagePath, TOKEN);
    expect(callsTo(FIRST_PAGE_PATH)).toBe(1);

    // Appended in order, nothing repeated, and the offer is gone.
    const texts = rowTexts(container);
    expect(texts).toHaveLength(PAGE_SIZE + 2);
    expect(texts[0]).toContain("Aufgabe 130");
    expect(texts[PAGE_SIZE]).toContain("Aufgabe 100");
    expect(texts[PAGE_SIZE + 1]).toContain("Aufgabe 99");
    expect(screen.queryByRole("button", { name: "Mehr laden" })).not.toBeInTheDocument();
  });

  it("does not offer more when the last row of a full page carries no cursor", async () => {
    const page = Array.from({ length: PAGE_SIZE }, (_, index) => activity(130 - index, { cursor: undefined }));
    routeApi({ [FIRST_PAGE_PATH]: () => page });
    const { container } = renderCard();

    await screen.findByText("Task created: Aufgabe 130");
    expect(rowTexts(container)).toHaveLength(PAGE_SIZE);
    expect(screen.queryByRole("button", { name: "Mehr laden" })).not.toBeInTheDocument();
  });

  it("shows a failed load in the API's words and reloads on retry", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("Nicht erreichbar"));
    renderCard();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Änderungen konnten nicht geladen werden.");
    expect(alert).toHaveTextContent("Nicht erreichbar");

    routeApi({ [FIRST_PAGE_PATH]: () => [TASK_IN_MUELLER] });
    fireEvent.click(within(alert).getByRole("button", { name: "Erneut versuchen" }));

    await screen.findByText("Task created: Aufgabe 42");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(callsTo(FIRST_PAGE_PATH)).toBe(2);
  });

  it("keeps the rows it has when loading more fails, and retries that page", async () => {
    const secondPagePath = `${FIRST_PAGE_PATH}&cursor=c101`;
    let secondPageFails = true;
    routeApi({
      [FIRST_PAGE_PATH]: () => page(130, PAGE_SIZE),
      [secondPagePath]: () => {
        if (secondPageFails) throw new Error("Zeitüberschreitung");
        return page(100, 1);
      },
    });
    const { container } = renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "Mehr laden" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Weitere Änderungen konnten nicht geladen werden.");
    expect(rowTexts(container)).toHaveLength(PAGE_SIZE);

    secondPageFails = false;
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    await screen.findByText("Task created: Aufgabe 100");
    expect(callsTo(secondPagePath)).toBe(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says so when the customer's projects have no changes yet", async () => {
    routeApi({ [FIRST_PAGE_PATH]: () => [] });
    renderCard();

    await screen.findByText("Noch keine Änderungen bei diesem Kunden.");
    expect(screen.queryByRole("button", { name: "Mehr laden" })).not.toBeInTheDocument();
  });

  it("starts afresh for another customer id", async () => {
    const otherPath = `/customers/8/activity?limit=${PAGE_SIZE}`;
    routeApi({
      [FIRST_PAGE_PATH]: () => [TASK_IN_MUELLER],
      [otherPath]: () => [activity(9, { message: "Task created: Beim Nachbarn" })],
    });
    const context = makeAppContextStub({ overrides: { openProjectById: vi.fn() } });
    const { rerender } = render(
      <AppContext.Provider value={context as never}>
        <CustomerActivityCard customerId={CUSTOMER_ID} />
      </AppContext.Provider>,
    );
    await screen.findByText("Task created: Aufgabe 42");

    rerender(
      <AppContext.Provider value={context as never}>
        <CustomerActivityCard customerId={8} />
      </AppContext.Provider>,
    );
    await screen.findByText("Task created: Beim Nachbarn");
    await waitFor(() => expect(screen.queryByText("Task created: Aufgabe 42")).not.toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledWith(otherPath, TOKEN);
  });
});
