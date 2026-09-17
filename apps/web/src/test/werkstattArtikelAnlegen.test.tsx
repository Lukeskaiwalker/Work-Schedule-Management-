/**
 * "Neuer Lagerartikel" actually creates one — and refuses to create a second.
 *
 * The owner's report, in one line: "when an item is not found in our database
 * we have no great way of adding it". The old dialog was worse than that — it
 * had the wrong fields and it saved nothing at all — so what is pinned here is
 * the whole path a person walks: scan a code, see what it turned out to be,
 * and either stop (it is already stocked) or save something real.
 *
 * The most important assertions are the two REFUSALS: a code that resolves to
 * an existing article must not offer a create button, and a webshop suggestion
 * must be visibly a suggestion. Those are what keep the feature from quietly
 * producing the duplicates the merge screen has to clean up afterwards.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { NeuerArtikelModal } from "../components/werkstatt/NeuerArtikelModal";

type Call = { method: string; url: string; body: unknown };

const EXISTING = {
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
  purchase_price_cents: null,
  currency: "EUR",
  notes: null,
  is_archived: false,
  suppliers: [],
  next_expected_delivery_at: null,
  created_at: "2026-01-01T00:00:00",
  updated_at: "2026-01-01T00:00:00",
};

/** Answer the lookup with `lookup`, every POST with `created`. */
function stubApi(lookup: unknown, created: unknown = { ...EXISTING, id: 99 }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (url.includes("/articles/lookup")) return json(lookup);
      if (method === "POST") return json(created);
      // categories / locations / suppliers
      return json([]);
    }),
  );
  return calls;
}

function openDialog(overrides: Record<string, unknown> = {}) {
  const onCreated = vi.fn();
  const onAdjustStock = vi.fn();
  render(
    <AppContext.Provider value={makeAppContextStub({ overrides: { language: "en" } }) as never}>
      <NeuerArtikelModal
        open
        onClose={() => undefined}
        language="en"
        token="test-token"
        onCreated={onCreated}
        onAdjustStock={onAdjustStock}
        {...overrides}
      />
    </AppContext.Provider>,
  );
  return { onCreated, onAdjustStock };
}

function typeCode(code: string) {
  fireEvent.change(screen.getByRole("textbox", { name: /Scan or enter a code/ }), {
    target: { value: code },
  });
  fireEvent.click(screen.getByRole("button", { name: "Look up" }));
}

describe("Neuer Artikel — a code answers the first question", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("stops at an article that is already stocked", async () => {
    // The duplicate this prevents is the expensive one: a second row for a
    // product already on the shelf, with the stock split between them.
    stubApi({
      kind: "existing",
      code: "4012345678901",
      article: EXISTING,
      matched_by: "ean",
      machine_number: null,
      via_merged_article_number: null,
    });
    const { onAdjustStock } = openDialog();
    typeCode("4012345678901");

    await screen.findByText("Already in stock");
    expect(screen.getByText(/SP-0042/)).toBeInTheDocument();
    expect(screen.getByText(/12 \/ 14 Stk/)).toBeInTheDocument();
    // No save button anywhere: there is nothing to create.
    expect(screen.queryByRole("button", { name: "Save article" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Adjust stock" }));
    expect(onAdjustStock).toHaveBeenCalledWith(7);
  });

  it("says when a label was merged, so the sticker still makes sense", async () => {
    stubApi({
      kind: "existing",
      code: "SP-0012",
      article: EXISTING,
      matched_by: "sp",
      machine_number: null,
      via_merged_article_number: "SP-0012",
    });
    openDialog();
    typeCode("SP-0012");

    await screen.findByText(/SP-0012 was merged into SP-0042/);
  });

  it("prefills from a webshop hit and marks it as a suggestion", async () => {
    // A scrape is a guess with a provenance. Hiding the provenance would make
    // it look like a fact, and the name ends up on a shelf label.
    const calls = stubApi({
      kind: "external",
      code: "4045454121006",
      hit: {
        item_name: "WAGO 221-413 Verbindungsklemme",
        ean: "4045454121006",
        manufacturer: "WAGO",
        unit: "Pak",
        image_url: null,
        source: "unielektro_shop",
        source_url: "https://www.unielektro.de/p/1",
        fetched_at: null,
      },
    });
    const { onCreated } = openDialog();
    typeCode("4045454121006");

    await screen.findByText(/Suggestion from the Unielektro webshop/);
    expect(screen.getByRole("link", { name: "View source" })).toHaveAttribute(
      "href",
      "https://www.unielektro.de/p/1",
    );
    const name = screen.getByRole("textbox", { name: /Item name/ }) as HTMLInputElement;
    expect(name.value).toBe("WAGO 221-413 Verbindungsklemme");

    // Every field stays editable — the person holding the box is the authority.
    fireEvent.change(name, { target: { value: "WAGO Klemme 3-polig" } });
    fireEvent.click(screen.getByRole("button", { name: "Save article" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const post = calls.find((call) => call.method === "POST");
    expect(post?.url).toContain("/werkstatt/articles");
    expect(post?.body).toMatchObject({
      item_name: "WAGO Klemme 3-polig",
      ean: "4045454121006",
      unit: "Pak",
      // Audit: the row records that a human accepted a scraped suggestion.
      lookup_source: "unielektro_shop",
    });
    // A create NEVER sets is_serialized — machines are made in their own tab.
    expect(post?.body).not.toHaveProperty("is_serialized");
  });

  it("offers an empty form when nothing anywhere knows the code", async () => {
    const calls = stubApi({ kind: "none", code: "12345", external_skipped: "not_a_gtin" });
    const { onCreated } = openDialog();
    typeCode("12345");

    await screen.findByText("Nothing found — please enter the data");
    expect(screen.getByText(/not a barcode/)).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: /Item name/ }), {
      target: { value: "Sonderklemme grau" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save article" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
      item_name: "Sonderklemme grau",
    });
  });

  it("creates from the catalogue row rather than from typed fields", async () => {
    // The wholesaler's row is a better identity than anything typed, and the
    // endpoint links their article number to the new article as it goes.
    const calls = stubApi({
      kind: "catalog",
      code: "4012345678901",
      matched_by: "catalog_ean",
      groups: [
        {
          ean: "4012345678901",
          hero: {
            id: 501,
            external_key: "k1",
            supplier_id: 3,
            supplier_name: "Unielektro",
            article_no: "01408573",
            item_name: "HAGER ZU37KS",
            ean: "4012345678901",
            manufacturer: "HAGER",
            unit: "ST",
            price_text: "328,20 EUR",
            image_url: null,
          },
          suppliers: [
            {
              id: 501,
              external_key: "k1",
              supplier_id: 3,
              supplier_name: "Unielektro",
              article_no: "01408573",
              item_name: "HAGER ZU37KS",
              ean: "4012345678901",
              manufacturer: "HAGER",
              unit: "ST",
              price_text: "328,20 EUR",
              image_url: null,
            },
          ],
        },
      ],
    });
    const { onCreated } = openDialog();
    typeCode("4012345678901");

    await screen.findByText("Found in the supplier catalogue");
    fireEvent.click(screen.getByRole("button", { name: "Create + link article" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const post = calls.find((call) => call.method === "POST");
    expect(post?.url).toContain("/werkstatt/articles/from-catalog");
    expect(post?.body).toMatchObject({ catalog_item_id: 501 });
  });

  it("shows the server's own German refusal when the EAN is taken", async () => {
    // "EAN already in use" is true and useless. The server names the article
    // that has it; passing that through is the whole value of the message.
    const detail =
      "Diese EAN gehört bereits zu SP-0042 „Schuko-Steckdose“ — dort den Bestand anpassen.";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        const json = (payload: unknown, status = 200) =>
          new Response(JSON.stringify(payload), {
            status,
            headers: { "Content-Type": "application/json" },
          });
        if (url.includes("/articles/lookup")) {
          return json({ kind: "none", code: "4012345678901", external_skipped: null });
        }
        if (method === "POST") return json({ detail }, 400);
        return json([]);
      }),
    );
    const { onCreated } = openDialog();
    typeCode("4012345678901");

    await screen.findByText("Nothing found — please enter the data");
    fireEvent.change(screen.getByRole("textbox", { name: /Item name/ }), {
      target: { value: "Noch eine Dose" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save article" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("SP-0042");
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("resolves a code it was handed instead of asking for it again", async () => {
    // The mobile scanner's hand-off: the barcode has already been read, and
    // retyping it on a phone is how stock stops being entered at all.
    const calls = stubApi({ kind: "none", code: "4045454121013", external_skipped: null });
    openDialog({ seedCode: "4045454121013" });

    await screen.findByText("Nothing found — please enter the data");
    expect(
      calls.some((call) => call.url.includes("code=4045454121013")),
    ).toBe(true);
  });
});

describe("Was der Dialog über einen Fehlschlag sagt", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("does not claim the webshop is switched off when the caller opted out", async () => {
    /* `lookup_code` returns the same `external_skipped` for two different
     * facts, and one of them is a setting somebody would go and edit. A cheap
     * internal lookup — what the Bestand page's scan handler asks for — is not
     * EAN_LOOKUP_UNIELEKTRO_ENABLED=false. */
    const { lookupDetail } = await import("../utils/werkstattArticleLookupApi");
    const notRequested = lookupDetail(
      { kind: "none", code: "4012345678901", external_skipped: "not_requested" },
      true,
    );
    const disabled = lookupDetail(
      { kind: "none", code: "4012345678901", external_skipped: "disabled" },
      true,
    );
    expect(notRequested).not.toContain("abgeschaltet");
    expect(disabled).toContain("abgeschaltet");
    expect(notRequested).not.toBe(disabled);
  });

  it("does not offer a stock dialog for a machine type or an archived row", async () => {
    /* Both are "already in stock" and neither can take a booking here: a
     * machine's quantity lives in the Maschinen tab, and an archived article
     * is not in the list a booking would show up in. The card used to offer
     * "Bestand anpassen" for both and say nothing about either. */
    const { ArtikelLookupResult } = await import(
      "../components/werkstatt/ArtikelLookupResult"
    );
    const hit = (article: Record<string, unknown>) =>
      ({
        kind: "existing",
        code: "4012345678901",
        article: { ...EXISTING, ...article },
        matched_by: "ean",
        machine_number: null,
        via_merged_article_number: null,
      }) as never;

    const { unmount } = render(
      <ArtikelLookupResult
        de={false}
        result={hit({ is_serialized: true })}
        onAdjustStock={() => undefined}
        onBack={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: "Adjust stock" })).toBeNull();
    expect(screen.getByText(/machine type/i)).toBeInTheDocument();
    unmount();

    render(
      <ArtikelLookupResult
        de={false}
        result={hit({ is_archived: true })}
        onAdjustStock={() => undefined}
        onBack={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: "Adjust stock" })).toBeNull();
    expect(screen.getByText("archived")).toBeInTheDocument();
  });
});
