/**
 * "Auf Baustelle", from the two lies it shipped with.
 *
 * "Zurückgeben" printed a notice and booked nothing, so the ledger kept the
 * tool out on the job while the office believed it was back on the shelf.
 * "Mahnen" claimed a reminder had been sent to a named colleague; there is no
 * reminder endpoint, so nobody was ever told anything.
 *
 * The assertions therefore pin: rows come from the API, the return button
 * actually POSTs (and against the right person), a failed return says so
 * instead of celebrating, and there is no reminder control anywhere on the
 * page — only a line saying reminders are not available.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { WerkstattAufBaustellePage } from "../pages/werkstatt/WerkstattAufBaustellePage";
import type { WerkstattOnSiteGroup } from "../utils/werkstattDashboardApi";

vi.mock("../utils/werkstattDashboardApi", () => ({
  fetchWerkstattDashboard: vi.fn(),
  listOnSiteGroups: vi.fn(),
  returnArticle: vi.fn(),
}));

import { listOnSiteGroups, returnArticle } from "../utils/werkstattDashboardApi";

const listMock = vi.mocked(listOnSiteGroups);
const returnMock = vi.mocked(returnArticle);

const NOW = new Date("2026-09-17T10:00:00Z");

const GROUPS: WerkstattOnSiteGroup[] = [
  {
    project_id: 3,
    project_number: "2026-110",
    project_title: "Halle A",
    item_count: 2,
    total_quantity: 5,
    overdue_count: 1,
    items: [
      {
        article_id: 11,
        article_number: "SP-0011",
        article_name: "Bohrhammer",
        unit: "Stk",
        image_url: null,
        quantity_out: 2,
        assignee_user_id: 4,
        assignee_display_name: "Tim Techniker",
        checked_out_at: "2026-09-01T08:00:00Z",
        expected_return_at: "2026-09-12T10:00:00Z",
        is_overdue: true,
      },
      {
        article_id: 12,
        article_number: "SP-0012",
        article_name: "Kabeltrommel",
        unit: "Stk",
        image_url: null,
        quantity_out: 3,
        assignee_user_id: 1,
        assignee_display_name: "Büro Chefin",
        checked_out_at: "2026-09-16T08:00:00Z",
        expected_return_at: "2026-09-17T10:00:00Z",
        is_overdue: false,
      },
    ],
  },
  {
    project_id: null,
    project_number: null,
    project_title: null,
    item_count: 1,
    total_quantity: 1,
    overdue_count: 0,
    items: [
      {
        article_id: 13,
        article_number: "SP-0013",
        article_name: "Staubsauger",
        unit: "Stk",
        image_url: null,
        quantity_out: 1,
        assignee_user_id: null,
        assignee_display_name: null,
        checked_out_at: "2026-09-16T12:00:00Z",
        expected_return_at: null,
        is_overdue: false,
      },
    ],
  },
];

function renderPage(overrides: Record<string, unknown> = {}) {
  const context = makeAppContextStub({
    overrides: {
      mainView: "werkstatt",
      werkstattTab: "on_site",
      language: "de",
      token: "t",
      now: NOW,
      user: { id: 1, email: "a@b.c", role: "admin", effective_permissions: ["werkstatt:manage"] },
      ...overrides,
    },
  });
  return render(
    <AppContext.Provider value={context as never}>
      <WerkstattAufBaustellePage />
    </AppContext.Provider>,
  );
}

/** The subtitle mixes a sentence with a coloured "überfällig" span, so its
 *  text lives across several nodes and getByText cannot see it whole. */
function subtitleText(): string {
  return document.querySelector(".werkstatt-sub-subtitle")?.textContent ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue(GROUPS);
  returnMock.mockResolvedValue({ id: 11 });
});

describe("WerkstattAufBaustellePage", () => {
  it("lists what the API says is out, grouped by site", async () => {
    renderPage();
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    expect(await screen.findByText("2026-110")).toBeTruthy();
    expect(screen.getByText("Halle A")).toBeTruthy();
    expect(screen.getByText("Bohrhammer")).toBeTruthy();
    expect(screen.getByText("Kabeltrommel")).toBeTruthy();
    // Checkouts booked without a project are still out of the workshop.
    expect(screen.getByText("OHNE PROJEKT")).toBeTruthy();
    expect(screen.getByText("Staubsauger")).toBeTruthy();
  });

  it("counts the headline totals over the whole response", async () => {
    renderPage();
    await screen.findByText("Bohrhammer");

    expect(subtitleText()).toContain("3 Positionen bei 1 Projekt");
    const overdue = screen.getByText("ÜBERFÄLLIG").closest(".werkstatt-kpi");
    expect(within(overdue as HTMLElement).getByText("1")).toBeTruthy();
    const dueToday = screen.getByText("HEUTE ZURÜCK").closest(".werkstatt-kpi");
    expect(within(dueToday as HTMLElement).getByText("1")).toBeTruthy();
  });

  it("books a real return and reloads the list", async () => {
    renderPage();
    const row = (await screen.findByText("Bohrhammer")).closest("li") as HTMLElement;

    fireEvent.click(within(row).getByRole("button", { name: /Zurück/ }));

    await waitFor(() => expect(returnMock).toHaveBeenCalledTimes(1));
    expect(returnMock).toHaveBeenCalledWith("t", {
      articleId: 11,
      quantity: 2,
      // Checked out to somebody else, so the return is written against THEIR
      // balance rather than the office user's.
      onBehalfOf: 4,
    });
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it("omits on_behalf_of when the row is the caller's own checkout", async () => {
    renderPage();
    const row = (await screen.findByText("Kabeltrommel")).closest("li") as HTMLElement;

    fireEvent.click(within(row).getByRole("button", { name: /Zurück/ }));

    await waitFor(() => expect(returnMock).toHaveBeenCalledTimes(1));
    expect(returnMock).toHaveBeenCalledWith("t", {
      articleId: 12,
      quantity: 3,
      onBehalfOf: null,
    });
  });

  it("reports the server's refusal instead of claiming a booking", async () => {
    returnMock.mockRejectedValue(new Error("Return quantity 2 exceeds stock_out 0"));
    const setNotice = vi.fn();
    renderPage({ setNotice });

    const row = (await screen.findByText("Bohrhammer")).closest("li") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: /Zurück/ }));

    expect(
      await screen.findByText(/Return quantity 2 exceeds stock_out 0/),
    ).toBeTruthy();
    expect(setNotice).not.toHaveBeenCalled();
    // A failed return must not make the list look refreshed either.
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("disables returning someone else's checkout without werkstatt:manage", async () => {
    renderPage({
      user: { id: 1, email: "a@b.c", role: "employee", effective_permissions: [] },
    });

    const foreign = (await screen.findByText("Bohrhammer")).closest("li") as HTMLElement;
    const foreignButton = within(foreign).getByRole("button", { name: /Zurück/ });
    expect((foreignButton as HTMLButtonElement).disabled).toBe(true);
    expect(foreignButton.getAttribute("title")).toMatch(/Werkstatt verwalten/);

    // The same user's own checkout needs no extra permission, so it stays live.
    const own = (screen.getByText("Kabeltrommel")).closest("li") as HTMLElement;
    expect(
      (within(own).getByRole("button", { name: /Zurück/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("offers no reminder control and says why", async () => {
    renderPage();
    await screen.findByText("Bohrhammer");

    expect(screen.queryByRole("button", { name: /Mahnen/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Team mahnen/ })).toBeNull();
    expect(
      screen.getByText(/Erinnerungen lassen sich von hier nicht verschicken/),
    ).toBeTruthy();
  });

  it("says the list failed rather than showing an empty workshop", async () => {
    listMock.mockRejectedValue(new Error("Bad Gateway"));
    renderPage();

    expect(await screen.findByText(/Die Liste konnte nicht geladen werden/)).toBeTruthy();
    expect(screen.getByText("Bad Gateway")).toBeTruthy();
    expect(screen.getAllByText("–").length).toBe(4);
    expect(
      screen.getByText("Nicht geladen — die Liste oben zeigt nichts Aktuelles."),
    ).toBeTruthy();
  });

  it("distinguishes an empty workshop from a filter that matched nothing", async () => {
    listMock.mockResolvedValue([]);
    renderPage();
    expect(
      await screen.findByText("Nichts ausgegeben — alles ist in der Werkstatt."),
    ).toBeTruthy();

    listMock.mockResolvedValue(GROUPS);
    fireEvent.click(screen.getByRole("button", { name: "Aktualisieren" }));
    await screen.findByText("Bohrhammer");

    fireEvent.change(screen.getByPlaceholderText(/Projekt, Artikel oder Person suchen/), {
      target: { value: "gibtesnicht" },
    });
    expect(screen.getByText("Keine Artikel für die aktuelle Auswahl.")).toBeTruthy();
  });

  it("filters to the overdue rows without changing the headline count", async () => {
    renderPage();
    await screen.findByText("Bohrhammer");

    fireEvent.click(screen.getByRole("tab", { name: "Überfällig" }));
    expect(screen.getByText("Bohrhammer")).toBeTruthy();
    expect(screen.queryByText("Kabeltrommel")).toBeNull();
    // Summary still describes the whole population, not the filtered slice.
    expect(subtitleText()).toContain("3 Positionen bei 1 Projekt");
  });

  it("says so when an article is out at several sites at once", async () => {
    // The API books a return against the ARTICLE, with no project on it, so
    // this list has to guess which checkout it settled. Where that guess can
    // be wrong, the page must say it is a guess.
    listMock.mockResolvedValue([
      GROUPS[0],
      {
        ...GROUPS[1],
        project_id: 9,
        project_number: "2026-220",
        project_title: "Halle B",
        items: [{ ...GROUPS[0].items[0], quantity_out: 1, is_overdue: false }],
      },
    ]);
    renderPage();
    await screen.findByText("2026-220");

    expect(
      screen.getByText(/1 Artikel ist gleichzeitig auf mehreren Baustellen ausgegeben/),
    ).toBeTruthy();
    const rows = screen.getAllByText("Bohrhammer");
    const button = within(rows[0].closest("li") as HTMLElement).getByRole("button", {
      name: /Zurück/,
    });
    expect(button.getAttribute("title")).toMatch(/Zuordnung in dieser Liste kann danach abweichen/);
  });

  it("stays quiet about attribution when every article is at one site", async () => {
    renderPage();
    await screen.findByText("Bohrhammer");
    expect(screen.queryByText(/auf mehreren Baustellen ausgegeben/)).toBeNull();
  });

  it("does not call two rows at ONE site several sites", async () => {
    // The endpoint keys rows on (site, person, deadline), so one drum out to
    // two colleagues on one job is two rows inside one group. Counting rows
    // instead of sites printed "auf mehreren Baustellen" over an article that
    // was at exactly one.
    listMock.mockResolvedValue([
      {
        ...GROUPS[0],
        item_count: 2,
        items: [
          { ...GROUPS[0].items[0], assignee_user_id: 4, assignee_display_name: "Meier" },
          {
            ...GROUPS[0].items[0],
            assignee_user_id: 8,
            assignee_display_name: "Krüger",
            expected_return_at: "2026-09-13T10:00:00Z",
          },
        ],
      },
    ]);
    renderPage();
    await screen.findByText("Meier");

    expect(screen.queryByText(/auf mehreren Baustellen ausgegeben/)).toBeNull();
    const rows = screen.getAllByText("Bohrhammer");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const button = within(row.closest("li") as HTMLElement).getByRole("button", {
        name: /Zurück/,
      });
      expect(button.getAttribute("title")).not.toMatch(/mehreren Baustellen/);
    }
  });

  it("keeps two lots of one article apart when their deadlines differ", async () => {
    // Same article, same person, same site, two return dates — the endpoint
    // now sends them as separate rows, so the page must key them separately or
    // a refusal on one would print under both.
    returnMock.mockRejectedValue(new Error("Return quantity 2 exceeds stock_out 1"));
    listMock.mockResolvedValue([
      {
        ...GROUPS[0],
        item_count: 2,
        items: [
          GROUPS[0].items[0],
          { ...GROUPS[0].items[0], quantity_out: 3, expected_return_at: null, is_overdue: false },
        ],
      },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getAllByText("Bohrhammer")).toHaveLength(2));

    // Two rows, one per lot — the one with a deadline and the one without.
    expect(screen.getByText("Ohne Rückgabedatum")).toBeTruthy();
    fireEvent.click(screen.getByTitle("2 Stk zurückbuchen"));

    expect(await screen.findByText(/exceeds stock_out 1/)).toBeTruthy();
    // Exactly one row carries the refusal, not both.
    expect(screen.getAllByText(/exceeds stock_out 1/)).toHaveLength(1);
    const refusedRow = screen
      .getByText(/exceeds stock_out 1/)
      .closest("li") as HTMLElement;
    expect(within(refusedRow).getByTitle("2 Stk zurückbuchen")).toBeTruthy();
  });

  it("drops a stale row refusal once fresh numbers arrive", async () => {
    returnMock.mockRejectedValue(new Error("Return quantity 2 exceeds stock_out 1"));
    renderPage();
    const row = (await screen.findByText("Bohrhammer")).closest("li") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: /Zurück/ }));
    await screen.findByText(/exceeds stock_out 1/);

    // A colleague books it back from the mobile screen; the user refreshes.
    listMock.mockResolvedValue([
      { ...GROUPS[0], items: [{ ...GROUPS[0].items[0], quantity_out: 1 }] },
      GROUPS[1],
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Aktualisieren" }));

    await waitFor(() =>
      expect(screen.queryByText(/exceeds stock_out 1/)).toBeNull(),
    );
  });

  it("shows no customer name and no site address", async () => {
    renderPage();
    await screen.findByText("Bohrhammer");
    // The endpoint is gated on authentication alone, so it sends neither —
    // and the page must not have kept a slot that silently renders undefined.
    expect(screen.queryByText(/Müller GmbH/)).toBeNull();
    expect(screen.queryByText(/Werkstraße/)).toBeNull();
    expect(screen.getByText("2026-110")).toBeTruthy();
  });

  it("says it is loading rather than claiming an empty workshop", () => {
    listMock.mockReturnValue(new Promise(() => {}));
    renderPage();
    const empty = document.querySelector(".werkstatt-onsite-empty");
    expect(empty?.textContent).toBe("Lädt…");
  });

  it("clears the failure banner while a retry is in flight", async () => {
    listMock.mockRejectedValueOnce(new Error("Bad Gateway"));
    renderPage();
    await screen.findByText("Bad Gateway");

    listMock.mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));

    // The banner must not keep saying the load failed while the retry runs.
    await waitFor(() =>
      expect(screen.queryByText(/Die Liste konnte nicht geladen werden/)).toBeNull(),
    );
  });

  it("does not fetch while another Werkstatt tab is showing", () => {
    renderPage({ werkstattTab: "dashboard" });
    expect(listMock).not.toHaveBeenCalled();
  });
});
