/**
 * What the Bestand page's filter chips claim when the list is not the whole
 * truth — because it failed, or because it stopped at the server's cap.
 *
 * The chips are the part of this page a user takes in at a glance: "Alle · 412
 * Verfügbar · 368 Niedrig · 14 Leer · 3 Unterwegs · 27" is how the page
 * shipped, hard-coded, over an empty table. The figures are derived from the
 * fetched rows now — but a fetch that FAILED yields the same zeros, printed
 * directly above the row admitting the stock could not be read. "Leer · 0" is
 * a positive claim about stock nobody counted.
 *
 * The second case is the one that is not live yet: `listArticles` asks for the
 * endpoint's maximum of 500 rows, so past 500 consumables the chips would
 * describe the first 500 and say nothing about the rest.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { WerkstattInventarPage } from "../pages/werkstatt/WerkstattInventarPage";
import type { WerkstattArticleLite } from "../utils/werkstattArticlesApi";

vi.mock("../utils/werkstattArticlesApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/werkstattArticlesApi")>()),
  listArticles: vi.fn(),
}));
vi.mock("../utils/werkstattDuplicatesApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/werkstattDuplicatesApi")>()),
  listDuplicateCandidates: vi.fn(async () => []),
}));

import { listArticles } from "../utils/werkstattArticlesApi";

const listMock = vi.mocked(listArticles);

function article(id: number): WerkstattArticleLite {
  return {
    id,
    article_number: `SP-${String(id).padStart(4, "0")}`,
    ean: null,
    internal_code: null,
    item_name: `Artikel ${id}`,
    manufacturer: null,
    category_name: "Werkzeug",
    location_name: "Regal B2",
    stock_available: 9,
    stock_total: 12,
    stock_status: "available",
    image_url: null,
    next_expected_delivery_at: null,
    unit: null,
  };
}

function renderPage() {
  const context = makeAppContextStub({
    overrides: {
      mainView: "werkstatt",
      werkstattTab: "inventar",
      language: "de",
      token: "t",
      user: { id: 1, email: "a@b.c", role: "admin", effective_permissions: ["werkstatt:manage"] },
    },
  });
  return render(
    <AppContext.Provider value={context as never}>
      <WerkstattInventarPage />
    </AppContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue([article(7)]);
});

describe("WerkstattInventarPage — chips and the size of the answer", () => {
  it("counts the rows it got", async () => {
    renderPage();

    expect(await screen.findByRole("tab", { name: "Alle · 1" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Leer · 0" })).toBeInTheDocument();
  });

  it("drops the counts entirely when the stock could not be read", async () => {
    listMock.mockRejectedValue(new Error("503 Service Unavailable"));
    renderPage();

    // The error row is the page's answer; the chips must not contradict it
    // one line higher up.
    expect(await screen.findByText(/Bestand konnte nicht geladen werden/)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Alle" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Leer" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /· 0/ })).not.toBeInTheDocument();
  });

  it("says nothing about a cap it did not hit", async () => {
    renderPage();
    await screen.findByRole("tab", { name: "Alle · 1" });

    expect(screen.queryByText(/Artikel angezeigt/)).not.toBeInTheDocument();
  });

  /* A full page and a complete one look identical here: the endpoint refuses a
   * limit above its own maximum, so the page cannot fetch a probe row the way
   * the Katalog page does. It says what it knows — that there may be more, and
   * that the chip counts cover only these rows. */
  it("admits a full page might not be the whole stock", async () => {
    listMock.mockResolvedValue(Array.from({ length: 500 }, (_, index) => article(index + 1)));
    renderPage();

    const note = await screen.findByText(/500 Artikel angezeigt/);
    expect(note).toHaveTextContent("möglicherweise gibt es weitere");
    expect(note).toHaveTextContent("Die Zahlen an den Filtern zählen nur diese 500");
  });

  it("asks for no more rows than the endpoint allows", async () => {
    renderPage();
    await screen.findByRole("tab", { name: "Alle · 1" });

    expect(listMock.mock.calls[0][1]).toMatchObject({ limit: 500 });
  });
});
