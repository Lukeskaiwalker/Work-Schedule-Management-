/**
 * The Aufbau tab on a board with a cabinet (docs/PANEL_ENCLOSURE.md §11):
 * rows are grouped by the module whose rail they sit on, in rail order,
 * and rows outside the cabinet come last under "Nicht im Schrank". A row
 * on a cabinet rail is that rail — its width is the rail's PLE and it
 * cannot be deleted from here (the module owns it), so the slot input and
 * × are not offered. Rows outside the cabinet keep both.
 * Invented boards only — the repo is public.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { RailEditor, RailRow } from "../components/schaltplan/RailEditor";
import type { EnclosureModule } from "../types/panelEnclosure";
import type { PanelDocument } from "../types/schaltplan";
import { board, dev, INDEX, row } from "./enclosureTestCatalog";

const mod = (id: string, code: string, field: number, rails: Record<string, string>, label = ""): EnclosureModule => ({
  id, code, field, unit: 0, label, rails, fittings: null, removed_fittings: [], meters: [],
});

function cabinetBoard(): PanelDocument {
  return board(
    [
      row("old", [dev("mcb", { id: "x1", designation: "F9" })], "Reihe alt"),
      row("v2", [dev("mcb", { id: "b1", designation: "F2.1" })], "F2 · Verteiler 2"),
      row("v1", [dev("rcd", { id: "f1", designation: "F1" })], "F2 · Verteiler 1"),
      row("aar", [dev("hauptschalter", { id: "q1", designation: "Q1", supplied_by: { module: "m1", part: "hs" } })], "F1 · AAR 1"),
    ],
    { code: "ZB33S", modules: [mod("m2", "ZU37KS", 1, { r2: "v2", r1: "v1" }), mod("m1", "ZH3EH16", 0, { aar1: "aar" }, "Allgemein")] },
  );
}

function renderEditor(document: PanelDocument, withIndex = true) {
  const props = {
    document,
    index: withIndex ? INDEX : null,
    selectedDeviceId: null,
    readOnly: false,
    onSelectDevice: vi.fn(),
    onAddDevice: vi.fn(),
    onAddRow: vi.fn(),
    onAddRowFromTemplate: vi.fn(),
    onRemoveRow: vi.fn(),
    onRenameRow: vi.fn(),
    onChangeSlots: vi.fn(),
  };
  render(<RailEditor {...props} />);
  return props;
}

const groupTitles = () => screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"));
const rowNames = (region: HTMLElement) =>
  within(region)
    .getAllByRole("textbox")
    .map((input) => (input as HTMLInputElement).value);

describe("RailEditor — grouped by cabinet module", () => {
  it("groups the rows by module in field order, rails top to bottom, and the rest last", () => {
    renderEditor(cabinetBoard());
    expect(groupTitles()).toEqual(["Feld 1 · ZH3EH16 Allgemein", "Feld 2 · ZU37KS Modul ZU37KS", "Nicht im Schrank"]);
    expect(rowNames(screen.getByRole("region", { name: "Feld 2 · ZU37KS Modul ZU37KS" }))).toEqual(["F2 · Verteiler 1", "F2 · Verteiler 2"]);
    expect(rowNames(screen.getByRole("region", { name: "Nicht im Schrank" }))).toEqual(["Reihe alt"]);
  });

  it("shows a linked row's width but offers neither slot input nor remove", () => {
    renderEditor(cabinetBoard());
    const linked = screen.getByRole("region", { name: "Feld 2 · ZU37KS Modul ZU37KS" });
    expect(within(linked).queryByRole("spinbutton")).toBeNull();
    expect(within(linked).queryByRole("button", { name: /entfernen$/ })).toBeNull();
    expect(within(linked).getAllByText("4 / 12 TE")).toHaveLength(1);

    const outside = screen.getByRole("region", { name: "Nicht im Schrank" });
    expect(within(outside).getByRole("spinbutton")).toBeInTheDocument();
    expect(within(outside).getByRole("button", { name: /entfernen$/ })).toBeInTheDocument();
  });

  it("keeps the flat list on a board without a cabinet, or before the catalogue is there", () => {
    renderEditor(cabinetBoard(), false);
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.getAllByRole("spinbutton")).toHaveLength(4);
  });

  it("calls a DIN-rail meter a Zwischenzähler on a cabinet board only (D7)", () => {
    const withMeter = (document: PanelDocument): PanelDocument => ({
      ...document,
      rows: document.rows.map((entry) =>
        entry.id === "old" ? { ...entry, devices: [...entry.devices, dev("meter", { id: "m9", designation: "P9" })] } : entry,
      ),
    });
    renderEditor(withMeter(cabinetBoard()));
    expect(screen.getByTitle("Zwischenzähler (Hutschiene) — ohne Bezeichnung")).toBeInTheDocument();
    expect(screen.queryByTitle(/^Zähler \/ eHZ/)).toBeNull();
  });

  it("keeps the plain meter name on a board without a cabinet", () => {
    const plain = { ...cabinetBoard(), enclosure: null };
    renderEditor({ ...plain, rows: [row("r1", [dev("meter", { id: "m9", designation: "P9" })], "Reihe 1")] }, false);
    expect(screen.getByTitle("Zähler / eHZ — ohne Bezeichnung")).toBeInTheDocument();
  });

  it("exports RailRow with a linked mode", () => {
    render(
      <RailRow
        row={row("v1", [dev("mcb", { id: "a" })], "F2 · Verteiler 1")}
        index={0}
        canRemove
        linked
        selectedDeviceId={null}
        readOnly={false}
        onSelectDevice={vi.fn()}
        onAddDevice={vi.fn()}
        onRemoveRow={vi.fn()}
        onRenameRow={vi.fn()}
        onChangeSlots={vi.fn()}
      />,
    );
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(screen.queryByRole("button", { name: /entfernen$/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Gerät$/ })).toBeInTheDocument();
  });
});
