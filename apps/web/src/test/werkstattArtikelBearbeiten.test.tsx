/**
 * Editing an article from the Bestand row, and the form logic underneath it.
 *
 * "editing the item should also be possible from the stock page" — it was not
 * possible anywhere, so a typo in a name was permanent in practice. Two things
 * are pinned here because they are what makes an edit dialog safe rather than
 * merely present:
 *
 *   - the PATCH carries ONLY what changed, so a colleague's edit made while
 *     this dialog was open is not overwritten by fields nobody touched;
 *   - the stock figure is not editable at all. The counters are derived from
 *     the movement ledger; a field here would be a number the server discards
 *     while the person believes they corrected the shelf.
 *
 * The mobile hand-off is here too, for the same reason it exists: the scanner
 * that recognises a code and then offers nothing is the dead end the whole
 * feature is about.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ArtikelBearbeitenModal } from "../components/werkstatt/ArtikelBearbeitenModal";
import {
  artikelFormFromArticle,
  centsToInput,
  priceToCents,
  toCreateInput,
  toUpdatePatch,
} from "../components/werkstatt/artikelForm";
import type { WerkstattArticle } from "../types/werkstatt";

type Call = { method: string; url: string; body: unknown };

const ARTICLE = {
  id: 7,
  article_number: "SP-0042",
  ean: "4012345678901",
  internal_code: null,
  item_name: "Schuko-Steckdose",
  manufacturer: "Gira",
  category_id: null,
  category_name: null,
  location_id: null,
  location_name: null,
  unit: "Stk",
  image_url: null,
  image_source: null,
  image_checked_at: null,
  source_catalog_item_id: null,
  stock_total: 14,
  stock_available: 12,
  stock_out: 2,
  stock_repair: 0,
  stock_min: 2,
  stock_status: "available",
  is_serialized: false,
  bg_inspection_required: false,
  bg_inspection_interval_days: null,
  last_bg_inspected_at: null,
  next_bg_due_at: null,
  purchase_price_cents: 1250,
  currency: "EUR",
  notes: null,
  is_archived: false,
  suppliers: [],
  next_expected_delivery_at: null,
  created_at: "2026-01-01T00:00:00",
  updated_at: "2026-01-01T00:00:00",
} as unknown as WerkstattArticle;

function stubApi(article: unknown = ARTICLE) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
      const json = (payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (url.includes("/werkstatt/articles/7")) return json(article);
      return json([]);
    }),
  );
  return calls;
}

function openEditor(overrides: Record<string, unknown> = {}) {
  const onSaved = vi.fn();
  const onArchived = vi.fn();
  render(
    <ArtikelBearbeitenModal
      open
      articleId={7}
      language="en"
      token="test-token"
      onClose={() => undefined}
      onSaved={onSaved}
      onArchived={onArchived}
      {...overrides}
    />,
  );
  return { onSaved, onArchived };
}

describe("Artikel bearbeiten", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("sends only the field that changed", async () => {
    const calls = stubApi();
    const { onSaved } = openEditor();

    const name = (await screen.findByRole("textbox", {
      name: /Item name/,
    })) as HTMLInputElement;
    expect(name.value).toBe("Schuko-Steckdose");

    fireEvent.change(name, { target: { value: "Schuko-Steckdose reinweiß" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch?.url).toContain("/werkstatt/articles/7");
    expect(patch?.body).toEqual({ item_name: "Schuko-Steckdose reinweiß" });
  });

  it("shows stock read-only, with the way to actually change it", async () => {
    stubApi();
    const onOpenStockDialog = vi.fn();
    openEditor({ onOpenStockDialog });

    await screen.findByText("12 / 14 Stk");
    // No editable starting-stock field on an edit — the ledger owns that.
    expect(screen.queryByRole("spinbutton", { name: /Starting stock/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Adjust stock" }));
    expect(onOpenStockDialog).toHaveBeenCalledWith(7);
  });

  it("explains a machine type instead of offering to unmake one", async () => {
    // Unsetting is_serialized would orphan every unit, its label and its
    // inspection dates — so the dialog says where they live instead.
    stubApi({ ...ARTICLE, is_serialized: true });
    openEditor();

    await screen.findByText("Individual units (machine)");
    expect(screen.queryByRole("checkbox", { name: /machine/i })).toBeNull();
  });

  it("offers reactivation for an archived article", async () => {
    // The answer to an EAN clash that names an archived row: bring it back
    // rather than creating a second article for the same product.
    const calls = stubApi({ ...ARTICLE, is_archived: true });
    const { onSaved } = openEditor();

    fireEvent.click(await screen.findByRole("button", { name: "Reactivate" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ is_archived: false });
  });

  it("reactivates AND saves what the person typed, in one request", async () => {
    /* The hint above the button says so, and the page announces
     * "SP-0042 gespeichert" afterwards. The button used to send
     * {is_archived:false} alone, so a corrected EAN and a changed unit were
     * dropped silently under a notice claiming they were saved. */
    const calls = stubApi({ ...ARTICLE, is_archived: true });
    const { onSaved } = openEditor();

    const name = (await screen.findByRole("textbox", {
      name: /Item name/,
    })) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Schuko-Steckdose reinweiß" } });
    fireEvent.click(screen.getByRole("button", { name: "Reactivate" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
      item_name: "Schuko-Steckdose reinweiß",
      is_archived: false,
    });
  });

  it("keeps unsaved edits when a catalogue row is linked", async () => {
    /* Linking reseeded the whole form from the server's row, so a corrected
     * name typed a minute earlier vanished with no message — and "Save" then
     * sent an empty patch and closed as though it had saved it. */
    const linked = {
      ...ARTICLE,
      source_catalog_item_id: 900,
      suppliers: [
        {
          id: 3,
          supplier_id: 5,
          supplier_name: "Unielektro",
          supplier_article_no: "26190",
          is_preferred: true,
        },
      ],
    };
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
        const json = (payload: unknown) =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        if (url.includes("/link-catalog")) return json(linked);
        if (url.includes("/catalog/search")) {
          return json([
            {
              ean: "4012345678901",
              hero: {
                id: 900,
                item_name: "Schuko (Datanorm)",
                article_no: "26190",
                supplier_name: "Unielektro",
                supplier_id: 5,
                ean: "4012345678901",
              },
              suppliers: [],
            },
          ]);
        }
        if (url.includes("/werkstatt/articles/7")) return json(ARTICLE);
        return json([]);
      }),
    );
    const { onSaved } = openEditor();

    const name = (await screen.findByRole("textbox", {
      name: /Item name/,
    })) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Schuko-Steckdose reinweiß" } });

    fireEvent.change(screen.getByPlaceholderText(/Search the supplier catalogue/), {
      target: { value: "Schuko" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Link" }));

    await waitFor(() => expect(name.value).toBe("Schuko-Steckdose reinweiß"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
      item_name: "Schuko-Steckdose reinweiß",
    });
  });

  it("confirms an archive in words before doing it", async () => {
    const calls = stubApi();
    const { onArchived } = openEditor({ startArchiveConfirm: true });

    const confirm = await screen.findByRole("alertdialog", { name: "Archive" });
    expect(confirm).toHaveTextContent(/Movements and orders are kept/);
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);

    fireEvent.click(
      screen.getAllByRole("button", { name: "Archive" }).slice(-1)[0] as HTMLElement,
    );
    await waitFor(() => expect(onArchived).toHaveBeenCalled());
    expect(calls.some((call) => call.method === "DELETE")).toBe(true);
  });
});

describe("artikelForm — the conversions both dialogs share", () => {
  it("reads a price in either decimal convention", () => {
    // The workshop types German; the interface can be English. A dot AND a
    // comma means the dot is a thousands separator.
    expect(priceToCents("1.248,00")).toBe(124800);
    expect(priceToCents("1248.00")).toBe(124800);
    expect(priceToCents("12,50")).toBe(1250);
    expect(priceToCents("12")).toBe(1200);
    expect(priceToCents("")).toBeNull();
    expect(priceToCents("abc")).toBeNull();
    expect(centsToInput(124800)).toBe("1248,00");
    expect(centsToInput(null)).toBe("");
  });

  it("produces an empty patch when nothing was touched", () => {
    // Which is why the dialog can close without a request at all: a PATCH
    // that changes nothing still bumps updated_at and still races.
    const values = artikelFormFromArticle(ARTICLE);
    expect(toUpdatePatch(values, ARTICLE)).toEqual({});
  });

  it("clears a nullable field explicitly rather than omitting it", () => {
    const values = { ...artikelFormFromArticle(ARTICLE), ean: "" };
    expect(toUpdatePatch(values, ARTICLE)).toEqual({ ean: null });
  });

  it("never sends a stock counter on an update", () => {
    const values = { ...artikelFormFromArticle(ARTICLE), stock_total: "999" };
    expect(toUpdatePatch(values, ARTICLE)).not.toHaveProperty("stock_total");
  });

  it("sends the opening quantity on a create, as a quantity", () => {
    // On a create the number is legitimate — the server books it as an
    // opening `intake` movement rather than assigning a counter.
    const created = toCreateInput({
      ...artikelFormFromArticle(ARTICLE),
      stock_total: "6",
      supplier_id: 3,
      supplier_article_no: "4711",
    });
    expect(created.stock_total).toBe(6);
    expect(created.supplier_links).toEqual([
      { supplier_id: 3, supplier_article_no: "4711", is_preferred: true },
    ]);
  });
});

describe("Mobile-Scan — the hand-off out of a dead end", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("offers 'Als Lagerartikel anlegen' when a scan finds nothing stockable", async () => {
    // The phone recognised a code, said so, and left the person with nothing
    // to press. The button carries the scanned code straight into the create
    // dialog — retyping a barcode on a phone is how stock stops being entered.
    vi.stubGlobal(
      "matchMedia",
      ((query: string) => ({
        matches: query.includes("max-width: 767px"),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia,
    );
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({
          method: (init?.method ?? "GET").toUpperCase(),
          url,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        const json = (payload: unknown) =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        if (url.includes("/scan/resolve")) return json({ kind: "not_found", code: "4045454121013" });
        if (url.includes("/articles/lookup")) {
          return json({ kind: "none", code: "4045454121013", external_skipped: null });
        }
        return json([]);
      }),
    );

    const { WerkstattMobileScanPage } = await import(
      "../pages/werkstatt/WerkstattMobileScanPage"
    );
    const { AppContext } = await import("../context/AppContext");
    const { makeAppContextStub } = await import("./appContextStub");

    render(
      <AppContext.Provider
        value={
          makeAppContextStub({
            overrides: {
              mainView: "werkstatt_scan",
              language: "en",
              token: "test-token",
              // Creating an article needs `werkstatt:manage`; the button is
              // hidden without it rather than ending in a 403.
              user: { id: 1, effective_permissions: ["werkstatt:manage"] },
            },
          }) as never
        }
      >
        <WerkstattMobileScanPage />
      </AppContext.Provider>,
    );

    // Manual entry stands in for the camera, which jsdom has none of — the
    // three input paths share one pipeline, which is the point of that design.
    fireEvent.click(await screen.findByRole("button", { name: /Enter manually/ }));
    fireEvent.change(screen.getByPlaceholderText(/M-0001/), {
      target: { value: "4045454121013" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));

    const create = await screen.findByRole("button", { name: "Add as a stock item" });
    fireEvent.click(create);

    await waitFor(() =>
      expect(calls.some((call) => call.url.includes("code=4045454121013"))).toBe(true),
    );
    expect(await screen.findByRole("dialog", { name: "New stock item" })).toBeInTheDocument();
  });
  it("books stock where the person is standing, not on the mock detail page", async () => {
    /* The create dialog re-runs the code through the variant-aware lookup and
     * finds it already stocked. "Bestand anpassen" used to switch to the
     * mobile "artikel" tab, which is still a fixture: it printed an empty name
     * and LAGER 0 / UNTERWEGS 0 / BESTAND 0 for an article with fourteen on
     * the shelf, and offered no way to adjust anything. */
    mockMobileViewport();
    const stocked = { ...ARTICLE, id: 7, stock_total: 14, stock_available: 12 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const json = (payload: unknown) =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        if (url.includes("/scan/resolve")) return json({ kind: "not_found", code: "4045454121013" });
        if (url.includes("/articles/lookup")) {
          return json({
            kind: "existing",
            code: "4045454121013",
            article: stocked,
            matched_by: "ean",
            machine_number: null,
            via_merged_article_number: null,
          });
        }
        if (url.includes("/werkstatt/articles/7")) return json(stocked);
        return json([]);
      }),
    );

    await renderMobileScan(["werkstatt:manage"]);
    fireEvent.click(await screen.findByRole("button", { name: "Add as a stock item" }));
    fireEvent.click(await screen.findByRole("button", { name: "Adjust stock" }));

    // The real figures, in a dialog that can actually book — on this screen.
    const dialog = await screen.findByRole("dialog", { name: /Adjust stock/i });
    expect(dialog).toHaveTextContent("SP-0042");
    expect(dialog).toHaveTextContent("14");
  });

  it("does not offer creating an article to somebody who may not create one", async () => {
    /* POST /werkstatt/articles needs `werkstatt:manage`; the lookup behind the
     * first step deliberately does not. Without the gate an apprentice filled
     * in name, unit, Lagerort and quantity and collected an English
     * "Permission denied" under a German dialog. */
    mockMobileViewport();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const json = (payload: unknown) =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        if (url.includes("/scan/resolve")) return json({ kind: "not_found", code: "4045454121013" });
        return json([]);
      }),
    );

    await renderMobileScan(["werkstatt:view"]);
    await screen.findByText(/Only the office can add items/);
    expect(screen.queryByRole("button", { name: "Add as a stock item" })).toBeNull();
  });
});

/** jsdom has no viewport; the mobile page self-gates on one. */
function mockMobileViewport() {
  vi.stubGlobal(
    "matchMedia",
    ((query: string) => ({
      matches: query.includes("max-width: 767px"),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia,
  );
}

/** Render the scan page and run one code through it by hand.
 *
 * Manual entry stands in for the camera, which jsdom has none of — the three
 * input paths share one pipeline, which is the point of that design.
 */
async function renderMobileScan(permissions: string[]) {
  const { WerkstattMobileScanPage } = await import(
    "../pages/werkstatt/WerkstattMobileScanPage"
  );
  const { AppContext } = await import("../context/AppContext");
  const { makeAppContextStub } = await import("./appContextStub");

  render(
    <AppContext.Provider
      value={
        makeAppContextStub({
          overrides: {
            mainView: "werkstatt_scan",
            language: "en",
            token: "test-token",
            user: { id: 1, effective_permissions: permissions },
          },
        }) as never
      }
    >
      <WerkstattMobileScanPage />
    </AppContext.Provider>,
  );

  fireEvent.click(await screen.findByRole("button", { name: /Enter manually/ }));
  fireEvent.change(screen.getByPlaceholderText(/M-0001/), {
    target: { value: "4045454121013" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Find" }));
}

describe("Bestand exportieren", () => {
  it("writes the rows as semicolon CSV that German Excel can open", async () => {
    // Comma-separated would arrive as one column of gibberish for the person
    // who needs it, and a quote in a product name would shift every column
    // after it — so every cell is quoted, not only the suspicious ones.
    const { stockRowsToCsv, stockExportFilename } = await import(
      "../components/werkstatt/stockExport"
    );
    const csv = stockRowsToCsv(
      [
        {
          article_no: "SP-0042",
          item_name: 'Kabel 3x1,5 "NYM"',
          sub_meta: "Gira · 4012345678901",
          category: "Installation",
          location: "Regal B2",
          stock_available: 9,
          stock_total: 12,
          unit: null,
        },
      ],
      true,
    );
    const [header, row] = csv.trim().split("\r\n");
    expect(header.split(";")[0]).toBe('"Artikelnummer"');
    expect(row).toContain('"Kabel 3x1,5 ""NYM"""');
    // No unit of its own falls back to the interface language's abbreviation.
    expect(row.endsWith('"Stk"')).toBe(true);
    expect(stockExportFilename(new Date("2026-09-17T10:00:00Z"))).toBe("bestand-2026-09-17.csv");
  });

  it("neutralises a cell Excel would run as a formula", async () => {
    /* Quoting is not the guard people think it is: Excel strips the quotes on
     * import and evaluates a cell starting with = + - or @. Before this wave
     * `item_name` only ever came from staff typing or a Datanorm import; an
     * article created at the rack now takes its name from a scraped webshop
     * page that nobody reviews, so the export is one hostile title away from
     * being an active document on the office PC. */
    const { stockRowsToCsv } = await import("../components/werkstatt/stockExport");
    const csv = stockRowsToCsv(
      [
        {
          article_no: "SP-0043",
          item_name: '=HYPERLINK("http://evil.example","Rechnung")',
          sub_meta: "+49",
          category: "@import",
          location: "-Regal",
          stock_available: 1,
          stock_total: 1,
          unit: "Stk",
        },
      ],
      true,
    );
    const row = csv.trim().split("\r\n")[1] as string;
    for (const cell of row.split(";").slice(1, 5)) {
      // Every cell that began with a formula trigger now begins with the
      // apostrophe Excel itself uses to mean "this is text".
      expect(cell.startsWith("\"'")).toBe(true);
    }
    // And an ordinary cell is untouched.
    expect(row.split(";")[0]).toBe('"SP-0043"');
  });
});
