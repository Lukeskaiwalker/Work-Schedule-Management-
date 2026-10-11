/**
 * The machine's custody log names every ledger type rather than printing its
 * key. A consumption used to read "Verbrauch (Verteiler)", which was only ever
 * true for a board; now that every consumable dispensed at the rack, the desk
 * or the phone is a consumption, the word is plain "Verbrauch", and its undo is
 * "Verbrauch zurück" (it can be leftovers carried back, not only a Storno).
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { MaschineDetailPanel } from "../components/werkstatt/MaschineDetailPanel";
import type { Machine, MachineMovement } from "../types/werkstattMachines";

const MACHINE: Machine = {
  id: 5,
  unit_number: "M-0005",
  article_id: 40,
  article_name: "Kernbohrgerät DD 150",
  manufacturer: "Hilti",
  parent_unit_id: null,
  serial_number: "SN-123",
  status: "verfuegbar",
  current_location_id: null,
  current_location_name: null,
  holder_user_id: null,
  holder_name: null,
  booked_from: null,
  booked_until: null,
  is_overdue: false,
  inspection_required: false,
  inspection_interval_days: null,
  last_inspected_at: null,
  next_inspection_due_at: null,
  inspection_overdue: false,
  purchased_at: null,
  notes: null,
  is_archived: false,
  created_at: "2026-01-01T09:00:00Z",
  components: [],
};

function movement(id: number, movement_type: string): MachineMovement {
  return {
    id,
    movement_type,
    from_location_id: null,
    from_location_name: null,
    to_location_id: null,
    to_location_name: null,
    user_id: 1,
    user_name: "Luca Schmidt",
    assignee_user_id: null,
    assignee_name: null,
    expected_return_at: null,
    notes: null,
    created_at: "2026-10-09T10:00:00Z",
  };
}

const noop = () => undefined;

function renderPanel(history: MachineMovement[], language: "de" | "en" = "de") {
  return render(
    <MaschineDetailPanel
      machine={MACHINE}
      history={history}
      language={language}
      users={[]}
      locations={[]}
      canCreate={false}
      canEdit={false}
      busy={false}
      onBack={noop}
      onBook={noop}
      onEdit={noop}
      onAddAnother={noop}
      onReturn={noop}
      onInspect={noop}
      onPrintLabel={noop}
      grossPrintable
      grossHint={null}
      onQueueLabel={noop}
      onAddComponent={noop}
      onOpenComponent={noop}
    />,
  );
}

describe("MaschineDetailPanel — log labels", () => {
  it("calls a consumption Verbrauch and its undo Verbrauch zurück", () => {
    renderPanel([movement(1, "consumption"), movement(2, "consumption_undo")]);
    expect(screen.getByText("Verbrauch")).toBeInTheDocument();
    expect(screen.getByText("Verbrauch zurück")).toBeInTheDocument();
    expect(screen.queryByText("Verbrauch (Verteiler)")).toBeNull();
  });

  it("names them in English too", () => {
    renderPanel([movement(1, "consumption"), movement(2, "consumption_undo")], "en");
    expect(screen.getByText("Consumed")).toBeInTheDocument();
    expect(screen.getByText("Consumption returned")).toBeInTheDocument();
  });
});
