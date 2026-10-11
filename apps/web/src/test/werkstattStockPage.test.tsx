/**
 * The Bestand page: find an article, see what to do with it, and find it again
 * after creating it.
 *
 * The owner's report, in his words: "can not even change the stock when we
 * added one by searching for it in the stock page. The edit button does not
 * work or show right … sometimes I am not able to search for an already added
 * item by its supplier part number."
 *
 * Root causes pinned here:
 *
 *   - the list was filtered TWICE: the server matched name/number/EAN/…, and
 *     the page then kept only rows whose name, number, category or location
 *     contained the text. A hit by EAN or supplier number came back from the
 *     server and was thrown away in the browser;
 *   - after "scan → nicht gefunden → Neuer Artikel" the scanned EAN stayed in
 *     the search box, so the article just created was filtered out of sight;
 *   - Bearbeiten and Bestand anpassen lived only behind a clipped "…" menu.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { WerkstattInventarPage } from "../pages/werkstatt/WerkstattInventarPage";

const ROW = {
  id: 7,
  article_number: "SP-0042",
  ean: "4001234567890",
  internal_code: null,
  item_name: "Bohrer SDS-Plus 8mm",
  manufacturer: "Bosch",
  category_name: "Werkzeug",
  location_name: "Regal B2",
  stock_available: 9,
  stock_total: 12,
  stock_status: "available",
  image_url: null,
  next_expected_delivery_at: null,
  unit: null,
};

const FULL_ARTICLE = {
  ...ROW,
  category_id: null,
  location_id: null,
  image_source: null,
  image_checked_at: null,
  source_catalog_item_id: null,
  stock_out: 3,
  stock_repair: 0,
  stock_min: 0,
  is_serialized: false,
  bg_inspection_required: false,
  bg_inspection_interval_days: null,
  last_bg_inspected_at: null,
  next_bg_due_at: null,
  purchase_price_cents: null,
  currency: "EUR",
  notes: null,
  is_archived: false,
  suppliers: [],
  created_at: "2026-01-01T00:00:00",
  updated_at: "2026-01-01T00:00:00",
};

/** The Bestand search box, by its English placeholder. */
const STOCK_SEARCH = "Name, SP no., EAN, supplier no. …";

type Call = { method: string; url: string; body: unknown };
type Route = (call: Call) => unknown;

const MANAGER = { id: 1, effective_permissions: ["werkstatt:manage"] };
const VIEWER = { id: 2, effective_permissions: ["werkstatt:view"] };

/** A fetch stub that asks `route` first and falls back to a list of [ROW]. */
function stubApi(route: Route = () => undefined) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const call = { method, url, body: init?.body ? JSON.parse(String(init.body)) : null };
      calls.push(call);
      const answer = await route(call);
      const payload =
        answer !== undefined
          ? answer
          : url.includes("/duplicates") || url.includes("/categories") || url.includes("/locations") || url.includes("/suppliers")
            ? []
            : url.match(/\/werkstatt\/articles\/7(\?|$)/)
              ? FULL_ARTICLE
              : [ROW];
      if (payload instanceof Response) return payload;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

function renderPage(extra: Record<string, unknown> = {}) {
  const setNotice = vi.fn();
  render(
    <AppContext.Provider
      value={
        makeAppContextStub({
          overrides: {
            mainView: "werkstatt",
            werkstattTab: "inventar",
            language: "en",
            token: "test-token",
            projects: [],
            user: MANAGER,
            setNotice,
            ...extra,
          },
        }) as never
      }
    >
      <WerkstattInventarPage />
    </AppContext.Provider>,
  );
  return { setNotice };
}

const listCalls = (calls: Call[]) =>
  calls.filter(
    (call) => call.method === "GET" && /\/werkstatt\/articles(\?|$)/.test(call.url),
  );
const qOf = (call: Call) => new URL(call.url, "http://x").searchParams.get("q");

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest("[role='row']");
  if (!row) throw new Error(`no row for ${name}`);
  return row as HTMLElement;
}

function scan(code: string) {
  for (const key of code) fireEvent.keyDown(document.body, { key });
  fireEvent.keyDown(document.body, { key: "Enter" });
}

describe("Bestand row — visible actions", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("puts 'Stock' and 'Edit' on the row itself for a stock manager", async () => {
    stubApi();
    renderPage();
    await screen.findByText("Bohrer SDS-Plus 8mm");
    const row = rowOf("Bohrer SDS-Plus 8mm");

    fireEvent.click(within(row).getByRole("button", { name: "Stock" }));
    expect(await screen.findByRole("dialog", { name: "Adjust stock" })).toHaveTextContent("SP-0042");
    // The row click (Entnehmen) must not fire underneath the button.
    expect(screen.queryByRole("dialog", { name: "Check out item" })).toBeNull();
  });

  it("opens the edit dialog from the row's 'Edit' button", async () => {
    stubApi();
    renderPage();
    await screen.findByText("Bohrer SDS-Plus 8mm");

    fireEvent.click(within(rowOf("Bohrer SDS-Plus 8mm")).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit article" });
    await within(dialog).findByText(/SP-0042 · Bohrer SDS-Plus 8mm/);
    expect(screen.queryByRole("dialog", { name: "Check out item" })).toBeNull();
  });

  it("shows neither button without werkstatt:manage", async () => {
    stubApi();
    renderPage({ user: VIEWER });
    await screen.findByText("Bohrer SDS-Plus 8mm");
    const row = rowOf("Bohrer SDS-Plus 8mm");
    expect(within(row).queryByRole("button", { name: "Stock" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("folds a booking made in the edit dialog back into the row", async () => {
    stubApi((call) =>
      call.method === "POST" && call.url.endsWith("/movements")
        ? { id: 7, stock_total: 17, stock_available: 14, stock_status: "available" }
        : undefined,
    );
    renderPage();
    await screen.findByText("Bohrer SDS-Plus 8mm");
    fireEvent.click(within(rowOf("Bohrer SDS-Plus 8mm")).getByRole("button", { name: "Edit" }));
    const section = await screen.findByRole("group", { name: "Stock" });

    fireEvent.change(within(section).getByRole("spinbutton", { name: "Goods receipt" }), {
      target: { value: "5" },
    });
    fireEvent.click(within(section).getByRole("button", { name: "Book receipt" }));

    await waitFor(() =>
      expect(within(rowOf("Bohrer SDS-Plus 8mm")).getByText("14 pcs")).toBeInTheDocument(),
    );
  });
});

describe("Bestand search — the server is the only text filter", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("keeps a row the server matched by supplier number, and says why it matched", async () => {
    // Regression: the client re-filter kept only name/number/category/location
    // matches, so this row arrived and was dropped.
    const calls = stubApi((call) =>
      listCalls([call]).length && qOf(call) === "26190"
        ? [{ ...ROW, matched_supplier_article_no: "26190" }]
        : undefined,
    );
    renderPage();
    await screen.findByText("Bohrer SDS-Plus 8mm");

    fireEvent.change(screen.getByPlaceholderText(STOCK_SEARCH), { target: { value: "26190" } });

    await waitFor(() => expect(listCalls(calls).some((call) => qOf(call) === "26190")).toBe(true));
    const row = await waitFor(() => rowOf("Bohrer SDS-Plus 8mm"));
    await waitFor(() => expect(row).toHaveTextContent("Supplier no. 26190"));
  });

  it("keeps a row the server matched by EAN", async () => {
    stubApi();
    renderPage();
    await screen.findByText("Bohrer SDS-Plus 8mm");

    fireEvent.change(screen.getByPlaceholderText(STOCK_SEARCH), {
      target: { value: "4001234567890" },
    });
    // Give the debounce time to fire and the answer to land.
    await new Promise((resolve) => window.setTimeout(resolve, 350));
    expect(screen.getByText("Bohrer SDS-Plus 8mm")).toBeInTheDocument();
    expect(screen.queryByText("No items match the current filter.")).toBeNull();
  });

  it("lets only the newest search paint the list", async () => {
    let releaseSlow: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const calls = stubApi((call) => {
      if (!listCalls([call]).length) return undefined;
      if (qOf(call) === "ka") {
        return slow.then(
          () =>
            new Response(JSON.stringify([{ ...ROW, id: 11, item_name: "Kabelschuh (alt)" }]), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
        );
      }
      if (qOf(call) === "kabel") return [{ ...ROW, id: 12, item_name: "Kabelbinder 200mm" }];
      return undefined;
    });
    renderPage();
    await screen.findByText("Bohrer SDS-Plus 8mm");
    const search = screen.getByPlaceholderText(STOCK_SEARCH);

    fireEvent.change(search, { target: { value: "ka" } });
    await waitFor(() => expect(listCalls(calls).some((call) => qOf(call) === "ka")).toBe(true));
    fireEvent.change(search, { target: { value: "kabel" } });
    await screen.findByText("Kabelbinder 200mm");

    // The older answer lands last — and must not repaint the list.
    releaseSlow();
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    expect(screen.getByText("Kabelbinder 200mm")).toBeInTheDocument();
    expect(screen.queryByText("Kabelschuh (alt)")).toBeNull();
  });

  it("names supplier numbers in the German placeholder", async () => {
    stubApi();
    renderPage({ language: "de" });
    await screen.findByText("Bohrer SDS-Plus 8mm");
    expect(screen.getByPlaceholderText("Name, SP-Nr., EAN, Lieferanten-Nr. …")).toBeInTheDocument();
  });

  it("still narrows by category in the browser", async () => {
    stubApi((call) =>
      listCalls([call]).length
        ? [ROW, { ...ROW, id: 8, article_number: "SP-0043", item_name: "Kabelbinder", category_name: "Befestigung" }]
        : undefined,
    );
    renderPage();
    await screen.findByText("Kabelbinder");
    fireEvent.change(screen.getByRole("combobox", { name: "Category:" }), {
      target: { value: "Befestigung" },
    });
    expect(screen.queryByText("Bohrer SDS-Plus 8mm")).toBeNull();
    expect(screen.getByText("Kabelbinder")).toBeInTheDocument();
  });
});

describe("Bestand — scan, create, find it again", () => {
  beforeEach(() => vi.unstubAllGlobals());

  const CREATED = {
    ...FULL_ARTICLE,
    id: 100,
    article_number: "SP-0100",
    ean: "4049999999999",
    item_name: "Wago 221-413",
    manufacturer: null,
    stock_total: 0,
    stock_available: 0,
    stock_out: 0,
  };

  it("after scan → create, shows the new row and opens it for editing", async () => {
    let created = false;
    const calls = stubApi((call) => {
      if (call.url.includes("/articles/lookup")) {
        return { kind: "none", code: "4049999999999", external_skipped: null };
      }
      if (call.method === "POST" && /\/werkstatt\/articles$/.test(call.url)) {
        created = true;
        return CREATED;
      }
      if (call.url.endsWith("/werkstatt/articles/100")) return CREATED;
      if (listCalls([call]).length) {
        const q = qOf(call);
        if (!created) return [ROW];
        // The server finds the new row by its EAN as well as by its number —
        // the page used to throw the EAN hit away again.
        if (q === "4049999999999" || q === "SP-0100") return [{ ...CREATED }];
        return [ROW, CREATED];
      }
      return undefined;
    });
    renderPage();
    await screen.findByText("Bohrer SDS-Plus 8mm");

    scan("4049999999999");
    const createDialog = await screen.findByRole("dialog", { name: "New stock item" });
    fireEvent.change(await within(createDialog).findByRole("textbox", { name: /Item name/ }), {
      target: { value: "Wago 221-413" },
    });
    fireEvent.click(within(createDialog).getByRole("button", { name: "Save article" }));

    // The search now names the new article, the row is on screen, and its
    // edit dialog is open — the place to book its stock.
    const search = screen.getByPlaceholderText(STOCK_SEARCH) as HTMLInputElement;
    await waitFor(() => expect(search.value).toBe("SP-0100"));
    await waitFor(() => expect(rowOf("Wago 221-413")).toBeInTheDocument());
    const edit = await screen.findByRole("dialog", { name: "Edit article" });
    await within(edit).findByText(/SP-0100 · Wago 221-413/);
    expect(calls.some((call) => call.url.endsWith("/werkstatt/articles/100"))).toBe(true);
  });

  it("resets the category filter that would hide the new row", async () => {
    let created = false;
    stubApi((call) => {
      if (call.method === "POST" && /\/werkstatt\/articles$/.test(call.url)) {
        created = true;
        return { ...CREATED, category_name: null };
      }
      if (call.url.endsWith("/werkstatt/articles/100")) return CREATED;
      if (listCalls([call]).length) return created ? [ROW, { ...CREATED, category_name: null }] : [ROW];
      return undefined;
    });
    renderPage();
    await screen.findByText("Bohrer SDS-Plus 8mm");
    fireEvent.change(screen.getByRole("combobox", { name: "Category:" }), {
      target: { value: "Werkzeug" },
    });

    fireEvent.click(screen.getByRole("button", { name: /New item/ }));
    const dialog = await screen.findByRole("dialog", { name: "New stock item" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Continue without a code/ }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Item name/ }), {
      target: { value: "Wago 221-413" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save article" }));

    await waitFor(() => expect(rowOf("Wago 221-413")).toBeInTheDocument());
    expect((screen.getByRole("combobox", { name: "Category:" }) as HTMLSelectElement).value).toBe("all");
  });

  it("does not open 'Neuer Artikel' on a scan miss without werkstatt:manage", async () => {
    const calls = stubApi((call) =>
      call.url.includes("/articles/lookup")
        ? { kind: "none", code: "4049999999999", external_skipped: null }
        : undefined,
    );
    const { setNotice } = renderPage({ user: VIEWER });
    await screen.findByText("Bohrer SDS-Plus 8mm");

    scan("4049999999999");

    await waitFor(() => expect(calls.some((call) => call.url.includes("/articles/lookup"))).toBe(true));
    await waitFor(() => expect(setNotice).toHaveBeenCalledWith(expect.stringContaining("4049999999999")));
    expect(screen.queryByRole("dialog", { name: "New stock item" })).toBeNull();
  });
});
