/**
 * The Werkstatt "Verteiler" tab: every planned panel, how far its picking is,
 * and one panel's list on tap.
 *
 * The numbers on this screen are what the workshop acts on ("ist der ZV1
 * fertig gepackt?"), so the assertions pin that rows and headline figures come
 * from the overview endpoint, that a failed load says so instead of showing an
 * empty workshop, that the search finds a cabinet by any name a person at the
 * rack might know, and that the detail hands the shared list the right panel
 * with the right permission. The list itself is stubbed: it is a separate
 * component with its own tests, and this page only has to embed it.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { WerkstattVerteilerPage } from "../pages/werkstatt/WerkstattVerteilerPage";
import type { PanelMaterialSummary } from "../types/schaltplan";

vi.mock("../utils/schaltplanApi", () => ({
  getPanelMaterialOverview: vi.fn(),
}));

vi.mock("../components/schaltplan/PanelMaterialList", () => ({
  PanelMaterialList: (props: {
    panelId: number;
    canEdit: boolean;
    language: string;
    hideHeader?: boolean;
    onChanged?: () => void;
  }) => (
    <div
      data-testid="panel-material-list"
      data-panel-id={props.panelId}
      data-can-edit={String(props.canEdit)}
      data-language={props.language}
      data-hide-header={String(Boolean(props.hideHeader))}
    >
      <button type="button" onClick={() => props.onChanged?.()}>
        stub-changed
      </button>
    </div>
  ),
}));

import { getPanelMaterialOverview } from "../utils/schaltplanApi";

const overviewMock = vi.mocked(getPanelMaterialOverview);

const ZV1: PanelMaterialSummary = {
  panel: {
    id: 7,
    panel_number: "VT-0007",
    designation: "ZV1",
    name: "Zählerverteiler",
    panel_type: "meter",
    status: "draft",
    customer_id: 3,
    customer_name: "Schulze",
    project_id: 244,
    project_number: "381",
    project_name: "Neubau Schulze",
    updated_at: "2026-09-24T08:00:00",
  },
  planned_total: 40,
  scanned_total: 12,
  open_lines: 5,
  last_scanned_at: "2026-09-24T08:12:00",
};

const UV2: PanelMaterialSummary = {
  panel: {
    id: 2,
    panel_number: "VT-0002",
    designation: "UV2",
    name: "Unterverteiler",
    panel_type: "sub",
    status: "final",
    customer_id: 4,
    customer_name: "Meier",
    project_id: 250,
    project_number: "999",
    project_name: "Halle B",
    updated_at: "2026-09-20T08:00:00",
  },
  planned_total: 20,
  scanned_total: 20,
  open_lines: 0,
  last_scanned_at: null,
};

function renderPage(overrides: Record<string, unknown> = {}) {
  const context = makeAppContextStub({
    overrides: {
      mainView: "werkstatt",
      werkstattTab: "verteiler",
      language: "de",
      token: "t",
      user: { id: 1, email: "a@b.c", role: "admin", effective_permissions: ["reports:create"] },
      ...overrides,
    },
  });
  return render(
    <AppContext.Provider value={context as never}>
      <WerkstattVerteilerPage />
    </AppContext.Provider>,
  );
}

function kpi(label: string): HTMLElement {
  return screen.getByText(label).closest(".werkstatt-kpi") as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  overviewMock.mockResolvedValue([ZV1, UV2]);
});

describe("WerkstattVerteilerPage", () => {
  it("does not fetch while another Werkstatt tab is showing", () => {
    renderPage({ werkstattTab: "dashboard" });
    expect(overviewMock).not.toHaveBeenCalled();
    expect(screen.queryByText("Verteiler")).toBeNull();
  });

  it("lists every panel from the overview with its picking progress", async () => {
    renderPage();
    await waitFor(() => expect(overviewMock).toHaveBeenCalledTimes(1));
    expect(overviewMock).toHaveBeenCalledWith("t", expect.anything());

    expect(await screen.findByText("VT-0007")).toBeTruthy();
    expect(screen.getByText("ZV1")).toBeTruthy();
    expect(screen.getByText("Zählerverteiler")).toBeTruthy();
    expect(screen.getByText("Schulze · 381 Neubau Schulze")).toBeTruthy();
    expect(screen.getByText("12 / 40")).toBeTruthy();
    expect(screen.getByText("5 offen")).toBeTruthy();
    expect(screen.getByText(/zuletzt gescannt/)).toBeTruthy();

    expect(screen.getByText("VT-0002")).toBeTruthy();
    expect(screen.getByText("20 / 20")).toBeTruthy();
    expect(screen.getByText("vollständig")).toBeTruthy();
  });

  it("counts the headline figures over the whole overview", async () => {
    renderPage();
    await screen.findByText("VT-0007");

    expect(within(kpi("VERTEILER")).getByText("2")).toBeTruthy();
    // "In Arbeit" = panels with at least one scan on record.
    expect(within(kpi("IN ARBEIT")).getByText("1")).toBeTruthy();
    expect(within(kpi("OFFENE POSITIONEN")).getByText("5")).toBeTruthy();
    expect(within(kpi("GESCANNT")).getByText("32")).toBeTruthy();
    expect(within(kpi("GESCANNT")).getByText("von 60 geplant")).toBeTruthy();
    expect(document.querySelector(".werkstatt-sub-subtitle")?.textContent).toBe(
      "2 Verteiler geplant · 1 in Kommissionierung",
    );
  });

  it("finds a panel by number, name, customer or project number", async () => {
    renderPage();
    await screen.findByText("VT-0007");
    const search = screen.getByPlaceholderText(/Verteiler, Kunde oder Projekt suchen/);

    fireEvent.change(search, { target: { value: "vt-0002" } });
    expect(screen.queryByText("VT-0007")).toBeNull();
    expect(screen.getByText("VT-0002")).toBeTruthy();

    fireEvent.change(search, { target: { value: "schulze" } });
    expect(screen.getByText("VT-0007")).toBeTruthy();
    expect(screen.queryByText("VT-0002")).toBeNull();

    fireEvent.change(search, { target: { value: "999" } });
    expect(screen.queryByText("VT-0007")).toBeNull();
    expect(screen.getByText("VT-0002")).toBeTruthy();

    fireEvent.change(search, { target: { value: "unterverteiler" } });
    expect(screen.getByText("VT-0002")).toBeTruthy();

    fireEvent.change(search, { target: { value: "gibtesnicht" } });
    expect(screen.getByText("Kein Verteiler passt zur Suche.")).toBeTruthy();
    // The headline numbers still describe the whole population.
    expect(within(kpi("VERTEILER")).getByText("2")).toBeTruthy();
  });

  it("opens a panel's list on tap and comes back to a fresh overview", async () => {
    renderPage();
    await screen.findByText("VT-0007");

    fireEvent.click(screen.getByRole("button", { name: /VT-0007 ZV1 Zählerverteiler öffnen/ }));

    const list = screen.getByTestId("panel-material-list");
    expect(list.getAttribute("data-panel-id")).toBe("7");
    expect(list.getAttribute("data-can-edit")).toBe("true");
    expect(list.getAttribute("data-language")).toBe("de");
    // The card head already names the panel; the list must not repeat it.
    expect(list.getAttribute("data-hide-header")).toBe("true");
    expect(screen.getByText("Zählerverteiler")).toBeTruthy();
    expect(screen.getByText(/Schulze · 381 Neubau Schulze/)).toBeTruthy();
    expect(screen.getByText("5 offen")).toBeTruthy();
    // The overview rows are gone while the detail is open.
    expect(screen.queryByText("VT-0002")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Zurück zur Übersicht/ }));
    expect(screen.queryByTestId("panel-material-list")).toBeNull();
    expect(await screen.findByText("VT-0002")).toBeTruthy();
    // Booking in the detail changes the row's numbers, so coming back reloads.
    await waitFor(() => expect(overviewMock).toHaveBeenCalledTimes(2));
  });

  it("reloads the overview when the list reports a booking", async () => {
    renderPage();
    await screen.findByText("VT-0007");
    fireEvent.click(screen.getByRole("button", { name: /VT-0007 ZV1 Zählerverteiler öffnen/ }));

    overviewMock.mockResolvedValue([{ ...ZV1, scanned_total: 13, open_lines: 4 }, UV2]);
    fireEvent.click(screen.getByRole("button", { name: "stub-changed" }));

    await waitFor(() => expect(overviewMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("4 offen")).toBeTruthy();
    expect(screen.getByText(/13 \/ 40/)).toBeTruthy();
  });

  it("withholds booking from the list without reports:create", async () => {
    renderPage({
      user: { id: 1, email: "a@b.c", role: "employee", effective_permissions: [] },
    });
    await screen.findByText("VT-0007");
    fireEvent.click(screen.getByRole("button", { name: /VT-0007 ZV1 Zählerverteiler öffnen/ }));

    expect(screen.getByTestId("panel-material-list").getAttribute("data-can-edit")).toBe("false");
  });

  it("says so when nothing is planned yet", async () => {
    overviewMock.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText("Noch kein Verteiler geplant.")).toBeTruthy();
    expect(within(kpi("VERTEILER")).getByText("0")).toBeTruthy();
  });

  it("says the load failed rather than showing an empty workshop", async () => {
    overviewMock.mockRejectedValue(new Error("Bad Gateway"));
    renderPage();

    expect(await screen.findByText(/Die Verteiler konnten nicht geladen werden/)).toBeTruthy();
    expect(screen.getByText("Bad Gateway")).toBeTruthy();
    expect(screen.queryByText("Noch kein Verteiler geplant.")).toBeNull();
    expect(screen.getAllByText("–").length).toBe(4);
    expect(
      screen.getByText("Nicht geladen — die Zahlen oben zeigen nichts Aktuelles."),
    ).toBeTruthy();

    overviewMock.mockResolvedValue([ZV1, UV2]);
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect(await screen.findByText("VT-0007")).toBeTruthy();
  });

  it("says it is loading rather than claiming an empty workshop", () => {
    overviewMock.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(document.querySelector(".verteiler-empty")?.textContent).toBe("Lädt…");
  });

  it("does not call an empty panel complete", async () => {
    overviewMock.mockResolvedValue([
      { ...UV2, planned_total: 0, scanned_total: 0, open_lines: 0 },
    ]);
    renderPage();
    await screen.findByText("VT-0002");
    expect(screen.queryByText("vollständig")).toBeNull();
    expect(screen.getByText("keine Positionen")).toBeTruthy();
  });

  it("speaks English when the UI does", async () => {
    renderPage({ language: "en" });
    await screen.findByText("VT-0007");
    expect(screen.getByText("Panels")).toBeTruthy();
    expect(screen.getByText("5 open")).toBeTruthy();
    expect(screen.getByText("complete")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Open VT-0007 ZV1 Zählerverteiler/ })).toBeTruthy();
  });
});
