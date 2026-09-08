/**
 * The "Breite (mm)" field is the only way a 70 mm Hager FI stops being
 * printed as 72 mm. These pin the write path: chips and typing set
 * `width_mm`, clearing sets it back to null, and read-only hides the chips.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DeviceInspector } from "../components/schaltplan/DeviceInspector";
import { emptyDocument, makeDevice } from "../utils/schaltplanDevices";

const noop = () => undefined;

function boardWith(device: ReturnType<typeof makeDevice>) {
  return {
    ...emptyDocument(),
    rows: [{ id: "r1", label: "Reihe 1", slots: 12, devices: [device] }],
  };
}

function renderInspector(device: ReturnType<typeof makeDevice>, readOnly = false) {
  const onChange = vi.fn();
  render(
    <DeviceInspector
      device={device}
      document={boardWith(device)}
      readOnly={readOnly}
      onChange={onChange}
      onDelete={noop}
      onDuplicate={noop}
      onMove={noop}
      onClose={noop}
    />,
  );
  return onChange;
}

describe("DeviceInspector — Breite (mm)", () => {
  it("shows the derived default as placeholder and offers 70 / 72 for a 4 TE FI", () => {
    renderInspector(makeDevice("rcd", { id: "f1", designation: "F1" }));
    const input = screen.getByRole("spinbutton", { name: "Breite in Millimetern" });
    expect(input).toHaveAttribute("placeholder", "70");
    expect(input).toHaveValue(null);
    expect(screen.getByRole("button", { name: "70" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "72" })).toBeInTheDocument();
  });

  it("offers 17,5 / 18 for a 1 TE breaker", () => {
    renderInspector(makeDevice("mcb", { id: "c1", designation: "F1.1" }));
    expect(screen.getByRole("button", { name: "17,5" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "18" })).toBeInTheDocument();
  });

  it("writes width_mm from a chip", () => {
    const onChange = renderInspector(makeDevice("rcd", { id: "f1" }));
    fireEvent.click(screen.getByRole("button", { name: "72" }));
    expect(onChange).toHaveBeenCalledWith({ width_mm: 72 });
  });

  it("writes width_mm from typing and null when cleared", () => {
    const onChange = renderInspector(makeDevice("rcd", { id: "f1" }));
    const input = screen.getByRole("spinbutton", { name: "Breite in Millimetern" });
    fireEvent.change(input, { target: { value: "70.5" } });
    expect(onChange).toHaveBeenLastCalledWith({ width_mm: 70.5 });
    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith({ width_mm: null });
  });

  it("rejects zero and negatives as null rather than a zero-width segment", () => {
    const onChange = renderInspector(makeDevice("rcd", { id: "f1" }));
    const input = screen.getByRole("spinbutton", { name: "Breite in Millimetern" });
    fireEvent.change(input, { target: { value: "0" } });
    expect(onChange).toHaveBeenLastCalledWith({ width_mm: null });
  });

  it("marks the active chip and shows the real width in the header", () => {
    renderInspector(makeDevice("rcd", { id: "f1", width_mm: 70 }));
    expect(screen.getByRole("button", { name: "70" })).toHaveClass("sp-chip-btn--active");
    expect(screen.getByRole("button", { name: "72" })).not.toHaveClass("sp-chip-btn--active");
    expect(screen.getByText(/4 TE · 70 mm/)).toBeInTheDocument();
  });

  it("hides the chips and disables the field when read-only", () => {
    renderInspector(makeDevice("rcd", { id: "f1" }), true);
    expect(screen.getByRole("spinbutton", { name: "Breite in Millimetern" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "70" })).toBeNull();
  });
});
