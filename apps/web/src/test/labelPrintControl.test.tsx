/**
 * The print sheet's round-4 parts (docs/PANEL_ENCLOSURE_R4.md §9.1–§9.2):
 * the §14a block strip as the last item of the Klemmen list — vertical
 * text, its own size, refused when a label cannot fit — and the
 * "Aderbeschriftung" mode, which prints every named terminal twice on the
 * board's own heat-shrink tube.
 */
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { LabelPrintDialog } from "../components/schaltplan/LabelPrintDialog";
import { boardTerminalsState } from "../hooks/useBoardTerminals";
import { defaultControlBlock } from "../utils/enclosureControlBlock";
import { emptyDocument, makeDevice } from "../utils/schaltplanDevices";
import type { ControlBlock } from "../types/panelEnclosure";
import type { PanelDocument } from "../types/schaltplan";

const CONTROL_ROW = "§14a-Klemmleiste (senkrecht beschriftet) drucken";

/** Two FIs on one rail, one terminal each: Leisten X1 and X2. */
function terminalRows(): PanelDocument["rows"] {
  return [
    {
      id: "r1",
      label: "Reihe 1",
      slots: 12,
      devices: [
        makeDevice("rcd", { id: "f1", designation: "F1" }),
        makeDevice("mcb", { id: "a", designation: "F1.1", circuit: "1", rating: "B16", terminal_block: true }),
        makeDevice("rcd", { id: "f2", designation: "F2" }),
        makeDevice("mcb", { id: "b", designation: "F2.1", circuit: "2", rating: "B16", terminal_block: true }),
      ],
    },
  ];
}

function withBlock(rows: PanelDocument["rows"], block: unknown): PanelDocument {
  return {
    ...emptyDocument(),
    rows,
    enclosure: { code: "ZB33S", modules: [], control_block: block },
  } as unknown as PanelDocument;
}

function labelled(labels: string[], overrides: Partial<ControlBlock> = {}): ControlBlock {
  return {
    ...defaultControlBlock(),
    terminals: labels.map((label, i) => ({ id: `t${i + 1}`, label, color: "braun" })),
    ...overrides,
  };
}

type Props = Parameters<typeof LabelPrintDialog>[0];

/**
 * The page passes its one derivation; here it is the rows' own (no cabinet
 * modules), so the sheet does not wait for a catalogue.
 */
function renderSheet(document: PanelDocument, overrides: Partial<Props> = {}) {
  const props: Props = {
    open: true,
    mode: "reihenklemmen",
    document,
    boardTerminals: boardTerminalsState({ ...document, enclosure: null }, null),
    initialRowIds: ["f1:leiste", "f2:leiste", "control:block"],
    busy: false,
    onPrint: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  const view = render(<LabelPrintDialog {...props} />);
  return { ...props, container: view.container };
}

function verticalTexts(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll("svg.sp-strip-svg--vertical text.sp-strip-text"));
}

describe("LabelPrintDialog — the §14a strip in the Klemmen list", () => {
  it("lists the block strip last, with its terminals, the word senkrecht and its length", () => {
    renderSheet(withBlock(terminalRows(), defaultControlBlock()));
    const boxes = within(screen.getByRole("list", { name: "Klemmenleisten" })).getAllByRole("checkbox");
    expect(boxes.map((box) => box.getAttribute("aria-label"))).toEqual([
      "X1 · FI F1 · Reihe 1 drucken",
      "X2 · FI F2 · Reihe 1 drucken",
      CONTROL_ROW,
    ]);
    const row = screen.getByRole("checkbox", { name: CONTROL_ROW }).closest("li") as HTMLElement;
    expect(within(row).getByText("6 Klemmen · senkrecht · 31,2 mm")).toBeInTheDocument();
  });

  it("previews the strip at 5 px/mm with every label rotated to read bottom → top", () => {
    const { container } = renderSheet(withBlock(terminalRows(), defaultControlBlock()));
    const svg = screen.getByRole("img", { name: /§14a-Klemmleiste.*UNSM, 60%, 30%, 0%, UStve, Stve/ });
    // 3 + 6 × 5,2 + 3 = 37,2 mm at 5 px/mm.
    expect(Number(svg.getAttribute("width"))).toBeCloseTo(186, 6);
    const texts = verticalTexts(container);
    expect(texts.map((node) => node.textContent)).toEqual(["UNSM", "60%", "30%", "0%", "UStve", "Stve"]);
    // 35 dots at 5 px/mm: 35 × 5 / 11,81 px; the first one centred on its 5,2 mm segment.
    expect(Number(texts[0].getAttribute("font-size"))).toBeCloseTo(14.82, 2);
    const x = (3 + 2.6) * 5;
    expect(Number(texts[0].getAttribute("x"))).toBeCloseTo(x, 6);
    expect(texts[0].getAttribute("transform")).toMatch(/^rotate\(-90 /);
    expect(screen.getByText("Schrift liest von unten nach oben — so einsetzen, dass „UNSM“ links steht.")).toBeInTheDocument();
    expect(screen.getByText("37,2 mm (3 + 31,2 + 3)")).toBeInTheDocument();
  });

  it("adds the strip to the summary with its own size", () => {
    renderSheet(withBlock(terminalRows(), defaultControlBlock()));
    // (3 + 17,2 + 3) × 2 + (3 + 31,2 + 3) = 83,6 mm; 4 Leiste markers + 6 §14a labels.
    expect(
      screen.getByText("3 Streifen · 10 Klemmen · 83,6 mm Material · Schriftgröße: 3,0 mm · §14a: 3,0 mm"),
    ).toBeInTheDocument();
  });

  it("ticks the strip with Alle and prints it with the Leisten", () => {
    const { onPrint } = renderSheet(withBlock(terminalRows(), defaultControlBlock()), { initialRowIds: [] });
    fireEvent.click(screen.getByRole("button", { name: "Alle" }));
    expect(screen.getByRole("checkbox", { name: CONTROL_ROW })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Drucken" }));
    expect(onPrint).toHaveBeenCalledWith(["f1:leiste", "f2:leiste", "control:block"], "wago-2009-110", {
      target: "reihenklemmen",
    });
  });

  it("keeps a blank terminal as an empty segment and counts it", () => {
    const { container } = renderSheet(withBlock(terminalRows(), labelled(["UNSM", "", "Stve"])), {
      initialRowIds: ["control:block"],
    });
    expect(verticalTexts(container).map((node) => node.textContent)).toEqual(["UNSM", "Stve"]);
    // Three segments, two cuts between them.
    expect(container.querySelectorAll("svg.sp-strip-svg--vertical line.sp-strip-cut")).toHaveLength(2);
    expect(screen.getByText("1 Streifen · 2 Klemmen · 21,6 mm Material · §14a: 3,0 mm · 1 ohne Beschriftung")).toBeInTheDocument();
  });

  it("disables a strip with a label too long for the terminal and never sends it", () => {
    const { onPrint, container } = renderSheet(withBlock(terminalRows(), labelled(["UNSM", "Steuerbox 12"])));
    const box = screen.getByRole("checkbox", { name: CONTROL_ROW });
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();
    const reason = "„Steuerbox 12“ ist zu lang für die Klemme — in der §14a-Klemmleiste kürzen.";
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(box).toHaveAccessibleDescription(reason);
    expect(verticalTexts(container)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Keine" }));
    fireEvent.click(screen.getByRole("button", { name: "Alle" }));
    expect(box).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Drucken" }));
    expect(onPrint).toHaveBeenCalledWith(["f1:leiste", "f2:leiste"], "wago-2009-110", { target: "reihenklemmen" });
  });

  it("names the too-long label on a board whose only strip is the block, and prints nothing", () => {
    const { onPrint } = renderSheet(withBlock([], labelled(["UNSM", "Steuerbox 12"])), { initialRowIds: [] });
    expect(screen.getByText("„Steuerbox 12“ ist zu lang für die Klemme — in der §14a-Klemmleiste kürzen.")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: CONTROL_ROW })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Drucken" })).toBeDisabled();
    expect(onPrint).not.toHaveBeenCalled();
  });

  it("prints a board that has only the block, without the empty-board text or a Leiste size", () => {
    const { onPrint } = renderSheet(withBlock([], defaultControlBlock()), { initialRowIds: ["control:block"] });
    expect(screen.queryByText(/Noch keine Reihenklemmen/)).toBeNull();
    expect(screen.getByText("1 Streifen · 6 Klemmen · 37,2 mm Material · §14a: 3,0 mm")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Drucken" }));
    expect(onPrint).toHaveBeenCalledWith(["control:block"], "wago-2009-110", { target: "reihenklemmen" });
  });

  it("has no strip for a removed block, and a tick left on it is not sent", () => {
    const { onPrint } = renderSheet(withBlock(terminalRows(), { ...defaultControlBlock(), off: true }));
    expect(screen.queryByRole("checkbox", { name: CONTROL_ROW })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Drucken" }));
    expect(onPrint).toHaveBeenCalledWith(["f1:leiste", "f2:leiste"], "wago-2009-110", { target: "reihenklemmen" });
  });

  it("previews the strip only while it is ticked", () => {
    const { container } = renderSheet(withBlock(terminalRows(), defaultControlBlock()));
    fireEvent.click(screen.getByRole("checkbox", { name: CONTROL_ROW }));
    expect(verticalTexts(container)).toHaveLength(0);
    expect(screen.queryByText(/Schrift liest von unten nach oben/)).toBeNull();
    expect(screen.getByText(/^2 Streifen · 4 Klemmen · 46,4 mm Material · Schriftgröße: 3,0 mm$/)).toBeInTheDocument();
  });
});

describe("LabelPrintDialog — Aderbeschriftung", () => {
  function renderWires(document: PanelDocument, overrides: Partial<Props> = {}) {
    return renderSheet(document, { mode: "adern", initialRowIds: ["control:wires"], ...overrides });
  }

  it("is titled for the wires, with the board's tube as its one material and no strip list", () => {
    renderWires(withBlock(terminalRows(), defaultControlBlock()));
    expect(screen.getByRole("dialog", { name: "Aderbeschriftung drucken" })).toBeInTheDocument();
    expect(screen.getByText("Schrumpfschlauch WAGO 211-502 (Ø 4,8 mm) einlegen — nicht den 11-mm-Streifen.")).toBeInTheDocument();
    const chips = within(screen.getByRole("radiogroup", { name: "Material" })).getAllByRole("radio");
    expect(chips.map((chip) => chip.textContent)).toEqual(["WAGO 211-502"]);
    expect(chips[0]).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("list", { name: "Klemmenleisten" })).toBeNull();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("previews every label twice on one tube and sums wires, sleeves and tube", () => {
    const { container } = renderWires(withBlock(terminalRows(), defaultControlBlock()));
    expect(screen.getByText("6 Adern · 12 Hülsen · 186 mm Schlauch · Schriftgröße: 4,1 mm")).toBeInTheDocument();
    const svg = screen.getByRole("img", { name: /^Streifen Aderbeschriftung, 186 mm/ });
    const texts = Array.from(svg.querySelectorAll("text.sp-strip-text")).map((node) => node.textContent);
    expect(texts).toEqual(["UNSM", "UNSM", "60%", "60%", "30%", "30%", "0%", "0%", "UStve", "UStve", "Stve", "Stve"]);
    // The band is the tube's 7,5 mm, not the 11 mm strip: 7,5 × 2,4 px + 2 × 6 px of room.
    expect(Number(svg.getAttribute("height"))).toBeCloseTo(7.5 * 2.4 + 12, 6);
    expect(container.querySelectorAll("svg.sp-strip-svg--vertical")).toHaveLength(0);
  });

  it("prints the wires on the board's tube with the adern target", () => {
    const { onPrint } = renderWires(withBlock(terminalRows(), defaultControlBlock()));
    fireEvent.click(screen.getByRole("button", { name: "Drucken" }));
    expect(onPrint).toHaveBeenCalledWith(["control:wires"], "wago-211-502", { target: "adern" });
  });

  it("follows a board that chose the 211-501", () => {
    const { onPrint } = renderWires(withBlock(terminalRows(), labelled(["UNSM", "", "Stve"], { label_material: "wago-211-501" })));
    expect(screen.getByText("Schrumpfschlauch WAGO 211-501 (Ø 3,2 mm) einlegen — nicht den 11-mm-Streifen.")).toBeInTheDocument();
    // 42 dots on the 5 mm tube (Python: wire_label_size).
    expect(screen.getByText("2 Adern · 4 Hülsen · 66 mm Schlauch · Schriftgröße: 3,6 mm")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Drucken" }));
    expect(onPrint).toHaveBeenCalledWith(["control:wires"], "wago-211-501", { target: "adern" });
  });

  it("refuses without a named terminal, a block, or with the block removed", () => {
    for (const block of [labelled(["", ""]), null, { ...defaultControlBlock(), off: true }]) {
      renderWires(withBlock(terminalRows(), block));
      expect(screen.getByText("Keine Aderbeschriftung — erst Klemmen benennen.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Drucken" })).toBeDisabled();
      cleanup();
    }
  });

  it("needs no cabinet catalogue", () => {
    renderWires(withBlock(terminalRows(), defaultControlBlock()), {
      boardTerminals: { ready: false, terms: null, placement: null },
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Drucken" })).toBeEnabled();
  });

  it("disables Drucken while busy", () => {
    renderWires(withBlock(terminalRows(), defaultControlBlock()), { busy: true });
    expect(screen.getByRole("button", { name: "Drucke…" })).toBeDisabled();
  });
});
