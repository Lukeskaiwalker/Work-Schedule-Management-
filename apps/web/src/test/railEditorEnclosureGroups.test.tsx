/**
 * The Aufbau tab on a board with a cabinet (docs/PANEL_ENCLOSURE.md §11):
 * rows are grouped by the module whose rail they sit on, in rail order,
 * and rows outside the cabinet come last under "Nicht im Schrank". A row
 * on a cabinet rail is that rail — its width is the rail's PLE and it
 * cannot be deleted from here (the module owns it), so the slot input and
 * × are not offered. Rows outside the cabinet keep both.
 *
 * Round 2 (docs/PANEL_ENCLOSURE_R2.md §9): every module is listed and every
 * rail too — an empty rail is one plain line with "+ Gerät", a cover or an
 * unknown code says why it has none. Empty lines are no region and have no
 * textbox, so the role counts above stay what they were.
 * Invented boards only — the repo is public.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { RailEditor, RailRow } from "../components/schaltplan/RailEditor";
import type { EnclosureModule } from "../types/panelEnclosure";
import type { PanelDocument } from "../types/schaltplan";
import { AUFBAU_INDEX, mod as aufbauModule, OWNER_GROUP_TITLES, ownerBoard } from "./enclosureAufbauBoards";
import { boardDocument, FIXTURE_INDEX } from "./enclosureFixtureBoards";
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

type EditorOptions = Pick<Parameters<typeof RailEditor>[0], "findings" | "findingActions"> & { index?: typeof INDEX; readOnly?: boolean };

function renderEditor(document: PanelDocument, withIndex = true, options: EditorOptions = {}) {
  const props = {
    document,
    index: withIndex ? options.index ?? INDEX : null,
    findings: options.findings,
    findingActions: options.findingActions,
    selectedDeviceId: null,
    readOnly: options.readOnly ?? false,
    onSelectDevice: vi.fn(),
    onAddDevice: vi.fn(),
    onAddRow: vi.fn(),
    onAddRowFromTemplate: vi.fn(),
    onRemoveRow: vi.fn(),
    onRenameRow: vi.fn(),
    onChangeSlots: vi.fn(),
    onAddDeviceToRail: vi.fn(),
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

describe("RailEditor — every module and every rail (round 2, §9)", () => {
  const VT_REGION = "Feld 3 · ZU37VT5APZ2 Modul ZU37VT5APZ2";

  it("shows the owner's empty ZU37VT5APZ2 with six empty rails, „+ Gerät“ on each one not reserved for terminals", () => {
    renderEditor(ownerBoard(), true, { index: AUFBAU_INDEX });
    expect(groupTitles()).toEqual(OWNER_GROUP_TITLES);
    const field = screen.getByRole("region", { name: VT_REGION });
    expect(within(field).getAllByRole("button", { name: /^Gerät auf F3 · .+ hinzufügen$/ }).map((button) => button.getAttribute("aria-label"))).toEqual([
      "Gerät auf F3 · Verteiler 3 hinzufügen",
      "Gerät auf F3 · Verteiler 4 hinzufügen",
      "Gerät auf F3 · Verteiler 5 hinzufügen",
      "Gerät auf F3 · APZ hinzufügen",
    ]);
    expect(within(field).getAllByText("leer · 12 PLE")).toHaveLength(3);
    expect(within(field).getByText("leer · 6 PLE")).toBeInTheDocument();
    expect(within(field).getAllByText("für Reihenklemmen reserviert · noch keine")).toHaveLength(2);
    expect(within(field).getByText("F3 · Verteiler 1")).toBeInTheDocument();
    // Plain text, not a row: nothing to rename, no slots, nothing to remove.
    expect(within(field).queryByRole("textbox")).toBeNull();
    expect(within(field).queryByRole("spinbutton")).toBeNull();
    expect(within(field).queryByRole("button", { name: /entfernen$/ })).toBeNull();
  });

  it("hands the rail to onAddDeviceToRail with the label the new row will get", () => {
    const props = renderEditor(ownerBoard(), true, { index: AUFBAU_INDEX });
    fireEvent.click(screen.getByRole("button", { name: "Gerät auf F3 · APZ hinzufügen" }));
    expect(props.onAddDeviceToRail).toHaveBeenCalledWith({ moduleId: "m-vt", railKey: "apz", label: "F3 · APZ" });
    expect(props.onAddDevice).not.toHaveBeenCalled();
  });

  it("keeps rows and empty rails apart in one group, and the role counts as before", () => {
    renderEditor(ownerBoard(), true, { index: AUFBAU_INDEX });
    expect(screen.getAllByRole("region")).toHaveLength(4);
    expect(screen.getAllByRole("textbox")).toHaveLength(6);
    const ks = screen.getByRole("region", { name: "Feld 4 · ZU37KS Modul ZU37KS" });
    expect(rowNames(ks)).toEqual(["F4 · Verteiler 1", "F4 · Verteiler 2"]);
    expect(within(ks).getAllByRole("button", { name: /^Gerät auf F4 · Verteiler [3-7] hinzufügen$/ })).toHaveLength(5);
  });

  it("says „Keine Geräte erfasst.“ instead of „+ Gerät“ on a read-only board", () => {
    renderEditor(ownerBoard(), true, { index: AUFBAU_INDEX, readOnly: true });
    const field = screen.getByRole("region", { name: VT_REGION });
    expect(within(field).queryByRole("button")).toBeNull();
    expect(within(field).getAllByText("Keine Geräte erfasst.")).toHaveLength(4);
    expect(within(field).getAllByText("für Reihenklemmen reserviert · noch keine")).toHaveLength(2);
  });

  it("names a cover and an unknown code instead of hiding them", () => {
    const doc = board([row("lost", [dev("mcb", { id: "b1" })], "Reihe Altbestand")], {
      code: "ZB33S",
      modules: [aufbauModule("m-cover", "ZU62A", 0), aufbauModule("m-x", "ZX99Q", 1, { r1: "lost" })],
    });
    renderEditor(doc);
    expect(groupTitles()).toEqual(["Feld 1 · ZU62A Modul ZU62A", "Feld 2 · ZX99Q", "Nicht im Schrank"]);
    expect(within(screen.getByRole("region", { name: "Feld 1 · ZU62A Modul ZU62A" })).getByText("Keine Hutschiene")).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Feld 2 · ZX99Q" })).getByText("Modulcode unbekannt — Reihen unter „Nicht im Schrank“"),
    ).toBeInTheDocument();
    expect(rowNames(screen.getByRole("region", { name: "Nicht im Schrank" }))).toEqual(["Reihe Altbestand"]);
  });

  it("offers no „+ Gerät“ on an empty rail when the page wires no rail add", () => {
    render(
      <RailEditor
        document={ownerBoard()}
        index={AUFBAU_INDEX}
        selectedDeviceId={null}
        readOnly={false}
        onSelectDevice={vi.fn()}
        onAddDevice={vi.fn()}
        onAddRow={vi.fn()}
        onAddRowFromTemplate={vi.fn()}
        onRemoveRow={vi.fn()}
        onRenameRow={vi.fn()}
        onChangeSlots={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Gerät auf / })).toBeNull();
    expect(screen.getAllByText("leer · 12 PLE").length).toBeGreaterThan(0);
  });
});

describe("RailEditor — rails reserved for WAGO terminals (round 2, §9, W4b)", () => {
  const KS_REGION = "Feld 4 · ZU37KS Modul ZU37KS";
  const BANNER = "Diese Hutschiene ist für Reihenklemmen reserviert — Geräte tiefer setzen.";
  /** The row section a rail name's textbox sits in. */
  const rowSection = (name: string) => screen.getByDisplayValue(name).closest("section") as HTMLElement;

  it("keeps a reserved row's devices and inspector, with the banner and without „+ Gerät“", () => {
    const props = renderEditor(ownerBoard(), true, { index: AUFBAU_INDEX });
    for (const name of ["F4 · Verteiler 1", "F4 · Verteiler 2"]) {
      const section = rowSection(name);
      expect(within(section).getByRole("note")).toHaveTextContent(BANNER);
      expect(within(section).queryByRole("button", { name: /^\+ ?Gerät$/ })).toBeNull();
    }
    fireEvent.click(screen.getByTitle("FI-Schutzschalter (RCD) — ohne Bezeichnung"));
    expect(props.onSelectDevice).toHaveBeenCalledWith("f1");
    // A row on a rail below the terminal rails keeps its tile.
    const outside = screen.getByRole("region", { name: "Feld 2 · ZH3EH16 Modul ZH3EH16" });
    expect(within(outside).getAllByRole("button", { name: /^\+ ?Gerät$/ }).length).toBeGreaterThan(0);
    expect(within(screen.getByRole("region", { name: KS_REGION })).queryByRole("button", { name: /^\+ ?Gerät$/ })).toBeNull();
  });

  it("shows the finding's own sentence and runs its suggestion from the banner", () => {
    const run = vi.fn();
    const message = "F4 · Verteiler 1: Hutschiene ist für Reihenklemmen reserviert — 2 Gerät(e) tiefer setzen. Vorschlag: Reihe auf F4 · Verteiler 3 umhängen.";
    renderEditor(ownerBoard(), true, {
      index: AUFBAU_INDEX,
      findings: [{ rule: "encl.terminal_rail_devices", level: "warn", scope: "ks-r1", message }],
      findingActions: new Map([["encl.terminal_rail_devices|ks-r1", { label: "Vorschlag ausführen", run }]]),
    });
    const first = rowSection("F4 · Verteiler 1");
    expect(within(first).getByRole("note")).toHaveTextContent(message);
    fireEvent.click(within(first).getByRole("button", { name: "Vorschlag ausführen" }));
    expect(run).toHaveBeenCalledTimes(1);
    // The second row has neither a finding of its own nor an action: the plain banner.
    const second = rowSection("F4 · Verteiler 2");
    expect(within(second).getByRole("note")).toHaveTextContent(BANNER);
    expect(within(second).queryByRole("button", { name: "Vorschlag ausführen" })).toBeNull();
  });

  it("offers no suggestion on a read-only board", () => {
    renderEditor(ownerBoard(), true, {
      index: AUFBAU_INDEX,
      readOnly: true,
      findingActions: new Map([["encl.terminal_rail_devices|ks-r1", { label: "Vorschlag ausführen", run: vi.fn() }]]),
    });
    expect(screen.queryByRole("button", { name: "Vorschlag ausführen" })).toBeNull();
    expect(within(rowSection("F4 · Verteiler 1")).getByRole("note")).toHaveTextContent(BANNER);
  });

  it("names the strips on an empty reserved rail, and no „+ Gerät“ there", () => {
    renderEditor(boardDocument("terminals_zb34s"), true, { index: FIXTURE_INDEX });
    expect(screen.getByText("für Reihenklemmen reserviert · X7, X8, X10")).toBeInTheDocument();
    expect(screen.getByText("für Reihenklemmen reserviert · X9, X11, X12")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Gerät auf F4 · Verteiler [12] hinzufügen$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Gerät auf F3 · Verteiler [12] hinzufügen$/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Gerät auf F3 · Verteiler 3 hinzufügen" })).toBeInTheDocument();
  });

  it("asks nobody to move devices off a reserved row that has none — only placeholders or nothing", () => {
    const doc = board(
      [row("kept", [], "Reserve oben"), row("ph", [dev("terminal", { id: "p1" })], "F1 · Verteiler 2")],
      { code: "ZB32S", modules: [mod("m-ks", "ZU37KS", 0, { r1: "kept", r2: "ph" })] },
    );
    renderEditor(doc);
    for (const name of ["Reserve oben", "F1 · Verteiler 2"]) {
      const section = rowSection(name);
      expect(within(section).getByRole("note")).toHaveTextContent("für Reihenklemmen reserviert · noch keine");
      expect(within(section).queryByText(/Geräte tiefer setzen/)).toBeNull();
      expect(within(section).queryByRole("button", { name: /^\+ ?Gerät$/ })).toBeNull();
    }
  });

  it("keeps the flat list without reservations before the catalogue is there", () => {
    renderEditor(ownerBoard(), false);
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByText(/für Reihenklemmen reserviert/)).toBeNull();
  });
});
