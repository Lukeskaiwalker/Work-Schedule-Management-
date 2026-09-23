/**
 * The print preview is the last look before 200 mm of strip feeds. These
 * pin the parts that would otherwise fail silently: a rail whose checkbox
 * does nothing, a preview that shows a rail that will not print, a strip
 * that still reserves room for a blank cover, a BMK drawn at a different
 * size from its neighbours, or a "Drucken" that fires with the wrong
 * material.
 */
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { LabelPrintDialog } from "../components/schaltplan/LabelPrintDialog";
import { emptyDocument, makeDevice } from "../utils/schaltplanDevices";

/** The options every print reports alongside ids and material. */
const BMK_OPTIONS = { target: "bmk" };

function twoRailBoard() {
  return {
    ...emptyDocument(),
    rows: [
      {
        id: "r1",
        label: "Reihe 1",
        slots: 12,
        devices: [
          makeDevice("rcd", { id: "f1", designation: "F1" }),
          makeDevice("mcb", { id: "c1", designation: "F1.1" }),
          makeDevice("mcb", { id: "c2", designation: "F1.2" }),
          makeDevice("blank", { id: "b1" }),
        ],
      },
      {
        id: "r2",
        label: "Reihe 2",
        slots: 12,
        devices: [
          makeDevice("contactor", { id: "k1", designation: "K1" }),
          makeDevice("mcb", { id: "c3" }),
        ],
      },
    ],
  };
}

const noop = () => undefined;

function renderDialog(overrides: Partial<Parameters<typeof LabelPrintDialog>[0]> = {}) {
  const props = {
    open: true,
    document: twoRailBoard(),
    initialRowIds: ["r1", "r2"],
    busy: false,
    onPrint: vi.fn(),
    onClose: noop,
    ...overrides,
  };
  const view = render(<LabelPrintDialog {...props} />);
  return { ...props, container: view.container };
}

function previewTextSizes(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("text.sp-strip-text")).map(
    (node) => node.getAttribute("font-size") ?? "",
  );
}

describe("LabelPrintDialog", () => {
  it("renders nothing while closed", () => {
    const { container } = render(
      <LabelPrintDialog
        open={false}
        document={twoRailBoard()}
        initialRowIds={[]}
        busy={false}
        onPrint={noop}
        onClose={noop}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows one checkbox per rail, ticked per the initial selection", () => {
    renderDialog({ initialRowIds: ["r2"] });
    const first = screen.getByRole("checkbox", { name: "Reihe 1 drucken" });
    const second = screen.getByRole("checkbox", { name: "Reihe 2 drucken" });
    expect(first).not.toBeChecked();
    expect(second).toBeChecked();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  });

  it("previews the BMK texts of the selected rails on a scaled strip", () => {
    renderDialog();
    expect(screen.getByRole("img", { name: /Streifen Reihe 1/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Streifen Reihe 2/ })).toBeInTheDocument();
    for (const bmk of ["F1", "F1.1", "F1.2", "K1"]) {
      expect(screen.getByText(bmk)).toBeInTheDocument();
    }
    expect(screen.getAllByText(/1 ohne BMK/).length).toBeGreaterThan(0);
  });

  it("leaves the blank cover off the strip: FI 70 + 2 × 17.5 = 105 mm, plus 3 mm lead each side", () => {
    renderDialog();
    expect(screen.getByText(/3 \+ 105 \+ 3/)).toBeInTheDocument();
    expect(screen.getByText(/^111 mm/)).toBeInTheDocument();
    expect(screen.queryByText(/122,5/)).toBeNull();
    // Reihe 2: the unnamed LS takes no width either — only the 2 TE Schütz.
    expect(screen.getByText(/3 \+ 35 \+ 3/)).toBeInTheDocument();
  });

  it("draws every BMK on the board at one font size, the tightest segment's", () => {
    const { container } = renderDialog();
    const sizes = previewTextSizes(container);
    expect(sizes).toHaveLength(4);
    // F1.1 in 17.5 mm fixes the board at 92 dots; the preview scales 0.2 px per dot.
    expect(new Set(sizes)).toEqual(new Set(["18.4"]));
  });

  it("keeps the one size when a row with only roomy segments is previewed alone", () => {
    const { container } = renderDialog({ initialRowIds: ["r2"] });
    // K1 on a 35 mm Schütz would fit far larger; the board size still rules.
    expect(previewTextSizes(container)).toEqual(["18.4"]);
  });

  it("centres each BMK on its segment", () => {
    const { container } = renderDialog({ initialRowIds: ["r2"] });
    const text = container.querySelector("text.sp-strip-text");
    expect(text).not.toBeNull();
    expect(text?.getAttribute("text-anchor")).toBe("middle");
    expect(text?.getAttribute("dominant-baseline")).toBe("central");
    // Lead 3 mm + half of 35 mm = 20.5 mm × 2.4 px/mm.
    expect(Number(text?.getAttribute("x"))).toBeCloseTo(20.5 * 2.4, 6);
  });

  it("shows the board font size in the summary", () => {
    renderDialog();
    expect(screen.getByText(/Schriftgröße: 7,7 mm/)).toBeInTheDocument();
  });

  it("warns about BMKs too long for their segment at the board size, and still prints", () => {
    const tooLong = "F1.10 Wallbox Garage";
    const document = {
      ...emptyDocument(),
      rows: [
        {
          id: "r1",
          label: "Reihe 1",
          slots: 12,
          devices: [makeDevice("mcb", { id: "c1", designation: tooLong }), makeDevice("mcb", { id: "c2", designation: "F1.2" })],
        },
      ],
    };
    const { onPrint, container } = renderDialog({ document, initialRowIds: ["r1"] });
    expect(screen.getByText(`Zu lang für die Box bei einheitlicher Größe: ${tooLong}`)).toBeInTheDocument();
    expect(screen.getByText(/Schriftgröße: 2,0 mm/)).toBeInTheDocument();
    expect(new Set(previewTextSizes(container))).toEqual(new Set(["4.8"]));
    const print = screen.getByRole("button", { name: "Drucken" });
    expect(print).toBeEnabled();
    fireEvent.click(print);
    expect(onPrint).toHaveBeenCalledWith(["r1"], "wago-2009-110", BMK_OPTIONS);
  });

  it("drops an unnamed device that sits BEFORE a labelled one, so the label moves left", () => {
    // Old behaviour kept a 17.5 mm empty segment for the unnamed breaker, which
    // would have put K1's centre at (3 + 17.5 + 17.5) mm; now it is (3 + 17.5) mm.
    const document = {
      ...emptyDocument(),
      rows: [
        {
          id: "r1",
          label: "Reihe 1",
          slots: 12,
          devices: [
            makeDevice("mcb", { id: "x", designation: "" }),
            makeDevice("contactor", { id: "k1", designation: "K1" }),
          ],
        },
      ],
    };
    const { container } = renderDialog({ document, initialRowIds: ["r1"] });
    const text = container.querySelector("svg text");
    expect(text?.textContent).toBe("K1");
    expect(Number(text?.getAttribute("x"))).toBeCloseTo((3 + 17.5) * 2.4, 6);
  });

  it("shows no overflow warning when everything fits", () => {
    renderDialog();
    expect(screen.queryByText(/Zu lang für die Box/)).toBeNull();
  });

  it("renders no strip for a rail of only blanks and unnamed devices", () => {
    const document = {
      ...emptyDocument(),
      rows: [
        { id: "r1", label: "Reihe 1", slots: 12, devices: [makeDevice("blank"), makeDevice("mcb")] },
        { id: "r2", label: "Reihe 2", slots: 12, devices: [makeDevice("mcb", { designation: "F2.1" })] },
      ],
    };
    const { container } = renderDialog({ document, initialRowIds: ["r1", "r2"] });
    expect(screen.queryByRole("img", { name: /Streifen Reihe 1/ })).toBeNull();
    expect(screen.getByText("Keine BMK in dieser Reihe — nichts zu drucken.")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Streifen Reihe 2/ })).toBeInTheDocument();
    expect(previewTextSizes(container)).toHaveLength(1);
  });

  it("drops a rail from the preview when its checkbox is unticked", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("checkbox", { name: "Reihe 2 drucken" }));
    expect(screen.queryByRole("img", { name: /Streifen Reihe 2/ })).toBeNull();
    expect(screen.queryByText("K1")).toBeNull();
    expect(screen.getByRole("img", { name: /Streifen Reihe 1/ })).toBeInTheDocument();
  });

  it("switches to one chip per BMK for the 210-805 single labels", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: "WAGO 210-805" }));
    expect(screen.queryByRole("img", { name: /Streifen/ })).toBeNull();
    const lists = screen.getAllByRole("list", { name: /^Etiketten Reihe/ });
    const chips = lists.flatMap((list) => within(list).getAllByRole("listitem"));
    expect(chips.map((chip) => chip.textContent)).toEqual(["F1", "F1.1", "F1.2", "K1"]);
  });

  it("prints the selected rails with the chosen material", () => {
    const { onPrint } = renderDialog();
    fireEvent.click(screen.getByRole("checkbox", { name: "Reihe 1 drucken" }));
    fireEvent.click(screen.getByRole("radio", { name: "WAGO 210-805" }));
    fireEvent.click(screen.getByRole("button", { name: "Drucken" }));
    expect(onPrint).toHaveBeenCalledWith(["r2"], "wago-210-805", BMK_OPTIONS);
  });

  it("defaults to the 2009-110 strip", () => {
    const { onPrint } = renderDialog({ initialRowIds: ["r1"] });
    fireEvent.click(screen.getByRole("button", { name: "Drucken" }));
    expect(onPrint).toHaveBeenCalledWith(["r1"], "wago-2009-110", BMK_OPTIONS);
  });

  it("disables Drucken with nothing selected, and re-enables via Alle", () => {
    renderDialog({ initialRowIds: [] });
    const print = screen.getByRole("button", { name: "Drucken" });
    expect(print).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Alle" }));
    expect(print).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Keine" }));
    expect(print).toBeDisabled();
  });

  it("disables Drucken when the selection has no BMK at all", () => {
    const document = {
      ...emptyDocument(),
      rows: [{ id: "r1", label: "Reihe 1", slots: 12, devices: [makeDevice("blank"), makeDevice("mcb")] }],
    };
    renderDialog({ document, initialRowIds: ["r1"] });
    expect(screen.getByRole("button", { name: "Drucken" })).toBeDisabled();
  });

  it("disables Drucken while busy", () => {
    renderDialog({ busy: true });
    expect(screen.getByRole("button", { name: /Drucke…/ })).toBeDisabled();
  });

  it("reports the print action to the parent, not via state, and offers Abbrechen", () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("lists rail metadata: device count, unnamed devices and the blank-free strip length", () => {
    renderDialog();
    const row = screen.getByRole("checkbox", { name: "Reihe 2 drucken" }).closest("li");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText(/2 Geräte/)).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText(/1 ohne BMK/)).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText(/35 mm/)).toBeInTheDocument();
    expect(within(row as HTMLElement).queryByText(/52,5 mm/)).toBeNull();
  });

  it("omits the strip length from a rail that has nothing to print", () => {
    const document = {
      ...emptyDocument(),
      rows: [{ id: "r1", label: "Reihe 1", slots: 12, devices: [makeDevice("blank"), makeDevice("mcb")] }],
    };
    renderDialog({ document, initialRowIds: ["r1"] });
    const row = screen.getByRole("checkbox", { name: "Reihe 1 drucken" }).closest("li");
    expect(within(row as HTMLElement).queryByText(/ mm/)).toBeNull();
  });
});

/** Two FIs on one rail, one terminal each — the twin fixture of the derivation tests. */
function terminalBoard() {
  return {
    ...emptyDocument(),
    rows: [
      {
        id: "r1",
        label: "Reihe 1",
        slots: 12,
        devices: [
          makeDevice("rcd", { id: "f1", designation: "F1" }),
          makeDevice("mcb", { id: "a", designation: "F1.1", circuit: "1", label: "Licht Flur", rating: "B16", terminal_block: true }),
          makeDevice("rcd", { id: "f2", designation: "F2" }),
          makeDevice("mcb", { id: "b", designation: "F2.1", circuit: "2", rating: "B16", terminal_block: true }),
        ],
      },
    ],
  };
}

/** FI F1 with one small outgoing and one Wallbox above 16 A: a Leiste X1 and a Block X2. */
function blockBoard(labels?: Record<string, string>) {
  return {
    ...emptyDocument(),
    rows: [
      {
        id: "r1",
        label: "Reihe 1",
        slots: 12,
        devices: [
          makeDevice("rcd", { id: "f1", designation: "F1" }),
          makeDevice("mcb", { id: "a", designation: "F1.1", circuit: "1", rating: "B16", terminal_block: true }),
          makeDevice("wallbox", { id: "w", designation: "F1.2", circuit: "2", label: "Wallbox Garage", rating: "B32", terminal_block: true }),
        ],
      },
    ],
    ...(labels ? { terminal_labels: labels } : {}),
  };
}

function renderTerminalDialog(overrides: Partial<Parameters<typeof LabelPrintDialog>[0]> = {}) {
  return renderDialog({
    mode: "reihenklemmen",
    document: terminalBoard(),
    initialRowIds: ["f1:leiste", "f2:leiste"],
    onEditTerminalLabel: vi.fn(),
    ...overrides,
  });
}

function previewTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("text.sp-strip-text")).map((node) => node.textContent ?? "");
}

describe("LabelPrintDialog — Reihenklemmen", () => {
  it("lists the terminal strips by X number instead of rails, and only the continuous strip", () => {
    renderTerminalDialog();
    expect(screen.getByRole("dialog", { name: "Klemmen-Etiketten drucken" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "X1 · FI F1 · Reihe 1 drucken" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "X2 · FI F2 · Reihe 1 drucken" })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: "Reihe 1 drucken" })).toBeNull();
    expect(screen.getByRole("radio", { name: "WAGO 2009-110" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "WAGO 210-805" })).toBeNull();
    expect(screen.getByText(/ein Streifen je Klemmenleiste/)).toBeInTheDocument();
    // No text-mode chips any more: the marker says the X numbering, editable below.
    expect(screen.queryByRole("radiogroup", { name: "Text" })).toBeNull();
  });

  it("previews one strip per Leiste with the X numbering, at the terminal pitch and the board size", () => {
    const { container } = renderTerminalDialog();
    expect(screen.getByRole("img", { name: /Streifen X1 · FI F1 · Reihe 1/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Streifen X2 · FI F2 · Reihe 1/ })).toBeInTheDocument();
    expect(previewTexts(container)).toEqual(["X1", "1.1", "X2", "2.1"]);
    // 12 mm feed + 5.2 mm Etagenklemme = 17.2 mm between the end lines, 3 mm lead each side.
    expect(screen.getAllByText(/3 \+ 17,2 \+ 3/)).toHaveLength(2);
    // "1.1" on 5.2 mm with the 0.5 mm pad fits at 36 dots → 3.0 mm, 7.2 px in the preview.
    expect(screen.getByText(/2 Streifen · 4 Klemmen · 46,4 mm Material · Schriftgröße: 3,0 mm/)).toBeInTheDocument();
    expect(new Set(previewTextSizes(container))).toEqual(new Set(["7.2"]));
    // A divider on every boundary: one cut line per strip between X1 and 1.1.
    expect(container.querySelectorAll("line.sp-strip-cut")).toHaveLength(2);
  });

  it("draws a Block as one 60 mm piece with three rows and short dividers in the cell row", () => {
    const { container } = renderTerminalDialog({ document: blockBoard(), initialRowIds: ["f1:leiste", "w:block"] });
    const block = screen.getByRole("img", { name: "Block X2 · Block F1.2 Wallbox Garage, 66 mm" });
    expect(block).toBeInTheDocument();
    const rows = Array.from(block.querySelectorAll("text.sp-block-row")).map((node) => node.textContent);
    expect(rows).toEqual(["Wallbox Garage", "X2"]);
    const cells = Array.from(block.querySelectorAll("text.sp-block-cell")).map((node) => node.textContent);
    expect(cells).toEqual(["N", "L1", "L2", "L3", "PE"]);
    // Four dividers between five cells, crossing only the bottom third of the 26.4 px band.
    const cuts = Array.from(block.querySelectorAll("line.sp-block-cell-cut"));
    expect(cuts).toHaveLength(4);
    expect(Number(cuts[0].getAttribute("y1"))).toBeCloseTo(6 + (26.4 / 3) * 2, 6);
    expect(Number(cuts[0].getAttribute("y2"))).toBeCloseTo(6 + 26.4, 6);
    // The Leiste before it is X1 with one Etagenklemme; the Block is listed as such.
    expect(screen.getByText("Block · 60 mm")).toBeInTheDocument();
    // (3 + 17.2 + 3) + (3 + 60 + 3) mm of strip.
    expect(screen.getByText(/2 Streifen · 7 Klemmen · 89,2 mm Material/)).toBeInTheDocument();
    expect(container.querySelectorAll("text.sp-strip-text")).toHaveLength(2 + 7);
  });

  it("prints the ticked strips with the terminal target — no text mode", () => {
    const { onPrint } = renderTerminalDialog();
    fireEvent.click(screen.getByRole("checkbox", { name: "X1 · FI F1 · Reihe 1 drucken" }));
    fireEvent.click(screen.getByRole("button", { name: "Drucken" }));
    expect(onPrint).toHaveBeenCalledWith(["f2:leiste"], "wago-2009-110", { target: "reihenklemmen" });
  });

  it("shows strip metadata: terminals, unlabelled ones and the strip length", () => {
    renderTerminalDialog({ document: { ...terminalBoard(), terminal_labels: { "a:1": "" } } });
    const row = screen.getByRole("checkbox", { name: "X1 · FI F1 · Reihe 1 drucken" }).closest("li");
    expect(within(row as HTMLElement).getByText(/3 Klemmen/)).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText(/1 ohne Beschriftung/)).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText(/12 mm/)).toBeInTheDocument();
  });

  it("offers one input per marker under the preview, labelled by strip, position, part and device", () => {
    const { onEditTerminalLabel } = renderTerminalDialog();
    const feed = screen.getByLabelText("X1 · Pos. 1 · 2016-7714 · FI F1");
    const first = screen.getByLabelText("X1 · Pos. 2 · 2003-7641 · F1.1 Licht Flur");
    expect(feed).toHaveValue("X1");
    expect(first).toHaveValue("1.1");
    expect(first).toHaveAttribute("placeholder", "1.1");
    // The end clamp carries no marker and gets no input.
    expect(screen.queryByLabelText(/2009-305/)).toBeNull();
    fireEvent.change(first, { target: { value: "7" } });
    expect(onEditTerminalLabel).toHaveBeenCalledWith("a:1", "7");
    // Without an override there is nothing to reset.
    expect(screen.getByRole("button", { name: "X1 · Pos. 2 · 2003-7641 · F1.1 Licht Flur zurücksetzen" })).toBeDisabled();
  });

  it("shows the override in the input and the preview, and Zurücksetzen removes it", () => {
    const document = { ...terminalBoard(), terminal_labels: { "a:1": "7 ", "f2:feed": "" } };
    const { onEditTerminalLabel, container } = renderTerminalDialog({ document });
    const first = screen.getByLabelText("X1 · Pos. 2 · 2003-7641 · F1.1 Licht Flur");
    // The raw override, untrimmed, so a space being typed is not eaten; the preview shows the trimmed marker.
    expect(first).toHaveValue("7 ");
    expect(previewTexts(container)).toEqual(["X1", "7", "2.1"]);
    // A blank override: empty input, the default as placeholder, the marker skipped and counted.
    const feed2 = screen.getByLabelText("X2 · Pos. 1 · 2016-7714 · FI F2");
    expect(feed2).toHaveValue("");
    expect(feed2).toHaveAttribute("placeholder", "X2");
    expect(screen.getByText(/1 ohne Beschriftung$/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "X1 · Pos. 2 · 2003-7641 · F1.1 Licht Flur zurücksetzen" }));
    expect(onEditTerminalLabel).toHaveBeenCalledWith("a:1", null);
  });

  it("gives a Block its Name and X inputs plus its five cells", () => {
    const { onEditTerminalLabel } = renderTerminalDialog({
      document: blockBoard({ "w:name": "PV Block" }),
      initialRowIds: ["w:block"],
    });
    const name = screen.getByLabelText("X2 · Name");
    expect(name).toHaveValue("PV Block");
    expect(name).toHaveAttribute("placeholder", "Wallbox Garage");
    expect(screen.getByLabelText("X2 · X")).toHaveValue("X2");
    expect(screen.getByLabelText("X2 · Pos. 1 · 2016-7604 · N · F1.2 Wallbox Garage")).toHaveValue("N");
    expect(screen.getByLabelText("X2 · Pos. 5 · 2016-7607 · PE · F1.2 Wallbox Garage")).toHaveValue("PE");
    // Only the ticked strip is listed: the Leiste's markers are not offered.
    expect(screen.queryByLabelText(/2003-7641/)).toBeNull();
    fireEvent.change(screen.getByLabelText("X2 · X"), { target: { value: "X9" } });
    expect(onEditTerminalLabel).toHaveBeenCalledWith("w:x", "X9");
    fireEvent.click(screen.getByRole("button", { name: "X2 · Name zurücksetzen" }));
    expect(onEditTerminalLabel).toHaveBeenCalledWith("w:name", null);
  });

  it("keeps the editing list read-only without write access, and hides it without a handler", () => {
    renderTerminalDialog({ readOnly: true });
    expect(screen.getByLabelText("X1 · Pos. 1 · 2016-7714 · FI F1")).toBeDisabled();
    expect(screen.getByRole("button", { name: /FI F1 zurücksetzen$/ })).toBeDisabled();
    cleanup();
    renderTerminalDialog({ onEditTerminalLabel: undefined });
    expect(screen.queryByRole("region", { name: "Beschriftung" })).toBeNull();
  });

  it("prints the Block without a width warning now that every part is confirmed", () => {
    renderTerminalDialog({ document: blockBoard(), initialRowIds: ["w:block"] });
    expect(screen.queryByText(/Breite nicht bestätigt/)).not.toBeInTheDocument();
  });

  it("disables Drucken when no ticked strip has a text", () => {
    const document = { ...terminalBoard(), terminal_labels: { "f1:feed": "", "a:1": "", "f2:feed": "", "b:1": "" } };
    renderTerminalDialog({ document });
    expect(screen.getByRole("button", { name: "Drucken" })).toBeDisabled();
    expect(screen.getByText("Nichts zu drucken · 4 ohne Beschriftung")).toBeInTheDocument();
  });

  it("shows the empty state on a board without terminals", () => {
    renderTerminalDialog({ document: twoRailBoard(), initialRowIds: [] });
    expect(screen.getByText(/Noch keine Reihenklemmen/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Drucken" })).toBeDisabled();
  });

  // The Reihenklemmen twin of "disables Drucken with nothing selected": an
  // empty selection used to preview and print EVERY group.
  it("disables Drucken with no strip ticked — nothing is nothing, not every strip", () => {
    const { onPrint } = renderTerminalDialog({ initialRowIds: [] });
    const print = screen.getByRole("button", { name: "Drucken" });
    expect(print).toBeDisabled();
    expect(screen.queryByRole("img", { name: /Streifen/ })).toBeNull();
    expect(screen.getByText("Keine Klemmenleiste ausgewählt.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Beschriftung" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Alle" }));
    expect(print).toBeEnabled();
    expect(screen.getAllByRole("img", { name: /Streifen/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Keine" }));
    expect(print).toBeDisabled();
    expect(screen.queryByRole("img", { name: /Streifen/ })).toBeNull();
    fireEvent.click(print);
    expect(onPrint).not.toHaveBeenCalled();
  });

  it("counts the terminals of a ticked Leiste that has nothing to print", () => {
    const document = { ...terminalBoard(), terminal_labels: { "f2:feed": "", "b:1": "" } };
    renderTerminalDialog({ document });
    // F2's Leiste has no strip, but its two markers are still unmarked.
    expect(screen.getByText(/^1 Streifen · 2 Klemmen · .* · 2 ohne Beschriftung$/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "X1 · FI F1 · Reihe 1 drucken" }));
    expect(screen.getByText("Nichts zu drucken · 2 ohne Beschriftung")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Drucken" })).toBeDisabled();
  });
});
