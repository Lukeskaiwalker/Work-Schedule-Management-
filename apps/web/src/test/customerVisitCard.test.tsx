/**
 * The "Kundenbesuche" card of the customer page — the visit feed. What
 * must hold: the card fetches the customer's visits on mount and lists
 * them as given, newest first, each under "Besuch am <date> · <who went>"
 * (either half left out when the row has none) with a chip for the
 * project it belongs to or "Alle Projekte"; an empty feed says what
 * belongs here and offers to record one; Speichern trims, refuses an
 * empty summary without a request, POSTs summary, date and project_id
 * (null when unlinked) and puts the answer at the top; a failed post
 * keeps the form; Bearbeiten opens the form seeded with the row and
 * PATCHes only what the form holds; Löschen asks first and then DELETEs;
 * Bearbeiten and Löschen show only on own rows or for a manager; a
 * failed first load is shown with a retry.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { CustomerVisitCard } from "../components/customers/CustomerVisitCard";
import { apiFetch } from "../api/client";
import type { CustomerProjectSummary } from "../utils/customersApi";
import type { CustomerVisit } from "../types";

vi.mock("../api/client", () => ({ apiFetch: vi.fn() }));

const apiFetchMock = vi.mocked(apiFetch);

const CUSTOMER_ID = 7;
const TOKEN = "test-token";
const ME = { id: 1, email: "me@example.com", role: "employee", display_name: "Ich" };
const VISITS_PATH = `/customers/${CUSTOMER_ID}/visits`;
const EMPTY_TEXT =
  "Noch kein Besuch erfasst — was ein Termin beim Kunden ergeben hat, gehört hierher. Wird am Anfang des Projektberichts gedruckt.";
const UNLINKED_HINT = "Wird am Anfang jedes Projektberichts dieses Kunden gedruckt";

const PROJECTS: CustomerProjectSummary[] = [
  { id: 1, project_number: "2026-0001", name: "Müller Garage", status: "active", last_state: null, last_updated_at: null, customer_id: CUSTOMER_ID },
  { id: 2, project_number: "2026-0002", name: "Carport", status: "active", last_state: null, last_updated_at: null, customer_id: CUSTOMER_ID },
];

function visit(id: number, overrides: Partial<CustomerVisit> = {}): CustomerVisit {
  return {
    id,
    customer_id: CUSTOMER_ID,
    project_id: null,
    project_number: null,
    project_name: null,
    visit_date: null,
    visit_by_user_id: null,
    visit_by_name: null,
    summary: `Besuch ${id}`,
    created_at: "2026-09-18T09:30:00",
    updated_at: "2026-09-18T09:30:00",
    ...overrides,
  };
}

const ANNAS_LINKED = visit(12, {
  project_id: 1,
  project_number: "2026-0001",
  project_name: "Müller Garage",
  visit_date: "2026-09-12",
  visit_by_user_id: 3,
  visit_by_name: "Anna",
  summary: "Dach prüfen.\nZähler im Keller.",
});
const NOBODYS_UNLINKED = visit(11, { summary: "Ruft nur vormittags an." });
const MINE = visit(14, { visit_by_user_id: ME.id, visit_by_name: ME.display_name, visit_date: "2026-09-15", summary: "Eigener Besuch" });

type Routes = Record<string, (init?: { method?: string; body?: string }) => unknown>;

function routeApi(routes: Routes) {
  apiFetchMock.mockImplementation((async (path: string, _token: string | null, init?: { method?: string; body?: string }) => {
    const route = routes[path];
    if (!route) throw new Error(`unexpected apiFetch: ${path}`);
    return route(init);
  }) as typeof apiFetch);
}

function callsTo(path: string): number {
  return apiFetchMock.mock.calls.filter(([calledPath]) => calledPath === path).length;
}

function renderCard(overrides: Record<string, unknown> = {}) {
  const spies = { setNotice: vi.fn(), setError: vi.fn() };
  const context = makeAppContextStub({
    overrides: { user: ME, canCreateProject: false, ...spies, ...overrides },
  });
  render(
    <AppContext.Provider value={context as never}>
      <CustomerVisitCard customerId={CUSTOMER_ID} projects={PROJECTS} language="de" />
    </AppContext.Provider>,
  );
  return spies;
}

/** The feed holds `visits`; posts are answered by `created`. */
function feedOf(visits: () => CustomerVisit[], extra: Routes = {}) {
  routeApi({ [VISITS_PATH]: visits, ...extra });
}

function rows(): HTMLElement[] {
  return screen.getAllByRole("listitem");
}

function summaryField(): HTMLTextAreaElement {
  return screen.getByLabelText(/Zusammenfassung des Besuchs/) as HTMLTextAreaElement;
}

function bodyOfCall(path: string, method: string): unknown {
  const call = apiFetchMock.mock.calls.find(
    ([calledPath, , init]) => calledPath === path && (init as { method?: string } | undefined)?.method === method,
  );
  if (!call) throw new Error(`no ${method} ${path}`);
  return JSON.parse((call[2] as { body: string }).body);
}

beforeEach(() => {
  apiFetchMock.mockReset();
  vi.restoreAllMocks();
});

describe("CustomerVisitCard", () => {
  it("fetches the feed and lists it as given, with date, name and project chip where the row has them", async () => {
    feedOf(() => [ANNAS_LINKED, NOBODYS_UNLINKED]);
    renderCard();
    expect(screen.getByRole("heading", { level: 3, name: "Kundenbesuche" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Kundenbesuche werden geladen…");

    await screen.findByText(/Dach prüfen/);
    expect(apiFetchMock).toHaveBeenCalledWith(VISITS_PATH, TOKEN);
    const [first, second] = rows();
    expect(within(first).getByText("Besuch am 12.09.2026 · Anna")).toBeInTheDocument();
    expect(within(first).getByText("2026-0001")).toBeInTheDocument();
    // Line breaks survive as typed: the summary is one block, not split.
    expect(within(first).getByText(/Dach prüfen/).textContent).toBe(ANNAS_LINKED.summary);
    expect(within(second).getByText("Alle Projekte")).toBeInTheDocument();
    expect(within(second).queryByText(/Besuch am/)).not.toBeInTheDocument();
    expect(within(second).getByText("Ruft nur vormittags an.")).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_TEXT)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Besuch erfassen" })).toBeInTheDocument();
  });

  it("says what belongs here when nothing is recorded and offers to record a visit", async () => {
    feedOf(() => []);
    renderCard();
    await screen.findByText(EMPTY_TEXT);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Besuch erfassen" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Bearbeiten" })).not.toBeInTheDocument();
  });

  it("posts an unlinked visit, trimmed, with project_id null and puts it at the top", async () => {
    const created = visit(15, { visit_date: "2026-09-12", visit_by_user_id: ME.id, visit_by_name: ME.display_name, summary: "Dach prüfen" });
    feedOf(() => [NOBODYS_UNLINKED], { [VISITS_PATH]: (init) => (init?.method === "POST" ? created : [NOBODYS_UNLINKED]) });
    const { setNotice, setError } = renderCard();
    await screen.findByText("Ruft nur vormittags an.");

    fireEvent.click(screen.getByRole("button", { name: "Besuch erfassen" }));
    // The header's link gives way to the composer: one way in at a time.
    expect(screen.queryByRole("button", { name: "Besuch erfassen" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Besuch am/), { target: { value: "2026-09-12" } });
    fireEvent.change(summaryField(), { target: { value: "  Dach prüfen  " } });
    expect(screen.getByLabelText("Projekt")).toHaveValue("");
    expect(screen.getByText(UNLINKED_HINT)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await screen.findByText("Dach prüfen");
    expect(apiFetchMock).toHaveBeenCalledWith(VISITS_PATH, TOKEN, {
      method: "POST",
      body: JSON.stringify({ summary: "Dach prüfen", visit_date: "2026-09-12", project_id: null }),
    });
    expect(callsTo(VISITS_PATH)).toBe(2);
    expect(rows()[0]).toHaveTextContent("Besuch am 12.09.2026 · Ich");
    expect(rows()[0]).toHaveTextContent("Dach prüfen");
    expect(rows()[1]).toHaveTextContent("Ruft nur vormittags an.");
    expect(setNotice).toHaveBeenCalledWith("Kundenbesuch gespeichert");
    expect(setError).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/Zusammenfassung des Besuchs/)).not.toBeInTheDocument();
  });

  it("offers the customer's projects, names the chosen one in the hint and posts its id", async () => {
    const created = visit(15, { project_id: 2, project_number: "2026-0002", project_name: "Carport", summary: "Fundament ansehen" });
    feedOf(() => [], { [VISITS_PATH]: (init) => (init?.method === "POST" ? created : []) });
    renderCard();
    await screen.findByText(EMPTY_TEXT);

    fireEvent.click(screen.getByRole("button", { name: "Besuch erfassen" }));
    const project = screen.getByLabelText("Projekt") as HTMLSelectElement;
    expect(Array.from(project.options).map((option) => option.textContent)).toEqual([
      "Alle Projekte dieses Kunden",
      "2026-0001 · Müller Garage",
      "2026-0002 · Carport",
    ]);
    fireEvent.change(project, { target: { value: "2" } });
    expect(screen.getByText("Wird am Anfang des Projektberichts von 2026-0002 gedruckt")).toBeInTheDocument();
    fireEvent.change(summaryField(), { target: { value: "Fundament ansehen" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await screen.findByText("Fundament ansehen");
    expect(bodyOfCall(VISITS_PATH, "POST")).toEqual({ summary: "Fundament ansehen", visit_date: null, project_id: 2 });
    expect(within(rows()[0]).getByText("2026-0002")).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_TEXT)).not.toBeInTheDocument();
  });

  it("refuses an empty summary without a request and keeps the form open when the post fails", async () => {
    feedOf(() => [], {
      [VISITS_PATH]: (init) => {
        if (init?.method === "POST") throw new Error("Nicht erreichbar");
        return [];
      },
    });
    const { setError, setNotice } = renderCard();
    await screen.findByText(EMPTY_TEXT);

    fireEvent.click(screen.getByRole("button", { name: "Besuch erfassen" }));
    fireEvent.change(summaryField(), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(setError).toHaveBeenCalledWith("Bitte eine Zusammenfassung des Besuchs eintragen");
    expect(callsTo(VISITS_PATH)).toBe(1);

    fireEvent.change(summaryField(), { target: { value: "Bleibt stehen" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(setError).toHaveBeenCalledWith("Nicht erreichbar"));
    expect(summaryField().value).toBe("Bleibt stehen");
    expect(setNotice).not.toHaveBeenCalled();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("opens Bearbeiten seeded with the row, PATCHes only what the form holds and replaces the row", async () => {
    const updated = { ...MINE, summary: "Eigener Besuch, ergänzt", visit_date: "2026-09-16", project_id: 1, project_number: "2026-0001", project_name: "Müller Garage" };
    feedOf(() => [MINE, NOBODYS_UNLINKED], { [`${VISITS_PATH}/14`]: () => updated });
    const { setNotice } = renderCard();
    await screen.findByText("Eigener Besuch");

    fireEvent.click(within(rows()[0]).getByRole("button", { name: "Bearbeiten" }));
    expect(screen.getByLabelText(/Besuch am/)).toHaveValue("2026-09-15");
    expect(screen.getByLabelText("Projekt")).toHaveValue("");
    expect(summaryField()).toHaveValue("Eigener Besuch");

    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(screen.queryByLabelText(/Zusammenfassung des Besuchs/)).not.toBeInTheDocument();
    expect(callsTo(`${VISITS_PATH}/14`)).toBe(0);

    fireEvent.click(within(rows()[0]).getByRole("button", { name: "Bearbeiten" }));
    fireEvent.change(screen.getByLabelText(/Besuch am/), { target: { value: "2026-09-16" } });
    fireEvent.change(screen.getByLabelText("Projekt"), { target: { value: "1" } });
    fireEvent.change(summaryField(), { target: { value: " Eigener Besuch, ergänzt " } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await screen.findByText("Eigener Besuch, ergänzt");
    expect(apiFetchMock).toHaveBeenCalledWith(`${VISITS_PATH}/14`, TOKEN, {
      method: "PATCH",
      body: JSON.stringify({ summary: "Eigener Besuch, ergänzt", visit_date: "2026-09-16", project_id: 1 }),
    });
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toHaveTextContent("Besuch am 16.09.2026 · Ich");
    expect(within(rows()[0]).getByText("2026-0001")).toBeInTheDocument();
    expect(setNotice).toHaveBeenCalledWith("Kundenbesuch gespeichert");
    // The feed was not fetched again: the answer replaced the row in place.
    expect(callsTo(VISITS_PATH)).toBe(1);
  });

  it("deletes after confirmation and drops the row; a cancelled confirm sends nothing", async () => {
    feedOf(() => [MINE, NOBODYS_UNLINKED], { [`${VISITS_PATH}/14`]: () => undefined });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { setNotice } = renderCard();
    await screen.findByText("Eigener Besuch");

    fireEvent.click(screen.getByRole("button", { name: "Löschen" }));
    expect(confirmSpy).toHaveBeenCalledWith("Diesen Kundenbesuch löschen?");
    expect(callsTo(`${VISITS_PATH}/14`)).toBe(0);

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Löschen" }));
    await waitFor(() => expect(screen.queryByText("Eigener Besuch")).not.toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledWith(`${VISITS_PATH}/14`, TOKEN, { method: "DELETE" });
    expect(rows()).toHaveLength(1);
    expect(screen.getByText("Ruft nur vormittags an.")).toBeInTheDocument();
    expect(setNotice).toHaveBeenCalledWith("Kundenbesuch gelöscht");
    expect(callsTo(VISITS_PATH)).toBe(1);
  });

  it("shows Bearbeiten and Löschen only on own rows, or on every row for a manager", async () => {
    feedOf(() => [MINE, ANNAS_LINKED, NOBODYS_UNLINKED]);
    renderCard();
    await screen.findByText("Eigener Besuch");

    const [mineRow, annasRow, orphanRow] = rows();
    expect(within(mineRow).getByRole("button", { name: "Bearbeiten" })).toBeInTheDocument();
    expect(within(mineRow).getByRole("button", { name: "Löschen" })).toBeInTheDocument();
    expect(within(annasRow).queryByRole("button", { name: "Bearbeiten" })).not.toBeInTheDocument();
    expect(within(annasRow).queryByRole("button", { name: "Löschen" })).not.toBeInTheDocument();
    expect(within(orphanRow).queryByRole("button", { name: "Bearbeiten" })).not.toBeInTheDocument();
    expect(within(orphanRow).queryByRole("button", { name: "Löschen" })).not.toBeInTheDocument();
  });

  it("lets a manager edit and delete any row, the orphaned one included", async () => {
    feedOf(() => [ANNAS_LINKED, NOBODYS_UNLINKED]);
    renderCard({ canCreateProject: true });
    await screen.findByText(/Dach prüfen/);
    expect(screen.getAllByRole("button", { name: "Bearbeiten" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Löschen" })).toHaveLength(2);
  });

  it("shows a failed load in the API's words and fetches again on retry", async () => {
    let fails = true;
    feedOf(() => {
      if (fails) throw new Error("Nicht erreichbar");
      return [NOBODYS_UNLINKED];
    });
    renderCard();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Kundenbesuche konnten nicht geladen werden.");
    expect(alert).toHaveTextContent("Nicht erreichbar");
    expect(screen.queryByRole("button", { name: "Besuch erfassen" })).not.toBeInTheDocument();

    fails = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Erneut versuchen" }));
    await screen.findByText("Ruft nur vormittags an.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(callsTo(VISITS_PATH)).toBe(2);
  });
});
