/**
 * The "Klemmen" tab: the derived terminal list per strip (X1, X2 …), the
 * Stückliste, the bulk switches, and the rail tile's marker. The derivation
 * itself is pinned in `schaltplanTerminals.test.ts`; this proves the tab
 * shows it — one card per Leiste or Block with the marker texts as the PDF
 * prints them — that the two bulk buttons fire the right flag and vanish
 * read-only, and that a part whose width is unconfirmed is said out loud.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { RailEditor } from "../components/schaltplan/RailEditor";
import { TerminalList } from "../components/schaltplan/TerminalList";
import { emptyDocument, makeDevice } from "../utils/schaltplanDevices";
import type { PanelDocument } from "../types/schaltplan";

const noop = () => undefined;

function terminalBoard(): PanelDocument {
  return {
    ...emptyDocument(),
    rows: [
      {
        id: "r1",
        label: "Reihe 1",
        slots: 12,
        devices: [
          makeDevice("rcd", { id: "f1", designation: "F1", residual_current: "30 mA", rcd_type: "A" }),
          makeDevice("mcb", { id: "a", designation: "F1.1", circuit: "1", label: "Licht Flur", rating: "B16", terminal_block: true }),
          makeDevice("rcd", { id: "f2", designation: "F2" }),
          makeDevice("mcb", { id: "b", designation: "F2.1", circuit: "2", rating: "B16", terminal_block: true }),
          makeDevice("mcb", { id: "c", designation: "F2.2", circuit: "3" }),
        ],
      },
    ],
  };
}

function plainBoard(): PanelDocument {
  return {
    ...emptyDocument(),
    rows: [
      {
        id: "r1",
        label: "Reihe 1",
        slots: 12,
        devices: [makeDevice("rcd", { id: "f1", designation: "F1" }), makeDevice("mcb", { id: "a", designation: "F1.1" })],
      },
    ],
  };
}

function renderList(overrides: Partial<Parameters<typeof TerminalList>[0]> = {}) {
  const props = {
    document: terminalBoard(),
    readOnly: false,
    onSetAllTerminals: vi.fn(),
    onPrint: vi.fn(),
    pdfHref: "/api/schaltplan/panels/7/pdf?terminals_only=true",
    printing: false,
    ...overrides,
  };
  const view = render(<TerminalList {...props} />);
  return { ...props, container: view.container };
}

describe("TerminalList", () => {
  it("shows one card per strip with the derived sequence", () => {
    renderList();
    expect(screen.getByText("6 Klemmen · 2 Klemmenleisten (X1–X2) · 2 FI-Gruppen · 2 von 3 Abgängen")).toBeInTheDocument();
    const first = screen.getByRole("region", { name: "X1 · FI F1 · Reihe 1" });
    expect(within(first).getByText("30 mA / Typ A")).toBeInTheDocument();
    expect(within(first).getByText("Standard")).toBeInTheDocument();
    // The phone cards repeat the rows, so read the table alone.
    const table = within(first).getByRole("table");
    const parts = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell")[1].textContent);
    expect(parts).toEqual(["WAGO 2016-7714", "WAGO 2003-7641", "WAGO 2009-305"]);
    expect(within(table).getByText(/F1\.1 · Licht Flur · Nr\. 1/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "X2 · FI F2 · Reihe 1" })).toBeInTheDocument();
  });

  it("sums the Stückliste over the board", () => {
    renderList();
    const bom = screen.getByRole("region", { name: "Stückliste Reihenklemmen" });
    const rows = within(bom)
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));
    expect(rows.map((cells) => [cells[0], cells[2]])).toEqual([
      ["WAGO 2003-7641", "2"],
      ["WAGO 2009-305", "2"],
      ["WAGO 2016-7714", "2"],
    ]);
    expect(within(bom).getByText("6 Klemmen · 3 Artikel")).toBeInTheDocument();
  });

  it("lists the marker text per terminal as the print produces it — overrides applied, nothing filled in", () => {
    const document: PanelDocument = { ...terminalBoard(), terminal_labels: { "a:1": "7" } };
    renderList({ document });
    const first = screen.getByRole("region", { name: "X1 · FI F1 · Reihe 1" });
    const table = within(first).getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Pos.",
      "Klemme",
      "Beschriftung",
      "für",
    ]);
    const rows = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));
    expect(rows).toEqual([
      ["1", "WAGO 2016-7714", "X1", "FI F1 · 30 mA / Typ A"],
      ["2", "WAGO 2003-7641", "7", "F1.1 · Licht Flur · Nr. 1"],
      ["3", "WAGO 2009-305", "—", "—"],
    ]);
    // The phone card says the same thing.
    const cards = Array.from(first.querySelectorAll(".sp-terminal-row b")).map((node) => node.textContent);
    expect(cards).toEqual(["X1 · WAGO 2016-7714", "7 · WAGO 2003-7641", "— · WAGO 2009-305"]);
    // The second FI's Leiste counts its own X: 2.1, not 1.2.
    const second = screen.getByRole("region", { name: "X2 · FI F2 · Reihe 1" });
    expect(within(within(second).getByRole("table")).getByText("2.1")).toBeInTheDocument();
  });

  it("shows a blanked marker as — rather than its default", () => {
    const document: PanelDocument = { ...terminalBoard(), terminal_labels: { "a:1": "" } };
    renderList({ document });
    const first = screen.getByRole("region", { name: "X1 · FI F1 · Reihe 1" });
    const table = within(first).getByRole("table");
    const cells = within(within(table).getAllByRole("row")[2]).getAllByRole("cell").map((cell) => cell.textContent);
    expect(cells).toEqual(["2", "WAGO 2003-7641", "—", "F1.1 · Licht Flur · Nr. 1"]);
  });

  it("offers the bulk switches and reports the flag", () => {
    const { onSetAllTerminals } = renderList();
    fireEvent.click(screen.getByRole("button", { name: "Alle Abgänge mit Reihenklemme" }));
    expect(onSetAllTerminals).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Alle ohne" }));
    expect(onSetAllTerminals).toHaveBeenLastCalledWith(false);
  });

  it("hides the bulk switches read-only but keeps print and PDF", () => {
    renderList({ readOnly: true });
    expect(screen.queryByRole("button", { name: "Alle Abgänge mit Reihenklemme" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Alle ohne" })).toBeNull();
    expect(screen.getByRole("button", { name: "Klemmen-Etiketten drucken" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "Klemmenliste als PDF" })).toHaveAttribute(
      "href",
      "/api/schaltplan/panels/7/pdf?terminals_only=true",
    );
  });

  it("fires onPrint and disables it while printing", () => {
    const { onPrint } = renderList();
    fireEvent.click(screen.getByRole("button", { name: "Klemmen-Etiketten drucken" }));
    expect(onPrint).toHaveBeenCalledTimes(1);
  });

  it("shows the empty state with the bulk switch when nothing has a terminal", () => {
    renderList({ document: plainBoard() });
    expect(screen.getByText(/Noch keine Reihenklemmen/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Alle Abgänge mit Reihenklemme" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Alle ohne" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Klemmen-Etiketten drucken" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: "Klemmenliste als PDF" })).toBeNull();
  });

  it("shows a three-phase outgoing above 16 A as its own Block card with its PE terminal and no width warning", () => {
    const document: PanelDocument = {
      ...emptyDocument(),
      rows: [
        {
          id: "r1",
          label: "Reihe 1",
          slots: 12,
          devices: [
            makeDevice("rcd", { id: "f1", designation: "F1" }),
            makeDevice("mcb", { id: "a", designation: "F1.1", circuit: "1", rating: "B16", terminal_block: true }),
            makeDevice("wallbox", { id: "w", designation: "F1.2", circuit: "2", label: "Wallbox", rating: "B32", terminal_block: true }),
          ],
        },
      ],
    };
    renderList({ document });
    expect(screen.getByText("8 Klemmen · 2 Klemmenleisten (X1–X2) · 1 FI-Gruppe · 2 von 2 Abgängen")).toBeInTheDocument();
    const block = screen.getByRole("region", { name: "X2 · Block F1.2 Wallbox" });
    expect(within(block).getByText("Block · 60 mm")).toBeInTheDocument();
    expect(within(block).getByText("Etikett: Wallbox · X2")).toBeInTheDocument();
    const table = within(block).getByRole("table");
    const rows = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));
    expect(rows).toEqual([
      ["1", "WAGO 2016-7604", "N", "FI F1 · 30 mA / Typ A"],
      ["2", "WAGO 2016-7601", "L1", "F1.2 · Wallbox · Nr. 2"],
      ["3", "WAGO 2016-7601", "L2", "F1.2 · Wallbox · Nr. 2"],
      ["4", "WAGO 2016-7601", "L3", "F1.2 · Wallbox · Nr. 2"],
      ["5", "WAGO 2016-7607", "PE", "F1.2 · Wallbox · Nr. 2"],
    ]);
    expect(screen.queryByText(/Breite nicht bestätigt/)).not.toBeInTheDocument();
    const bom = screen.getByRole("region", { name: "Stückliste Reihenklemmen" });
    expect(within(bom).getByText(/2016-7607/)).toBeInTheDocument();
    expect(within(bom).queryByText("nicht bestätigt")).not.toBeInTheDocument();
  });

  it("flags a group without an FI", () => {
    const document: PanelDocument = {
      ...emptyDocument(),
      rows: [
        {
          id: "r1",
          label: "Reihe 1",
          slots: 12,
          devices: [
            makeDevice("hauptschalter", { id: "q1", designation: "Q1" }),
            makeDevice("mcb", { id: "a", designation: "F0.1", circuit: "1", terminal_block: true }),
          ],
        },
      ],
    };
    renderList({ document });
    expect(screen.getByRole("region", { name: "X1 · HS Q1 · Reihe 1" })).toBeInTheDocument();
    expect(screen.getByText("ohne FI")).toBeInTheDocument();
    // The info finding is shown here, on the tab — the page's Prüfen block only lists warnings.
    expect(
      screen.getByText("Gruppe Q1: Abgänge mit Reihenklemme ohne FI — Einspeiseklemme nicht abgeleitet"),
    ).toBeInTheDocument();
  });

  it("shows the pole-rounding hint next to the list", () => {
    const document: PanelDocument = {
      ...emptyDocument(),
      rows: [
        {
          id: "r1",
          label: "Reihe 1",
          slots: 12,
          devices: [
            makeDevice("rcd", { id: "f1", designation: "F1" }),
            makeDevice("mcb", { id: "a", designation: "F1.1", circuit: "1", poles: 2, terminal_block: true }),
          ],
        },
      ],
    };
    renderList({ document });
    expect(screen.getByText("F1.1: 2-polig — Klemme wie 1-polig abgeleitet")).toBeInTheDocument();
  });

  it("shows no hint list when the derivation assumed nothing", () => {
    renderList();
    expect(screen.queryByRole("list", { name: "Hinweise" })).toBeNull();
  });
});

describe("RailEditor — Reihenklemme marker", () => {
  it("marks a flagged tile and leaves the others alone", () => {
    render(
      <RailEditor
        document={terminalBoard()}
        selectedDeviceId={null}
        readOnly
        onSelectDevice={noop}
        onAddDevice={noop}
        onAddRow={noop}
        onAddRowFromTemplate={noop}
        onRemoveRow={noop}
        onRenameRow={noop}
        onChangeSlots={noop}
      />,
    );
    const marks = screen.getAllByRole("img", { name: "mit Reihenklemme" });
    expect(marks).toHaveLength(2);
    expect(marks[0].closest("button")?.textContent).toContain("F1.1");
    expect(marks[1].closest("button")?.textContent).toContain("F2.1");
  });
});
