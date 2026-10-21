/**
 * The Kunden page keeps its rows to itself.
 *
 * It used to search by writing the server's answer into the ONE customer list
 * every picker filters: after somebody looked up "Mustermann" there, the project
 * form, the Kisten page and the Baustellenbericht knew exactly one customer
 * until the next reload — and offered to create everyone else again. Without a
 * search it showed the server's 200-row default, so the 22 alphabetically last
 * customers were neither listed nor exported, and "Alle" was the active list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { CustomersShell, SEARCH_PLACEHOLDER, tableRows } from "./fixtures/customersShell";
import {
  archivedCustomers,
  customerRow,
  productionLikeCustomers,
  serveCustomers,
  type CustomerServer,
} from "./fixtures/customerServer";
import type { CustomerListItem } from "../types";

function directoryActions() {
  return {
    reloadCustomers: vi.fn(async () => undefined),
    searchCustomers: vi.fn(async () => [] as CustomerListItem[]),
    // Gone from the context; spied so the old page's writes would still show.
    loadCustomers: vi.fn(async () => undefined),
    setCustomers: vi.fn(),
  };
}

// The search text lives in App now (like the project search), so the page is
// rendered inside a shell that holds it — a fixed context could not type.
function page(actions: ReturnType<typeof directoryActions>, customers: CustomerListItem[]) {
  return <CustomersShell customers={customers} overrides={actions} />;
}

let server: CustomerServer;

beforeEach(() => {
  server = serveCustomers([...productionLikeCustomers(222), ...archivedCustomers(3, 900)]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Kunden page", () => {
  it("lists all 222 active customers, and exports all 222", async () => {
    render(page(directoryActions(), []));
    await waitFor(() => expect(tableRows()).toHaveLength(222));
    expect(screen.getByText("Mustermann, Erika")).toBeInTheDocument();

    const exported: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      exported.push(blob as Blob);
      return "blob:kunden";
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Exportieren" }));

    const csv = await exported[0].text();
    const lines = csv.split("\n");
    expect(lines).toHaveLength(223);
    expect(lines.some((line) => line.startsWith('210,"Mustermann, Erika"'))).toBe(true);
  });

  it("searches on the server and leaves the shared customer list alone", async () => {
    const actions = directoryActions();
    render(page(actions, []));
    await waitFor(() => expect(tableRows()).toHaveLength(222));

    fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), { target: { value: "Mustermann" } });

    await waitFor(() => expect(tableRows()).toHaveLength(1));
    expect(screen.getByText("Mustermann, Erika")).toBeInTheDocument();
    expect(server.listRequests[server.listRequests.length - 1].get("q")).toBe("Mustermann");
    expect(actions.reloadCustomers).not.toHaveBeenCalled();
    expect(actions.loadCustomers).not.toHaveBeenCalled();
    expect(actions.setCustomers).not.toHaveBeenCalled();
  });

  it("shows active and archived customers under „Alle“", async () => {
    render(page(directoryActions(), []));
    await waitFor(() => expect(tableRows()).toHaveLength(222));

    fireEvent.click(screen.getByRole("button", { name: "Alle" }));

    await waitFor(() => expect(tableRows()).toHaveLength(225));
    expect(screen.getByText("Archiviert 01")).toBeInTheDocument();
    expect(screen.getByText("Mustermann, Erika")).toBeInTheDocument();
  });

  it("does not let an older search answering late replace the newer one", async () => {
    render(page(directoryActions(), []));
    await waitFor(() => expect(tableRows()).toHaveLength(222));

    const releaseOlder = server.hold();
    const input = screen.getByPlaceholderText(SEARCH_PLACEHOLDER);
    fireEvent.change(input, { target: { value: "Kunde" } });
    await waitFor(() => expect(server.listRequests.some((params) => params.get("q") === "Kunde")).toBe(true));
    fireEvent.change(input, { target: { value: "Mustermann" } });
    await waitFor(() => expect(tableRows()).toHaveLength(1));

    releaseOlder();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tableRows()).toHaveLength(1);
    expect(screen.queryByText("Kunde 0001")).toBeNull();
  });

  it("fetches again when the shared list changes, so a save in the customer form shows up", async () => {
    const actions = directoryActions();
    const { rerender } = render(page(actions, []));
    await waitFor(() => expect(tableRows()).toHaveLength(222));
    const requestsBefore = server.listRequests.length;

    server.setRows([...server.rows(), customerRow(5000, "Neumann Elektro")]);
    rerender(page(actions, [customerRow(5000, "Neumann Elektro")]));

    await waitFor(() => expect(tableRows()).toHaveLength(223));
    expect(server.listRequests.length).toBeGreaterThan(requestsBefore);
  });
});
