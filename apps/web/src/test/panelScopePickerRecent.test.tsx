/**
 * "Zuletzt bearbeitet" in the Schaltplan scope picker: the recent panels
 * become the customer search's leading rows, worded as the page promises —
 * number and name, customer · project number, and how long ago — and a pick
 * hands the whole panel back, not just an id.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { PanelScopePicker, recentPanelHint, recentPanelItems } from "../components/schaltplan/PanelScopePicker";
import type { PanelPlanSummary } from "../types/schaltplan";

const NOW = new Date("2026-09-24T10:00:00Z");

function panel(overrides: Partial<PanelPlanSummary> = {}): PanelPlanSummary {
  return {
    id: 7,
    panel_number: "VT-0007",
    customer_id: 3,
    customer_name: "Schulze",
    project_id: 244,
    project_number: "381",
    project_name: "Neubau Schulze",
    name: "Unterverteiler Keller",
    designation: "UV1",
    panel_type: "sub",
    location: null,
    fed_from_panel_id: null,
    fed_from_designation: null,
    status: "draft",
    revision: 3,
    device_count: 4,
    circuit_count: 3,
    rcd_count: 1,
    used_slots: 6,
    total_slots: 12,
    row_count: 1,
    updated_at: "2026-09-24T08:00:00",
    updated_by_name: "Luca",
    ...overrides,
  };
}

describe("recentPanelHint", () => {
  it("climbs from minutes to hours to gestern to the short date", () => {
    expect(recentPanelHint("2026-09-24T09:59:40", NOW)).toBe("gerade eben");
    expect(recentPanelHint("2026-09-24T09:45:00", NOW)).toBe("vor 15 Min.");
    expect(recentPanelHint("2026-09-24T08:00:00", NOW)).toBe("vor 2 Std.");
    expect(recentPanelHint("2026-09-23T20:00:00", NOW)).toBe("gestern");
    expect(recentPanelHint("2026-09-20T12:00:00", NOW)).toMatch(/^20\.09\.?$/);
    expect(recentPanelHint("not a date", NOW)).toBe("");
  });
});

describe("recentPanelItems", () => {
  it("words the rows as the search box shows them", () => {
    expect(recentPanelItems([panel(), panel({ id: 9, panel_number: "VT-0009", customer_name: "Meyer", project_number: null })], NOW)).toEqual([
      {
        id: "7",
        primary: "VT-0007 · UV1 Unterverteiler Keller",
        secondary: "Schulze · 381",
        hint: "vor 2 Std.",
      },
      {
        id: "9",
        primary: "VT-0009 · UV1 Unterverteiler Keller",
        secondary: "Meyer",
        hint: "vor 2 Std.",
      },
    ]);
  });

  it("leaves the secondary line out when nothing is known", () => {
    expect(recentPanelItems([panel({ customer_name: null, project_number: null })], NOW)[0].secondary).toBeUndefined();
  });
});

describe("PanelScopePicker — Zuletzt bearbeitet", () => {
  function renderPicker(recent: PanelPlanSummary[] | undefined, onPickRecent = vi.fn()) {
    render(
      <PanelScopePicker
        language="de"
        customers={[]}
        projects={[]}
        customerId={null}
        projectId={null}
        onCustomerChange={vi.fn()}
        onProjectChange={vi.fn()}
        onRequestCreateCustomer={vi.fn()}
        panels={[]}
        activePanelId={null}
        onSelectPanel={vi.fn()}
        onNewPanel={vi.fn()}
        canEdit
        loading={false}
        recentPanels={recent}
        onPickRecent={onPickRecent}
      />,
    );
    // The project <select> is a combobox too; the customer search is the one with the placeholder.
    return { onPickRecent, input: screen.getByPlaceholderText("Kunde suchen…") };
  }

  it("offers the recent panels above the customers and hands the pick back whole", () => {
    const recent = panel();
    const { input, onPickRecent } = renderPicker([recent]);
    fireEvent.focus(input);

    expect(screen.getByText("Zuletzt bearbeitet")).toBeInTheDocument();
    expect(screen.getByText("Schulze · 381")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText("VT-0007 · UV1 Unterverteiler Keller"));

    expect(onPickRecent).toHaveBeenCalledWith(recent);
  });

  it("shows the plain customer search without recent panels", () => {
    const { input } = renderPicker(undefined);
    fireEvent.focus(input);
    expect(screen.queryByText("Zuletzt bearbeitet")).toBeNull();
  });
});
