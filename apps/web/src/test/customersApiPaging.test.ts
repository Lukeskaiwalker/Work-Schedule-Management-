/**
 * The shared customer list is the WHOLE customer list.
 *
 * GET /customers answers 200 rows unless asked for more (at most 1000 per
 * page, ordered by name, then id). The web asked for neither, so from the
 * 201st active customer on (2026-09-29) the alphabetically last ones —
 * "Mustermann, Erika" among them — did not exist for any picker: the Kisten
 * page could not pack a box for her and the project form offered to create
 * her a second time. These pin the loader: it pages until a short page, never
 * hands back a partial list, and fails loudly rather than truncating.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { CUSTOMER_PAGE_LIMIT, listAllCustomers, listCustomers } from "../utils/customersApi";
import { customerRow, productionLikeCustomers, serveCustomers, MUSTERMANN_ID } from "./fixtures/customerServer";

afterEach(() => vi.unstubAllGlobals());

describe("listAllCustomers", () => {
  it("brings back all 1022 customers, Mustermann included", async () => {
    serveCustomers(productionLikeCustomers(1022));

    const rows = await listAllCustomers("t");

    expect(rows).toHaveLength(1022);
    expect(rows.find((row) => row.id === MUSTERMANN_ID)?.name).toBe("Mustermann, Erika");
  });

  it("asks for the server's largest page at offset 0, then 1000, and stops at the short page", async () => {
    const server = serveCustomers(productionLikeCustomers(1022));

    await listAllCustomers("t");

    expect(CUSTOMER_PAGE_LIMIT).toBe(1000);
    expect(server.listRequests.map((params) => [params.get("limit"), params.get("offset")])).toEqual([
      ["1000", "0"],
      ["1000", "1000"],
    ]);
    expect(server.listRequests.every((params) => params.get("archived") === "false")).toBe(true);
  });

  it("takes exactly one request for production's 222 customers", async () => {
    const server = serveCustomers(productionLikeCustomers(222));

    const rows = await listAllCustomers("t");

    expect(rows).toHaveLength(222);
    expect(server.listRequests).toHaveLength(1);
  });

  it("passes the search and the archived filter on to every page", async () => {
    const server = serveCustomers([
      customerRow(1, "Mustermann, Erika"),
      customerRow(2, "Mustermann, Anna", { archived_at: "2026-05-01T08:00:00Z" }),
    ]);

    const rows = await listAllCustomers("t", { query: "  mustermann ", archived: true });

    expect(rows.map((row) => row.id)).toEqual([2]);
    expect(server.listRequests[0].get("q")).toBe("mustermann");
    expect(server.listRequests[0].get("archived")).toBe("true");
  });

  it("rejects when a later page fails — never a partial list", async () => {
    const server = serveCustomers(productionLikeCustomers(1022));
    server.failWhere((params) => params.get("offset") === "1000");

    await expect(listAllCustomers("t")).rejects.toThrow("Interner Serverfehler");
  });

  it("lists a customer only once when a page boundary shifts under it", async () => {
    // A customer created between the two requests sorts first, pushing the
    // last row of page one onto page two as well.
    const server = serveCustomers(productionLikeCustomers(1001), {
      onList: (_params, call) => {
        if (call === 1) server.setRows([customerRow(5000, "Aachener Bau"), ...server.rows()]);
      },
    });

    const rows = await listAllCustomers("t");
    const ids = rows.map((row) => row.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(1001);
    expect(ids).toContain(MUSTERMANN_ID);
  });

  it("refuses to go round in circles when the server ignores the offset", async () => {
    const page = productionLikeCustomers(1000);
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(page), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(listAllCustomers("t")).rejects.toThrow(/nicht vollständig/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("listCustomers", () => {
  it("always names its page size, so the server's 200-row default never applies", async () => {
    const server = serveCustomers(productionLikeCustomers(222));

    await listCustomers("t");
    await listCustomers("t", "Must");
    await listCustomers("t", "Must", false, { limit: 20 });

    expect(server.listRequests.map((params) => params.get("limit"))).toEqual(["1000", "1000", "20"]);
  });
});
