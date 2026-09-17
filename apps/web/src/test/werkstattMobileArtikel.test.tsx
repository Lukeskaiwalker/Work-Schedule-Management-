/**
 * The phone's article screen is what a scan lands on, and it rendered a
 * fixture: LAGER 0 / UNTERWEGS 0 / BESTAND 0 and an empty name for an article
 * with a dozen on the shelf. These tests pin that it now reads
 * `GET /werkstatt/articles/{id}`, that its three actions reach the real
 * endpoints, and that the one action needing `werkstatt:manage` is not offered
 * to somebody who would only collect a 403.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { WerkstattMobileArtikelPage } from "../pages/werkstatt/WerkstattMobileArtikelPage";

const ARTICLE = {
  id: 42,
  article_number: "SP-0201",
  ean: "4012345678901",
  internal_code: null,
  item_name: "Bohrhammer GBH 2-28",
  manufacturer: "Bosch",
  category_id: 3,
  category_name: "Elektrowerkzeug",
  location_id: 2,
  location_name: "Regal B2",
  unit: "Stk",
  image_url: null,
  image_source: null,
  image_checked_at: null,
  source_catalog_item_id: null,
  stock_total: 12,
  stock_available: 9,
  stock_out: 3,
  stock_repair: 0,
  stock_min: 4,
  stock_status: "available",
  is_serialized: false,
  bg_inspection_required: false,
  bg_inspection_interval_days: null,
  last_bg_inspected_at: null,
  next_bg_due_at: null,
  purchase_price_cents: 24900,
  currency: "EUR",
  notes: null,
  is_archived: false,
  suppliers: [
    {
      id: 5,
      article_id: 42,
      supplier_id: 9,
      supplier_name: "Unielektro",
      supplier_article_no: "UE-99812",
      typical_price_cents: 24900,
      currency: "EUR",
      typical_lead_time_days: 2,
      effective_lead_time_days: 2,
      minimum_order_quantity: 1,
      is_preferred: true,
      source_catalog_item_id: null,
      last_ordered_at: null,
      last_confirmed_lead_time_days: null,
      notes: null,
      created_at: "2026-01-01T09:00:00Z",
      updated_at: "2026-01-01T09:00:00Z",
    },
  ],
  next_expected_delivery_at: null,
  created_at: "2026-01-01T09:00:00Z",
  updated_at: "2026-09-01T09:00:00Z",
};

const MOVEMENTS = [
  {
    id: 900,
    article_id: 42,
    article_number: "SP-0201",
    article_name: "Bohrhammer GBH 2-28",
    movement_type: "checkout",
    quantity: 3,
    from_location_name: "Regal B2",
    to_location_name: null,
    project_id: 7,
    project_number: "P-2026-014",
    project_name: "Neubau Nord",
    user_id: 1,
    user_display_name: "Luca Schmidt",
    assignee_user_id: 1,
    assignee_display_name: "Luca Schmidt",
    expected_return_at: null,
    notes: null,
    created_at: "2026-09-12T12:30:00Z",
  },
  {
    // Another article's movement: the endpoint is caller-scoped, not
    // article-scoped, so the screen has to filter and must not show this.
    id: 901,
    article_id: 77,
    article_number: "SP-0777",
    article_name: "Leitungssucher",
    movement_type: "return",
    quantity: 1,
    from_location_name: null,
    to_location_name: "Regal A1",
    project_id: null,
    project_number: null,
    project_name: null,
    user_id: 1,
    user_display_name: "Luca Schmidt",
    assignee_user_id: null,
    assignee_display_name: null,
    expected_return_at: null,
    notes: null,
    created_at: "2026-09-11T08:00:00Z",
  },
];

/**
 * What `GET /werkstatt/mobile/my-checkouts` says the CALLER is holding.
 *
 * The screen needs it because the article's `stock_out` is the whole TEAM's
 * outstanding quantity, and a return can only give back one's own.
 */
const MY_CHECKOUT = {
  article_id: 42,
  article_number: "SP-0201",
  article_name: "Bohrhammer GBH 2-28",
  image_url: null,
  unit: "Stk",
  quantity_out: 1,
  earliest_checkout_at: "2026-09-15T07:00:00Z",
  latest_expected_return_at: null,
  project_id: 7,
  project_number: "P-2026-014",
  project_name: "Neubau Nord",
};

/** The narrowed payload `POST /werkstatt/articles/{id}/movements` answers. */
const STOCK_SNAPSHOT = {
  article_id: 42,
  stock_total: 13,
  stock_available: 10,
  stock_status: "available",
};

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface Routes {
  /** Called with 1 on the first article GET, 2 on the next — so a test can
   *  show the screen a different server state after a refetch. */
  article?: (nth: number) => Response;
  movements?: () => Response;
  checkouts?: () => Response;
  checkout?: () => Response;
  ret?: () => Response;
  adjust?: () => Response;
}

function stubApi(routes: Routes = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let articleReads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/werkstatt/mobile/movements")) {
        return routes.movements ? routes.movements() : json(MOVEMENTS);
      }
      if (url.includes("/werkstatt/mobile/my-checkouts")) {
        return routes.checkouts ? routes.checkouts() : json([MY_CHECKOUT]);
      }
      if (url.includes("/werkstatt/mobile/checkout")) {
        return routes.checkout
          ? routes.checkout()
          : json({ ...ARTICLE, stock_available: 8, stock_out: 4 });
      }
      if (url.includes("/werkstatt/mobile/return")) {
        return routes.ret ? routes.ret() : json({ ...ARTICLE, stock_out: 2 });
      }
      // Before the plain article route: the stock-take POSTs to this path.
      if (url.includes("/werkstatt/articles/42/movements")) {
        return routes.adjust ? routes.adjust() : json(STOCK_SNAPSHOT);
      }
      if (url.includes("/werkstatt/articles/42")) {
        articleReads += 1;
        return routes.article ? routes.article(articleReads) : json(ARTICLE);
      }
      return json([]);
    }),
  );
  return calls;
}

/** How many times the screen has asked the server for the article itself. */
function articleReadCount(calls: Array<{ url: string; init?: RequestInit }>): number {
  return calls.filter(
    (call) => call.url.includes("/werkstatt/articles/42") && !call.url.includes("/movements"),
  ).length;
}

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

function renderArtikel(overrides: Record<string, unknown> = {}) {
  stubPhoneViewport();
  return render(
    <AppContext.Provider
      value={
        makeAppContextStub({
          overrides: {
            mainView: "werkstatt",
            werkstattTab: "artikel",
            activeWerkstattArticleId: 42,
            language: "de",
            token: "test-token",
            projects: [],
            user: { id: 1, display_name: "Luca Schmidt", effective_permissions: [] },
            ...overrides,
          },
        }) as never
      }
    >
      <WerkstattMobileArtikelPage />
    </AppContext.Provider>,
  );
}

describe("Werkstatt Mobile — Artikel-Detail", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("renders the server's counters, not three zeros", async () => {
    stubApi();
    renderArtikel();

    expect(await screen.findByText("Bohrhammer GBH 2-28")).toBeInTheDocument();
    expect(screen.getByText("9")).toBeInTheDocument(); // LAGER
    expect(screen.getByText("3")).toBeInTheDocument(); // UNTERWEGS
    expect(screen.getByText("12")).toBeInTheDocument(); // BESTAND
    expect(screen.getByText("Regal B2")).toBeInTheDocument();
    expect(screen.getByText(/4012345678901/)).toBeInTheDocument();
    expect(screen.getByText("Unielektro")).toBeInTheDocument();
    expect(screen.getByText("UE-99812")).toBeInTheDocument();
  });

  it("keeps the caller-scoped ledger to this article", async () => {
    stubApi();
    renderArtikel();

    expect(await screen.findByText("Entnommen")).toBeInTheDocument();
    // "1 Einträge" was German the workshop does not speak.
    expect(screen.getByText("1 Eintrag")).toBeInTheDocument();
    // And the count is a window, not this article's history.
    expect(screen.getByText("aus deinen letzten 200 Buchungen")).toBeInTheDocument();
    // The other article's movement came back in the same response.
    expect(screen.queryByText("Zurückgegeben")).toBeNull();
  });

  it("says the article could not be loaded rather than showing an empty one", async () => {
    stubApi({ article: () => json({ detail: "Werkstatt article not found" }, 404) });
    renderArtikel();

    expect(await screen.findByText("Artikel konnte nicht geladen werden")).toBeInTheDocument();
    expect(screen.getByText("Werkstatt article not found")).toBeInTheDocument();
    expect(screen.queryByText("LAGER")).toBeNull();
  });

  it("checks out through POST /werkstatt/mobile/checkout", async () => {
    const calls = stubApi();
    renderArtikel();

    fireEvent.click(await screen.findByRole("button", { name: "Entnehmen" }));
    fireEvent.click(screen.getByRole("button", { name: /Entnahme bestätigen/ }));

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("/werkstatt/mobile/checkout"))).toBe(true);
    });
    const write = calls.find((call) => call.url.includes("/werkstatt/mobile/checkout"));
    expect(write?.init?.method).toBe("POST");
    const body = JSON.parse(String(write?.init?.body));
    expect(body.article_id).toBe(42);
    expect(body.quantity).toBe(1);
  });

  it("hides „Bestand anpassen“ from a user the endpoint would 403", async () => {
    stubApi();
    renderArtikel();

    fireEvent.click(await screen.findByRole("button", { name: "Weitere Aktionen" }));
    expect(screen.queryByRole("menuitem", { name: "Bestand anpassen" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Zurückgeben" })).toBeEnabled();
  });

  it("offers it to a user who holds werkstatt:manage", async () => {
    stubApi();
    renderArtikel({
      user: {
        id: 1,
        display_name: "Luca Schmidt",
        effective_permissions: ["werkstatt:manage"],
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Weitere Aktionen" }));
    expect(screen.getByRole("menuitem", { name: "Bestand anpassen" })).toBeEnabled();
  });

  it("will not offer a checkout the server has nothing left for", async () => {
    stubApi({
      article: () => json({ ...ARTICLE, stock_available: 0, stock_out: 12 }),
    });
    renderArtikel();

    const primary = await screen.findByRole("button", { name: "Nichts verfügbar" });
    expect(primary).toBeDisabled();
  });

  it("caps the return at what the CALLER holds, not the team's stock_out", async () => {
    // 14 out across the workshop, one of them hers. Seeded from `stock_out`
    // the sheet opened on 14 and one tap booked thirteen colleagues' drums
    // back onto the shelf — a return the server cannot refuse, because
    // `apply_movement` only checks the article's global figure.
    const calls = stubApi({
      article: () => json({ ...ARTICLE, stock_available: 0, stock_out: 14 }),
      checkouts: () => json([{ ...MY_CHECKOUT, quantity_out: 1 }]),
    });
    renderArtikel();

    fireEvent.click(await screen.findByRole("button", { name: "Weitere Aktionen" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Zurückgeben" }));

    expect(await screen.findByText(/1 Stk auf deinen Namen/)).toBeInTheDocument();
    expect(screen.queryByText(/14 Stk/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Rückgabe bestätigen" }));
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("/werkstatt/mobile/return"))).toBe(true);
    });
    const body = JSON.parse(
      String(calls.find((call) => call.url.includes("/werkstatt/mobile/return"))?.init?.body),
    );
    expect(body.quantity).toBe(1);
    // And it closes the loan it came from, so the row can actually clear.
    expect(body.project_id).toBe(7);
  });

  it("does not offer a return to somebody holding none of it, and says why", async () => {
    stubApi({
      article: () => json({ ...ARTICLE, stock_out: 14 }),
      checkouts: () => json([]),
    });
    renderArtikel();

    fireEvent.click(await screen.findByRole("button", { name: "Weitere Aktionen" }));
    const item = screen.getByRole("menuitem", {
      name: "Zurückgeben — nichts auf deinen Namen",
    });
    expect(item).toBeDisabled();
  });

  it("lets the user say which loan a return closes when there are several", async () => {
    const calls = stubApi({
      article: () => json({ ...ARTICLE, stock_out: 5 }),
      checkouts: () =>
        json([
          { ...MY_CHECKOUT, quantity_out: 2 },
          {
            ...MY_CHECKOUT,
            project_id: null,
            project_number: null,
            project_name: null,
            quantity_out: 3,
          },
        ]),
    });
    renderArtikel();

    fireEvent.click(await screen.findByRole("button", { name: "Weitere Aktionen" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Zurückgeben" }));

    // Opens on the first loan …
    expect(await screen.findByText(/2 Stk auf deinen Namen/)).toBeInTheDocument();
    // … and switching re-seeds the quantity with the other loan's own cap.
    fireEvent.click(screen.getByRole("radio", { name: /Ohne Projekt/ }));
    expect(screen.getByText(/3 Stk auf deinen Namen/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Rückgabe bestätigen" }));
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("/werkstatt/mobile/return"))).toBe(true);
    });
    const body = JSON.parse(
      String(calls.find((call) => call.url.includes("/werkstatt/mobile/return"))?.init?.body),
    );
    expect(body).toMatchObject({ article_id: 42, quantity: 3, project_id: null });
  });

  it("refreshes the figures when the stock-take loses the optimistic lock", async () => {
    const CONFLICT =
      "Der Bestand hat sich inzwischen geändert: angezeigt waren 12 Stk, aktuell sind es 30 Stk.";
    const calls = stubApi({
      // Second read = after the 409, and it is a different shelf.
      article: (nth) => json(nth === 1 ? ARTICLE : { ...ARTICLE, stock_total: 30 }),
      adjust: () => json({ detail: CONFLICT }, 409),
    });
    renderArtikel({
      user: {
        id: 1,
        display_name: "Luca Schmidt",
        effective_permissions: ["werkstatt:manage"],
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Weitere Aktionen" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Bestand anpassen" }));
    fireEvent.click(screen.getByRole("radio", { name: /Inventur-Korrektur/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Gezählter Regalbestand" }), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Wareneingang Lieferschein/), {
      target: { value: "Inventur 09/2026" },
    });

    const before = articleReadCount(calls);
    fireEvent.click(screen.getByRole("button", { name: "Korrektur speichern" }));

    // The server's own sentence survives …
    expect(await screen.findByText(new RegExp("aktuell sind es 30 Stk"))).toBeInTheDocument();
    // … with the wording this client can stand behind appended.
    expect(
      screen.getByText(/Die Zahlen oben sind soeben aktualisiert worden/),
    ).toBeInTheDocument();
    // Without the refetch the dialog kept showing 12 and every retry re-sent
    // expected_total 12 for the identical 409.
    await waitFor(() => expect(articleReadCount(calls)).toBeGreaterThan(before));
    // Exact, not a regex: the 409 sentence quotes "30 Stk" too, and the point
    // here is the dialog's own GESAMT figure.
    expect(await screen.findByText("30 Stk")).toBeInTheDocument();
  });

  it("keeps a plain refusal plain — no stale-stock wording on a 400", async () => {
    stubApi({
      adjust: () => json({ detail: "Reason is required" }, 400),
    });
    renderArtikel({
      user: {
        id: 1,
        display_name: "Luca Schmidt",
        effective_permissions: ["werkstatt:manage"],
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Weitere Aktionen" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Bestand anpassen" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Menge" }), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Wareneingang Lieferschein/), {
      target: { value: "LS-2026-0001" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Korrektur speichern" }));

    expect(await screen.findByText("Reason is required")).toBeInTheDocument();
    expect(screen.queryByText(/soeben aktualisiert worden/)).toBeNull();
  });

  it("calls an empty ledger a window, not an absence", async () => {
    stubApi({ movements: () => json([]) });
    renderArtikel();

    expect(await screen.findByText("Nichts in diesem Ausschnitt")).toBeInTheDocument();
    expect(
      screen.getByText(
        "In deinen letzten 200 Buchungen ist zu diesem Artikel nichts dabei — ältere können darunter fehlen.",
      ),
    ).toBeInTheDocument();
    // The sentence this screen used to state as fact about the whole ledger.
    expect(
      screen.queryByText("Zu diesem Artikel ist nichts auf deinen Namen gebucht."),
    ).toBeNull();
  });

  it("names the shelf code and the EAN instead of calling one of them „Barcode“", async () => {
    stubApi({ article: () => json({ ...ARTICLE, internal_code: "SMPL-000042" }) });
    renderArtikel();

    // The sticker on the shelf is the internal code; both are named so nobody
    // has to guess which number they are holding.
    expect(
      await screen.findByText("Regal-Code SMPL-000042 · EAN 4012345678901"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Barcode /)).toBeNull();
  });

  it("refuses bookings on an archived article and says why", async () => {
    stubApi({ article: () => json({ ...ARTICLE, is_archived: true }) });
    renderArtikel();

    expect(
      await screen.findByText("Dieser Artikel ist archiviert — Buchungen werden abgelehnt."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Artikel archiviert" })).toBeDisabled();
  });
});
