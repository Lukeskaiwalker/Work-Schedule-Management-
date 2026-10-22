/**
 * The Werkstatt "Verteiler" overview names the parts that came out of a cabinet
 * module and still have to go back on the shelf (docs/PANEL_ENCLOSURE.md §6):
 * "{n} × ins Lager offen". Returns are not picks, so the chip sits beside the
 * picking chip and never changes it; a board without open returns shows none.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { WerkstattVerteilerPage, returnsOpenChip } from "../pages/werkstatt/WerkstattVerteilerPage";
import type { PanelMaterialSummary } from "../types/schaltplan";

vi.mock("../utils/schaltplanApi", () => ({
  getPanelMaterialOverview: vi.fn(),
}));

vi.mock("../components/schaltplan/PanelMaterialList", () => ({
  PanelMaterialList: () => <div data-testid="panel-material-list" />,
}));

import { getPanelMaterialOverview } from "../utils/schaltplanApi";

const overviewMock = vi.mocked(getPanelMaterialOverview);

function summary(id: number, number: string, returnsOpen: number | undefined): PanelMaterialSummary {
  const row = {
    panel: {
      id,
      panel_number: number,
      designation: `ZS${id}`,
      name: "Zählerschrank Beispiel",
      panel_type: "meter",
      status: "draft",
      customer_id: 3,
      customer_name: "Familie Beispiel",
      project_id: null,
      project_number: null,
      project_name: null,
      updated_at: "2026-10-21T08:00:00",
    },
    planned_total: 6,
    scanned_total: 6,
    open_lines: 0,
    last_scanned_at: null,
  } as PanelMaterialSummary;
  return returnsOpen === undefined ? row : ({ ...row, returns_open: returnsOpen } as PanelMaterialSummary);
}

function renderPage(language: "de" | "en" = "de") {
  const context = makeAppContextStub({
    overrides: {
      mainView: "werkstatt",
      werkstattTab: "verteiler",
      language,
      token: "t",
      user: { id: 1, email: "a@b.c", role: "admin", effective_permissions: ["reports:create"] },
    },
  });
  return render(
    <AppContext.Provider value={context as never}>
      <WerkstattVerteilerPage />
    </AppContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("open returns on the Verteiler overview", () => {
  it("shows the chip only on boards with parts still to book back", async () => {
    overviewMock.mockResolvedValue([summary(1, "VT-0101", 2), summary(2, "VT-0102", 0), summary(3, "VT-0103", undefined)]);
    renderPage();

    const withReturns = (await screen.findByText("VT-0101")).closest("li") as HTMLElement;
    expect(within(withReturns).getByText("2 × ins Lager offen")).toBeTruthy();
    // The picking chip is untouched: returns are not picks.
    expect(within(withReturns).getByText("vollständig")).toBeTruthy();

    for (const number of ["VT-0102", "VT-0103"]) {
      const row = screen.getByText(number).closest("li") as HTMLElement;
      expect(within(row).queryByText(/ins Lager offen/)).toBeNull();
    }
  });

  it("words the chip in both languages and stays silent without returns", () => {
    expect(returnsOpenChip(summary(1, "VT-0101", 3), true)).toBe("3 × ins Lager offen");
    expect(returnsOpenChip(summary(1, "VT-0101", 1), false)).toBe("1 × to return to stock");
    expect(returnsOpenChip(summary(1, "VT-0101", 0), true)).toBeNull();
    expect(returnsOpenChip(summary(1, "VT-0101", undefined), true)).toBeNull();
  });
});
