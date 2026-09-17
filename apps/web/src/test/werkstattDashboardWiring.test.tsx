/**
 * The Werkstatt dashboard, from the complaint that produced it: every number
 * on the landing screen was a literal in the JSX (412 articles, 14 below
 * minimum, 27 on site, 3 unavailable) over four fixture lists that had since
 * been emptied. A workshop orders cable off this screen.
 *
 * So the assertions are about where the numbers come from and what happens
 * when they cannot be fetched. The failure case matters most: a dashboard that
 * renders 0 after a failed request is worse than one that renders nothing,
 * because 0 is a number somebody will act on.
 *
 * The second round is about the two cards that previewed a DIFFERENT query
 * than the page their buttons open — a reorder line that does not exist on the
 * reorder page, a tool that came back in March still listed as overdue in
 * September. Both now read the destination's own endpoint.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { WerkstattDashboardPage } from "../pages/werkstatt/WerkstattDashboardPage";
import type { WerkstattDashboard } from "../types/werkstatt";
import type { WerkstattOnSiteGroup } from "../utils/werkstattDashboardApi";
import type { ReorderSuggestionGroup } from "../utils/werkstattReorderApi";

vi.mock("../utils/werkstattDashboardApi", () => ({
  fetchWerkstattDashboard: vi.fn(),
  listOnSiteGroups: vi.fn(),
  returnArticle: vi.fn(),
}));

vi.mock("../utils/werkstattReorderApi", () => ({
  listReorderSuggestions: vi.fn(),
  submitReorder: vi.fn(),
}));

import {
  fetchWerkstattDashboard,
  listOnSiteGroups,
} from "../utils/werkstattDashboardApi";
import { listReorderSuggestions } from "../utils/werkstattReorderApi";

const fetchMock = vi.mocked(fetchWerkstattDashboard);
const onSiteMock = vi.mocked(listOnSiteGroups);
const reorderMock = vi.mocked(listReorderSuggestions);

const NOW = new Date("2026-09-17T10:00:00Z");

/** The dashboard composite. Its own `on_site_groups` and `reorder_preview`
 *  blocks are still in the payload — the page must no longer render them. */
const PAYLOAD: WerkstattDashboard = {
  kpis: {
    total_articles: 87,
    total_categories: 12,
    below_min_count: 9,
    on_site_count: 9,
    on_site_project_count: 5,
    unavailable_count: 2,
    in_repair_count: 1,
  },
  reorder_preview: [
    {
      article_id: 99,
      article_number: "SP-0099",
      article_name: "Artikel ohne Lieferant",
      image_url: null,
      stock_available: 0,
      stock_min: 9,
      suggested_quantity: 9,
      unit: "Stk",
      unit_price_cents: null,
      line_total_cents: null,
    },
  ],
  recent_movements: [
    {
      id: 900,
      article_id: 11,
      article_number: "SP-0011",
      article_name: "NYM-J 5x6",
      movement_type: "checkout",
      quantity: 2,
      from_location_name: null,
      to_location_name: null,
      project_id: 3,
      project_number: "2026-110",
      project_name: "Halle A",
      user_id: 4,
      user_display_name: "Tim Techniker",
      assignee_user_id: 4,
      assignee_display_name: "Tim Techniker",
      expected_return_at: null,
      notes: null,
      created_at: "2026-09-17T09:30:00Z",
    },
    {
      id: 901,
      article_id: 12,
      article_number: "SP-0012",
      article_name: "Bohrhammer",
      movement_type: "correction",
      quantity: 1,
      from_location_name: null,
      to_location_name: null,
      project_id: null,
      project_number: null,
      project_name: null,
      user_id: 1,
      user_display_name: "Büro",
      assignee_user_id: null,
      assignee_display_name: null,
      expected_return_at: null,
      notes: null,
      created_at: "2026-09-17T08:00:00Z",
    },
    {
      id: 902,
      article_id: 13,
      article_number: "SP-0013",
      article_name: "Klemmen WAGO 221",
      movement_type: "intake",
      quantity: 50,
      from_location_name: null,
      to_location_name: "Regal C",
      project_id: null,
      project_number: null,
      project_name: null,
      user_id: 1,
      user_display_name: "Büro",
      assignee_user_id: null,
      assignee_display_name: null,
      expected_return_at: null,
      notes: null,
      created_at: "2026-09-17T07:00:00Z",
    },
  ],
  // Raw checkout rows, returns never subtracted: this block is exactly why the
  // card stopped reading it.
  on_site_groups: [
    {
      project_id: 3,
      project_number: "2025-011",
      project_title: "Längst fertig",
      item_count: 1,
      items: [
        {
          article_id: 77,
          article_number: "SP-0077",
          article_name: "Im März zurückgegeben",
          quantity: 1,
          assignee_display_name: "Tim Techniker",
          expected_return_at: "2025-03-10T10:00:00Z",
          is_overdue: true,
        },
      ],
    },
  ],
  maintenance_entries: [
    {
      article_id: 20,
      article_number: "SP-0020",
      article_name: "Leiter 3m",
      category_name: "Steighilfen",
      location_name: "Regal B",
      last_bg_inspected_at: "2025-09-01T10:00:00Z",
      next_bg_due_at: "2026-09-10T10:00:00Z",
      days_until_due: -7,
      urgency: "overdue",
    },
  ],
};

function onSiteItem(articleId: number, name: string, overdue = false) {
  return {
    article_id: articleId,
    article_number: `SP-${String(articleId).padStart(4, "0")}`,
    article_name: name,
    unit: "Stk",
    image_url: null,
    quantity_out: 2,
    assignee_user_id: 4,
    assignee_display_name: "Tim Techniker",
    checked_out_at: "2026-09-01T08:00:00Z",
    expected_return_at: overdue ? "2026-09-12T10:00:00Z" : "2026-09-30T10:00:00Z",
    is_overdue: overdue,
  };
}

/** Four sites, the first with six rows — so the 3×5 slice hides one of each. */
const ON_SITE: WerkstattOnSiteGroup[] = [
  {
    project_id: 3,
    project_number: "2026-110",
    project_title: "Halle A",
    item_count: 6,
    total_quantity: 12,
    overdue_count: 1,
    items: [
      onSiteItem(11, "Bohrhammer", true),
      onSiteItem(12, "Kabeltrommel"),
      onSiteItem(13, "Leiter 3m"),
      onSiteItem(14, "Messgerät"),
      onSiteItem(15, "Staubsauger"),
      onSiteItem(16, "Winkelschleifer"),
    ],
  },
  {
    project_id: 9,
    project_number: "2026-220",
    project_title: "Halle B",
    item_count: 1,
    total_quantity: 2,
    overdue_count: 0,
    items: [onSiteItem(17, "Akkuschrauber")],
  },
  {
    project_id: 10,
    project_number: "2026-330",
    project_title: "Halle C",
    item_count: 1,
    total_quantity: 2,
    overdue_count: 0,
    items: [onSiteItem(18, "Bohrmaschine")],
  },
  {
    project_id: 11,
    project_number: "2026-440",
    project_title: "Halle D",
    item_count: 1,
    total_quantity: 2,
    overdue_count: 0,
    items: [onSiteItem(19, "Trennschleifer")],
  },
];

function suggestionLine(id: number, name: string, available: number, min: number) {
  return {
    article_id: id,
    article_number: `SP-${String(id).padStart(4, "0")}`,
    article_name: name,
    image_url: null,
    stock_available: available,
    stock_min: min,
    suggested_quantity: min * 2 - available,
    unit: "Rolle",
    unit_price_cents: 4599,
    line_total_cents: 4599 * (min * 2 - available),
  };
}

/** Seven orderable lines across two suppliers. The KPI says nine articles are
 *  below minimum, so two of them have no supplier link at all. */
const SUGGESTIONS: ReorderSuggestionGroup[] = [
  {
    supplier_id: 1,
    supplier_name: "Unielektro",
    supplier_short_name: "UE",
    default_lead_time_days: 2,
    subtotal_cents: 12345,
    currency: "EUR",
    lines: [
      suggestionLine(11, "NYM-J 5x6", 1, 9),
      suggestionLine(12, "NYM-J 3x1,5", 2, 8),
      suggestionLine(13, "Schelle 16mm", 3, 7),
      suggestionLine(14, "Dose tief", 4, 6),
    ],
  },
  {
    supplier_id: 2,
    supplier_name: "Sonepar",
    supplier_short_name: "SP",
    default_lead_time_days: 3,
    subtotal_cents: 6789,
    currency: "EUR",
    lines: [
      suggestionLine(15, "Kabelbinder", 5, 6),
      suggestionLine(16, "Klemme 3-fach", 5, 7),
      suggestionLine(17, "Automat B16", 5, 8),
    ],
  },
];

function renderPage(overrides: Record<string, unknown> = {}) {
  const context = makeAppContextStub({
    overrides: {
      mainView: "werkstatt",
      werkstattTab: "dashboard",
      language: "de",
      token: "t",
      now: NOW,
      user: { id: 1, email: "a@b.c", role: "admin", effective_permissions: ["werkstatt:manage"] },
      ...overrides,
    },
  });
  return render(
    <AppContext.Provider value={context as never}>
      <WerkstattDashboardPage />
    </AppContext.Provider>,
  );
}

function cardFor(title: string): HTMLElement {
  return screen.getByText(title).closest("section") as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue(PAYLOAD);
  onSiteMock.mockResolvedValue(ON_SITE);
  reorderMock.mockResolvedValue(SUGGESTIONS);
});

describe("WerkstattDashboardPage", () => {
  it("shows the KPI numbers the API returned, not the old literals", async () => {
    renderPage();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(await screen.findByText("87")).toBeTruthy();
    expect(screen.getByText("über 12 Kategorien")).toBeTruthy();
    // The hard-coded figures the page used to print.
    expect(screen.queryByText("412")).toBeNull();
    expect(screen.queryByText("27")).toBeNull();
  });

  it("makes no subset claim on the NICHT-VERFÜGBAR tile", async () => {
    // `unavailable_count` counts stock_available <= 0 and `in_repair_count`
    // counts stock_repair > 0 — independent predicates. "davon N in Reparatur"
    // could therefore print a subset larger than its own total.
    fetchMock.mockResolvedValue({
      ...PAYLOAD,
      kpis: { ...PAYLOAD.kpis, unavailable_count: 0, in_repair_count: 1 },
    });
    renderPage();

    const tile = (await screen.findByText("NICHT VERFÜGBAR")).closest(
      ".werkstatt-kpi",
    ) as HTMLElement;
    expect(within(tile).getByText("kein Bestand verfügbar")).toBeTruthy();
    expect(screen.queryByText(/davon/)).toBeNull();
    expect(screen.queryByText(/of them in repair/)).toBeNull();
    // The repair figure keeps its place where it makes no subset claim.
    expect(screen.getByText(/1 Artikel in Reparatur/)).toBeTruthy();
  });

  it("renders every block from the endpoint that owns it", async () => {
    renderPage();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(await screen.findByText("9 Artikel unter Mindestbestand")).toBeTruthy();
    expect(within(cardFor("Nachbestellen")).getByText("NYM-J 5x6")).toBeTruthy();
    expect(screen.getByText("9 Artikel außer Haus")).toBeTruthy();
    expect(within(cardFor("Auf Baustelle")).getByText("2026-110")).toBeTruthy();
    expect(screen.getByText("Leiter 3m")).toBeTruthy();
    expect(screen.getByText("7 T. überfällig")).toBeTruthy();
  });

  it("builds the on-site card from the netted list, not from checkout rows", async () => {
    renderPage();
    const card = cardFor("Auf Baustelle");
    await within(card).findByText("2026-110");

    // The dashboard payload still carries a checkout from March that was
    // returned two days later. It must not reach the card.
    expect(screen.queryByText(/Im März zurückgegeben/)).toBeNull();
    expect(screen.queryByText("2025-011")).toBeNull();
    expect(onSiteMock).toHaveBeenCalledTimes(1);

    // The slice is 3 sites × 5 rows, and the footer says what it left out
    // instead of apologising for rows that may already be back.
    expect(within(card).queryByText("2026-440")).toBeNull();
    expect(within(card).queryByText(/2 Stk Winkelschleifer/)).toBeNull();
    expect(
      within(card).getByText(
        "Rückgaben sind abgezogen. 1 weitere Baustelle und 1 weitere Position unter „Alle“.",
      ),
    ).toBeTruthy();
    expect(within(card).queryByText(/bereits zurückgegebene/)).toBeNull();
  });

  it("counts the reorder card against the page its buttons open", async () => {
    renderPage();
    const card = cardFor("Nachbestellen");
    await within(card).findByText("NYM-J 5x6");

    // Seven lines exist on the Nachbestellen page, five are previewed here.
    expect(within(card).getByText(/2 weitere unter Nachbestellen/)).toBeTruthy();
    // And the two below-minimum articles that page cannot list are named,
    // so the subtitle's nine and the footer's seven do not contradict.
    expect(
      within(card).getByText(/2 Artikel haben keinen Lieferanten hinterlegt/),
    ).toBeTruthy();
    // An article with no supplier link never becomes a row with an order
    // button that leads to a page it does not appear on.
    expect(screen.queryByText("Artikel ohne Lieferant")).toBeNull();
  });

  it("says the numbers could not be loaded instead of showing zeros", async () => {
    fetchMock.mockRejectedValue(new Error("Service Unavailable"));
    onSiteMock.mockRejectedValue(new Error("Service Unavailable"));
    reorderMock.mockRejectedValue(new Error("Service Unavailable"));
    renderPage();

    expect(
      await screen.findByText(/Die Zahlen konnten nicht geladen werden/),
    ).toBeTruthy();
    // Four KPI tiles, all unknown — and no invented zero among them.
    expect(screen.getAllByText("–").length).toBe(4);
    expect(screen.getAllByText("nicht geladen").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Nicht geladen.").length).toBe(4);
    expect(screen.queryByText("0")).toBeNull();
  });

  it("names a partial failure as partial", async () => {
    reorderMock.mockRejectedValue(new Error("Bestellvorschläge kaputt"));
    renderPage();

    expect(
      await screen.findByText(/Ein Teil der Zahlen konnte nicht geladen werden/),
    ).toBeTruthy();
    expect(screen.getByText(/Bestellvorschläge kaputt/)).toBeTruthy();
    // The blocks that did load still show their rows.
    expect(within(cardFor("Auf Baustelle")).getByText("2026-110")).toBeTruthy();
    expect(within(cardFor("Nachbestellen")).getByText("Nicht geladen.")).toBeTruthy();
  });

  it("retries only what failed, and drops the banner while it runs", async () => {
    reorderMock.mockRejectedValueOnce(new Error("kaputt"));
    renderPage();
    await screen.findByText(/kaputt/);

    reorderMock.mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));

    await waitFor(() => expect(reorderMock).toHaveBeenCalledTimes(2));
    // The one that succeeded is not refetched, and the banner does not keep
    // claiming a failure the user has already asked to retry.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.queryByText(/nicht geladen werden/)).toBeNull(),
    );
  });

  it("gives every block its own empty state", async () => {
    fetchMock.mockResolvedValue({
      ...PAYLOAD,
      kpis: { ...PAYLOAD.kpis, below_min_count: 0, on_site_count: 0, on_site_project_count: 0 },
      recent_movements: [],
      maintenance_entries: [],
    });
    onSiteMock.mockResolvedValue([]);
    reorderMock.mockResolvedValue([]);
    renderPage();

    expect(
      await screen.findByText(
        "Nichts zu bestellen — alles über Mindestbestand oder ohne Lieferant.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Noch keine Buchungen.")).toBeTruthy();
    expect(screen.getByText("Nichts ausgegeben.")).toBeTruthy();
    expect(screen.getByText("Keine prüfpflichtigen Werkzeuge.")).toBeTruthy();
  });

  it("says it is loading before it has an answer, never 'nothing to report'", () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    onSiteMock.mockReturnValue(new Promise(() => {}));
    reorderMock.mockReturnValue(new Promise(() => {}));
    renderPage();

    expect(screen.getAllByText("Lädt…").length).toBe(4);
    expect(screen.queryByText(/Alles über Mindestbestand/)).toBeNull();
    expect(screen.queryByText("Nichts ausgegeben.")).toBeNull();
    expect(screen.queryByText("Keine prüfpflichtigen Werkzeuge.")).toBeNull();
    expect(screen.queryByText("Noch keine Buchungen.")).toBeNull();
  });

  it("filters the loaded movements without hiding rows silently", async () => {
    renderPage();
    // Scoped to the movements card: other cards render the same article names,
    // so a page-wide query proves nothing.
    const card = (await screen.findByText("Letzte Bewegungen")).closest(
      "section",
    ) as HTMLElement;
    expect(within(card).getByText("Die letzten 3 Buchungen")).toBeTruthy();

    fireEvent.click(within(card).getByRole("tab", { name: "Korrekturen" }));
    expect(within(card).getByText("1× Bohrhammer")).toBeTruthy();
    expect(within(card).queryByText("2× NYM-J 5x6")).toBeNull();
  });

  it("keeps a supplier delivery out of the 'Rückgaben' bucket", async () => {
    renderPage();
    const card = (await screen.findByText("Letzte Bewegungen")).closest(
      "section",
    ) as HTMLElement;

    // Somebody checking what came back from the sites must not be handed the
    // morning's delivery under that label.
    fireEvent.click(within(card).getByRole("tab", { name: "Rückgaben" }));
    expect(within(card).queryByText("50× Klemmen WAGO 221")).toBeNull();
    expect(
      within(card).getByText("Keine Buchungen dieser Art unter den letzten."),
    ).toBeTruthy();

    fireEvent.click(within(card).getByRole("tab", { name: "Wareneingang" }));
    expect(within(card).getByText("50× Klemmen WAGO 221")).toBeTruthy();
  });

  it("does not print the project count that only ever grows", async () => {
    renderPage();
    await screen.findByText("87");
    // `on_site_project_count` counts every project that has EVER had a
    // checkout, so no tile or card subtitle may present it as "at N sites".
    expect(screen.queryByText(/bei 5 Projekten/)).toBeNull();
    expect(screen.getByText("Artikel außer Haus")).toBeTruthy();
    expect(screen.getByText("9 Artikel außer Haus")).toBeTruthy();
  });

  it("opens the full list and the reorder tab from the cards", async () => {
    const setWerkstattTab = vi.fn();
    renderPage({ setWerkstattTab });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Alle →" }));
    expect(setWerkstattTab).toHaveBeenCalledWith("on_site");

    fireEvent.click(screen.getByRole("button", { name: "Nachbestellen öffnen →" }));
    expect(setWerkstattTab).toHaveBeenCalledWith("nachbestellen");
  });

  it("does not fetch while another Werkstatt tab is showing", () => {
    renderPage({ werkstattTab: "inventar" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onSiteMock).not.toHaveBeenCalled();
    expect(reorderMock).not.toHaveBeenCalled();
  });
});
