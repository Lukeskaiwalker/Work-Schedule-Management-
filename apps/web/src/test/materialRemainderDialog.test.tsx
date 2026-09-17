/**
 * "Was ist mit dem Rest passiert?" — the question asked when a crate comes
 * back with something still in it.
 *
 * Three things have to hold, because all three used to be impossible: the rest
 * is shown per position (not as one number), the answer that leaves the app is
 * exactly the one that was clicked, and a new crate cannot be created without
 * a name — the server refuses that with a 400, and a dialog that lets the
 * button be pressed anyway turns a decision into an error message.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import {
  MaterialRemainderDialog,
  defaultNewBoxLabel,
} from "../components/tasks/MaterialRemainderDialog";
import type { MaterialSettlementPreview } from "../types/taskSettlement";

const PREVIEW: MaterialSettlementPreview = {
  box: {
    id: 3,
    box_number: "K3",
    label: "Kiste 3",
    status: "zugewiesen",
    customer_name: "Musterbau GmbH",
  },
  lines: [
    {
      id: 11,
      item_name: "Wago 221-415",
      unit: "Stk",
      quantity: 10,
      quantity_used: 6,
      remainder: 4,
      article_id: 5,
    },
    {
      id: 12,
      item_name: "Hager MBN116",
      unit: "Stk",
      quantity: 3,
      quantity_used: null,
      remainder: 0,
      article_id: 6,
    },
  ],
  remainder_total: 4,
  handover_pending: false,
  needs_decision: true,
};

function open(preview: MaterialSettlementPreview = PREVIEW) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <MaterialRemainderDialog
      preview={preview}
      language="de"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel };
}

describe("MaterialRemainderDialog", () => {
  it("shows every packed line with what was used and what is left", () => {
    open();
    const row = screen.getByText("Wago 221-415").closest("tr");
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("10");
    expect(row?.textContent).toContain("6");
    expect(row?.textContent).toContain("4");
    // A line nobody reported on is not a reported zero, and must not read like one.
    const unreported = screen.getByText("Hager MBN116").closest("tr");
    expect(unreported?.textContent).toContain("–");
  });

  it("defaults to keeping the rest in the same crate and says so", () => {
    const { onConfirm } = open();
    expect(screen.getByText(/Zurück in dieselbe Kiste/)).toBeInTheDocument();
    expect(screen.getByText(/K3 bleibt Musterbau GmbH zugewiesen/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Abrechnen/ }));
    expect(onConfirm).toHaveBeenCalledWith({ disposition: "same_box", new_box_label: null });
  });

  it("sends the shelf choice when the rest is stored away", () => {
    const { onConfirm } = open();
    fireEvent.click(screen.getByRole("radio", { name: /Zurück ins Lagerregal/ }));
    fireEvent.click(screen.getByRole("button", { name: /Abrechnen/ }));
    expect(onConfirm).toHaveBeenCalledWith({ disposition: "shelf", new_box_label: null });
  });

  it("offers a prefilled name for a new crate and sends it", () => {
    const { onConfirm } = open();
    fireEvent.click(screen.getByRole("radio", { name: /In eine neue Kiste/ }));

    const input = screen.getByLabelText("Bezeichnung der neuen Kiste") as HTMLInputElement;
    expect(input.value).toBe("Rest K3 – Musterbau GmbH");
    fireEvent.change(input, { target: { value: "Rest Musterstraße" } });
    fireEvent.click(screen.getByRole("button", { name: /Abrechnen/ }));

    expect(onConfirm).toHaveBeenCalledWith({
      disposition: "new_box",
      new_box_label: "Rest Musterstraße",
    });
  });

  it("refuses to settle into a nameless new crate", () => {
    const { onConfirm } = open();
    fireEvent.click(screen.getByRole("radio", { name: /In eine neue Kiste/ }));
    fireEvent.change(screen.getByLabelText("Bezeichnung der neuen Kiste"), {
      target: { value: "   " },
    });

    const settle = screen.getByRole("button", { name: /Abrechnen/ });
    expect(settle).toBeDisabled();
    fireEvent.click(settle);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText("Die neue Kiste braucht eine Bezeichnung")).toBeInTheDocument();
  });

  it("says when the handover was never booked", () => {
    open({ ...PREVIEW, handover_pending: true });
    expect(
      screen.getByText(/Die Übergabe dieser Kiste wurde nie gebucht/),
    ).toBeInTheDocument();
  });

  it("cancelling answers nothing at all", () => {
    const { onCancel, onConfirm } = open();
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("names a crate without a customer without an empty gap", () => {
    expect(
      defaultNewBoxLabel({ ...PREVIEW, box: { ...PREVIEW.box!, customer_name: null } }),
    ).toBe("Rest K3");
  });
});
