/**
 * A fetch stand-in that answers the customer endpoints the way the API does.
 *
 * GET /customers is the contract the web's paging relies on, so the stub keeps
 * every rule of `list_customers` (apps/api/app/routers/workflow_customers.py):
 * 200 rows unless asked, 422 above 1000, `offset` honoured, active or archived
 * only, ordered by name then id. A stub that answered "everything" would have
 * passed against the very loader that hid 22 customers in production.
 */
import { vi } from "vitest";

import type { CustomerListItem } from "../../types";

/** Production's id for the customer who could not be found on the Kisten page. */
export const MUSTERMANN_ID = 210;

const SERVER_DEFAULT_LIMIT = 200;
const SERVER_MAX_LIMIT = 1000;

export function customerRow(id: number, name: string, overrides: Partial<CustomerListItem> = {}): CustomerListItem {
  return {
    id,
    name,
    address: null,
    contact_person: null,
    email: null,
    phone: null,
    tax_id: null,
    notes: null,
    birthday: null,
    marktakteur_nummer: null,
    customer_type: null,
    mobile: null,
    archived_at: null,
    created_by: null,
    created_at: "2026-09-01T08:00:00Z",
    updated_at: "2026-09-01T08:00:00Z",
    project_count: 0,
    active_project_count: 0,
    last_project_activity_at: null,
    ...overrides,
  };
}

/**
 * `count` active customers shaped like production when the cap bit: the
 * fillers ("Kunde 0001" …) sort first, so "Mustermann, Erika" (id 210) and
 * "Ölmuster, Clara" (the last id) land past row 200 — exactly the rows the
 * old loader never asked for.
 */
export function productionLikeCustomers(count = 222): CustomerListItem[] {
  return Array.from({ length: count }, (_, index) => {
    const id = index + 1;
    if (id === MUSTERMANN_ID) return customerRow(id, "Mustermann, Erika", { address: "Musterweg 1, 12345 Musterstadt" });
    if (id === count) return customerRow(id, "Ölmuster, Clara");
    return customerRow(id, `Kunde ${String(id).padStart(4, "0")}`);
  });
}

export function archivedCustomers(count: number, firstId: number): CustomerListItem[] {
  return Array.from({ length: count }, (_, index) =>
    customerRow(firstId + index, `Archiviert ${String(index + 1).padStart(2, "0")}`, {
      archived_at: "2026-05-01T08:00:00Z",
    }),
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The server's ORDER BY name ASC, id ASC — code-point order is close enough for these names. */
function serverOrder(a: CustomerListItem, b: CustomerListItem): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id - b.id;
}

export interface CustomerServerOptions {
  /** Called with each list request before it is answered; may change the rows (`server.setRows`). */
  onList?: (params: URLSearchParams, call: number) => void;
}

export interface CustomerServer {
  fetchMock: ReturnType<typeof vi.fn>;
  /** The query of every GET /customers, in order. */
  listRequests: URLSearchParams[];
  rows: () => CustomerListItem[];
  setRows: (next: CustomerListItem[]) => void;
  /** The NEXT list request answers with the rows it saw, but only once the returned function is called. */
  hold: () => () => void;
  /** List requests matching this answer 500 until cleared with `null`. */
  failWhere: (predicate: ((params: URLSearchParams) => boolean) | null) => void;
}

/** Install the stub as the global fetch. `vi.unstubAllGlobals()` takes it down again. */
export function serveCustomers(initialRows: CustomerListItem[], options: CustomerServerOptions = {}): CustomerServer {
  let rows = initialRows;
  let failing: ((params: URLSearchParams) => boolean) | null = null;
  let holds: Array<Promise<void>> = [];
  const listRequests: URLSearchParams[] = [];

  function answerList(params: URLSearchParams): Response {
    const limit = Number(params.get("limit") ?? SERVER_DEFAULT_LIMIT);
    const offset = Number(params.get("offset") ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > SERVER_MAX_LIMIT) {
      return json({ detail: [{ loc: ["query", "limit"], msg: "Input should be less than or equal to 1000" }] }, 422);
    }
    const archived = params.get("archived") === "true";
    const q = (params.get("q") ?? "").trim().toLowerCase();
    const page = rows
      .filter((row) => (archived ? row.archived_at !== null : row.archived_at === null))
      .filter((row) => !q || row.name.toLowerCase().includes(q))
      .slice()
      .sort(serverOrder)
      .slice(offset, offset + limit);
    return json(page);
  }

  function setArchived(id: number, archivedAt: string | null): Response {
    const current = rows.find((row) => row.id === id);
    if (!current) return json({ detail: "Kunde nicht gefunden" }, 404);
    const updated = { ...current, archived_at: archivedAt };
    rows = rows.map((row) => (row.id === id ? updated : row));
    return json(updated);
  }

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET" && url.pathname === "/api/customers") {
      const call = listRequests.length;
      listRequests.push(url.searchParams);
      options.onList?.(url.searchParams, call);
      // The answer is what the server saw when the request arrived; a hold
      // only delays its delivery, like a slow connection would.
      const answer = failing?.(url.searchParams) ? json({ detail: "Interner Serverfehler" }, 500) : answerList(url.searchParams);
      const [hold, ...rest] = holds;
      holds = rest;
      if (hold) await hold;
      return answer;
    }
    const archive = /^\/api\/customers\/(\d+)\/(archive|unarchive)$/.exec(url.pathname);
    if (method === "POST" && archive) {
      return setArchived(Number(archive[1]), archive[2] === "archive" ? "2026-10-20T09:00:00Z" : null);
    }
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);

  return {
    fetchMock,
    listRequests,
    rows: () => rows,
    setRows: (next) => {
      rows = next;
    },
    hold: () => {
      let release = () => {};
      holds = [...holds, new Promise<void>((resolve) => (release = resolve))];
      return () => release();
    },
    failWhere: (predicate) => {
      failing = predicate;
    },
  };
}
