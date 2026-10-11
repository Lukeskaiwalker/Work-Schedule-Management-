/**
 * The edit dialog is the one place to change an article — stock included.
 *
 * "Can not even change the stock when we added one … The edit button does not
 * work or show right. There should be a more easy way to change something."
 *
 * Two halves are pinned here:
 *
 *   - Bestand: the dialog books a counted stock (a stock-take through
 *     `adjustArticleStock`, carrying the displayed total as the lock) and a
 *     Wareneingang +n, without sending anybody into a second dialog. Every
 *     figure shown afterwards is the server's. A count is a stock CORRECTION
 *     (shrinkage too), so — as in "Bestand anpassen" and the API — it is not
 *     booked without a reason somebody typed.
 *   - Lieferanten: a linked supplier's article number is editable and is SAVED
 *     (PATCH on the link). The old form showed supplier fields in edit mode and
 *     "Speichern" dropped them silently — an empty article patch closed the
 *     dialog as if it had saved. A change the form shows is never discarded
 *     without a word.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ArtikelBearbeitenModal } from "../components/werkstatt/ArtikelBearbeitenModal";
import {
  EMPTY_NEW_LINK,
  changedLinkNumbers,
  pendingNewLink,
  withLinkDraft,
} from "../components/werkstatt/artikelLieferanten";
import type { WerkstattArticle } from "../types/werkstatt";

type Call = { method: string; url: string; body: unknown };

const LINK = {
  id: 3,
  article_id: 7,
  supplier_id: 5,
  supplier_name: "Unielektro",
  supplier_article_no: "26190",
  is_preferred: true,
};

/** 14 owned, 12 on the shelf, 2 out on a job. */
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
  suppliers: [LINK],
  next_expected_delivery_at: null,
  created_at: "2026-01-01T00:00:00",
  updated_at: "2026-01-01T00:00:00",
} as unknown as WerkstattArticle;

const SUPPLIERS = [
  { id: 5, name: "Unielektro" },
  { id: 6, name: "Sonepar" },
];

type Responder = (call: Call) => { status: number; payload: unknown } | null;

function stubApi(article: unknown = ARTICLE, respond: Responder = () => null) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const call = { method, url, body: init?.body ? JSON.parse(String(init.body)) : null };
      calls.push(call);
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      const custom = respond(call);
      if (custom) return json(custom.payload, custom.status);
      if (url.includes("/werkstatt/suppliers")) return json(SUPPLIERS);
      if (url.includes("/werkstatt/articles/7")) return json(article);
      return json([]);
    }),
  );
  return calls;
}

function openEditor(overrides: Record<string, unknown> = {}) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const onStockChanged = vi.fn();
  render(
    <ArtikelBearbeitenModal
      open
      articleId={7}
      language="en"
      token="test-token"
      onClose={onClose}
      onSaved={onSaved}
      onArchived={() => undefined}
      onStockChanged={onStockChanged}
      {...overrides}
    />,
  );
  return { onSaved, onClose, onStockChanged };
}

const writes = (calls: Call[]) => calls.filter((call) => call.method !== "GET");

describe("Artikel bearbeiten — Bestand", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("shows the live counters with what is off the shelf", async () => {
    stubApi();
    openEditor();
    const section = await screen.findByRole("group", { name: "Stock" });
    expect(section).toHaveTextContent("12 / 14 Stk");
    expect(section).toHaveTextContent("2 out");
  });

  it("books a counted stock as a stock-take with the displayed total as the lock", async () => {
    const calls = stubApi(ARTICLE, (call) =>
      call.method === "POST" && call.url.endsWith("/movements")
        ? { status: 200, payload: { id: 7, stock_total: 12, stock_available: 10, stock_status: "available" } }
        : null,
    );
    const { onStockChanged } = openEditor();
    const section = await screen.findByRole("group", { name: "Stock" });

    // The person counts the SHELF; the two on a job are added back on, as
    // in the Bestand-anpassen dialog — writing them off would be wrong.
    fireEvent.change(within(section).getByRole("spinbutton", { name: "Counted stock" }), {
      target: { value: "10" },
    });
    expect(section).toHaveTextContent("+ 2 out = 12 total");
    fireEvent.change(within(section).getByRole("textbox", { name: /Reason/ }), {
      target: { value: "  Inventur Regal 3 " },
    });
    fireEvent.click(within(section).getByRole("button", { name: "Book count" }));

    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    const [write] = writes(calls);
    expect(write.url).toBe("/api/werkstatt/articles/7/movements");
    expect(write.body).toEqual({
      kind: "inventory",
      target_total: 12,
      reason: "Inventur Regal 3",
      expected_total: 14,
    });
    // The server's figures, in the dialog and handed to the list.
    await waitFor(() => expect(section).toHaveTextContent("10 / 12 Stk"));
    expect(onStockChanged).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, stock_total: 12, stock_available: 10 }),
    );
    expect(within(section).getByRole("status")).toHaveTextContent(
      "Inventory adjust −2 · Schuko-Steckdose — now 12 total, 10 available",
    );
  });

  it("books a Wareneingang +n with the typed Beleg and no lock", async () => {
    const calls = stubApi(ARTICLE, (call) =>
      call.method === "POST" && call.url.endsWith("/movements")
        ? { status: 200, payload: { id: 7, stock_total: 19, stock_available: 17, stock_status: "available" } }
        : null,
    );
    openEditor();
    const section = await screen.findByRole("group", { name: "Stock" });

    fireEvent.change(within(section).getByRole("spinbutton", { name: "Goods receipt" }), {
      target: { value: "5" },
    });
    fireEvent.change(within(section).getByRole("textbox", { name: /Reason/ }), {
      target: { value: "LS-4711" },
    });
    fireEvent.click(within(section).getByRole("button", { name: "Book receipt" }));

    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0].body).toEqual({ kind: "intake", quantity: 5, reason: "LS-4711" });
    await waitFor(() => expect(section).toHaveTextContent("17 / 19 Stk"));
  });

  it("refuses a count with no typed reason — a stock correction needs one", async () => {
    // The regression: an empty Beleg used to be filled with a canned sentence,
    // so a count that wrote off stock reached the ledger with no reason at all
    // — the row "Bestand anpassen" and the API both refuse.
    const calls = stubApi();
    openEditor();
    const section = await screen.findByRole("group", { name: "Stock" });
    const book = within(section).getByRole("button", { name: "Book count" });

    fireEvent.change(within(section).getByRole("spinbutton", { name: "Counted stock" }), {
      target: { value: "9" },
    });
    expect(book).toBeDisabled();
    expect(book).toHaveAccessibleDescription("Reason required");

    // Blank is not a reason.
    const reason = within(section).getByRole("textbox", { name: /Reason/ });
    fireEvent.change(reason, { target: { value: "   " } });
    expect(book).toBeDisabled();
    fireEvent.click(book);
    expect(writes(calls)).toHaveLength(0);

    fireEvent.change(reason, { target: { value: "Schwund" } });
    expect(book).toBeEnabled();
    expect(within(section).queryByText("Reason required")).toBeNull();
  });

  it("does not offer the field as optional", async () => {
    stubApi();
    openEditor();
    const section = await screen.findByRole("group", { name: "Stock" });
    const reason = within(section).getByRole("textbox", { name: "Reason / reference" });
    expect(reason).toHaveAccessibleDescription("Required for a count · optional for a goods receipt");
    expect(section).not.toHaveTextContent(/optional\)/);
  });

  it("books a Wareneingang without a Beleg under a sentence naming the delivery", async () => {
    // A delivery only ever adds stock and its ledger kind says what it was;
    // the reason requirement above is about corrections.
    const calls = stubApi(ARTICLE, (call) =>
      call.method === "POST" && call.url.endsWith("/movements")
        ? { status: 200, payload: { id: 7, stock_total: 17, stock_available: 15, stock_status: "available" } }
        : null,
    );
    openEditor();
    const section = await screen.findByRole("group", { name: "Stock" });

    fireEvent.change(within(section).getByRole("spinbutton", { name: "Goods receipt" }), {
      target: { value: "3" },
    });
    const book = within(section).getByRole("button", { name: "Book receipt" });
    expect(book).toBeEnabled();
    fireEvent.click(book);

    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0].body).toEqual({
      kind: "intake",
      quantity: 3,
      reason: "Wareneingang im Artikeldialog",
    });
  });

  it("refuses an empty or zero receipt before sending anything", async () => {
    const calls = stubApi();
    openEditor();
    const section = await screen.findByRole("group", { name: "Stock" });
    const book = within(section).getByRole("button", { name: "Book receipt" });
    expect(book).toBeDisabled();
    fireEvent.change(within(section).getByRole("spinbutton", { name: "Goods receipt" }), {
      target: { value: "0" },
    });
    expect(book).toBeDisabled();
    expect(writes(calls)).toHaveLength(0);
  });

  it("refetches on a 409 and shows the server's current figures", async () => {
    let fetched = 0;
    const moved = { ...ARTICLE, stock_total: 15, stock_available: 13 };
    stubApi(ARTICLE, (call) => {
      if (call.method === "POST" && call.url.endsWith("/movements")) {
        return {
          status: 409,
          payload: {
            detail: "Der Bestand hat sich inzwischen geändert: angezeigt waren 14 Stk, aktuell sind es 15 Stk.",
          },
        };
      }
      if (call.method === "GET" && call.url.endsWith("/werkstatt/articles/7")) {
        fetched += 1;
        return { status: 200, payload: fetched > 1 ? moved : ARTICLE };
      }
      return null;
    });
    openEditor();
    const section = await screen.findByRole("group", { name: "Stock" });

    fireEvent.change(within(section).getByRole("spinbutton", { name: "Counted stock" }), {
      target: { value: "9" },
    });
    fireEvent.change(within(section).getByRole("textbox", { name: /Reason/ }), {
      target: { value: "Inventur" },
    });
    fireEvent.click(within(section).getByRole("button", { name: "Book count" }));

    const alert = await within(section).findByRole("alert");
    expect(alert).toHaveTextContent("angezeigt waren 14 Stk, aktuell sind es 15 Stk.");
    await waitFor(() => expect(section).toHaveTextContent("13 / 15 Stk"));
    // What was typed stays, so it can be checked against the new figures.
    expect(
      (within(section).getByRole("spinbutton", { name: "Counted stock" }) as HTMLInputElement).value,
    ).toBe("9");
  });

  it("offers no stock booking on an archived article", async () => {
    stubApi({ ...ARTICLE, is_archived: true });
    openEditor();
    const section = await screen.findByRole("group", { name: "Stock" });
    expect(within(section).getByRole("button", { name: "Book count" })).toBeDisabled();
    expect(within(section).getByRole("button", { name: "Book receipt" })).toBeDisabled();
  });

  it("does not let Save close over a typed but unbooked receipt", async () => {
    const calls = stubApi();
    const { onClose } = openEditor();
    const section = await screen.findByRole("group", { name: "Stock" });
    fireEvent.change(within(section).getByRole("spinbutton", { name: "Goods receipt" }), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/has not been booked/);
    expect(onClose).not.toHaveBeenCalled();
    expect(writes(calls)).toHaveLength(0);
  });

  it("has no stock booking for a machine type — its units are counted elsewhere", async () => {
    stubApi({ ...ARTICLE, is_serialized: true });
    openEditor();
    await screen.findByText("Individual units (machine)");
    expect(screen.queryByRole("button", { name: "Book count" })).toBeNull();
  });
});

describe("Artikel bearbeiten — Lieferanten", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("has no main-form supplier fields that Save would ignore", async () => {
    stubApi();
    openEditor();
    await screen.findByRole("textbox", { name: /Item name/ });
    expect(screen.queryByRole("combobox", { name: /Supplier \(optional\)/ })).toBeNull();
  });

  it("saves an edited supplier number instead of closing silently", async () => {
    // The regression: Save used to find an empty ARTICLE patch and close with
    // no request at all, so a corrected supplier number was simply lost.
    const calls = stubApi();
    const { onSaved, onClose } = openEditor();

    const number = (await screen.findByRole("textbox", {
      name: "Supplier article no. at Unielektro",
    })) as HTMLInputElement;
    expect(number.value).toBe("26190");
    fireEvent.change(number, { target: { value: " 26190-A " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const patches = writes(calls);
    expect(patches).toEqual([
      {
        method: "PATCH",
        url: "/api/werkstatt/articles/7/suppliers/3",
        body: { supplier_article_no: "26190-A" },
      },
    ]);
    expect(onClose).toHaveBeenCalled();
  });

  it("saves a supplier picked under 'Lieferant hinzufügen' with Save, too", async () => {
    const calls = stubApi();
    const { onSaved } = openEditor();

    const pick = await screen.findByRole("combobox", { name: "Add a supplier" });
    await within(pick).findByRole("option", { name: "Sonepar" });
    fireEvent.change(pick, { target: { value: "6" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Supplier article no. for the new supplier" }), {
      target: { value: "SON-88" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(writes(calls)).toEqual([
      {
        method: "POST",
        url: "/api/werkstatt/articles/7/suppliers",
        body: { supplier_id: 6, supplier_article_no: "SON-88", is_preferred: false },
      },
    ]);
  });

  it("saves the article and the link changes in one go", async () => {
    const calls = stubApi(ARTICLE, (call) =>
      call.method === "PATCH" && call.url.endsWith("/werkstatt/articles/7")
        ? { status: 200, payload: { ...ARTICLE, item_name: "Schuko reinweiß" } }
        : null,
    );
    const { onSaved } = openEditor();

    fireEvent.change(await screen.findByRole("textbox", { name: /Item name/ }), {
      target: { value: "Schuko reinweiß" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Supplier article no. at Unielektro" }), {
      target: { value: "26191" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(writes(calls).map((call) => [call.method, call.url, call.body])).toEqual([
      ["PATCH", "/api/werkstatt/articles/7", { item_name: "Schuko reinweiß" }],
      ["PATCH", "/api/werkstatt/articles/7/suppliers/3", { supplier_article_no: "26191" }],
    ]);
  });

  it("keeps the dialog open with the error when a link save fails", async () => {
    stubApi(ARTICLE, (call) =>
      call.method === "PATCH" && call.url.includes("/suppliers/3")
        ? { status: 400, payload: { detail: "Lieferanten-Art.-Nr. ist bereits vergeben" } }
        : null,
    );
    const { onSaved, onClose } = openEditor();

    const number = await screen.findByRole("textbox", { name: "Supplier article no. at Unielektro" });
    fireEvent.change(number, { target: { value: "99999" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Lieferanten-Art.-Nr. ist bereits vergeben");
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect((number as HTMLInputElement).value).toBe("99999");
  });

  it("asks before throwing away unsaved changes", async () => {
    const calls = stubApi();
    const { onClose } = openEditor();

    fireEvent.change(await screen.findByRole("textbox", { name: "Supplier article no. at Unielektro" }), {
      target: { value: "26191" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    const confirm = await screen.findByRole("alertdialog", { name: "Discard changes?" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("alertdialog", { name: "Discard changes?" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog", { name: "Discard changes?" })).getByRole(
        "button",
        { name: "Discard" },
      ),
    );
    expect(onClose).toHaveBeenCalled();
    expect(writes(calls)).toHaveLength(0);
  });

  it("closes without asking when nothing was changed", async () => {
    stubApi();
    const { onClose } = openEditor();
    await screen.findByRole("textbox", { name: /Item name/ });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("artikelLieferanten — what Save writes for the links", () => {
  const article = { suppliers: [LINK] } as unknown as WerkstattArticle;

  it("ignores a draft that only differs by whitespace", () => {
    expect(changedLinkNumbers(article, withLinkDraft({}, 3, " 26190 "))).toEqual([]);
  });

  it("clears a number that was emptied", () => {
    expect(changedLinkNumbers(article, withLinkDraft({}, 3, "  "))).toEqual([
      { linkId: 3, supplier_article_no: null },
    ]);
  });

  it("ignores drafts for links that are gone", () => {
    expect(changedLinkNumbers(article, withLinkDraft({}, 99, "x"))).toEqual([]);
  });

  it("makes the first link on an article preferred, and nothing without a supplier", () => {
    const bare = { suppliers: [] } as unknown as WerkstattArticle;
    expect(pendingNewLink(bare, EMPTY_NEW_LINK)).toBeNull();
    expect(pendingNewLink(bare, { supplierId: 6, number: " A-1 " })).toEqual({
      supplier_id: 6,
      supplier_article_no: "A-1",
      is_preferred: true,
    });
    expect(pendingNewLink(article, { supplierId: 6, number: "" })).toEqual({
      supplier_id: 6,
      supplier_article_no: null,
      is_preferred: false,
    });
  });
});
