/**
 * The device sheet's three field-driven additions.
 *
 * Previous/next in the header (so a worker walking a rail does not close and
 * re-tap every breaker), a Neozed offered as "Eingespeist von" to an RCBO
 * or LS, and the "speist die folgenden Abgänge" flag on a fuse. Plus the
 * action row: four buttons, one grid, equal cells — the "some buttons are not
 * the same size" report.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { DeviceInspector } from "../components/schaltplan/DeviceInspector";
import { emptyDocument, makeDevice } from "../utils/schaltplanDevices";
import type { PanelDevice, PanelDocument } from "../types/schaltplan";

const noop = () => undefined;

function board() {
  const fuse = makeDevice("fuse", { id: "f0", designation: "F0", rating: "35 A" });
  const rcbo = makeDevice("rcbo", { id: "c1", designation: "F0.1", circuit: "1" });
  const rcd = makeDevice("rcd", { id: "f1", designation: "F1" });
  const mcb = makeDevice("mcb", { id: "c2", designation: "F1.1", circuit: "2" });
  const document: PanelDocument = {
    ...emptyDocument(),
    rows: [{ id: "r1", label: "Reihe 1", slots: 12, devices: [fuse, rcbo, rcd, mcb] }],
  };
  return { document, fuse, rcbo, rcd, mcb };
}

type Extra = {
  hasPrevious?: boolean;
  hasNext?: boolean;
  onNavigate?: (direction: -1 | 1) => void;
  readOnly?: boolean;
};

function renderInspector(device: PanelDevice, document: PanelDocument, extra: Extra = {}) {
  const onChange = vi.fn();
  const onNavigate = extra.onNavigate ?? vi.fn();
  const utils = render(
    <DeviceInspector
      device={device}
      document={document}
      readOnly={extra.readOnly ?? false}
      onChange={onChange}
      onDelete={noop}
      onDuplicate={noop}
      onMove={noop}
      onClose={noop}
      hasPrevious={extra.hasPrevious}
      hasNext={extra.hasNext}
      onNavigate={onNavigate}
    />,
  );
  return { ...utils, onChange, onNavigate };
}

describe("DeviceInspector — Vorheriges / Nächstes Gerät", () => {
  it("shows both buttons in the header and disables them at the ends", () => {
    const { document, fuse } = board();
    renderInspector(fuse, document, { hasPrevious: false, hasNext: true });
    const head = screen.getByRole("dialog").querySelector(".sp-sheet-head");
    expect(head).not.toBeNull();
    const previous = within(head as HTMLElement).getByRole("button", { name: "Vorheriges Gerät" });
    const next = within(head as HTMLElement).getByRole("button", { name: "Nächstes Gerät" });
    expect(previous).toBeDisabled();
    expect(next).toBeEnabled();
    // The close button keeps its place at the far end of the header.
    expect(within(head as HTMLElement).getByRole("button", { name: "Schließen" })).toBeInTheDocument();
  });

  it("disables next at the last device", () => {
    const { document, mcb } = board();
    renderInspector(mcb, document, { hasPrevious: true, hasNext: false });
    expect(screen.getByRole("button", { name: "Vorheriges Gerät" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Nächstes Gerät" })).toBeDisabled();
  });

  it("reports the direction to onNavigate", () => {
    const { document, rcbo } = board();
    const { onNavigate } = renderInspector(rcbo, document, { hasPrevious: true, hasNext: true });
    fireEvent.click(screen.getByRole("button", { name: "Nächstes Gerät" }));
    expect(onNavigate).toHaveBeenLastCalledWith(1);
    fireEvent.click(screen.getByRole("button", { name: "Vorheriges Gerät" }));
    expect(onNavigate).toHaveBeenLastCalledWith(-1);
    expect(onNavigate).toHaveBeenCalledTimes(2);
  });

  it("stays usable read-only — browsing a final plan is still browsing", () => {
    const { document, rcbo } = board();
    renderInspector(rcbo, document, { hasPrevious: true, hasNext: true, readOnly: true });
    expect(screen.getByRole("button", { name: "Nächstes Gerät" })).toBeEnabled();
  });
});

describe("DeviceInspector — Eingespeist von einer Sicherung", () => {
  it("offers every fuse on the board to an RCBO and writes parent_id", () => {
    const { document, rcbo } = board();
    const { onChange } = renderInspector(rcbo, document);
    const select = screen.getByLabelText(/eingespeist von/i) as HTMLSelectElement;
    const labels = Array.from(select.options).map((option) => option.textContent);
    expect(labels).toContain("Si F0 35 A — Vorsicherung");
    // The FI is still there as well.
    expect(labels.some((label) => label?.startsWith("F1 FI"))).toBe(true);
    fireEvent.change(select, { target: { value: "f0" } });
    expect(onChange).toHaveBeenCalledWith({ parent_id: "f0" });
  });

  it("offers the fuse to a plain LS too", () => {
    const { document, mcb } = board();
    renderInspector(mcb, document);
    const select = screen.getByLabelText(/eingespeist von/i) as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).toContain("f0");
    expect(values).toContain("f1");
  });

  it("never offers a fuse to another fuse — a fuse's feed is not modelled", () => {
    const { document, fuse } = board();
    const second = makeDevice("fuse", { id: "f9", designation: "F9", rating: "20 A" });
    const withSecond: PanelDocument = {
      ...document,
      rows: document.rows.map((row, index) =>
        index === 0 ? { ...row, devices: [...row.devices, second] } : row,
      ),
    };
    renderInspector(fuse, withSecond);
    const select = screen.getByLabelText(/eingespeist von/i) as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).not.toContain("f0");
    expect(values).not.toContain("f9");
    expect(values).toContain("f1");
  });

  it("disarms a pending delete when the arrows move to another device", () => {
    const { document, mcb, fuse } = board();
    const { rerender } = renderInspector(mcb, document);
    fireEvent.click(screen.getByRole("button", { name: "Löschen" }));
    expect(screen.getByRole("button", { name: "Wirklich löschen?" })).toBeInTheDocument();
    rerender(
      <DeviceInspector
        device={fuse}
        document={document}
        readOnly={false}
        onChange={noop}
        onDelete={noop}
        onDuplicate={noop}
        onMove={noop}
        onClose={noop}
        onNavigate={noop}
      />,
    );
    expect(screen.getByRole("button", { name: "Löschen" })).toBeInTheDocument();
  });

  it("lists a fuse that already heads a group once, not twice", () => {
    const { document, mcb } = board();
    const flagged: PanelDocument = {
      ...document,
      rows: document.rows.map((row) => ({
        ...row,
        devices: row.devices.map((device) =>
          device.id === "f0" ? { ...device, feeds_following: true } : device,
        ),
      })),
    };
    renderInspector(mcb, flagged);
    const select = screen.getByLabelText(/eingespeist von/i) as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value);
    expect(values.filter((value) => value === "f0")).toHaveLength(1);
  });
});

describe("DeviceInspector — Sicherung speist die folgenden Abgänge", () => {
  it("toggles feeds_following from a checkbox", () => {
    const { document, fuse } = board();
    const { onChange } = renderInspector(fuse, document);
    const checkbox = screen.getByRole("checkbox", { name: /speist die folgenden abgänge/i });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith({ feeds_following: true });
  });

  it("is checked and disabled read-only, and the header says what the fuse does", () => {
    const { document, fuse } = board();
    const flaggedFuse: PanelDevice = { ...fuse, feeds_following: true };
    renderInspector(flaggedFuse, document, { readOnly: true });
    const checkbox = screen.getByRole("checkbox", { name: /speist die folgenden abgänge/i });
    expect(checkbox).toBeChecked();
    expect(checkbox).toBeDisabled();
    expect(screen.getByText(/Vorsicherung, speist Abgänge/)).toBeInTheDocument();
  });

  it("does not offer the flag on an LS", () => {
    const { document, mcb } = board();
    renderInspector(mcb, document);
    expect(screen.queryByRole("checkbox", { name: /speist die folgenden abgänge/i })).toBeNull();
    expect(screen.queryByText(/Vorsicherung, speist Abgänge/)).toBeNull();
  });
});

describe("DeviceInspector — Aktionen", () => {
  it("renders exactly four equal buttons in a two-column grid, in reading order", () => {
    const { document, rcbo } = board();
    const { container } = renderInspector(rcbo, document);
    const actions = container.querySelector(".sp-sheet-actions");
    expect(actions).not.toBeNull();
    expect(actions).toHaveClass("sp-sheet-actions--grid");
    const buttons = Array.from(actions!.querySelectorAll(".sp-btn"));
    expect(buttons).toHaveLength(4);
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      "← Nach links",
      "Nach rechts →",
      "Duplizieren",
      "Löschen",
    ]);
  });
});

describe("DeviceInspector — Reihenklemme am Abgang", () => {
  it("offers the checkbox on an LS and writes terminal_block", () => {
    const { document, mcb } = board();
    const { onChange } = renderInspector(mcb, document);
    const checkbox = screen.getByRole("checkbox", { name: /reihenklemme am abgang/i });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith({ terminal_block: true });
  });

  it("names the Etagenklemmen the current poles resolve to — two of them for three phases", () => {
    const { document, mcb } = board();
    const { unmount } = renderInspector(mcb, document);
    expect(screen.getByText(/Bei 1 Pol: WAGO 2003-7641 \(eine Etagenklemme\)/)).toBeInTheDocument();
    unmount();
    // A wallbox is 3-pole by catalogue; without a rating above 16 A it stays on the Etagenklemmen.
    const wallbox = makeDevice("wallbox", { id: "w1", designation: "F1.2" });
    renderInspector(wallbox, document);
    expect(
      screen.getByText(/Bei 3 Polen: WAGO 2003-7641 \+ WAGO 2003-7642 \(zwei Etagenklemmen, zwei Marker\)/),
    ).toBeInTheDocument();
  });

  it("is hidden on an RCBO — with a note — and on a fuse, without one", () => {
    const { document, rcbo, fuse } = board();
    const { unmount } = renderInspector(rcbo, document);
    expect(screen.queryByRole("checkbox", { name: /reihenklemme am abgang/i })).toBeNull();
    expect(screen.getByText(/FI\/LS-Kombis erhalten keine Reihenklemme/)).toBeInTheDocument();
    unmount();
    renderInspector(fuse, document);
    expect(screen.queryByRole("checkbox", { name: /reihenklemme am abgang/i })).toBeNull();
    expect(screen.queryByText(/FI\/LS-Kombis erhalten keine Reihenklemme/)).toBeNull();
  });

  it("is checked and disabled read-only", () => {
    const { document, mcb } = board();
    renderInspector({ ...mcb, terminal_block: true }, document, { readOnly: true });
    const checkbox = screen.getByRole("checkbox", { name: /reihenklemme am abgang/i });
    expect(checkbox).toBeChecked();
    expect(checkbox).toBeDisabled();
  });
});

describe("DeviceInspector — Sicherung als Gruppenkopf", () => {
  it("hides the feed select for a fuse that already heads a group", () => {
    const { document, fuse } = board();
    const flaggedFuse: PanelDevice = { ...fuse, feeds_following: true };
    renderInspector(flaggedFuse, document);
    expect(screen.queryByLabelText(/eingespeist von/i)).toBeNull();
    expect(screen.queryByLabelText(/vorsicherung/i)).toBeNull();
  });
});
