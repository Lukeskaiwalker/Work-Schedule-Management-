/**
 * Coming back to the Kunden page finds the search where it was left.
 *
 * Opening a customer switches the main view, which unmounts the page. Its
 * search text and archive filter were page state and went with it, so every
 * "zurück" started over at all active customers — while the project list,
 * whose search lives in App, kept its search. Now the Kunden page's does too,
 * along with the last answer, so the rows are back at once and refresh behind
 * them instead of the table emptying and filling again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  BACK_TO_CUSTOMERS,
  CustomersShell,
  rowNames,
  SEARCH_PLACEHOLDER,
  tableRows,
} from "./fixtures/customersShell";
import {
  archivedCustomers,
  customerRow,
  productionLikeCustomers,
  serveCustomers,
  type CustomerServer,
} from "./fixtures/customerServer";

/** "Muster" under „Alle“: two active customers and one archived — needs the query AND the filter. */
const MUSTER_ALL = ["Musterhaus GmbH", "Mustermann, Erika", "Ölmuster, Clara"];

let server: CustomerServer;

beforeEach(() => {
  server = serveCustomers([
    ...productionLikeCustomers(222),
    ...archivedCustomers(3, 900),
    customerRow(950, "Musterhaus GmbH", { archived_at: "2026-05-01T08:00:00Z" }),
  ]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function searchInput(): HTMLInputElement {
  return screen.getByPlaceholderText(SEARCH_PLACEHOLDER) as HTMLInputElement;
}

function chip(name: "Alle" | "Aktiv" | "Archiviert"): HTMLElement {
  return screen.getByRole("button", { name });
}

/** Search "Muster" under „Alle“ and wait for its answer. */
async function searchMusterUnderAll() {
  await waitFor(() => expect(tableRows()).toHaveLength(222));
  fireEvent.change(searchInput(), { target: { value: "Muster" } });
  fireEvent.click(chip("Alle"));
  await waitFor(() => expect(rowNames()).toEqual(MUSTER_ALL));
}

/** Open a customer from the list: the page unmounts, as App's view switch does. */
function openCustomer(name: string) {
  const button = screen.getByText(name).closest("button");
  if (!button) throw new Error(`no open button for ${name}`);
  fireEvent.click(button);
  expect(screen.queryByPlaceholderText(SEARCH_PLACEHOLDER)).toBeNull();
}

function goBack() {
  fireEvent.click(screen.getByRole("button", { name: BACK_TO_CUSTOMERS }));
}

/** List requests sent since `from` that asked for `query`. */
function requestsFor(query: string, from: number): URLSearchParams[] {
  return server.listRequests.slice(from).filter((params) => params.get("q") === query);
}

describe("Kunden page after opening a customer", () => {
  it("shows the same search, filter and rows at once, before any new answer", async () => {
    render(<CustomersShell />);
    await searchMusterUnderAll();
    openCustomer("Mustermann, Erika");

    const sent = server.listRequests.length;
    const releaseRefresh = server.hold();
    goBack();

    // Synchronously after the remount: nothing has been answered yet.
    expect(searchInput().value).toBe("Muster");
    expect(chip("Alle")).toHaveAttribute("aria-pressed", "true");
    expect(chip("Aktiv")).toHaveAttribute("aria-pressed", "false");
    expect(rowNames()).toEqual(MUSTER_ALL);
    expect(screen.queryByText("Kunden werden geladen…")).toBeNull();

    // …and it refreshes the same question behind them.
    await waitFor(() => expect(requestsFor("Muster", sent)).toHaveLength(2));
    expect(requestsFor("Muster", sent).map((params) => params.get("archived")).sort()).toEqual(["false", "true"]);
    releaseRefresh();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rowNames()).toEqual(MUSTER_ALL);
  });

  it("keeps the rows on screen when their refresh fails, and says why", async () => {
    render(<CustomersShell />);
    await searchMusterUnderAll();
    openCustomer("Mustermann, Erika");

    server.failWhere((params) => params.get("q") === "Muster");
    goBack();
    expect(rowNames()).toEqual(MUSTER_ALL);

    expect(await screen.findByRole("alert")).toHaveTextContent("Kunden konnten nicht geladen werden");
    expect(rowNames()).toEqual(MUSTER_ALL);
  });

  it("does not keep rows that answer another question when the new one fails", async () => {
    render(<CustomersShell />);
    await waitFor(() => expect(tableRows()).toHaveLength(222));

    server.failWhere((params) => params.get("q") === "Muster");
    fireEvent.change(searchInput(), { target: { value: "Muster" } });

    expect(await screen.findByRole("alert")).toHaveTextContent("Kunden konnten nicht geladen werden");
    expect(tableRows()).toHaveLength(0);
    // The failure is the whole message: not "none found", not "loading".
    expect(screen.queryByText(/Keine Kunden für/)).toBeNull();
    expect(screen.queryByText("Kunden werden geladen…")).toBeNull();
  });

  it("lets only the newest answer replace the remembered rows", async () => {
    render(<CustomersShell />);
    await searchMusterUnderAll();
    openCustomer("Mustermann, Erika");

    // Somebody adds a "Musterbau KG" meanwhile; the refresh would bring it.
    server.setRows([...server.rows(), customerRow(960, "Musterbau KG")]);
    const sent = server.listRequests.length;
    const releaseRefresh = server.hold();
    goBack();
    expect(rowNames()).toEqual(MUSTER_ALL);
    await waitFor(() => expect(requestsFor("Muster", sent)).toHaveLength(2));

    // A newer search answers first; the refresh landing after it must not win.
    fireEvent.change(searchInput(), { target: { value: "Mustermann" } });
    await waitFor(() => expect(rowNames()).toEqual(["Mustermann, Erika"]));
    releaseRefresh();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rowNames()).toEqual(["Mustermann, Erika"]);
    expect(screen.queryByText("Musterbau KG")).toBeNull();

    // Nor may it reach what the next visit starts from.
    openCustomer("Mustermann, Erika");
    server.hold();
    goBack();
    expect(searchInput().value).toBe("Mustermann");
    expect(rowNames()).toEqual(["Mustermann, Erika"]);
  });
});

describe("Kunden page after signing out", () => {
  it("starts the next user over: empty search, „Aktiv“, no rows from before", async () => {
    const { rerender } = render(<CustomersShell userId={1} />);
    await searchMusterUnderAll();
    openCustomer("Mustermann, Erika");
    goBack();
    expect(searchInput().value).toBe("Muster");

    rerender(<CustomersShell userId={null} />);
    expect(screen.getByText("Anmeldung")).toBeInTheDocument();
    const releaseFirstLoad = server.hold();
    rerender(<CustomersShell userId={2} />);

    expect(searchInput().value).toBe("");
    expect(chip("Aktiv")).toHaveAttribute("aria-pressed", "true");
    expect(chip("Alle")).toHaveAttribute("aria-pressed", "false");
    expect(tableRows()).toHaveLength(0);

    releaseFirstLoad();
    await waitFor(() => expect(tableRows()).toHaveLength(222));
  });

  it("does not let a refresh answering after the sign-out reach the next user", async () => {
    const { rerender } = render(<CustomersShell userId={1} />);
    await searchMusterUnderAll();
    openCustomer("Mustermann, Erika");
    const sent = server.listRequests.length;
    const releaseRefresh = server.hold();
    goBack();
    await waitFor(() => expect(requestsFor("Muster", sent)).toHaveLength(2));

    // Signed out while the refresh is still on its way; then it answers.
    rerender(<CustomersShell userId={null} />);
    releaseRefresh();
    await new Promise((resolve) => setTimeout(resolve, 50));

    server.hold();
    rerender(<CustomersShell userId={2} />);
    expect(searchInput().value).toBe("");
    expect(chip("Aktiv")).toHaveAttribute("aria-pressed", "true");
    expect(tableRows()).toHaveLength(0);
  });
});
