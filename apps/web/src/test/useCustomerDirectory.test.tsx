/**
 * The one customer list every picker filters.
 *
 * It used to be a single GET with the server's 200-row default, written by
 * whoever called last — including the Kunden page's search, which replaced it
 * with its hits. These pin what the pickers may rely on now: the list is
 * complete, only the newest reload lands, a failed reload leaves the list it
 * had, and it holds active customers only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { useCustomerDirectory } from "../hooks/useCustomerDirectory";
import { customerRow, productionLikeCustomers, serveCustomers, MUSTERMANN_ID } from "./fixtures/customerServer";

afterEach(() => vi.unstubAllGlobals());

function mountDirectory() {
  const setError = vi.fn();
  const setNotice = vi.fn();
  const hook = renderHook(() => useCustomerDirectory({ token: "t", language: "de", setError, setNotice }));
  return { ...hook, setError, setNotice };
}

describe("useCustomerDirectory", () => {
  it("holds all 222 active customers after mount, Mustermann included", async () => {
    serveCustomers(productionLikeCustomers(222));

    const { result } = mountDirectory();

    await waitFor(() => expect(result.current.customers).toHaveLength(222));
    expect(result.current.customers.some((row) => row.id === MUSTERMANN_ID)).toBe(true);
  });

  it("lets the newer of two overlapping reloads win", async () => {
    const all = productionLikeCustomers(222);
    const server = serveCustomers(all.filter((row) => row.id !== MUSTERMANN_ID));
    // The mount's load is slow and answers with the list before Mustermann existed.
    const releaseFirst = server.hold();
    const { result } = mountDirectory();
    await waitFor(() => expect(server.listRequests).toHaveLength(1));

    server.setRows(all);
    await act(() => result.current.reloadCustomers());
    expect(result.current.customers).toHaveLength(222);

    // Let the stale answer arrive and finish parsing before looking again.
    await act(async () => {
      releaseFirst();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(server.listRequests).toHaveLength(2);
    expect(result.current.customers).toHaveLength(222);
    expect(result.current.customers.some((row) => row.id === MUSTERMANN_ID)).toBe(true);
  });

  it("keeps the list it has when a reload fails, and says so", async () => {
    const server = serveCustomers(productionLikeCustomers(222));
    const { result, setError } = mountDirectory();
    await waitFor(() => expect(result.current.customers).toHaveLength(222));

    server.failWhere(() => true);
    await act(() => result.current.reloadCustomers());

    expect(result.current.customers).toHaveLength(222);
    expect(setError).toHaveBeenCalledWith("Interner Serverfehler");
  });

  it("drops an archived customer and takes them back on restore", async () => {
    serveCustomers(productionLikeCustomers(222));
    const { result } = mountDirectory();
    await waitFor(() => expect(result.current.customers).toHaveLength(222));

    await act(() => result.current.archiveCustomer(MUSTERMANN_ID));
    expect(result.current.customers).toHaveLength(221);
    expect(result.current.customers.some((row) => row.id === MUSTERMANN_ID)).toBe(false);

    await act(() => result.current.unarchiveCustomer(MUSTERMANN_ID));
    expect(result.current.customers).toHaveLength(222);
    expect(result.current.customers.find((row) => row.id === MUSTERMANN_ID)?.archived_at).toBeNull();
  });

  it("searches the server without touching the list, and fetches a fresh one when a hit is missing", async () => {
    const all = productionLikeCustomers(222);
    const server = serveCustomers(all.filter((row) => row.id !== MUSTERMANN_ID));
    const { result } = mountDirectory();
    await waitFor(() => expect(result.current.customers).toHaveLength(221));

    // Created by a colleague after this browser loaded the list.
    server.setRows(all);
    let hits: Array<{ id: number }> = [];
    await act(async () => {
      hits = await result.current.searchCustomers("Mustermann");
    });

    expect(hits.map((row) => row.id)).toEqual([MUSTERMANN_ID]);
    const search = server.listRequests[1];
    expect(search.get("q")).toBe("Mustermann");
    expect(search.get("limit")).toBe("20");
    expect(search.get("archived")).toBe("false");
    await waitFor(() => expect(result.current.customers).toHaveLength(222));
  });

  it("does not start another full reload for every search while one is under way", async () => {
    // A slow login load (a phone on a site connection): until it lands every
    // search hit is "unknown", and each search used to supersede the reload in
    // flight with a new one, so the list never landed while the user typed.
    const server = serveCustomers(productionLikeCustomers(222));
    const releaseLoad = server.hold();
    const { result } = mountDirectory();
    await waitFor(() => expect(server.listRequests).toHaveLength(1));

    await act(async () => {
      await result.current.searchCustomers("Mustermann");
      await result.current.searchCustomers("Ölmuster");
    });

    const fullLoads = server.listRequests.filter((params) => !params.get("q"));
    expect(fullLoads).toHaveLength(1);
    await act(async () => {
      releaseLoad();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(result.current.customers).toHaveLength(222);
  });

  it("finds a customer of exactly the typed name beyond the first 20 hits", async () => {
    // The server's search matches name, contact, address, e-mail and phone
    // and stops at 20 rows in name order. 25 customers whose name contains
    // "Müller" sort before the one called exactly that — who was created in
    // another browser after this list loaded, so only the server knows him.
    // Without him in the answer the combobox offers to create him again.
    const neighbours = Array.from({ length: 25 }, (_, index) =>
      customerRow(500 + index, `Albers-Müller ${String(index).padStart(2, "0")}`),
    );
    const server = serveCustomers([...productionLikeCustomers(222), ...neighbours]);
    const { result } = mountDirectory();
    await waitFor(() => expect(result.current.customers).toHaveLength(247));
    server.setRows([...server.rows(), customerRow(600, "Müller")]);

    let hits: Array<{ id: number }> = [];
    await act(async () => {
      hits = await result.current.searchCustomers("Müller");
    });

    expect(hits.map((row) => row.id)).toContain(600);
  });

  it("asks again, completely, only when a full page lacks the exact name", async () => {
    const server = serveCustomers(productionLikeCustomers(222));
    const { result } = mountDirectory();
    await waitFor(() => expect(result.current.customers).toHaveLength(222));
    const before = server.listRequests.length;

    await act(async () => {
      await result.current.searchCustomers("Kunde 00");
    });

    // 99 fillers match "Kunde 00": the page of 20 is full and nobody is called
    // exactly that, so only the complete answer can say nobody is. A short
    // page settles it in one request.
    await act(async () => {
      await result.current.searchCustomers("Mustermann, Erika");
    });
    const searches = server.listRequests.slice(before).map((params) => [params.get("q"), params.get("limit")]);
    expect(searches).toEqual([
      ["Kunde 00", "20"],
      ["Kunde 00", "1000"],
      ["Mustermann, Erika", "20"],
    ]);
  });

  it("adds a saved new customer and replaces an edited one", async () => {
    serveCustomers(productionLikeCustomers(222));
    const { result } = mountDirectory();
    await waitFor(() => expect(result.current.customers).toHaveLength(222));

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { name: string };
        const id = init?.method === "PATCH" ? MUSTERMANN_ID : 999;
        return new Response(JSON.stringify(customerRow(id, body.name)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    await act(async () => {
      await result.current.saveCustomer({ name: "Neumann Elektro" });
      await result.current.saveCustomer({ name: "Mustermann, Erika und Anna" }, MUSTERMANN_ID);
    });

    expect(result.current.customers).toHaveLength(223);
    expect(result.current.customers.find((row) => row.id === 999)?.name).toBe("Neumann Elektro");
    expect(result.current.customers.filter((row) => row.id === MUSTERMANN_ID).map((row) => row.name)).toEqual([
      "Mustermann, Erika und Anna",
    ]);
  });
});
