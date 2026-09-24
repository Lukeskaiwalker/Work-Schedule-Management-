/**
 * The customer combobox's leading group: rows a page may show above the
 * customers while nothing is typed (the Schaltplan page's "Zuletzt
 * bearbeitet" panels). The combobox is shared with every other form, so the
 * first thing pinned is that without the prop nothing changes; then that
 * the rows vanish the moment the user searches, and that the keyboard walks
 * one list — leading rows, customers, the create action.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { CustomerCombobox } from "../components/customers/CustomerCombobox";
import type { CustomerListItem } from "../types";

const CUSTOMERS = [
  { id: 1, name: "Schulze", address: "Hauptstraße 1", active_project_count: 2 },
  { id: 2, name: "Meyer", address: null, active_project_count: 0 },
] as unknown as CustomerListItem[];

function leading(onPick = vi.fn()) {
  return {
    title: "Zuletzt bearbeitet",
    items: [
      { id: "7", primary: "VT-0007 · UV1 Unterverteiler Keller", secondary: "Schulze · 381", hint: "vor 2 Std." },
      { id: "9", primary: "VT-0009 · HV Hauptverteiler", secondary: "Meyer" },
    ],
    onPick,
  };
}

type Props = Parameters<typeof CustomerCombobox>[0];

function renderBox(overrides: Partial<Props> = {}) {
  const props: Props = {
    language: "de",
    customers: CUSTOMERS,
    value: { customerId: null, customerName: "" },
    onChange: vi.fn(),
    onRequestCreate: vi.fn(),
    ...overrides,
  };
  render(<CustomerCombobox {...props} />);
  const input = screen.getByRole("combobox");
  return { ...props, input };
}

describe("CustomerCombobox — leading items", () => {
  it("changes nothing without the prop", () => {
    const { input, onChange } = renderBox();
    fireEvent.focus(input);
    expect(screen.queryByText("Kunden")).toBeNull();
    expect(screen.queryByText("Zuletzt bearbeitet")).toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(2);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith({ customerId: 1, customerName: "Schulze" });
  });

  it("shows the group above the customers only while the query is empty", () => {
    const { input } = renderBox({ leadingItems: leading() });
    fireEvent.focus(input);

    expect(screen.getByText("Zuletzt bearbeitet")).toBeInTheDocument();
    expect(screen.getByText("Kunden")).toBeInTheDocument();
    expect(screen.getByText("VT-0007 · UV1 Unterverteiler Keller")).toBeInTheDocument();
    expect(screen.getByText("Schulze · 381")).toBeInTheDocument();
    expect(screen.getByText("vor 2 Std.")).toBeInTheDocument();
    // Leading rows first, then the customers.
    const options = screen.getAllByRole("option").map((row) => row.textContent);
    expect(options[0]).toContain("VT-0007");
    expect(options[1]).toContain("VT-0009");
    expect(options[2]).toContain("Schulze");
    expect(options[3]).toContain("Meyer");

    fireEvent.change(input, { target: { value: "Sch" } });
    expect(screen.queryByText("Zuletzt bearbeitet")).toBeNull();
    expect(screen.queryByText("Kunden")).toBeNull();
    expect(screen.queryByText("VT-0007 · UV1 Unterverteiler Keller")).toBeNull();
    expect(screen.getByText("Schulze")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByText("Zuletzt bearbeitet")).toBeInTheDocument();
  });

  it("shows nothing extra for an empty leading list", () => {
    const { input } = renderBox({ leadingItems: { ...leading(), items: [] } });
    fireEvent.focus(input);
    expect(screen.queryByText("Zuletzt bearbeitet")).toBeNull();
    expect(screen.queryByText("Kunden")).toBeNull();
  });

  it("fires onPick on click, and closes without touching the customer", () => {
    const onPick = vi.fn();
    const { input, onChange } = renderBox({ leadingItems: leading(onPick) });
    fireEvent.focus(input);

    fireEvent.mouseDown(screen.getByText("VT-0007 · UV1 Unterverteiler Keller"));

    expect(onPick).toHaveBeenCalledWith("7");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("fires onPick on Enter after ArrowDown, and walks on into the customers", () => {
    const onPick = vi.fn();
    const { input, onChange } = renderBox({ leadingItems: leading(onPick) });
    fireEvent.focus(input);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByText("VT-0009 · HV Hauptverteiler").closest("li")).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("9");
    expect(onChange).not.toHaveBeenCalled();

    // Reopen: two steps down is the first customer.
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByText("Schulze").closest("li")).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith({ customerId: 1, customerName: "Schulze" });
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("wraps ArrowUp from the first leading row to the last customer", () => {
    const { input } = renderBox({ leadingItems: leading() });
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    // "Meyer" is also a leading row's secondary line; the customer row names it in bold.
    expect(screen.getByText("Meyer", { selector: ".customer-combobox-option-name" }).closest("li")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
