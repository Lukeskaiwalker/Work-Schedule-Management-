/**
 * The Bedarfe screen, from the complaints it was rewritten for.
 *
 * "Overflown, and completing ten projects × eight items one click at a time is
 * unusable." So the assertions are about the things that make a hundred rows
 * workable: rows arrive grouped per building site, the toolbar narrows the
 * SERVER query (not a client filter over one page of data), a whole site can
 * be selected at once, and the bulk bar then does the work in one call.
 *
 * The order dialog gets its own case because the failure it prevents is
 * expensive and silent: a need with no catalogue article cannot become an
 * order line, and the old flow would simply have left it out of the basket
 * without saying so.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { WerkstattBedarfePage } from "../pages/werkstatt/WerkstattBedarfePage";
import type { MaterialNeedRow } from "../types/materialNeeds";

vi.mock("../utils/werkstattBedarfeApi", () => ({
  listBedarfe: vi.fn(),
  updateNeed: vi.fn(),
  deleteNeed: vi.fn(),
  createNeed: vi.fn(),
  bulkUpdateNeeds: vi.fn(),
  bulkDeleteNeeds: vi.fn(),
  createOrderFromNeeds: vi.fn(),
  searchCatalogItems: vi.fn(async () => []),
}));
vi.mock("../utils/werkstattSuppliersApi", () => ({ listSuppliers: vi.fn(async () => []) }));
vi.mock("../utils/werkstattOrdersApi", () => ({ listOrders: vi.fn(async () => []) }));

import {
  bulkUpdateNeeds,
  createOrderFromNeeds,
  listBedarfe,
} from "../utils/werkstattBedarfeApi";

const listBedarfeMock = vi.mocked(listBedarfe);
const bulkUpdateMock = vi.mocked(bulkUpdateNeeds);
const createOrderMock = vi.mocked(createOrderFromNeeds);

function row(overrides: Partial<MaterialNeedRow> & { id: number }): MaterialNeedRow {
  return {
    project_id: 1,
    project_number: "2026-110",
    project_name: "Halle A",
    customer_name: "Müller GmbH",
    item: "NYM-J 5x6",
    status: "order",
    created_at: "2026-09-15T08:00:00Z",
    updated_at: "2026-09-15T08:00:00Z",
    quantity: "25",
    unit: "m",
    article_no: "11102138",
    material_catalog_item_id: 501,
    supplier_id: 7,
    supplier_name: "Unielektro",
    catalog_item_name: "NYM-J 5x6 grau",
    orderable: true,
    source: "report",
    report_date: "2026-09-14",
    werkstatt_order_id: null,
    werkstatt_order_number: null,
    werkstatt_order_line_id: null,
    ordered_at: null,
    ...overrides,
  } as MaterialNeedRow;
}

const ROWS: MaterialNeedRow[] = [
  row({ id: 1 }),
  row({ id: 2, item: "Kabelbinder", quantity: "1", unit: "Pack", orderable: false, material_catalog_item_id: null, supplier_id: null, supplier_name: null, article_no: null, source: "manual" }),
  row({ id: 3, project_id: 2, project_number: "2026-220", project_name: "Halle B", item: "Rohr M20" }),
];

function renderPage(overrides: Record<string, unknown> = {}) {
  const context = makeAppContextStub({
    overrides: {
      mainView: "werkstatt",
      werkstattTab: "bedarfe",
      language: "de",
      token: "t",
      user: { id: 1, email: "a@b.c", role: "admin", effective_permissions: ["werkstatt:manage"] },
      activeProjects: [
        { id: 1, project_number: "2026-110", name: "Halle A" },
        { id: 2, project_number: "2026-220", name: "Halle B" },
      ],
      ...overrides,
    },
  });
  return render(
    <AppContext.Provider value={context as never}>
      <WerkstattBedarfePage />
    </AppContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listBedarfeMock.mockResolvedValue(ROWS);
  window.localStorage.clear();
});

describe("WerkstattBedarfePage", () => {
  it("groups the rows by building site and counts what is open", async () => {
    renderPage();

    expect(await screen.findByText("2026-110")).toBeInTheDocument();
    expect(screen.getByText("2026-220")).toBeInTheDocument();
    expect(screen.getByText("NYM-J 5x6")).toBeInTheDocument();
    // "{open} offen · {orderable} bestellbar · {ordered} bestellt"
    expect(screen.getByText(/3 offen · 2 bestellbar · 0 bestellt/)).toBeInTheDocument();
  });

  it("marks a row without a catalogue article as unorderable", async () => {
    renderPage();
    await screen.findByText("Kabelbinder");
    expect(screen.getByText("Kein Katalog-Artikel")).toBeInTheDocument();
  });

  it("asks the SERVER for a filtered list rather than filtering on screen", async () => {
    renderPage();
    await screen.findByText("NYM-J 5x6");

    fireEvent.click(screen.getByRole("button", { name: "Bestellt" }));

    await waitFor(() => {
      const calls = listBedarfeMock.mock.calls;
      expect(calls[calls.length - 1][1]).toMatchObject({ statuses: ["ordered"] });
    });
  });

  it("selects a whole site at once and completes it in one call", async () => {
    bulkUpdateMock.mockResolvedValue([]);
    renderPage();
    await screen.findByText("NYM-J 5x6");

    fireEvent.click(screen.getByLabelText("Alle Bedarfe von 2026-110"));

    const bulkBar = screen.getByRole("region", { name: "Massenaktionen" });
    expect(within(bulkBar).getByText("2 ausgewählt")).toBeInTheDocument();

    fireEvent.click(within(bulkBar).getByRole("button", { name: "Erledigt" }));

    await waitFor(() => expect(bulkUpdateMock).toHaveBeenCalledTimes(1));
    expect(bulkUpdateMock.mock.calls[0][1]).toEqual([1, 2]);
    expect(bulkUpdateMock.mock.calls[0][2]).toEqual({ status: "completed" });
  });

  it("says how many of the selection cannot be ordered, and orders the rest", async () => {
    createOrderMock.mockResolvedValue({
      orders: [
        {
          id: 9,
          order_number: "BST-2026-0042",
          supplier_id: 7,
          supplier_name: "Unielektro",
          status: "draft",
          lines: [],
        } as never,
      ],
      added: [{ need_id: 1, order_id: 9, line_id: 11, quantity_warning: null }],
      skipped: [{ need_id: 2, reason: "no_catalog_item", order_number: null }],
      created_at: null,
    });
    renderPage();
    await screen.findByText("NYM-J 5x6");

    fireEvent.click(screen.getByLabelText("Alle Bedarfe von 2026-110"));
    const bulkBar = screen.getByRole("region", { name: "Massenaktionen" });
    const orderButton = within(bulkBar).getByRole("button", { name: /In Bestellung übernehmen/ });
    expect(orderButton).toBeEnabled();

    fireEvent.click(orderButton);

    const dialog = await screen.findByRole("dialog", {
      name: "Bestellung aus Bedarf erstellen",
    });
    // The preview names the supplier group and the row that will be skipped.
    expect(within(dialog).getByText(/Unielektro · 1 Position/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Kabelbinder — Kein Katalog-Artikel/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: /Positionen übernehmen/ }));

    await waitFor(() => expect(createOrderMock).toHaveBeenCalledTimes(1));
    expect(createOrderMock.mock.calls[0][1]).toMatchObject({ need_ids: [1, 2], order_id: null });
    expect(await within(dialog).findByText(/BST-2026-0042/)).toBeInTheDocument();
    // The selection is cleared the moment the server answers, so the result
    // panel has to keep the rows it was built from: a skip list that reads
    // "#2 — Kein Katalog-Artikel" names nothing the buyer can go and fix.
    expect(
      await within(dialog).findByText(/Kabelbinder — Kein Katalog-Artikel/),
    ).toBeInTheDocument();
  });

  it("says plainly when the server ordered nothing at all", async () => {
    // Reachable without a second user: an archived supplier is invisible to
    // the browser's own predicate, so the button and the modal both offer the
    // row and the server refuses it.
    createOrderMock.mockResolvedValue({
      orders: [],
      added: [],
      skipped: [
        { need_id: 1, reason: "no_supplier", order_number: null },
        { need_id: 2, reason: "no_catalog_item", order_number: null },
      ],
      created_at: null,
    });
    const setError = vi.fn();
    const setNotice = vi.fn();
    renderPage({ setError, setNotice });
    await screen.findByText("NYM-J 5x6");

    fireEvent.click(screen.getByLabelText("Alle Bedarfe von 2026-110"));
    const bulkBar = screen.getByRole("region", { name: "Massenaktionen" });
    fireEvent.click(within(bulkBar).getByRole("button", { name: /In Bestellung übernehmen/ }));

    const dialog = await screen.findByRole("dialog", {
      name: "Bestellung aus Bedarf erstellen",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /Positionen übernehmen/ }));

    await waitFor(() => expect(createOrderMock).toHaveBeenCalledTimes(1));
    // No green "  erstellt (0 Positionen)" with a blank order number.
    await waitFor(() => expect(setError).toHaveBeenCalled());
    expect(String(setError.mock.calls[0][0])).toContain("Keine Bestellung erstellt");
    expect(setNotice).not.toHaveBeenCalled();
    expect(
      await within(dialog).findByText(/Keine Bestellung erstellt/),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "Zu den Bestellungen" }),
    ).not.toBeInTheDocument();
  });

  it("blames the reason a row was actually skipped, not the catalogue", async () => {
    listBedarfeMock.mockResolvedValue([
      row({
        id: 1,
        werkstatt_order_id: 9,
        werkstatt_order_line_id: 11,
        werkstatt_order_number: "BST-2026-0042",
        status: "ordered",
      }),
      row({
        id: 2,
        item: "Kabelbinder",
        werkstatt_order_id: 9,
        werkstatt_order_line_id: 12,
        werkstatt_order_number: "BST-2026-0042",
        status: "ordered",
      }),
    ]);
    renderPage();
    await screen.findByText("NYM-J 5x6");

    fireEvent.click(screen.getByLabelText("Alle Bedarfe von 2026-110"));
    const bulkBar = screen.getByRole("region", { name: "Massenaktionen" });
    const orderButton = within(bulkBar).getByRole("button", {
      name: /In Bestellung übernehmen/,
    });
    expect(orderButton).toBeDisabled();
    expect(orderButton).toHaveAttribute(
      "title",
      expect.stringContaining("2 bereits in einer Bestellung"),
    );
    expect(orderButton.getAttribute("title")).not.toContain("Katalog");
  });

  it("offers the rows that block the hand-off as their own supplier filter", async () => {
    renderPage();
    await screen.findByText("NYM-J 5x6");

    fireEvent.change(screen.getByLabelText("Lieferant"), { target: { value: "none" } });

    await waitFor(() => {
      const calls = listBedarfeMock.mock.calls;
      expect(calls[calls.length - 1][1]).toMatchObject({ supplierId: "none" });
    });
  });

  it("hides the order action from someone who may not spend money", async () => {
    renderPage({
      user: { id: 2, email: "e@b.c", role: "employee", effective_permissions: [] },
    });
    await screen.findByText("NYM-J 5x6");

    fireEvent.click(screen.getByLabelText("Alle Bedarfe von 2026-110"));
    const bulkBar = screen.getByRole("region", { name: "Massenaktionen" });
    expect(
      within(bulkBar).queryByRole("button", { name: /In Bestellung übernehmen/ }),
    ).not.toBeInTheDocument();
    // Everything they ARE allowed to do stays.
    expect(within(bulkBar).getByRole("button", { name: "Erledigt" })).toBeInTheDocument();
  });

  it("stays silent and empty when there is nothing to buy", async () => {
    listBedarfeMock.mockResolvedValue([]);
    renderPage();
    expect(
      await screen.findByText("Kein offener Materialbedarf gefunden."),
    ).toBeInTheDocument();
  });
});
