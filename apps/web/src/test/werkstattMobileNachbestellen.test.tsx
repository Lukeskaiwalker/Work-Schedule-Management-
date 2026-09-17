/**
 * Werkstatt › Nachbestellen on the phone.
 *
 * Same endpoint as the desktop screen, one structural difference that is easy
 * to get wrong: an order carries exactly ONE supplier, so the single footer
 * button cannot be one request. It walks the suppliers and creates one order
 * each — so the cases here are about that walk being honest: what it sends,
 * that a refusal on one supplier does not swallow the others, and that a
 * supplier whose order the server refused is NOT shown as sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { WerkstattMobileNachbestellenPage } from "../pages/werkstatt/WerkstattMobileNachbestellenPage";
import { ApiError } from "../api/client";
import type { WerkstattOrder } from "../types/werkstatt";
import type { ReorderSuggestionGroup } from "../utils/werkstattReorderApi";

vi.mock("../utils/werkstattReorderApi", () => ({
  listReorderSuggestions: vi.fn(),
  submitReorder: vi.fn(),
}));

import { listReorderSuggestions, submitReorder } from "../utils/werkstattReorderApi";

const listMock = vi.mocked(listReorderSuggestions);
const submitMock = vi.mocked(submitReorder);

const GROUPS: ReorderSuggestionGroup[] = [
  {
    supplier_id: 7,
    supplier_name: "Unielektro Fulda GmbH",
    supplier_short_name: "Unielektro",
    default_lead_time_days: 2,
    subtotal_cents: 12000,
    currency: "EUR",
    lines: [
      {
        article_id: 101,
        article_number: "SP-1001",
        article_name: "NYM-J 5x6",
        image_url: null,
        stock_available: 0,
        stock_min: 50,
        suggested_quantity: 100,
        unit: "m",
        unit_price_cents: 120,
        line_total_cents: 12000,
      },
    ],
  },
  {
    supplier_id: 9,
    supplier_name: "Contorion GmbH",
    supplier_short_name: null,
    default_lead_time_days: null,
    subtotal_cents: 12500,
    currency: "EUR",
    lines: [
      {
        article_id: 201,
        article_number: "SP-2001",
        article_name: "Bohrer SDS 8mm",
        image_url: null,
        stock_available: 2,
        stock_min: 6,
        suggested_quantity: 5,
        unit: null,
        unit_price_cents: 2500,
        line_total_cents: 12500,
      },
    ],
  },
];

function order(id: number, number_: string, supplierName: string): WerkstattOrder {
  return {
    id,
    order_number: number_,
    supplier_id: 7,
    supplier_name: supplierName,
    status: "sent",
    line_count: 1,
    currency: "EUR",
    total_amount_cents: 12000,
  } as unknown as WerkstattOrder;
}

function renderPage(permissions: string[] = ["werkstatt:manage"]) {
  const context = makeAppContextStub({
    overrides: {
      mainView: "werkstatt",
      werkstattTab: "nachbestellen",
      language: "de",
      token: "t",
      user: { id: 1, email: "a@b.c", role: "monteur", effective_permissions: permissions },
    },
  });
  return render(
    <AppContext.Provider value={context as never}>
      <WerkstattMobileNachbestellenPage />
    </AppContext.Provider>,
  );
}

function groupSection(supplierName: string): HTMLElement {
  const name = screen.getByText(supplierName);
  const section = name.closest("section");
  if (!section) throw new Error(`no group for ${supplierName}`);
  return section as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue(GROUPS);
  // The page renders only under 768px — pin the viewport there for the suite.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("max-width: 767px"),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
});

describe("WerkstattMobileNachbestellenPage", () => {
  it("shows what the endpoint returned, first supplier open", async () => {
    renderPage();

    expect(await screen.findByText("Unielektro Fulda GmbH")).toBeInTheDocument();
    expect(screen.getByText(/2 Artikel unter Mindestbestand/)).toBeInTheDocument();
    expect(screen.getByText(/2 Lieferanten/)).toBeInTheDocument();
    // First group expanded: its line and stepper are on screen…
    expect(screen.getByText("NYM-J 5x6")).toBeInTheDocument();
    expect(screen.getByText("0 / 50")).toBeInTheDocument();
    // …the second is collapsed until tapped.
    expect(screen.queryByText("Bohrer SDS 8mm")).not.toBeInTheDocument();
    // 100 × 1,20 € + 5 × 25,00 €.
    expect(screen.getByText(/245,00/)).toBeInTheDocument();
  });

  it("creates one order per supplier and says how many that is", async () => {
    submitMock
      .mockResolvedValueOnce(order(1, "BST-2026-0101", "Unielektro Fulda GmbH"))
      .mockResolvedValueOnce(order(2, "BST-2026-0102", "Contorion GmbH"));
    renderPage();
    await screen.findByText("Unielektro Fulda GmbH");

    fireEvent.click(screen.getByRole("button", { name: /2 Bestellungen versenden/ }));

    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(2));
    expect(submitMock.mock.calls[0][1]).toEqual({
      supplier_id: 7,
      lines: [{ article_id: 101, quantity: 100, unit_price_cents: 120 }],
      notes: null,
      allow_unresolved: false,
    });
    expect(submitMock.mock.calls[1][1].supplier_id).toBe(9);
    expect(await screen.findByText("Bestellung BST-2026-0101 versendet")).toBeInTheDocument();
    expect(await screen.findByText(/2 Bestellungen versendet/)).toBeInTheDocument();
  });

  it("sends what the stepper was set to", async () => {
    submitMock.mockResolvedValue(order(1, "BST-2026-0101", "Unielektro Fulda GmbH"));
    renderPage();
    await screen.findByText("Unielektro Fulda GmbH");

    const card = groupSection("Unielektro Fulda GmbH");
    fireEvent.click(within(card).getByRole("button", { name: "Mehr NYM-J 5x6" }));
    fireEvent.click(within(card).getByRole("button", { name: /Bei Unielektro bestellen/ }));

    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
    expect(submitMock.mock.calls[0][1].lines).toEqual([
      { article_id: 101, quantity: 101, unit_price_cents: 120 },
    ]);
  });

  it("keeps a refused supplier out of the sent count and offers the override", async () => {
    submitMock
      .mockRejectedValueOnce(
        new ApiError("1 Position ohne Lieferanten-Artikelnummer", 409, {
          code: "unresolved_lines",
          message: "1 Position ohne Lieferanten-Artikelnummer",
          warnings: ["Unielektro hat keine Artikelnummer für „NYM-J 5x6“"],
          unresolved_positions: [1],
        }),
      )
      .mockResolvedValueOnce(order(2, "BST-2026-0102", "Contorion GmbH"));
    renderPage();
    await screen.findByText("Unielektro Fulda GmbH");

    fireEvent.click(screen.getByRole("button", { name: /2 Bestellungen versenden/ }));

    expect(
      await screen.findByText("1 Position ohne Lieferanten-Artikelnummer"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Pos\. 1 · NYM-J 5x6 \(SP-1001\)/)).toBeInTheDocument();
    // The other supplier went out — and exactly one did.
    await waitFor(() => expect(screen.getByText(/1 Bestellung versendet/)).toBeInTheDocument());

    submitMock.mockResolvedValueOnce(order(3, "BST-2026-0103", "Unielektro Fulda GmbH"));
    fireEvent.click(screen.getByRole("button", { name: "Trotzdem übergeben" }));

    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(3));
    expect(submitMock.mock.calls[2][1]).toMatchObject({ supplier_id: 7, allow_unresolved: true });
    expect(await screen.findByText("Bestellung BST-2026-0103 versendet")).toBeInTheDocument();
  });

  it("opens a collapsed supplier whose order the server refused", async () => {
    submitMock
      .mockResolvedValueOnce(order(1, "BST-2026-0101", "Unielektro Fulda GmbH"))
      .mockRejectedValueOnce(
        new ApiError("1 Position ohne Lieferanten-Artikelnummer", 409, {
          code: "unresolved_lines",
          message: "1 Position ohne Lieferanten-Artikelnummer",
          warnings: [],
          unresolved_positions: [1],
        }),
      );
    renderPage();
    await screen.findByText("Unielektro Fulda GmbH");
    // Contorion starts collapsed — its lines are not on screen.
    expect(screen.queryByText("Bohrer SDS 8mm")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /2 Bestellungen versenden/ }));

    // The refusal belongs to the collapsed group, so the group opens itself…
    expect(await screen.findByText(/Pos\. 1 · Bohrer SDS 8mm \(SP-2001\)/)).toBeInTheDocument();
    // …and its header says so too, for when the buyer closes it again.
    expect(within(groupSection("Contorion GmbH")).getByText(/nicht versendet/)).toBeInTheDocument();
  });

  it("keeps the orders it placed after the list is re-read", async () => {
    submitMock
      .mockResolvedValueOnce(order(1, "BST-2026-0101", "Unielektro Fulda GmbH"))
      .mockResolvedValueOnce(order(2, "BST-2026-0102", "Contorion GmbH"));
    renderPage();
    await screen.findByText("Unielektro Fulda GmbH");

    fireEvent.click(screen.getByRole("button", { name: /2 Bestellungen versenden/ }));
    expect(await screen.findByText(/2 Bestellungen versendet/)).toBeInTheDocument();

    // The phone's refresh icon re-reads a list that still holds the same
    // shortfall — the suggestion engine knows nothing about open orders.
    fireEvent.click(screen.getByRole("button", { name: "Aktualisieren" }));

    expect(await screen.findByText("Bereits bestellt: BST-2026-0101")).toBeInTheDocument();
    // The counter does not reset, and nothing offers to send it all again.
    expect(screen.getByText(/2 Bestellungen versendet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Bestellungen versenden/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Nichts offen/ })).toBeDisabled();
    expect(
      within(groupSection("Unielektro Fulda GmbH")).getByText(/bereits bestellt: BST-2026-0101/),
    ).toBeInTheDocument();
    expect(submitMock).toHaveBeenCalledTimes(2);
  });

  it("does not re-send a supplier whose order may or may not exist", async () => {
    // The link dies on the first supplier: `fetch` rejects, no status, and the
    // endpoint commits before it answers — the order may be at Unielektro.
    submitMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(order(2, "BST-2026-0102", "Contorion GmbH"));
    renderPage();
    await screen.findByText("Unielektro Fulda GmbH");

    fireEvent.click(screen.getByRole("button", { name: /2 Bestellungen versenden/ }));

    expect(
      await screen.findByText("Verbindung abgebrochen — Ergebnis unklar"),
    ).toBeInTheDocument();
    // The other supplier still went out, and exactly one did.
    await waitFor(() => expect(screen.getByText(/1 Bestellung versendet/)).toBeInTheDocument());
    // Neither the group button nor the footer walk will touch it again.
    expect(screen.queryByRole("button", { name: /Bei Unielektro bestellen/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Nichts offen/ })).toBeDisabled();
    expect(submitMock).toHaveBeenCalledTimes(2);

    // Only dismissing it — after checking Werkstatt › Bestellungen — offers
    // the send again.
    fireEvent.click(screen.getByRole("button", { name: "Schließen" }));
    expect(
      await screen.findByRole("button", { name: /Bestellung versenden/ }),
    ).toBeInTheDocument();
  });

  it("says the load failed instead of showing an empty basket", async () => {
    listMock.mockRejectedValueOnce(new Error("Zeitüberschreitung"));
    renderPage();

    expect(await screen.findByText("Liste nicht geladen")).toBeInTheDocument();
    expect(screen.getByText("Zeitüberschreitung")).toBeInTheDocument();
    expect(screen.queryByText(/Artikel unter Mindestbestand/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /versenden/ })).not.toBeInTheDocument();
  });

  it("offers no send button without werkstatt:manage", async () => {
    renderPage([]);
    await screen.findByText("Unielektro Fulda GmbH");

    expect(screen.queryByRole("button", { name: /versenden/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /bestellen/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Nur Ansicht/)).toBeInTheDocument();
  });
});
