/**
 * The Daten tab on a board with a cabinet (docs/PANEL_ENCLOSURE.md §2.1,
 * D7): the meters live on the cabinet's meter places, so the old free-text
 * "Zählernummer" is not offered there — a second place to type a meter
 * number is a place for the two to disagree. The cabinet's meters are
 * listed read-only, with where to change them.
 * Invented numbers only — the repo is public.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { PanelDataTab } from "../components/schaltplan/PanelDataTab";
import { emptyDocument } from "../utils/schaltplanDevices";
import type { EnclosureModule } from "../types/panelEnclosure";
import type { PanelDocument, PanelPlan } from "../types/schaltplan";

const PANEL = { id: 7, designation: "UV1", name: "Unterverteiler Keller", location: null, panel_type: "sub", fed_from_panel_id: null, notes: null } as unknown as PanelPlan;

const mod = (id: string, field: number, meters: EnclosureModule["meters"]): EnclosureModule => ({
  id, code: "ZH3EL22", field, unit: 0, label: "", rails: {}, fittings: null, removed_fittings: [], meters,
});

function renderTab(document: PanelDocument) {
  render(
    <PanelDataTab
      panel={PANEL}
      document={document}
      panels={[]}
      readOnly={false}
      canEdit
      onPatchSupply={vi.fn()}
      onSaveMeta={vi.fn()}
      onDelete={vi.fn()}
    />,
  );
}

describe("PanelDataTab — meters", () => {
  it("lists the cabinet's meters instead of the free-text field", () => {
    const document: PanelDocument = {
      ...emptyDocument({ enclosureCode: "ZB33S" }),
      supply: { ...emptyDocument().supply, meter_number: "ALT-0001" },
      enclosure: {
        code: "ZB33S",
        modules: [
          mod("m2", 1, [{ place: 0, number: "", label: "" }]),
          mod("m1", 0, [{ place: 1, number: "1EBZ0100000008", label: "WE 2" }, { place: 0, number: "1EBZ0100000007", label: "WE 1" }]),
        ],
      },
    };
    renderTab(document);
    expect(screen.queryByLabelText("Zählernummer")).toBeNull();
    expect(
      screen.getByText("Zähler im Schrank: 1EBZ0100000007 (WE 1), 1EBZ0100000008 (WE 2), ohne Nummer — im Tab Schrank bearbeiten."),
    ).toBeInTheDocument();
  });

  it("says so when the cabinet has no meter", () => {
    renderTab(emptyDocument({ enclosureCode: "ZB33S" }));
    expect(screen.getByText("Zähler im Schrank: keine — im Tab Schrank bearbeiten.")).toBeInTheDocument();
  });

  it("keeps the free-text field on a board without a cabinet", () => {
    renderTab(emptyDocument());
    expect(screen.getByLabelText("Zählernummer")).toBeInTheDocument();
    expect(screen.queryByText(/^Zähler im Schrank:/)).toBeNull();
  });
});
