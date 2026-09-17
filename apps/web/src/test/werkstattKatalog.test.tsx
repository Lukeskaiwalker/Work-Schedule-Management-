/**
 * The Datanorm catalogue page, from what it used to invent.
 *
 * Three numbers on that page came from nowhere: the supplier filter was built
 * from an emptied fixture list (so it never appeared at all), every offer
 * carried `lead_time_days: 0` — "0 Werktage" on every article in the
 * workshop — and a PREFERRED badge was wired to a constant false. The page
 * also read an endpoint that does not know which supplier a Datanorm row
 * belongs to, and printed the manufacturer under the word "Lieferanten".
 *
 * So the assertions are about provenance: the filter is the supplier list the
 * API returns, choosing one narrows the SERVER query (the pool is far larger
 * than one page of results), and a failed load says it failed instead of
 * rendering an empty catalogue that reads as "we stock nothing".
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { WerkstattKatalogPage } from "../pages/werkstatt/WerkstattKatalogPage";
import type {
  MaterialCatalogItemLite,
  WerkstattCatalogGroup,
  WerkstattSupplier,
} from "../types/werkstatt";

vi.mock("../utils/werkstattCatalogApi", () => ({ searchWerkstattCatalog: vi.fn() }));
vi.mock("../utils/werkstattSuppliersApi", () => ({ listSuppliers: vi.fn() }));
vi.mock("../utils/werkstattKatalogApi", () => ({
  uploadCatalogImage: vi.fn(),
  deleteCatalogImage: vi.fn(),
}));
vi.mock("../utils/werkstattBedarfeApi", () => ({
  createNeed: vi.fn(),
  searchCatalogItems: vi.fn(async () => []),
}));

import { searchWerkstattCatalog } from "../utils/werkstattCatalogApi";
import { listSuppliers } from "../utils/werkstattSuppliersApi";
import { deleteCatalogImage, uploadCatalogImage } from "../utils/werkstattKatalogApi";
import { KATALOG_FETCH_LIMIT, KATALOG_SEARCH_LIMIT } from "../components/werkstatt/katalogEntries";

const searchMock = vi.mocked(searchWerkstattCatalog);
const suppliersMock = vi.mocked(listSuppliers);
const uploadMock = vi.mocked(uploadCatalogImage);
const deleteMock = vi.mocked(deleteCatalogImage);

function lite(over: Partial<MaterialCatalogItemLite> & { id: number }): MaterialCatalogItemLite {
  return {
    external_key: `key-${over.id}`,
    supplier_id: null,
    supplier_name: null,
    article_no: null,
    item_name: "NYM-J 5x6",
    ean: null,
    manufacturer: null,
    unit: null,
    price_text: null,
    image_url: null,
    ...over,
  };
}

function supplier(over: Partial<WerkstattSupplier> & { id: number; name: string }): WerkstattSupplier {
  return {
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
    order_channel: "manual",
    is_archived: false,
    article_count: 0,
    last_order_at: null,
    created_at: "2026-01-01T08:00:00Z",
    updated_at: "2026-01-01T08:00:00Z",
    ...over,
  };
}

const SUPPLIERS: WerkstattSupplier[] = [
  supplier({ id: 7, name: "Unielektro Fachgroßhandel", short_name: "Unielektro", default_lead_time_days: 3 }),
  supplier({ id: 9, name: "Sonepar" }),
  supplier({ id: 11, name: "Altlieferant", is_archived: true }),
];

const SINGLE: WerkstattCatalogGroup = {
  ean: "4011234567890",
  hero: lite({
    id: 501,
    supplier_id: 7,
    supplier_name: "Unielektro Fachgroßhandel",
    article_no: "11102138",
    item_name: "NYM-J 5x6 grau",
    ean: "4011234567890",
    manufacturer: "Lapp",
    unit: "m",
    price_text: "4,15 €/m",
  }),
  suppliers: [],
};
SINGLE.suppliers = [SINGLE.hero];

const MULTI: WerkstattCatalogGroup = {
  ean: "4019876543210",
  hero: lite({
    id: 601,
    supplier_id: 7,
    supplier_name: "Unielektro Fachgroßhandel",
    article_no: "A-1",
    item_name: "Rohr M20",
    ean: "4019876543210",
    price_text: "1,10 €",
  }),
  suppliers: [],
};
MULTI.suppliers = [
  MULTI.hero,
  lite({
    id: 602,
    supplier_id: 9,
    supplier_name: "Sonepar",
    article_no: "S-2",
    item_name: "Rohr M20",
    ean: "4019876543210",
    price_text: "1,05 €",
  }),
];

/** Two wholesalers for one EAN, both carrying a picture — the case where
 *  deleting the displayed one silently promotes the other. */
const PICTURED: WerkstattCatalogGroup = {
  ean: "4019876543210",
  hero: lite({
    id: 701,
    supplier_id: 7,
    supplier_name: "Unielektro Fachgroßhandel",
    item_name: "Rohr M20",
    ean: "4019876543210",
    image_url: "/api/materials/catalog/images/key-701",
  }),
  suppliers: [],
};
PICTURED.suppliers = [
  PICTURED.hero,
  lite({
    id: 702,
    supplier_id: 9,
    supplier_name: "Sonepar",
    item_name: "Rohr M20",
    ean: "4019876543210",
    image_url: "/api/materials/catalog/images/key-702",
  }),
];

/** `count` single-row groups, as the server would answer them. */
function singles(count: number): WerkstattCatalogGroup[] {
  return Array.from({ length: count }, (_, index) => {
    const row = lite({ id: 1000 + index, item_name: `Artikel ${index + 1}`, supplier_id: 7 });
    return { ean: null, hero: row, suppliers: [row] };
  });
}

function renderPage(overrides: Record<string, unknown> = {}) {
  const context = makeAppContextStub({
    overrides: {
      mainView: "werkstatt",
      werkstattTab: "katalog",
      language: "de",
      token: "t",
      user: { id: 1, email: "a@b.c", role: "admin", effective_permissions: ["werkstatt:manage"] },
      activeProjects: [],
      ...overrides,
    },
  });
  return render(
    <AppContext.Provider value={context as never}>
      <WerkstattKatalogPage />
    </AppContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  searchMock.mockResolvedValue([SINGLE, MULTI]);
  suppliersMock.mockResolvedValue(SUPPLIERS);
});

describe("WerkstattKatalogPage", () => {
  it("builds the supplier filter from the API and hides archived suppliers", async () => {
    renderPage();

    expect(await screen.findByRole("tab", { name: "Unielektro" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Sonepar" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Altlieferant" })).not.toBeInTheDocument();
  });

  it("asks the SERVER to narrow by supplier rather than filtering the page", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "Sonepar" }));

    await waitFor(() => {
      const calls = searchMock.mock.calls;
      expect(calls[calls.length - 1][1]).toMatchObject({ supplierId: 9 });
    });
  });

  it("sends the typed text to the server", async () => {
    renderPage();
    await screen.findByText("NYM-J 5x6 grau");

    fireEvent.change(screen.getByLabelText("Katalog durchsuchen"), {
      target: { value: "nym 5x6" },
    });

    await waitFor(() => {
      const calls = searchMock.mock.calls;
      expect(calls[calls.length - 1][1]).toMatchObject({ q: "nym 5x6" });
    });
  });

  it("names the real supplier on each offer of a grouped product", async () => {
    renderPage();
    await screen.findByText("Rohr M20");

    // Scoped to the offer rows: the chip row carries these names too, and the
    // point of this case is that the OFFER says who sells it — the page used
    // to print the manufacturer there.
    const offerName = ".werkstatt-katalog-offer-main b";
    expect(screen.getByText("Sonepar", { selector: offerName })).toBeInTheDocument();
    expect(
      screen.getByText("Unielektro Fachgroßhandel", { selector: offerName }),
    ).toBeInTheDocument();
    expect(screen.getByText("2 Lieferanten")).toBeInTheDocument();
  });

  it("never claims a delivery time the catalogue does not carry", async () => {
    renderPage();
    await screen.findByText("Rohr M20");

    // The invented constant that used to sit on every single offer.
    expect(screen.queryByText(/0 Werktage/)).not.toBeInTheDocument();
    // Unielektro has a lead time on its supplier record; it is shown as the
    // SUPPLIER's standard, and Sonepar's unknown one is admitted as unknown.
    expect(screen.getByText("i. d. R. 3 Werktage")).toBeInTheDocument();
    expect(screen.getByText("Lieferzeit unbekannt")).toBeInTheDocument();
  });

  it("says a failed search failed instead of rendering an empty catalogue", async () => {
    searchMock.mockRejectedValue(new Error("502 Bad Gateway"));
    renderPage();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Katalog konnte nicht geladen werden.");
    expect(alert).toHaveTextContent("502 Bad Gateway");
    expect(screen.queryByText(/Keine Treffer/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Produkte ·/)).not.toBeInTheDocument();
  });

  it("retries the search on demand", async () => {
    searchMock.mockRejectedValueOnce(new Error("offline"));
    renderPage();
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));

    expect(await screen.findByText("NYM-J 5x6 grau")).toBeInTheDocument();
  });

  it("distinguishes an empty pool from a search that found nothing", async () => {
    searchMock.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText(/Noch keine Katalogdaten/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Katalog durchsuchen"), {
      target: { value: "gibtsnicht" },
    });

    expect(await screen.findByText(/Keine Treffer/)).toBeInTheDocument();
  });

  it("admits when the supplier list could not be loaded", async () => {
    suppliersMock.mockRejectedValue(new Error("403"));
    renderPage();

    expect(
      await screen.findByText(/es lässt sich gerade nicht nach Lieferant filtern/),
    ).toBeInTheDocument();
  });

  /* The picture control existed before and could never run: it was gated on
   * `external_key`, and the endpoint the page used then never returns one. */
  it("attaches an uploaded picture to the catalogue row it belongs to", async () => {
    uploadMock.mockResolvedValue({
      ok: true,
      external_key: "key-501",
      image_url: "/api/materials/catalog/images/key-501",
      image_source: "manual",
    });
    const { container } = renderPage();
    await screen.findByText("NYM-J 5x6 grau");

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["x"], "steckdose.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(uploadMock).toHaveBeenCalledWith("t", "key-501", file));
    // Shown from the answer, without a second round trip.
    expect(await screen.findByRole("button", { name: "Bild entfernen" })).toBeInTheDocument();
    expect(container.querySelector("img.katalog-thumb-img")).toHaveAttribute(
      "src",
      "/api/materials/catalog/images/key-501",
    );
  });

  it("says an upload failed rather than showing a picture that is not there", async () => {
    uploadMock.mockRejectedValue(new Error("413 Payload Too Large"));
    const { container } = renderPage();
    await screen.findByText("NYM-J 5x6 grau");

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "gross.png", { type: "image/png" })] },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("413 Payload Too Large");
    expect(container.querySelector("img.katalog-thumb-img")).toBeNull();
  });

  /* The chip commits on the same render; the new rows are a debounce plus a
   * round trip away. Keeping the previous supplier's cards under an already
   * active "Sonepar" chip re-attributes every price on screen to a wholesaler
   * that never quoted it. */
  it("clears the cards when the supplier filter changes", async () => {
    renderPage();
    await screen.findByText("NYM-J 5x6 grau");

    fireEvent.click(screen.getByRole("tab", { name: "Sonepar" }));

    expect(screen.queryByText("NYM-J 5x6 grau")).not.toBeInTheDocument();
    // And no counts describing a list that is no longer on screen.
    expect(screen.queryByText(/Produkte ·/)).not.toBeInTheDocument();
    // Header note and list placeholder both say it; either is the honest
    // "nothing to report yet" state this falls back to.
    expect(screen.getAllByText("Lädt…").length).toBeGreaterThan(0);
  });

  it("names the wholesaler on a card that has no offer list", async () => {
    const { container } = renderPage();
    await screen.findByText("NYM-J 5x6 grau");

    // The one field the whole endpoint switch was made for: a single-offer
    // card used to print "4,15 €/m" with nobody's name against it.
    expect(container.querySelector(".werkstatt-katalog-hero-supplier")).toHaveTextContent(
      "Unielektro Fachgroßhandel",
    );
  });

  it("does not present a filtered count as the product's supplier count", async () => {
    renderPage();
    await screen.findByText("Rohr M20");
    fireEvent.click(screen.getByRole("tab", { name: "Sonepar" }));
    await screen.findByText("Rohr M20");

    // With a chip active every group holds that supplier's rows by
    // construction, so a count says nothing about who else carries the
    // product — and "1 Lieferant" beside the name says the opposite.
    expect(screen.queryByText("1 Lieferant")).not.toBeInTheDocument();
    expect(screen.getAllByText("Treffer bei diesem Lieferanten").length).toBeGreaterThan(0);
  });

  it("asks for one row beyond the page and stays quiet at exactly the cap", async () => {
    searchMock.mockResolvedValue(singles(KATALOG_SEARCH_LIMIT));
    renderPage();
    await screen.findByText("Artikel 1");

    expect(searchMock.mock.calls[0][1]).toMatchObject({ limit: KATALOG_FETCH_LIMIT });
    // Exactly 60 rows is a complete answer, not a cut-off one.
    expect(screen.queryByText(/Nur die ersten/)).not.toBeInTheDocument();
  });

  it("admits the cut — and that the supplier counts suffer from it", async () => {
    searchMock.mockResolvedValue(singles(KATALOG_FETCH_LIMIT));
    renderPage();
    await screen.findByText("Artikel 1");

    const note = screen.getByText(/Nur die ersten/);
    expect(note).toHaveTextContent(
      `Nur die ersten ${KATALOG_SEARCH_LIMIT} Katalogeinträge werden angezeigt`,
    );
    expect(note).toHaveTextContent("Lieferantenzahl");
    // The probe row is counted, never rendered: the list must match the note.
    expect(screen.getByText(`${KATALOG_SEARCH_LIMIT} Produkte · ${KATALOG_SEARCH_LIMIT} Katalogeinträge`))
      .toBeInTheDocument();
    expect(screen.queryByText(`Artikel ${KATALOG_FETCH_LIMIT}`)).not.toBeInTheDocument();
  });

  /* The picture is shared catalogue data: the DELETE drops the file and the
   * row's image state for the whole company, with no undo and no permission
   * to gate the button on. A mis-tap on a 14 px × must not be enough. */
  it("does not delete a picture on the first click", async () => {
    searchMock.mockResolvedValue([PICTURED]);
    renderPage();
    await screen.findByText("Rohr M20");

    fireEvent.click(screen.getByRole("button", { name: "Bild entfernen" }));

    expect(deleteMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("lässt sich nicht rückgängig machen");
  });

  it("deletes once the removal is confirmed, and says which picture went", async () => {
    deleteMock.mockResolvedValue(undefined);
    searchMock.mockResolvedValue([PICTURED]);
    const setNotice = vi.fn();
    renderPage({ setNotice });
    await screen.findByText("Rohr M20");

    fireEvent.click(screen.getByRole("button", { name: "Bild entfernen" }));
    fireEvent.click(screen.getByRole("button", { name: "Entfernen" }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("t", "key-701"));
    // The card immediately falls back to Sonepar's picture, so a bare "Bild
    // entfernt." would be indistinguishable from nothing having happened —
    // and the next click would destroy the second wholesaler's image too.
    await waitFor(() => expect(setNotice).toHaveBeenCalled());
    const message = String(setNotice.mock.calls[0][0]);
    expect(message).toContain("Bild von Unielektro Fachgroßhandel entfernt.");
    expect(message).toContain("Sonepar");
  });

  it("lets the user back out of a removal", async () => {
    searchMock.mockResolvedValue([PICTURED]);
    renderPage();
    await screen.findByText("Rohr M20");

    fireEvent.click(screen.getByRole("button", { name: "Bild entfernen" }));
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));

    expect(deleteMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("hides 'In Werkstatt anlegen' without werkstatt:manage", async () => {
    renderPage({ user: { id: 2, email: "b@c.d", role: "employee", effective_permissions: [] } });
    await screen.findByText("NYM-J 5x6 grau");

    expect(screen.queryByRole("button", { name: "In Werkstatt anlegen" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Zum Projekt-Bedarf" }).length).toBeGreaterThan(0);
  });
});
