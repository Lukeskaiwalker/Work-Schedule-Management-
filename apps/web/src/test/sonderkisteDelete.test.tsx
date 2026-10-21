/**
 * Deleting a Sonderkiste that is no longer needed.
 *
 * The Sonderkisten card promised "löschbar" since v2.7.0, but no button ever
 * called DELETE /werkstatt/boxes/{id}: an ad-hoc crate somebody made for one
 * job, emptied and brought back, stayed on the list for good.
 *
 * The rule is the server's — a Sonderkiste, open or back, empty, and not on an
 * unfinished task. The page shows the button where the first three hold and
 * leaves the task check to the server, whose German refusal it shows as is —
 * and then reads the crate again, since the refusal may name a line or a
 * state that another device put there after the crate was opened.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { WerkstattKistenPage } from "../pages/werkstatt/WerkstattKistenPage";
import { sonderkisteDeletion } from "../utils/boxes";

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

const SONDERKISTE_ID = 71;

const ITEM: CrateItem = {
  id: 1,
  box_id: SONDERKISTE_ID,
  source: "manual",
  article_id: null,
  catalog_external_key: null,
  item_name: "Kabelbinder",
  article_no: null,
  ean: null,
  unit: "Stk",
  quantity: 1,
  notes: null,
};

/** An ad-hoc crate: no rack slot, a BK number, open and empty unless told otherwise. */
function sonderkiste(extra: Partial<Crate> = {}): Crate {
  return {
    id: SONDERKISTE_ID,
    box_number: "BK-2026-0007",
    label: "Sonderkiste Muster",
    slot: null,
    status: "offen",
    customer_id: null,
    customer_name: null,
    project_id: null,
    project_name: null,
    item_count: 0,
    packed_at: null,
    assigned_at: null,
    returned_at: null,
    notes: null,
    items: [],
    ...extra,
  };
}

/** One of the eight permanent rack crates, open and empty. */
function rackCrate(slot: number): Crate {
  return sonderkiste({ id: 30 + slot, box_number: `K${slot}`, label: `Rackkiste ${slot}`, slot });
}

/** A crate somebody packed for a customer: still has its lines. */
function spokenFor(status: "gepackt" | "zugewiesen"): Partial<Crate> {
  return {
    status,
    customer_id: 12,
    customer_name: "Beispiel, Max",
    item_count: 1,
    items: [ITEM],
    packed_at: "2026-10-20T09:00:00Z",
    assigned_at: status === "zugewiesen" ? "2026-10-20T10:00:00Z" : null,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** What the server answers to the DELETE, when it is not a plain 204. */
type DeleteAnswer = { status: number; detail: string };

const NOT_EMPTY_REFUSAL = "Die Kiste ist nicht leer — erst leeren, dann löschen.";
const SPOKEN_FOR_REFUSAL =
  "Die Kiste ist einem Kunden zugewiesen — erst die Zuweisung aufheben oder die Kiste zurückbuchen.";

/**
 * The box endpoints this page calls, over a rack that a DELETE really changes.
 * `calls` keeps every request in order, so a test can ask what came after what.
 * The DELETE refuses as the server does when the crate is not empty or is
 * spoken for, and `meanwhile` changes a crate the way the wall station does
 * while the page has it open.
 */
function serveRack(initial: Crate[], deleteAnswer?: DeleteAnswer) {
  let crates = initial;
  const calls: string[] = [];
  const meanwhile = (changed: Crate) => {
    crates = crates.map((row) => (row.id === changed.id ? changed : row));
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    calls.push(`${method} ${path}`);
    if (method === "GET" && path === "/api/werkstatt/boxes") return json(crates);
    if (path === "/api/werkstatt/item-search") return json([]);
    const match = /^\/api\/werkstatt\/boxes\/(\d+)$/.exec(path);
    const crate = match ? crates.find((row) => row.id === Number(match[1])) : undefined;
    if (match && !crate) return json({ detail: "Kiste nicht gefunden." }, 404);
    if (crate && method === "GET") return json(crate);
    if (crate && method === "DELETE") {
      if (deleteAnswer && deleteAnswer.status !== 404) return json({ detail: deleteAnswer.detail }, deleteAnswer.status);
      if (crate.status === "gepackt" || crate.status === "zugewiesen") return json({ detail: SPOKEN_FOR_REFUSAL }, 400);
      if (crate.items.length > 0) return json({ detail: NOT_EMPTY_REFUSAL }, 400);
      crates = crates.filter((row) => row.id !== crate.id);
      // A 404 here is somebody else having deleted it a moment earlier.
      return deleteAnswer ? json({ detail: deleteAnswer.detail }, 404) : new Response(null, { status: 204 });
    }
    return json({ detail: `unexpected ${method} ${path}` }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, meanwhile };
}

type Mount = { rack?: Crate[]; deleteAnswer?: DeleteAnswer };

function renderPage(rack: Crate[], deleteAnswer?: DeleteAnswer) {
  const server = serveRack(rack, deleteAnswer);
  const setNotice = vi.fn();
  const setError = vi.fn();
  render(
    <AppContext.Provider
      value={
        makeAppContextStub({
          overrides: {
            mainView: "werkstatt",
            werkstattTab: "kisten",
            language: "de",
            token: "test-token",
            user: { id: 2, email: "lager@example.com", role: "employee", display_name: "Lager", effective_permissions: [] },
            customers: [],
            projects: [],
            searchCustomers: async () => [],
            reloadCustomers: async () => undefined,
            setNotice,
            setError,
          },
        }) as never
      }
    >
      <WerkstattKistenPage />
    </AppContext.Provider>,
  );
  return { ...server, setNotice, setError };
}

/** Render the page with `crate` on the rack and open it. */
async function openCrate(crate: Crate, mount: Mount = {}) {
  const page = renderPage(mount.rack ?? [crate], mount.deleteAnswer);
  fireEvent.click(await screen.findByText(crate.label));
  await screen.findByText(`Inhalt (${crate.items.length})`);
  return page;
}

function deleteButton(): HTMLButtonElement | null {
  return screen.queryByRole("button", { name: "Sonderkiste löschen" }) as HTMLButtonElement | null;
}

const HINT = "Erst leeren, dann löschen.";

function deletesSent(calls: string[]): string[] {
  return calls.filter((call) => call.startsWith("DELETE "));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("sonderkisteDeletion", () => {
  it("allows an empty Sonderkiste that is open or back", () => {
    expect(sonderkisteDeletion({ slot: null, status: "offen" }, 0)).toBe("allowed");
    expect(sonderkisteDeletion({ slot: null, status: "zurueck" }, 0)).toBe("allowed");
  });

  it("asks for an empty crate first when the Sonderkiste still holds something", () => {
    expect(sonderkisteDeletion({ slot: null, status: "offen" }, 3)).toBe("not_empty");
    expect(sonderkisteDeletion({ slot: null, status: "zurueck" }, 1)).toBe("not_empty");
  });

  it("never offers it for a rack crate", () => {
    for (const slot of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(sonderkisteDeletion({ slot, status: "offen" }, 0)).toBe("none");
    }
  });

  it("never offers it for a crate that is spoken for", () => {
    expect(sonderkisteDeletion({ slot: null, status: "gepackt" }, 0)).toBe("none");
    expect(sonderkisteDeletion({ slot: null, status: "zugewiesen" }, 2)).toBe("none");
  });
});

describe("Kisten — deleting a Sonderkiste", () => {
  it("says on the list what is true: a Sonderkiste can be deleted once it is empty", async () => {
    renderPage([sonderkiste()]);

    expect(await screen.findByText("Für einzelne Aufträge angelegt — leer löschbar")).toBeTruthy();
  });

  it("offers „Sonderkiste löschen“ on an empty open Sonderkiste", async () => {
    await openCrate(sonderkiste());

    expect(deleteButton()).toBeEnabled();
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it("offers it on an empty Sonderkiste that came back", async () => {
    await openCrate(sonderkiste({ status: "zurueck", returned_at: "2026-10-19T15:00:00Z" }));

    expect(deleteButton()).toBeEnabled();
  });

  it("asks for an empty crate first instead of offering an enabled button", async () => {
    await openCrate(sonderkiste({ item_count: 1, items: [ITEM] }));

    expect(screen.getByText(HINT)).toBeTruthy();
    expect(deleteButton()).toBeDisabled();
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("never offers it on rack crate K%i, empty and open as it is", async (slot) => {
    await openCrate(rackCrate(slot));

    expect(deleteButton()).toBeNull();
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it.each(["gepackt", "zugewiesen"] as const)("never offers it on a %s Sonderkiste", async (status) => {
    await openCrate(sonderkiste(spokenFor(status)));

    expect(deleteButton()).toBeNull();
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it("deletes after confirmation: one DELETE, the crate closes, the list reloads and names it", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const other = sonderkiste({ id: 72, box_number: "BK-2026-0008", label: "Sonderkiste Beispiel" });
    const page = await openCrate(sonderkiste(), { rack: [sonderkiste(), other] });

    // A double tap on a phone is one deletion.
    const button = deleteButton() as HTMLButtonElement;
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() =>
      expect(page.setNotice).toHaveBeenCalledWith("Sonderkiste BK-2026-0007 „Sonderkiste Muster“ gelöscht"),
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith("Sonderkiste BK-2026-0007 „Sonderkiste Muster“ löschen?");
    expect(deletesSent(page.calls)).toEqual([`DELETE /api/werkstatt/boxes/${SONDERKISTE_ID}`]);

    // Back on the list, and the list was fetched again after the delete.
    expect(await screen.findByText("Sonderkiste Beispiel")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Sonderkiste Muster")).toBeNull());
    expect(screen.queryByText(/^Inhalt \(/)).toBeNull();
    const deletedAt = page.calls.indexOf(`DELETE /api/werkstatt/boxes/${SONDERKISTE_ID}`);
    expect(page.calls.slice(deletedAt + 1)).toContain("GET /api/werkstatt/boxes");
    expect(page.setError).not.toHaveBeenCalled();
  });

  it("sends nothing when the confirmation is cancelled", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const page = await openCrate(sonderkiste());

    fireEvent.click(deleteButton() as HTMLButtonElement);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(deletesSent(page.calls)).toEqual([]);
    expect(screen.getByText("Inhalt (0)")).toBeTruthy();
    expect(deleteButton()).toBeEnabled();
    expect(page.setNotice).not.toHaveBeenCalled();
  });

  it("shows the server's refusal as it is and keeps the crate open", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const refusal =
      "Die Kiste ist noch mit einer offenen Aufgabe verknüpft (Zählerschrank setzen) — dort erst die Kiste entfernen.";
    const page = await openCrate(sonderkiste(), { deleteAnswer: { status: 400, detail: refusal } });

    fireEvent.click(deleteButton() as HTMLButtonElement);

    await waitFor(() => expect(page.setError).toHaveBeenCalledWith(refusal));
    expect(deletesSent(page.calls)).toHaveLength(1);
    expect(screen.getByText("Inhalt (0)")).toBeTruthy();
    // Free to try again once the task no longer holds it.
    await waitFor(() => expect(deleteButton()).toBeEnabled());
    expect(page.setNotice).not.toHaveBeenCalled();
  });

  it("re-reads a crate that filled up meanwhile: the line shows and the button waits for an empty crate", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const page = await openCrate(sonderkiste());
    // Scanned in at the wall station while this screen still shows it empty.
    page.meanwhile(sonderkiste({ item_count: 1, items: [ITEM] }));

    fireEvent.click(deleteButton() as HTMLButtonElement);

    await waitFor(() => expect(page.setError).toHaveBeenCalledWith(NOT_EMPTY_REFUSAL));
    expect(await screen.findByText("Inhalt (1)")).toBeTruthy();
    expect(screen.getByText("Kabelbinder")).toBeTruthy();
    await waitFor(() => expect(deleteButton()).toBeDisabled());
    expect(screen.getByText(HINT)).toBeTruthy();
    const deletedAt = page.calls.indexOf(`DELETE /api/werkstatt/boxes/${SONDERKISTE_ID}`);
    expect(page.calls.slice(deletedAt + 1)).toContain(`GET /api/werkstatt/boxes/${SONDERKISTE_ID}`);
    expect(page.setNotice).not.toHaveBeenCalled();
  });

  it("re-reads a crate that was packed meanwhile: the button leaves with the state that refused it", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const page = await openCrate(sonderkiste());
    page.meanwhile(sonderkiste(spokenFor("gepackt")));

    fireEvent.click(deleteButton() as HTMLButtonElement);

    await waitFor(() => expect(page.setError).toHaveBeenCalledWith(SPOKEN_FOR_REFUSAL));
    expect(await screen.findByText("Inhalt (1)")).toBeTruthy();
    await waitFor(() => expect(deleteButton()).toBeNull());
    expect(screen.queryByText(HINT)).toBeNull();
    expect(page.setNotice).not.toHaveBeenCalled();
  });

  it("closes a crate somebody else deleted a moment earlier instead of leaving it open", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const page = await openCrate(sonderkiste(), {
      rack: [sonderkiste(), rackCrate(1)],
      deleteAnswer: { status: 404, detail: "Kiste nicht gefunden." },
    });

    fireEvent.click(deleteButton() as HTMLButtonElement);

    await waitFor(() => expect(screen.queryByText(/^Inhalt \(/)).toBeNull());
    expect(await screen.findByText("Rackkiste 1")).toBeTruthy();
    expect(screen.queryByText("Sonderkiste Muster")).toBeNull();
    expect(page.setError).not.toHaveBeenCalled();
  });
});
