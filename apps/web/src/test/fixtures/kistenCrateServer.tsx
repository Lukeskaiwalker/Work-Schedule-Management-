/**
 * Crates on the Kisten page, behind a stub that answers their endpoints the
 * way the API does, and records every request with its body, in order:
 *
 *   - a PATCH changes the line, a DELETE removes it, a POST adds one — or
 *     tops up the line already holding that article, as `add_item_to_box`
 *     does for a repeat scan;
 *   - a handed-over crate (`zugewiesen`) refuses every change to its lines
 *     with the API's 400, as `ensure_box_unlocked` does — so a count that
 *     arrives after the handover is visibly refused, not quietly taken;
 *   - POST /status and POST /pack move the crate.
 *
 * `holdNextWrite` and `failNextWrite` stand in for a slow and a failing
 * connection. Invented data only: the repo is public.
 */
import { vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { AppContext } from "../../context/AppContext";
import { makeAppContextStub } from "../appContextStub";
import { WerkstattKistenPage } from "../../pages/werkstatt/WerkstattKistenPage";

export type CrateItem = {
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

export type Crate = {
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

export const BOX_ID = 44;

/** The API's refusal for a line change on a handed-over crate (BOX_LOCKED_DETAIL). */
export const BOX_LOCKED_DETAIL = "Die Kiste ist beim Kunden — ihr Inhalt kann nicht mehr geändert werden.";

export function crateLine(extra: Partial<CrateItem>): CrateItem {
  return {
    id: 1,
    box_id: BOX_ID,
    source: "article",
    article_id: 11,
    catalog_external_key: null,
    item_name: "Kabelbinder 200 mm",
    article_no: "SP-0011",
    ean: null,
    unit: "Stk",
    quantity: 3,
    notes: null,
    ...extra,
  };
}

/** Rack crate 4, open and nobody's, holding `items`. */
export function crateWith(items: CrateItem[], extra: Partial<Crate> = {}): Crate {
  return {
    id: BOX_ID,
    box_number: "K4",
    label: "Kiste 4",
    slot: 4,
    status: "offen",
    customer_id: null,
    customer_name: null,
    project_id: null,
    project_name: null,
    item_count: items.length,
    packed_at: null,
    assigned_at: null,
    returned_at: null,
    notes: null,
    ...extra,
    items,
  };
}

export type Call = { method: string; path: string; body: unknown };

export interface CrateServer {
  calls: Call[];
  /** The NEXT write lands on arrival but is answered only once the returned function is called. */
  holdNextWrite: () => () => void;
  /** The NEXT write is answered 500 and changes nothing. */
  failNextWrite: () => void;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function withItems(crate: Crate, items: CrateItem[]): Crate {
  return { ...crate, items, item_count: items.length };
}

/** A POST /items: the line holding this article grows, otherwise a new line. */
function addLine(crate: Crate, body: Partial<CrateItem>): { crate: Crate; line: CrateItem } {
  const quantity = body.quantity ?? 1;
  const existing = body.article_id != null ? crate.items.find((row) => row.article_id === body.article_id) : undefined;
  if (existing) {
    const line = { ...existing, quantity: existing.quantity + quantity };
    return { crate: withItems(crate, crate.items.map((row) => (row.id === line.id ? line : row))), line };
  }
  const line = crateLine({ ...body, id: 100 + crate.items.length, box_id: crate.id, quantity });
  return { crate: withItems(crate, [...crate.items, line]), line };
}

type Answer = { crate: Crate; response: Response };

/** What the API does with one write to `crate`; null when the stub does not know the route. */
function answerWrite(crate: Crate, method: string, rest: string, body: unknown): Answer | null {
  const locked = () => ({ crate, response: json({ detail: BOX_LOCKED_DETAIL }, 400) });
  const lineMatch = /^\/items\/(\d+)$/.exec(rest);
  if (lineMatch && (method === "PATCH" || method === "DELETE")) {
    if (crate.status === "zugewiesen") return locked();
    const id = Number(lineMatch[1]);
    const line = crate.items.find((row) => row.id === id);
    if (!line) return { crate, response: json({ detail: "Position nicht gefunden" }, 404) };
    if (method === "DELETE") {
      return { crate: withItems(crate, crate.items.filter((row) => row.id !== id)), response: new Response(null, { status: 204 }) };
    }
    const changed = { ...line, quantity: (body as { quantity: number }).quantity };
    return { crate: withItems(crate, crate.items.map((row) => (row.id === id ? changed : row))), response: json(changed) };
  }
  if (method === "POST" && rest === "/items") {
    if (crate.status === "zugewiesen") return locked();
    const added = addLine(crate, body as Partial<CrateItem>);
    return { crate: added.crate, response: json(added.line, 201) };
  }
  if (method === "POST" && rest === "/status") {
    const status = (body as { status: string }).status;
    const moved = { ...crate, status, assigned_at: status === "zugewiesen" ? "2026-10-20T10:00:00Z" : crate.assigned_at };
    return { crate: moved, response: json(moved) };
  }
  if (method === "POST" && rest === "/pack") {
    const { customer_id, project_id } = body as { customer_id: number; project_id: number | null };
    const packed = { ...crate, status: "gepackt", customer_id, project_id, packed_at: "2026-10-20T09:00:00Z" };
    return { crate: packed, response: json(packed) };
  }
  return null;
}

/** `searchHits` maps an item-search query to the hits it returns. */
function serveCrates(initial: Crate[], searchHits: Record<string, unknown[]>): CrateServer {
  let crates = initial;
  let holds: Array<Promise<void>> = [];
  let failNext = false;
  const calls: Call[] = [];

  async function write(crate: Crate, method: string, rest: string, body: unknown): Promise<Response> {
    if (failNext) {
      failNext = false;
      return json({ detail: "Interner Serverfehler" }, 500);
    }
    const answer = answerWrite(crate, method, rest, body);
    if (!answer) return json({ detail: `unexpected ${method} ${rest}` }, 404);
    // Lands when it arrives; a hold only delays the answer, as a slow connection would.
    crates = crates.map((row) => (row.id === crate.id ? answer.crate : row));
    const [hold, ...others] = holds;
    holds = others;
    if (hold) await hold;
    return answer.response;
  }

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
    calls.push({ method, path, body });
    if (method === "GET" && path === "/api/werkstatt/boxes") return json(crates);
    if (path === "/api/werkstatt/item-search") return json(searchHits[url.searchParams.get("q") ?? ""] ?? []);
    const crateMatch = /^\/api\/werkstatt\/boxes\/(\d+)(\/.*)?$/.exec(path);
    const crate = crateMatch ? crates.find((row) => row.id === Number(crateMatch[1])) : undefined;
    if (!crateMatch || !crate) return json({ detail: `unexpected ${method} ${path}` }, 404);
    const rest = crateMatch[2] ?? "";
    if (method === "GET" && rest === "") return json(crate);
    return write(crate, method, rest, body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    holdNextWrite: () => {
      let release = () => {};
      holds = [...holds, new Promise<void>((resolve) => (release = resolve))];
      return () => release();
    },
    failNextWrite: () => {
      failNext = true;
    },
  };
}

/**
 * Render the page with `box` (and `otherCrates`) on the rack, open `box`, and
 * hand back the server: its request log and its hold/fail switches.
 */
export async function mountCrate(
  box: Crate,
  searchHits: Record<string, unknown[]> = {},
  otherCrates: Crate[] = [],
): Promise<CrateServer> {
  const server = serveCrates([box, ...otherCrates], searchHits);
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
            setNotice: vi.fn(),
            setError: vi.fn(),
          },
        }) as never
      }
    >
      <WerkstattKistenPage />
    </AppContext.Provider>,
  );
  fireEvent.click(await screen.findByText(box.label));
  await screen.findByText(`Inhalt (${box.items.length})`);
  return server;
}

/** The requests that change something, in the order they were sent. */
export function writes(calls: Call[]): Call[] {
  return calls.filter((call) => call.method !== "GET");
}

export function lineUrl(itemId: number, boxId = BOX_ID): string {
  return `/api/werkstatt/boxes/${boxId}/items/${itemId}`;
}

export function qtyField(itemName: string): HTMLInputElement {
  return screen.getByLabelText(`Menge ${itemName}`) as HTMLInputElement;
}

export function plusButtons(): HTMLElement[] {
  return screen.getAllByRole("button", { name: "Menge erhöhen" });
}

/** What a person does: put the cursor in, type, and press a key. */
export function typeInto(field: HTMLInputElement, text: string) {
  fireEvent.focus(field);
  fireEvent.change(field, { target: { value: text } });
}

export function press(field: HTMLInputElement, key: string) {
  fireEvent.keyDown(field, { key });
}

/** The page debounces a line's change for 350 ms; this is comfortably past it. */
export const QUIET_MS = 600;

export function quiet(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, QUIET_MS));
}
