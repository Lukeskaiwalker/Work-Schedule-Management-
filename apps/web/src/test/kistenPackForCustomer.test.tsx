/**
 * Packing a crate for a customer, and for the site it is going to.
 *
 * K5 could not be packed for customer 210 (an invented "Mustermann, Erika" here), project 293:
 *
 *  * the picker filtered a customer list capped at 200 and never found her,
 *  * its "+ Neuen Kunden anlegen" row did nothing on this page — a dead end
 *    that looked like a way out,
 *  * and the page could not name a project at all, so every handover was
 *    booked without a site and never showed up under "Auf der Baustelle".
 *
 * The stub answers the box endpoints the way the API does and records every
 * pack body, because the body is the contract: {customer_id, project_id}.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { WerkstattKistenPage } from "../pages/werkstatt/WerkstattKistenPage";
import { MUSTERMANN_ID, customerRow, productionLikeCustomers } from "./fixtures/customerServer";
import type { CustomerListItem, Project } from "../types";

const MUSTERMANN_PROJECT_ID = 293;

function project(
  id: number,
  projectNumber: string,
  name: string,
  customerId: number,
  status = "In Durchführung",
): Project {
  return { id, project_number: projectNumber, name, status, customer_id: customerId };
}

/**
 * Mustermann has two open jobs and an archived one; customer 5 has exactly one
 * open job (and an archived one); customer 7 has two; somebody else has one.
 */
const PROJECTS: Project[] = [
  project(MUSTERMANN_PROJECT_ID, "367", "Wallbox Garage", MUSTERMANN_ID),
  project(296, "371", "Zählerschrank Altbau", MUSTERMANN_ID, "Angebot"),
  project(297, "301", "Kellersanierung", MUSTERMANN_ID, "Archiviert"),
  project(405, "405", "PV Dach", 5),
  project(406, "212", "Hausanschluss", 5, "archived"),
  project(501, "501", "Ladepark Halle 1", 7),
  project(502, "502", "Ladepark Halle 2", 7),
  project(600, "600", "Fremdes Projekt", 99),
];

type CrateItem = {
  id: number;
  box_id: number;
  source: string;
  article_id: number | null;
  catalog_external_key: string | null;
  item_name: string;
  article_no: string | null;
  ean: string | null;
  unit: string | null;
  quantity: number;
  notes: string | null;
};

const ITEM: CrateItem = {
  id: 1,
  box_id: 55,
  source: "article",
  article_id: 9,
  catalog_external_key: null,
  item_name: "Wallbox 11 kW",
  article_no: "SP-0009",
  ean: null,
  unit: "Stk",
  quantity: 1,
  notes: null,
};

type Crate = {
  id: number;
  box_number: string;
  label: string;
  slot: number | null;
  status: string;
  customer_id: number | null;
  customer_name: string | null;
  project_id: number | null;
  project_name: string | null;
  item_count: number;
  packed_at: string | null;
  assigned_at: string | null;
  returned_at: string | null;
  notes: string | null;
  items: CrateItem[];
};

/** K5 as it stood in production: open, nobody's, seven lines in it (one is enough here). */
function k5(extra: Partial<Crate> = {}): Crate {
  return {
    id: 55,
    box_number: "K5",
    label: "Kiste 5",
    slot: 5,
    status: "offen",
    customer_id: null,
    customer_name: null,
    project_id: null,
    project_name: null,
    item_count: 1,
    packed_at: null,
    assigned_at: null,
    returned_at: null,
    notes: null,
    items: [ITEM],
    ...extra,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The box endpoints this page calls, with the crate's state kept between calls. */
function serveCrate(initial: Crate) {
  let crate = initial;
  const packBodies: unknown[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    if (method === "POST" && path === `/api/werkstatt/boxes/${crate.id}/pack`) {
      const body = JSON.parse(String(init?.body)) as { customer_id: number; project_id: number | null };
      packBodies.push(body);
      crate = { ...crate, status: "gepackt", customer_id: body.customer_id, project_id: body.project_id };
      return json(crate);
    }
    if (method === "POST" && path === `/api/werkstatt/boxes/${crate.id}/status`) {
      const body = JSON.parse(String(init?.body)) as { status: string };
      // Every way back to offen frees the crate (services/werkstatt_boxes.py).
      crate =
        body.status === "offen"
          ? { ...crate, status: "offen", customer_id: null, customer_name: null, project_id: null, project_name: null }
          : { ...crate, status: body.status };
      return json(crate);
    }
    if (method === "POST" && path === `/api/werkstatt/boxes/${crate.id}/items`) {
      const body = JSON.parse(String(init?.body)) as { item_name: string };
      const line = { ...ITEM, id: crate.items.length + 1, source: "manual", article_id: null, item_name: body.item_name };
      crate = { ...crate, items: [...crate.items, line], item_count: crate.items.length + 1 };
      return json(line, 201);
    }
    if (path === "/api/werkstatt/item-search") return json([]);
    if (path === "/api/werkstatt/boxes") return json([crate]);
    if (path === `/api/werkstatt/boxes/${crate.id}`) return json(crate);
    return json({ detail: `unexpected ${method} ${path}` }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, packBodies };
}

/** GET /projects answers this user with every project (projects:manage). */
const OFFICE_USER = { id: 1, email: "buero@example.com", role: "admin", display_name: "Büro", effective_permissions: ["projects:view", "projects:manage"] };
/**
 * A packer: role employee, projects:view only. GET /projects answers them with
 * the jobs they are a member of or have a task on, not with every job.
 */
const PACKER = { id: 2, email: "lager@example.com", role: "employee", display_name: "Lager", effective_permissions: ["projects:view", "werkstatt:view"] };

type Mount = {
  user?: Record<string, unknown>;
  customers?: CustomerListItem[];
  projects?: Project[];
  searchCustomers?: (query: string) => Promise<CustomerListItem[]>;
  reloadCustomers?: () => Promise<void>;
};

/** Render the page with `crate` on the rack and open it. */
async function openCrate(crate: Crate, mount: Mount = {}) {
  const server = serveCrate(crate);
  render(
    <AppContext.Provider
      value={
        makeAppContextStub({
          overrides: {
            mainView: "werkstatt",
            werkstattTab: "kisten",
            language: "de",
            token: "test-token",
            user: mount.user ?? OFFICE_USER,
            customers: mount.customers ?? productionLikeCustomers(222),
            projects: mount.projects ?? PROJECTS,
            searchCustomers: mount.searchCustomers ?? (async () => []),
            reloadCustomers: mount.reloadCustomers ?? (async () => undefined),
          },
        }) as never
      }
    >
      <WerkstattKistenPage />
    </AppContext.Provider>,
  );
  fireEvent.click(await screen.findByText(crate.label));
  await screen.findByText(`Inhalt (${crate.items.length})`);
  return server;
}

function customerInput(): HTMLInputElement {
  return screen.getByPlaceholderText("Kunde wählen…") as HTMLInputElement;
}

function projectSelect(): HTMLSelectElement {
  return screen.getByLabelText("Projekt (optional)") as HTMLSelectElement;
}

function projectOptions(): string[] {
  return within(projectSelect())
    .getAllByRole("option")
    .map((option) => option.textContent ?? "");
}

/** Type into the customer field and pick the row whose name matches. */
async function pickCustomer(typed: string, name: RegExp) {
  const input = customerInput();
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: typed } });
  fireEvent.mouseDown(await screen.findByRole("option", { name }));
}

function packButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Packen & zuweisen" }) as HTMLButtonElement;
}

describe("Kisten — packing a crate for a customer and a site", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("packs K5 for Mustermann and her project 293", async () => {
    const server = await openCrate(k5());

    await pickCustomer("Mustermann", /Mustermann, Erika/);

    // Her open jobs and nothing else: not the archived one, not anybody else's.
    expect(projectOptions()).toEqual(["Ohne Projekt", "367 · Wallbox Garage", "371 · Zählerschrank Altbau"]);
    fireEvent.change(projectSelect(), { target: { value: String(MUSTERMANN_PROJECT_ID) } });
    fireEvent.click(packButton());

    await waitFor(() =>
      expect(server.packBodies).toEqual([{ customer_id: MUSTERMANN_ID, project_id: MUSTERMANN_PROJECT_ID }]),
    );
  });

  it("asks for a project only once a customer is chosen", async () => {
    await openCrate(k5());

    expect(projectSelect()).toBeDisabled();
    expect(projectOptions()).toEqual(["Erst Kunde wählen"]);
    expect(packButton()).toBeDisabled();
  });

  it("forgets the project when the customer changes", async () => {
    const server = await openCrate(k5());

    await pickCustomer("Mustermann", /Mustermann, Erika/);
    fireEvent.change(projectSelect(), { target: { value: String(MUSTERMANN_PROJECT_ID) } });
    // Customer 7 has two open jobs, so nothing is chosen for him.
    await pickCustomer("Kunde 0007", /Kunde 0007/);

    expect(projectSelect().value).toBe("");
    expect(projectOptions()).toEqual(["Ohne Projekt", "501 · Ladepark Halle 1", "502 · Ladepark Halle 2"]);
    // Gone for good, not merely hidden while it does not fit: back to
    // Mustermann, and her job has to be chosen again.
    await pickCustomer("Mustermann", /Mustermann, Erika/);
    expect(projectSelect().value).toBe("");
    await pickCustomer("Kunde 0007", /Kunde 0007/);
    fireEvent.click(packButton());
    await waitFor(() => expect(server.packBodies).toEqual([{ customer_id: 7, project_id: null }]));
  });

  it("forgets the project when the customer is removed", async () => {
    await openCrate(k5());

    await pickCustomer("Mustermann", /Mustermann, Erika/);
    fireEvent.change(projectSelect(), { target: { value: String(MUSTERMANN_PROJECT_ID) } });
    fireEvent.click(screen.getByRole("button", { name: "Kunde entfernen" }));

    expect(projectSelect().value).toBe("");
    expect(projectSelect()).toBeDisabled();
    expect(packButton()).toBeDisabled();
  });

  it("chooses the project for you when the customer has exactly one open job", async () => {
    const server = await openCrate(k5());

    await pickCustomer("Kunde 0005", /Kunde 0005/);

    expect(projectSelect().value).toBe("405");
    expect(projectOptions()).toEqual(["Ohne Projekt", "405 · PV Dach"]);
    fireEvent.click(packButton());
    await waitFor(() => expect(server.packBodies).toEqual([{ customer_id: 5, project_id: 405 }]));
  });

  it("says so when the customer has no open job, and packs without one", async () => {
    const server = await openCrate(k5());

    await pickCustomer("Kunde 0012", /Kunde 0012/);

    expect(projectSelect()).toBeDisabled();
    expect(projectOptions()).toEqual(["Keine offenen Projekte"]);
    fireEvent.click(packButton());
    await waitFor(() => expect(server.packBodies).toEqual([{ customer_id: 12, project_id: null }]));
  });

  it("keeps the chosen customer and project while the crate is still being filled", async () => {
    const server = await openCrate(k5());

    await pickCustomer("Mustermann", /Mustermann, Erika/);
    fireEvent.change(projectSelect(), { target: { value: String(MUSTERMANN_PROJECT_ID) } });
    // One more line goes in: the page fetches the crate again afterwards.
    fireEvent.change(screen.getByPlaceholderText("Suchen oder scannen…"), { target: { value: "Kabelbinder" } });
    fireEvent.click(screen.getByRole("button", { name: /Kabelbinder.*manuell hinzufügen/ }));
    await screen.findByText("Inhalt (2)");

    expect(projectSelect().value).toBe(String(MUSTERMANN_PROJECT_ID));
    fireEvent.click(packButton());
    await waitFor(() =>
      expect(server.packBodies).toEqual([{ customer_id: MUSTERMANN_ID, project_id: MUSTERMANN_PROJECT_ID }]),
    );
  });

  it("finds a customer the local list lacks through the server, and packs for her", async () => {
    // The list as production had it: the first 200 rows, Mustermann not among them.
    const capped = productionLikeCustomers(222).filter((row) => row.id !== MUSTERMANN_ID).slice(0, 200);
    const mustermann = customerRow(MUSTERMANN_ID, "Mustermann, Erika", { active_project_count: 2 });
    const searchCustomers = vi.fn(async (query: string) =>
      query.toLowerCase().includes("mustermann") ? [mustermann] : [],
    );
    const server = await openCrate(k5(), { customers: capped, searchCustomers });

    await pickCustomer("Mustermann", /Mustermann, Erika/);

    expect(searchCustomers).toHaveBeenCalledWith("Mustermann");
    expect(customerInput().value).toBe("Mustermann, Erika");
    fireEvent.change(projectSelect(), { target: { value: String(MUSTERMANN_PROJECT_ID) } });
    fireEvent.click(packButton());
    await waitFor(() =>
      expect(server.packBodies).toEqual([{ customer_id: MUSTERMANN_ID, project_id: MUSTERMANN_PROJECT_ID }]),
    );
  });

  it("offers no „Neuen Kunden anlegen“ row: this page cannot create customers", async () => {
    await openCrate(k5());

    const input = customerInput();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Brinkhaus-Quadflieg" } });

    expect(screen.queryByText(/Neuen Kunden anlegen/)).toBeNull();
    // Once the server has also found nobody, the dropdown says so plainly.
    expect(await screen.findByText("Keine Kunden gefunden.")).toBeTruthy();
    expect(screen.queryByText(/Neuen Kunden anlegen/)).toBeNull();
  });

  it("shows the crate's customer by name when the list does not hold her", async () => {
    const capped = productionLikeCustomers(222).filter((row) => row.id !== MUSTERMANN_ID).slice(0, 200);
    await openCrate(
      k5({ status: "zurueck", customer_id: MUSTERMANN_ID, customer_name: "Mustermann, Erika", returned_at: "2026-10-19T15:00:00Z" }),
      { customers: capped },
    );

    expect(customerInput().value).toBe("Mustermann, Erika");
    expect(screen.getByRole("button", { name: "Kunde entfernen" })).toBeTruthy();
  });

  it("names the project on a packed crate", async () => {
    await openCrate(
      k5({
        status: "gepackt",
        customer_id: MUSTERMANN_ID,
        customer_name: "Mustermann, Erika",
        project_id: MUSTERMANN_PROJECT_ID,
        project_name: "Wallbox Garage",
        packed_at: "2026-10-20T09:00:00Z",
      }),
    );

    expect(screen.getByText("Gepackt für Mustermann, Erika – bereit zur Mitnahme")).toBeTruthy();
    expect(screen.getByText("Projekt: 367 · Wallbox Garage")).toBeTruthy();
  });

  it("names the project from the crate itself when the project list lacks it", async () => {
    await openCrate(
      k5({
        status: "zugewiesen",
        customer_id: MUSTERMANN_ID,
        customer_name: "Mustermann, Erika",
        project_id: 999,
        project_name: "Altbau Keller",
        packed_at: "2026-10-20T09:00:00Z",
        assigned_at: "2026-10-20T10:00:00Z",
      }),
    );

    expect(screen.getByText("Projekt: Altbau Keller")).toBeTruthy();
  });

  it("starts from an empty customer field after „Erneut öffnen“, and packs again", async () => {
    // The server frees a re-opened crate. The card stays mounted across
    // zurueck → offen, and the field used to keep the old name with no ✕
    // and a dead "Packen & zuweisen" button.
    const server = await openCrate(
      k5({
        status: "zurueck",
        customer_id: MUSTERMANN_ID,
        customer_name: "Mustermann, Erika",
        project_id: MUSTERMANN_PROJECT_ID,
        project_name: "Wallbox Garage",
        returned_at: "2026-10-19T15:00:00Z",
      }),
    );
    expect(customerInput().value).toBe("Mustermann, Erika");

    fireEvent.click(screen.getByRole("button", { name: "Erneut öffnen" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Erneut öffnen" })).toBeNull());

    expect(customerInput().value).toBe("");
    expect(screen.queryByRole("button", { name: "Kunde entfernen" })).toBeNull();
    expect(projectOptions()).toEqual(["Erst Kunde wählen"]);

    await pickCustomer("Mustermann", /Mustermann, Erika/);
    fireEvent.change(projectSelect(), { target: { value: String(MUSTERMANN_PROJECT_ID) } });
    fireEvent.click(packButton());
    await waitFor(() =>
      expect(server.packBodies).toEqual([{ customer_id: MUSTERMANN_ID, project_id: MUSTERMANN_PROJECT_ID }]),
    );
  });

  it("leaves no half-typed search behind after „Erneut öffnen“ either", async () => {
    // Re-opening is a new start for the card: text typed into the returned
    // crate's field, never picked, must not sit there looking chosen.
    await openCrate(
      k5({ status: "zurueck", customer_id: MUSTERMANN_ID, customer_name: "Mustermann, Erika", returned_at: "2026-10-19T15:00:00Z" }),
    );
    fireEvent.focus(customerInput());
    fireEvent.change(customerInput(), { target: { value: "Kunde 00" } });

    fireEvent.click(screen.getByRole("button", { name: "Erneut öffnen" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Erneut öffnen" })).toBeNull());

    expect(customerInput().value).toBe("");
  });

  it("chooses no project for a packer who sees only some of the customer's jobs", async () => {
    // Mustermann has two open jobs; this packer is on 367 only, so the one
    // they see is not "the" job the crate is for.
    const visible = PROJECTS.filter((row) => row.id !== 296);
    const server = await openCrate(k5(), { user: PACKER, projects: visible });

    await pickCustomer("Mustermann", /Mustermann, Erika/);

    expect(projectSelect().value).toBe("");
    expect(projectOptions()).toEqual(["Ohne Projekt", "367 · Wallbox Garage"]);
    expect(screen.getByText("Es werden nur Projekte angezeigt, auf die du Zugriff hast.")).toBeTruthy();
    fireEvent.click(packButton());
    await waitFor(() => expect(server.packBodies).toEqual([{ customer_id: MUSTERMANN_ID, project_id: null }]));
  });

  it("does not tell a packer the customer has no open job when they just cannot see it", async () => {
    await openCrate(k5(), { user: PACKER, projects: [] });

    await pickCustomer("Mustermann", /Mustermann, Erika/);

    expect(projectSelect()).toBeDisabled();
    expect(projectOptions()).toEqual(["Keine Projekte sichtbar"]);
  });

  it("chooses the sole open job for a packer with project management rights", async () => {
    // The rule is the server's (has_global_project_access): projects:manage
    // lists every job, whatever the role.
    const foreman = { ...PACKER, effective_permissions: ["projects:view", "projects:manage"] };
    await openCrate(k5(), { user: foreman });

    await pickCustomer("Kunde 0005", /Kunde 0005/);

    expect(projectSelect().value).toBe("405");
  });

  it("asks for the complete customer list again whenever the tab opens", async () => {
    const reloadCustomers = vi.fn(async () => undefined);
    await openCrate(k5(), { reloadCustomers });

    expect(reloadCustomers).toHaveBeenCalledTimes(1);
  });
});
