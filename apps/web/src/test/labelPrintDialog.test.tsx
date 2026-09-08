/**
 * The print preview is the last look before 200 mm of strip feeds. These
 * pin the parts that would otherwise fail silently: a rail whose checkbox
 * does nothing, a preview that shows a rail that will not print, or a
 * "Drucken" that fires with the wrong material.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { LabelPrintDialog } from "../components/schaltplan/LabelPrintDialog";
import { emptyDocument, makeDevice } from "../utils/schaltplanDevices";

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
  render(<LabelPrintDialog {...props} />);
  return props;
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
    // FI 70 + 3 × 17.5 = 122.5 mm printed, plus 3 mm lead each side.
    expect(screen.getByText(/3 \+ 122,5 \+ 3/)).toBeInTheDocument();
    expect(screen.getAllByText(/1 ohne BMK/).length).toBeGreaterThan(0);
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
    expect(onPrint).toHaveBeenCalledWith(["r2"], "wago-210-805");
  });

  it("defaults to the 2009-110 strip", () => {
    const { onPrint } = renderDialog({ initialRowIds: ["r1"] });
    fireEvent.click(screen.getByRole("button", { name: "Drucken" }));
    expect(onPrint).toHaveBeenCalledWith(["r1"], "wago-2009-110");
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

  it("lists rail metadata: device count, unnamed devices and strip length", () => {
    renderDialog();
    const row = screen.getByRole("checkbox", { name: "Reihe 2 drucken" }).closest("li");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText(/2 Geräte/)).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText(/1 ohne BMK/)).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText(/52,5 mm/)).toBeInTheDocument();
  });
});
