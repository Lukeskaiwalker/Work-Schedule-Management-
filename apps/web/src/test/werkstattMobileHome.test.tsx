/**
 * The phone start screen used to render the mobile checkout fixtures and a
 * constant below-minimum count, and made no request at all. These tests pin the three
 * things that had to become true when it was wired:
 *
 *  * the rows come from `GET /werkstatt/mobile/my-checkouts`,
 *  * a failed load SAYS so — it never falls back to zero, which on this screen
 *    reads as "nothing is borrowed" to a workshop that acts on it,
 *  * "Zurück" books a real return instead of doing nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { WerkstattMobileHomePage } from "../pages/werkstatt/WerkstattMobileHomePage";

const CHECKOUT = {
  article_id: 42,
  article_number: "SP-0201",
  article_name: "Bohrhammer GBH 2-28",
  image_url: null,
  unit: "Stk",
  quantity_out: 2,
  earliest_checkout_at: "2026-09-15T07:00:00Z",
  // Far future on purpose: "overdue" must not depend on when the suite runs.
  latest_expected_return_at: "2099-01-01T16:00:00Z",
  project_id: 7,
  project_number: "P-2026-014",
  project_name: "Neubau Nord",
};

const ARTICLE_AFTER_RETURN = {
  id: 42,
  article_number: "SP-0201",
  item_name: "Bohrhammer GBH 2-28",
  stock_total: 12,
  stock_available: 11,
  stock_out: 1,
  stock_status: "available",
  unit: "Stk",
};

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface Routes {
  checkouts?: () => Response;
  dashboard?: () => Response;
  /** Gets the parsed request body so a test can keep a ledger of its own. */
  ret?: (body: Record<string, unknown>) => Response;
}

/** Stub the network and record every call so the writes can be asserted. */
function stubApi(routes: Routes = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/werkstatt/mobile/my-checkouts")) {
        return routes.checkouts ? routes.checkouts() : json([CHECKOUT]);
      }
      if (url.includes("/werkstatt/dashboard")) {
        return routes.dashboard
          ? routes.dashboard()
          : json({
              kpis: {
                total_articles: 120,
                total_categories: 8,
                below_min_count: 7,
                on_site_count: 3,
                on_site_project_count: 1,
                unavailable_count: 0,
                in_repair_count: 0,
              },
              reorder_preview: [],
              recent_movements: [],
              on_site_groups: [],
              maintenance_entries: [],
            });
      }
      if (url.includes("/werkstatt/mobile/return")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        return routes.ret ? routes.ret(body) : json(ARTICLE_AFTER_RETURN);
      }
      return json([]);
    }),
  );
  return calls;
}

/** jsdom has no matchMedia; the page self-gates on the phone breakpoint. */
function stubPhoneViewport() {
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
}

function renderHome(overrides: Record<string, unknown> = {}) {
  stubPhoneViewport();
  return render(
    <AppContext.Provider
      value={
        makeAppContextStub({
          overrides: {
            mainView: "werkstatt",
            werkstattTab: "dashboard",
            language: "de",
            token: "test-token",
            user: { id: 1, display_name: "Luca Schmidt", effective_permissions: [] },
            ...overrides,
          },
        }) as never
      }
    >
      <WerkstattMobileHomePage />
    </AppContext.Provider>,
  );
}

describe("Werkstatt Mobile — Start", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("shows the checkouts the server returned, not a fixture", async () => {
    stubApi();
    renderHome();

    expect(await screen.findByText("Bohrhammer GBH 2-28")).toBeInTheDocument();
    expect(screen.getByText(/2 Stk/)).toBeInTheDocument();
    expect(screen.getByText(/P-2026-014/)).toBeInTheDocument();
    expect(screen.getByText("1 Artikel unterwegs")).toBeInTheDocument();
    // Not overdue: the agreed date is in the future.
    expect(screen.queryByText(/überfällig/)).toBeNull();
  });

  it("takes the below-minimum count from the dashboard KPIs", async () => {
    stubApi();
    renderHome();

    expect(await screen.findByText("7 Artikel unter Mindestbestand")).toBeInTheDocument();
  });

  it("says a failed load failed instead of rendering zeros", async () => {
    stubApi({
      checkouts: () => json({ detail: "Datenbank nicht erreichbar" }, 500),
      dashboard: () => json({ detail: "Datenbank nicht erreichbar" }, 500),
    });
    renderHome();

    expect(
      await screen.findByText("Entnahmen konnten nicht geladen werden"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Mindestbestand konnte nicht geladen werden"),
    ).toBeInTheDocument();
    // The two lies this screen shipped with, in the shape they would take.
    expect(screen.queryByText("0 Artikel unterwegs")).toBeNull();
    expect(screen.queryByText("0 Artikel unter Mindestbestand")).toBeNull();
    expect(screen.queryByText("Nichts ausgeliehen")).toBeNull();
  });

  it("tells an empty list apart from a broken one", async () => {
    stubApi({ checkouts: () => json([]) });
    renderHome();

    expect(await screen.findByText("Nichts ausgeliehen")).toBeInTheDocument();
    expect(screen.getByText("0 Artikel unterwegs")).toBeInTheDocument();
    expect(screen.queryByText("Entnahmen konnten nicht geladen werden")).toBeNull();
  });

  it("books a real return through POST /werkstatt/mobile/return", async () => {
    const calls = stubApi();
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: "Bohrhammer GBH 2-28 zurückgeben" }));
    // Seeded with everything that is out — the common case is one more tap.
    fireEvent.click(screen.getByRole("button", { name: "Rückgabe bestätigen" }));

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("/werkstatt/mobile/return"))).toBe(true);
    });
    const write = calls.find((call) => call.url.includes("/werkstatt/mobile/return"));
    expect(write?.init?.method).toBe("POST");
    expect(JSON.parse(String(write?.init?.body))).toEqual({
      article_id: 42,
      quantity: 2,
      condition: "ok",
      // The row IS a loan — one (article, project) bucket. A return that does
      // not name it subtracts from the caller's no-project bucket instead, so
      // the row it was meant to close never goes away.
      project_id: 7,
      notes: null,
    });
  });

  it("clears the row it just returned instead of re-rendering it", async () => {
    // The old stub answered my-checkouts with a constant, so the reload could
    // not contradict the success notice even when the server would. This one
    // balances the ledger the way `list_my_checkouts` does — per
    // (article, project), keeping only buckets that are still positive.
    const ledger: Array<{ project_id: number | null; qty: number }> = [
      { project_id: CHECKOUT.project_id, qty: 2 },
    ];
    const openLoans = () => {
      const byProject = new Map<number | null, number>();
      for (const row of ledger) {
        byProject.set(row.project_id, (byProject.get(row.project_id) ?? 0) + row.qty);
      }
      return [...byProject.entries()]
        .filter(([, qty]) => qty > 0)
        .map(([projectId, qty]) => ({
          ...CHECKOUT,
          project_id: projectId,
          project_number: projectId === null ? null : CHECKOUT.project_number,
          project_name: projectId === null ? null : CHECKOUT.project_name,
          quantity_out: qty,
        }));
    };

    stubApi({
      checkouts: () => json(openLoans()),
      ret: (body) => {
        ledger.push({
          project_id: (body.project_id as number | null) ?? null,
          qty: -(body.quantity as number),
        });
        return json(ARTICLE_AFTER_RETURN);
      },
    });
    renderHome();

    fireEvent.click(
      await screen.findByRole("button", { name: "Bohrhammer GBH 2-28 zurückgeben" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Rückgabe bestätigen" }));

    // Without the project on the POST the reloaded list still showed the row,
    // directly under a green notice saying it had come back.
    expect(await screen.findByText("Nichts ausgeliehen")).toBeInTheDocument();
    expect(screen.queryByText("Bohrhammer GBH 2-28")).toBeNull();
  });

  it("keeps the sheet open and shows why when the server refuses", async () => {
    stubApi({ ret: () => json({ detail: "Mehr als unterwegs" }, 400) });
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: "Bohrhammer GBH 2-28 zurückgeben" }));
    fireEvent.click(screen.getByRole("button", { name: "Rückgabe bestätigen" }));

    expect(await screen.findByText("Mehr als unterwegs")).toBeInTheDocument();
    // Still open, so the quantity and note the user picked survive the refusal.
    expect(screen.getByRole("dialog", { name: "Artikel zurückgeben" })).toBeInTheDocument();
  });

  it("searches stock instead of leaving the field inert", async () => {
    const calls = stubApi();
    renderHome();

    fireEvent.change(await screen.findByPlaceholderText("Artikel oder Nummer suchen…"), {
      target: { value: "bohr" },
    });

    await waitFor(
      () => {
        expect(calls.some((call) => call.url.includes("/werkstatt/articles?q=bohr"))).toBe(true);
      },
      { timeout: 2000 },
    );
  });
});
