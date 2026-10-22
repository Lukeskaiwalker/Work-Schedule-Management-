/**
 * "Neuer Verteiler" with an optional cabinet (docs/PANEL_ENCLOSURE.md §11):
 * the default stays a board of plain rows; choosing a Hager univers Z
 * cabinet hands its code over so the board starts with the cabinet and no
 * rows (rail rows come lazily as the rails fill, D15).
 * Invented data only — the repo is public.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { NewPanelDialog } from "../components/schaltplan/NewPanelDialog";

const CABINETS = [
  { height: 1100, options: [{ code: "ZB32S", label: "ZB32S · 2 Felder · 1100 × 550 × 205 mm · IP44 · Aufputz" }, { code: "ZB33S", label: "ZB33S · 3 Felder · 1100 × 800 × 205 mm · IP44 · Aufputz" }] },
  { height: 1400, options: [{ code: "ZB52S", label: "ZB52S · 2 Felder · 1400 × 550 × 205 mm · IP44 · Aufputz" }] },
];

function renderDialog(cabinets = CABINETS) {
  const onCreate = vi.fn();
  render(
    <NewPanelDialog
      customerName="Schulze"
      projectLabel={null}
      existing={[]}
      busy={false}
      cabinets={cabinets}
      onCancel={vi.fn()}
      onCreate={onCreate}
    />,
  );
  fireEvent.change(screen.getByPlaceholderText("Unterverteiler Werkstatt"), { target: { value: "Unterverteiler Keller" } });
  return onCreate;
}

describe("NewPanelDialog — cabinet", () => {
  it("defaults to no cabinet", () => {
    const onCreate = renderDialog();
    const select = screen.getByRole("combobox", { name: "Schrank" });
    expect(select).toHaveValue("");
    expect(within(select).getByRole("option", { name: "ohne Schrank (nur Hutschienen)" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Verteiler anlegen" }));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ name: "Unterverteiler Keller", enclosure_code: null }));
  });

  it("groups the cabinets by height and hands the chosen code over", () => {
    const onCreate = renderDialog();
    const select = screen.getByRole("combobox", { name: "Schrank" });
    expect(within(select).getAllByRole("group").map((group) => group.getAttribute("label"))).toEqual(["1100 mm hoch", "1400 mm hoch"]);
    fireEvent.change(select, { target: { value: "ZB33S" } });
    fireEvent.click(screen.getByRole("button", { name: "Verteiler anlegen" }));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ enclosure_code: "ZB33S" }));
  });

  it("has no cabinet choice while the catalogue is not there", () => {
    const onCreate = renderDialog([]);
    expect(screen.queryByRole("combobox", { name: "Schrank" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Verteiler anlegen" }));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ enclosure_code: null }));
  });
});
