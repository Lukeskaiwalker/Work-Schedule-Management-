/**
 * The Klemmen tab and the §14a block (docs/PANEL_ENCLOSURE_R4.md §9.1,
 * §9.2): "Aderbeschriftung drucken" next to "Klemmen-Etiketten drucken"
 * while the board has a block, and the strip print stays possible on a
 * board whose only strip is the block's.
 * Invented data only — the repo is public.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { TerminalList } from "../components/schaltplan/TerminalList";
import { emptyDocument } from "../utils/schaltplanDevices";

function renderList(extra: { onPrintWires?: () => void; hasControlStrip?: boolean; printing?: boolean } = {}) {
  const onPrint = vi.fn();
  render(<TerminalList document={emptyDocument()} readOnly={false} onPrint={onPrint} pdfHref="/x.pdf" {...extra} />);
  return onPrint;
}

describe("TerminalList — §14a block", () => {
  it("offers the wire labels next to the strip print", () => {
    const onPrintWires = vi.fn();
    renderList({ onPrintWires, hasControlStrip: true });
    const wires = screen.getByRole("button", { name: "Aderbeschriftung drucken" });
    expect(wires.closest(".sp-terminal-actions")).toBe(screen.getByRole("button", { name: "Klemmen-Etiketten drucken" }).closest(".sp-terminal-actions"));
    fireEvent.click(wires);
    expect(onPrintWires).toHaveBeenCalledTimes(1);
  });

  it("has no wire button without a block", () => {
    renderList();
    expect(screen.queryByRole("button", { name: "Aderbeschriftung drucken" })).toBeNull();
  });

  it("disables the wire button while a print runs", () => {
    renderList({ onPrintWires: vi.fn(), printing: true });
    expect(screen.getByRole("button", { name: "Aderbeschriftung drucken" })).toBeDisabled();
  });

  it("lets a board print its §14a strip when it has no other terminals", () => {
    const onPrint = renderList({ hasControlStrip: true });
    const print = screen.getByRole("button", { name: "Klemmen-Etiketten drucken" });
    expect(print).toBeEnabled();
    fireEvent.click(print);
    expect(onPrint).toHaveBeenCalledTimes(1);
  });
});
