/**
 * What the Bestellungen page says when it did NOT get the orders.
 *
 * `refresh()` catches, reports, and leaves `orders` at `[]` — and every figure
 * on the page is derived from that array. So a failed GET used to print OFFEN
 * 0, ÜBERFÄLLIG 0, DIESE WOCHE GELIEFERT 0, OFFENER WARENWERT 0,00 €, the
 * subtitle "0 offen · 0 unterwegs · 0 geliefert diese Woche", and an empty
 * state inviting the buyer to create their first order — for a workshop with
 * forty open orders and three overdue ones. The only counter-signal was a
 * dismissible red banner, and a buyer who closes it walks away believing
 * nothing is late.
 *
 * These pin the rule the rest of the program is built on: a number on screen
 * is a number the server answered with.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { WerkstattOrdersPage } from "../pages/werkstatt/WerkstattOrdersPage";
import type { WerkstattOrderSummary } from "../types/werkstatt";

vi.mock("../utils/werkstattOrdersApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/werkstattOrdersApi")>()),
  listOrders: vi.fn(),
  listOrderTemplates: vi.fn(),
  listIdsConnections: vi.fn(),
}));
vi.mock("../utils/werkstattSuppliersApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/werkstattSuppliersApi")>()),
  listSuppliers: vi.fn(),
}));

import { listIdsConnections, listOrderTemplates, listOrders } from "../utils/werkstattOrdersApi";
import { listSuppliers } from "../utils/werkstattSuppliersApi";

const ordersMock = vi.mocked(listOrders);
const templatesMock = vi.mocked(listOrderTemplates);
const connectionsMock = vi.mocked(listIdsConnections);
const suppliersMock = vi.mocked(listSuppliers);

/** One open order, three days past its ETA — the state that must never be
 *  reported as "0 überfällig" because a request failed. */
const OVERDUE: WerkstattOrderSummary = {
  id: 31,
  order_number: "BST-2026-0031",
  supplier_id: 7,
  supplier_name: "Unielektro",
  status: "sent",
  total_amount_cents: 124_500,
  currency: "EUR",
  ordered_at: "2026-09-01T08:00:00Z",
  expected_delivery_at: "2026-09-08T08:00:00Z",
  delivered_at: null,
  line_count: 12,
  days_overdue: 3,
  title: "Baustelle Nordstraße",
  is_template: false,
  template_name: null,
  task_id: null,
  task_title: null,
  project_id: null,
  source: "manual",
  merged_into_order_id: null,
};

function context(token: string) {
  return makeAppContextStub({
    overrides: {
      mainView: "werkstatt",
      werkstattTab: "orders",
      language: "de",
      token,
      user: { id: 1, email: "a@b.c", role: "admin", effective_permissions: ["werkstatt:manage"] },
      tasks: [],
      pendingWerkstattOrderId: null,
      consumePendingWerkstattOrderId: () => undefined,
    },
  });
}

function renderPage(token = "t") {
  return render(
    <AppContext.Provider value={context(token) as never}>
      <WerkstattOrdersPage />
    </AppContext.Provider>,
  );
}

/** The four KPI figures, with the non-breaking space Intl puts before "€"
 *  normalised so the expectations read like the screen does. */
function kpiValues(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".werkstatt-kpi-value")).map((node) =>
    (node.textContent ?? "").replace(/\u00a0/g, " "),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  ordersMock.mockResolvedValue([OVERDUE]);
  templatesMock.mockResolvedValue([]);
  suppliersMock.mockResolvedValue([]);
  connectionsMock.mockResolvedValue([]);
});

describe("WerkstattOrdersPage — a failed load", () => {
  it("prints figures only when the orders were actually read", async () => {
    const { container } = renderPage();

    await screen.findByText("BST-2026-0031");
    expect(kpiValues(container)).toEqual(["1", "1", "0", "1.245,00 €"]);
  });

  it("replaces every KPI figure with a dash instead of a zero", async () => {
    ordersMock.mockRejectedValue(new Error("500 Internal Server Error"));
    const { container } = renderPage();

    await screen.findByText(/Bestellungen konnten nicht geladen werden/);
    expect(kpiValues(container)).toEqual(["—", "—", "—", "—"]);
    expect(container.querySelectorAll(".werkstatt-kpi-subtitle")[0]).toHaveTextContent(
      "nicht geladen",
    );
  });

  it("says so in the subtitle rather than counting the empty array", async () => {
    ordersMock.mockRejectedValue(new Error("500 Internal Server Error"));
    renderPage();

    expect(
      await screen.findByText("Keine Zahlen — Bestellungen wurden nicht geladen."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/0 offen ·/)).not.toBeInTheDocument();
  });

  it("never invites the buyer to create their first order", async () => {
    ordersMock.mockRejectedValue(new Error("500 Internal Server Error"));
    renderPage();

    expect(
      await screen.findByText(/Bestellungen konnten nicht geladen werden/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Noch keine Bestellungen/)).not.toBeInTheDocument();
    // The server's own words stay where the list is, not only in the banner
    // the user is about to close.
    expect(document.querySelector(".werkstatt-orders-empty-detail")).toHaveTextContent(
      "500 Internal Server Error",
    );
  });

  /* The failure scenario in full: the banner is one ✕ away from gone, and the
   * KPI strip is what a buyer glances at. */
  it("keeps saying so after the error banner is dismissed", async () => {
    ordersMock.mockRejectedValue(new Error("500 Internal Server Error"));
    const { container } = renderPage();
    await screen.findByText(/Bestellungen konnten nicht geladen werden/);

    fireEvent.click(screen.getAllByRole("button", { name: "Schließen" })[0]);

    expect(kpiValues(container)).toEqual(["—", "—", "—", "—"]);
    expect(
      screen.getByText("Keine Zahlen — Bestellungen wurden nicht geladen."),
    ).toBeInTheDocument();
  });

  it("recovers on retry", async () => {
    ordersMock.mockRejectedValueOnce(new Error("offline"));
    const { container } = renderPage();
    await screen.findByText(/Bestellungen konnten nicht geladen werden/);

    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));

    expect(await screen.findByText("BST-2026-0031")).toBeInTheDocument();
    await waitFor(() => expect(kpiValues(container)[1]).toBe("1"));
  });

  /* A refresh after a successful mutation can fail on its own. Throwing the
   * rows away would hide the change that just landed, so they stay — labelled,
   * because an unlabelled stale list reads as today's, and its figures would
   * be yesterday's presented as fact. */
  it("labels a list that could not be refreshed, and stops quoting its figures", async () => {
    const { container, rerender } = renderPage();
    await screen.findByText("BST-2026-0031");

    ordersMock.mockRejectedValue(new Error("offline"));
    // A re-read of the same list, from the page's own effect.
    rerender(
      <AppContext.Provider value={context("t2") as never}>
        <WerkstattOrdersPage />
      </AppContext.Provider>,
    );

    expect(await screen.findByText(/Letzter geladener Stand/)).toBeInTheDocument();
    // The rows the page did get are still readable…
    expect(screen.getByText("BST-2026-0031")).toBeInTheDocument();
    // …and the KPI strip no longer presents figures counted off them.
    await waitFor(() => expect(kpiValues(container)).toEqual(["—", "—", "—", "—"]));
  });
});
