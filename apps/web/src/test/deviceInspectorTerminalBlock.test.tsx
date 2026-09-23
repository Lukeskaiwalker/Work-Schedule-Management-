/**
 * "Name auf dem Klemmenblock": the one device field that writes to the
 * document rather than the device. A three-phase outgoing above 16 A ends
 * on its own 16 mm² Block whose 60 mm label opens with a name row; the
 * inspector edits that row's override (`terminal_labels["<id>:name"]`)
 * through a document-level callback, and an emptied field removes the
 * override so the label falls back to the description. Anything else — a
 * small outgoing, a Block with the flag off — never shows the field.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DeviceInspector } from "../components/schaltplan/DeviceInspector";
import { emptyDocument, makeDevice } from "../utils/schaltplanDevices";
import type { PanelDocument } from "../types/schaltplan";

const noop = () => undefined;

function boardWith(device: ReturnType<typeof makeDevice>, labels?: Record<string, string>): PanelDocument {
  return {
    ...emptyDocument(),
    rows: [{ id: "r1", label: "Reihe 1", slots: 12, devices: [makeDevice("rcd", { id: "f1", designation: "F1" }), device] }],
    ...(labels ? { terminal_labels: labels } : {}),
  };
}

function renderInspector(
  device: ReturnType<typeof makeDevice>,
  options: { labels?: Record<string, string>; readOnly?: boolean; withHandler?: boolean } = {},
) {
  const onEditTerminalLabel = vi.fn();
  render(
    <DeviceInspector
      device={device}
      document={boardWith(device, options.labels)}
      readOnly={options.readOnly ?? false}
      onChange={noop}
      onEditTerminalLabel={options.withHandler === false ? undefined : onEditTerminalLabel}
      onDelete={noop}
      onDuplicate={noop}
      onMove={noop}
      onClose={noop}
    />,
  );
  return onEditTerminalLabel;
}

const wallbox = (overrides: Partial<ReturnType<typeof makeDevice>> = {}) =>
  makeDevice("wallbox", { id: "w", designation: "F1.2", label: "Wallbox Garage", rating: "B32", terminal_block: true, ...overrides });

describe("DeviceInspector — Name auf dem Klemmenblock", () => {
  it("shows the field for a flagged three-phase outgoing above 16 A, with the description as placeholder", () => {
    renderInspector(wallbox());
    const input = screen.getByLabelText("Name auf dem Klemmenblock");
    expect(input).toHaveValue("");
    expect(input).toHaveAttribute("placeholder", "Wallbox Garage");
    expect(screen.getByText(/Erste Zeile des 60-mm-Block-Etiketts/)).toBeInTheDocument();
    expect(screen.getByText(/eigener 16-mm²-Block mit eigener X-Nummer/)).toBeInTheDocument();
  });

  it("writes the override through the document-level callback and removes it when emptied", () => {
    const onEdit = renderInspector(wallbox(), { labels: { "w:name": "PV Block" } });
    const input = screen.getByLabelText("Name auf dem Klemmenblock");
    expect(input).toHaveValue("PV Block");
    fireEvent.change(input, { target: { value: "PV Block 2" } });
    expect(onEdit).toHaveBeenCalledWith("w:name", "PV Block 2");
    fireEvent.change(input, { target: { value: "" } });
    expect(onEdit).toHaveBeenCalledWith("w:name", null);
  });

  it("hides the field for a small outgoing and for a Block-sized device without the flag", () => {
    renderInspector(makeDevice("mcb", { id: "a", designation: "F1.1", rating: "B16", terminal_block: true }));
    expect(screen.queryByLabelText("Name auf dem Klemmenblock")).toBeNull();
    // The hint still names the two Etagenklemmen a three-phase outgoing gets.
    expect(screen.getByText(/Bei 1 Pol: WAGO 2003-7641 \(eine Etagenklemme\)/)).toBeInTheDocument();
  });

  it("hides the field while the flag is off, and disables it read-only or without a handler", () => {
    renderInspector(wallbox({ terminal_block: false }));
    expect(screen.queryByLabelText("Name auf dem Klemmenblock")).toBeNull();
  });

  it("is disabled read-only and without a document-level handler", () => {
    renderInspector(wallbox(), { readOnly: true });
    expect(screen.getByLabelText("Name auf dem Klemmenblock")).toBeDisabled();
  });

  it("is disabled when the page offers no document-level handler", () => {
    renderInspector(wallbox(), { withHandler: false });
    expect(screen.getByLabelText("Name auf dem Klemmenblock")).toBeDisabled();
  });
});
