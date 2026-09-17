/**
 * Starting an order from the Orders tab.
 *
 * The report: there was no way to create an order except fetching a cart out
 * of the wholesaler's shop, and no way to pick a stocked article or a
 * catalogue row when adding a line. These pin the dialog's one job: turn
 * mixed hits — an own article, a catalogue row, a free position — into the
 * `createOrder` payload the server expects, with identity only (the server
 * snapshots names and numbers itself) and quantities merged per hit.
 */
import { describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  NeueBestellungModal,
  type NeueBestellungModalProps,
  type NeueBestellungPayload,
} from "../components/werkstatt/NeueBestellungModal";
import type { WerkstattSupplier } from "../types/werkstatt";

const SUPPLIER: WerkstattSupplier = {
  id: 7,
  name: "Unielektro",
  short_name: null,
  email: null,
  order_email: null,
  phone: null,
  contact_person: null,
  address_street: null,
  address_zip: null,
  address_city: null,
  address_country: null,
  default_lead_time_days: null,
  notes: null,
  order_identifier: "supplier_no",
  order_channel: "ids",
  is_archived: false,
  article_count: 0,
  last_order_at: null,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};

const OWN_ARTICLE = {
  id: 42,
  article_number: "SP-0042",
  ean: "4011234567890",
  internal_code: null,
  item_name: "Schuko-Steckdose",
  manufacturer: "Busch-Jaeger",
  category_name: null,
  location_name: null,
  stock_available: 12,
  stock_total: 12,
  stock_status: "available",
  image_url: null,
  next_expected_delivery_at: null,
  unit: "Stk",
  supplier_article_no: "01004771",
};

const CATALOG_ROW = {
  id: 9001,
  external_key: "u-9001",
  supplier_id: 7,
  supplier_name: "Unielektro",
  article_no: "11102138",
  item_name: "NYY-J 5x6 RE schwarz",
  ean: "4099999999999",
  manufacturer: "Lapp",
  unit: "MTR",
  price_text: "2,10 €/m",
  image_url: null,
};

/** Own-article search finds the socket; the catalogue finds the cable. */
function stubApi() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let payload: unknown = [];
      if (url.includes("/werkstatt/articles?")) payload = [OWN_ARTICLE];
      if (url.includes("/werkstatt/catalog/search?")) {
        payload = [{ ean: CATALOG_ROW.ean, hero: CATALOG_ROW, suppliers: [CATALOG_ROW] }];
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

const SONEPAR: WerkstattSupplier = { ...SUPPLIER, id: 8, name: "Sonepar", order_channel: "manual" };

function open(
  onCreate: (payload: NeueBestellungPayload) => void,
  extra: Partial<NeueBestellungModalProps> = {},
) {
  return render(
    <NeueBestellungModal
      open
      language="de"
      token="test-token"
      suppliers={[SUPPLIER]}
      tasks={[]}
      templates={[]}
      onClose={() => undefined}
      onCreate={onCreate}
      onStartFromTemplate={() => undefined}
      {...extra}
    />,
  );
}

/** The URLs the dialog asked for, in order. */
function requestedUrls(): string[] {
  return (globalThis.fetch as Mock).mock.calls.map((call) => String(call[0]));
}

describe("NeueBestellungModal — the createOrder payload", () => {
  it("builds one line per hit kind and sends identity only", async () => {
    stubApi();
    const onCreate = vi.fn();
    open(onCreate);

    fireEvent.change(screen.getByPlaceholderText(/Artikel suchen/), {
      target: { value: "NYY" },
    });
    // Both sources answer; the debounce means we wait for either hit.
    fireEvent.click(await screen.findByRole("button", { name: "Schuko-Steckdose hinzufügen" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "NYY-J 5x6 RE schwarz hinzufügen" }),
    );
    // The same article a second time is more of it, not a second line.
    fireEvent.click(screen.getByRole("button", { name: "Schuko-Steckdose hinzufügen" }));

    // A free position with its own quantity and net price.
    fireEvent.change(screen.getByLabelText("Freie Position"), {
      target: { value: "Kabelbinder 200 mm" },
    });
    fireEvent.change(screen.getByLabelText("Menge der freien Position"), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByLabelText("Einzelpreis der freien Position"), {
      target: { value: "1,50" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Freie Position" }));

    fireEvent.change(screen.getByPlaceholderText(/Baustelle Müller/), {
      target: { value: "Baustelle Müller" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Entwurf anlegen" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0][0]).toEqual({
      supplier_id: 7,
      title: "Baustelle Müller",
      task_id: null,
      lines: [
        { article_id: 42, quantity_ordered: 2 },
        { catalog_item_id: 9001, quantity_ordered: 1 },
        { description: "Kabelbinder 200 mm", quantity_ordered: 3, unit_price_cents: 150 },
      ],
    });
  });

  it("shows the supplier number beside a hit that has one", async () => {
    stubApi();
    open(() => undefined);
    fireEvent.change(screen.getByPlaceholderText(/Artikel suchen/), {
      target: { value: "Schuko" },
    });
    await screen.findByRole("button", { name: "Schuko-Steckdose hinzufügen" });
    expect(screen.getByText(/Lieferanten-Nr\. 01004771/)).toBeInTheDocument();
    expect(screen.getByText(/Art\.-Nr\. 11102138/)).toBeInTheDocument();
  });

  it("searches every own article and asks for this supplier's number, not for a filter", async () => {
    // A stocked article with no link to Unielektro yet must still be a hit —
    // it is exactly the one whose number the buyer is about to type.
    stubApi();
    open(() => undefined);
    fireEvent.change(screen.getByPlaceholderText(/Artikel suchen/), {
      target: { value: "Schuko" },
    });
    await screen.findByRole("button", { name: "Schuko-Steckdose hinzufügen" });
    const articleSearch = requestedUrls().find((url) => url.includes("/werkstatt/articles?"));
    const params = new URL(articleSearch ?? "", "http://x").searchParams;
    expect(params.get("annotate_supplier_id")).toBe("7");
    expect(params.get("supplier_id")).toBeNull();
  });

  it("keeps a catalogue pick when the supplier changes, as a free line with its EAN", async () => {
    stubApi();
    const onCreate = vi.fn();
    open(onCreate, { suppliers: [SUPPLIER, SONEPAR] });

    fireEvent.change(screen.getByPlaceholderText(/Artikel suchen/), {
      target: { value: "NYY" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "NYY-J 5x6 RE schwarz hinzufügen" }),
    );
    expect(screen.getByText(/Katalog · Lieferanten-Nr\. 11102138/)).toBeInTheDocument();

    const supplierSelect = screen.getAllByRole("combobox")[0];
    expect(supplierSelect).toHaveValue("7");
    fireEvent.change(supplierSelect, { target: { value: "8" } });

    // The notice renders — its count comes from the cart, not from inside
    // React's state updater, which runs later and reported 0.
    expect(screen.getByRole("status")).toHaveTextContent(
      "1 Katalog-Position(en) werden für den neuen Lieferanten neu aufgelöst.",
    );
    expect(screen.getByText(/Freie Position \(aus Katalog\) · EAN 4099999999999/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Entwurf anlegen" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    // No row id (it was Unielektro's), but everything the new supplier's
    // catalogue needs to find the product again.
    expect(onCreate.mock.calls[0][0]).toEqual({
      supplier_id: 8,
      title: null,
      task_id: null,
      lines: [
        {
          description: "NYY-J 5x6 RE schwarz",
          ean: "4099999999999",
          manufacturer: "Lapp",
          unit: "MTR",
          quantity_ordered: 1,
        },
      ],
    });
  });

  it("preselects a supplier with a shop connection even when its channel still says manual", () => {
    stubApi();
    open(() => undefined, {
      suppliers: [SONEPAR, { ...SUPPLIER, order_channel: "manual" }],
      shopSupplierIds: new Set([7]),
    });
    const supplierSelect = screen.getAllByRole("combobox")[0];
    expect(supplierSelect).toHaveValue("7");
    expect(screen.getByRole("option", { name: "Unielektro · Shop" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Sonepar" })).toBeInTheDocument();
  });

  it("does not create without a supplier", () => {
    stubApi();
    const onCreate = vi.fn();
    render(
      <NeueBestellungModal
        open
        language="de"
        token="test-token"
        suppliers={[]}
        tasks={[]}
        templates={[]}
        onClose={() => undefined}
        onCreate={onCreate}
        onStartFromTemplate={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: "Entwurf anlegen" })).toBeDisabled();
  });
});
