/**
 * Werkstatt › Nachbestellen (desktop), from the ways it can lie.
 *
 * The page used to render fixtures, so every number on it was invented and
 * its "Bestellung versenden" sent nothing. The assertions here are therefore
 * about honesty first: the figures come from the endpoint, a failed load shows
 * no figures at all, a submission sends exactly what the buyer set, and the
 * 409 that refuses an unnumbered basket is surfaced with the positions named
 * rather than swallowed or reported as success.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { WerkstattNachbestellenPage } from "../pages/werkstatt/WerkstattNachbestellenPage";
import { ApiError } from "../api/client";
import type { WerkstattOrder } from "../types/werkstatt";
import type { ReorderSuggestionGroup } from "../utils/werkstattReorderApi";

vi.mock("../utils/werkstattReorderApi", () => ({
  listReorderSuggestions: vi.fn(),
  submitReorder: vi.fn(),
}));
vi.mock("../utils/reorderOrderCsv", () => ({ downloadOrderCsv: vi.fn() }));

import { listReorderSuggestions, submitReorder } from "../utils/werkstattReorderApi";
import { downloadOrderCsv } from "../utils/reorderOrderCsv";

const listMock = vi.mocked(listReorderSuggestions);
const submitMock = vi.mocked(submitReorder);
const downloadMock = vi.mocked(downloadOrderCsv);

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
      {
        article_id: 102,
        article_number: "SP-1002",
        article_name: "Kabelbinder 200 mm",
        image_url: null,
        stock_available: 3,
        stock_min: 10,
        suggested_quantity: 17,
        unit: "Stk",
        unit_price_cents: null,
        line_total_cents: null,
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

function sentOrder(overrides: Partial<WerkstattOrder> = {}): WerkstattOrder {
  return {
    id: 4242,
    order_number: "BST-2026-0042",
    supplier_id: 7,
    supplier_name: "Unielektro Fulda GmbH",
    status: "sent",
    line_count: 2,
    currency: "EUR",
    total_amount_cents: 12000,
    ...overrides,
  } as unknown as WerkstattOrder;
}

function unresolvedConflict(): ApiError {
  return new ApiError("1 Position ohne Lieferanten-Artikelnummer", 409, {
    code: "unresolved_lines",
    message: "1 Position ohne Lieferanten-Artikelnummer",
    warnings: ["Unielektro hat keine Artikelnummer für „Kabelbinder 200 mm“"],
    unresolved_positions: [2],
  });
}

function renderPage(
  permissions: string[] = ["werkstatt:manage"],
  extra: Record<string, unknown> = {},
) {
  const context = makeAppContextStub({
    overrides: {
      mainView: "werkstatt",
      werkstattTab: "nachbestellen",
      language: "de",
      token: "t",
      user: { id: 1, email: "a@b.c", role: "admin", effective_permissions: permissions },
      ...extra,
    },
  });
  return render(
    <AppContext.Provider value={context as never}>
      <WerkstattNachbestellenPage />
    </AppContext.Provider>,
  );
}

/**
 * One keystroke into a field, the way a keyboard delivers it: appended to what
 * the input actually holds right now. Typing "250" over a rejected empty field
 * is how 100 became 1002 — `fireEvent.change` with a ready-made string would
 * never have shown it.
 */
function press(input: HTMLInputElement, key: string) {
  fireEvent.change(input, { target: { value: `${input.value}${key}` } });
}

/** The card of one supplier, addressed the way a buyer would: by its name. */
function groupCard(supplierName: string): HTMLElement {
  const heading = screen.getByText(supplierName);
  const card = heading.closest("article");
  if (!card) throw new Error(`no group card for ${supplierName}`);
  return card as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue(GROUPS);
});

describe("WerkstattNachbestellenPage", () => {
  it("shows the suggestions and the totals the endpoint implies", async () => {
    renderPage();

    expect(await screen.findByText("Unielektro Fulda GmbH")).toBeInTheDocument();
    expect(screen.getByText("Contorion GmbH")).toBeInTheDocument();
    expect(screen.getByText("NYM-J 5x6")).toBeInTheDocument();
    // 100 × 1,20 € + 5 × 25,00 € = 245,00 €; the unpriced line is not guessed.
    expect(screen.getByText(/245,00/)).toBeInTheDocument();
    // …and the page says so rather than presenting the sum as complete: once
    // on the line itself, once on the subtotal, once in the KPI strip.
    expect(screen.getByText("kein Preis hinterlegt")).toBeInTheDocument();
    expect(screen.getByText(/zzgl\. 1 Position ohne Preis/)).toBeInTheDocument();
    expect(screen.getByText(/netto, ohne 1 Position\(en\) ohne Preis/)).toBeInTheDocument();
    // Stock pill straight from the article: 0 of a minimum of 50.
    expect(screen.getByText("0 / 50")).toBeInTheDocument();
    expect(screen.getByText(/3 Artikel unter Mindestbestand/)).toBeInTheDocument();
  });

  it("says the load failed instead of rendering zeros", async () => {
    listMock.mockRejectedValueOnce(new Error("Verbindung unterbrochen"));
    renderPage();

    expect(
      await screen.findByText("Die Nachbestell-Vorschläge konnten nicht geladen werden."),
    ).toBeInTheDocument();
    expect(screen.getByText("Verbindung unterbrochen")).toBeInTheDocument();
    // No KPI strip, no invented total.
    expect(screen.queryByText(/VORGESCHLAGENER BESTELLWERT/)).not.toBeInTheDocument();

    listMock.mockResolvedValueOnce(GROUPS);
    fireEvent.click(screen.getByRole("button", { name: "Erneut laden" }));
    expect(await screen.findByText("Unielektro Fulda GmbH")).toBeInTheDocument();
  });

  it("names the empty case rather than showing an empty page", async () => {
    listMock.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText("Nichts nachzubestellen.")).toBeInTheDocument();
  });

  it("submits the quantity the buyer set, and leaves a zeroed line out", async () => {
    submitMock.mockResolvedValue(sentOrder());
    renderPage();
    await screen.findByText("Unielektro Fulda GmbH");

    const card = groupCard("Unielektro Fulda GmbH");
    fireEvent.click(within(card).getByRole("button", { name: "mehr NYM-J 5x6" }));
    fireEvent.change(within(card).getByRole("spinbutton", { name: /Kabelbinder 200 mm/ }), {
      target: { value: "0" },
    });
    fireEvent.click(within(card).getByRole("button", { name: /Bestellen bei Unielektro/ }));

    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
    expect(submitMock).toHaveBeenCalledWith("t", {
      supplier_id: 7,
      lines: [{ article_id: 101, quantity: 101, unit_price_cents: 120 }],
      notes: null,
      allow_unresolved: false,
    });
    expect(await screen.findByText("Bestellung BST-2026-0042 versendet")).toBeInTheDocument();
  });

  it("surfaces the 409 with the positions named, and overrides on demand", async () => {
    submitMock.mockRejectedValueOnce(unresolvedConflict());
    renderPage();
    await screen.findByText("Unielektro Fulda GmbH");

    const card = groupCard("Unielektro Fulda GmbH");
    fireEvent.click(within(card).getByRole("button", { name: /Bestellen bei Unielektro/ }));

    expect(
      await screen.findByText("1 Position ohne Lieferanten-Artikelnummer"),
    ).toBeInTheDocument();
    // Position 2 of the submitted lines is the tie-wrap — named, not numbered.
    expect(screen.getByText(/Pos\. 2 · Kabelbinder 200 mm \(SP-1002\)/)).toBeInTheDocument();
    expect(
      screen.getByText(/Es wurde nichts bestellt und nichts versendet/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/versendet$/)).not.toBeInTheDocument();

    submitMock.mockResolvedValueOnce(sentOrder());
    fireEvent.click(screen.getByRole("button", { name: "Trotzdem übergeben" }));

    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(2));
    expect(submitMock.mock.calls[1][1].allow_unresolved).toBe(true);
    expect(await screen.findByText("Bestellung BST-2026-0042 versendet")).toBeInTheDocument();
    expect(
      screen.getByText(/Übergeben ohne vollständige Lieferanten-Artikelnummern/),
    ).toBeInTheDocument();
  });

  it("reports a failed submission as failed", async () => {
    submitMock.mockRejectedValue(new ApiError("Lieferant nicht gefunden", 404));
    renderPage();
    await screen.findByText("Unielektro Fulda GmbH");

    fireEvent.click(
      within(groupCard("Unielektro Fulda GmbH")).getByRole("button", {
        name: /Bestellen bei Unielektro/,
      }),
    );

    expect(await screen.findByText("Bestellung fehlgeschlagen")).toBeInTheDocument();
    expect(screen.getByText("Lieferant nicht gefunden")).toBeInTheDocument();
    expect(screen.getByText("Es wurde nichts versendet. Bitte erneut versuchen.")).toBeInTheDocument();
  });

  it("exports the order that was created — not the suggestion list", async () => {
    submitMock.mockResolvedValue(sentOrder());
    downloadMock.mockResolvedValue({
      order_id: 4242,
      order_number: "BST-2026-0042",
      filename: "BST-2026-0042.csv",
      identifier: "supplier_no",
      csv: "a;b",
      text: "a",
      warnings: [],
      sent_positions: 2,
      dropped_positions: 0,
      submitted_at: "2026-09-17T08:00:00Z",
    });
    renderPage();
    await screen.findByText("Unielektro Fulda GmbH");

    fireEvent.click(
      within(groupCard("Unielektro Fulda GmbH")).getByRole("button", {
        name: /Bestellen bei Unielektro/,
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "CSV herunterladen" }));

    await waitFor(() => expect(downloadMock).toHaveBeenCalledWith("t", 4242, false));
    expect(await screen.findByText(/BST-2026-0042\.csv heruntergeladen/)).toBeInTheDocument();
  });

  it("names what the CSV leaves out instead of only counting what it holds", async () => {
    submitMock.mockResolvedValue(sentOrder({ line_count: 5 }));
    // The order went out with all five lines; the file can only carry three.
    downloadMock.mockResolvedValue({
      order_id: 4242,
      order_number: "BST-2026-0042",
      filename: "BST-2026-0042.csv",
      identifier: "supplier_no",
      csv: "a;b",
      text: "a",
      warnings: ["Unielektro hat keine Artikelnummer für „Kabelbinder 200 mm“"],
      sent_positions: 3,
      dropped_positions: 2,
      submitted_at: "2026-09-17T08:00:00Z",
    });
    renderPage();
    await screen.findByText("Unielektro Fulda GmbH");

    fireEvent.click(
      within(groupCard("Unielektro Fulda GmbH")).getByRole("button", {
        name: /Bestellen bei Unielektro/,
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "CSV herunterladen" }));

    const notice = await screen.findByText(/BST-2026-0042\.csv heruntergeladen/);
    // A file that is shorter than the order must say so, and say which lines.
    expect(notice.textContent).toContain("3 von 5 Positionen");
    expect(notice.textContent).toContain("2 ohne Lieferanten-Artikelnummer sind NICHT in der Datei");
    expect(notice.textContent).toContain("Kabelbinder 200 mm");
  });

  it("lets the quantity field be cleared, so overtyping replaces the number", async () => {
    submitMock.mockResolvedValue(sentOrder());
    renderPage();
    await screen.findByText("Unielektro Fulda GmbH");

    const card = groupCard("Unielektro Fulda GmbH");
    const field = within(card).getByRole("spinbutton", { name: /NYM-J 5x6/ }) as HTMLInputElement;
    expect(field.value).toBe("100");

    // Backspace to empty: the field must stay empty, not snap back to 100.
    fireEvent.change(field, { target: { value: "" } });
    expect(field.value).toBe("");

    press(field, "2");
    press(field, "5");
    press(field, "0");
    expect(field.value).toBe("250");

    fireEvent.click(within(card).getByRole("button", { name: /Bestellen bei Unielektro/ }));
    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
    expect(submitMock.mock.calls[0][1].lines[0]).toEqual({
      article_id: 101,
      quantity: 250,
      unit_price_cents: 120,
    });
  });

  it("reads a field left empty as “do not order this line”", async () => {
    submitMock.mockResolvedValue(sentOrder());
    renderPage();
    await screen.findByText("Unielektro Fulda GmbH");

    const card = groupCard("Unielektro Fulda GmbH");
    const field = within(card).getByRole("spinbutton", { name: /NYM-J 5x6/ }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.blur(field);

    expect(field.value).toBe("0");
    expect(within(card).getAllByText("wird nicht bestellt").length).toBeGreaterThan(0);

    fireEvent.click(within(card).getByRole("button", { name: /Bestellen bei Unielektro/ }));
    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
    // Only the tie-wrap is left; the cable was taken out of the order.
    expect(submitMock.mock.calls[0][1].lines.map((line) => line.article_id)).toEqual([102]);
  });

  it("does not claim a dropped connection sent nothing, and blocks the retry", async () => {
    // What `fetch` rejects with when the link dies: no status, no ApiError —
    // and the endpoint commits the order before it answers.
    submitMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const setWerkstattTab = vi.fn();
    renderPage(["werkstatt:manage"], { setWerkstattTab });
    await screen.findByText("Unielektro Fulda GmbH");

    fireEvent.click(
      within(groupCard("Unielektro Fulda GmbH")).getByRole("button", {
        name: /Bestellen bei Unielektro/,
      }),
    );

    expect(
      await screen.findByText("Verbindung abgebrochen — Ergebnis unklar"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Es wurde nichts versendet/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Erneut versuchen" })).not.toBeInTheDocument();
    // And no way to fire a second order without deciding to: the group's own
    // button is gone until the panel is dismissed.
    expect(screen.queryByRole("button", { name: /Bestellen bei Unielektro/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Zu den Bestellungen" }));
    expect(setWerkstattTab).toHaveBeenCalledWith("orders");

    fireEvent.click(screen.getByRole("button", { name: "Schließen" }));
    expect(
      await screen.findByRole("button", { name: /Bestellen bei Unielektro/ }),
    ).toBeInTheDocument();
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it("still knows about the order after the list is re-read", async () => {
    submitMock.mockResolvedValue(sentOrder());
    renderPage();
    await screen.findByText("Unielektro Fulda GmbH");
    // 100 × 1,20 € + 5 × 25,00 € while nothing has been ordered.
    expect(screen.getByText(/245,00/)).toBeInTheDocument();

    fireEvent.click(
      within(groupCard("Unielektro Fulda GmbH")).getByRole("button", {
        name: /Bestellen bei Unielektro/,
      }),
    );
    await screen.findByText("Bestellung BST-2026-0042 versendet");

    // The suggestion engine does not look at open orders: the same shortfall
    // comes straight back with the same lines.
    fireEvent.click(screen.getByRole("button", { name: "Aktualisieren" }));

    expect(await screen.findByText("Bereits bestellt: BST-2026-0042")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Bestellen bei Unielektro/ })).not.toBeInTheDocument();
    // Its money stays out of the basket total, too.
    expect(screen.queryByText(/245,00/)).not.toBeInTheDocument();
    // …and the locked line shows what was ORDERED, not the fresh suggestion.
    expect(
      within(groupCard("Unielektro Fulda GmbH")).getByText("100"),
    ).toBeInTheDocument();

    // Only an explicit dismissal hands the button back.
    fireEvent.click(screen.getByRole("button", { name: "Schließen" }));
    expect(
      await screen.findByRole("button", { name: /Bestellen bei Unielektro/ }),
    ).toBeInTheDocument();
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it("offers no order button without werkstatt:manage", async () => {
    renderPage([]);
    await screen.findByText("Unielektro Fulda GmbH");

    expect(screen.queryByRole("button", { name: /Bestellen bei/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Nur Ansicht/)).toBeInTheDocument();
  });
});
