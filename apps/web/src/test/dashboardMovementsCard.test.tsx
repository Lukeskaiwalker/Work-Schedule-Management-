/**
 * "Letzte Bewegungen" on the Werkstatt dashboard. Since 2026-10-10 every
 * consumable that is handed out is a `consumption` (owner: "any item that is
 * not inside the machine tab is a consumable … book it out of the
 * inventory"), so the "Entnahmen" chip must show them and "Rückgaben" must
 * show material carried back — or the two chips go quiet for most of what
 * the shelf hands out.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { DashboardMovementsCard } from "../components/werkstatt/dashboard/DashboardMovementsCard";
import type { WerkstattMovement } from "../types/werkstatt";

function movement(id: number, movement_type: WerkstattMovement["movement_type"], article_name: string, notes: string | null = null): WerkstattMovement {
  return {
    id,
    article_id: id,
    article_number: `SP-000${id}`,
    article_name,
    movement_type,
    quantity: 2,
    from_location_name: null,
    to_location_name: null,
    project_id: 12,
    project_number: "381",
    project_name: "Neubau Schulze",
    user_id: 1,
    user_display_name: "Max M.",
    assignee_user_id: 1,
    assignee_display_name: "Max M.",
    expected_return_at: null,
    notes,
    created_at: "2026-10-10T08:00:00Z",
  };
}

const MOVEMENTS = [
  movement(1, "consumption", "Kabelbinder", "Regal-Station Werkstatt — Verbrauch für 381"),
  movement(2, "consumption", "Klemme 2016", "Regal-Station Werkstatt — Verteiler VT-0007"),
  movement(3, "consumption_undo", "Verdrahtungskanal"),
  movement(4, "checkout", "Bohrhammer"),
  movement(5, "intake", "Aderendhülsen"),
];

function titles(): string[] {
  return within(screen.getByRole("list")).getAllByRole("listitem").map((row) => row.textContent ?? "");
}

describe("DashboardMovementsCard", () => {
  it("counts consumption as Entnahme and taking material back as Rückgabe", () => {
    render(<DashboardMovementsCard movements={MOVEMENTS} phase={null} language="de" now={new Date("2026-10-10T09:00:00Z")} />);

    fireEvent.click(screen.getByRole("tab", { name: "Entnahmen" }));
    const out = titles();
    expect(out).toHaveLength(3);
    expect(out.join(" ")).toContain("Kabelbinder");
    expect(out.join(" ")).toContain("Bohrhammer");

    fireEvent.click(screen.getByRole("tab", { name: "Rückgaben" }));
    expect(titles()).toHaveLength(1);
    expect(titles()[0]).toContain("Verdrahtungskanal");
  });

  it("names the board a consumption went into", () => {
    render(<DashboardMovementsCard movements={MOVEMENTS} phase={null} language="de" now={new Date("2026-10-10T09:00:00Z")} />);
    const board = titles().find((row) => row.includes("Klemme 2016")) ?? "";
    expect(board).toContain("Verbrauch · Verteiler VT-0007");
  });
});
